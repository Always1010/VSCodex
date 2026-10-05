'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const { RpcClient } = require('../lib/rpc');
const { SessionStore } = require('../lib/sessions');
const { groupProjects } = require('../lib/projects');

function mockClient(timeoutMs = 1000) {
  let spawned;
  const rpc = new RpcClient({ executable: 'codex-mock', cwd: __dirname, timeoutMs, spawn(executable, args, options) {
    spawned = { executable, args, options };
    return spawn(process.execPath, [path.join(__dirname, 'fixtures/mock-codex.js')], options);
  } });
  return { rpc, get spawned() { return spawned; } };
}
class FakeRpc extends EventEmitter {
  constructor(handler) { super(); this.handler = handler; this.calls = []; }
  async request(method, params) { this.calls.push({ method, params }); return this.handler(method, params); }
  notify(method, params) { this.emit('notification', method, params); }
}
const thread = (id = 'main', cwd = '/project') => ({ id, cwd, name: '测试聊天', status: { type: 'idle' }, turns: [] });

test('JSONL lifecycle: initialize, chunk framing, approval replies, and exit rejection', async t => {
  const client = mockClient(); const { rpc } = client; t.after(() => rpc.close());
  await Promise.all([rpc.connect(), rpc.connect()]);
  assert.deepEqual(client.spawned.args, ['app-server', '--listen', 'stdio://']);
  assert.equal(client.spawned.options.windowsHide, true); assert.equal(client.spawned.options.shell, false);
  const result = await rpc.request('inspect', { text: '中文' }); assert.equal(result.initialized, true); assert.equal(result.params.text, '中文');
  const notification = once(rpc, 'notification'); const approval = once(rpc, 'serverRequest');
  await rpc.request('events');
  assert.equal((await notification)[0], 'item/agentMessage/delta');
  const request = (await approval)[0]; const acknowledged = once(rpc, 'notification');
  rpc.respond(request.id, { decision: 'decline' });
  assert.deepEqual((await acknowledged)[1].result, { decision: 'decline' });
  await assert.rejects(rpc.request('exit'), /退出|关闭/); assert.equal(rpc.pending.size, 0);
});

test('Timeout and close reject requests without generation replay', async t => {
  const { rpc } = mockClient(200); t.after(() => rpc.close()); await rpc.connect();
  await assert.rejects(rpc.request('hang'), error => error.code === 'RPC_TIMEOUT');
  const waiting = rpc.request('hang'); rpc.close(); await assert.rejects(waiting, /关闭/);
  assert.equal(rpc.pending.size, 0);
});

test('Resume hydrates history and active status; list uses interactive defaults and traverses pages', async () => {
  const rpc = new FakeRpc((method, params) => {
    if (method === 'thread/resume') return { thread: { ...thread('history', '/other'), status: { type: 'active' }, turns: [{ id: 'active', status: 'inProgress', items: [
      { id: 'u', type: 'userMessage', content: [{ type: 'text', text: '问' }] }, { id: 'a', type: 'agentMessage', text: '答' }, { id: 'c', type: 'commandExecution', command: 'pwd', aggregatedOutput: '/other' }
    ] }] } };
    if (method === 'thread/list') return { data: [thread(params.cursor ? 'second' : 'first')], nextCursor: params.cursor ? null : 'next' };
    throw new Error(method);
  });
  const store = new SessionStore(rpc); const session = await store.resume('history', { sandbox: 'danger-full-access', approvalPolicy: 'never' });
  assert.deepEqual(session.messages.map(m => m.role), ['user', 'assistant', 'tool']); assert.equal(session.turnId, 'active');
  assert.equal(rpc.calls[0].params.sandbox, 'workspace-write'); assert.equal(rpc.calls[0].params.approvalPolicy, 'on-request');
  await assert.rejects(store.send('history', '重复'), /正在运行/);
  assert.equal((await store.list()).length, 2); assert.equal(rpc.calls.find(c => c.method === 'thread/list').params.sourceKinds, undefined);
});

test('Main and side streams stay isolated, use session cwd, and reconcile optimistic messages', async () => {
  let index = 0;
  const rpc = new FakeRpc((method, params) => {
    if (method === 'thread/start') return { thread: thread(++index === 1 ? 'main' : 'side', params.cwd) };
    if (method === 'turn/start') {
      const turnId = `${params.threadId}-turn`;
      rpc.notify('turn/started', { threadId: params.threadId, turn: { id: turnId, status: 'inProgress' } });
      rpc.notify('item/started', { threadId: params.threadId, turnId, item: { id: `${params.threadId}-user`, type: 'userMessage', clientId: params.clientUserMessageId, content: params.input } });
      return { turn: { id: turnId, status: 'inProgress', items: [] } };
    }
    if (method === 'turn/interrupt') return {};
    throw new Error(method);
  });
  const store = new SessionStore(rpc); await store.start('/project'); await store.start('/project', { side: true });
  await store.send('main', '主问题', { model: 'm', effort: 'high' }); await store.send('side', '侧问题', { permissions: 'workspace-write' });
  const starts = rpc.calls.filter(c => c.method === 'turn/start');
  assert.equal(starts[0].params.cwd, '/project'); assert.equal(starts[0].params.sandboxPolicy.type, 'workspaceWrite');
  assert.equal(starts[1].params.sandboxPolicy.type, 'readOnly'); assert.equal(starts[1].params.approvalPolicy, 'on-request');
  for (const [id, text] of [['main', '主答案'], ['side', '侧答案']]) {
    const params = { threadId: id, turnId: `${id}-turn`, itemId: 'answer', delta: text };
    rpc.notify('item/agentMessage/delta', params);
    rpc.notify('item/started', { ...params, item: { id: 'answer', type: 'agentMessage', text: '' } });
    rpc.notify('item/completed', { ...params, item: { id: 'answer', type: 'agentMessage', text } });
  }
  assert.deepEqual(store.get('main').messages.map(m => m.text), ['主问题', '主答案']);
  assert.deepEqual(store.get('side').messages.map(m => m.text), ['侧问题', '侧答案']);
  await assert.rejects(store.send('main', '重复'), /正在运行/); await store.stop('main'); assert.equal(store.get('main').busy, true);
  rpc.notify('turn/completed', { threadId: 'main', turn: { id: 'main-turn', status: 'completed', items: [] } });
  rpc.notify('item/agentMessage/delta', { threadId: 'main', turnId: 'main-turn', itemId: 'answer', delta: '迟到' });
  assert.equal(store.get('main').busy, false); assert.equal(store.get('side').busy, true); assert.equal(store.get('main').messages.at(-1).text, '主答案');
});

