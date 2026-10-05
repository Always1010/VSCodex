'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
function fixture(dependencies = {}, workspaceValues = {}) {
  const values = { scope: 'current', effort: 'medium', permissions: 'workspace-write', sideProvider: 'codex', additionalProjects: [] };
  const memory = new Map(); const sent = []; const commands = []; const registered = {};
  const context = { extensionPath: root, subscriptions: [],
    globalState: { get: (k, fallback) => memory.get(k) ?? fallback, update: async (k, v) => memory.set(k, structuredClone(v)) },
    workspaceState: { get: (key, fallback) => workspaceValues[key] ?? fallback, update: async (key, value) => { workspaceValues[key] = value; } }, secrets: { get: async () => 'fake' } };
  const vscode = {
    workspace: { getConfiguration: () => ({ get: key => values[key] }), workspaceFolders: [], onDidChangeWorkspaceFolders: () => ({ dispose() {} }), onDidChangeConfiguration: callback => { registered.configuration = callback; return { dispose() {} }; } },
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }), registerWebviewViewProvider: (_, provider) => { registered.workbench = provider; return { dispose() {} }; } },
    extensions: { getExtension: () => undefined }, commands: { executeCommand: async (...args) => commands.push(args), registerCommand: () => ({ dispose() {} }) },
    Uri: { file: value => ({ scheme: 'file', fsPath: value }), parse: value => { const url = new URL(value); return { scheme: url.protocol.slice(0, -1), authority: url.host, fsPath: decodeURIComponent(url.pathname) }; } }
  };
  const module = { exports: {} }; const requireFile = createRequire(path.join(root, 'extension.js'));
  vm.runInNewContext(fs.readFileSync(path.join(root, 'extension.js'), 'utf8'), { require: name => name === 'vscode' ? vscode : dependencies[name] || requireFile(name), module, setTimeout, clearTimeout, process, console });
  const workbench = new module.exports.Workbench(context);
  workbench.view = { webview: { postMessage: message => sent.push(message) } };
  workbench.connection = 'ready';
  return { workbench, values, memory, sent, commands, vscode, context, registered, activate: module.exports.activate };
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

