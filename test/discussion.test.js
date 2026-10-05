'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Discussion } = require('../lib/discussion');
test('普通讨论只向官方服务发送文本、不提供工具且不混入另一个会话', async () => {
  let body; let url;
  const discussion = new Discussion({ fetch: async (target, options) => {
    url = target; body = JSON.parse(options.body);
    const bytes = new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"回答"}\n\ndata: {"type":"response.completed"}\n\n');
    return { ok: true, body: (async function* () { yield bytes.slice(0, 17); yield bytes.slice(17); })() };
  } });
  const a = discussion.create('/a', 'parent-a'); const b = discussion.create('/b', 'parent-b');
  await discussion.send(a, '提问', [], { apiKey: 'fake', model: 'available-model' });
  assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(body.tools, undefined); assert.equal(body.store, false);
  assert.equal(a.messages[1].text, '回答'); assert.deepEqual(b.messages, []); assert.equal(a.busy, false);
});
test('未配置密钥不产生消息，错误不会泄露服务响应正文', async () => {
  const discussion = new Discussion({ fetch: async () => ({ ok: false, status: 401, text: async () => 'secret-content' }) });
  const s = discussion.create('/a', 'parent');
  await assert.rejects(discussion.send(s, '问题', [], { model: 'x' }), /API 密钥/);
  assert.equal(s.messages.length, 0);
  await assert.rejects(discussion.send(s, '问题', [], { apiKey: 'fake', model: 'x' }), /HTTP 401/);
  assert.equal(s.busy, false); assert.ok(s.messages[0].failed);
  assert.equal(s.messages.some(m => m.text.includes('secret-content')), false);
});
