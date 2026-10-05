'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { zip, crc32, buildEntries } = require('../scripts/package');
test('VSIX ZIP 校验和与目录定位正确，不包含开发数据或密钥', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const { entries, manifest } = buildEntries();
  const names = entries.map(([name]) => name);
  assert.ok(names.includes('extension/media/app.js'));
  assert.ok(names.includes('extension/lib/rpc.js'));
  assert.equal(names.some(name => /\.cache|test\/|AGENTS|node_modules|\.git/.test(name)), false);
  const bytes = zip(entries); const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  assert.equal(bytes.readUInt16LE(end + 10), entries.length);
  let cursor = bytes.readUInt32LE(end + 16);
  for (const [name, source] of entries) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const filenameLength = bytes.readUInt16LE(cursor + 28);
    assert.equal(bytes.subarray(cursor + 46, cursor + 46 + filenameLength).toString(), name);
    const offset = bytes.readUInt32LE(cursor + 42);
    assert.equal(bytes.readUInt32LE(offset), 0x04034b50);
    const content = Buffer.isBuffer(source) ? source : Buffer.from(source);
    assert.equal(bytes.readUInt32LE(offset + 14), crc32(content));
    assert.deepEqual(bytes.subarray(offset + 30 + filenameLength, offset + 30 + filenameLength + content.length), content);
    cursor += 46 + filenameLength;
  }
  assert.equal(cursor, end);
  assert.match(entries.find(([name]) => name === 'extension.vsixmanifest')[1], new RegExp(manifest.version.replaceAll('.', '\\.')));
  for (const view of Object.values(manifest.contributes.views).flat()) assert.equal(view.type, 'webview');
});
test('长期文档的本地链接均有目标', () => {
  const base = path.resolve(__dirname, '..');
  for (const filename of ['README.md', 'docs/GUIDE.md']) {
    const source = fs.readFileSync(path.join(base, filename), 'utf8');
    for (const match of source.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      assert.ok(fs.existsSync(path.resolve(base, path.dirname(filename), target)), `${filename}: ${target}`);
    }
  }
});
