'use strict';
const readline = require('node:readline');
let initialized = false;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialized') { initialized = true; return; }
  if (!message.method) { process.stdout.write(JSON.stringify({ method: 'approval/ack', params: message }) + '\n'); return; }
  if (message.method === 'hang') return;
  if (message.method === 'exit') { process.exit(7); return; }
  if (message.method === 'events') {
    process.stdout.write(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 't1', itemId: 'i1', turnId: 'turn1', delta: '片段' } }) + '\n');
    process.stdout.write(JSON.stringify({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 't1' } }) + '\n');
  }
  const response = JSON.stringify({ id: message.id, result: { initialized, method: message.method, params: message.params } });
  // Force JSONL framing across chunks, including a Chinese character.
  const bytes = Buffer.from(response + '\n'); const middle = Math.floor(bytes.length / 2);
  process.stdout.write(bytes.subarray(0, middle)); setImmediate(() => process.stdout.write(bytes.subarray(middle)));
});
