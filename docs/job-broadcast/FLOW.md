# Job template, post everywhere, contact lists and the WhatsApp job broadcast

Code: `backend/src/broadcast/*` (store, template, post, lists, campaign, replies, intent, access), `backend/src/routes/jobBroadcast.js` (`/api/job-broadcast`), screens in `frontend/src/components/broadcast/*`. Test: `backend/scripts/job-template-broadcast-test.js` (sandbox only).

Nothing here runs by itself. Every post and every send starts with a person's click. On a database with no started campaign no timer runs.

## The flow, end to end

```
 Add job form                       Job page                              Candidates > Contact lists
 ------------                       --------                              --------------------------
 Save as template                   "Ready template and post              Import contacts (CSV / Excel)
      |                              everywhere"                                  |
      v                                   |                                       v
 Ready template written  -------->  same text, versions  ------------>   Check: statuses per row
 (job post, WhatsApp, SMS, email)   Regenerate / Polish with AI /                |
 beside the form, editable          Use this                                       v
      |                                   |                               Save list (name, source, owner)
 Save & Post / Save Draft                 v                                       |
      |                          Post to all selected places                      v
      +---- same text goes with   Naukri / Foundit / Shine / Careers      Send a job to this list
            the job               (jobPublish queue), LinkedIn by hand,            |
                                  Indeed + Google (job feeds),              tick: "they gave permission"
                                  WhatsApp contacts (campaign), Email      (reason saved in audit)
                                  (not built: says so)                              |
                                                                                    v
                                                          Campaign: paced sends (caps, gaps, quiet hours)
                                                                                    |
                                                          Replies -> Campaign results (tiles, replies,
                                                          intent chips, Reply, Add as candidate)
```

## 1. The ready template (`broadcast/template.js`)

* Written when "Save as template" is pressed on the Add job form, and for any saved job. The text comes from the existing job post writer (`utils/jobText.js`). The label says who wrote it: "Suggested by template". "Polish with AI" only works when an AI model is connected; otherwise it says so (409). The label then reads "Suggested by AI: please read before posting".
* Five texts: long job post, WhatsApp (6 to 9 lines), SMS (at most 160 letters once the real values are in), email subject and body. Merge fields in the short texts: `{{firstName}} {{jobTitle}} {{location}} {{applyLink}}`.
* The client name is hidden ("our client") unless the job is TeamLink's own. Lines about the agreement, fees, commission or guarantee are dropped. Internal tracker notes (follow-up history, remarks) never get in. A missing fact (for example no salary) is left out of the short texts and listed as "not on the job yet". Nothing is invented.
* Edits are saved as new versions (max 30 kept, AppSetting `jobtpl.ready.<jobId>`). An edit that names the client or holds agreement or fee words is refused. "Use this" marks a version as the one in use and, if the long text was edited, saves it into the job post store (`jobposts.saved.<id>`) for Naukri, Shine, Indeed, LinkedIn and the careers page, so the publishing module posts exactly that text.
* Library: "Save to My job templates" keeps the texts for similar jobs (AppSetting `jobtpl.lib.<id>`). The WhatsApp, SMS and email texts are also created in Message templates as "Job post: <name>".
* Previews (Naukri, Indeed, Shine, WhatsApp) are plain formatting, no external call.

## 2. Post to all selected places (`broadcast/post.js`)

| Place | What happens |
|---|---|
| Naukri, Foundit, Shine, Careers page | `jobPublish/service.publish`. The publishing module keeps its queue and safety limits. A site with no saved login, or switched off, gets the by-hand task and shows "Not connected: set up in Integrations". |
| LinkedIn | By hand: the task and the text are kept. Never shown as Posted. |
| Indeed, Google Jobs, Website | The job is ticked in the job feeds. Says "In our feed": the board shows it once the feed is registered in its employer account. |
| WhatsApp contacts | Creates and starts a campaign to the chosen list. If something blocks it (no permission tick, switch off, not connected) the chip says what to do. |
| Email list | "Not available yet". |

