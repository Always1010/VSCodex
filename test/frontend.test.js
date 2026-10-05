'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { visibleProjects, draftKey, sameDraft, snapshotReference, messageReference, markdownBlocks, redact } = require('../media/app');
const { renderWebview } = require('../src/webview');
test('current scope excludes other projects; priority keeps every project and sorts current first', () => {
  const projects = [{ id: 'other', name: '其他', threads: [{ title: '部署' }] }, { id: 'current', current: true, name: '当前', threads: [{ title: '修复' }] }];
  assert.deepEqual(visibleProjects(projects, 'current').map(p => p.id), ['current']);
  assert.deepEqual(visibleProjects(projects, 'priority').map(p => p.id), ['current', 'other']);
  assert.equal(visibleProjects(projects, 'all', '部署')[0].id, 'other');
  assert.equal(projects[0].threads.length, 1);
});
test('draft namespaces preserve main and side isolation and acknowledgement cannot clear an edited draft', () => {
  assert.notEqual(draftKey('main', { id: '1' }), draftKey('side', { id: '1' }));
  assert.notEqual(draftKey('side', null, { id: '1' }), draftKey('side', null, { id: '2' }));
  const sent = { text: 'hello', references: [{ text: 'code' }] };
  assert.equal(sameDraft(sent, structuredClone(sent)), true);
  assert.equal(sameDraft(sent, { ...sent, text: 'hello again' }), false);
  assert.equal(sameDraft(sent, { ...sent, references: [] }), false);
});
test('references capture source content without retaining mutable session objects', () => {
  const session = { id: 'a', title: '来源', cwd: '/repo' }; const ref = snapshotReference(session, { id: 'm' }, '选区'); session.title = '后来';
  assert.deepEqual(ref, { threadId: 'a', messageId: 'm', sourceTitle: '来源', cwd: '/repo', text: '选区' });
  session.messages = [{ id: 'answer', text: '流式片段' }];
  const early = messageReference(session, 'answer'); session.messages[0].text += '与最终结果';
  assert.equal(messageReference(session, 'answer').text, '流式片段与最终结果'); assert.equal(early.text, '流式片段');
});
test('untrusted markdown remains literal content, including partial streaming code fences', () => {
  assert.deepEqual(markdownBlocks('# 标题\n<script>alert(1)</script>\n```js\n<img onerror=evil()>'), [
    { type: 'heading', text: '标题' }, { type: 'line', text: '<script>alert(1)</script>' }, { type: 'code', text: '<img onerror=evil()>' }
  ]);
  assert.equal(redact('Bearer abc sk-12345'), '[隐藏凭据] [隐藏凭据]');
});
test('webview CSP restricts scripts to its nonce and escapes resource attribute injection', () => {
  const html = renderWebview({ scriptUri: 'x" onload="evil', styleUri: 'style', cspSource: 'vscode-resource:', nonce: 'nonce' });
  assert.ok(html.includes("default-src &#39;none&#39;"));
  assert.ok(html.includes("script-src &#39;nonce-nonce&#39;"));
  assert.ok(html.includes('src="x&quot; onload=&quot;evil"'));
  assert.equal(html.includes('unsafe-inline'), false);
});
