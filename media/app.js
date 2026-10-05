'use strict';

// These helpers are shared with headless tests; all model content is rendered as text.
function visibleProjects(projects, scope, query = '') {
  const needle = query.trim().toLocaleLowerCase();
  return projects.filter(p => scope !== 'current' || p.current).map(p => ({ ...p,
    threads: (p.threads || []).filter(t => !needle || `${p.name} ${t.title} ${t.preview || ''}`.toLocaleLowerCase().includes(needle)).sort((a, b) => Number(!!b.isPinned) - Number(!!a.isPinned))
  })).filter(p => !needle || p.threads.length || p.name.toLocaleLowerCase().includes(needle))
    .sort((a, b) => scope === 'priority' ? Number(!!b.current) - Number(!!a.current) : 0);
}
function draftKey(channel, session, main) {
  return session?.id ? `${channel}:${session.id}` : `${channel}:new:${channel === 'side' ? main?.id || '' : ''}`;
}
function sameDraft(a, b) { return !!a && !!b && a.text === b.text && JSON.stringify(a.references) === JSON.stringify(b.references); }
function snapshotReference(session, message, text) {
  return { text, threadId: session.id, messageId: message.id, sourceTitle: session.title || '聊天', cwd: session.cwd };
}
function messageReference(session, id) {
  const message = session?.messages?.find(item => item.id === id);
  return message ? snapshotReference(session, message, message.text) : null;
}
function markdownBlocks(text) {
  const blocks = []; let code = null;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('```')) {
      if (code !== null) { blocks.push({ type: 'code', text: code.join('\n') }); code = null; }
      else code = [];
    } else if (code !== null) code.push(line);
    else blocks.push({ type: /^#{1,4} /.test(line) ? 'heading' : /^> /.test(line) ? 'quote' : 'line', text: line.replace(/^(#{1,4}|>) /, '') });
  }
  if (code !== null) blocks.push({ type: 'code', text: code.join('\n') });
  return blocks;
}
function redact(text) { return String(text || '').replace(/Bearer\s+\S+|sk-[\w-]+/gi, '[隐藏凭据]'); }
if (typeof module !== 'undefined') module.exports = { visibleProjects, draftKey, sameDraft, snapshotReference, messageReference, markdownBlocks, redact };

