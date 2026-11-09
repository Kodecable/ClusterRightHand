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
| 图标 | `lucide-react` | 1.61.0 |
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
  components/     项目通用组件（StatusText、StatusDot、RelativeTime、CopyButton、EmptyState…）
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

### 登录人机验证

`[auth] captcha = "cap"` 时（默认），密码登录前先做一次不可见的 Cap 工作量证明：

- 提交表单后才向 `POST /api/auth/login/challenge` 申请挑战（不提前预取），挑战绑定本次提交的用户名、密码和客户端地址；tag 用 `@noble/hashes` 计算 SHA-256，不依赖只存在于安全上下文的 `crypto.subtle`，所以通过局域网 HTTP 打开也能用。
- `cap-widget` 和两个 WASM 都按需加载，是 `web/dist/assets` 里带 hash 的自有资源；`CAP_CUSTOM_WASM_URL` / `CAP_CUSTOM_HASHWX_URL` 指向它们，并设置 `CAP_DISABLE_WIDGET_REF = true`，不从 CDN 加载。
- 验证期间按钮显示“正在进行安全验证…”并保持禁用。登录返回 403 `captcha_failed`（例如挑战过期）时自动重新求解并重试一次；第二次失败在表单旁显示错误。

### 外壳

- 使用 shadcn `Sidebar`：
  - `collapsible="icon"`；收起状态存 `localStorage`；收起时显示 tooltip；
  - 窄于 768 px 时变成抽屉。
- 导航分组：
  - 工作：Sessions、Schedules、Tasks、Batch、Approvals（带待办数）
  - 集群：Nodes、Node groups、Credentials\*
  - 管理：Authorizations\*、API tokens、Audit、Models\*、Users\*（\* 仅管理员可见）
  - 同一分组里的导航项之间留一点竖直空隙。
- 底部是用户菜单：主题（跟随系统 / 浅色 / 深色）、语言、修改密码、登出。

### 主题与 token

- `<html data-theme>` 加 Tailwind `@custom-variant dark`。
- 语义 token 写成 CSS 变量，经 `@theme inline` 映射给 Tailwind。
- 沿用现有配色（蓝色强调色），状态色补齐浅底变体。
- 界面的层次只改 token：主区域是最浅的表面，导航侧边栏比它深一档，卡片和浮层在主区域之上；深色模式方向相同（侧边栏比主区域深一档）。会话列表栏属于主区域，用 `--background`，列表里的选中行用 `--accent`，做成左右留边的圆角矩形（不铺满整行），与导航栏的选中项一致；行与行之间留一点竖直空隙。
- 圆角、间距、阴影统一用 shadcn 的 token。
- `index.html` 里的内联脚本在首屏绘制前设好主题。
- 偏好存在 `localStorage`，读写都包 try/catch。

### i18n

- 用 Lingui 宏（`<Trans>`、`` t`…` ``、`<Plural>`）。消息 ID 是哈希，所以英文目录也要在启动时加载；中文目录懒加载。
- 初始语言取 `navigator.languages`：`zh*` 用 `zh-CN`，其余用 `en`。用户覆盖存 `localStorage`，同时更新 `<html lang>`。
- 用 `lingui extract` 提取，`i18n:check` 在 CI 里检查中文是否有漏翻。
- 任务状态、规则预设、模型预设、审计事件这类枚举的显示名放进翻译。界面里不单独说“预设”，一律写“规则预设”或“模型预设”（D116）。服务端错误信息和 agent 输出不翻译。

### 状态、时间与任务结果

- 状态用 `StatusText` 显示为纯文本：标签按 tone 上色（ok 绿、warn 琥珀、danger 红、info 蓝、muted 灰），没有边框、背景和圆点，字号与所在行的正文一致。表格、列表、卡片和详情页头一律用它；状态点只保留在会话侧边列表（`StatusDot`，运行 / 等待 / 未读）。
- 任务状态 `exited` 显示为“已结束”（`Finished`），tone 固定为 ok，与退出码和信号无关；退出码只在结果（Outcome）列出现。任务组沿用任务的 tone：等待和运行是 info，`finished` 是 ok，`rejected` / `interrupted` 是 danger，`cancelled` 与任务取消一致。
- 相对时间（`RelativeTime`）用于列表里显示的时间（任务、节点最近连接、计划任务的下次运行和运行历史、节点的最近任务、访问授权的添加时间等）。它继承所在行的字号和颜色，悬停的 `title` 显示带秒的绝对时间。
- 绝对时间只有一种格式：`DateTime` 用 `formatDateTimeSeconds`，即带秒的日期时间（UI 语言、浏览器时区）。审计、授权、审批、API token、凭据、SSH 凭据和用户的创建时间等安全相关列表用它；详情页里的绝对时间也用同一格式。`Intl` 不传固定 `timeZone`。
- 任务结果：非 exec 任务（file.read / write / edit / stat / list）以退出码 0 结束、且没有超时、取消或信号时，Outcome 显示“成功”（`Succeeded`）；exec 任务仍显示 `Exit code N`。信号、超时、取消和错误照旧；没有内容时显示 muted 的 en dash “–”。
- 列表正文统一用表格的 text-sm 和普通前景色；等宽值（id、命令、路径、密钥、cron）保留 `font-mono text-xs`，占位符“–”用 muted。状态列的表头统一为 Status。

