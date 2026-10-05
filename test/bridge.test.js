'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
function fixture() {
  const values = { scope: 'current', effort: 'medium', permissions: 'workspace-write', sideProvider: 'codex', additionalProjects: [] };
  const memory = new Map(); const sent = []; const commands = [];
  const context = { extensionPath: root, subscriptions: [],
    globalState: { get: (k, fallback) => memory.get(k) ?? fallback, update: async (k, v) => memory.set(k, structuredClone(v)) },
    workspaceState: { get: (_, fallback) => fallback, update: async () => {} }, secrets: { get: async () => 'fake' } };
  const vscode = {
    workspace: { getConfiguration: () => ({ get: key => values[key] }), workspaceFolders: [] },
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
    extensions: { getExtension: () => undefined }, commands: { executeCommand: async (...args) => commands.push(args) },
    Uri: { parse: value => { const url = new URL(value); return { scheme: url.protocol.slice(0, -1), authority: url.host, fsPath: decodeURIComponent(url.pathname) }; } }
  };
  const module = { exports: {} }; const requireFile = createRequire(path.join(root, 'extension.js'));
  vm.runInNewContext(fs.readFileSync(path.join(root, 'extension.js'), 'utf8'), { require: name => name === 'vscode' ? vscode : requireFile(name), module, setTimeout, clearTimeout, process, console });
  const workbench = new module.exports.Workbench(context);
  workbench.view = { webview: { postMessage: message => sent.push(message) } };
  workbench.connection = 'ready';
  return { workbench, values, memory, sent, commands };
}
test('侧边发送固定只读、主聊天保留自己的执行目录，筛选不会改变发送目标', async () => {
  const { workbench, sent } = fixture(); const calls = [];
  const main = { id: 'main', title: '主任务', cwd: '/project-a', messages: [], busy: false };
  const side = { id: 'side', title: '讨论', cwd: '/project-a', messages: [], busy: false, provider: 'codex' };
  workbench.activeId = 'main'; workbench.sideId = 'side'; workbench.roots = [{ name: '另一项目', path: '/project-b' }];
  workbench.store = { get: id => id === 'main' ? main : side, send: async (...args) => calls.push(args) };
  await workbench.handle({ type: 'setScope', scope: 'all' });
  await workbench.send({ channel: 'side', text: '解释', references: [] });
  await workbench.send({ channel: 'main', text: '继续', references: [] });
  assert.equal(calls[0][0], 'side'); assert.equal(calls[0][2].permissions, 'read-only');
  assert.equal(calls[1][0], 'main'); assert.equal(main.cwd, '/project-a');
  assert.equal(sent.filter(m => m.type === 'sent').length, 2);
  workbench.dispose();
});
test('发送时聊天切换不会重定向任务，过期目标和重复提交保留草稿', async () => {
  const { workbench, sent } = fixture(); let release; const calls = [];
  const sessions = new Map(['a', 'b'].map(id => [id, { id, title: id, cwd: `/${id}`, messages: [], busy: false }]));
  workbench.activeId = 'a';
  workbench.store = { get: id => sessions.get(id), send: async id => { calls.push(id); await new Promise(resolve => { release = resolve; }); } };
  const first = workbench.send({ channel: 'main', threadId: 'a', text: '工作' });
  await Promise.resolve(); await Promise.resolve();
  await assert.rejects(workbench.send({ channel: 'main', threadId: 'a', text: '重复' }), /正在提交/);
  workbench.activeId = 'b';
  await assert.rejects(workbench.send({ channel: 'main', threadId: 'a', text: '过期' }), /目标已变化/);
  release(); await first;
  assert.deepEqual(calls, ['a']); assert.equal(sent.at(-1).threadId, 'a');
  workbench.dispose();
});
test('创建侧边时切换主聊天不重定向引用，取消新聊天选择解除提交', async () => {
  const { workbench, sent } = fixture(); let release;
  const sessions = new Map(['a', 'b'].map(id => [id, { id, title: id, cwd: `/${id}`, messages: [] }]));
  workbench.activeId = 'a';
  workbench.store = { get: id => sessions.get(id), start: () => new Promise(resolve => { release = resolve; }) };
  const first = workbench.openSide({ text: '甲的引用' });
  await Promise.resolve(); await Promise.resolve();
  const second = workbench.openSide({ text: '后续引用' });
  workbench.activeId = 'b'; workbench.sideId = 'side-b';
  await assert.rejects(workbench.openSide({ text: '乙的引用' }), /另一聊天/);
  const side = { id: 'side-a', title: '分析', cwd: '/a', messages: [], provider: 'codex' };
  release(side); await first; await second;
  assert.equal(workbench.sideId, 'side-b'); assert.equal(workbench.sideByParent.a, 'side-a');
  assert.equal(sent.filter(m => m.type === 'addReference').every(m => m.threadId === 'side-a'), true);
  workbench.activeId = null; workbench.newChat = async () => {};
  await assert.rejects(workbench.send({ channel: 'main', text: '问题' }), /未选择发送目标/);
  assert.equal(workbench.pendingSends.size, 0);
  workbench.dispose();
});

test('审批仅响应用户当前选择，不授予会话级权限，未知请求拒绝执行', () => {
  const { workbench } = fixture(); const results = [];
  workbench.rpc = { respond: (...args) => results.push(args), respondError: (...args) => results.push(args), close() {} };
  workbench.serverRequest({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'main', command: 'git status', cwd: '/a' } });
  assert.equal(workbench.approvals.size, 1);
  assert.throws(() => workbench.resolveApproval({ id: 7, decision: 'acceptForSession' }), /无效/);
  workbench.resolveApproval({ id: 7, decision: 'decline' });
  assert.equal(results[0][1].decision, 'decline');
  workbench.serverRequest({ id: 8, method: 'item/permissions/requestApproval' });
  assert.deepEqual(JSON.parse(JSON.stringify(results[1][1])), { permissions: {}, scope: 'turn' });
  workbench.serverRequest({ id: 9, method: 'unsupported/tool' });
  assert.equal(results[2][1], -32601);
  workbench.dispose();
});
test('无法找到 Codex 时连接进入可重试错误状态，不停留在连接中', async () => {
  const { workbench } = fixture(); workbench.connection = 'offline'; workbench.readRoots = async () => {};
  workbench.executable = () => { throw new Error('没有可执行文件'); };
  await assert.rejects(workbench.connect(), /没有可执行/);
  assert.equal(workbench.connection, 'error'); assert.equal(workbench.connecting, null);
  workbench.dispose();
});
test('跳转文件拒绝命令 URI，临时侧边历史不会出现在项目主列表', async () => {
  const { workbench } = fixture();
  await assert.rejects(workbench.openReference({ uri: 'command:deleteAll' }), /不支持/);
  workbench.threads = [{ id: 'normal', name: '正常', cwd: '/a' }, { id: 'old-side', name: '临时', cwd: '/a' }];
  workbench.hiddenSides.add('old-side');
  const ids = workbench.state().projects.flatMap(p => p.threads).map(t => t.id);
  assert.ok(ids.includes('normal')); assert.equal(ids.includes('old-side'), false);
  workbench.savedSides.add('old-side');
  assert.ok(workbench.state().projects.flatMap(p => p.threads).some(t => t.id === 'old-side'));
  workbench.dispose();
});
