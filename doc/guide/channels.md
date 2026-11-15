# Using CRH from chat

A chat channel lets you use your sessions from a chat app: send a message, read the answer, open
delivered files and answer approvals without opening the WebUI. A session started in a chat is an
ordinary session and appears in the WebUI like any other.

The first version supports Telegram. Only private chats are used; in a group the bot ignores messages,
because it is unclear whose account a group message would run as.

## Set up the bot

1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Give the bot a name and a username. BotFather replies with a token such as
   `123456789:AA…`; treat it like a password.
3. If you want one session per topic, open the chat with the bot and enable topics in the chat's
   settings. Each topic is then its own session. Without topics the chat has one current session and
   you switch between sessions with `/sessions`.

An administrator adds the channel in **Admin → Channels**: the name and the bot token. The token is
encrypted with the master key and never shown again. The page shows whether the bot is connected, its username and the last error. Links in
chat open the WebUI, so the administrator should set its **Public URL** in **System settings**.

## Link your account

1. Open **Settings…** in the user menu and choose the **Chat** tab.
2. Choose **Create link code**. The dialog shows a command such as `/link ABCD2345` and when the code
   expires.
3. Open a private chat with the bot, send that command, and the chat is linked to your account.

The code works once and expires after ten minutes. A linked chat acts with your authority for
everything the chat can do, including approvals that need no signature, so protect it like your
password. **Unlink** on the same tab, or `/unlink` in the chat, removes the link.

You can choose one linked account as your **default notification account**. When you are not using the
WebUI, notifications for your sessions go there. **Show progress** adds a short status while a turn
runs; tool calls and thinking are never sent as messages.

The bot's fixed messages follow your language from **Settings → General**. Before you link a chat it
uses the language of your Telegram client, so `/start` or `/help` is in Chinese when Telegram is.

## Commands

Text that starts with `/` is a command, even when it is the caption of a file; files attached to a
command are not sent. An unknown command gets a short hint instead of being passed to the session.

| Command | What it does |
|---|---|
| `/link <code>` | Links this private chat to your account |
| `/unlink` | Unlinks this chat |
| `/new` | Starts a draft for a new session; its first message creates the session |
| `/model` | Chooses the session's (or draft's) model, five per page |
| `/think` | Chooses its thinking level |
| `/rules` | Chooses its rule preset |
| `/extensions` | Turns the session's extensions on or off, five per page |
| `/sessions` | Lists your recent sessions, five per page, with buttons to switch to one |
| `/stop` | Stops the running turn |
| `/quota` | Shows the session's token quota |
| `/quota add <tokens>` | Raises the quota and continues |
| `/quota stop` | Ends the turn that waits for tokens |
| `/approve <id>` | Approves a waiting request |
| `/reject <id> [reason]` | Rejects it |
| `/help` | Lists the commands |

A new session uses your defaults from **Settings → Sessions**, not the channel's: the default model
with its thinking level, then the session model preset, then the first available model, and the default
rule preset (Ask when unset). `/new` shows a draft first; `/model`, `/think` and `/rules` change it and
save the choice as your default, while `/extensions` only affects that draft. The first message you
send starts the session with the draft's settings. Switching to another session with `/sessions`
discards the draft.

## What the chat shows

- Each piece of the assistant's text arrives as its own message: the short comments between tool calls
  as well as the final answer. Telegram renders its Markdown formatting, and long text is split at
  Telegram's limit.
- When a new session starts — with the first message after `/new`, in a new topic, or because the old
  session was archived or is no longer yours — the chat announces it and links to it in the WebUI.
- Files the assistant delivers are sent as links that open in the WebUI; opening one goes through the
  normal sign-in and access checks.
- A failed turn sends the error.
- When a session needs an approval that can be decided without a signature, the chat shows Approve and
  Reject buttons plus the `/approve` and `/reject` commands. An approval that needs a signature sends a
  link to its page in the WebUI, and "always allow" stays in the WebUI because it changes rules.
- When a session runs out of token quota, the chat shows the quota and the `/quota` commands.
- When you switch to another session, the chat first shows the last ten messages of that session: your
  messages and each turn's final answer, with a link to the WebUI for anything long.