### 会话界面

**侧边列表：**
- 进入 Sessions 路由后出现第二栏，用 virtua 虚拟滚动，按游标无限加载。`/sessions` 索引路由渲染新建会话的草稿页，不再有“未选择会话”的空状态：`lg` 及以上时列表和草稿并排显示；窄于 `lg` 时导航侧边栏、列表和会话放不下三栏，只显示其中一栏，`/sessions` 显示列表，草稿页（`/sessions/new`）和会话页占满主区域，两者的返回按钮都回到 `/sessions`（窄屏即列表）。
- 列的最上面是搜索框，紧接一个与搜索框同宽的“新建会话”按钮，下面直接是分组列表。“新建会话”不弹窗，只跳到草稿页 `/sessions/new`（D117，见下文“新建会话”），不调用后端。列里没有横向分隔线，只有列与会话区之间的竖线。
- 搜索框带防抖，在服务端搜索。
- 每一项只有标题，一行，超出省略；标题为空时显示 `New Session` / `新会话`（翻译串，不写进库）；不显示所有者和相对时间。由计划任务创建的会话和别人共享给你的会话，在同一行最右侧显示灰色的"计划" / "共享"徽章（共享徽章的 tooltip 写明所有者）；会话页页头的标题右侧显示同样的徽章。等待类型放在整行的 tooltip 里。行首的固定槽位按优先级只显示一个指示：`running` 是 12px 的旋转 `LoaderCircle`（muted 色，无障碍名 "Running"）；`awaiting` 是原来的琥珀色状态点；`idle` 且未读是蓝色状态点（"Unread" / "未读"）；其余为空。槽位始终保留（12px），标题因此对齐。未读只对所有者计算：根会话的 `reply_at` 晚于 `owner_read_at`（或后者为空）即为未读；共享给别人的会话永远不是未读。
- 按 `updatedAt` 分组（列表本来就按它排序）：`今天`、`昨天`、`7 天内`、`30 天内`，更早的按本地时区的月份分组（`2026-09`）。分组标题是虚拟列表里与条目交错的普通行，所以分页加载和 SSE 打补丁后重新分组即可；键盘上下键只在条目之间移动，跳过标题。
- 不再显示"共 N 个会话"。
- 支持键盘上下键和回车。
- 列表只显示调用者能看到的根会话：自己拥有的，加上共享给自己的（`scope=visible`）。共享的会话仍带灰色的“共享”徽章。
- 不再有范围切换。管理员也没有“全部”视图：管理员看到的同样是自己的加共享的会话。
- 列表变化由 SSE 推送（见后端部分）。

**消息视图：**
- 用 virtua 虚拟滚动，`shift` 处理向上插入的历史。
- 加一段锚点校正：插入历史、内容高度变化后，保持阅读位置在屏幕上不动。
- 贴底跟随的规则：
  - 用户位于底部时，跟随新内容；
  - 用户向上滚动后，立即停止跟随，并出现圆形的“跳到最新”图标按钮；按钮背景与会话主体同为 `--background`，靠边框与内容区分。
- 最终正文开始流式输出时，过程（thinking、工具调用、中间正文）就折到最终输出上方的一行 `已完成，用时 …` 里：这一行带下边框，chevron 紧跟在文字右侧，默认收起，只保留用户输入和最终输出；用时在正文输出期间每秒增长，正文结束后固定。点击展开后按原顺序显示全部过程。还没开始输出最终正文的最后一轮保持展开，含错误的一轮也不折叠。
- 用时由 entry 的 `timestamp` / `durationMs` 计算：流式期间从用户消息的 `timestamp` 算到当前时间，正文结束后用最终 assistant 的 `timestamp + durationMs` 固定；没有这些字段的旧数据不折叠。
- POC 中的 6 项行为都必须有 e2e 测试。

