'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', '.cache', 'artifacts', 'node_modules'].includes(entry.name)) continue;
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(target);
    else if (target.endsWith('.js')) files.push(target);
  }
}
walk(root);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(1); }
}
JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
console.log(`语法与清单检查通过：${files.length} 个 JavaScript 文件。`);