Only TL, BDE, BDE TL, Admin and Super Admin can post a job on their own chain. Recruiter, Manager, Assistant Manager, STL: refused. HR: internal jobs only (a client job is refused). Chips are read back from `GET /jobs/:id/post-status` and refresh while something is going.

## 3. Contact lists (`broadcast/lists.js`)

* Import: CSV or Excel (.xlsx, .xls), at most 5,000 rows, a template to download. Three steps: Upload, Check, Save. The heading row is read by itself: Name, Phone / Mobile / WhatsApp, Email, Company / Hospital, City / Location, Skills, Experience, Tag, Permission. If the phone column is not found the person picks it.
* Phones: 10-digit Indian mobiles (starting 6 to 9) become +91 (E.164 digits `91...`). `+`, `00`, `0` and `91` prefixes, spaces, dashes and brackets are handled. Two numbers in one cell: the first is used. Foreign `+` numbers (8 to 15 digits) are kept.
* Row status: Valid, Invalid number, No phone number, Duplicate in file (second occurrence), Already a candidate (link to the profile; still allowed), Already in another list (still allowed), On the STOP list, No permission (when the file has a permission column saying no).
* Stored as AppSetting rows (`bc.list.<id>`, `bc.contacts.<id>`). The import is audit-logged (name, count, source tag; no phone numbers). Delete is a soft delete: the list is hidden and can be brought back for 7 days, then it is removed for good. Per-list retention (0 = keep): after that time the contacts are removed and the list record stays.
* Who: import and send: TL, BDE, BDE TL, Admin, Super Admin. View only: Manager, Assistant Manager, STL (see every list), HR (only campaigns of internal jobs). Recruiter, Accountant, client, candidate: nothing. BDE and BDE TL get masked numbers from the server and cannot download a list. A list is seen by its owner and creator and by Admin / Manager / STL.

## 4. Consent and opt-out (DPDP)

* Before the first send to a list the sender ticks "These people gave permission to be contacted about jobs (or they are existing business contacts of the company)" and writes the basis. Both are saved in the audit log with the list id. Without it the campaign cannot start (409).
* The master switch (Contact lists > Settings, Admin only, default OFF) must be ON, and the WhatsApp company switch (Integrations) too.
* STOP, UNSUBSCRIBE, "remove me", "do not contact" and similar replies write the global STOP list (`msg.optout.WhatsApp.<number>`, the same list every other WhatsApp send reads). The person is then marked "On the STOP list" in every contact list, anything still waiting for them in any campaign is skipped, and no later import or campaign sends to them. A plain "NO" is "Not interested", not an opt-out.
* Every message ends with a plain opt-out line (the ready template has "Reply YES ... or STOP to stop these messages").

## 5. The campaign (`broadcast/campaign.js`)

* "Send this job to a list": pick job and list, see the preview with a real contact, the count in one line (`Will send to 4,820 of 5,000 (180 skipped: invalid 40, STOP 25, duplicates 90, no phone 25)`), the ETA and the time choice: Send now, Send at a time, or Spread over N hours. "Send first N today" is a limit per day. "If WhatsApp does not work for a person, send an SMS" is off unless ticked.
* One message per contact per job: before each send the contact is reserved for the job (`bc.jobsent.<jobId>`), so a restart or a second campaign cannot send twice.
* The send goes through the WhatsApp + SMS module (`channels/send.js`): provider choice, its caps, the communication log. Provider rules:
  * Official Cloud API: the first message needs an approved Message template (Admin marks it Approved). The dialog shows the picker; with none the campaign cannot start.
  * QR-linked number (prototype): plain text, but a ban risk. See below.
