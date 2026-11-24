# AGY Context

适用于 Google Antigravity 的上下文与模型透视插件，提供 DSH 风格底部状态栏、原生额度胶囊、回复用量统计与多标签页透视面板。

## 功能

- **底部状态栏与回复操作区**：在输入框下方实时显示模型厂商图标、轮/步数、输出速度（TPS）、TTFT、Token 用量、缓存命中率、估算费用（含 Gemini 4 Neon 费率）、上下文进度以及**原生额度进度胶囊**（直接通过本地 Language Server RPC 读取）；每条回复操作区显示单轮用量统计。
- **透视面板**：内置侧边栏与辅助面板（`上下文` / `编队` / `上下文洞察` / `调用全表` / `插件设置`）：
  - **真实压缩线对齐**：上下文进度条对齐 Antigravity 真实的 `100%` 强制压缩线（`checkpoint_config.max_token_limit`，如 `512k` / `256k`），支持单轮超窗溢出徽章与溢出段提示。
  - **模型路由与调用全表**：紧凑展示模型与思考强度（自动剥离 `-high` / `-xhigh` / `-medium` / `-low` 后缀避免路由不一致误报），并提供单次调用缓存命中率、TTFT / 流式耗时、完整系统提示词与工具 Schema 查看。
  - **版本更新检查**：自动检测 GitHub Releases 新版本，在设置页与界面内提示更新。
- **即开即用 & 零上下文开销**：随 Antigravity 启动自动生效，无需开启 CDP，不修改 `app.asar`，也不向对话注入任何额外 Skill/Rule 文本。

## 安装与卸载

需要 Windows（x64）、PowerShell 7（`pwsh`）与 Node.js。

### 方式一：下载 Release 压缩包（推荐）

1. 前往 [GitHub Releases](https://github.com/SaigyoujiYusora/agy-context/releases/latest) 下载 `agy-context-v*-windows-x64.zip`（内置由 GitHub Actions 从源码编译好的 `native/DWrite.dll`，可用同页 `SHA256SUMS.txt` 校验）。
2. 解压后在目录中打开 **PowerShell 7 (`pwsh`)** 执行安装：

```powershell
# 安装（完成后完全退出 Antigravity 托盘并重新打开一次即可生效）
pwsh ./install.ps1

# 卸载
pwsh ./install.ps1 -Uninstall
```

### 方式二：从源码仓库安装

```powershell
git clone https://github.com/SaigyoujiYusora/agy-context.git
cd agy-context
pwsh ./install.ps1
```

> 如 Antigravity 安装在非默认路径，可通过 `-AntigravityDir "<路径>"` 指定；如不需要 DLL 注入器，可附加 `-NoDllLoader`。

## 编译 `DWrite.dll` 与自动发布

Release 中的 `DWrite.dll` 由 [`.github/workflows/release.yml`](.github/workflows/release.yml) 在 `windows-latest` 环境下从源码自动编译并打包（推送 `v*` tag 或手动触发工作流即可发布）。

如需本地自行编译，安装 Visual Studio / Build Tools（勾选 C++ x64 工具链）后执行：

```powershell
pwsh ./native/build-dll.ps1
```

脚本会自动定位 MSVC x64 环境（`vcvars64.bat`）并将 `native/dwrite_loader.c` 编译输出到 `native/DWrite.dll`。

## 致谢与声明

界面中用于产品标识的 **Google Gemini** 与 **Google Antigravity** 官方品牌图标不在本仓库开源协议授权范围内，其商标与图形版权归原权利人 Google 所有。

本项目复用/参考了以下开源项目与组件，并保留各自版权与许可声明：

- **[dsh-context](https://github.com/bowenliang123/dsh-context)**（`v0.83.1`, Copyright 2025 `bowenliang123`）— Apache License 2.0，见 [LICENSE.dsh-context](sidecars/panel/vendor/LICENSE.dsh-context)。
- **DeepSeek Harness UI 图标与进度环**（Copyright (c) 2026 DeepSeek）— MIT License，见 [LICENSE.dsh-icons](sidecars/panel/vendor/LICENSE.dsh-icons)。
- **React & ReactDOM**（`v18.3.1`, Copyright (c) Facebook, Inc. and its affiliates）— MIT License。
