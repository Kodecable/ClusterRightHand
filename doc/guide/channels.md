# Using CRH from chat

A chat channel lets you use your sessions from a chat app: send a message, read the answer, open
delivered files and answer approvals without opening the WebUI. A session started in a chat is an
ordinary session and appears in the WebUI like any other.

The first version supports Telegram and a Satori gateway. Only private chats are used; in a group the bot
ignores messages, because it is unclear whose account a group message would run as.

## Set up a Telegram bot

1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Give the bot a name and a username. BotFather replies with a token such as
   `123456789:AA…`; treat it like a password.
3. If you want one session per topic, open the chat with the bot and enable topics in the chat's
   settings. Each topic is then its own session. Without topics the chat has one current session and
   you switch between sessions with `/sessions`.

An administrator adds the channel in **Admin → Channels**: the name and the bot token. The token is
encrypted with the master key and never shown again. The page shows whether the bot is connected, its username and the last error. Links in
chat open the WebUI, so the administrator should set its **Public URL** in **System settings**.

## Set up a Satori bot

A Satori channel reaches a platform through a gateway such as [Koishi](https://koishi.chat/) or
OneBots. The gateway holds the platform's token; crhs only dials the gateway, so it needs no public
address.

1. Run the gateway and connect the platform's bot to it. In Koishi that is an adapter such as the
   Telegram one.
2. In Koishi, set **`selfUrl`** to the same address crhs uses to reach Koishi (the origin of the gateway
   URL below). Received images and files are served from that address; without it they do not arrive.
3. Enable the Satori server plugin. Its base URL ends with a path such as `/satori`; the API lives
   under `<base>/v1/`.
4. In **Admin → Channels**, add a channel of kind **Satori** with the gateway URL, the gateway token (if
   one is set), the platform (for example `telegram`) and the bot id. The channels page lists the
   logins the gateway reported, so you can copy the bot id from there.
5. Optionally write **Link instructions**, plain text shown to users on the link page, such as the
   bot's name or how to find it.

The gateway token is encrypted with the master key and never shown again. The gateway URL, platform
and bot id are ordinary settings and are shown in the edit dialog.

## Link your account

1. Open **Settings…** in the user menu and choose the **Chat** tab.
2. Choose **Create link code**. The dialog shows a command such as `/link ABCD2345` and when the code
   expires. For a Satori channel it also shows the channel's link instructions.
3. Open a private chat with the bot, send that command, and the chat is linked to your account.

The code works once and expires after ten minutes. A linked chat acts with your authority for
everything the chat can do, including approvals that need no signature, so protect it like your
password. **Unlink** on the same tab, or `/unlink` in the chat, removes the link.

You can choose one linked account as your **default notification account**. When you are not using the
WebUI, notifications for your sessions go there. **Show progress** adds a short status while a turn
runs on a channel that has one (Telegram); tool calls and thinking are never sent as messages.

The bot's fixed messages follow your language from **Settings → General**. Before you link a chat it
uses the language the platform reports, so `/start` or `/help` is in Chinese when Telegram is.

## Commands

Text that starts with `/` is a command, even when it is the caption of a file; files attached to a
command are not sent. An unknown command gets a short hint instead of being passed to the session.

| Command | What it does |
|---|---|
| `/link <code>` | Links this private chat to your account |
| `/unlink` | Unlinks this chat |
| `/new` | Starts a draft for a new session; its first message creates the session |
| `/model [<n>]` | Lists the session's (or draft's) models, five per page; `/model 3` sets the third |
| `/think [<level>]` | Lists the model's thinking levels; `/think high` sets one by its id |
| `/rules [<preset>]` | Lists the rule presets; `/rules yolo` sets one by its id |
| `/extensions [<n>]` | Lists the session's extensions, five per page; `/extensions 3` turns the third on or off |
| `/sessions [<n>]` | Lists your recent sessions, five per page; `/sessions 3` switches to the third |
| `/stop` | Stops the running turn |
| `/quota` | Shows the session's token quota |
| `/quota add <tokens>` | Raises the quota and continues |
| `/quota stop` | Ends the turn that waits for tokens |
| `/approve <id>` | Approves a waiting request |
| `/reject <id> [reason]` | Rejects it |
| `/help` | Lists the commands |

The lists number their items across pages: page 2 starts at 6, and the text ends with the exact hint,
such as `Send /model and a number to choose, /model page 2 for the next page.` Use `/<command> <n>` to choose the
n-th item of the current list, or `/<command> page <n>` to see another page. `/think` and `/rules` take
the level or preset id, in any case. The bot replies with what it chose (the model, session, extension,
level or preset), so a list that changed since you saw it is noticed. An invalid number or unknown id
gets a short error with the hint. On Telegram the buttons do the same things.

A new session uses your defaults from **Settings → Sessions**, not the channel's: the default model
with its thinking level, then the session model preset, then the first available model, and the default
rule preset (Ask when unset). `/new` shows a draft first; `/model`, `/think` and `/rules` change it and
save the choice as your default, while `/extensions` only affects that draft. The first message you
send starts the session with the draft's settings. Switching to another session with `/sessions`
discards the draft.

## What the chat shows

- Each piece of the assistant's text arrives as its own message: the short comments between tool calls
  as well as the final answer. Telegram renders its Markdown formatting, and long text is split at
  Telegram's limit. A Satori channel receives plain text, so Markdown syntax shows literally; long text
  is split at 4,000 characters.
- A Satori channel shows no progress status while a turn runs, and sends no buttons: choices and
  approvals use the commands above. Its files arrive through the gateway's file proxy.
- When a new session starts — with the first message after `/new`, in a new topic, or because the old
  session was archived or is no longer yours — the chat announces it and links to it in the WebUI.
- Files you send must fit your library's single-file limit set by an administrator; a larger one is
  refused with a message.
- Files the assistant delivers are sent as links that open in the WebUI; opening one goes through the
  normal sign-in and access checks.
- A failed turn sends the error.
- When a session needs an approval that can be decided without a signature, Telegram shows Approve and
  Reject buttons plus the `/approve` and `/reject` commands; Satori shows the commands. An approval that
  needs a signature sends a link to its page in the WebUI, and "always allow" stays in the WebUI because
  it changes rules.
- When a session runs out of token quota, the chat shows the quota and the `/quota` commands.
- When you switch to another session, the chat first shows the last ten messages of that session: your
  messages and each turn's final answer, with a link to the WebUI for anything long.
