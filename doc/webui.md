# WebUI 重构

目标：把原型阶段的 WebUI 重写为正式版本。现有页面样式和结构全部推倒重做，现有 API 类型、`sessionState` reducer 等纯逻辑代码可以复用。

范围：
- 侧边导航（图标与文字收缩切换）；
- 经典的会话侧边列表；
- Markdown 渲染和代码高亮；
- 统一的组件库、设计 token 和深浅色主题；
- i18n（原文英语，加简体中文）。

从第一天起按"超多会话、超多消息"设计，必要时调整后端 API。

选型依据：生态调研报告和两轮 POC（2026-10-31，代码在 `crh-poc/`，用后删除）。

## 技术栈

版本全部锁死，不写 `^`。

| 用途 | 库 | 版本 |
|---|---|---|
| 构建 | Vite / `@vitejs/plugin-react` | 8.3.5 / 6.1.2 |
| 框架 | React / react-dom | 19.3.1 |
| 样式 | Tailwind CSS / `@tailwindcss/vite`、`tw-animate-css` | 4.3.3 / 1.4.0 |
| 组件 | shadcn CLI（组件源码复制进项目），底层原语 `@base-ui/react` | 4.23.0 / 1.9.0 |
| 工具 | `clsx` + `tailwind-merge`（`cn()`）、`class-variance-authority` | 2.1.1 / 3.7.0 / 0.7.1 |
| 图标 | `lucide-react` | 1.66.0 |
| i18n | Lingui：`@lingui/core`、`react`、`cli`、`vite-plugin`（`macroTransform: true`）、`format-po`、`conf` | 6.11.0 |
| 路由 | `@tanstack/react-router`（代码定义路由，不用文件路由生成） | 1.170.x |
| 数据 | `@tanstack/react-query` | 5.105.x |
| 表格 | `@tanstack/react-table`（shadcn data-table 模式） | 9.3.x |
| 表单 | `react-hook-form` + `@hookform/resolvers` + `zod`（与服务端同一版本） | 7.91.x / 7.0.0 / 4.6.7 |
| 通知 | `sonner`（shadcn Toast） | 2.0.8 |
| 虚拟列表 | `virtua` | 0.54.0 |
| Markdown | `react-markdown` + `remark-gfm` + `marked`（只用 Lexer 切块）+ `remend` | 10.1.0 / 4.0.1 / 18.x / 1.4.0 |
| 代码高亮 | `shiki`（`createHighlighterCore` + `@shikijs/engine-javascript`，按语言细粒度导入） | 4.5.0 |
| 测试 | Vitest + Testing Library + jsdom、Playwright | 5.0.x / 1.64.0 |

时间和数字格式化用原生 `Intl`，不引入日期库。

## 前端架构

### 目录

```
web/src/
  app/            入口、Providers（Query、I18n、Theme、Toaster）、路由表、外壳布局
  components/ui/  shadcn 生成的组件（由项目维护，可以修改）
  components/     项目通用组件（StatusDot、RelativeTime、CopyButton、EmptyState…）
  features/<域>/  sessions、nodes、tasks、approvals、schedules、credentials、authorizations、tokens、audit、settings、users
                  每个域包含 api.ts（query/mutation hooks）、页面组件、域内组件、纯逻辑和测试
  lib/            api 客户端、SSE、theme、i18n、url 安全检查
  markdown/       SafeMarkdown、增量切块、Shiki 代码块
  locales/        en.po、zh-CN.po
```

### 路由

- 改为路径路由，例如 `/sessions/:id`、`/approvals/tasks/:id`；crhs 对 `/api`、`/agent` 以外的路径已经回退到 `index.html`（D60）。
- 每个页面独立成一个 chunk，懒加载。
- 兼容旧链接：如果打开时地址是 `#/...`，转换成对应路径并 `replace`。agent 的历史消息里有旧链接。
- 服务端生成的链接（MCP 的 `approvalUrl` / `taskUrl` / `groupUrl`、agent 工具结果里的 `authorization_url` 等）同步改为路径形式。

