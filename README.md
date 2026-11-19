# AGY Context

适用于 Google Antigravity 的上下文与模型透视插件，提供 DSH 风格底部状态栏、回复用量统计与多标签页透视面板。

## 功能

- **底部状态栏与回复操作区**：在输入框下方实时显示轮/步数、输出速度（TPS）、TTFT、Token 用量、缓存命中率、估算费用与上下文进度，并在每条回复操作区显示单轮用量与分支按钮。
- **透视面板**：内置侧边栏与辅助面板（`上下文` / `编队` / `上下文洞察` / `调用全表` / `插件设置`），可查看真实上游模型（`sentModel` / `responseModel`）、完整系统提示词、工具 Schema 与调用明细。
- **即开即用**：随 Antigravity 启动自动生效，无需开启 CDP，不修改 `app.asar`。

## 安装与卸载

需要 Windows、PowerShell 7（`pwsh`）与 Node.js：

```powershell
# 安装（完成后完全退出 Antigravity 并重新打开一次即可生效）
pwsh ./install.ps1

# 卸载
pwsh ./install.ps1 -Uninstall
```

> 如 Antigravity 安装在非默认路径，可通过 `-AntigravityDir "<路径>"` 指定。

## 自行编译 `DWrite.dll`

仓库已附带源码（`native/dwrite_loader.c`）与预编译好的 `native/DWrite.dll`。如需自行重新编译，安装 Visual Studio / Build Tools（勾选 C++ x64 工具链）后执行：

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
