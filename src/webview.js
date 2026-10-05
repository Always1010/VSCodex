'use strict';

function escapeAttribute(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function renderWebview({ scriptUri, styleUri, cspSource, nonce }) {
  const escape = escapeAttribute;
  const csp = `default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'; img-src ${cspSource} data:;`;
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="${escape(csp)}"><link rel="stylesheet" href="${escape(styleUri)}"><title>Codex 工作台</title></head>
<body><div id="app"></div><script nonce="${escape(nonce)}" src="${escape(scriptUri)}"></script></body></html>`;
}

module.exports = { renderWebview };
