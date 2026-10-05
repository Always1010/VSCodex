'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { zip, crc32, buildEntries, build } = require('../scripts/package');
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
test('固定安装包路径、内部版本自动递增且更新索引匹配完整包', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vscodex-package-'));
  try {
    const root = path.resolve(__dirname, '..');
    for (const name of ['package.json', 'extension.js', 'README.md', 'lib', 'src', 'media', 'docs']) fs.cpSync(path.join(root, name), path.join(base, name), { recursive: true });
    const filename = build(base); const indexPath = path.join(base, 'artifacts', 'vscodex-workbench.update.json');
    const first = JSON.parse(fs.readFileSync(indexPath));
    assert.equal(path.basename(filename), 'vscodex-workbench.vsix');
    assert.equal(first.sha256, createHash('sha256').update(fs.readFileSync(filename)).digest('hex'));
    assert.equal(first.extensionId, 'vscodex-local.vscodex-workbench');
    assert.equal(build(base), filename);
    assert.equal(JSON.parse(fs.readFileSync(indexPath)).version, first.version);
    fs.appendFileSync(path.join(base, 'extension.js'), '\n// changed\n');
    build(base);
    const second = JSON.parse(fs.readFileSync(indexPath));
    assert.equal(second.version, first.version.replace(/\d+$/, patch => String(Number(patch) + 1)));
    const bytes = fs.readFileSync(filename);
    assert.equal(second.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.ok(bytes.includes(Buffer.from(`"version": "${second.version}"`)));
    assert.ok(bytes.includes(Buffer.from(`Version="${second.version}"`)));
    assert.ok(bytes.includes(Buffer.from('vscodexLocalUpdates')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(base, 'package.json'))).version, first.version);
    fs.writeFileSync(indexPath, '{}');
    assert.throws(() => build(base), /扩展标识不匹配/);
    assert.deepEqual(fs.readFileSync(filename), bytes);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
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
