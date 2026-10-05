'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { compareVersions } = require('./package-version');

// Local packages use stored ZIP entries. Validate their embedded identity before installing.
function packageManifest(bytes) {
  let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26); const extraLength = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extraLength; const end = start + size;
    if (end > bytes.length || bytes.readUInt16LE(offset + 8) !== 0 || (bytes.readUInt16LE(offset + 6) & 8)) throw new Error('不是本项目生成的完整安装包。');
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    if (name === 'extension/package.json') return JSON.parse(bytes.subarray(start, end).toString('utf8'));
    offset = end;
  }
  throw new Error('安装包缺少扩展清单。');
}

class LocalUpdates {
  constructor(vscode, context, output) {
    this.vscode = vscode; this.context = context; this.output = output;
    this.manifest = context.extension?.packageJSON || {};
    this.id = `${this.manifest.publisher}.${this.manifest.name}`;
  }
  config() { return this.vscode.workspace.getConfiguration('vscodex'); }
  source() { return this.config().get('updateSource') || this.manifest.vscodexLocalUpdates?.source || ''; }
  supported() {
    return this.context.extensionMode === this.vscode.ExtensionMode?.Production && !this.vscode.env?.remoteName;
  }
  start() {
    this.initial = setTimeout(() => this.check(), 2000);
    this.timer = setInterval(() => this.check(), 30000);
    this.initial.unref?.(); this.timer.unref?.();
  }
  async check(manual = false) {
    if (this.disposed || (!manual && !this.config().get('autoUpdate', true))) return { status: 'disabled' };
    if (!this.supported() || !this.source()) {
      if (manual) await this.vscode.window.showInformationMessage(!this.supported()
        ? '本地更新仅支持本机正式安装的扩展；开发宿主和远端请手动安装。'
        : '请在 VSCodex 设置中填写本地更新目录。');
      return { status: 'unavailable' };
    }
    if (this.operation) return this.operation;
    this.operation = this.installLatest(manual).catch(async error => {
      if (this.lastError !== error.message) this.output.appendLine(`本地更新：${error.message}`);
      this.lastError = error.message;
      if (manual) await this.vscode.window.showErrorMessage(`VSCodex 更新失败：${error.message}`);
      return { status: 'error' };
    }).finally(() => { this.operation = null; });
    return this.operation;
  }
  async installLatest(manual) {
    const source = this.source();
    if (!path.isAbsolute(source)) throw new Error('更新目录必须是绝对路径。');
    const indexPath = path.join(source, `${this.manifest.name}.update.json`);
    let index;
    try { index = JSON.parse(await fs.readFile(indexPath, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT' && !manual) return { status: 'missing' };
      throw error;
    }
    if (index.extensionId !== this.id || index.file !== `${this.manifest.name}.vsix` || !/^[a-f0-9]{64}$/.test(index.sha256)) throw new Error('更新索引无效或扩展标识不匹配。');
    if (compareVersions(index.version, this.pendingVersion || this.manifest.version) <= 0) {
      this.lastError = null;
      if (manual) await this.vscode.window.showInformationMessage(this.pendingVersion ? '新版已安装，重新加载窗口后生效。' : 'VSCodex 已是本地最新版本。');
      return { status: 'current' };
    }
    const bytes = await fs.readFile(path.join(source, index.file));
    if (createHash('sha256').update(bytes).digest('hex') !== index.sha256) throw new Error('安装包校验失败，可能正在打包；下次检查会重试。');
    const manifest = packageManifest(bytes);
    if (`${manifest.publisher}.${manifest.name}` !== this.id || manifest.version !== index.version) throw new Error('安装包与更新索引不一致。');
    // Install a verified snapshot so rebuilding the stable filename cannot replace bytes in flight.
    const storage = this.context.globalStorageUri;
    await fs.mkdir(storage.fsPath, { recursive: true });
    const temporary = await fs.mkdtemp(path.join(storage.fsPath, 'local-update-'));
    try {
      await fs.writeFile(path.join(temporary, index.file), bytes);
      if (this.disposed || (!manual && !this.config().get('autoUpdate', true)) || this.source() !== source) return { status: 'disabled' };
      const uri = this.vscode.Uri.joinPath(storage, path.basename(temporary), index.file);
      await this.vscode.commands.executeCommand('workbench.extensions.installExtension', uri);
      this.pendingVersion = index.version; this.lastError = null;
      this.output.appendLine(`已安装 VSCodex ${index.version}，等待重新加载窗口。`);
      Promise.resolve(this.vscode.window.showInformationMessage(`VSCodex ${index.version} 已更新，重新加载窗口后生效。`, '重新加载窗口')).then(choice => {
        if (choice === '重新加载窗口' && !this.disposed) return this.vscode.commands.executeCommand('workbench.action.reloadWindow');
      }).catch(error => this.output.appendLine(`更新提示：${error.message}`));
      return { status: 'updated', version: index.version };
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
  dispose() { this.disposed = true; clearTimeout(this.initial); clearInterval(this.timer); }
}
module.exports = { LocalUpdates, packageManifest };
