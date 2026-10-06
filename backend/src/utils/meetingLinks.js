// ---------------------------------------------------------------------------
// "CREATE MEETING LINK" FOR AN INTERVIEW (B4, 2026-10-06).
//
// Uses the account saved in Administration → Integrations → Calendar Sync.
// Official APIs only:
//   GOOGLE   OAuth 2.0 refresh token → access token
//              https://developers.google.com/identity/protocols/oauth2/web-server#offline
//            Calendar API events.insert with conferenceDataVersion=1 and
//            conferenceData.createRequest (hangoutsMeet) → the Meet link
//              https://developers.google.com/calendar/api/v3/reference/events/insert
//              https://developers.google.com/calendar/api/guides/create-events#conferencing
//   MICROSOFT  client-credentials token (Entra app, Calendars.ReadWrite
//            application permission, admin consent)
//              https://learn.microsoft.com/graph/auth-v2-service
//            POST /users/{organizer}/events with isOnlineMeeting=true,
//            onlineMeetingProvider=teamsForBusiness → onlineMeeting.joinUrl
//              https://learn.microsoft.com/graph/api/user-post-events
//              https://learn.microsoft.com/graph/outlook-calendar-online-meetings
//
// HONESTY RULES (like Save & Post / eMudhra): no account → "built, needs an
// account" with the exact setup steps; nothing is ever invented. No attendees
// are added to the event, so neither Google nor Microsoft emails anyone — the
// link is shown to the recruiter, who shares it as today. The test sandbox
// blocks outbound calls, so there it always answers "could not reach".
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const CHANNEL = 'calendar';
const F = {
  provider: 'Provider (Google / Outlook)',
  clientId: 'Client ID',
  clientSecret: 'Client secret',
  calendar: 'Default calendar',
  refresh: 'Refresh token (Google)',
  tenant: 'Tenant ID (Microsoft)',
  organizer: 'Organizer email (Microsoft)',
};

const STEPS = {
  google: [
    'Google Cloud console (console.cloud.google.com) → create or pick a project → APIs & Services → Library → enable "Google Calendar API".',
    'APIs & Services → OAuth consent screen → set it up for your company Google account.',
    'APIs & Services → Credentials → Create credentials → OAuth client ID (Web application). Copy the Client ID and Client secret.',
    'Get a refresh token for the Google account whose calendar holds the interviews, with the scope https://www.googleapis.com/auth/calendar.events (for example in Google OAuth 2.0 Playground → settings → "Use your own OAuth credentials").',
    'TeamLink → Administration → Integrations → Calendar Sync → Configure: Provider = Google, Client ID, Client secret, Refresh token (Google), Default calendar = primary (or the calendar id) → Save.',
  ],
  microsoft: [
    'Microsoft Entra admin center (entra.microsoft.com) → App registrations → New registration (single tenant). Copy the Application (client) ID and the Directory (tenant) ID.',
    'API permissions → Add → Microsoft Graph → Application permissions → Calendars.ReadWrite → Grant admin consent.',
    'Certificates & secrets → New client secret → copy the secret value.',
    'TeamLink → Administration → Integrations → Calendar Sync → Configure: Provider = Outlook, Client ID, Client secret, Tenant ID (Microsoft), Organizer email (Microsoft) = the Microsoft 365 mailbox that owns the Teams meetings → Save.',
  ],
};

async function readSettings() {
  // eslint-disable-next-line global-require
  const store = require('./integrationStore');
  const cfg = await store.readConfig(CHANNEL).catch(() => ({ values: {} }));
  const v = cfg.values || {};
  const p = String(v[F.provider] || '').toLowerCase();
  // eslint-disable-next-line no-nested-ternary
  const provider = /google|meet/.test(p) ? 'google' : (/outlook|microsoft|teams|office|365/.test(p) ? 'microsoft' : null);
  return {
    provider,
    clientId: String(v[F.clientId] || '').trim(),
    clientSecret: String(v[F.clientSecret] || '').trim(),
    calendar: String(v[F.calendar] || '').trim() || 'primary',
    refresh: String(v[F.refresh] || '').trim(),
    tenant: String(v[F.tenant] || '').trim(),
    organizer: String(v[F.organizer] || '').trim(),
    missingKey: !!cfg.missingKey,
  };
}

function missingOf(s) {
  const m = [];
  if (s.missingKey) m.push('the saved secret cannot be read with this server\'s key (save it again)');
  if (!s.provider) { m.push('Provider (Google or Outlook)'); return m; }
  if (!s.clientId) m.push('Client ID');
  if (!s.clientSecret) m.push('Client secret');
  if (s.provider === 'google' && !s.refresh) m.push('Refresh token (Google)');
  if (s.provider === 'microsoft') {
    if (!s.tenant) m.push('Tenant ID (Microsoft)');
    if (!/@/.test(s.organizer)) m.push('Organizer email (Microsoft)');
  }
  return m;
}