test('刷新使新聊天获得历史标题，同时保留自定义名称', async () => {
  const { workbench } = fixture();
  const sessions = new Map([['a', { id: 'a', title: '新聊天', cwd: '/a', messages: [] }], ['b', { id: 'b', title: '我的名称', cwd: '/a', messages: [] }]]);
  workbench.store = { get: id => sessions.get(id), sessions, list: async () => [{ id: 'a', preview: '实现项目导航', cwd: '/a' }, { id: 'b', preview: '旧问题', cwd: '/a' }] };
  await workbench.refresh();
  const threads = workbench.state().projects.flatMap(p => p.threads);
  assert.equal(threads.find(t => t.id === 'a').title, '实现项目导航');
  assert.equal(threads.find(t => t.id === 'b').title, '我的名称');
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

test('历史列表读取失败不阻断已连接的账户、模型和新聊天入口', async () => {
  const { EventEmitter } = require('node:events');
  class Rpc extends EventEmitter {
    async connect() {}
    async request(method) {
      if (method === 'thread/list') throw new Error('列表超时');
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'model/list') return { data: [{ model: 'test-model' }] };
      if (method === 'thread/start') return { thread: { id: 'new', cwd: '/known', turns: [] } };
      throw new Error('unexpected method');
    }
    close() {}
  }
  const { workbench } = fixture({ './lib/rpc': { RpcClient: Rpc } });
  workbench.connection = 'offline'; workbench.executable = () => 'test';
  workbench.readRoots = async () => { workbench.roots = [{ path: '/known', workspacePath: '/known', name: '项目' }]; };
  await workbench.connect();
  assert.equal(workbench.connection, 'ready'); assert.match(workbench.error, /列表读取失败/);
  assert.equal(workbench.models[0].id, 'test-model'); assert.match(workbench.accountLabel, /ChatGPT/);
  await workbench.newChat('/known'); assert.equal(workbench.activeId, 'new');
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

test('打开项目仅接受已识别目录并明确使用新窗口', async () => {
  const { workbench, commands } = fixture();
  workbench.roots = [{ name: '项目', path: '/known' }];
  // This fixture replaces the VS Code command bridge; no window is started.
  await assert.rejects(workbench.handle({ type: 'openProject', cwd: '/unknown' }), /未知项目/);
  assert.equal(commands.length, 0);
  await workbench.handle({ type: 'openProject', cwd: '/known' });
  assert.equal(commands[0][0], 'vscode.openFolder'); assert.equal(commands[0][1].fsPath, '/known');
  assert.equal(commands[0][2].forceNewWindow, true);
  workbench.dispose();
});

test('目录选择接受同一路径的分隔符及大小写形式，不接受相邻目录', async () => {
  const { workbench } = fixture();
  const directory = process.platform === 'win32' ? 'C:/Projects/VSCodex' : '/projects/vscodex';
  workbench.roots = [{ name: '项目', path: directory }];
  const alternative = process.platform === 'win32' ? 'c:\\projects\\VSCODEX\\.' : '/projects/vscodex/.';
  assert.equal(await workbench.pickCwd(alternative), directory);
  await assert.rejects(workbench.pickCwd(directory + '-other'), /已识别/);
  workbench.dispose();
});

test('全局聊天搜索遵守项目范围并在选择后打开目标，取消不切换', async () => {
  const { workbench, vscode, commands } = fixture();
  workbench.roots = [{ name: '当前', path: '/current' }];
  workbench.threads = [{ id: 'a', title: '当前任务', cwd: '/current' }, { id: 'b', title: '其他任务', cwd: '/other' }];
  let chosen = null; workbench.selectThread = async id => { chosen = id; };
  vscode.window.showQuickPick = async (items, options) => {
    assert.equal(items.length, 1); assert.equal(items[0].threadId, 'a');
    assert.equal(options.matchOnDescription, true); return items[0];
  };
  await workbench.switchChat(); assert.equal(chosen, 'a'); assert.equal(commands[0][0], 'vscodex.chat.focus');
  chosen = null; vscode.window.showQuickPick = async () => undefined;
  await workbench.switchChat(); assert.equal(chosen, null);
  workbench.dispose();
});

test('记住已选择聊天，重开时恢复；失效历史不阻断连接', async () => {
  const workspaceValues = {}; const { workbench } = fixture({}, workspaceValues);
  const session = { id: 'a', title: '任务', cwd: '/a', messages: [] };
  workbench.threads = [session]; workbench.store = { get: () => session, resume: async () => session };
  await workbench.selectThread('a'); assert.equal(workspaceValues.activeThread, 'a'); workbench.dispose();
  const reopened = fixture({}, workspaceValues).workbench; assert.equal(reopened.activeId, 'a'); reopened.dispose();
  const { EventEmitter } = require('node:events');
  class Rpc extends EventEmitter {
    async connect() {}
    async request(method) {
      if (method === 'thread/list' || method === 'model/list') return { data: [] };
      if (method === 'account/read') return { account: null };
      if (method === 'thread/resume') throw new Error('聊天已不可用');
      throw new Error(method);
    }
    close() {}
  }
  const invalid = fixture({ './lib/rpc': { RpcClient: Rpc } }, workspaceValues).workbench;
  invalid.connection = 'offline'; invalid.readRoots = async () => {}; invalid.executable = () => 'test';
  await invalid.connect(); assert.equal(invalid.connection, 'ready'); assert.equal(invalid.activeId, null);
  assert.equal(workspaceValues.activeThread, null); invalid.dispose();
});

test('无关配置变化不重置聊天权限、模型或项目范围', async () => {
  const setup = fixture(); setup.activate(setup.context); const workbench = setup.registered.workbench;
  workbench.options.permissions = 'read-only'; workbench.options.model = 'my-model'; workbench.scope = 'all';
  setup.registered.configuration({ affectsConfiguration: key => key === 'vscodex' || key === 'vscodex.discussionModel' });
  assert.equal(workbench.options.permissions, 'read-only'); assert.equal(workbench.options.model, 'my-model'); assert.equal(workbench.scope, 'all');
  setup.registered.configuration({ affectsConfiguration: key => key === 'vscodex' || key === 'vscodex.permissions' });
  assert.equal(workbench.options.permissions, 'workspace-write'); assert.equal(workbench.scope, 'all');
  workbench.dispose(); setup.workbench.dispose();
});

test('连接初始化尚未完成时重入连接仍等待账户、模型和历史恢复', async () => {
  const { EventEmitter } = require('node:events'); let release; let reachedModel;
  const modelEntered = new Promise(resolve => { reachedModel = resolve; });
  class Rpc extends EventEmitter {
    async connect() {}
    async request(method) {
      if (method === 'thread/list') return { data: [] };
      if (method === 'account/read') return { account: null };
      if (method === 'model/list') { reachedModel(); return new Promise(resolve => { release = () => resolve({ data: [] }); }); }
      throw new Error(method);
    }
    close() {}
  }
  const { workbench } = fixture({ './lib/rpc': { RpcClient: Rpc } });
  workbench.connection = 'offline'; workbench.readRoots = async () => {}; workbench.executable = () => 'test';
  const first = workbench.connect(); await modelEntered;
  let completed = false; const second = workbench.connect().then(() => { completed = true; });
  await Promise.resolve(); await Promise.resolve(); assert.equal(completed, false);
  release(); await first; await second; assert.equal(completed, true); workbench.dispose();
});
