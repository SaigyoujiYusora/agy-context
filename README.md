# AGY Context

适用于 Google Antigravity 的上下文与模型透视插件，提供 DSH 风格底部状态栏、原生额度胶囊、回复用量统计与多标签页透视面板。

## 功能

- **底部状态栏与回复统计**：在输入框下方显示模型图标、轮/步数、TPS、TTFT、Token 用量、缓存命中率、估算费用、上下文进度和原生额度胶囊，并在每条回复下方显示单轮用量。
- **多标签透视面板**：包含 `上下文`、`编队`、`上下文洞察`、`调用全表` 和 `插件设置`：
  - **上下文压缩线**：进度条对齐 Antigravity 真实压缩上限，支持超窗溢出提示。
  - **调用全表与路由**：展示模型、思考强度、缓存命中率、TTFT、系统提示词与工具 Schema。
  - **更新检查**：自动检测 GitHub Releases 新版本。
- **DLL 自动注入**：通过内置 `DWrite.dll` 完成界面注入，支持自动安装与更新后自动补装，不修改 `app.asar`。

## 安装与卸载

需要 Windows x64、PowerShell 7 与 Node.js。

### 方式一：下载 Release 压缩包

1. 前往 [GitHub Releases](https://github.com/SaigyoujiYusora/agy-context/releases/latest) 下载 `agy-context-v*-windows-x64.zip`。
2. 解压后在目录中打开 PowerShell 7 执行安装，完成后重启一次 Antigravity 即可生效：

```powershell
# 安装
pwsh ./install.ps1

# 卸载
pwsh ./install.ps1 -Uninstall
```

### 方式二：从源码安装

```powershell
git clone https://github.com/SaigyoujiYusora/agy-context.git
cd agy-context
pwsh ./install.ps1
```

> 非默认安装路径可通过 `-AntigravityDir "<路径>"` 指定。

## 编译 `DWrite.dll`

Release 中的 `DWrite.dll` 由 [`.github/workflows/release.yml`](.github/workflows/release.yml) 从源码自动编译打包。

如需本地自行编译，安装 Visual Studio / Build Tools 的 C++ x64 工具链后执行：

```powershell
pwsh ./native/build-dll.ps1
```

编译产物会输出到 `native/DWrite.dll`。

## 致谢与声明

界面中使用的 **Google Gemini** 与 **Google Antigravity** 官方品牌图标不在本仓库开源协议授权范围内，版权归 Google 所有。

本项目复用/参考了以下开源组件：

- **[dsh-context](https://github.com/bowenliang123/dsh-context)** — Apache License 2.0，见 [LICENSE.dsh-context](sidecars/panel/vendor/LICENSE.dsh-context)。
- **DeepSeek Harness UI 图标与进度环** — MIT License，见 [LICENSE.dsh-icons](sidecars/panel/vendor/LICENSE.dsh-icons)。
- **React & ReactDOM** — MIT License。
