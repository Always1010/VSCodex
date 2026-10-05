'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build, run } = require('../scripts/package');
const { findCli, install } = require('../scripts/install');

test('仅在打包成功后安装，纯打包和参数错误不会安装', () => {
  const calls = [];
  const dependencies = { buildPackage: () => { calls.push('build'); return '/output/example.vsix'; }, installPackage: file => calls.push(file) };
  assert.equal(run([], dependencies), '/output/example.vsix');
  assert.deepEqual(calls, ['build', '/output/example.vsix']);
  calls.length = 0;
  run(['--no-install'], dependencies); assert.deepEqual(calls, ['build']);
  calls.length = 0;
  assert.throws(() => run(['--unknown'], dependencies), /用法/); assert.deepEqual(calls, []);
  assert.throws(() => run([], { ...dependencies, buildPackage: () => { throw new Error('build failed'); } }), /build failed/);
  assert.deepEqual(calls, []);
});

test('校验完整安装包后用无窗口 CLI 安装副本，失败保留包并允许重试', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vscodex-install-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.resolve(__dirname, '..');
  for (const name of ['package.json', 'extension.js', 'README.md', 'lib', 'src', 'media', 'docs']) fs.cpSync(path.join(root, name), path.join(base, name), { recursive: true });
  const filename = build(base); const bytes = fs.readFileSync(filename); let snapshot; let attempts = 0;
  const options = { log() {}, resolveCli: () => ({ command: 'VS Code executable', args: ['CLI entry'], env: { marker: 'child only' } }), execute: (command, args, settings) => {
    attempts++; snapshot = args[2];
    assert.equal(command, 'VS Code executable');
    assert.deepEqual(args, ['CLI entry', '--install-extension', snapshot, '--force']);
    assert.deepEqual(settings.env, { marker: 'child only' });
    assert.equal(settings.windowsHide, true); assert.equal(settings.shell, false);
    assert.notEqual(snapshot, filename);
    fs.writeFileSync(filename, 'another build');
    assert.deepEqual(fs.readFileSync(snapshot), bytes);
    return { status: attempts === 1 ? 1 : 0 };
  } };
  assert.throws(() => install(filename, options), /退出码 1/);
  assert.equal(fs.existsSync(filename), true); assert.equal(fs.existsSync(snapshot), false);
  fs.writeFileSync(filename, bytes);
  assert.equal(install(filename, options), filename);
  assert.equal(attempts, 2); assert.equal(fs.existsSync(snapshot), false);
  // The source was replaced above; reject it before invoking the CLI again.
  assert.throws(() => install(filename, options), /校验失败/); assert.equal(attempts, 2);
  fs.writeFileSync(filename, bytes);
  const indexPath = path.join(path.dirname(filename), 'vscodex-workbench.update.json');
  const index = JSON.parse(fs.readFileSync(indexPath)); index.extensionId = 'another.extension';
  fs.writeFileSync(indexPath, JSON.stringify(index));
  assert.throws(() => install(filename, options), /不匹配/); assert.equal(attempts, 2);
});

test('发现 Windows 标准及版本目录 CLI，路径含空格也不经过 Shell', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vscodex-cli-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const app = path.join(base, 'Microsoft VS Code'); const bin = path.join(app, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(app, 'Code.exe'), 'fake runtime');
  const cli = path.join(bin, 'code.cmd');
  const env = { PATH: bin, unchanged: 'yes' };
  for (const prefix of ['', '07f806f999/']) {
    const script = path.join(app, prefix, 'resources', 'app', 'out', 'cli.js');
    fs.mkdirSync(path.dirname(script), { recursive: true }); fs.writeFileSync(script, '// fake cli');
    fs.writeFileSync(cli, `@echo off\n"%~dp0../Code.exe" "%~dp0../${prefix}resources/app/out/cli.js" %*\n`);
    const resolved = findCli({ env, platform: 'win32' });
    assert.equal(resolved.command, path.join(app, 'Code.exe')); assert.deepEqual(resolved.args, [script]);
    assert.equal(resolved.env.ELECTRON_RUN_AS_NODE, '1'); assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  }
  assert.throws(() => findCli({ env: { VSCODE_CLI: path.join(base, 'absent'), PATH: bin }, platform: 'win32' }), /未找到/);
  fs.writeFileSync(cli, '@echo off\nunrecognized command');
  assert.throws(() => findCli({ env, platform: 'win32' }), /无法识别/);
});