**会话页头：**
- 页头只保留标题（所有者可以就地编辑，子会话带面包屑）、计划 / 共享徽章和分享按钮，底部没有分割线。模型、规则、预算和发送 / 停止按钮在输入框的最后一行；上下文和总用量在输入框下方单独一行居中。页面没有别的操作（没有删除），所以没有溢出菜单。
- 页头下方最多只有一条单行提示，按优先级只显示最高的一条：连接中 / 重连中 > 失败（红色，`role=alert`）> 出错后重试 > 等待原因（审批 / 签名 / 配额，warn 色）> 已排队消息。仅在运行时没有任何提示，不再显示“处理中”。
- 等待提示显示本会话自己的状态，不显示整棵树的汇总；侧边列表才显示汇总。
- 根会话的停止按钮在树里任何会话运行时都可用：服务端停止会话时一并停止整棵子树。子会话页以它自己的状态为准。
- 等待卡片出现在根会话页上，列的是整棵树里等待处理的审批、签名和配额；等待区在单行提示下方、消息上方，与单行提示一样没有下边框，紧贴页头。

**输入框**（一个圆角矩形，正文和页脚在同一个框里，框下另有一行上下文和用量）：

- 输入框支持 `/compact [指令]`：调用 `POST /api/sessions/:id/compact` 手动压缩上下文，不作为消息发送；摘要生成后在记录中显示为压缩分隔线。输入 `/` 时在输入框上方弹出命令补全（↑↓ 选择，Tab 或 Enter 补全，已是完整命令时 Enter 执行，Esc 关闭），输入完整命令时在下方提示其作用；命令定义集中在 `web/src/features/sessions/slash-commands.ts`。
- 正文输入框没有自己的边框，外层容器负责圆角边框和 focus 环；不再使用原生的右下角拖拽扩大。
- 高度随内容自动增长，最小一行，最大为会话主体高度的一半；超过后在输入框内滚动。
- 页脚左右两端：左端依次是：
  1. **模型**，可点击的模型显示名（模型列表里的 `name`，列表里没有该模型时为 `modelId`）；tooltip 里是完整的 `provider/modelId` 和从下一轮起生效的提示。点击直接展开按 provider 分组的模型列表，不再先弹一个中间面板；选中即 `PATCH /sessions/:id { model }`（不带 `thinkingLevel`：服务端保留原档位，新模型不支持时调整到最近的可用档）。改动写进对话的 agent 配置，**从下一轮（下一次模型请求）起生效**，正在生成的那一轮仍用旧模型。
  2. **思考档位**，紧跟模型，例如 `[灯泡] high`：只列出当前模型的 `thinkingLevels`（来自 `/api/models`）；模型只有 `off` 时不显示这一项。选中即 `PATCH { model: { provider, modelId, thinkingLevel } }`，同样从下一轮起生效。
  3. **规则预设**，`[盾牌问号]Ask`、`[盾牌省略号]Auto Review`、`[盾牌感叹号]Yolo`：规则预设名加图标。点击直接展开三个规则预设的列表，不再先弹中间面板；选中即 `PATCH { rulePreset }`。只有根会话能改规则预设；子会话显示纯文本的规则摘要（`规则：N`）。规则预设改动立即写进规则集，**从下一次工具调用起生效**，并且服务端会立刻重判等待中的审批。调用者没有 `capabilities.configure` 时两项都禁用（查询参数的等待和页脚都只读）。
  4. **预算**，`[水滴] 12K`：剩余 token 加自动单位；不设上限时是 `[水滴] ∞`（tooltip 仍是 `No budget limit`，永远不说 "unlimited quota"）；为负时是 `[水滴] 0` 并用危险色。调用者可以改时点击打开配额对话框。
