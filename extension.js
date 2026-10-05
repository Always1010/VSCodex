'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { RpcClient } = require('./lib/rpc');
const { SessionStore } = require('./lib/sessions');
const { groupProjects } = require('./lib/projects');
const { reference, composeInput } = require('./lib/context');
const { Discussion } = require('./lib/discussion');
const { renderWebview } = require('./src/webview');

const setting = key => vscode.workspace.getConfiguration('vscodex').get(key);
const normalizedPath = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const runGit = cwd => new Promise(resolve => execFile('git', ['-C', cwd, 'rev-parse', '--show-toplevel'],
  { windowsHide: true, timeout: 3000 }, (error, stdout) => resolve(error ? cwd : stdout.trim())));

class Workbench {
  constructor(context) {
    this.context = context; this.connection = 'offline'; this.error = ''; this.roots = []; this.threads = [];
    this.models = []; this.accountLabel = '未连接'; this.scope = context.workspaceState.get('scope', setting('scope') || 'current');
    this.activeId = context.workspaceState.get('activeThread', null); this.sideId = null; this.sideByParent = context.globalState.get('sideByParent', {});
    if (typeof this.activeId !== 'string') this.activeId = null;
    this.sideId = this.sideByParent[this.activeId] || null;
    this.pins = context.globalState.get('pins', {}); this.savedSides = new Set(context.globalState.get('savedSides', []));
    this.hiddenSides = new Set(context.globalState.get('hiddenSides', Object.values(this.sideByParent)));
    this.discussions = new Map(context.globalState.get('discussions', []).map(s => [s.id, { ...s, busy: false, turnId: null }]));
    this.approvals = new Map(); this.items = new Map(); this.pendingMessages = [];
    this.pendingSends = new Set(); this.pendingSide = null;
    this.discussion = new Discussion({ onChange: session => { this.discussions.set(session.id, session); this.publish(); this.persistLater(); } });
    this.output = vscode.window.createOutputChannel('VSCodex'); context.subscriptions.push(this.output);
    this.options = { model: setting('model') || '', effort: setting('effort') || 'medium', permissions: setting('permissions') || 'workspace-write', sideProvider: setting('sideProvider') || 'codex' };
  }
  async resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    view.webview.html = renderWebview({
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'app.js')).toString(),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'styles.css')).toString(),
      cspSource: view.webview.cspSource, nonce: randomBytes(24).toString('hex')
    });
    view.webview.onDidReceiveMessage(message => {
      this.handle(message).catch(error => this.notifyError(error, message.channel));
    }, null, this.context.subscriptions);
    view.onDidDispose(() => { this.view = null; }, null, this.context.subscriptions);
  }
  async readRoots() {
    const folders = vscode.workspace.workspaceFolders || [];
    this.roots = await Promise.all(folders.map(async f => {
      const repo = await runGit(f.uri.fsPath);
      return { name: repo === f.uri.fsPath ? f.name : path.basename(repo), path: repo, workspacePath: f.uri.fsPath };
    }));
    this.roots = this.roots.filter((r, i, a) => a.findIndex(other => other.path === r.path) === i);
  }
  executable() {
    const configured = setting('codexPath');
    if (configured) {
      if (!fs.existsSync(configured) || !fs.statSync(configured).isFile()) throw new Error('codexPath 必须是当前运行环境中存在的可执行文件。');
      return configured;
    }
    const official = vscode.extensions.getExtension('openai.chatgpt');
    const platforms = { win32: 'windows', linux: 'linux', darwin: 'macos' };
    const architecture = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch;
    if (official && platforms[process.platform]) {
      const candidate = path.join(official.extensionPath, 'bin', `${platforms[process.platform]}-${architecture}`, process.platform === 'win32' ? 'codex.exe' : 'codex');
      if (fs.existsSync(candidate)) return candidate;
    }
    if (process.platform === 'win32') {
      for (const dir of (process.env.PATH || '').split(path.delimiter)) {
        if (dir && fs.existsSync(path.join(dir, 'codex.exe'))) return path.join(dir, 'codex.exe');
      }
      throw new Error('未找到 codex.exe。请在设置中填写 vscodex.codexPath，或使用已安装官方扩展的可执行文件。');
    }
    return 'codex';
  }
  async connect() {
    if (this.connecting) return this.connecting;
    if (this.connection === 'ready') return;
    this.connecting = this.connectOnce().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async connectOnce() {
    this.connection = 'connecting'; this.error = ''; this.publish();
    this.rpc?.close();
    this.store?.removeAllListeners();
    this.approvals.clear();
    let rpc;
    try {
      await this.readRoots();
      rpc = new RpcClient({ executable: this.executable(), cwd: this.roots[0]?.workspacePath || this.context.extensionPath });
    } catch (error) {
      this.connection = 'error'; this.error = error.message; this.publish(); throw error;
    }
    this.rpc = rpc; this.store = new SessionStore(rpc);
    this.store.on('change', () => this.publish());
    rpc.on('serverRequest', message => this.serverRequest(message));
    rpc.on('notification', (method, params) => {
      if (method === 'item/started' || method === 'item/completed') this.items.set(`${params.threadId}:${params.item?.id}`, params.item);
      if (method === 'turn/completed') {
        for (const [key, approval] of this.approvals) if (approval.threadId === params.threadId && (!approval.turnId || approval.turnId === params.turn?.id)) this.approvals.delete(key);
      }
      if (method === 'serverRequest/resolved') this.approvals.delete(String(params.requestId));
      if (['thread/started', 'thread/name/updated', 'thread/archived', 'thread/unarchived', 'turn/completed'].includes(method)) this.refreshLater();
      if (method === 'account/login/completed' || method === 'account/updated') this.refreshAccount().catch(() => {});
      this.publish();
    });
    rpc.on('disconnect', error => {
      if (this.rpc !== rpc || this.disposed) return;
      this.connection = 'error'; this.error = error?.message || 'Codex 连接已断开，点击重新连接。'; this.approvals.clear(); this.publish();
    });
    try {
      await rpc.connect(); this.connection = 'ready';
      await this.refresh().catch(error => {
        this.error = '聊天列表读取失败，可刷新重试。' + error.message;
        this.notifyError(error);
      });
      await this.refreshAccount();
      const listed = await rpc.request('model/list', {});
      this.models = (listed.data || []).map(m => ({ id: m.model || m.id, displayName: m.displayName || m.model || m.id, supportedReasoningEfforts: m.supportedReasoningEfforts }));
      if (this.activeId && !this.discussions.has(this.activeId)) {
        try { await this.store.resume(this.activeId, { sandbox: this.options.permissions, approvalPolicy: 'on-request' }); }
        catch (error) { this.activeId = null; this.sideId = null; await this.context.workspaceState.update('activeThread', null); this.notifyError(new Error('上次聊天无法恢复，可重新选择聊天。' + error.message)); }
      }
      if (this.sideId && !this.discussions.has(this.sideId)) {
        try { await this.store.resume(this.sideId, { sandbox: 'read-only', approvalPolicy: 'on-request' }); }
        catch (error) { this.sideId = null; this.notifyError(error, 'side'); }
      }
      this.publish();
    } catch (error) {
      this.connection = 'error'; this.error = error.message; this.publish(); throw error;
    }
  }
  async refreshAccount() {
    const result = await this.rpc.request('account/read', { refreshToken: false });
    this.accountLabel = result.account ? (result.account.type === 'chatgpt' ? `ChatGPT · ${result.account.planType || '已登录'}` : 'API 已登录') : '未登录 Codex';
    this.publish();
  }
  async refresh() {
    if (!this.store || this.connection !== 'ready') return;
    const threads = await this.store.list();
    this.error = '';
    for (const thread of threads) {
      const session = this.store.get(thread.id);
      if (session && session.title === '新聊天') session.title = thread.name || thread.title || thread.preview?.slice(0, 60) || session.title;
    }
    this.threads = threads.map(t => ({ ...t, title: t.name || t.title || t.preview?.slice(0, 60) || '未命名聊天', isPinned: this.pins[t.id] ?? t.isPinned ?? false }));
    this.publish();
  }
  refreshLater() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh().catch(error => this.notifyError(error)), 350);
  }
  session(id) { return this.discussions.get(id) || this.store?.get(id) || null; }
  state() {
    const hidden = new Set([...this.hiddenSides].filter(id => !this.savedSides.has(id)));
    const combined = new Map(this.threads.map(t => [t.id, t]));
    for (const session of this.store?.sessions?.values() || []) combined.set(session.id, {
      ...combined.get(session.id), ...session, name: session.title, isPinned: this.pins[session.id] ?? combined.get(session.id)?.isPinned ?? false, status: { type: session.busy ? 'active' : 'idle' }
    });
    for (const id of this.savedSides) {
      const discussion = this.discussions.get(id);
      if (discussion) combined.set(id, { ...discussion, isPinned: !!this.pins[id] });
    }
    const projects = groupProjects([...combined.values()].filter(t => !hidden.has(t.id)), this.roots, setting('additionalProjects') || []);
    return {
      connection: this.connection, error: this.error, accountLabel: this.accountLabel, roots: this.roots, projects,
      scope: this.scope, models: this.models, main: this.session(this.activeId), side: this.session(this.sideId),
      ...this.options, discussionModel: setting('discussionModel') || '', approvals: [...this.approvals.values()]
    };
  }
  publish() {
    clearTimeout(this.publishTimer);
    this.publishTimer = setTimeout(() => this.view?.webview.postMessage({ type: 'state', state: this.state() }), 40);
  }
  notifyError(error, channel) {
    const message = (error?.message || String(error)).replace(/Bearer\s+\S+|sk-[\w-]+/g, '[隐藏凭据]');
    this.view?.webview.postMessage({ type: 'error', message, channel });
    this.output.appendLine(message.replace(/Bearer\s+\S+|sk-[\w-]+/g, '[隐藏凭据]'));
  }
  persistLater() {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persist().catch(error => this.notifyError(error)), 500);
  }
  async persist() {
    await Promise.all([
      this.context.globalState.update('sideByParent', this.sideByParent),
      this.context.globalState.update('hiddenSides', [...this.hiddenSides]),
      this.context.globalState.update('savedSides', [...this.savedSides]),
      this.context.globalState.update('pins', this.pins),
      this.context.globalState.update('discussions', [...this.discussions.values()].map(s => ({ ...s, busy: false, turnId: null })))
    ]);
  }
  async handle(message) {
    if (!message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'ready':
        this.publish();
        for (const queued of this.pendingMessages.splice(0)) this.view?.webview.postMessage(queued);
        await this.connect(); return;
      case 'settings': await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:vscodex-local.vscodex-workbench'); return;
      case 'editorQuote': await this.editorQuote(false); return;
      case 'openReference': await this.openReference(message.reference); return;
      case 'refresh':
        if (this.connection !== 'ready') await this.connect(); else { await this.readRoots(); await this.refresh(); }
        return;
      case 'setScope':
        if (!['current', 'priority', 'all'].includes(message.scope)) return;
        this.scope = message.scope; await this.context.workspaceState.update('scope', this.scope); this.publish(); return;
      case 'setOption': {
        const allowed = { effort: ['low', 'medium', 'high'], permissions: ['read-only', 'workspace-write'], sideProvider: ['codex', 'responses'] };
        if (message.key === 'model') {
          if (message.value && !this.models.some(m => m.id === message.value)) throw new Error('请选择当前账户可用的模型。');
        } else if (!allowed[message.key]?.includes(message.value)) return;
        this.options[message.key] = message.value; this.publish(); return;
      }
      case 'selectThread': await this.selectThread(message.threadId); return;
      case 'newChat': await this.newChat(message.cwd); return;
      case 'send': await this.send(message); return;
      case 'stop': {
        const session = this.session(message.channel === 'side' ? this.sideId : this.activeId);
        if (session?.provider === 'responses') this.discussion.stop(session.id);
        else if (session) await this.store.stop(session.id);
        return;
      }
      case 'sideOpen': await this.openSide(message.reference, !!message.explain); return;
      case 'sideSave': await this.saveSide(); return;
      case 'approval': this.resolveApproval(message); return;
      case 'rename': await this.rename(message.threadId); return;
      case 'pin': {
        const thread = this.state().projects.flatMap(p => p.threads).find(t => t.id === message.threadId);
        if (!thread) throw new Error('找不到聊天。');
        this.pins[thread.id] = !thread.isPinned; await this.persist(); this.publish(); return;
      }
      case 'archive': await this.archive(message.threadId); return;
      case 'openProject': {
        if (typeof message.cwd !== 'string' || !this.state().projects.some(p => p.path === message.cwd)) throw new Error('未知项目目录。');
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(message.cwd), { forceNewWindow: true }); return;
      }
      case 'login': await this.login(); return;
      default: return;
    }
  }
  async pickCwd(provided) {
    const known = this.state().projects.filter(p => p.path);
    if (provided) {
      if (typeof provided !== 'string') throw new Error('请选择已识别的项目目录。');
      const selected = [...known, ...this.roots].find(p => normalizedPath(p.path) === normalizedPath(provided));
      if (!selected) throw new Error('请选择已识别的项目目录。');
      return selected.path;
    }
    if (this.roots.length === 1) return this.roots[0].path;
    const candidates = this.roots.length ? this.roots : known;
    if (!candidates.length) throw new Error('请先在 VS Code 打开一个项目文件夹。');
    const picked = await vscode.window.showQuickPick(candidates.map(p => ({ label: p.name, description: p.path, cwd: p.path })), { placeHolder: '选择新聊天所属项目' });
    return picked?.cwd;
  }
  async newChat(cwd) {
    await this.connect(); cwd = await this.pickCwd(cwd); if (!cwd) return;
    const session = await this.store.start(cwd, { ...this.options });
    this.activeId = session.id; this.sideId = null;
    await this.context.workspaceState.update('activeThread', this.activeId); this.publish();
  }
  async switchChat() {
    await this.connect();
    const projects = this.state().projects.filter(project => this.scope !== 'current' || project.current);
    const choices = projects.flatMap(project => project.threads.map(thread => ({
      label: `${thread.isPinned ? '$(pin) ' : ''}${thread.title || '未命名聊天'}`,
      description: project.name,
      detail: `${thread.busy ? '执行中 · ' : ''}${thread.cwd || project.path || ''}`,
      threadId: thread.id
    })));
    if (!choices.length) { vscode.window.showInformationMessage('当前项目范围没有聊天，可新建聊天或扩大项目范围。'); return; }
    const selected = await vscode.window.showQuickPick(choices, { placeHolder: '搜索聊天或项目名称', matchOnDescription: true, matchOnDetail: true });
    if (!selected) return;
    await this.selectThread(selected.threadId); await this.reveal();
  }
  async selectThread(id) {
    if (typeof id !== 'string') return;
    const available = this.state().projects.flatMap(p => p.threads).some(t => t.id === id);
    if (!available) throw new Error('聊天不存在或已经归档。');
    if (!this.discussions.has(id)) { await this.connect(); await this.store.resume(id, { sandbox: this.options.permissions, approvalPolicy: 'on-request' }); }
    this.activeId = id; this.sideId = this.sideByParent[id] || null;
    await this.context.workspaceState.update('activeThread', this.activeId); this.publish();
    if (this.sideId && !this.session(this.sideId)) {
      try { await this.store.resume(this.sideId, { sandbox: 'read-only', approvalPolicy: 'on-request' }); }
      catch (error) { this.sideId = null; this.notifyError(error, 'side'); }
      this.publish();
    }
  }
  async send(message) {
    const channel = message.channel === 'side' ? 'side' : 'main';
    const id = channel === 'side' ? this.sideId : this.activeId;
    if (message.threadId && message.threadId !== id) throw new Error('发送目标已变化，草稿已保留，请在目标聊天中重新发送。');
    const key = `${channel}:${id || 'new'}`;
    if (this.pendingSends.has(key)) throw new Error('消息正在提交，请等待确认。');
    this.pendingSends.add(key);
    try { await this.sendOnce(message, id); }
    finally { this.pendingSends.delete(key); }
  }
  async sendOnce(message, capturedId) {
    const channel = message.channel === 'side' ? 'side' : 'main';
    const refs = Array.isArray(message.references) ? message.references : [];
    // Validate before creating a session or initiating a generation.
    const input = composeInput(message.text, refs);
    if (channel === 'side' && !this.sideId) await this.openSide();
    if (channel === 'main' && !this.activeId) await this.newChat();
    const session = this.session(capturedId || (channel === 'side' ? this.sideId : this.activeId));
    if (!session) throw new Error('未选择发送目标，草稿已保留。');
    if (session.provider === 'responses') {
      const promise = this.discussion.send(session, message.text, refs, { apiKey: await this.context.secrets.get('discussionApiKey'), model: setting('discussionModel') });
      if (session.busy) this.view?.webview.postMessage({ type: 'sent', channel, threadId: session.id });
      await promise;
    } else {
      await this.connect();
      await this.store.send(session.id, input, { ...this.options, permissions: channel === 'side' ? 'read-only' : this.options.permissions });
      this.view?.webview.postMessage({ type: 'sent', channel, threadId: session.id });
    }
    this.publish();
  }
  async openSide(rawReference, explain = false) {
    if (this.pendingSide) {
      if (this.activeId !== this.pendingSideParent) throw new Error('另一聊天的侧边窗口正在创建，请稍后重试。');
      const session = await this.pendingSide;
      if (rawReference && session) this.view?.webview.postMessage({ type: 'addReference', threadId: session.id, channel: 'side', reference: reference(rawReference), explain });
      return session;
    }
    this.pendingSideParent = this.activeId;
    this.pendingSide = this.openSideOnce(rawReference, explain);
    try { return await this.pendingSide; } finally { this.pendingSide = null; this.pendingSideParent = null; }
  }
  async openSideOnce(rawReference, explain = false) {
    if (rawReference) reference(rawReference);
    if (!this.activeId) await this.newChat(rawReference?.cwd);
    const parent = this.session(this.activeId); if (!parent) return;
    const existing = this.sideByParent[parent.id];
    let session = this.session(existing);
    if (!session && existing && !existing.startsWith('discussion:')) {
      await this.connect();
      try { session = await this.store.resume(existing, { sandbox: 'read-only', approvalPolicy: 'on-request' }); }
      catch (error) { this.notifyError(error, 'side'); }
    }
    const provider = this.options.sideProvider;
    if (!session || (session.provider || 'codex') !== provider) {
      if (provider === 'responses') {
        session = this.discussion.create(parent.cwd, parent.id); this.discussions.set(session.id, session);
      } else {
        await this.connect(); session = await this.store.start(parent.cwd, { model: this.options.model, effort: this.options.effort, side: true });
        session.provider = 'codex'; session.parentId = parent.id;
      }
      this.sideByParent[parent.id] = session.id; await this.persist();
    }
    this.hiddenSides.add(session.id); await this.persist();
    if (this.activeId === parent.id) this.sideId = session.id;
    this.publish();
    if (rawReference) {
      const ref = reference(rawReference);
      this.view?.webview.postMessage({ type: 'addReference', channel: 'side', threadId: session.id, reference: ref, explain });
    }
    return session;
  }
  async saveSide() {
    const session = this.session(this.sideId); if (!session) return;
    this.savedSides.add(session.id);
    if (session.provider !== 'responses') {
      await this.connect();
      await this.rpc.request('thread/name/set', { threadId: session.id, name: '侧边讨论 · ' + (this.session(this.activeId)?.title || '项目分析') });
      session.title = '侧边讨论 · ' + (this.session(this.activeId)?.title || '项目分析');
    }
    await this.persist(); await this.refresh(); this.publish();
  }
  async rename(id) {
    const session = this.session(id);
    const thread = session || this.threads.find(t => t.id === id);
    if (!thread) throw new Error('找不到聊天。');
    const name = await vscode.window.showInputBox({ prompt: '聊天名称', value: thread.title || thread.name || '', validateInput: value => value.trim() ? null : '名称不能为空' });
    if (!name) return;
    if (thread.provider !== 'responses') { await this.connect(); await this.rpc.request('thread/name/set', { threadId: id, name: name.trim() }); }
    if (session) session.title = name.trim();
    await this.persist(); await this.refresh(); this.publish();
  }
  async archive(id) {
    const session = this.session(id);
    if (session?.busy) throw new Error('请先停止或等待聊天完成后归档。');
    if (session?.provider === 'responses') this.savedSides.delete(id);
    else { await this.connect(); await this.rpc.request('thread/archive', { threadId: id }); this.store.sessions.delete(id); }
    for (const [parent, side] of Object.entries(this.sideByParent)) if (side === id) delete this.sideByParent[parent];
    if (this.activeId === id) { this.activeId = null; this.sideId = null; await this.context.workspaceState.update('activeThread', null); }
    if (this.sideId === id) this.sideId = null;
    await this.persist(); await this.refresh();
  }
  serverRequest(message) {
    const { id, method, params = {} } = message;
    if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'tool/requestUserInput'].includes(method)) {
      const item = this.items.get(`${params.threadId}:${params.itemId}`);
      this.approvals.set(String(id), {
        id, method, threadId: params.threadId, turnId: params.turnId,
        title: method.includes('commandExecution') ? '执行命令需要确认' : method.includes('fileChange') ? '修改文件需要确认' : 'Codex 需要你的回答',
        details: [params.cwd, params.command, params.reason, item?.changes ? JSON.stringify(item.changes, null, 2) : ''].filter(Boolean).join('\n'),
        questions: params.questions || []
      });
      this.publish();
    } else if (method === 'item/permissions/requestApproval') {
      // No implicit escalation from the workbench's explicit permission selection.
      this.rpc.respond(id, { permissions: {}, scope: 'turn' });
      this.notifyError(new Error('已拒绝额外权限请求。请按需调整聊天权限后重新提问。'));
    } else {
      this.rpc.respondError(id, -32601, `VSCodex 尚未支持请求 ${method}`);
      this.notifyError(new Error(`当前客户端尚未支持 ${method}，该请求未执行。`));
    }
  }
  resolveApproval(message) {
    const request = this.approvals.get(String(message.id)); if (!request) throw new Error('确认请求已结束。');
    if (request.method.includes('requestUserInput')) {
      const answers = {};
      for (const question of request.questions) {
        const value = message.answers?.[question.id];
        const entries = typeof value === 'string' ? [value] : Array.isArray(value) ? value : value?.answers;
        if (!Array.isArray(entries) || !entries.every(v => typeof v === 'string')) throw new Error('请填写完整回答。');
        answers[question.id] = { answers: entries };
      }
      this.rpc.respond(request.id, { answers });
    } else {
      if (!['accept', 'decline', 'cancel'].includes(message.decision)) throw new Error('无效的确认选择。');
      this.rpc.respond(request.id, { decision: message.decision });
    }
    this.approvals.delete(String(message.id)); this.publish();
  }
  async login() {
    await this.connect();
    const result = await this.rpc.request('account/login/start', { type: 'chatgptDeviceCode' });
    const url = result.verificationUrl || result.verificationUri;
    const code = result.userCode;
    if (!url || !code) throw new Error('此 Codex 版本没有返回设备登录信息，请使用现有 Codex 客户端登录后刷新。');
    const chosen = await vscode.window.showInformationMessage(`设备登录代码：${code}。完成登录后点击工作台刷新。`, '复制代码并打开登录页面');
    if (chosen) { await vscode.env.clipboard.writeText(code); await vscode.env.openExternal(vscode.Uri.parse(url)); }
  }
  async editorQuote(side) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) throw new Error('请先在代码编辑器中选中内容。');
    const selection = editor.selection;
    const ref = reference({ text: editor.document.getText(selection), sourceTitle: `${path.basename(editor.document.uri.fsPath)}:${selection.start.line + 1}-${selection.end.line + 1}${editor.document.isDirty ? ' · 未保存快照' : ''}`, uri: editor.document.uri.toString(), startLine: selection.start.line + 1, endLine: selection.end.line + 1, cwd: vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.fsPath });
    if (side) { await this.reveal(); await this.openSide(ref); }
    else {
      const message = { type: 'addReference', channel: 'main', reference: ref };
      if (this.view) this.view.webview.postMessage(message); else this.pendingMessages.push(message);
      await this.reveal();
    }
  }
  async openReference(raw) {
    if (!raw || typeof raw.uri !== 'string') throw new Error('此引用没有文件来源。');
    const uri = vscode.Uri.parse(raw.uri);
    const workspaceUris = (vscode.workspace.workspaceFolders || []).map(f => f.uri);
    if (!['file', 'vscode-remote'].includes(uri.scheme) || (uri.scheme === 'vscode-remote' && !workspaceUris.some(u => u.scheme === uri.scheme && u.authority === uri.authority))) throw new Error('不支持此引用的文件来源。');
    const roots = [...this.roots.map(r => r.path), ...this.state().projects.map(p => p.path)].filter(Boolean);
    const inside = roots.some(root => {
      const relative = path.relative(root, uri.fsPath);
      return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
    });
    if (!inside) throw new Error('引用文件不属于已识别的项目。');
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { preview: true, preserveFocus: true });
    const line = Math.max(0, Math.min(document.lineCount - 1, (Number(raw.startLine) || 1) - 1));
    const range = new vscode.Range(line, 0, line, 0); editor.selection = new vscode.Selection(range.start, range.end); editor.revealRange(range);
  }
  async reveal() { await vscode.commands.executeCommand('vscodex.chat.focus'); }
  dispose() {
    this.disposed = true; clearTimeout(this.publishTimer); clearTimeout(this.refreshTimer); clearTimeout(this.persistTimer);
    this.discussion.dispose(); this.rpc?.close(); this.persist().catch(() => {});
  }
}