### 数据层

- 所有服务端状态都通过 TanStack Query 管理。
- 列表一律用 `useInfiniteQuery` 加游标。
- SSE 推送的变化由一个统一的客户端写入 Query 缓存：通过 `setQueryData` 打补丁，必要时 `invalidateQueries`。
- 401 统一跳转到登录页。
- 写操作用 mutation，成功后弹 toast 并让相关 query 失效。
- 原来的 `APPROVALS_CHANGED` 窗口事件，改为让 Query 缓存失效。

### 外壳

- 使用 shadcn `Sidebar`：
  - `collapsible="icon"`；收起状态存 `localStorage`；收起时显示 tooltip；
  - 窄于 768 px 时变成抽屉。
- 导航分组：
  - 工作：Sessions、Schedules、Tasks、Batch、Approvals（带待办数）
  - 集群：Nodes、Credentials、Authorizations
  - 管理：API tokens、Audit、Models\*、Users\*（\* 仅管理员可见）
- 底部是用户菜单：主题（跟随系统 / 浅色 / 深色）、语言、修改密码、登出。

### 主题与 token

- `<html data-theme>` 加 Tailwind `@custom-variant dark`。
- 语义 token 写成 CSS 变量，经 `@theme inline` 映射给 Tailwind。
- 沿用现有配色（蓝色强调色），状态色补齐浅底变体。
- 圆角、间距、阴影统一用 shadcn 的 token。
- `index.html` 里的内联脚本在首屏绘制前设好主题。
- 偏好存在 `localStorage`，读写都包 try/catch。

### i18n

- 用 Lingui 宏（`<Trans>`、`` t`…` ``、`<Plural>`）。消息 ID 是哈希，所以英文目录也要在启动时加载；中文目录懒加载。
- 初始语言取 `navigator.languages`：`zh*` 用 `zh-CN`，其余用 `en`。用户覆盖存 `localStorage`，同时更新 `<html lang>`。
- 用 `lingui extract` 提取，`i18n:check` 在 CI 里检查中文是否有漏翻。
- 任务状态、预设、审计事件这类枚举的显示名放进翻译。服务端错误信息和 agent 输出不翻译。

### 会话界面

**侧边列表：**
- 进入 Sessions 路由后出现第二栏，用 virtua 虚拟滚动，按游标无限加载。
- 搜索框带防抖，在服务端搜索。
- 每一项：状态点（idle / running / awaiting）、标题、相对时间，以及计划任务和共享的图标。
- 支持键盘上下键和回车。
- 范围切换：我的 / 共享给我 / 全部（仅管理员）。
- 列表变化由 SSE 推送（见后端部分）。

**消息视图：**
- 用 virtua 虚拟滚动，`shift` 处理向上插入的历史。
- 加一段锚点校正：插入历史、内容高度变化后，保持阅读位置在屏幕上不动。
- 贴底跟随的规则：
  - 用户位于底部时，跟随新内容；
  - 用户向上滚动后，立即停止跟随，并出现"跳到最新"按钮。
- POC 中的 6 项行为都必须有 e2e 测试。

**流式输出：**
- 正在生成的消息单独存在一个外部 store 里，用 `useSyncExternalStore` 订阅，并按动画帧合并更新。
- 列表本身只在消息条数变化时才重渲染。

**消息渲染：**
- 助手正文和 thinking 用 SafeMarkdown 渲染。
- 用户消息、工具参数、工具输出按原文显示（工具输出用等宽字体，可以折叠）。
- 审批、授权、配额等待以卡片形式插在消息中。
- 子会话可以从父会话进入，并有面包屑。

### SafeMarkdown

以 POC 的候选 A 为基础，加上以下优化：

