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
- **No limits of its own.** A channel adds no size or rate limits beyond the platform's; shared limits
  for all entry points may come later.
- **Signatures stay in the WebUI.** An approval that needs a signature is answered with a link.

## Channels

Administrators add channels on the **Channels** page.

| Field | Meaning |
|---|---|
| Name | Lowercase letters, digits and `-`, not starting with a digit; unique |
| Kind | `telegram` or `satori` |
| Enabled | A disabled channel stops polling or disconnects |
| Credentials | Telegram: the bot token. Satori: the gateway URL and its token. Encrypted with the master key and never returned |

There can be several channels, such as two Telegram bots. The page shows each channel's state, the
account it runs as (the bot's username, or the platforms the gateway reported) and the last error.
A dropped connection is retried with the same backoff as MCP extensions
([MCP connections](extensions.md#mcp-connections)).

## Accounts

A chat account is linked to exactly one CRH user; messages from accounts that are not linked are
answered once with how to link and otherwise ignored.

- **Linking.** In the WebUI's **Settings → Chat** a user creates a one-time link code (valid for 10
  minutes) and sends `/link <code>` to the bot in a private chat. The account is identified by channel,
  platform and the platform's user id. A code is single use and bound to the user who created it.
- **Unlinking** is possible from the WebUI and with `/unlink` in the chat. Disabling a CRH user stops
  all of their accounts.
- A linked account acts with the user's authority for everything a chat can do, including approvals
  that need no signature ([Approvals](#approvals)). The one-time code from a signed-in WebUI is what
  ties the two together, so the chat account should be protected like the login.
- The user's chat settings, including their **default notification channel**, **Show progress** and the
  bot language, are in `user_settings`, edited in the WebUI's settings dialog
  ([Notifications](#notifications)).
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
  commands as a Markdown list.
- **Management commands** act on the thread's session, or its draft, through the same runtime functions
  and checks as the WebUI's session PATCH: only the owner may change a session, and a rule change may
  settle waiting approvals. `/model` lists the offered models five per page, `/think` the levels the
  current model supports, `/rules` the three rule presets, and `/extensions` the extensions available to
  the session five per page. The current choice is marked `✓`; a model or extension press uses a short
  index and a digest of the list it showed, so a list that changed meanwhile is re-rendered instead of
  acting on the wrong entry. Changes are audited with the channel (`channel.settings_changed`); a
  session's rule change is also `rules.changed`, and a draft's write to the user's defaults is
  `user_settings.changed`.
- **History on switching.** A bot cannot read a chat's history, and the chat shows only what the bot
  sent there. When a thread switches to or attaches a session, the last 10 messages of that session are
  sent first: the user's messages and each turn's final answer, without intermediate text, tool calls,
  thinking or attachments. A long message is cut to about 500 characters, with a WebUI link for the rest.

## Messages

**Language.** Every fixed text the bot sends has an English and a Chinese catalogue in the server, so
the model's output is never translated. A linked user's `locale` decides; when it is unset, and for a
message from an account that is not linked yet, the platform's language decides (`zh*` → Chinese,
everything else → English). Notifications sent without an inbound message use the user's locale, else
English. The Telegram command menu is registered twice, in English and with `language_code: "zh"`.

**Inbound.** A text message is the user's message to the session. Files and photos become chat
attachments in the user's library, as in the WebUI ([Chat attachments](library.md#chat-attachments)).
Other kinds (voice, stickers) are answered with what is supported.

**Markdown.** Framework texts are rendered as rich Markdown, where one newline is a soft break: lists
of commands are Markdown lists and separate lines are separated by a blank line. Values a user, an
administrator or a model supplies, such as a session title, a model name, an extension name or a
username, are escaped so they show literally; assistant text is not escaped.

**Outbound**, to the thread a session's notifications go to ([Notifications](#notifications)):

- **Text.** Each piece of the assistant's text is sent as its own message as soon as it is complete:
  the commentary between tool calls as well as the final answer, as the WebUI shows them. On Telegram
  the text is sent as a rich message (`sendRichMessage`) with its Markdown as written, so headings,
  lists, tables and quotes render; a text over about 32,000 characters is split at a paragraph or line
  boundary, keeping code fences balanced. If Telegram rejects the rich message with a 400 (an
  unsupported construct, too many blocks), the same text is sent as plain messages of at most 4096
  characters. Telegram renders raw HTML in rich messages, so `<tg-button>` and `<tg-button-row>` tags
  in model output are broken with a zero-width space everywhere, code included (telling code from HTML
  the way Telegram parses it is fragile); otherwise a prompt-injected answer could forge buttons
  carrying our approval or session-switch callbacks. Our own buttons travel in `reply_markup`, not in
  the text.
- **Progress** (optional, per user, on by default). Tool calls and thinking are never sent as messages;
  they can only appear as a status. On Telegram the current step shows as a draft (`sendMessageDraft`),
  whose stop control stops the turn; each real message starts a new draft, and a shown draft is re-sent
  every 20 seconds while the run goes on so it does not expire. Elsewhere one status message is edited at
  most every few seconds and removed when the turn ends.
- **Delivered files** (`copy_file` to `user_interface`) are sent as WebUI download links, never as
  attachments. Opening one goes through the normal sign-in and access checks
  ([Deliveries](library.md#deliveries)).
- **A failed turn** sends the error.

## Notifications

Each session records where its latest user message came from: the WebUI, a chat thread, or nowhere for
a message a schedule submitted. Switching or attaching a session in a chat does not change it.

| The latest message came from | Text and approval requests go to |
|---|---|
| A chat thread | That thread |
| The WebUI, or nowhere | The WebUI only while the user is online there; otherwise the user's default notification channel, if they chose one |

- **Online in the WebUI** means a request from the user's WebUI in the last 10 minutes, or an open event
  stream. crhs is one process, so presence is kept in memory.
- A notification to the default channel goes to the session's thread there, creating one when needed:
  a new topic on Telegram, otherwise a message naming the session with a button to switch to it.
- Notifications follow the session owner. Users a session is shared with are not notified.

## Approvals

A waiting approval is sent where the session's notifications go, as a message describing what waits:

| Wait | In the chat |
|---|---|
| A rule approval that needs no signature (task, task group, extension call), privileged or not | Approve and Reject buttons, and `/approve <id>`, `/reject <id> [reason]` |
| An approval that needs a signature | A link to its page in the WebUI |
| Used-up quota | The quota, `/quota add <tokens>` to raise it and go on, and `/quota stop` to end the turn |

A button or command decides as the linked user through the same checks as the WebUI: only someone who
may decide that approval can. "Always allow" is not offered, because it changes rules; that stays in the
WebUI. The decision is audited with the channel. When the wait ends elsewhere, the message is edited to
say how it ended.

## Channel kinds

Both kinds implement one internal channel interface: receive messages and button presses; send, edit and
delete messages; buttons; files; and the optional capabilities drafts and topics. The core uses an
optional capability when the channel has it and falls back to sending and editing otherwise.

- **Telegram** uses grammY's API client and long polling, with Node's own `fetch`. It is confined to its
  channel module and uses no grammY middleware. The last handled update id is stored, so a restart does
  not handle an update twice. On connect it registers the `/link`, `/unlink`, `/new`, `/model`, `/think`,
  `/rules`, `/extensions`, `/sessions`, `/stop`, `/quota`, `/approve`, `/reject`, `/help` and `/start`
  menu in English and Chinese.
- **Satori** is a small client written in crhs on the protocol's two official packages without cordis:
  `@satorijs/protocol` for the API types and `@satorijs/element` for message content. The rest of the
  satori.js stack is not used, because its stable line is rarely released, fixes merged upstream stay
  unpublished, and it faces an incompatible move to cordis 4. A Koishi gateway must have its file proxy
  (`selfUrl`) configured, or inbound files arrive without an address.

## Extension points

- Group chats, with a per-group link to a CRH user or user group.
- Alerts and scheduled-run reports posted to a channel.
- Shared limits on size and rate for every entry point.
- Webhook mode for platforms that only offer webhooks.
