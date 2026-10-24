# WhatsApp from the ATS: official API and the QR-link prototype

Two ways, chosen in **Administration > Integrations > WhatsApp & SMS**: "Which one sends?".

| | Official (Meta Cloud API) | QR-link prototype |
|---|---|---|
| Rules | Allowed by WhatsApp | **Not allowed for business messaging. The number can be banned.** |
| Cost | Meta charges per conversation | Free |
| Start a chat | Only with an **approved template**. Plain text only inside 24 h after they write | Any text, no template limit |
| Number | A dedicated business number (not on the WhatsApp app) | A **spare** number you can lose |
| Delivery ticks, replies | Meta webhook | The linked session |
| Safe for bulk | Yes, within Meta limits | **No.** Never use it for mass broadcasts |
| Files | Document within the 24 h window | Document any time |

**Recommendation:** use the official API for anything important. Use the QR prototype only with a spare number, small volumes,
people who agreed to be messaged, and expect it to stop one day.

## Official API: setup

Already built. Steps (also shown in Message templates > Channels):
1. Meta Business account, verified; a Business app with the WhatsApp product.
2. A phone number not on the WhatsApp app. Choose billing currency INR.
3. A System user token (`whatsapp_business_management`, `whatsapp_business_messaging`), never expires.
4. Integrations > Connections > WhatsApp Business > Configure: Phone number ID, WhatsApp Business ID, token, App secret, a verify token.
5. Meta > WhatsApp > Configuration: callback URL `https://<your site>/api/webhooks/whatsapp` and the verify token; subscribe to `messages`.
6. Create the templates in Meta, then mark them Approved in Message templates (Admin only).
7. Press Test. Delivery ticks and replies now reach TeamLink.

The Contact dialog says "WhatsApp via company number (Official)". Outside the 24-hour window only approved templates can be sent: the dialog
shows the plain reason and the template picker. With "try the other one" on and the QR number connected, plain text is routed there instead.

## QR-link prototype: how it works

* `@whiskeysockets/baileys` (WebSocket, no browser, light on RAM: chosen over whatsapp-web.js, which needs Chrome and a lot of RAM). It is an
  **optional dependency**. Not installed: the screen says "run `npm install @whiskeysockets/baileys` in the backend folder"; nothing else breaks.
* A **separate worker process** (`backend/src/workers/whatsappQrWorker.js`) holds the WhatsApp link and sends the queue. The main server
  never starts it by itself. Start it with the **Start** button (Integrations > WhatsApp & SMS) or `npm run whatsapp-qr-worker`.
* The worker **refuses to start** unless: the switch is on, an Admin ticked "I understand" (saved in the audit log), the kill switch is off,
  `INTEGRATION_SECRET_KEY` is set (so the session is stored encrypted), and, on the real database, `TL_ALLOW_REAL_WHATSAPP_QR=1` is set.
* The login session is stored **encrypted** (AES-GCM, `utils/secrets.js`) in `~/.teamlink/whatsapp-qr-session/` (override `TL_QR_SESSION_DIR`), never in git.

### Set up (Admin)

1. `cd backend && npm install @whiskeysockets/baileys` (once).
2. Add `TL_ALLOW_REAL_WHATSAPP_QR=1` to the backend environment and restart the server (only on the real server).
3. Integrations > WhatsApp & SMS > QR card: read the warning, tick **I understand**, press **Switch it on**.
4. Press **Start**. A QR code appears (it changes every 20 s).
5. On the **spare** phone: WhatsApp > Linked devices > Link a device > scan.
6. The card says "Connected as +91 ......" (masked). Choose "QR-linked number" as the first WhatsApp provider.
7. Tick "This number is new" for the first days (limits 10 an hour, 40 a day).

### States

Disconnected, Waiting for QR scan, Connected as +91xxxx (masked), Logged out, Banned or blocked suspected, Paused (repeated failures), Stopped.
A worker that stops beating for 2 minutes is shown as **Disconnected**, never "Connected".

### Human-like pacing and limits (defaults)

* one message at a time, random 8-20 s gap, "typing..." pause;
* 30 an hour, 150 a day (new number: 10 / 40), changeable by an Admin (Limits that protect the number);
* never to people who did not agree or replied STOP (checked when planned, again when the message leaves the queue);
* a number that is not on WhatsApp fails with that reason and is not counted as a send failure.

### Safety switches

* **Circuit breaker:** 3 failures in a row pause sending and ring the Admin bell. **Resume** after the cause is fixed.
* **Logged out** (unlinked on the phone): sending stops, session wiped, bell. Start again and scan a new QR.
* **Banned or blocked suspected** (403 or repeated refusals): sending stops, bell. Do not retry with that number for some days.
* **Kill switch** (company): stops the worker and cancels everything waiting. Nothing goes out until it is turned off.

### Replies and ticks

Inbound messages go to the candidate's timeline (RECEIVED) and the Inbox, reopen the 24 h window and honour STOP. Ticks:
Queued -> Sent -> Delivered -> Read update the same message. Group messages are ignored.

## Risks (read this)

* **Ban risk is real and cannot be removed.** WhatsApp bans numbers that behave like business bots. Pacing and caps lower the chance, they do not make it safe.
* A banned number loses its chats and contacts. That is why it must be a spare.
* The library reverse-engineers WhatsApp Web; a WhatsApp update can break it for days.
* Using it may breach WhatsApp's terms of service. The company carries that decision.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Not installed: run npm install ..." | Run `npm install @whiskeysockets/baileys` in `backend`, then Start |
| Start says "not allowed to link a real WhatsApp number" | Set `TL_ALLOW_REAL_WHATSAPP_QR=1` and restart, or run the npm script yourself |
| Start says "sandbox" | You are on the test copy. The real WhatsApp network is never contacted there |
| No QR appears | Worker not running (Start), or it stopped: read the red message on the card and the worker console |
| State Disconnected after it was Connected | Worker stopped or the internet dropped. Press Start |
| Messages stay "Queued" | Worker not running, number not connected, paused, or an hourly / daily cap is reached |
| "not on WhatsApp" | The person has no WhatsApp on that number |
| Official: "outside the 24-hour window" | Choose an approved template, or use the QR number for plain text |
