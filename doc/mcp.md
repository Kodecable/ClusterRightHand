# MCP 门面

不使用内置 agent 时，CRH 作为 MCP 服务器把节点集群提供给外部 coding agent（Claude Code、Codex 等）。

## 接入

- 传输：Streamable HTTP，路径 `/mcp`。
- 鉴权：`Authorization: Bearer <api-token>`，见 [access-control.md](access-control.md#api-token)。OAuth 后续再加。
- 在 WebUI 的"API tokens"页面创建 token（选择规则预设 Ask 或 Yolo），然后在 Claude Code 中添加：

  ```sh
  claude mcp add --transport http crh https://<crhs>/mcp --header "Authorization: Bearer crh_…"
  ```
- 实现：`@modelcontextprotocol/server` v2 的 `createMcpHandler`，无状态（每个请求一个 `McpServer` 实例），同时服务 2026-07-28 和 2025 年版本的客户端。
- 只支持 stdio 的客户端可以使用通用的 stdio ↔ HTTP 桥（例如 `mcp-remote`），CRH 不提供自己的桥。

## 工具

与 agent 共用同一份 `ToolCatalog`（见 [agent-runtime.md](agent-runtime.md#cluster-工具)），所以工具名称、参数和语义完全一致：

`list_nodes`、`node_info`、`exec`、`read_file`、`write_file`、`edit_file`、`list_dir`、`stat`、`task_wait`、`task_cancel`。`exec`、`read_file`、`write_file`、`list_dir`、`stat`、`node_info`、`edit_file` 用同一个 `targets` 参数支持批量执行（一个节点名是单个任务，多个条目或节点组是任务组）；`node_info` 和 `edit_file` 也用 `targets`（D114）。

结果是 MCP 的内容块：`exec` 和 `read_file` 是原文块加说明块，其余工具是一个 JSON 文本块；失败时 `isError: true`（D112，见 [agent-runtime.md](agent-runtime.md#交给模型的输出d112)）。agent 的 `details` 不发给 MCP 客户端。

能访问哪些节点，与 token 所属用户相同（管理员是全部节点，其他人是访问授权覆盖的节点）；能对这些节点做什么，由 token 的规则决定：token 是 MCP 规则链的根，创建时选择规则预设 Ask 或 Yolo（Auto Review 在 M3 之后可用），见 [access-control.md](access-control.md#授权规则)。需要审批时直接交给 token 所属的用户。

## 与 agent 模式的差异

| 方面 | agent 会话 | MCP |
|---|---|---|
| 操作者 | `session`，代表会话所有者 | `api_token`，代表 token 所属用户 |
| 规则链的根 | 根会话 | API token |
| 等待审批 | 工具一直等待，UI 显示审批状态 | `exec` 在 `wait` 内等待；超时返回"等待审批中，task_id = X，审批链接 = …"，客户端之后用 `task_wait` 跟进。文件工具一直等待，不返回任务 id（D111）；客户端自己的调用超时先到时，请求被关闭，任务随之取消 |
| 长任务 | 同左 | 同左：超过 `wait` 返回 task_id，之后用 `task_wait`；完整输出用 `read_file` 读取节点上的输出文件 |
| 策略与审计 | Cluster 核心 | 同一个 Cluster 核心，规则可以按来源类型区分 |

## 后续

- 暴露"向某个 agent 会话提问"的工具，让外部 coding agent 可以把任务委托给 CRH 的会话。
- MCP resources：节点列表、任务输出。
