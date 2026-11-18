# Chat channels

A chat channel lets people use their CRH sessions from a chat app: send a message, read the answers,
open delivered files and decide approvals, without opening the WebUI. A session started in a chat is an
ordinary session; the WebUI shows it like any other.

The scope of the first version:

- **Private chats only.** In a group chat it is unclear whose identity and rules a message runs under,
  so group messages are ignored.
- **Two channel kinds.** `telegram` talks to the Telegram Bot API directly; `satori` connects to a Satori
  gateway such as Koishi or OneBots, which in turn reaches many platforms
  ([Channel kinds](#channel-kinds)).
- **Outbound connections only.** crhs polls Telegram and dials the Satori gateway; it needs no public
  webhook address.
- **No limits of its own.** A channel adds no size or rate limits beyond the platform's and the user's
  library single-file limit; shared limits for all entry points may come later.
- **Signatures stay in the WebUI.** An approval that needs a signature is answered with a link.

## Channels

Administrators add channels on the **Channels** page.

| Field | Meaning |
|---|---|
| Name | Lowercase letters, digits and `-`, not starting with a digit; unique |
| Kind | `telegram` or `satori` |
| Enabled | A disabled channel stops polling or disconnects |
| Credentials | Telegram: the bot token. Satori: the optional gateway token; its URL, platform and bot id are non-secret settings. Secrets are encrypted with the master key and never returned |
| Link instructions | Satori only: plain text shown to users before they link, such as how to reach the bot |

There can be several channels, such as two Telegram bots. The page shows each channel's state, the
account it runs as (the bot's username, or the logins the gateway reported with their online state) and the last error.
A dropped connection is retried with the same backoff as MCP extensions
([MCP connections](extensions.md#mcp-connections)). An administrator's save or delete is applied one
operation at a time, so two overlapping changes cannot leave a second adapter running.

## Accounts

A chat account is linked to exactly one CRH user; messages from accounts that are not linked are
answered once with how to link and otherwise ignored.

- **Linking.** In the WebUI's **Settings → Chat** a user creates a one-time link code (valid for 10
  minutes) and sends `/link <code>` to the bot in a private chat. The account is identified by channel,
  platform and the platform's user id. A code is single use and bound to the user who created it; a new
  code replaces the user's previous unused one, and repeated wrong codes from one chat account are
  rate-limited like wrong passwords.
- **Unlinking** is possible from the WebUI and with `/unlink` in the chat. Disabling a CRH user stops
  all of their accounts.
- A linked account acts with the user's authority for everything a chat can do, including approvals
  that need no signature ([Approvals](#approvals)). The one-time code from a signed-in WebUI is what
  ties the two together, so the chat account should be protected like the login.
- The user's chat settings, including their **default notification channel**, **Show progress** and the
  bot language, are in `user_settings`, edited in the WebUI's settings dialog
  ([Notifications](#notifications)). Each linked account also stores the platform language tag its
  latest inbound message, button press or command carried, so a pushed text can follow the account it
  is routed to when the user has no saved locale.
- Linking and unlinking are audited (`channel_account.*`); a change of the settings, including the
  default notification account, is audited as `user_settings.changed`.

## Conversations

A conversation is one thread of a private chat, mapped to one session (`channel_threads`).

- **Telegram** uses topics in private chats: each topic is one session, and the first message in a new
  topic starts a session. Without topics, the chat has one current session; `/new` starts a draft and
  `/sessions` switches between the user's active sessions, five per page.
- **Satori** has no topics; it uses the current-session commands.
- **A session created from a chat uses the user's defaults**, the same resolution as the WebUI's new
  session page: the default model (with its thinking level), then the session model preset, then the
  first offered model, and the default rule preset, else Ask. A chat or topic with no thread yet creates
  the session directly on the first message and sends the usual notice. `/sessions` can also attach an
  existing session of that user to the thread.
- **`/new` records a draft** instead of creating a session at once (`session_id` null and the `draft`
  column set), like the WebUI's new-session page. The reply shows the draft's model, thinking level and
  rule preset and points to the management commands. `/model`, `/think` and `/rules` change the draft
  and write the same choice to the user's defaults; `/extensions` changes only the draft's disabled
  extensions. The first ordinary message creates the session with the draft's settings, sends the
  notice, then submits the message. `/sessions` switching to a session discards the draft, and `/stop`
  or `/quota` on a draft reply that there is no running session.
- **Commands are strict.** Any text that starts with `/`, including a file's caption, is a command; an
  unknown one is answered with a hint instead of being sent to the session. Files attached to a command
  are not downloaded or sent.
- **A new session is announced.** `/new`, the first ordinary message in a chat or topic without a
  thread, and a thread whose session is archived or no longer the user's all send the same notice with
  the session's WebUI link. When the old session is archived or unavailable, the notice says so. It is
  sent before the user's message is submitted, so it appears before the reply.
- `/stop` stops the running turn, `/quota` shows the session's token quota, and `/help` lists the
  commands as a Markdown list. `/approve` and `/reject` take an optional id; `/help` explains that
  omitting it decides the only request waiting in the chat, and that `/reject`'s words without an id
  are the reason.
- **Management commands** act on the thread's session, or its draft, through the same runtime functions
  and checks as the WebUI's session PATCH: only the owner may change a session, and a rule change may
  settle waiting approvals. `/model` lists the offered models five per page, `/think` the levels the
  current model supports, `/rules` the three rule presets, and `/extensions` the extensions available to
  the session five per page. Items are numbered globally across pages (page 2 starts at 6), and the list
  ends with a hint such as "Send /model and a number to choose, /model page 2 for the next page." A
  level is named by the model's own display name when it defines one, otherwise its raw pi-ai id
  (`high`), and that name is never translated.
- **Settings buttons are bound to their target.** Each `/model`, `/think`, `/rules` and `/extensions`
  button carries a short digest of the session or draft it was shown for. Pressing one after `/sessions`
  switched the chat re-renders the current target's list instead of changing the other session.
- **Every choice is also a command.** `/sessions <n>` switches to the n-th session, `/model <n>` sets the
  n-th offered model, and `/extensions <n>` toggles the n-th extension, with the list re-computed when the
  command runs. `/<command> page <n>` shows another page. `/think <level>` and `/rules <preset>` take the
  level or preset id, case-insensitively. Without an argument they list the choices. The reply names what
  was chosen (model, session title, extension, level or preset), so a changed list is noticed; an invalid
  number or unknown id gets a short localized error with the hint. On Telegram the buttons remain
  shortcuts for the same operations.
- The current choice is marked `✓`; a model or extension press uses a short
  index and a digest of the list it showed, so a list that changed meanwhile is re-rendered instead of
  acting on the wrong entry. Changes are audited with the channel (`channel.settings_changed`); a
  session's rule change is also `rules.changed`, and a draft's write to the user's defaults is
  `user_settings.changed`.
- **History on switching.** A bot cannot read a chat's history, and the chat shows only what the bot
  sent there. When a thread switches to or attaches a session, the last 10 messages of that session are
  sent first: the user's messages and each turn's final answer, without intermediate text, tool calls,
  thinking or attachments. Each is sent in full with the adapter's normal length limit and splitting
  (about 32,000 characters on Telegram, 4,000 on Satori), never cut or replaced by a link. A message is
  one bold label line and then the text: the assistant's text is its Markdown as written, so headings,
  lists, tables and code render; a user's text is escaped so it shows literally, line by line with its
  line breaks kept. Satori gets its usual plain-text conversion.

## Messages

**Language.** Every fixed text the bot sends has an English and a Chinese catalogue in the server, so
the model's output is never translated. A linked user's saved `locale` decides. When it is null, an
answer to an inbound update follows that update's `language_code`, while a pushed message (an approval,
a delivery, a final answer, a turn failure) follows the `language_code` most recently reported by the
linked account it is routed to; an unlinked sender's reply follows the update too. Unknown tags fall
through to English. The one registry is `packages/api/src/locales.ts`: it lists the supported locales
with the BCP 47 tags they accept and implements RFC 4647 lookup, so `zh`, `zh-CN`, `zh-Hans`, `zh-SG`
and also `zh-Hant`/`zh-TW`/`zh-HK` resolve to zh-CN (there is no Traditional Chinese catalogue yet),
`en-US` and `en-GB` resolve to en, and an unknown language returns null. The WebUI uses the same
registry for its first-paint language. The Telegram command menu is registered twice, in English and
with `language_code: "zh"`.

**Inbound.** A text message is the user's message to the session. Files and photos become chat
attachments in the user's library, as in the WebUI ([Chat attachments](library.md#chat-attachments)).
An inbound file is limited to at least the user's library single-file limit (`libraries.max_file_bytes`):
a larger one is refused before or while it is downloaded. Other kinds (voice, stickers) are answered with
what is supported.

**Markdown.** Framework texts are rendered as rich Markdown, where one newline is a soft break: lists
of commands are Markdown lists and separate lines are separated by a blank line. Values a user, an
administrator or a model supplies, such as a session title, a model name, an extension name or a
username, are escaped so they show literally; assistant text is not escaped. Telegram's rich Markdown
also parses `$formula$`, `==mark==`, `||spoiler||`, `^`, footnotes, lists, tables, horizontal rules and
raw HTML. Measured against `sendRichMessage` on 2026-11-17, a backslash escapes exactly
`` ! # $ ( ) * + - . = > [ \ ] _ ` { | } ~ ``; before `" % & ' , / : ; < ? @ ^` it is shown literally,
so `escapeMarkdown` leaves those characters as written; `&` and `<` become `&amp;` and `&lt;`, since
they would otherwise be parsed as an entity or HTML. A value with `&` or `<` therefore shows literally
without a backslash, while `@name` and `/command` stay a mention and a command as in a plain message.
Inline code wraps commands, paths and extension/tool names in a fence longer than the longest backtick
run inside it, padding a value that starts or ends with a backtick; entities are not decoded inside a
code span, so `<` and `&` are literal there. Satori (and Telegram's plain fallback) turn an inline code
span into its plain content, remove a backslash only before the characters the rich parser consumes it
before, and decode `&amp;`/`&lt;`; a backslash before any other character stays as written. Cards are the
exception: they are rendered natively for their surface, Markdown for Telegram and plain text for
Satori, and are never converted from one to the other.

**Outbound**, to the thread a session's notifications go to ([Notifications](#notifications)):

- **Text.** Each piece of the assistant's text is sent as its own message as soon as it is complete:
  the commentary between tool calls as well as the final answer, as the WebUI shows them. On Telegram
  the text is sent as a rich message (`sendRichMessage`) with its Markdown as written, so headings,
  lists, tables and quotes render; a text over about 32,000 characters is split at a paragraph or line
  boundary, keeping code fences balanced. If Telegram rejects the rich message with a 400 (an
  unsupported construct, too many blocks), the same text is sent as plain messages of at most 4096
  characters. On Satori the text is sent as plain text, XML-escaped with the element package's escape,
  and split at 4,000 characters; Markdown is not converted, so its syntax shows literally. Telegram
  renders raw HTML in rich messages, so `<tg-button>` and `<tg-button-row>` tags
  in model output are broken with a zero-width space everywhere, code included (telling code from HTML
  the way Telegram parses it is fragile); otherwise a prompt-injected answer could forge buttons
  carrying our approval or session-switch callbacks. Our own buttons travel in `reply_markup`, not in
  the text.
- **Progress** (optional, per user, on by default where the kind has it). Tool calls and thinking are never
  sent as messages; they can only appear as a status. On Telegram the current step shows as a draft
  (`sendMessageDraft`), and each real message starts a new draft. A shown draft is re-sent every 20 seconds
  while the run goes on so it does not expire. While the run waits **for the user** — an approval or a
  signature — no draft is kept: the wait's request message clears it, and neither the keep-alive nor a
  re-send follows, so it expires on its own; when the wait ends and the run goes on, the next progress
  update starts a new draft with a new id. A request Auto Review is still judging is not a
  wait, so it counts as running and drafting continues ([Reviewing](access-control.md#auto-review)).
  Elsewhere one status message is edited at most every few seconds and removed when the turn ends. A kind
  without the `progress` capability shows none, and one without `buttons` sends none: its approval texts
  already carry `/approve <id>`/`/reject <id>`, and a notification without a thread appends the session
  link where Telegram would show an **Open session** button.
- **The draft's stop control is bound to that draft.** Telegram keeps stopped drafts around for hours, so
  the stop update carries the draft id it belongs to. The manager stops the turn only when that id is the
  session's current live draft, the session is running and drafting is active; a stale or unknown id is
  ignored with a log line instead of aborting a turn that moved on. A real stop answers with the same
  `Stopped.` message as `/stop` and is audited as `session.stop` with source `channel_draft_stop`.
- **Delivered files** (`copy_file` to `user_interface`) are sent as WebUI download links, never as
  attachments. Opening one goes through the normal sign-in and access checks
  ([Deliveries](library.md#deliveries)).
- **A failed turn** sends a "The run failed" line and then the error as its own language-less code
  block, with a fence longer than any backtick run inside the error. The other messages that embed a raw
  problem (`couldNotSaveFile`, `couldNotSendMessage`, `couldNotStartSession`, `couldNotStop`,
  `couldNotReadHistory`, `couldNotChange` and a scheduled run's `reportError`) use the same form; the
  plain-text surfaces show the error text without the fence markers.

## Notifications

Each session records where its latest user message came from: the WebUI, a chat thread, or nowhere for
a message a schedule submitted. Switching or attaching a session in a chat does not change it.

| The latest message came from | Text and approval requests go to |
|---|---|
| A chat thread | That thread |
| The WebUI | The WebUI only while the user is online there; otherwise the user's default notification channel, if they chose one |
| Nowhere (a scheduled run) | Requests only (approvals, signatures, used-up quota), by the same rule; its assistant text, delivered-file links and turn errors are not pushed anywhere |

A scheduled run also has its own report, sent to the account its owner chose on the schedule
([Reports](scheduling.md#reports)); that is not a text push and is not routed by this table.

- **Online in the WebUI** means a request from the user's WebUI in the last 10 minutes, or an open event
  stream. crhs is one process, so presence is kept in memory.
- A notification to the default channel goes to the session's thread there, creating one when needed:
  a new topic on Telegram, otherwise a message naming the session with a button to switch to it.
- **A chat thread counts as the session's source only while the account linked for that chat belongs to
  the session owner.** A session whose chat was unlinked and linked to another user is treated as last
  used from the WebUI. A shared user's message also records the WebUI as the source, so notifications
  keep following the owner.
- Notifications follow the session owner. Users a session is shared with are not notified.
- A session's event watch is released when no chat thread points at it and it has no run or draft state.

## Approvals

Every display surface renders one compact, locale-free `ApprovalRequest` built by the server
(`server/src/approvals/request.ts`): its kind and id, the phase (`reviewing` while Auto Review decides,
`awaiting_signature` while a task or task group waits for the user's signature, otherwise
`awaiting_user`), the source (a subagent's request resolves to its root session; an API token or a user
acting directly is named as itself, and a task or schedule resolves to the user it acted for), a
structured action (exec command, file operation and path with an optional line range, API request, or
extension tool), the node names that need approval (at most 10 with a `moreNodes` count), whether it is
privileged, the settled Auto Review risk and reason when one exists, and the "always allow" rule
candidates the server can build.
Telegram, Satori and the WebUI render this model; details beyond it belong on the task, task group and
external call pages. The approvals API returns one per waiting item beside the kind-specific view,
including tasks and task groups waiting for a signature; task, task group and external-call detail
responses carry the item's `request`.

Every card is one structured record rendered natively for its surface: Telegram takes Markdown (bold
title, escaped values, the detail as one inline code span, hard line breaks), Satori plain text. Its
lines are, in order:

- the title with ` · privileged` when the request is privileged: `Approval needed`, `Signature needed`
  or `Token quota used up`, localized;
- the meta line: `Nodes: app-1, db-1` with `and N more` for a capped list, or the quota's session
  title; and, only when a default notification account routed the card rather than a chat thread,
  ` · Source: Session …`, ` · Source: API token …` or ` · Source: User …`;
- `🟡 Medium risk · …` (🟢 low, 🔴 high) only when Auto Review settled a review;
- the action detail: the command, `Read file /etc/hosts (lines 2-4)`, `GET /api/nodes`, or
  `github/create_issue`;
- a blank line, then the command hints: with buttons only `Reject with a reason: /reject <id> reason`;
  without buttons `/approve <id>` and `/reject <id> [reason]`.

A signature card carries the same body and the hints for the ways the owner can authorize it: `Sign
in the WebUI: <link>`, the `sudo crha approve --for 30m` command for a local window, and the reject
control — a Reject button with `Reject with a reason: /reject <id> reason` where the platform takes
buttons, otherwise `/reject <id> [reason]`. It offers no approve: `/approve` never decides a signature
wait. A quota card's meta is the session title (or the localized new-session name), its
detail used first (`Used N · N left`, or `Used up, over by N` when exhausted, with full separators and
never a negative remaining), and its hints `Continue: /quota add <tokens>` and `End this turn:
/quota stop`; it is never wrapped in the session title again.

A waiting approval is sent where the session's notifications go. A request Auto Review is still
reviewing is not sent: the card appears only when the review escalates it to the user, and not when the
review approves it (the operation simply runs). A signature wait gets its card once its options are
written (doc/design/privilege.md "Waiting for signatures"); when a sync pass changes them, the card is
edited. A rule approval of the same task is settled first: its card ends with the decision, and the
signature card follows as a new message. A partly dispatched task group keeps the group state
`running`, but it still has a signature wait: its card stays while any member is in
`awaiting_authorization`.

| Wait | In the chat |
|---|---|
| A rule approval that needs no signature (task, task group, extension call), privileged or not | Approve and Reject buttons, and `/approve <id>`, `/reject <id> [reason]` |
| An approval that needs a signature | A **Signature needed** card, a link to its page in the WebUI, its local-window command when planned, a "signed, sent when the node is back" line when the owner already signed for an absent node, and a Reject button (or `/reject <id> [reason]`) |
| Used-up quota | A **Token quota used up** card, `/quota add <tokens>` to raise it and go on, and `/quota stop` to end the turn |

A request without a session — an API token's task, a user's direct task, an extension call made outside
a session — goes to the same place as a session with no chat source: nowhere while its owner is online in
the WebUI, otherwise the owner's default notification account. These messages are tracked by `kind:id`
with a nullable root and settle through the same approval-change hooks (the runtime's approval listener,
the external-call wait listener, and a periodic fallback sweep) as session messages.

A button or command decides as the linked user through the same checks as the WebUI: only someone who
may decide that approval can. "Always allow" is not offered, because it changes rules; that stays in the
WebUI (the request still carries the candidates). The decision is audited with the channel. After any
decision, cancellation or rule re-evaluation, crhs first deletes the tracked message. When the platform
refuses deletion, it edits the card replacing only its hints with the result line: `✅ Approved · by
<user>`, `❌ Rejected · by <user>: <reason>`, or `Expired` for a wait that ended otherwise (task gone,
cancelled, rule re-evaluation, session stopped, quota wait over). Auto Review's approval reads `✅
Approved · by Auto Review`. A signature card ends with how the signature wait ended, read from its
tasks rather than from the earlier approval: `❌ Rejected · by <owner>: <reason>` when the owner
rejected it (in the WebUI or the chat; `authorization_declined`), `✅ Authorized` once a task was sent
to its node, `Expired` when the wait ran out, and `❌ Not authorized: <reason>` when nothing could
authorize it, crha's own refusals included. A group's card reads only the members that waited while
the card was up, so a member that ran before the wait does not decide it. When editing fails too, the result line is sent as a new message, so the
chat never keeps a stale card. The `/approve` and `/reject` command reply uses the same line.

`/approve` and `/reject` may omit the id: when exactly one approval or signature wait is waiting for
the user in this chat (a card tracked for the chat target), that request is decided. For `/reject`, an
argument that is not a waiting request id is the reason, so `/reject not now` rejects the only waiting
request with reason "not now". `/approve` only ever decides a rule approval: given a signature wait it
answers like an unknown id. `/reject` rejects either kind through the same server function as the
WebUI's reject routes (the task's or the task group's `authorization/reject`), so a signature wait ends
`rejected` with `authorization_declined` exactly as it does from the WebUI. With none or several
waiting, the bot replies with the localized usage, and `/help` explains both forms. A kind without the
`buttons` capability sends no buttons: the command hints are the way to decide, and a notification
outside a thread carries the session link (a signature card carries its own WebUI link instead).

## Channel kinds

Both kinds implement one internal channel interface: receive messages and button presses; send, edit and
delete messages; buttons; files; and the optional capabilities drafts, topics, buttons, progress and
markdown. The core uses an optional capability when the channel has it and falls back to text otherwise;
a card is rendered as Markdown for a `markdown` kind and as plain text for the others.

- **Telegram** uses grammY's API client and long polling, with Node's own `fetch`. It is confined to its
  channel module and uses no grammY middleware. The last handled update id is stored, so a restart does
  not handle an update twice; submitting the bot token resets it, because update ids belong to one bot.
  On connect it registers the `/link`, `/unlink`, `/new`, `/model`, `/think`, `/rules`, `/extensions`,
  `/sessions`, `/stop`, `/quota`, `/approve`, `/reject`, `/help` and `/start` menu in English and Chinese.
- **Satori** is a small client written in crhs on the protocol's two official packages without cordis:
  `@satorijs/protocol` for the API types and `@satorijs/element` for message content. The rest of the
  satori.js stack is not used, because its stable line is rarely released, fixes merged upstream stay
  unpublished, and it faces an incompatible move to cordis 4 ([Satori](#satori)).

## Satori

A Satori channel is one bot behind a gateway such as Koishi or OneBots: the gateway reaches the actual
platform (Telegram, Discord, …) and crhs dials the gateway, so no public webhook is needed. The
administrator configures the gateway base URL (its API is under `<base>/v1/...`), an optional token, the
platform (for example `telegram`) and the login's bot id, plus plain-text link instructions shown to
users. One channel runs one bot; another bot is another channel. The token is encrypted like a Telegram
bot token and never returned.

The protocol is used directly:

- **Events.** A WebSocket to `<base>/v1/events` (http → ws, https → wss). On open crhs sends IDENTIFY
  (`{op: 3, body: {token, sn}}`) with the last handled `sn`, persisted in the channel cursor after each
  event like Telegram's update id. A change of the gateway URL, platform or bot id, or a submitted token,
  resets it, because `sn` belongs to one gateway. READY (`op: 4`) lists the gateway's logins; the
  configured platform and bot id must be there and ONLINE, otherwise the channel becomes unavailable with
  that error and is retried with the usual backoff. The login's name is the channel's account. META
  (`op: 5`) updates the proxy roots. A PING is sent every 10 seconds; without any frame for about 30 seconds the connection is
  presumed dead and re-established. A gateway resumes only with events after the sent `sn`, so a lower
  or equal `sn` means its counter restarted (Koishi keeps it in memory): the event is handled and the
  cursor follows it. For the same reason submissions are deduplicated by the platform message id, not
  the `sn`.
- **Inbound.** Only `message-created` events whose login, platform and self id match the configured bot
  and whose `channel.type` is DIRECT (1) are handled; guild messages, other events and other logins are
  dropped before any file is touched. `message.content` is parsed with `@satorijs/element`: text
  elements become text (`<br>`/`<p>` newlines, `<at>` a mention), and `img`, `audio`, `video` and `file`
  elements become inbound files.
- **Outbound.** `POST <base>/v1/<resource>.<method>` with the JSON body and the gateway's headers:
  `Authorization: Bearer <token>` when set, `Satori-Platform`/`Satori-User-ID` and
  `X-Platform`/`X-Self-ID`. Text is sent with `message.create` as plain, XML-escaped text (newlines
  kept) and split above 4,000 characters; a card already rendered as plain text is sent without the
  Markdown conversion. `message.update` and `message.delete` report a failure, so the manager can edit
  a decided card or send the result as a new message.
- **Files.** A message must not make crhs fetch an arbitrary address. A `data:` URL is decoded in place; an
  http(s) `src` on the gateway's own origin is fetched directly, because Koishi's Telegram adapter serves
  files from `<selfUrl>/telegram/...` without listing them as proxy roots; any other `src` goes through
  the gateway proxy, `GET <base>/v1/proxy/<src>`, which checks it against its proxy roots. The same
  attachment limits apply as for Telegram.
- **No buttons, topics, drafts or progress.** Approvals travel as `/approve <id>` and `/reject <id>` in
  the text; a notification without a thread appends the session's WebUI link instead of an **Open
  session** button. The management command arguments described under [Conversations](#conversations)
  are the only way to choose.

## Extension points

- Group chats, with a per-group link to a CRH user or user group.
- Alerts and scheduled-run reports posted to a group or channel (admin-registered outbound-only targets).
- Shared limits on size and rate for every entry point.
- Webhook mode for platforms that only offer webhooks.

## Not yet

- Markdown → Satori elements: Satori receives plain text, so framework Markdown shows as written
  (inline code content is unwrapped); cards are rendered as plain text rather than converted.
- Progress for Satori: the manager shows none while a turn runs.
- Buttons for Satori: there are none; approvals and lists use commands.
