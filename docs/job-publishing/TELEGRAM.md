# Telegram channel posting (official Bot API, free)

TeamLink can post a short job message to your Telegram channel through your own bot. It uses only the official Bot API
(`https://api.telegram.org`). No browser, no bot-farm. **Nothing is sent until an Admin switches it ON.**

## Set up (once, about 5 minutes)
1. In Telegram open **@BotFather**, send `/newbot`, answer the questions. BotFather gives you a **token** that looks like
   `123456789:AAH...`. Keep it private. Anyone with the token can post as your bot.
2. Make your channel (or use the one you have). Open the channel, **Administrators**, **Add administrator**, pick your bot and
   leave **Post messages** ON.
3. In TeamLink open **Administration, Integrations, Job portals, Logins and switches, Telegram channel**.
   Type the channel (`@yourchannel`, or the number that starts with `-100` for a private channel) and paste the token. **Save**.
   (A team lead or client manager may save the FIRST details from the job's Distribute tab. Only an Admin can replace or delete them.)
4. Press **Test connection**. It calls `getMe`, `getChat` and `getChatMember` and tells you in plain words whether the token is good,
   the channel exists and the bot is an administrator who may post. **It posts nothing.**
5. An Admin presses **Switch ON**. Press **Send a test post to my channel** (a separate button) to see one real message.

## What gets posted
* The text is the job's Posting Kit text for Telegram (job title, place, experience, skills, salary if allowed, the apply link).
  It never names the client and never shows the fee. Limit 4096 characters (the screen warns before you go over).
* The apply link carries `?src=telegram&utm_source=telegram&utm_medium=social&utm_campaign=job-<code>`, so applicants show
  "Telegram" as their source.
* **One post per job per channel.** Posting the same job again does nothing ("Already posted"). To change the message press
  **Post update**: it edits the message that is already there (never a second message).
* **Check only (dry run)** builds the message and shows it. Nothing is sent. Works even while posting is OFF.
* When a job is closed TeamLink sends nothing, unless an Admin ticks "post a short closing note" (OFF by default). The first message
  is never deleted by TeamLink: delete it in Telegram if you want it gone.

## When something goes wrong (plain words shown on the job)
| What you see | What it means / what to do |
|---|---|
| The token was not accepted | Wrong, expired or revoked token. An Admin saves a new one. Posting stops until then. |
| The channel or page was not found | Check the channel name. |
| The bot is not allowed to post there | Make the bot an administrator with "Post messages". |
| The site asked us to slow down | Telegram sent 429 with a wait time. TeamLink tries again after that wait. |

The answer's HTTP status is kept on the queue entry and in the job's log. The token is stored encrypted
(AES-256-GCM, `INTEGRATION_SECRET_KEY`), is never shown again, never written to a log, audit row or notification.

## For developers
Base address: `TL_TELEGRAM_API_BASE` (env) or the setting `jobpublish.api.telegram.base` (tests point it at a local fake server).
While `TL_API_STRICT_LOCAL=1` the adapter refuses any non-local address. Code: `backend/src/portals/telegram/TelegramAdapter.js`.
Test: `backend/scripts/job-distribution-test.js` (fake server only).
