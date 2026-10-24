# Interview: Google Meet link, e-mail on schedule, Start interview

Added 2026-10-14. No database migration: the settings and the e-mail results live in the existing `AppSetting` table, the Meet link in the existing `Application.interviewMeetingLink` column.

## What the user sees

1. **Book interview** (Interview Calendar, the existing dialog; only BDE / BDE TL / Admin / HR-internal can book, unchanged).
   - Mode **Online (Google Meet)** shows the Meet link field: **Create a Meet link** (opens https://meet.google.com/new in a new tab), a box **Paste the link here**, and **Use our standing Meet link** when an Admin saved one.
   - A Google Meet link (`https://meet.google.com/abc-defg-hij`) is accepted. Any other `https://` meeting link is accepted with a warning. Anything else is refused in plain words.
2. **E-mail with a calendar invite** goes when an interview is booked, moved or cancelled:
   - the candidate (date, time in IST, mode, Join Meet link, "reply to this e-mail"; the client is called "our client", never named; no salary or fee);
   - the interviewer(s) / panel (job and company, the Meet link);
   - optionally a copy to the booker, the job's team lead and the client manager (BDE).
   - The invite is a `.ics` file (`METHOD:REQUEST`, or `METHOD:CANCEL`). Its UID is stable per interview round and SEQUENCE grows with every change, so Google Calendar / Outlook update the same entry.
   - The interview card shows per person **Email sent** or **Email not sent: <reason>** (address masked) with a **Resend** button (booking team only).
   - A mail problem never blocks the booking. If mail is not set up the booking result says so and points to Administration > Integrations > Email.
3. **Start interview** (blue button on the interview row, detail panel and card):
   - shown to the interviewer (panel member or named), the booker, the BDE team, the job's team lead and Admin; a recruiter who is not the named interviewer gets no button;
   - enabled from 15 minutes before to 2 hours after the start (Admin can always start); outside that the button is disabled with the reason "Opens 15 minutes before the interview";
   - opens the Meet link in a new tab (`noopener`), sets the status to **Started**, writes the history line "Interview started by <name> at <time> IST" and an audit row;
   - no Meet link yet: the button says **Add the Meet link first** and opens a small paste dialog (the updated invite is e-mailed);
   - in-person interviews: Start just marks it started and shows the address.

## Admin settings (Interview Calendar, "Interview e-mails and Meet" line, Admin only)

| Setting | Default |
| --- | --- |
| Email the candidate when an interview is booked | ON |
| Email the interviewer | ON |
| Email on reschedule or cancel | ON |
| Copy to booker / TL / BDE | OFF |
| Standing Meet link | empty |
| Make the Meet link automatically (Google Calendar auto-link) | OFF |
| Start window | 15 min before, 120 min after |

## Optional: Google Calendar auto-link (needs a Google account setup)

Google Meet links cannot be created without the Google Calendar API, so the default route is "Create a Meet link" + paste. To let TeamLink make the link by itself:

1. Google Cloud console > create or pick a project > APIs & Services > Library > enable **Google Calendar API**.
2. APIs & Services > OAuth consent screen > set it up for your company Google account.
3. APIs & Services > Credentials > Create credentials > OAuth client ID (Web application). Copy the Client ID and Client secret.
4. Get a refresh token for the Google account that owns the interviews' calendar (scope `https://www.googleapis.com/auth/calendar.events`, for example in Google OAuth 2.0 Playground > settings > use your own OAuth credentials).
5. TeamLink > Administration > Integrations > Calendar Sync > Configure: Provider = Google, Client ID, Client secret, Refresh token (Google), Default calendar = `primary` > Save. (Secrets are stored encrypted by the existing integration mechanism.)
6. Interview Calendar > "Interview e-mails and Meet" > tick **Make the Meet link automatically**.

Until step 5 is done the switch calls nothing; the booking says "Google Calendar auto-link is on but not connected" and the Meet link can still be pasted. Same adapter as the older "Create meeting link" button in the interview detail (`backend/src/utils/meetingLinks.js`).

## E-mail setup

Interview e-mails use the existing mailer (Administration > Integrations > Email, SMTP). Test addresses (`*.test`, `example.com`) are never handed to the provider. In the test sandbox the transport is fake.

## Files

- `backend/src/utils/interviewMeet.js` (settings, link check, e-mail text, .ics, send + record, Start rules)
- `backend/src/routes/interviewMeet.js` (settings, e-mail status / resend, paste link, start)
- hooks: `routes/interviewsJoining.js` (book), `routes/atsExtras.js` (reschedule, cancel, did-not-attend + new time, calendar rows carry `start`), `index.js` (mount)
- `frontend/src/components/interviews/MeetStart.jsx` + `meetStart.css`, `ScheduleInterview.jsx`, `pages/ats/InterviewCalendar.jsx`
- test: `backend/scripts/interview-email-meet-test.js` (`TL_API=http://localhost:4011`)
