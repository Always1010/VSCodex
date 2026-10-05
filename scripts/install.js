'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const manifest = require('../package.json');
const defaultPackage = path.resolve(__dirname, '..', 'artifacts', `${manifest.name}.vsix`);

function findCli({ env = process.env, platform = process.platform } = {}) {
  const candidates = [];
  if (env.VSCODE_CLI) candidates.push(path.resolve(env.VSCODE_CLI));
  else {
    const names = platform === 'win32' ? ['code.cmd', 'code-insiders.cmd'] : ['code', 'code-insiders'];
    for (const dir of (env.PATH || '').split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
      for (const name of names) candidates.push(path.join(dir.replace(/^"|"$/g, ''), name));
    }
    if (platform === 'win32') {
      for (const dir of [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) {
        candidates.push(path.join(dir, 'Microsoft VS Code', 'bin', 'code.cmd'));
      }
    }
  }
  const cli = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!cli) throw new Error('未找到 VS Code 命令行。安装包已保留；可用 VSCODE_CLI 指定已有 code 命令路径后运行 npm run install:local。');
  if (platform !== 'win32') return { command: cli, args: [], env };
  // Use the exact runtime and CLI recorded by VS Code's launcher. New installations
  // may place resources under a versioned directory. No cmd shell interpolation.
  const source = fs.readFileSync(cli, 'utf8');
  const launch = source.match(/"(%~dp0[^"\r\n]+\.exe)"\s+"(%~dp0[^"\r\n]+cli\.js)"\s+%\*/i);
  if (!launch) throw new Error(`无法识别 VS Code 启动脚本：${cli}。请将 VSCODE_CLI 指向安装目录中的 bin/code.cmd。`);
  const command = path.resolve(path.dirname(cli), launch[1].slice(5));
  const cliScript = path.resolve(path.dirname(cli), launch[2].slice(5));
  if (![command, cliScript].every(file => fs.existsSync(file) && fs.statSync(file).isFile())) throw new Error('VS Code 启动脚本引用的可执行文件或 CLI 不存在。');
  return { command, args: [cliScript], env: { ...env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' } };
}

function install(filename = defaultPackage, { resolveCli = findCli, execute = spawnSync, log = console.log } = {}) {
  const destination = path.resolve(filename);
  const indexPath = path.join(path.dirname(destination), `${manifest.name}.update.json`);
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  if (index.extensionId !== `${manifest.publisher}.${manifest.name}` || index.file !== path.basename(destination)) throw new Error('安装包与本项目的打包索引不匹配。');
  const bytes = fs.readFileSync(destination);
  if (createHash('sha256').update(bytes).digest('hex') !== index.sha256) throw new Error('安装包校验失败，请重新打包。');
  const cli = resolveCli();
  log(`正在安装 VSCodex ${index.version}：${destination}`);
  // A second build can replace the stable output while the CLI is reading it.
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vscodex-install-'));
  const snapshot = path.join(temporary, index.file);
  try {
    fs.writeFileSync(snapshot, bytes);
    const result = execute(cli.command, [...cli.args, '--install-extension', snapshot, '--force'], {
      env: cli.env, stdio: 'inherit', windowsHide: true, shell: false, timeout: 120000
    });
    if (result.error) throw new Error(`安装失败，VSIX 已保留：${result.error.message}`);
    if (result.status !== 0) throw new Error(`VS Code 安装失败（退出码 ${result.status ?? result.signal}），VSIX 已保留，可运行 npm run install:local 重试。`);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  log('安装完成。若 VS Code 已打开，请等当前任务结束后重新加载窗口，新版即可生效。');
  return destination;
}
if (require.main === module) {
  try {
    if (process.argv.length > 2) throw new Error('用法：node scripts/install.js');
    install();
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { findCli, install };