- 输入框下方单独一行居中，从左到右三项（统计定义见 [agent-runtime.md](agent-runtime.md#会话统计)）：
  - **生成统计**：`[仪表] 2 轮 4 步 · 45 tok/s`。轮数和步数来自 `SessionView.stats.turns` / `stats.steps`；`tok/s` 只在 `decodeMs > 0` 时显示，值为 `decodeTokens / (decodeMs / 1000)`，≥ 10 取整数、小于 10 保留一位小数。`steps = 0` 时整项不显示。tooltip 是平均首字时间（`ttftMs / ttftSteps`，如 `1.2s`；`ttftSteps = 0` 时省略）和解码速度。
  - **总用量**：`[数据库] 1.5M · 75%`（`usageTokens` 的自动单位）。`promptTokens > 0` 时追加缓存命中率 `cacheReadTokens / promptTokens`：整数百分比，非整时向下取整且不显示成 100，只有正好全部命中才是 100%；`promptTokens = 0` 时不显示。tooltip 是精确的总用量，以及 `Cache hit: 7,550 / 10,000` 形式的精确读取/输入数。
  - **上下文**：一个小圆环加百分比，例如 `◔ 42%`；tooltip 是精确的 `contextTokens / contextWindow`。百分比用模型列表里的 `contextWindow` 计算；任意一项未知时不显示。
- 右端只有一个图标按钮：发送时是向上箭头，停止时是方形。当前有运行可以停止且输入框为空时显示停止，否则显示发送；输入内容后即使还在运行也切换为发送（作为追加消息）。
- 页脚不再按宽度隐藏计数：预算始终显示，模型和规则在窄屏只用 `min-w-0 truncate` 省略，完整文本在 tooltip 里；发送 / 停止按钮永不缩小或隐藏。生成统计、用量和上下文在框下单独一行，窄屏可以换行。390 / 768 / 1440 px 三档都有 e2e 断言。
- 生成统计、两个度量与上下文的含义见 [agent-runtime.md](agent-runtime.md#配额) 和 [agent-runtime.md](agent-runtime.md#会话统计)，决策见 D101。

**子会话栏**（输入框正上方的圆角条，没有子会话时整个条不显示）：

- 与输入框等宽，无边框和阴影，距输入框约 4px；内部是一行紧凑的计数：`3 个子会话 · 1 个运行中 · 1 个等待中`，状态计数与主文本同色，没有右侧箭头；只有直接子会话，按它们**自己的**状态计数。
- 计数来自 `GET /sessions/:id/children/summary`，不需要把子会话列表的每一页都取回来。
- 点击打开浮层（窄屏为底部抽屉）：树里每个节点显示标题和状态，链接到子会话；嵌套的子会话按需展开（展开时才请求）。
- 每一层用 `/sessions/:id/children` 的游标分页，每层有自己的"加载更多"。
- 这三条事件仍然会让本页重新拉取子会话列表和计数：本会话事件流的 `snapshot`、`subagent` 工具的 `tool_execution_update` / `tool_execution_end`、以及列表推送给树根会话的 `upsert`（见 `server/src/api/session-routes.ts` 里 `GET /sessions/:id/children` 的说明）。

**流式输出：**
- 正在生成的消息单独存在一个外部 store 里，用 `useSyncExternalStore` 订阅，并按动画帧合并更新。
- 列表本身只在消息条数变化时才重渲染。

**消息渲染：**
- 助手正文和 thinking 用 SafeMarkdown 渲染。
- 用户消息按原文显示。工具参数和工具输出也按原文显示（等宽字体），但它们放在工具详情弹窗里。
- 工具调用是一行无边框的按钮：左边是状态图标，然后是一行 `工具名 · 节点 · 主体`。节点来自原始的 `targets`/`node` 输入，没有节点时省略；主体只取命令、路径、提示词或任务 id，不显示退出码、耗时等额外字段。点击这一行打开弹窗，里面是参数、实时输出、结果、任务结果和子会话链接；不再内联展开，也没有右侧箭头，弹窗里也没有 description。
- thinking 同样是无边框的可折叠行，箭头放在行首，用与工具调用相同的 chevron 图标（收起时向右，展开时向下）。收起时在标签后显示一行思考内容：流式更新时显示最新一行，结束后显示第一行；展开后隐藏这行预览。
- 上下文压缩与思考同样式：已完成的压缩显示为可折叠的"上下文已压缩"行（折叠时预览摘要首行）；压缩进行中在记录末尾显示"正在压缩上下文"，此时会话视为运行中，可停止。已完成的压缩按提交顺序显示在被压缩的对话之后，刷新前后位置一致，且不会被折叠进某一轮的过程里。
- 工具调用和 thinking 行之间只留很小的间距；工具名在未悬停时与同一行的描述文本同色。悬停提示只把文字和图标从 muted 提亮到 foreground，不加背景块。
- 审批、授权、配额等待以卡片形式插在消息中。
- 子会话可以从父会话进入，并有面包屑。
- 工具调用行不用徽标，状态只由开头的图标表示：
  - 调用还没有返回、而且还可能返回时（没有 `item.result`：preparing、running、还没有结果），扳手换成旋转的加载圈，无障碍名称和 tooltip 是 `Running`；
  - 调用不会再返回时也停下加载圈，换成扳手。两种情况：会话不是 `running` / `awaiting`（看页面自己的会话状态，`awaiting` 也算活动），或者调用对应的任务 / 任务组已经结束；
  - 返回成功时是原来的扳手；
  - 返回失败时是同样的扳手，用危险色，无障碍名称和 tooltip 是 `Failed`；任务失败时用具体原因，例如 `Exit 2`、`Timed out`、`Cancelled`、`Partly failed`。
  - 只看调用有没有返回：后台 `subagent` 调用返回后子会话还在运行，图标也是 `Done`。
  - 子会话的实时状态不再显示在工具调用行上，只显示在子会话栏和子会话浮层里。
- 停下的卡片（没有结果，但不会再有结果）：
  - 用状态详情里的 `task_id` / `task_group_id` 跟进任务或任务组：转圈期间每 5 秒普通读取一次，停下时再读一次。不用长轮询：一个会话可能同时有很多未返回的调用，每个长轮询都会占住浏览器对同一来源仅有的几个连接。只有没有结果的卡片跟进；返回了的调用不查询。
  - 任务到了终态、或任务组是 `finished` / `interrupted` / `rejected` / `cancelled` 时，按任务视图判断结果：失败用危险色，标签用具体原因，否则普通颜色、标签是 `Done`。
  - 会话变成 idle 而任务还没结束、或者连 id 都不知道时，结果未知：普通颜色，标签是 `No result`（中文“无结果”）。
  - `data-tool-status` 在停下的卡片上是 `empty`；任务失败时是 `failed`。
  - 状态详情里的 id 由服务端在第一次等待前推送，见 [agent-runtime.md](agent-runtime.md#exec-工具的语义)。
- 失败的含义：
  - 工具结果本身是错误（`isError`）；
  - 返回的调用按工具结果的 `details` 判断（D112：模型看到的内容可能是文本，不再解析它），不做实时查询；
  - 停下的调用按跟进到的 `TaskView` / `TaskGroupView` 字段判断，规则相同；
  - 单个任务（`details` 有 `task_id` 和 `state`）：`failed` / `denied` / `rejected` / `unknown` 算失败；`exited` 时非零 `exit_code`、有 `signal`、`timed_out` 或 `cancelled` 也算失败（用户取消按失败处理）；
  - 任务组（`details` 有 `task_group_id` 和 `nodes`）：部分成员失败时算失败，标签写“部分失败”；全部失败或组是 `interrupted` / `rejected` / `cancelled` 时也失败，标签写 `Failed`；
  - 失败以外的结果（`read_file` 没有 `exit_code`、`exit 0`、仍在 `running` 的任务、全部成功的组）不影响状态，也不显示 `exit N` 文本。

**新建会话（D117）：**
- `/sessions/new` 是一个空白的会话页：没有页头和标题，记录区正中只有一行较大的 `今天有什么安排？`，下方是输入框和页脚。页脚与会话页共用组件，数据来自本地草稿状态：模型（默认取上次新建会话用的模型，存在 `localStorage`，失效时取列表第一项）、思考档位、规则预设（默认 Ask）、预算（默认不限）。
- 草稿页不支持 `/compact`；没有停止按钮。
- 发送时生成一次 `requestId`（草稿存在期间不变），调用 `POST /api/sessions { requestId, model, rulePreset, budgetRemaining?, message }`；成功后用返回的会话替换路由到 `/sessions/:id`（`replace`，返回键不回到草稿），并把会话插入侧边列表。失败时留在草稿页，输入内容保留，显示错误；重试沿用同一个 `requestId`。
- 已在草稿页时再点“新建会话”不做任何事。

### 模型页

管理员可见（`Models`），分两块，模型预设在前：

- **模型预设**：会话、自动复核、标题生成三张卡片。自动复核和标题生成有模型选择（含“使用会话的模型”，自动复核另有思考档位）；三张都有系统提示词编辑框，留空表示使用默认提示词，旁边可以查看默认提示词和固定附加的协议说明（只读）。
- **提供方**：列表 + 添加 / 编辑对话框。类型选择 `Pi 内置` 或 `自定义`。
  - Pi 内置：选择 pi-ai 的提供方，填 API key 和可选的 Base URL；说明只支持 API key。
  - 自定义：Base URL、API key、额外请求头（键值行）、会话 id 字段（请求头名 / 请求体字段路径，各若干行）；模型逐个编辑（嵌套弹窗）：id、显示名、协议（Chat Completions / Responses）、上下文窗口、最大输出 token、图像理解（开关）、思考（不支持 / 标准 / 自定义：标准选格式并逐档填映射值，自定义逐档填 JSON；两者都有“显示名”列，默认是档位 id，清空即隐藏这一档，`off` 不能清空）、`compat`（JSON 编辑框，保存时按协议校验，错误标出字段路径）。

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
  - `GET /api/authorizations`（仅管理员；去掉 200 条的硬上限）
- 原来的 offset 分页删除，不保留兼容。已核对：crha 和 MCP 工具都不调用这些列表接口，WebUI 是唯一的调用方。

### 会话列表

- `GET /api/sessions?scope=mine|shared|visible|all&q=&cursor=&limit=`：
  - 按 `updated_at desc, id` 排序；
  - 只返回根会话；
  - 默认 `mine`；`visible` 是自己拥有的加共享给自己的根会话（并集），管理员也一样，是 WebUI 唯一使用的范围；
  - `all` 仅管理员可用。
- 返回轻量的 `SessionListItem`：id、title、ownerUserId、ownerName、scheduleId、shared、state、waitingLevelId、updatedAt。
  - 不再逐行查询规则集和已用 token，消除 N+1；
  - 详细信息仍走 `GET /sessions/:id`。
- 索引：
  - `(owner_user_id, parent_session_id, updated_at, id)`；
  - `scope=all` 用 `(parent_session_id, updated_at, id)`。
- 搜索：标题用 `LIKE` 子串匹配，参数做转义。SQLite 和 PG 都适用；数据量再大时再考虑 FTS 或 trigram。
  - 大小写不敏感是**按数据库实现**的：两边都对 `lower()` 后的标题和模式比较，SQLite 的 `lower()` 只折叠 ASCII 字母（`A`–`Z`），所以带重音或其他字母表的标题在 SQLite 上按原样匹配；PostgreSQL 的 `lower()` 按 Unicode 折叠。需要跨两种后端一致时，搜索词只用 ASCII 字母，或不要在标题里依赖非 ASCII 的大小写。带变音符号的字母（如 `Ä` / `ä`）、希腊字母和西里尔字母在 SQLite 上是不同的字符。
- 会话的状态、标题或消息变化时，必须更新 `updated_at`（标记已读除外，见下）。实现时核对所有写入点。
- 未读（`unread`）只对所有者计算：根会话的 `reply_at` 晚于 `owner_read_at`，或 `owner_read_at` 为空时为 true；共享给别人的会话永远为 false。`reply_at` 只在根上、在整棵树的状态从 `running` 变为 `idle` 或 `awaiting` 时写入（有新的输出）；`owner_read_at` 由标记已读写入。
- `POST /api/sessions/:id/read`（仅所有者，返回 `204`）：把 `:id` 所在树的根的 `owner_read_at` 置为当前时间，并推送该根的 upsert，让所有者的其他标签页清掉未读点；`updated_at` 不变，因此列表不会重排。`:id` 可以是树里的任意会话，打开子会话即标记整棵树已读。会话页在打开时、以及页面可见时该树从 `running` 变为 `idle` / `awaiting` 时调用它；页面不可见时推迟到下一次可见。
- `GET /api/sessions/stream?scope=`（SSE）：
  - 只推送当前用户可见的根会话的变化：`upsert`（携带 `SessionListItem`）和 `remove`；
  - `scope` 与列表相同；省略时保持原行为（管理员收到全部根会话），WebUI 用 `scope=visible`，管理员也只收到自己拥有和共享的会话；
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
  - `GET /api/authorizations`：仅管理员，返回整个组织的授权；只按 `limit` / `cursor` 分页。

**请求体上限：**
- 普通 JSON 接口的请求体最多 1 MiB，超过返回 413 和 `{ "error": "request body too large" }`；`POST /api/auth/login` 同样在解析、鉴权和限流之前拒绝。
- 任务输入接口（`POST /api/nodes/:id/tasks`、`POST /api/task-groups`）按 64 MiB 的输入上限放宽：请求体最多 `ceil(64 MiB / 3) * 4 + 64 KiB`，供 base64 后的 `contentBase64` 和 JSON 的其他字段使用。`contentBase64` 解码前的字符数不超过 `ceil(64 MiB / 3) * 4`，`stdin` 的 UTF-8 字节数不超过 64 MiB；这两项超限是 400。

**`SessionListItem`：**

```ts
{
  id: string; title: string;
  ownerUserId: string; ownerName: string;
  scheduleId: string | null;
  shared: boolean;            // 不是当前用户本人拥有，而是共享给他的
  state: "idle" | "running" | "awaiting"; // 整棵会话树的汇总：任何会话 awaiting → awaiting；否则任何 running → running；否则 idle
  waitingKind: "quota" | "approval" | "authorization" | null; // 汇总为 awaiting 时，取树里优先级最高的等待（quota > approval > authorization）
  unread: boolean;            // 仅所有者：reply_at 晚于 owner_read_at 或 owner_read_at 为空；共享查看者永远 false，子会话列表也永远 false
  updatedAt: string;
}
```

**会话详情与修改**：`GET /sessions/:id` 的 `SessionView` 带两个 token 度量、一个上下文值和本会话的生成统计（D101）：
- `budgetUsedTokens`：预算口径，只计输出，链上累计；
- `usageTokens`：统计口径，输入 + 输出，链上累计；
- `contextTokens`：本会话最近一次主 agent 模型调用的输入大小（input + cache read + cache write），第一次调用前为 null；
- `stats`：`{ turns, steps, ttftMs, ttftSteps, decodeMs, decodeTokens, promptTokens, cacheReadTokens }`。前六项只属于本会话；`promptTokens` / `cacheReadTokens` 与 `usageTokens` 一样是整棵树的，供输入框下方的缓存命中率使用（定义见 [agent-runtime.md](agent-runtime.md#会话统计)）；
- `budgetRemaining`：剩余预算（原 `quota` 字段改名，null 不限）。
`POST /sessions` 和 `PATCH /sessions/:id` 用 `budgetRemaining` 取代原来的 `quota` 字段。

**子会话列表** `GET /api/sessions/:id/children?cursor=&limit=`：
- 可见性与 `GET /api/sessions/:id` 相同，不可见时返回 404；
- 按 `updated_at desc, id desc` 排序，返回游标列表；
- `items` 是 `SessionListItem` 并带 `parentSessionId`；`state` / `waitingKind` 是子会话**自己的**状态，不是汇总；
- 列表推送不包含子会话，所以客户端在以下事件后重新拉取：
  - 本会话事件流的 `snapshot`；
  - `subagent` 工具的 `tool_execution_update` / `tool_execution_end`；
  - 列表推送中该会话树根会话的 `upsert`。

**子会话计数** `GET /api/sessions/:id/children/summary`：
- 可见性与 `GET /api/sessions/:id` 相同，不可见时 404；
- 响应 `{ "total": number, "states": { "idle": number, "running": number, "awaiting": number } }`，只统计直接子会话自己的状态；
- 给输入框上方的子会话栏用，避免为了显示计数而取回每一页。

**会话列表实时推送** `GET /api/sessions/stream`（SSE）：
- `event: upsert`，data 为 `SessionListItem`；
- `event: remove`，data 为 `{ "id": string }`，会话被删除、取消共享或归档时发送；
- `event: ping`，每 15 秒一次。
- 只推送当前用户可见的根会话；连接上带 `scope=visible` 时（WebUI 的用法）不再有管理员的全量视图。会话树里任何会话的状态变化都推送其根会话。客户端按自己当前的 `q` 过滤后，打补丁到已加载的列表；断线重连后重新拉取第一页。
- 打补丁时按服务端的排序键 `updatedAt desc, id desc` 定位，而不是一律放到最前面：`updated_at` 没变的事件（标记已读、未读/状态变化、按调用统计更新）原地替换、不移动；位置变化时插入它所属的那一页。新位置越过最后一个已加载条目且还有下一页（末页 `nextCursor` 非 null）时丢弃该条，下一页拉取时自然带入；没有下一页则追加到末页末尾。这样日期分组（今天、昨天……）不会因为一次不改 `updated_at` 的 upsert 而乱序或出现重复标题。

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
- 会话列表 10 万条：首屏严格计时（从打开页面到第一行绘制），4× 降速下约 500 ms 可以接受；滚动没有明显卡顿。
- 消息视图 2 万条消息（全部加载后）：DOM 节点数恒定；向上插入历史时阅读位置偏移 ≤ 2 px。
- 流式输出：按真实速率（每秒 300 和 1500 字符）输出 100K 字符的消息，在 4× 降速下"停止"按钮的响应 p95 < 100 ms。
- 安全：外链图片请求为零，没有可执行的 HTML，没有非白名单协议的链接。
- 无障碍：侧边栏、菜单、对话框、列表都能完全用键盘操作，并用 Playwright 脚本验证。

## 实现结果

2026-11-01 完成 W1–W3，数据来自 `web/e2e-mock/perf/`（mock 接口，延迟 50 ms，Chromium，3 次取中位数）：

| 指标 | 1× | 4× |
|---|---|---|
| 入口 JS（gzip） | 136 kB | — |
| 会话列表首屏（严格计时） | 214 ms | 488 ms |
| 2 万条消息：向上插入历史时的偏移 | 0.3 px | 0.3 px |
| 每秒 1500 字符流式输出 100K：停止按钮响应 p95 | 2.9 ms | 8.7 ms |
| 同上，生成结束那一帧 | 100 ms | 383 ms |

与设计有出入或需要知道的地方：

- **节点信任**：服务端只提供读取，页面是只读报告加 `privileged.toml` 片段编辑器，由用户复制到节点。
- **授权页**：在管理区，只对管理员可见；只能查看 payload，没有吊销操作（D103）。
- **会话等待卡片**：审批、签名、配额卡片显示在页头下方的等待区（单行提示之下、消息上方）；工具卡片里给出指向审批页的链接。
- **管理员的会话列表**：列表只显示自己拥有和共享的会话，管理员没有“全部”视图。
- **任务结果**：单节点执行、任务页、任务组页、批量都用 `/wait` 长轮询，超时 5 秒后重新发起。
- **窄屏表格**：表格保持最小列宽并横向滚动，不转成卡片。
- **已完成消息的缓存**：为了在消息重新挂载时复用渲染结果，在 JSX 之外调用并缓存 `react-markdown` 10.1.0 的 `Markdown()`。这依赖它不使用 hooks，升级大版本时要重新确认。
- **测试**：
  - `web/e2e/`：真实 crhs + crha + faux 模型；
  - `web/e2e-mock/`：mock 接口，覆盖滚动行为和 Markdown 安全；
  - `web/e2e-mock/perf/`：性能测试；
  - `web/e2e-mock/review/`：深浅主题、桌面和手机、中文下的逐页截图，用于视觉审查。
- **待办**：
  - 中文翻译需要人工校对；
  - SSH 向导的端到端测试需要 `CRH_TEST_SSH_JUMP`；
  - 只在 Chromium 上验证过。

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
  - StatusText / StatusDot：节点、任务、任务组、会话、授权、计划任务运行、API token、用户和模型提供商的状态，配色和翻译统一；StatusText 是彩色纯文本，StatusDot 只用于会话侧边列表；
  - RelativeTime / DateTime：基于 `Intl`；列表用相对时间，绝对时间统一到秒；
  - CopyButton、CodeText（等宽、可折叠的长输出）。
- **表单**：基于 react-hook-form + zod 的 Form 字段封装；以及 ModelSelect、RulePresetSelect、NodePicker（单选和多选）、TaskFormFields（exec / file.read / file.write / file.list，同时用于 RunPanel、Batch 和规则测试）。
- **任务**：TaskResult（输出、退出码、截断提示；输出只有一个流，D114，`notice` 在输出上方单独显示）、TaskSummary 行。状态 `exited` 统一显示“已结束”，非 exec 任务成功在 Outcome 里显示“成功”，exec 任务显示退出码。这些同时用在任务页、批量、审批和会话的工具卡片里。
- **决策卡片**：ApprovalCard（批准 / 拒绝，带规则说明）、AuthorizationCard（签名 payload、复制 `crha grant` 命令、Passkey 签名）、QuotaCard（加额度 / 停止）。这些同时用在会话、审批页、任务页和任务组页。
- **对话框**：ConfirmDialog（危险操作二次确认）、FormDialog，以及 DialogScrollArea（统一的可滚动正文：给焦点环留边距，并用 `scrollbar-gutter` 和右侧内边距避免滚动条压住内容）。
- **Markdown**：SafeMarkdown、CodeBlock（见上文）。

W2 的工作量很大，可能需要分几次派给 ds-flash。但每一次都是在同一个 worktree 里接着做，不会出现新旧界面共存的中间状态。我在每次结束时审计。

## 待定决策

方案确认后写入 README 的决策表：

- D94：WebUI 技术栈，即上表。
- D95：WebUI 改为路径路由，兼容旧的 hash 链接。
- D96：列表接口统一用 keyset 游标；会话事件流的 snapshot 只带最近一页，更早的历史分页加载。