function activate(context) {
  const workbench = new Workbench(context);
  context.subscriptions.push(workbench, vscode.window.registerWebviewViewProvider('vscodex.chat', workbench, { webviewOptions: { retainContextWhenHidden: true } }));
  context.subscriptions.push(vscode.commands.registerCommand('vscodex.open', () => workbench.reveal()));
  context.subscriptions.push(vscode.commands.registerCommand('vscodex.switchChat', () => workbench.switchChat().catch(error => vscode.window.showErrorMessage(error.message))));
  for (const [command, side] of [['vscodex.addSelection', false], ['vscodex.askSelection', true]]) {
    context.subscriptions.push(vscode.commands.registerCommand(command, () => workbench.editorQuote(side).catch(e => vscode.window.showErrorMessage(e.message))));
  }
  context.subscriptions.push(vscode.commands.registerCommand('vscodex.setApiKey', async () => {
    const key = await vscode.window.showInputBox({ password: true, prompt: '普通讨论使用单独计费的 OpenAI API 密钥。留空删除已有密钥。', ignoreFocusOut: true });
    if (key === undefined) return;
    if (key.trim()) await context.secrets.store('discussionApiKey', key.trim()); else await context.secrets.delete('discussionApiKey');
    vscode.window.showInformationMessage(key.trim() ? 'API 密钥已保存到 VS Code SecretStorage。' : '已删除普通讨论 API 密钥。');
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => workbench.readRoots().then(() => workbench.publish())));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration('vscodex')) return;
    const defaults = { model: '', effort: 'medium', permissions: 'workspace-write', sideProvider: 'codex' };
    for (const [key, fallback] of Object.entries(defaults)) {
      if (event.affectsConfiguration(`vscodex.${key}`)) workbench.options[key] = setting(key) || fallback;
    }
    if (event.affectsConfiguration('vscodex.scope')) {
      workbench.scope = setting('scope') || 'current';
      context.workspaceState.update('scope', workbench.scope).catch(error => workbench.notifyError(error));
    }
    workbench.publish();
  }));
}
module.exports = { activate, Workbench };