* Pacing: one message per gap (QR: random between the module's gap min and max; Cloud: from messages per minute; "Spread" stretches the gap), per-hour cap, per-day cap, quiet hours 21:00 to 09:00 India time (nothing sent), "first N today". The campaign says why it waits ("Today's limit of 150 messages is reached. Sending continues tomorrow.").
* States per person: Waiting, With WhatsApp (accepted by the provider's queue, the QR worker sends 8 to 20 seconds apart), Sent, Delivered, Read, Failed (with the reason), Skipped (with the reason). Delivery reports move a row forward only, never back; Failed always wins.
* Pause, Resume, Cancel. Cancel marks everyone not yet messaged as Skipped (Cancelled). When WhatsApp is not connected the campaign pauses and says so, nobody is marked sent.
* The timer (every 5 seconds) only exists while a started or scheduled campaign exists. It does not start in the sandbox, and on a database with no campaign nothing runs after a reload.

### Be blunt about limits

* 5,000 contacts at 150 a day is 34 days. That is deliberate: WhatsApp restricts accounts that message many strangers.
* The QR-linked number is unofficial. WhatsApp can ban the number, and a bulk campaign to people who never wrote to you is exactly what gets numbers banned. Use a spare number, keep the caps low, prefer the official Cloud API with an approved template.
* A reply opens a 24-hour window. On the official API a free-text answer (the automatic reply, or "Reply") only works inside it.

## 6. Replies and results (`broadcast/replies.js`)

* Every inbound WhatsApp message passes `utils/messageDelivery.applyInbound`, which hands it to `broadcast/replies.handle`. The sender's number is matched to a contact a campaign messaged in the last 14 days. Anything else is ignored by this module.
* How a reply is classified (keywords, English / Telugu / Hindi, also written in English letters):

| Meaning | Examples |
|---|---|
| Interested | YES, Y, yeah, ok, okay, interested, apply, sure, haan, avunu, chesthanu, ready |
| Not interested | NO, not interested, no thanks, not now, vaddu, ledu, nahi, kadu |
| Opt-out | STOP, UNSUBSCRIBE, opt out, remove me, do not contact, band karo |
| Question | everything else |

* Campaign results: tiles (Sent, Delivered, Read, Replied, Interested, Not interested, Opted out, Failed, with counts and percent of sent), a live progress bar, the replies newest first with a meaning chip, filters with counts (status, meaning, date), a timeline, Excel and PDF downloads (audited).
* Reply: sends a plain WhatsApp text (inside the 24-hour window; refused and said so otherwise; never to someone who said STOP).
* Add as candidate (one, or "Add all interested"): creates the candidate (or uses the one already on file by phone) and an application at the first step on the job, Source = "WhatsApp campaign: <list name>". The salary is not asked at creation: the existing salary rule asks for it at the first step. The reply is copied into the new candidate's conversation, so the Inbox shows it. A person who is already a candidate gets their reply into the Inbox by the normal inbound path.
* Bell: "N new replies to <job> campaign", grouped, at most once an hour per campaign, to the campaign creator, the list owner and the job's TL and BDE.
* Automatic reply (Settings, default OFF): after an Interested reply, one automatic text with the apply link, once per person per campaign, never after STOP.

## 7. Privacy and safety

* Roles are enforced on the server. Numbers are masked for BDE and BDE TL. Phone numbers are not written into the audit log or the logs.
* Act as: starting or resuming a campaign, "Post to all" and a typed reply need the "really send?" confirmation (`utils/actAs.js` OUTBOUND list).
* Audit rows: list imported, permission confirmed, list deleted / brought back / removed, list exported, campaign created / started / scheduled / paused / resumed / cancelled / finished, contact opted out, automatic reply, results downloaded, post to all.
* No migration: AppSetting rows. If volume grows, move `bc.contacts.*` and `bc.crow.*` to tables (additive); every caller goes through `broadcast/store.js` and the functions in `lists.js` / `campaign.js`.

## 8. Hooks into other modules

* `utils/messageDelivery.js`: one line in `applyInbound` (replies) and one in `applyStatus` (delivery reports).
* `channels/send.js` (WhatsApp + SMS module): `sendWhatsApp`, `sendSms`. Caps and provider from `channels/settings.js`, `channels/index.js status('WhatsApp')`.
* `jobPublish/service.publish`, `jobPublish/access.mayPost`.
* `utils/messageTemplates.js`: the token `{{applyLink}}` is an alias of the job link.
* `routes/applications.js addApplication` for Add as candidate.
