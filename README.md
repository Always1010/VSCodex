# VSCodex Workbench

面向 VS Code 的个人 Codex 客户端，按项目管理聊天，使用本机已有的 `codex app-server`。

## 开发启动

需要已有 Node.js 20+、VS Code 1.95+ 和 Codex。项目没有第三方运行依赖，无需执行 `npm install`。

在 VS Code 打开本项目，选择“运行 VSCodex 开发宿主”并按 F5；或运行 `node scripts/package.js` 生成 VSIX 后手动安装。运行“VSCodex: 打开聊天工作台”（`Ctrl+Alt+C`）。

## 主要功能

- 当前项目筛选、多根工作区和目录关联。
- 可收起、固定的项目聊天导航与快速会话切换。
- 聊天文本与编辑器选区引用。
- 独立侧边项目分析、普通讨论和回答引用。
- Codex 流式对话、模型与权限选择、单次审批。

## 检查

运行 `npm run check` 检查 JavaScript 语法与扩展清单。

## 文档

[使用与开发指南](docs/GUIDE.md)：安装、配置、交互边界和针对性验证。

[已确认问题](docs/ISSUES.md)：实现缺陷的原因、修复与验证记录。
