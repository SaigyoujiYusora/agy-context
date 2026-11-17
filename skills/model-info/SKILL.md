---
name: model-info
description: 查看当前会话或近期会话发往上游的实际模型 ID (sentModel) 与上游 SSE 返回模型版本 (responseModel)、modelDisplayName、model_enum、DSH 口径会话统计（模型/工具用时、正文/思考输出、缓存命中率、TTFT 与纯 Decode/含TTFT 一键切换 TPS）以及 dsh-context 四标签页透视面板（Context / Browser / Insights / Fleet）。触发词：/model-info、查看返回的模型名称、真实模型、实际模型id、什么模型、model info、responseModel。
---

# AGY Context (`model-info`)

当用户询问“当前使用的是什么模型”、“查看返回的模型名称 / 实际模型 ID / 会话统计”、触发 `/model-info` 或想配置模型徽章 / TPS 统计口径时，按以下步骤执行：

## 1. 查询当前会话与近期会话的真实模型 ID 与 DSH 会话统计

直接运行插件内置的查询脚本（传入当前会话 UUID）并向用户展示输出的 Markdown 报告：

```powershell
node --no-warnings "$HOME/.gemini/config/plugins/agy-model-inspector/scripts/cli_query.mjs" --conversation "<CURRENT_CONVERSATION_ID>" --steps 15 --recent 8
```

> **重要说明**：请同时展示脚本解析出的两层模型字段与 DSH 口径统计：
> - **`sentModel`（发往上游实际模型 ID，来自 `gen_metadata.f3.f28`）**：例如 `gemini-4-carbon-medium`、`gemini-4-argon-high`、`claude-opus-5-5-medium`。
> - **`responseModel`（上游 SSE `response.modelVersion`，来自 `gen_metadata.f1.f19`）**：例如 `gemini-4-carbon`、`claude-opus-5-5-medium`。
> - **DSH `会话统计`**：`模型调用用时`、`工具调用用时`、`首 token 平均 (TTFT)`、`会话输出速率 (TPS)`（按 `总输出 Token ÷ 流式时长` 且总时长加权）、`最近一次请求`、`正文 / 思考输出` 与 `缓存命中`。

## 2. 切换对话内自动徽章模式或 TPS 口径（按需）

如果用户希望修改每轮对话自动追加的模型信息徽章模式，或一键切换纯 Decode / 含 TTFT 的 TPS 统计口径，运行：

- **仅在模型输出回复末尾追加极简 DSH 胶囊（默认）**：
  ```powershell
  node --no-warnings "$HOME/.gemini/config/plugins/agy-model-inspector/scripts/cli_query.mjs" --badge-mode on_reply
  ```
- **每次工具调用步都注入步骤徽章**：
  ```powershell
  node --no-warnings "$HOME/.gemini/config/plugins/agy-model-inspector/scripts/cli_query.mjs" --badge-mode every_step
  ```
- **关闭对话内自动徽章（仅通过命令或侧边栏面板查看）**：
  ```powershell
  node --no-warnings "$HOME/.gemini/config/plugins/agy-model-inspector/scripts/cli_query.mjs" --badge-mode off
  ```
- **一键切换 TPS 口径（纯 Decode ⇄ 含 TTFT 端到端）**：
  ```powershell
  node --no-warnings "$HOME/.gemini/config/plugins/agy-model-inspector/scripts/cli_query.mjs" --tps-mode e2e   # 或 decode
  ```

## 3. 提供侧边栏与辅助面板快捷入口 (`Context / Browser / Insights / Fleet`)

在回复末尾附上可视化透视面板的快捷打开链接（保持 `&auto_open=false`，仅在点击时展开）：

```markdown
[AGY Context 面板](sidecar://agy-model-inspector/panel/?conversationId=<CURRENT_CONVERSATION_ID>&auto_open=false)
```