1. **增量切块**：只从最后一个块的起点重新运行 Lexer，已完成的块按源文本缓存。
2. **未闭合代码块快速通道**：最后一个块是未闭合的代码块时，不走 Markdown 解析，直接把代码交给增量高亮。
3. **代码行分组缓存**：已完成的代码行每 100 行一组缓存，新增一行时不必协调全部行。
4. **语法预热**：常用语言（bash、shellsession、json、yaml、diff、ansi）在空闲时预加载。其余语言首次用到时加载，加载完成前先显示纯文本。
5. **引用式链接**：收集全文的引用定义，附加到每个块，使文末定义的链接也能解析。

安全规则（全部要有测试，包括 Playwright 网络拦截）：
- 不渲染原始 HTML。不用 `rehype-raw`；HTML 显示为文本或直接丢弃。
- 链接只允许 `http:`、`https:`、`mailto:`，要覆盖大小写、空白、实体编码等混淆写法；外链加 `rel="noopener noreferrer"`。
- 不渲染 `<img>`：Markdown 图片显示为文字链接，不发起任何请求。
- 代码块只渲染为文本节点和高亮 token；复制按钮复制原文。

代码高亮参照 shadcn Code Block 的算法：
- 只对新增的完整行分词，并接续上一行的语法状态（`grammarState`）；
- 双主题输出为 CSS 变量（`defaultColor: false`）；
- 支持的语言：bash、shellsession、json、yaml、diff、ini、toml、dockerfile、python、go、typescript、javascript、sql、nginx、ansi；未知语言显示为纯文本。

## 后端改动

### 游标分页

- 新增统一的 keyset 游标：
  - 游标是 `(排序键, id)` 编码成的不透明字符串；
  - 响应格式 `{ items, nextCursor }`；
  - `limit` 默认 50，最大 200。
- 以下接口改用游标：
  - `GET /api/sessions`
  - `GET /api/tasks`
  - `GET /api/audit`
  - `GET /api/schedules/:id/runs`
  - `GET /api/authorizations`（去掉 200 条的硬上限）
- 原来的 offset 分页删除，不保留兼容。已核对：crha 和 MCP 工具都不调用这些列表接口，WebUI 是唯一的调用方。

### 会话列表

- `GET /api/sessions?scope=mine|shared|all&q=&cursor=&limit=`：
  - 按 `updated_at desc, id` 排序；
  - 只返回根会话；
  - `all` 仅管理员可用。
- 返回轻量的 `SessionListItem`：id、title、ownerUserId、ownerName、scheduleId、shared、state、waitingLevelId、updatedAt。
  - 不再逐行查询规则集和已用 token，消除 N+1；
  - 详细信息仍走 `GET /sessions/:id`。
- 索引：
  - `(owner_user_id, parent_session_id, updated_at, id)`；
  - `scope=all` 用 `(parent_session_id, updated_at, id)`。
- 搜索：标题用 `LIKE` 子串匹配，参数做转义。SQLite 和 PG 都适用；数据量再大时再考虑 FTS 或 trigram。
- 会话的状态、标题或消息变化时，必须更新 `updated_at`。实现时核对所有写入点。
- `GET /api/sessions/stream`（SSE）：
  - 只推送当前用户可见的根会话的变化：`upsert`（携带 `SessionListItem`）和 `remove`；
  - 连接建立时不发全量数据；
  - 断线重连后，客户端重新拉取第一页。

### 会话事件流和历史

- `GET /sessions/:id/events` 的 snapshot 只带最近的 N 条记录（默认 100），另外附带 `historyCursor`。
- 新增 `GET /sessions/:id/entries?before=<cursor>&limit=`：
  - 用 durable 存储的 `scanEntries` 倒序扫描；
  - 返回的记录格式与 snapshot 里的 entries 相同；
  - 同样过滤掉 system 消息。
- 客户端 reducer 支持在头部插入一页历史，不影响正在进行的流式输出。
- 压缩（compaction）之前的记录照常可以翻页查看。

### API 约定（W1 实现，W2 按此编码）

