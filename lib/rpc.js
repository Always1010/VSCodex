'use strict';
const { EventEmitter } = require('node:events');
const { spawn: spawnProcess } = require('node:child_process');

// One connection owns one process. Requests are never replayed after a disconnect.
class RpcClient extends EventEmitter {
  constructor({ executable, cwd, spawn = spawnProcess, timeoutMs = 30000 }) {
    super(); this.executable = executable; this.cwd = cwd; this.spawn = spawn;
    this.timeoutMs = timeoutMs; this.pending = new Map(); this.nextId = 1; this.child = null;
  }
  connect() {
    if (this.connecting) return this.connecting;
    if (this.ready) return Promise.resolve();
    this.connecting = this.open().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async open() {
    const child = this.spawn(this.executable, ['app-server', '--listen', 'stdio://'], {
      cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false
    });
    this.child = child; let buffer = '';
    const fail = error => this.disconnect(child, error);
    child.on('error', fail);
    child.on('exit', (code, signal) => fail(new Error(`Codex 进程已退出（${signal || code}）。`)));
    child.on('close', () => fail(new Error('Codex 连接已关闭。')));
    child.stdin.on('error', fail);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.child !== child) return;
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024) { fail(new Error('Codex 消息超过安全读取上限。')); return; }
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { fail(new Error('Codex 返回了无效的 JSON 消息。')); return; }
        this.receive(message);
      }
    });
    // Drain diagnostic output so a full stderr pipe cannot block the protocol.
    child.stderr?.on('data', () => {});
    try {
      await this.request('initialize', { clientInfo: { name: 'vscodex_workbench', title: 'VSCodex Workbench', version: '0.1.0' } });
      this.write({ method: 'initialized', params: {} }); this.ready = true;
    } catch (error) { fail(error); throw error; }
  }
  write(message) {
    if (!this.child || this.child.stdin.destroyed) throw new Error('Codex 尚未连接。');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params = {}) {
    if (!this.child) return Promise.reject(new Error('Codex 尚未连接。'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Codex 请求 ${method} 超时；请求不会自动重发，请刷新聊天确认执行状态。`);
        error.code = 'RPC_TIMEOUT'; reject(error);
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  receive(message) {
    if (!message || typeof message !== 'object') return;
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'id')) this.emit('serverRequest', message);
      else this.emit('notification', message.method, message.params || {});
      return;
    }
    const pending = this.pending.get(message.id); if (!pending) return;
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (message.error) {
      const error = new Error(message.error.message || 'Codex 请求失败。');
      error.code = message.error.code; error.data = message.error.data; pending.reject(error);
    } else pending.resolve(message.result);
  }
  respond(id, result) { this.write({ id, result }); }
  respondError(id, code, message) { this.write({ id, error: { code, message } }); }
  disconnect(child, error) {
    if (this.child !== child) return;
    this.child = null; this.ready = false;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); child.kill(); this.emit('disconnect', error);
  }
  close() { if (this.child) this.disconnect(this.child, new Error('Codex 连接已关闭。')); }
}
module.exports = { RpcClient };