if (typeof document !== 'undefined') (() => {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const ui = { drafts: saved.drafts || {}, scrolls: saved.scrolls || {}, collapsed: saved.collapsed || {},
    drawer: false, pinned: !!saved.pinned, width: saved.width || 260, sideVisible: false, query: '' };
  let state = { connection: 'offline', projects: [], models: [], approvals: [], scope: 'current' };
  const pending = {}; const queuedReferences = []; let selectedReference = null;
  const post = (type, values = {}) => vscode.postMessage({ type, ...values });
  const persist = () => vscode.setState({ drafts: ui.drafts, scrolls: ui.scrolls, collapsed: ui.collapsed, pinned: ui.pinned, width: ui.width });
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const button = (label, glyph, action, cls = '') => { const b = el('button', cls, glyph); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label); b.onclick = action; return b; };
  const select = (label, options, action) => { const s = el('select'); s.title = label; s.setAttribute('aria-label', label);
    for (const [value, text] of options) { const o = el('option', '', text); o.value = value; s.append(o); }
    s.onchange = () => action(s.value); return s; };
  function renderInline(node, text) {
    node.replaceChildren();
    const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
    let offset = 0;
    for (const match of text.matchAll(pattern)) {
      node.append(document.createTextNode(text.slice(offset, match.index)));
      const token = match[0];
      if (token.startsWith('`')) node.append(el('code', '', token.slice(1, -1)));
      else if (token.startsWith('**')) node.append(el('strong', '', token.slice(2, -2)));
      else { const split = token.indexOf(']('); const anchor = el('a', '', token.slice(1, split)); anchor.href = token.slice(split + 2, -1); anchor.rel = 'noopener noreferrer'; anchor.title = anchor.href; node.append(anchor); }
      offset = match.index + token.length;
    }
    node.append(document.createTextNode(text.slice(offset))); node.dataset.sourceText = text;
  }
  const root = document.getElementById('app');
  const shell = el('div', 'shell'); root.append(shell);
  const rail = el('nav', 'rail'); rail.setAttribute('aria-label', '工作台导航'); shell.append(rail);
  const drawerToggle = button('聊天列表 (Alt+L)', '☰', () => { ui.drawer = !ui.drawer; layout(); if (ui.drawer) search.focus(); });
  rail.append(drawerToggle, el('span', 'rail-label', '聊天'), button('新建聊天', '+', () => post('newChat')), button('侧边聊天', '◧', openSide));
  const railBottom = el('div', 'rail-bottom'); railBottom.append(button('刷新连接', '↻', () => post('refresh')), button('设置', '⚙', () => post('settings'))); rail.append(railBottom);
  const backdrop = el('button', 'backdrop'); backdrop.title = '关闭聊天列表'; backdrop.setAttribute('aria-label', '关闭聊天列表'); backdrop.onclick = () => { ui.drawer = false; layout(); drawerToggle.focus(); }; shell.append(backdrop);
  const drawer = el('aside', 'drawer'); drawer.setAttribute('aria-label', '项目与聊天'); shell.append(drawer);
  const drawerHead = el('div', 'drawer-head'); drawerHead.append(el('strong', '', '项目聊天'), button('固定聊天列表', '固定', () => { ui.pinned = !ui.pinned; ui.drawer = true; persist(); layout(); }), button('关闭聊天列表', '×', () => { ui.drawer = false; ui.pinned = false; persist(); layout(); drawerToggle.focus(); })); drawer.append(drawerHead);
  const scope = select('项目范围', [['current', '仅当前项目'], ['priority', '当前项目优先'], ['all', '全部项目']], value => post('setScope', { scope: value })); drawer.append(scope);
  const search = el('input', 'search'); search.placeholder = '搜索项目或聊天'; search.setAttribute('aria-label', '搜索项目或聊天'); search.oninput = () => { ui.query = search.value; renderTree(); }; drawer.append(search);
  const tree = el('div', 'tree'); drawer.append(tree);
  const resize = el('div', 'resize'); resize.role = 'separator'; resize.tabIndex = 0; resize.setAttribute('aria-label', '调整聊天列表宽度'); resize.setAttribute('aria-orientation', 'vertical'); drawer.append(resize);
  resize.onpointerdown = e => { resize.setPointerCapture(e.pointerId); resize.onpointermove = event => { ui.width = Math.max(200, Math.min(440, event.clientX - 46)); layout(); }; resize.onpointerup = () => { resize.onpointermove = null; persist(); }; };
  resize.onkeydown = e => { if (['ArrowLeft', 'ArrowRight'].includes(e.key)) { ui.width = Math.max(200, Math.min(440, ui.width + (e.key === 'ArrowRight' ? 10 : -10))); persist(); layout(); e.preventDefault(); } };
  const workspace = el('main', 'workspace'); shell.append(workspace);
  const status = el('div', 'connection'); status.role = 'status'; workspace.append(status);
  const approvals = el('section', 'approvals'); approvals.setAttribute('aria-label', '待处理确认'); workspace.append(approvals);
  const columns = el('div', 'columns'); workspace.append(columns);
  const panes = {};
  function makePane(channel) {
    const panel = el('section', `conversation ${channel}`); panel.setAttribute('aria-label', channel === 'main' ? '主聊天' : '侧边聊天'); columns.append(panel);
    const head = el('header', 'conversation-head'); panel.append(head);
    const title = select(channel === 'main' ? '切换聊天' : '侧边后端', [], value => {
      if (channel === 'main') { if (value) post('selectThread', { threadId: value }); }
      else { post('setOption', { key: 'sideProvider', value }); post('sideOpen'); }
    }); head.append(title);
    if (channel === 'main') head.append(button('重命名当前聊天', '✎', () => state.main && post('rename', { threadId: state.main.id })), button('打开侧边讨论', '◧', openSide));
    else head.append(button('保存为独立聊天', '▣', () => post('sideSave')), button('关闭侧边讨论', '×', () => { ui.sideVisible = false; layout(); }));
    const notice = el('div', 'pane-notice'); panel.append(notice);
    const messages = el('div', 'messages'); messages.tabIndex = 0; messages.setAttribute('aria-label', '聊天消息'); panel.append(messages);
    const composer = el('form', 'composer'); panel.append(composer);
    const refs = el('div', 'references'); composer.append(refs);
    const input = el('textarea'); input.rows = 2; input.placeholder = channel === 'main' ? '描述任务，或引用选中的内容…' : '继续讨论，不打断主任务…'; input.setAttribute('aria-label', channel === 'main' ? '主聊天输入' : '侧边聊天输入'); composer.append(input);
    const controls = el('div', 'composer-controls'); composer.append(controls);
    const model = select('模型', [], value => post('setOption', { key: 'model', value }));
    const effort = select('推理强度', [['low', '低'], ['medium', '中'], ['high', '高']], value => post('setOption', { key: 'effort', value }));
    const permissions = select('操作权限', [['read-only', '只读'], ['workspace-write', '工作区写入']], value => post('setOption', { key: 'permissions', value }));
    controls.append(model, effort, permissions);
    if (channel === 'main') controls.append(button('引用编辑器选区', '⌁', () => post('editorQuote')));
    const send = button('发送 (Ctrl+Enter)', '↑', () => submit(channel), 'send'); controls.append(send);
    const recovery = button('追加上次未发送草稿', '恢复草稿', () => recoverDraft(channel)); recovery.hidden = true; controls.insertBefore(recovery, send);
    const error = el('div', 'inline-error'); error.role = 'alert'; composer.append(error);
    const pane = panes[channel] = { panel, title, notice, messages, composer, refs, input, model, effort, permissions, send, recovery, error, key: null, nodes: new Map() };
    input.oninput = () => { const draft = getDraft(pane.key); draft.text = input.value; persist(); };
    input.onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(channel); } };
    composer.onsubmit = e => { e.preventDefault(); submit(channel); };
    messages.onscroll = () => { if (pane.key) { ui.scrolls[pane.key] = messages.scrollTop; persist(); } };
    messages.onmouseup = () => captureSelection(channel);
    messages.onkeyup = () => captureSelection(channel);
    return pane;
  }
  makePane('main'); makePane('side');
  const toolbar = el('div', 'selection-toolbar'); toolbar.hidden = true; toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', '选中文本操作'); root.append(toolbar);
  toolbar.onpointerdown = e => e.preventDefault();
  toolbar.append(button('添加到对话', '添加到对话', () => useSelection('main', false)), button('解释', '解释', () => useSelection('side', true)), button('在侧边聊天中提问', '在侧边聊天中提问', () => useSelection('side', false)));
  const preview = el('dialog', 'reference-preview'); const previewTitle = el('strong'); const previewText = el('pre'); preview.append(previewTitle, previewText, button('关闭引用预览', '关闭', () => preview.close())); root.append(preview);
  function getDraft(key) { return ui.drafts[key] || (ui.drafts[key] = { text: '', references: [] }); }
  function openSide() { ui.sideVisible = true; layout(); post('sideOpen'); }
  function layout() {
    shell.classList.toggle('drawer-open', ui.drawer || ui.pinned); shell.classList.toggle('drawer-pinned', ui.pinned);
    shell.style.setProperty('--drawer-width', `${ui.width}px`); backdrop.hidden = !(ui.drawer && !ui.pinned);
    drawerToggle.setAttribute('aria-expanded', String(ui.drawer || ui.pinned));
    drawer.hidden = !(ui.drawer || ui.pinned); panes.side.panel.hidden = !ui.sideVisible;
    columns.classList.toggle('has-side', ui.sideVisible);
  }
  let treeSignature = '';
  function renderTree() {
    const treeData = (state.projects || []).map(p => [p.id, p.name, p.path, p.current, (p.threads || []).map(t => [t.id, t.title, t.isPinned, t.busy, t.status])]);
    const signature = JSON.stringify([treeData, state.scope, state.main?.id, state.approvals?.map(a => a.threadId), ui.query, ui.collapsed]);
    scope.value = state.scope || 'current';
    if (signature === treeSignature) return; treeSignature = signature;
    tree.replaceChildren(); scope.value = state.scope || 'current';
    for (const project of visibleProjects(state.projects || [], state.scope || 'current', ui.query)) {
      if (ui.collapsed[project.id] === undefined && state.scope === 'priority' && !project.current) ui.collapsed[project.id] = true;
      const group = el('section', 'project'); const heading = el('div', 'project-head');
      const toggle = button(`${ui.collapsed[project.id] ? '展开' : '折叠'} ${project.name}`, `${ui.collapsed[project.id] ? '▸' : '▾'} ${project.name}`, () => { ui.collapsed[project.id] = !ui.collapsed[project.id]; persist(); renderTree(); }, 'project-toggle');
      toggle.setAttribute('aria-expanded', String(!ui.collapsed[project.id])); heading.append(toggle);
      if (project.current) heading.append(el('span', 'badge', '当前'));
      if (project.path) heading.append(button(`在 VS Code 新窗口打开 ${project.name}`, '↗', () => post('openProject', { cwd: project.path })));
      heading.append(button(`在 ${project.name} 新建聊天`, '+', () => post('newChat', { cwd: project.path }))); group.append(heading);
      if (!ui.collapsed[project.id]) for (const thread of project.threads) {
        const row = el('div', 'thread-row'); row.classList.toggle('active', thread.id === state.main?.id);
        const choose = button(thread.title, `${thread.isPinned ? '◆ ' : ''}${thread.title || '未命名聊天'}`, () => { post('selectThread', { threadId: thread.id }); if (!ui.pinned) { ui.drawer = false; layout(); } }, 'thread-select');
        if (thread.id === state.main?.id) choose.setAttribute('aria-current', 'true');
        const waiting = state.approvals?.some(a => a.threadId === thread.id);
        const busy = thread.busy || (typeof thread.status === 'string' ? thread.status === 'active' : thread.status?.type === 'active');
        row.append(choose);
        if (waiting || busy) { const badge = el('span', 'badge', waiting ? '待确认' : '执行中'); badge.title = waiting ? '此聊天有待处理确认' : '此聊天正在执行'; row.append(badge); }
        row.append(button(thread.isPinned ? '取消置顶' : '置顶聊天', thread.isPinned ? '取消置顶' : '置顶', () => post('pin', { threadId: thread.id })), button('归档聊天', '归档', () => post('archive', { threadId: thread.id }))); group.append(row);
      }
      tree.append(group);
    }
    if (!tree.children.length) tree.append(el('p', 'empty-small', ui.query ? '没有匹配的聊天' : '当前范围尚无聊天'));
  }
  function updateSelect(control, items, value) {
    const signature = JSON.stringify(items);
    if (control.dataset.options !== signature) { control.replaceChildren(); for (const [id, label] of items) { const option = el('option', '', label); option.value = id; control.append(option); } control.dataset.options = signature; }
    control.value = value || '';
  }
  function renderPane(channel) {
    const pane = panes[channel], session = state[channel], key = draftKey(channel, session, state.main);
    if (pane.key !== key) {
      if (pane.key) ui.scrolls[pane.key] = pane.messages.scrollTop;
      // A newly created session inherits its channel's pending new-session draft.
      if (!ui.drafts[key] && pane.key?.includes(':new:')) ui.drafts[key] = getDraft(pane.key);
      pane.key = key; pane.input.value = getDraft(key).text; pane.messages.replaceChildren(); pane.nodes.clear();
      requestAnimationFrame(() => { pane.messages.scrollTop = ui.scrolls[key] || 0; });
    }
    if (channel === 'main') {
      const options = visibleProjects(state.projects || [], state.scope || 'current').flatMap(p => p.threads.map(t => [t.id, `${p.name} / ${t.title}`]));
      if (session && !options.some(([id]) => id === session.id)) options.unshift([session.id, session.title || '当前聊天']);
      updateSelect(pane.title, [['', '新聊天'], ...options], session?.id);
    }
    else updateSelect(pane.title, [['codex', 'Codex · 只读分析'], ['responses', '普通讨论 · API']], state.sideProvider || 'codex');
    pane.notice.textContent = channel === 'side' ? ((session?.provider || state.sideProvider) === 'responses' ? `纯讨论 · ${state.discussionModel || '请在设置中配置模型和 API 密钥'}` : '只读项目分析 · 独立上下文') : session?.cwd || '选择项目，开始一段新聊天';
    const bottom = pane.messages.scrollHeight - pane.messages.scrollTop - pane.messages.clientHeight < 64;
    const incoming = new Set();
    for (const message of session?.messages || []) {
      incoming.add(message.id); let entry = pane.nodes.get(message.id);
      if (!entry) { const article = el('article', `message ${message.role}`); article.dataset.messageId = message.id; const label = el('div', 'message-label', message.role === 'user' ? '你' : message.role === 'assistant' ? session?.provider === 'responses' ? '助手' : 'Codex' : '运行信息'); const body = el('div', 'message-body'); article.append(label, body);
        if (channel === 'side' && message.role === 'assistant') article.append(button('将回答引用到主聊天', '引用到主聊天', () => {
          const ref = messageReference(state.side, message.id);
          if (ref && state.side.id === session.id) addReference('main', ref);
        }, 'quote-back'));
        pane.messages.append(article); entry = { article, body, text: null }; pane.nodes.set(message.id, entry); }
      if (entry.text !== message.text) {
        const blocks = markdownBlocks(message.text);
        blocks.forEach((block, index) => {
          let node = entry.body.children[index];
          if (!node || node.dataset.blockType !== block.type) {
            const replacement = el(block.type === 'code' ? 'pre' : block.type === 'heading' ? 'h3' : block.type === 'quote' ? 'blockquote' : 'div', `markdown-${block.type}`);
            replacement.dataset.blockType = block.type;
            if (node) node.replaceWith(replacement); else entry.body.append(replacement);
            node = replacement;
          }
          const text = block.text || '\u00a0';
          if ((node.dataset.sourceText || node.textContent) !== text) {
            // Append token deltas to the existing text node, keeping unchanged blocks intact.
            if (block.type !== 'code' && /`|\*\*|\[[^\]]+\]\(/.test(text)) renderInline(node, text);
            else if (!node.dataset.sourceText && node.childNodes.length === 1 && node.firstChild?.nodeType === 3 && text.startsWith(node.textContent)) node.firstChild.appendData(text.slice(node.textContent.length));
            else { node.textContent = text; delete node.dataset.sourceText; }
          }
        });
        while (entry.body.children.length > blocks.length) entry.body.lastChild.remove();
        entry.text = message.text;
      }
    }
    for (const [id, entry] of pane.nodes) if (!incoming.has(id)) { entry.article.remove(); pane.nodes.delete(id); }
    const empty = pane.messages.querySelector('.empty');
    if (!incoming.size && !empty) { const card = el('div', 'empty'); card.append(el('div', 'empty-mark', '✦'), el('h2', '', channel === 'main' ? '把想法变成进展' : '留一个空间，深入讨论'), el('p', '', channel === 'main' ? '连接 Codex 后，聊天会按项目汇聚在这里。' : '引用主聊天片段，或直接提出问题。')); pane.messages.append(card); }
    if (incoming.size) empty?.remove();
    if (bottom && incoming.size) pane.messages.scrollTop = pane.messages.scrollHeight;
    updateSelect(pane.model, [['', '默认模型'], ...(state.models || []).map(m => [m.id, m.displayName])], state.model);
    pane.effort.value = state.effort || 'medium'; pane.permissions.value = channel === 'side' ? 'read-only' : state.permissions || 'workspace-write';
    const pure = channel === 'side' && (session?.provider || state.sideProvider) === 'responses';
    pane.model.hidden = pure; pane.effort.hidden = pure; pane.permissions.hidden = pure; pane.permissions.disabled = channel === 'side';
    pane.send.textContent = session?.busy ? '■' : '↑'; pane.send.title = session?.busy ? '停止生成' : '发送 (Ctrl+Enter)'; pane.send.setAttribute('aria-label', pane.send.title);
    pane.send.disabled = !!pending[channel] && !session?.busy;
    renderReferences(channel);
  }
  function renderReferences(channel) {
    const pane = panes[channel]; pane.refs.replaceChildren();
    for (const [index, ref] of getDraft(pane.key).references.entries()) {
      const chip = el('div', 'reference-chip'); chip.append(button('预览引用', ref.sourceTitle || '引用片段', () => { previewTitle.textContent = ref.sourceTitle || '引用'; previewText.textContent = ref.text; preview.showModal(); }, 'chip-title'));
      chip.append(button('跳转引用来源', '↗', () => {
        const sourceChannel = state.side?.id === ref.threadId ? 'side' : state.main?.id === ref.threadId ? 'main' : null;
        if (sourceChannel) {
          if (sourceChannel === 'side') { ui.sideVisible = true; layout(); }
          const source = panes[sourceChannel].nodes.get(ref.messageId); source?.article.scrollIntoView({ block: 'center' }); source?.article.classList.add('reference-target');
        } else if (ref.threadId) { post('selectThread', { threadId: ref.threadId }); ui.jump = ref.messageId; }
        else if (ref.uri) post('openReference', { reference: ref });
      }), button('移除引用', '×', () => { getDraft(pane.key).references.splice(index, 1); persist(); renderReferences(channel); })); pane.refs.append(chip);
    }
  }
  function addReference(channel, reference, explain = false) {
    if (channel === 'side') { ui.sideVisible = true; layout(); }
    const pane = panes[channel]; const draft = getDraft(pane.key); draft.references.push({ ...reference });
    if (explain && !draft.text.trim()) { draft.text = '请解释这个片段，并结合上下文说明。'; pane.input.value = draft.text; }
    persist(); renderReferences(channel); pane.input.focus();
  }
  function recoverDraft(channel) {
    const pane = panes[channel]; if (!pane.recoveredDraft) return;
    const target = getDraft(pane.key), old = pane.recoveredDraft;
    target.text = [target.text, old.text].filter(Boolean).join('\n\n'); target.references.push(...old.references);
    pane.input.value = target.text; pane.recoveredDraft = null; pane.recovery.hidden = true;
    persist(); renderReferences(channel);
  }
  function submit(channel) {
    const pane = panes[channel]; if (state[channel]?.busy) { post('stop', { channel }); return; }
    if (pending[channel]) return;
    const draft = getDraft(pane.key); if (!draft.text.trim() && !draft.references.length) return;
    pending[channel] = { key: pane.key, sessionId: state[channel]?.id, snapshot: JSON.parse(JSON.stringify(draft)) }; pane.error.textContent = ''; pane.send.disabled = true;
    post('send', { channel, threadId: state[channel]?.id, text: draft.text, references: draft.references });
  }
  function consumeSideReference(message) {
    if (!message.explain) { addReference('side', message.reference); return; }
    const pane = panes.side; const draft = getDraft(pane.key);
    if (!draft.text.trim() && !pending.side && !state.side?.busy) { addReference('side', message.reference, true); submit('side'); return; }
    if (pending.side || state.side?.busy) { addReference('side', message.reference, true); pane.error.textContent = '侧边聊天正在生成，完成后可发送解释问题。'; return; }
    // An automatic explanation is independent of an already written side draft.
    const snapshot = { text: '请解释这个片段，并结合上下文说明。', references: [{ ...message.reference }] };
    pending.side = { key: pane.key, sessionId: state.side?.id, snapshot }; pane.send.disabled = true;
    ui.sideVisible = true; layout();
    post('send', { channel: 'side', threadId: state.side?.id, ...snapshot });
  }
  function captureSelection(channel) {
    const selection = window.getSelection(); const text = selection?.toString().trim();
    if (!text || !selection.rangeCount) { toolbar.hidden = true; return; }
    const node = selection.anchorNode?.parentElement?.closest('.message');
    if (!node || !panes[channel].messages.contains(node) || selection.focusNode?.parentElement?.closest('.message') !== node) { toolbar.hidden = true; return; }
    const session = state[channel], message = session?.messages.find(m => m.id === node.dataset.messageId); if (!message) return;
    selectedReference = snapshotReference(session, message, text);
    const rect = selection.getRangeAt(0).getBoundingClientRect(); toolbar.hidden = false;
    toolbar.style.left = `${Math.max(8, Math.min(window.innerWidth - 360, rect.left))}px`; toolbar.style.top = `${Math.max(8, rect.top - 42)}px`;
  }
  function useSelection(channel, explain) {
    if (!selectedReference) return; const ref = { ...selectedReference }; toolbar.hidden = true;
    if (channel === 'side') { ui.sideVisible = true; layout(); post('sideOpen', { reference: ref, explain }); }
    else addReference(channel, ref);
  }
  let approvalSignature = '';
  function renderApprovals() {
    const requests = state.approvals || []; const signature = JSON.stringify(requests);
    if (signature === approvalSignature) return; approvalSignature = signature;
    approvals.replaceChildren();
    for (const request of requests) {
      const card = el('form', 'approval-card'); card.append(el('strong', '', request.title || '需要确认'), el('small', '', `聊天 ${request.threadId || ''}`));
      if (request.details) card.append(el('pre', '', redact(request.details)));
      if (request.method.includes('requestUserInput')) {
        const fields = new Map();
        for (const question of request.questions || []) {
          const group = el('fieldset'); group.append(el('legend', '', redact(question.header || question.question)), el('p', '', redact(question.question)));
          const options = [];
          for (const [index, option] of (question.options || []).entries()) { const label = el('label', 'answer-option'); const input = el('input'); input.type = 'radio'; input.name = `${request.id}:${question.id}`; input.value = option.label; input.id = `answer-${request.id}-${question.id}-${index}`; label.append(input, el('span', '', redact(option.label)), el('small', '', redact(option.description))); group.append(label); options.push(input); }
          const free = el('input'); free.type = question.isSecret ? 'password' : 'text'; free.autocomplete = 'off'; free.placeholder = '输入你的回答'; free.setAttribute('aria-label', question.question || question.header); group.append(free); fields.set(question.id, { free, options }); card.append(group);
        }
        const submitAnswer = button('提交回答', '提交回答', () => { const answers = {}; for (const [id, field] of fields) { const value = field.free.value || field.options.find(o => o.checked)?.value; if (!value) { field.free.focus(); return; } answers[id] = [value]; } post('approval', { id: request.id, answers }); }); card.append(submitAnswer);
        card.onsubmit = e => { e.preventDefault(); submitAnswer.click(); };
      } else { const actions = el('div', 'approval-actions'); for (const [decision, label] of [['accept', '允许'], ['decline', '拒绝'], ['cancel', '取消任务']]) actions.append(button(label, label, () => post('approval', { id: request.id, decision }))); card.append(actions); card.onsubmit = e => e.preventDefault(); }
      approvals.append(card);
    }
    approvals.hidden = !requests.length;
  }
  function render() {
    status.replaceChildren(); status.dataset.connection = state.connection;
    status.append(el('span', 'connection-dot'), el('span', '', `${({ offline: '未连接', connecting: '连接中…', ready: '已连接', error: '连接异常' })[state.connection] || '未连接'} · ${state.accountLabel || 'Codex'}`));
    if (state.error) status.append(el('span', 'status-error', redact(state.error)));
    if (state.connection !== 'ready') status.append(button('重新连接', '↻', () => post('refresh')));
    if (state.accountLabel?.includes('未登录')) status.append(button('登录 Codex', '登录', () => post('login')));
    renderTree(); renderPane('main'); renderPane('side'); renderApprovals(); layout();
    if (ui.jump) { const entry = panes.main.nodes.get(ui.jump); if (entry) { entry.article.scrollIntoView({ block: 'center' }); entry.article.classList.add('reference-target'); ui.jump = null; } }
  }
  window.addEventListener('message', event => {
    const message = event.data; if (!message || typeof message.type !== 'string') return;
    if (message.type === 'state') {
      state = message.state; render();
      for (let i = queuedReferences.length - 1; i >= 0; i--) {
        const ref = queuedReferences[i];
        if (!state.side || (ref.threadId && ref.threadId !== state.side.id) || (ref.explain && (state.side.busy || pending.side))) continue;
        queuedReferences.splice(i, 1); consumeSideReference(ref);
      }
    }
    if (message.type === 'addReference') {
      if (message.channel === 'side') {
        if (message.threadId && message.threadId === state.side?.id && !(message.explain && (state.side.busy || pending.side))) consumeSideReference(message);
        else queuedReferences.push(message);
      } else addReference('main', message.reference, message.explain);
    }
    if (message.type === 'restoreDraft') {
      const old = ui.drafts[`main:${message.threadId}`];
      if (old && (old.text.trim() || old.references.length) && panes.main.key !== `main:${message.threadId}`) {
        panes.main.recoveredDraft = JSON.parse(JSON.stringify(old));
        const target = getDraft(panes.main.key);
        if (!target.text.trim() && !target.references.length) recoverDraft('main');
        else panes.main.recovery.hidden = false;
      }
    }
    if (message.type === 'error') {
      const channel = message.channel === 'side' ? 'side' : 'main'; panes[channel].error.textContent = redact(message.message);
      // Unscoped failures (refresh, settings, approvals) must not release an in-flight send.
      if (message.channel && (!message.threadId || pending[channel]?.sessionId === message.threadId)) { delete pending[channel]; panes[channel].send.disabled = false; }
    }
    if (message.type === 'sent') {
      const channel = message.channel === 'side' ? 'side' : 'main'; const sent = pending[channel];
      if (!sent || (sent.sessionId && sent.sessionId !== message.threadId)) return;
      const original = ui.drafts[sent.key]; if (sameDraft(original, sent.snapshot)) ui.drafts[sent.key] = { text: '', references: [] };
      const key = `${channel}:${message.threadId}`;
      if (sameDraft(ui.drafts[key], sent.snapshot)) ui.drafts[key] = { text: '', references: [] };
      delete pending[channel]; if (panes[channel].key === key || panes[channel].key === sent.key) { panes[channel].input.value = getDraft(panes[channel].key).text; renderReferences(channel); } panes[channel].send.disabled = false; persist();
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { toolbar.hidden = true; if (preview.open) preview.close(); else if (ui.drawer && !ui.pinned) { ui.drawer = false; layout(); drawerToggle.focus(); } else if (ui.sideVisible) { ui.sideVisible = false; layout(); } }
    if (event.altKey && event.key.toLowerCase() === 'l') { event.preventDefault(); ui.drawer = !ui.drawer; layout(); (ui.drawer ? search : drawerToggle).focus(); }
  });
  render(); post('ready');
})();