**游标列表：**
- 请求参数：`?cursor=<string>&limit=<1..200, 默认 50>`，外加各接口自己的过滤参数。
- 响应：`{ "items": [...], "nextCursor": string | null }`。
- `cursor` 是 base64url 编码的 JSON（排序键 + id），对客户端不透明。服务端校验格式，无效时返回 400。
- 改为这一格式的接口：
  - `GET /api/sessions`：items 为 `SessionListItem`；
  - `GET /api/tasks`：保留现有过滤参数 `state`、`actorType`、`nodeId`，按 `created_at desc, id desc` 排序。去掉原来"等待我的任务排在最前"的特殊排序：等待我处理的事项统一在 Approvals 页显示，任务列表可以用 `state` 过滤；
  - `GET /api/audit`：保留 `action`、`targetType`、`targetId`，按 `seq desc` 排序，用 `cursor` 取代 `beforeSeq`；
  - `GET /api/schedules/:id/runs`；
  - `GET /api/authorizations`：保留现有过滤参数。

**`SessionListItem`：**

```ts
{
  id: string; title: string;
  ownerUserId: string; ownerName: string;
  scheduleId: string | null;
  shared: boolean;            // 不是当前用户本人拥有，而是共享给他的
  state: "idle" | "running" | "awaiting"; // 整棵会话树的汇总：任何会话 awaiting → awaiting；否则任何 running → running；否则 idle
  waitingKind: "quota" | "approval" | "authorization" | null; // 汇总为 awaiting 时，取树里优先级最高的等待（quota > approval > authorization）
  updatedAt: string;
}
```

**子会话列表** `GET /api/sessions/:id/children?cursor=&limit=`：
- 可见性与 `GET /api/sessions/:id` 相同，不可见时返回 404；
- 按 `updated_at desc, id desc` 排序，返回游标列表；
- `items` 是 `SessionListItem` 并带 `parentSessionId`；`state` / `waitingKind` 是子会话**自己的**状态，不是汇总；
- 列表推送不包含子会话，所以客户端在以下事件后重新拉取：
  - 本会话事件流的 `snapshot`；
  - `subagent` 工具的 `tool_execution_update` / `tool_execution_end`；
  - 列表推送中该会话树根会话的 `upsert`。

**会话列表实时推送** `GET /api/sessions/stream`（SSE）：
- `event: upsert`，data 为 `SessionListItem`；
- `event: remove`，data 为 `{ "id": string }`，会话被删除、取消共享或归档时发送；
- `event: ping`，每 15 秒一次。
- 只推送当前用户可见的根会话（管理员是全部）。会话树里任何会话的状态变化都推送其根会话。客户端按自己当前的 `scope` 和 `q` 过滤后，打补丁到已加载的列表；断线重连后重新拉取第一页。

**会话事件流** `GET /api/sessions/:id/events`：
- 第一条 `events` 批次中的 `snapshot` 事件，`entries` 只保留最近的 100 条可显示记录（不含 system 消息），并新增字段 `historyCursor: string | null`（为 null 表示没有更早的记录）。
- 其余事件格式不变。

**历史分页** `GET /api/sessions/:id/entries?before=<historyCursor>&limit=<1..200, 默认 100>`：
- 响应 `{ "entries": EntryRecord[], "historyCursor": string | null }`；
- `entries` 按从旧到新排列，紧接在 `before` 之前；
- 权限与 `events` 相同。

### 链接

服务端生成的 WebUI 链接一律改为路径形式（`/approvals/tasks/:id` 等）。

## 性能与质量目标

- 首屏：入口 JS ≤ 250 kB gzip（不含各页面的懒加载 chunk）。
- 会话列表 10 万条：首屏 < 200 ms（4× 降速），滚动没有明显卡顿。
- 消息视图 2 万条消息（全部加载后）：DOM 节点数恒定；向上插入历史时阅读位置偏移 ≤ 2 px。
- 流式输出：按真实速率（每秒 300 和 1500 字符）输出 100K 字符的消息，在 4× 降速下"停止"按钮的响应 p95 < 100 ms。
- 安全：外链图片请求为零，没有可执行的 HTML，没有非白名单协议的链接。
- 无障碍：侧边栏、菜单、对话框、列表都能完全用键盘操作，并用 Playwright 脚本验证。

