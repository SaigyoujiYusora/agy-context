# AGY Context

运行时注入 DSH 风格底部状态栏和回复统计，并提供本地透视面板与 CLI 查询能力，从 Antigravity 实际请求记录与会话数据库读取模型、Token、系统提示词与上下文信息。不修改 `app.asar`、语言服务可执行文件或代理 DLL。

## 功能与数据来源

- **双层模型识别**：解析 `conversation_summaries.db` 与 `.pb` `generator_metadata`，提取发往上游的 `sentModel` 与上游返回的 `responseModel`。
- **底部状态栏与回复操作区**：通过本地 CDP 注入在输入框下方展示会话统计（轮/步数、TPS、TTFT、模型/工具用时）、Token 用量（总 Token、缓存命中率、估算费用与子代理汇总）以及上下文环形进度；在每条回复操作区显示单轮用量与分支按钮。
- **四标签页透视面板**：内置本地 HTTP 后端与 Web UI（`Context` / `Browser` / `Insights` / `Fleet`），支持查看完整系统提示词、工具定义 Schema、请求上下文分布与历史统计。
- **统计口径说明**：系统原文优先读取 `gen_metadata.chatModel.systemPrompt`；总 Token 使用宿主记录，分类 Token 与历史趋势在缺乏完整请求快照时按估算展示。

## 目录结构

- `plugin.json` / `hooks.json`：插件清单与 Pre/PostInvocation 钩子定义
- `scripts/`：检测与解析后端
  - `model_core.mjs` / `protobuf.mjs`：数据库与 Protobuf 解码、模型提取、Token/TTFT/TPS 与 Fleet 汇总
  - `dsh_bridge.mjs` / `stored_prompt.mjs` / `prompt_profiles.mjs`：DSH 上下文桥接与系统提示词读取
  - `runtime-injector.mjs`：通过本地 CDP 端口向 Antigravity 会话页注入状态栏与统计浮层
  - `cli_query.mjs` / `pre_invocation_hook.mjs` / `post_invocation_hook.mjs`：CLI 查询与调用钩子
- `sidecars/panel/`：本地 HTTP API 后端与透视面板前端（`server.mjs` 默认监听 `127.0.0.1:18922`，含 `ui.html`、`prompts.html`、`dsh_host.js`、`runtime-overlay.js` 与 `vendor/`）
- `skills/model-info/SKILL.md` / `rules/AGENTS.md`：`/model-info` 技能与规则定义
- `assets/`：插件图标与内置系统提示词模板
- `install.ps1`：PowerShell 7 一键安装脚本

## 安装与使用

### 安装部署（PowerShell 7）

依赖 **PowerShell 7 (`pwsh`)** 与 **Node.js**（无额外 npm 第三方运行时依赖）：

```powershell
pwsh ./install.ps1
```

脚本会将插件安装到 `~/.gemini/config/plugins/agy-model-inspector`（Antigravity 会自动扫描该目录并将插件加入插件列表，无需手动修改配置文件；若 Antigravity 正在运行，重启或刷新插件管理界面即可加载钩子、技能与 Sidecar），并自动启动本地后端 `sidecars/panel/server.mjs` 与 CDP 注入器 `scripts/runtime-injector.mjs`。

卸载可执行：

```powershell
pwsh ./install.ps1 -Uninstall
```

### CLI 查询

```powershell
node --no-warnings "$HOME/.gemini/config/plugins/agy-model-inspector/scripts/cli_query.mjs" --conversation "<CONVERSATION_ID>" --steps 15 --recent 8
```

常用参数：
- `--badge-mode on_reply | every_step | off`：切换对话内徽章模式
- `--tps-mode decode | e2e`：切换纯 Decode / 含 TTFT 的 TPS 计算口径

## 致谢与开源协议

本项目的前端透视面板与状态栏图标复用/参考了以下开源项目与组件，并严格遵循其各自开源协议保留版权与许可声明：

- **[dsh-context](https://github.com/bowenliang123/dsh-context)** (`v0.83.1`, Copyright 2025 `bowenliang123`) — 遵循 **Apache License 2.0**，完整协议文本见 [sidecars/panel/vendor/LICENSE.dsh-context](sidecars/panel/vendor/LICENSE.dsh-context)。
- **DeepSeek Harness UI 图标与进度环几何**（来自 `DeepSeek Harness 0.2.2-rc.2` `@deepseek-ai/dsh-web-frontend` 与 `@deepseek-ai/dsh-client-ui-conversation`，Copyright (c) 2026 DeepSeek）— 遵循 **MIT License**，完整协议文本见 [sidecars/panel/vendor/LICENSE.dsh-icons](sidecars/panel/vendor/LICENSE.dsh-icons)。
- **React & ReactDOM** (`v18.3.1`, Copyright (c) Facebook, Inc. and its affiliates) — 遵循 **MIT License**。
