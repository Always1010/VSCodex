'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { compareVersions, nextVersion } = require('../lib/package-version');
const root = path.resolve(__dirname, '..');
const xml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
// A ZIP using stored entries avoids downloaded packagers and executable hooks.
function zip(entries) {
  const chunks = []; const directory = []; let offset = 0;
  for (const [name, source] of entries) {
    const filename = Buffer.from(name, 'utf8'); const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source, 'utf8');
    const checksum = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(33, 12); // 1980-01-01, deterministic package.
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
    chunks.push(local, filename, bytes);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(33, 14);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(central, filename); offset += local.length + filename.length + bytes.length;
  }
  const index = Buffer.concat(directory); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, index, end]);
}
function collectFiles(dir, prefix, entries) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const target = path.join(dir, entry.name); const name = `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`不打包符号链接：${target}`);
    if (entry.isDirectory()) collectFiles(target, name, entries);
    else entries.push([name, fs.readFileSync(target)]);
  }
}
function buildEntries(base = root, packagedManifest) {
  const manifest = packagedManifest || JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
  for (const key of ['name', 'version', 'publisher', 'main']) if (!manifest[key]) throw new Error(`扩展清单缺少 ${key}`);
  const entries = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="css" ContentType="text/css"/><Default Extension="svg" ContentType="image/svg+xml"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>'],
    ['extension.vsixmanifest', `<?xml version="1.0" encoding="utf-8"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="${xml(manifest.name)}" Version="${xml(manifest.version)}" Publisher="${xml(manifest.publisher)}"/><DisplayName>${xml(manifest.displayName)}</DisplayName><Description xml:space="preserve">${xml(manifest.description)}</Description><Tags>codex,chat,workspace</Tags><Categories>AI,Other</Categories><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(manifest.engines.vscode)}"/><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/></Properties></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/></Assets></PackageManifest>`]
  ];
  entries.push(['extension/package.json', JSON.stringify(manifest, null, 2) + '\n']);
  for (const name of ['extension.js', 'README.md']) entries.push([`extension/${name}`, fs.readFileSync(path.join(base, name))]);
  for (const dir of ['lib', 'src', 'media', 'docs']) collectFiles(path.join(base, dir), `extension/${dir}`, entries);
  if (!entries.some(([name]) => name === `extension/${manifest.main.replace(/^\.\//, '')}`)) throw new Error('扩展入口未包含在安装包。');
  return { manifest, entries };
}
function atomicWrite(destination, bytes) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, bytes); fs.renameSync(temporary, destination); }
  finally { fs.rmSync(temporary, { force: true }); }
}
function build(base = root) {
  const { manifest, entries: original } = buildEntries(base);
  const dir = path.join(path.resolve(base), 'artifacts'); fs.mkdirSync(dir, { recursive: true });
  const destination = path.join(dir, `${manifest.name}.vsix`);
  const indexPath = path.join(dir, `${manifest.name}.update.json`);
  const extensionId = `${manifest.publisher}.${manifest.name}`;
  const sourceHash = createHash('sha256').update(zip(original)).digest('hex');
  let previous;
  try { previous = JSON.parse(fs.readFileSync(indexPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`无法读取更新索引，未覆盖安装包：${error.message}`); }
  let version = manifest.version;
  compareVersions(version, version);
  if (previous) {
    if (previous.extensionId !== extensionId) throw new Error('更新索引的扩展标识不匹配，未覆盖安装包。');
    if (compareVersions(previous.version, version) >= 0) version = previous.sourceHash === sourceHash ? previous.version : nextVersion(previous.version);
  }
  const { entries } = buildEntries(base, { ...manifest, version });
  const bytes = zip(entries);
  atomicWrite(destination, bytes);
  atomicWrite(indexPath, JSON.stringify({ extensionId, version, sourceHash, file: path.basename(destination), sha256: createHash('sha256').update(bytes).digest('hex') }, null, 2) + '\n');
  console.log(`已生成 ${destination}（内部版本 ${version}，${entries.length} 个文件）`);
  return destination;
}
function run(args = process.argv.slice(2), { buildPackage = build, installPackage = require('./install').install } = {}) {
  if (args.some(arg => arg !== '--no-install')) throw new Error('用法：node scripts/package.js [--no-install]');
  const destination = buildPackage();
  if (!args.includes('--no-install')) installPackage(destination);
  return destination;
}
if (require.main === module) {
  try { run(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { zip, crc32, buildEntries, build, run };
