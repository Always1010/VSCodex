'use strict';
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');

const textContent = content => (content || []).map(c => c.text || (c.type === 'image' ? `[图片：${c.url || ''}]` : c.type === 'localImage' ? `[图片：${c.path || ''}]` : '')).filter(Boolean).join('\n');
const safePermission = value => value === 'read-only' ? 'read-only' : 'workspace-write';
function itemMessage(item) {
  if (!item?.id) return null;
  if (item.type === 'userMessage') return { id: item.id, role: 'user', text: textContent(item.content) };
  if (item.type === 'agentMessage' || item.type === 'plan') return { id: item.id, role: 'assistant', text: item.text || '' };
  if (item.type === 'reasoning' || item.type === 'hookPrompt') return null;
  let text = item.command || item.query || item.tool || item.name || item.type;
  if (item.type === 'fileChange') text = (item.changes || []).map(c => `${c.path}\n${c.diff || ''}`).join('\n');
  const output = item.aggregatedOutput ?? item.output ?? item.result;
  if (output) text += '\n' + (typeof output === 'string' ? output : JSON.stringify(output));
  if (item.error) text += '\n' + (item.error.message || JSON.stringify(item.error));
  return { id: item.id, role: 'tool', text };
}

class SessionStore extends EventEmitter {
  constructor(rpc) {
    super(); this.rpc = rpc; this.sessions = new Map(); this.resuming = new Map(); this.pendingUsers = new Map(); this.completedTurns = new Set();
    rpc.on('notification', (method, params) => this.notification(method, params));
    rpc.on('disconnect', error => {
      for (const session of this.sessions.values()) if (session.busy) {
        session.busy = false; session.turnId = null; session.needsResume = true;
        this.addError(session, error?.message || '连接已断开，请刷新聊天确认执行状态。'); this.changed(session);
      }
    });
  }
  get(id) { return this.sessions.get(id); }
  changed(session) { this.emit('change', session); }
  addError(session, text, id = randomUUID()) {
    if (!session.messages.some(m => m.id === id)) session.messages.push({ id, role: 'error', text });
  }
  hydrate(thread, existing = {}) {
    const messages = []; const ids = new Set();
    for (const turn of thread.turns || []) for (const item of turn.items || []) {
      const message = itemMessage(item); if (message && !ids.has(message.id)) { messages.push(message); ids.add(message.id); }
    }
    const active = (thread.turns || []).findLast(t => t.status === 'inProgress');
    const session = { ...existing, id: thread.id, title: thread.name || thread.title || thread.preview?.slice(0, 60) || '新聊天', cwd: thread.cwd || existing.cwd,
      messages, busy: !!active || thread.status?.type === 'active', turnId: active?.id || null, side: !!existing.side, provider: 'codex', needsResume: false };
    this.sessions.set(session.id, session); this.changed(session); return session;
  }
  async start(cwd, { model, permissions, side = false } = {}) {
    if (typeof cwd !== 'string' || !cwd) throw new Error('聊天需要有效的项目目录。');
    const params = { cwd, sandbox: side ? 'read-only' : safePermission(permissions), approvalPolicy: 'on-request' };
    if (model) params.model = model;
    const result = await this.rpc.request('thread/start', params);
    return this.hydrate(result.thread, { cwd, side });
  }
  resume(id, overrides = {}) {
    const existing = this.get(id);
    if (existing && !existing.needsResume) return Promise.resolve(existing);
    if (this.resuming.has(id)) return this.resuming.get(id);
    const params = { threadId: id, sandbox: safePermission(overrides.sandbox || overrides.permissions), approvalPolicy: 'on-request', excludeTurns: false };
    if (overrides.model) params.model = overrides.model;
    const promise = this.rpc.request('thread/resume', params).then(async result => {
      const session = this.hydrate(result.thread, existing);
      await this.loadHistory(session, result); return session;
    }).finally(() => this.resuming.delete(id));
    this.resuming.set(id, promise); return promise;
  }
  async loadHistory(session, result) {
    const olderTurns = []; const olderItems = [];
    // Recent servers can return only the most recent slice of persisted history.
    for (const [initial, method, target] of [[result.turnsBackwardsCursor, 'thread/turns/list', olderTurns], [result.itemsBackwardsCursor, 'thread/items/list', olderItems]]) {
      let cursor = initial; const seen = new Set();
      for (let page = 0; cursor && page < 50 && !seen.has(cursor); page++) {
        seen.add(cursor);
        const params = { threadId: session.id, cursor, limit: 100, sortDirection: 'desc' };
        if (method === 'thread/turns/list') params.itemsView = 'full';
        const response = await this.rpc.request(method, params);
        target.push(...response.data || []); cursor = response.nextCursor;
      }
    }
    const history = [...olderTurns.reverse().flatMap(t => t.items || []), ...olderItems.reverse().map(e => e.item)].map(itemMessage).filter(Boolean);
    if (!history.length) return;
    const latest = new Map(session.messages.map(m => [m.id, m])); const ids = new Set(); const merged = [];
    for (const message of [...history, ...session.messages]) if (!ids.has(message.id)) { merged.push(latest.get(message.id) || message); ids.add(message.id); }
    session.messages = merged; this.changed(session);
  }
  async send(id, text, { model, effort, permissions } = {}) {
    let session = this.get(id); if (!session || session.needsResume) session = await this.resume(id);
    if (session.busy) throw new Error('聊天正在运行，请等待完成或先停止。');
    if (typeof text !== 'string' || !text.trim()) throw new Error('消息不能为空。');
    const clientId = randomUUID(); const optimistic = { id: clientId, role: 'user', text };
    session.messages.push(optimistic); this.pendingUsers.set(id, { clientId, message: optimistic });
    session.busy = true; session.turnId = null; this.changed(session);
    const permission = session.side ? 'read-only' : safePermission(permissions);
    const params = { threadId: id, cwd: session.cwd, input: [{ type: 'text', text, text_elements: [] }], clientUserMessageId: clientId,
      sandboxPolicy: permission === 'read-only' ? { type: 'readOnly', networkAccess: false } : { type: 'workspaceWrite', writableRoots: [session.cwd], networkAccess: false }, approvalPolicy: 'on-request' };
    if (model) params.model = model; if (effort) params.effort = effort;
    try {
      const result = await this.rpc.request('turn/start', params);
      const turn = result.turn;
      if (turn?.items) for (const item of turn.items) this.upsert(session, item);
      if (turn && !this.completedTurns.has(`${id}:${turn.id}`)) {
        session.turnId = turn.status === 'inProgress' ? turn.id : null;
        session.busy = turn.status === 'inProgress';
      }
      this.changed(session); return session;
    } catch (error) {
      const pending = this.pendingUsers.get(id);
      if (pending?.clientId === clientId) { session.messages = session.messages.filter(m => m !== optimistic); this.pendingUsers.delete(id); }
      session.busy = false; session.turnId = null;
      // A timeout/disconnect leaves execution uncertain; hydrate before allowing a retry.
      if (error.code === 'RPC_TIMEOUT' || !this.rpc.child && this.rpc.constructor.name === 'RpcClient') session.needsResume = true;
      this.addError(session, error.message); this.changed(session); throw error;
    }
  }
  async stop(id) {
    const session = this.get(id); if (!session?.busy) return;
    if (!session.turnId) throw new Error('正在等待运行编号，请稍后停止或刷新聊天。');
    await this.rpc.request('turn/interrupt', { threadId: id, turnId: session.turnId });
    // Wait for turn/completed: interrupt acknowledgement is not turn completion.
  }
  async list({ cwd } = {}) {
    const threads = new Map(); const cursors = new Set(); let cursor;
    for (let page = 0; page < 50; page++) {
      const params = { limit: 100, archived: false, sortKey: 'updated_at', sourceKinds: ['cli', 'vscode', 'appServer'], modelProviders: [] };
      if (cwd) params.cwd = cwd; if (cursor) params.cursor = cursor;
      const result = await this.rpc.request('thread/list', params);
      for (const thread of result.data || []) threads.set(thread.id, thread);
      if (!result.nextCursor || cursors.has(result.nextCursor)) break;
      cursor = result.nextCursor; cursors.add(cursor);
    }
    return [...threads.values()];
  }
  upsert(session, item, completed = false) {
    const message = itemMessage(item); if (!message) return;
    const pending = this.pendingUsers.get(session.id);
    if (message.role === 'user' && pending && (item.clientId === pending.clientId || message.text === pending.message.text)) {
      pending.message.id = message.id; pending.message.text = message.text; this.pendingUsers.delete(session.id); return;
    }
    const existing = session.messages.find(m => m.id === message.id);
    if (existing) {
      // Empty started notifications must not erase earlier streamed text.
      if (completed || message.text) Object.assign(existing, message);
    } else session.messages.push(message);
  }
  notification(method, params) {
    if (method === 'thread/started') return; // start/resume responses hydrate authoritatively.
    const session = this.get(params.threadId); if (!session) return;
    if (method === 'thread/name/updated') session.title = params.threadName || params.name || session.title;
    else if (method === 'turn/started') {
      if (this.completedTurns.has(`${session.id}:${params.turn.id}`)) return;
      session.busy = true; session.turnId = params.turn.id;
    } else if (method === 'turn/completed') {
      const turn = params.turn; this.completedTurns.add(`${session.id}:${turn.id}`);
      for (const item of turn.items || []) this.upsert(session, item, true);
      if (session.turnId && session.turnId !== turn.id) return;
      session.busy = false; session.turnId = null; this.pendingUsers.delete(session.id);
      if (turn.error) this.addError(session, turn.error.message || '运行失败。', `error:${turn.id}`);
    } else {
      if (params.turnId && this.completedTurns.has(`${session.id}:${params.turnId}`)) return;
      if (params.turnId && session.turnId && params.turnId !== session.turnId) return;
      if (method === 'item/started' || method === 'item/completed') this.upsert(session, params.item, method === 'item/completed');
      else if (['item/agentMessage/delta', 'item/plan/delta', 'item/commandExecution/outputDelta', 'item/fileChange/outputDelta'].includes(method)) {
        let message = session.messages.find(m => m.id === params.itemId);
        if (!message) { message = { id: params.itemId, role: method.includes('agentMessage') || method.includes('plan') ? 'assistant' : 'tool', text: '' }; session.messages.push(message); }
        message.text += params.delta || '';
      } else if (method === 'error') {
        this.addError(session, params.error?.message || '运行失败。', `error:${params.turnId}:${params.error?.message}`);
        if (!params.willRetry) { this.completedTurns.add(`${session.id}:${params.turnId}`); session.busy = false; session.turnId = null; }
      } else return;
    }
    this.changed(session);
  }
}
module.exports = { SessionStore };