async function setupReport() {
  const s = await readSettings();
  const missing = missingOf(s);
  const name = s.provider === 'google' ? 'Google Meet' : (s.provider === 'microsoft' ? 'Microsoft Teams' : null);
  return {
    ready: missing.length === 0,
    provider: s.provider,
    providerName: name,
    missing,
    result: missing.length
      ? `Built, needs an account — missing: ${missing.join('; ')}. Nothing was sent.`
      : `Ready (${name}). Nothing was sent; the first real call happens when someone presses "Create meeting link".`,
    steps: s.provider ? { [s.provider]: STEPS[s.provider] } : STEPS,
  };
}

async function postForm(url, form) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  const body = await r.json().catch(() => null);
  if (!r.ok || !body || !body.access_token) {
    throw Object.assign(new Error(`sign-in to the calendar account failed (${r.status}${body && body.error ? ` ${body.error}` : ''})`), { code: 'AUTH' });
  }
  return body.access_token;
}
async function postJson(url, token, json) {
  const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(json) });
  const body = await r.json().catch(() => null);
  if (!r.ok || !body) {
    const msg = body && body.error ? (body.error.message || body.error.code || body.error) : '';
    throw Object.assign(new Error(`the calendar said ${r.status}${msg ? ` — ${String(msg).slice(0, 160)}` : ''}`), { code: 'API' });
  }
  return body;
}

// Creates the real event + meeting. { ok, url, provider, eventId } | { ok:false, needsAccount, report } | { ok:false, error }
async function createMeeting({ title, description, start, minutes = 60 }) {
  const report = await setupReport();
  if (!report.ready) return { ok: false, needsAccount: true, report };
  const s = await readSettings();
  const begin = new Date(start);
  const end = new Date(begin.getTime() + minutes * 60000);
  try {
    if (s.provider === 'google') {
      const token = await postForm('https://oauth2.googleapis.com/token', {
        client_id: s.clientId, client_secret: s.clientSecret, refresh_token: s.refresh, grant_type: 'refresh_token',
      });
      const ev = await postJson(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(s.calendar)}/events?conferenceDataVersion=1&sendUpdates=none`, token, {
        summary: title,
        description,
        start: { dateTime: begin.toISOString(), timeZone: 'Asia/Kolkata' },
        end: { dateTime: end.toISOString(), timeZone: 'Asia/Kolkata' },
        conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      });
      const video = ((ev.conferenceData && ev.conferenceData.entryPoints) || []).find((e) => e.entryPointType === 'video');
      const url = ev.hangoutLink || (video && video.uri) || null;
      if (!url || !/^https:\/\//.test(url)) return { ok: false, error: 'Google made the calendar event but gave no Meet link (is Google Meet allowed for this account?).' };
      return { ok: true, url, provider: 'Google Meet', eventId: ev.id || null };
    }
    const token = await postForm(`https://login.microsoftonline.com/${encodeURIComponent(s.tenant)}/oauth2/v2.0/token`, {
      client_id: s.clientId, client_secret: s.clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials',
    });
    const ist = (d) => new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 19);
    const ev = await postJson(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(s.organizer)}/events`, token, {
      subject: title,
      body: { contentType: 'text', content: description },
      start: { dateTime: ist(begin), timeZone: 'India Standard Time' },
      end: { dateTime: ist(end), timeZone: 'India Standard Time' },
      isOnlineMeeting: true,
      onlineMeetingProvider: 'teamsForBusiness',
    });
    const url = ev.onlineMeeting && ev.onlineMeeting.joinUrl;
    if (!url || !/^https:\/\//.test(url)) return { ok: false, error: 'Microsoft made the calendar event but gave no Teams link (is Teams enabled for the organizer mailbox?).' };
    return { ok: true, url, provider: 'Microsoft Teams', eventId: ev.id || null };
  } catch (err) {
    const blocked = /blocked|fetch failed|ENOTFOUND|ECONNREFUSED/i.test(`${err.message} ${err.cause ? err.cause.message : ''}`);
    return { ok: false, error: blocked ? 'Could not reach the calendar service from this server (no internet, or the test sandbox). Nothing was made.' : `No link was made: ${err.message}.` };
  }
}

module.exports = { CHANNEL, FIELDS: F, STEPS, readSettings, setupReport, createMeeting };