test('Rejected sends remove optimistic history; disconnect forces hydration before retry', async () => {
  let reject = true;
  const rpc = new FakeRpc((method, params) => {
    if (method === 'thread/start') return { thread: thread() };
    if (method === 'thread/resume') return { thread: thread() };
    if (method === 'turn/start') { if (reject) throw new Error('拒绝'); return { turn: { id: 'turn', status: 'inProgress', items: [] } }; }
    throw new Error(method);
  });
  const store = new SessionStore(rpc); await store.start('/project');
  await assert.rejects(store.send('main', '重试内容'), /拒绝/); assert.equal(store.get('main').messages.filter(m => m.role === 'user').length, 0);
  reject = false; await store.send('main', '重试内容'); assert.equal(store.get('main').messages.filter(m => m.role === 'user').length, 1);
  rpc.emit('disconnect', new Error('断开')); assert.equal(store.get('main').busy, false); assert.equal(store.get('main').needsResume, true);
  await store.resume('main'); assert.equal(rpc.calls.at(-1).method, 'thread/resume'); assert.equal(store.get('main').messages.length, 0);
});

test('Resume supports paginated history and late turn/start replies cannot revive completion', async () => {
  const rpc = new FakeRpc((method, params) => {
    if (method === 'thread/resume') return { thread: { ...thread(), turns: [{ id: 'new', status: 'completed', items: [{ id: 'new-a', type: 'agentMessage', text: '新' }] }] }, turnsBackwardsCursor: 'older' };
    if (method === 'thread/turns/list') return { data: [{ id: 'old', status: 'completed', items: [{ id: 'old-u', type: 'userMessage', content: [{ type: 'text', text: '旧' }] }] }], nextCursor: null };
    if (method === 'turn/start') {
      if (params.input[0].text === '错误') { rpc.notify('error', { threadId: 'main', turnId: 'failed', willRetry: false, error: { message: '失败' } }); return { turn: { id: 'failed', status: 'inProgress', items: [] } }; }
      rpc.notify('turn/completed', { threadId: 'main', turn: { id: 'fast', status: 'completed', items: [] } }); return { turn: { id: 'fast', status: 'inProgress', items: [] } };
    }
    throw new Error(method);
  });
  const store = new SessionStore(rpc); await store.resume('main'); assert.deepEqual(store.get('main').messages.map(m => m.text), ['旧', '新']);
  await store.send('main', '快'); assert.equal(store.get('main').busy, false); assert.equal(store.get('main').turnId, null);
  await store.send('main', '错误'); assert.equal(store.get('main').busy, false); assert.equal(store.get('main').turnId, null);
});

test('Project grouping respects Windows boundaries, longest roots, explicit aliases, and POSIX case', () => {
  const roots = [{ name: 'Root', path: 'D:\\Repo' }, { name: 'Nested', path: 'D:\\Repo\\nested' }];
  const groups = groupProjects([
    { id: 'a', cwd: 'd:\\REPO\\src', name: '标题' }, { id: 'b', cwd: 'D:\\Repo\\nested\\x' }, { id: 'c', cwd: 'D:\\Repository' },
    { id: 'd', cwd: 'D:\\Worktrees\\branch\\src' }, { id: 'e', cwd: 'E:\\Other\\Repo' }
  ], roots, [{ name: 'Alias', path: 'D:\\Canonical', folders: ['D:\\Worktrees\\branch'] }], { platform: 'win32' });
  assert.equal(groups.find(p => p.name === 'Root').threads[0].title, '标题'); assert.equal(groups.find(p => p.name === 'Nested').threads[0].id, 'b');
  assert.equal(groups.find(p => p.name === 'Alias').threads[0].id, 'd'); assert.equal(groups.length, 5);
  const linux = groupProjects([{ id: 'upper', cwd: '/Repo' }, { id: 'lower', cwd: '/repo' }], [], [], { platform: 'linux' }); assert.equal(linux.length, 2);
  const currentWorktree = groupProjects([{ id: 'worktree', cwd: '/worktrees/branch/src' }], [{ name: 'Worktree', path: '/worktrees/branch', workspacePath: '/worktrees/branch/src' }], [{ name: 'Canonical', path: '/repo', folders: ['/worktrees/branch'] }], { platform: 'linux' });
  assert.equal(currentWorktree.length, 1); assert.equal(currentWorktree[0].name, 'Canonical'); assert.equal(currentWorktree[0].current, true);
});
