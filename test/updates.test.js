'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { build, zip } = require('../scripts/package');
const { LocalUpdates, packageManifest } = require('../lib/local-updates');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vscodex-updates-'));
  const root = path.resolve(__dirname, '..');
  for (const name of ['package.json', 'extension.js', 'README.md', 'lib', 'src', 'media', 'docs']) fs.cpSync(path.join(root, name), path.join(base, name), { recursive: true });
  const filename = build(base); const manifest = packageManifest(fs.readFileSync(filename));
  const indexPath = path.join(base, 'artifacts', 'vscodex-workbench.update.json');
  const config = { autoUpdate: true, updateSource: '' }; const calls = []; const notifications = []; const logs = [];
  const vscode = {
    ExtensionMode: { Production: 1 }, env: {},
    workspace: { getConfiguration: () => ({ get: (key, fallback) => config[key] ?? fallback }) },
    Uri: { joinPath: (uri, ...parts) => ({ scheme: uri.scheme, fsPath: path.join(uri.fsPath, ...parts) }) },
    commands: { executeCommand: async (command, uri, options) => {
      calls.push({ command, uri, options, bytes: uri ? fs.readFileSync(uri.fsPath) : undefined });
    } },
    window: { showInformationMessage: async (...args) => { notifications.push(args); }, showErrorMessage: async message => { notifications.push([message]); } }
  };
  const context = { extension: { packageJSON: manifest }, extensionMode: 1, globalStorageUri: { scheme: 'file', fsPath: path.join(base, 'storage') } };
  const updates = new LocalUpdates(vscode, context, { appendLine: message => logs.push(message) });
  t.after(() => { updates.dispose(); fs.rmSync(base, { recursive: true, force: true }); });
  const rebuild = () => { fs.appendFileSync(path.join(base, 'extension.js'), '\n// new build\n'); build(base); };
  return { base, filename, indexPath, manifest, config, calls, notifications, logs, vscode, context, updates, rebuild };
}

test('新版自动安装完整副本、保留用户重载选择且重启后不重复安装', async t => {
  const f = fixture(t);
  assert.equal((await f.updates.check()).status, 'current');
  f.rebuild(); const expected = fs.readFileSync(f.filename);
  f.vscode.commands.executeCommand = async (command, uri, options) => {
    f.calls.push({ command, uri, options });
    assert.notEqual(uri.fsPath, f.filename);
    // Another build must not change the verified bytes passed to VS Code.
    f.rebuild();
    assert.deepEqual(fs.readFileSync(uri.fsPath), expected);
  };
  const result = await f.updates.check();
  assert.equal(result.status, 'updated');
  assert.equal(f.calls[0].command, 'workbench.extensions.installExtension');
  assert.equal(fs.existsSync(f.calls[0].uri.fsPath), false);
  assert.equal(f.calls.length, 1); // No automatic window reload.
  assert.equal(f.notifications.at(-1)[1], '重新加载窗口');
  // Match the source to the just installed build, including its original checksum.
  fs.writeFileSync(f.filename, expected);
  const index = JSON.parse(fs.readFileSync(f.indexPath));
  index.version = result.version; index.sha256 = createHash('sha256').update(expected).digest('hex');
  fs.writeFileSync(f.indexPath, JSON.stringify(index));
  assert.equal((await f.updates.check()).status, 'current');
  const restarted = new LocalUpdates(f.vscode, { ...f.context, extension: { packageJSON: packageManifest(expected) } }, { appendLine() {} });
  assert.equal((await restarted.check()).status, 'current'); restarted.dispose();
  assert.equal(f.calls.length, 1);
});

test('关闭自动更新仍可手动检查；开发宿主和远端不安装', async t => {
  const f = fixture(t); f.rebuild(); f.config.autoUpdate = false;
  assert.equal((await f.updates.check()).status, 'disabled');
  assert.equal(f.calls.length, 0);
  assert.equal((await f.updates.check(true)).status, 'updated');
  f.rebuild(); f.config.autoUpdate = true;
  f.context.extensionMode = 2;
  assert.equal((await f.updates.check()).status, 'unavailable');
  f.context.extensionMode = 1; f.vscode.env.remoteName = 'ssh-remote';
  assert.equal((await f.updates.check()).status, 'unavailable');
  f.vscode.env.remoteName = undefined; f.updates.dispose();
  assert.equal((await f.updates.check(true)).status, 'disabled');
  assert.equal(f.calls.length, 1);
});

test('只有用户选择重新加载时才执行重载命令', async t => {
  const f = fixture(t); f.rebuild();
  f.vscode.window.showInformationMessage = async () => '重新加载窗口';
  assert.equal((await f.updates.check()).status, 'updated');
  assert.deepEqual(f.calls.map(call => call.command), ['workbench.extensions.installExtension', 'workbench.action.reloadWindow']);
});

test('拒绝损坏包和错误扩展；安装失败可重试且并发检查只安装一次', async t => {
  const f = fixture(t); f.rebuild(); const goodBytes = fs.readFileSync(f.filename); const goodIndex = fs.readFileSync(f.indexPath);
  fs.writeFileSync(f.filename, Buffer.from('unfinished'));
  assert.equal((await f.updates.check()).status, 'error');
  assert.equal(f.calls.length, 0);
  const wrongBytes = zip([['extension/package.json', JSON.stringify({ publisher: 'other', name: f.manifest.name, version: JSON.parse(goodIndex).version })]]);
  fs.writeFileSync(f.filename, wrongBytes);
  fs.writeFileSync(f.indexPath, JSON.stringify({ ...JSON.parse(goodIndex), sha256: createHash('sha256').update(wrongBytes).digest('hex') }));
  assert.equal((await f.updates.check()).status, 'error');
  assert.equal(f.calls.length, 0);
  fs.writeFileSync(f.filename, goodBytes); fs.writeFileSync(f.indexPath, goodIndex);
  let attempts = 0; let release; let started;
  const installing = new Promise(resolve => { started = resolve; });
  f.vscode.commands.executeCommand = async () => {
    attempts++;
    if (attempts === 1) throw new Error('installation failed');
    started(); await new Promise(resolve => { release = resolve; });
  };
  assert.equal((await f.updates.check()).status, 'error');
  assert.equal(f.updates.pendingVersion, undefined);
  assert.deepEqual(fs.readdirSync(f.context.globalStorageUri.fsPath), []);
  const first = f.updates.check(); await installing;
  const second = f.updates.check(); release();
  assert.equal((await first).status, 'updated');
  assert.equal((await second).status, 'updated');
  assert.equal(attempts, 2);
});

test('移动更新目录一次后仍可更新，缺失目录保持现有版本，低版本不降级', async t => {
  const f = fixture(t); f.rebuild();
  const moved = path.join(f.base, 'moved'); fs.renameSync(path.dirname(f.filename), moved);
  assert.equal((await f.updates.check()).status, 'missing');
  f.config.updateSource = moved;
  assert.equal((await f.updates.check()).status, 'updated');
  const indexPath = path.join(moved, path.basename(f.indexPath)); const index = JSON.parse(fs.readFileSync(indexPath));
  index.version = '0.0.1'; fs.writeFileSync(indexPath, JSON.stringify(index));
  assert.equal((await f.updates.check()).status, 'current');
  assert.equal(f.calls.length, 1);
});
