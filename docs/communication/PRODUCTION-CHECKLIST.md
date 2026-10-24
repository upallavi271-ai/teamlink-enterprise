# Production checklist: WhatsApp and SMS from the ATS

## Always
- [ ] `INTEGRATION_SECRET_KEY` is set and backed up (without it stored passwords and the QR session cannot be read).
- [ ] `APP_BASE_URL` is the public address of the site (webhooks) and, for the Android phone on Wi-Fi, an address the phone can reach.
- [ ] Candidate emails switch is ON (Company Setup > Step timing) and "WhatsApp / SMS to candidates" is ON on Integrations > WhatsApp & SMS.
- [ ] Message templates are written and (WhatsApp) marked Approved only after Meta approved them.
- [ ] Consent: the apply form says people agree to be messaged; STOP replies are honoured.

## Official WhatsApp
- [ ] Phone number ID, Business ID, token, app secret, verify token saved; webhook subscribed to `messages`; Test is green; a delivery tick arrived.

## Paid SMS gateway
- [ ] DLT entity, sender ID and templates registered; provider account bound to the entity; delivery-report link set; Test message delivered.

## Android phone (sms.android)
- [ ] App installed, server running, phone on the same Wi-Fi (or Cloud mode), battery saving off for the app, SIM has balance.
- [ ] Test and "Send the test SMS" to your own number work; webhooks set; a Delivered tick arrived.
- [ ] Limits reviewed (3-6 s gap, 60 / hour, 200 / day). Only personal-style / transactional texts (India DLT note).

## WhatsApp QR prototype (only if you accept the ban risk)
- [ ] A **spare** number you can lose; never the main or official number.
- [ ] `npm install @whiskeysockets/baileys` done in `backend`; `TL_ALLOW_REAL_WHATSAPP_QR=1` set; server restarted.
- [ ] "I understand" ticked; limits left at the defaults; "This number is new" ticked for the first days.
- [ ] Start the worker, scan the QR, send to yourself first. Keep the Admin bell visible (paused / banned / logged out alerts).
- [ ] Know how to stop: Kill switch (company), Stop, Unlink. Know what a ban looks like: "Banned or blocked suspected".

## Not allowed / never do
- [ ] Do not point tests or probes at real numbers. Tests use the sandbox and mock providers only (`scripts/comm-automation-test.js`).
- [ ] Never put the QR session folder inside the project or git.
- [ ] Never use the QR number for mass broadcasts.

## After go-live
- [ ] Watch the Communication log for Failed rows and the Integrations cards (sent today vs limits, last problem).
- [ ] If volume grows beyond a few thousand messages a day, move the comm records to a table (ARCHITECTURE.md, Migration path).