## 分期

前端整体重写，不逐页迁移。现有页面之间耦合很多：
- `TaskResult` 同时用在会话的工具卡片、审批、批量和任务页；
- `Approval` / `AuthorizationWait` 卡片同时出现在会话、审批页和任务页；
- `ModelSelect`、任务表单字段、规则和预设编辑分散在多个页面。

所以先统一设计这些共享部件，然后一次性写完全部页面。旧的 `web/src` 在重写开始时整体删除，只保留可以复用的纯逻辑（`sessionState` reducer、`taskForm`、`scheduleForm`、`sshHops`、`authorization` 等），连同它们的测试一起迁到对应的 `features/` 目录。

在 `webui` 分支的 worktree 中进行，完成后整体合并回 main。

| 期 | 内容 | 验收 |
|---|---|---|
| **W1 后端** | 游标分页工具和各列表接口；`SessionListItem` 和索引；会话列表 SSE；snapshot 只带最近 N 条、加历史分页接口；链接改为路径 | 服务端测试（含 10 万会话的分页和搜索、历史翻页与流式输出交错）、e2e |
| **W2 前端重写** | 一次完成：基座（Tailwind、shadcn、token 和主题、Lingui、Router、Query 和 SSE 客户端、外壳）→ 共享部件 → 全部页面，界面文案从一开始就用 Lingui 宏 | 构建、类型检查、Vitest、`i18n:check`；全部 Playwright 场景重写并通过，含侧边栏、主题、语言、键盘、移动端、6 项滚动行为、Markdown 安全和正确性，以及真实速率的性能测试 |
| **W3 收尾** | 中文翻译人工校对；按路由拆包，检查体积；深浅两种主题下逐页截图审查和视觉修正；更新文档 | 体积预算、全部测试 |

### 共享部件（W2 中先于页面完成）

- **布局**：AppShell、PageHeader（标题、说明、操作区）、EmptyState、ErrorState、加载骨架。
- **数据展示**：
  - DataTable：基于 TanStack Table，支持游标无限加载、列定义、行操作；
  - KeyValue 列表；
  - StatusBadge / StatusDot：节点、任务、会话、授权、计划任务运行的状态，配色和翻译统一；
  - RelativeTime / DateTime：基于 `Intl`；
  - CopyButton、CodeText（等宽、可折叠的长输出）。
- **表单**：基于 react-hook-form + zod 的 Form 字段封装；以及 ModelSelect、PresetSelect、NodePicker（单选和多选）、TaskFormFields（exec / file.read / file.write / file.list，同时用于 RunPanel、Batch 和规则测试）。
- **任务**：TaskResult（输出、退出码、截断提示）、TaskSummary 行。这些同时用在任务页、批量、审批和会话的工具卡片里。
- **决策卡片**：ApprovalCard（批准 / 拒绝，带规则说明）、AuthorizationCard（签名 payload、复制 `crha grant` 命令、Passkey 签名）、QuotaCard（加额度 / 停止）。这些同时用在会话、审批页、任务页和任务组页。
- **对话框**：ConfirmDialog（危险操作二次确认）、FormDialog。
- **Markdown**：SafeMarkdown、CodeBlock（见上文）。

W2 的工作量很大，可能需要分几次派给 ds-flash。但每一次都是在同一个 worktree 里接着做，不会出现新旧界面共存的中间状态。我在每次结束时审计。

## 待定决策

方案确认后写入 README 的决策表：

- D94：WebUI 技术栈，即上表。
- D95：WebUI 改为路径路由，兼容旧的 hash 链接。
- D96：列表接口统一用 keyset 游标；会话事件流的 snapshot 只带最近一页，更早的历史分页加载。
