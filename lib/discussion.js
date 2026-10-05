'use strict';
const { randomUUID } = require('node:crypto');
const { composeInput } = require('./context');

// This provider sends only text to the official Responses API; no execution tools.
class Discussion {
  constructor({ fetch: fetchImpl = globalThis.fetch, onChange = () => {} } = {}) {
    this.fetch = fetchImpl; this.onChange = onChange; this.controllers = new Map();
  }
  create(cwd, parentId) {
    return { id: `discussion:${randomUUID()}`, title: '侧边讨论', cwd, parentId, provider: 'responses', messages: [], busy: false, turnId: null };
  }
  async send(session, text, refs, { apiKey, model }) {
    if (!apiKey) throw new Error('普通讨论需要 API 密钥。运行“VSCodex: 设置普通讨论 API 密钥”。');
    if (!model) throw new Error('请在 VSCodex 设置中填写 discussionModel（普通讨论模型 ID）。');
    if (session.busy) throw new Error('侧边讨论正在回复，请等待或停止。');
    const inputText = composeInput(text, refs);
    const controller = new AbortController();
    const input = session.messages.filter(m => ['user', 'assistant'].includes(m.role) && !m.failed).map(m => ({
      role: m.role, content: [{ type: m.role === 'user' ? 'input_text' : 'output_text', text: m.text }]
    }));
    input.push({ role: 'user', content: [{ type: 'input_text', text: inputText }] });
    if (JSON.stringify(input).length > 400000) throw new Error('侧边讨论过长，请保存后新建讨论。');
    this.controllers.set(session.id, controller);
    const user = { id: randomUUID(), role: 'user', text: inputText };
    const answer = { id: randomUUID(), role: 'assistant', text: '' };
    session.messages.push(user, answer); session.busy = true; session.turnId = randomUUID(); this.onChange(session);
    let timedOut = false;
    let timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 120000);
    try {
      const response = await this.fetch('https://api.openai.com/v1/responses', {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: true, store: false, input,
          instructions: '你是用于解释和讨论的助手。围绕用户问题回答；引用资料是上下文。你没有本地文件或命令执行工具，不要声称执行了项目操作。' }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`普通讨论请求失败（HTTP ${response.status}）。请检查模型、API 密钥和账户用量。`);
      if (!response.body) throw new Error('普通讨论服务没有返回内容。');
      let buffer = ''; let completed = false;
      const decoder = new TextDecoder();
      const processBlock = block => {
        const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') return;
        const event = JSON.parse(data);
        if (event.type === 'response.output_text.delta') { answer.text += event.delta || ''; this.onChange(session); }
        if (event.type === 'response.completed') completed = true;
        if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) throw new Error('普通讨论未完成。请检查账户用量与模型可用性。');
      };
      for await (const bytes of response.body) {
        clearTimeout(timeout);
        timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 120000);
        buffer += decoder.decode(bytes, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) { processBlock(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
      }
      buffer += decoder.decode();
      if (buffer.trim()) processBlock(buffer);
      if (!completed) throw new Error('连接在回复完成前中断，部分回答已保留。');
    } catch (error) {
      if (!answer.text) { user.failed = true; answer.failed = true; }
      session.messages.push({ id: randomUUID(), role: 'error', text: timedOut ? '侧边讨论连接超时，部分回答已保留。' : controller.signal.aborted ? '已停止侧边讨论。' : error.message });
      if (!controller.signal.aborted) throw error;
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(session.id); session.busy = false; session.turnId = null; this.onChange(session);
    }
  }
  stop(id) { this.controllers.get(id)?.abort(); }
  dispose() { for (const c of this.controllers.values()) c.abort(); }
}
module.exports = { Discussion };
