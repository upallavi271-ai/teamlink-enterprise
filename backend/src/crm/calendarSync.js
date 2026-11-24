// ---------------------------------------------------------------------------
// CRM > FOLLOW-UPS > CALENDAR: TWO-WAY GOOGLE / MICROSOFT SYNC (wave E, 2026-11-24; gap 05.04).
//
// Each salesperson joins THEIR OWN calendar (OAuth 2.0, the provider's own sign-in page; TeamLink never sees the password):
//   GOOGLE     accounts.google.com consent, scope calendar.events (+ openid email), offline access (refresh token)
//              https://developers.google.com/identity/protocols/oauth2/web-server  ·  Calendar API v3 events list / insert / patch / delete
//   MICROSOFT  login.microsoftonline.com consent, scopes offline_access Calendars.ReadWrite User.Read
//              https://learn.microsoft.com/graph/auth-v2-user  ·  Graph /me/calendarView, /me/events
// Then, every 10 minutes (and on "Sync now"):
//   CRM -> calendar   their open follow-ups from yesterday to 60 days ahead become events (a time = that slot, no time = all day);
//                     a follow-up moved / renamed in the CRM moves the event; a done / cancelled one is taken off the calendar.
//   calendar -> CRM   an event TeamLink made that was moved in the calendar moves the follow-up (and says so on the timeline);
//                     their other events are read as "busy" blocks for the CRM calendar, joined to a lead / contact when an attendee's
//                     email is one of ours.
// No attendee is ever added and the provider is told not to send invites, so nobody outside gets a mail from this.
//
// SWITCHES AND KEYS: OFF until an Admin turns on "Calendar sync" (CRM settings > Calendar, video and AI switches). The OAuth app (client ID
// / secret) is typed in Administration > Integrations > "CRM calendar sync" (falls back to the Calendar Sync card's Client ID / secret
// for the same provider). The redirect address to register with Google / Microsoft is shown on that screen. Tokens are stored encrypted
// (utils/secrets.js, INTEGRATION_SECRET_KEY) and never leave the server. Provider addresses can be pointed at a stand-in for tests
// (CRM_GOOGLE_AUTH_URL, CRM_GOOGLE_TOKEN_URL, CRM_GOOGLE_API, CRM_MS_LOGIN, CRM_MS_GRAPH).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const P = require('./plusE');
const S = require('./service');
const DB = require('./schema');

const CHANNEL = 'crm-calendar';
const F = { gId: 'Google Client ID', gSecret: 'Google Client secret', mId: 'Microsoft Client ID', mSecret: 'Microsoft Client secret', mTenant: 'Microsoft tenant (common = any)' };
const U = {
  gAuth: () => process.env.CRM_GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
  gToken: () => process.env.CRM_GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
  gApi: () => String(process.env.CRM_GOOGLE_API || 'https://www.googleapis.com/calendar/v3').replace(/\/+$/, ''),
  mLogin: () => String(process.env.CRM_MS_LOGIN || 'https://login.microsoftonline.com').replace(/\/+$/, ''),
  mGraph: () => String(process.env.CRM_MS_GRAPH || 'https://graph.microsoft.com/v1.0').replace(/\/+$/, ''),
};
const PROVIDERS = ['google', 'microsoft'];
const WORD = { google: 'Google Calendar', microsoft: 'Microsoft Outlook calendar' };
const clip = (v, n) => S.clip(v, n);
const sec = () => require('../utils/secrets'); // eslint-disable-line global-require

async function config() {
  const IS = require('../utils/integrationStore'); // eslint-disable-line global-require
  const v = ((await IS.readConfig(CHANNEL).catch(() => null)) || {}).values || {};
  const old = ((await IS.readConfig('calendar').catch(() => null)) || {}).values || {}; // the interview Calendar Sync card: the same OAuth app may serve both
  const oldP = /outlook|microsoft/i.test(String(old['Provider (Google / Outlook)'] || '')) ? 'microsoft' : /google/i.test(String(old['Provider (Google / Outlook)'] || '')) ? 'google' : '';
  const pick = (a, p, b) => String(v[a] || (oldP === p ? old[b] : '') || '').trim();
  const c = {
    google: { clientId: pick(F.gId, 'google', 'Client ID'), clientSecret: pick(F.gSecret, 'google', 'Client secret') },
    microsoft: { clientId: pick(F.mId, 'microsoft', 'Client ID'), clientSecret: pick(F.mSecret, 'microsoft', 'Client secret'), tenant: String(v[F.mTenant] || (oldP === 'microsoft' ? old['Tenant ID (Microsoft)'] : '') || 'common').trim() || 'common' },
  };
  c.google.ready = !!(c.google.clientId && c.google.clientSecret);
  c.microsoft.ready = !!(c.microsoft.clientId && c.microsoft.clientSecret);
  return c;
}
const baseUrl = (origin) => String(process.env.APP_BASE_URL || origin || '').replace(/\/+$/, '');
const redirectFor = (provider, origin) => `${baseUrl(origin)}/api/crm/pluse/calendar/callback/${provider}`;

// ---- the signed "state" that comes back from the provider (who joined, which provider, when) ---------------------------------------
const stateKey = () => crypto.createHash('sha256').update(`crm-calendar:${process.env.JWT_SECRET || 'teamlink'}`).digest();
function makeState(userId, provider) {
  const body = Buffer.from(JSON.stringify({ u: userId, p: provider, t: Date.now(), n: crypto.randomBytes(6).toString('hex') })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', stateKey()).update(body).digest('base64url')}`;
}
function readState(state) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', stateKey()).update(body).digest('base64url');
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  try { const j = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return Date.now() - j.t < 15 * 60000 ? j : null; } catch { return null; }
}

// ---- the person's joined calendars -------------------------------------------------------------------------------------------
async function linksOf(userId) {
  const rows = await P.all('SELECT * FROM "CrmCalendarLink" WHERE "userId" = ?', userId).catch(() => []);
  return Object.fromEntries(rows.map((r) => [r.provider, r]));
}
async function status(user, { origin } = {}) {
  const r = S.roleOf(user);
  if (!r) return S.fail(403, 'No CRM access.');
  const st = await P.settings();
  const cfg = await config();
  const mine = await linksOf(user.id);
  const prov = Object.fromEntries(PROVIDERS.map((p) => [p, { name: WORD[p], configured: cfg[p].ready, joined: !!mine[p], email: mine[p] ? mine[p].email : null, syncedAt: mine[p] ? mine[p].syncedAt : null, lastError: mine[p] ? mine[p].lastError : null }]));
  return S.okBody({ enabled: st.calendarSync, providers: prov, redirect: r === 'admin' ? { google: redirectFor('google', origin), microsoft: redirectFor('microsoft', origin) } : null });
}
async function connectUrl(user, provider, { origin } = {}) {
  if (!S.roleOf(user)) return S.fail(403, 'No CRM access.');
  if (!PROVIDERS.includes(provider)) return S.fail(404, 'Google or Microsoft.');
  const st = await P.settings();
  if (!st.calendarSync) return S.fail(409, 'Calendar sync is off. An Admin turns it on in CRM settings (Calendar, video and AI switches).');
  const cfg = (await config())[provider];
  if (!cfg.ready) return S.fail(409, `${WORD[provider]} is not set up yet: an Admin adds the ${provider === 'google' ? 'Google' : 'Microsoft'} OAuth app (Client ID and secret) in Administration → Integrations → CRM calendar sync.`, { needsAccount: true });
  const state = makeState(user.id, provider);
  const q = provider === 'google'
    ? new URLSearchParams({ client_id: cfg.clientId, redirect_uri: redirectFor('google', origin), response_type: 'code', scope: 'openid email https://www.googleapis.com/auth/calendar.events', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state })
    : new URLSearchParams({ client_id: cfg.clientId, redirect_uri: redirectFor('microsoft', origin), response_type: 'code', response_mode: 'query', scope: 'offline_access Calendars.ReadWrite User.Read', state });
  const url = provider === 'google' ? `${U.gAuth()}?${q}` : `${U.mLogin()}/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/authorize?${q}`;
  return S.okBody({ url });
}
async function tokenCall(provider, form) {
  const cfg = (await config())[provider];
  const url = provider === 'google' ? U.gToken() : `${U.mLogin()}/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/token`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...form }).toString() });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || !j.access_token) throw Object.assign(new Error(`${WORD[provider]} sign-in failed (${res.status}${j && j.error ? ` ${j.error}` : ''})`), { auth: true });
  return j;
}
const emailOfIdToken = (t) => { try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8')).email || null; } catch { return null; } };
// The provider sends the person back here (no TeamLink login on this request: the signed state says who it is). Answers the address to go to.
async function callback(provider, { code, state, error } = {}, { origin } = {}) {
  const back = (q) => `${baseUrl(origin)}/crm/followups?tab=calendar&${q}`;
  if (!PROVIDERS.includes(provider)) return back('calendar=failed&why=provider');
  const s = readState(state);
  if (!s || s.p !== provider) return back('calendar=failed&why=expired');
  if (error || !code) return back(`calendar=failed&why=${encodeURIComponent(clip(error, 40) || 'cancelled')}`);
  try {
    const j = await tokenCall(provider, { code: String(code), grant_type: 'authorization_code', redirect_uri: redirectFor(provider, origin) });
    let email = provider === 'google' ? emailOfIdToken(j.id_token) : null;
    if (provider === 'microsoft') {
      const me = await fetch(`${U.mGraph()}/me`, { headers: { Authorization: `Bearer ${j.access_token}` } }).then((x) => x.json()).catch(() => ({}));
      email = me.mail || me.userPrincipalName || null;
    }
    const now = DB.nowIso();
    const row = { id: S.newId('cal'), userId: s.u, provider, email: clip(email, 200), accessEnc: sec().encryptSecret(j.access_token), refreshEnc: j.refresh_token ? sec().encryptSecret(j.refresh_token) : null, expiresAt: new Date(Date.now() + (Number(j.expires_in) || 3600) * 1000).toISOString(), calendarId: 'primary', syncedAt: null, lastError: null, createdAt: now, updatedAt: now };
    await P.run('DELETE FROM "CrmCalendarLink" WHERE "userId" = ? AND "provider" = ?', s.u, provider);
    const cols = Object.keys(row);
    await P.run(`INSERT INTO "CrmCalendarLink" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c]));
    require('../utils/audit').logAudit({ userId: s.u, action: `CRM: ${WORD[provider]} joined`, entity: 'CrmCalendarLink', entityId: row.id, toValue: email || '' }).catch(() => {}); // eslint-disable-line global-require
    syncUser(s.u).catch(() => null);
    return back(`calendar=connected&provider=${provider}`);
  } catch (e) {
    return back(`calendar=failed&why=${encodeURIComponent(clip(e.message, 80) || 'error')}`);
  }
}
async function disconnect(user, provider) {
  if (!S.roleOf(user)) return S.fail(403, 'No CRM access.');
  await P.run('DELETE FROM "CrmCalendarLink" WHERE "userId" = ? AND "provider" = ?', user.id, provider);
  await P.run('DELETE FROM "CrmCalendarEvent" WHERE "userId" = ? AND "provider" = ?', user.id, provider);
  S.audit(user, `CRM: ${WORD[provider] || provider} disconnected`, 'CrmCalendarLink', user.id, provider);
  return S.okBody({ ok: true });
}
async function accessToken(link) {
  if (link.expiresAt && Date.parse(link.expiresAt) - Date.now() > 90000) return sec().decryptSecret(link.accessEnc);
  const refresh = link.refreshEnc ? sec().decryptSecret(link.refreshEnc) : null;
  if (!refresh) throw Object.assign(new Error('The calendar sign-in ran out. Join the calendar again.'), { auth: true });
  const j = await tokenCall(link.provider, { refresh_token: refresh, grant_type: 'refresh_token', ...(link.provider === 'microsoft' ? { scope: 'offline_access Calendars.ReadWrite User.Read' } : {}) });
  await P.run('UPDATE "CrmCalendarLink" SET "accessEnc" = ?, "refreshEnc" = COALESCE(?, "refreshEnc"), "expiresAt" = ?, "updatedAt" = ? WHERE "id" = ?', sec().encryptSecret(j.access_token), j.refresh_token ? sec().encryptSecret(j.refresh_token) : null, new Date(Date.now() + (Number(j.expires_in) || 3600) * 1000).toISOString(), DB.nowIso(), link.id);
  return j.access_token;
}
async function api(link, method, path, body, extraHeaders = {}) {
  const token = await accessToken(link);
  const base = link.provider === 'google' ? U.gApi() : U.mGraph();
  const res = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 204 || (method === 'DELETE' && res.ok)) return {};
  const j = await res.json().catch(() => null);
  if (res.status === 404 || res.status === 410) return { gone: true };
  if (!res.ok) throw Object.assign(new Error(`${WORD[link.provider]} said ${res.status}${j && j.error ? `: ${String(j.error.message || j.error).slice(0, 140)}` : ''}`), { status: res.status });
  return j || {};
}

// ---- event shapes ----------------------------------------------------------------------------------------------------------------
const MS_TZ = { Prefer: 'outlook.timezone="India Standard Time"' };
const istParts = (iso) => { const d = new Date(Date.parse(iso) + 5.5 * 3600000).toISOString(); return { date: d.slice(0, 10), time: d.slice(11, 16) }; };
const plusMin = (date, time, mins) => { const t = new Date(Date.parse(`${date}T${time}:00+05:30`) + mins * 60000); return istParts(t.toISOString()); };
const nextDay = (ymd) => new Date(Date.parse(`${ymd}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
function eventBody(provider, t, minutes) {
  const title = clip(`${t.type || 'Follow-up'}: ${t.title}${t.recordName ? ` · ${t.recordName}` : ''}`, 250);
  const description = `TeamLink CRM follow-up${t.recordName ? ` for ${t.recordName}` : ''}.${t.meetingUrl ? `\nMeeting link: ${t.meetingUrl}` : ''}\nMove it here and the CRM follow-up moves too.`;
  if (provider === 'google') {
    if (!t.dueTime) return { summary: title, description, start: { date: t.dueDate }, end: { date: nextDay(t.dueDate) }, extendedProperties: { private: { tlTask: t.id } } };
    const e = plusMin(t.dueDate, t.dueTime, minutes);
    return { summary: title, description, start: { dateTime: `${t.dueDate}T${t.dueTime}:00+05:30`, timeZone: 'Asia/Kolkata' }, end: { dateTime: `${e.date}T${e.time}:00+05:30`, timeZone: 'Asia/Kolkata' }, extendedProperties: { private: { tlTask: t.id } } };
  }
  if (!t.dueTime) return { subject: title, body: { contentType: 'text', content: description }, isAllDay: true, start: { dateTime: `${t.dueDate}T00:00:00`, timeZone: 'India Standard Time' }, end: { dateTime: `${nextDay(t.dueDate)}T00:00:00`, timeZone: 'India Standard Time' } };
  const e = plusMin(t.dueDate, t.dueTime, minutes);
  return { subject: title, body: { contentType: 'text', content: description }, start: { dateTime: `${t.dueDate}T${t.dueTime}:00`, timeZone: 'India Standard Time' }, end: { dateTime: `${e.date}T${e.time}:00`, timeZone: 'India Standard Time' } };
}
// an event as { id, title, date, time ('' = all day), endAt, cancelled, attendees[] } in India time
function readEvent(provider, ev) {
  if (provider === 'google') {
    const allDay = !!(ev.start && ev.start.date);
    const p = allDay ? { date: ev.start.date, time: '' } : istParts((ev.start && ev.start.dateTime) || new Date().toISOString());
    return { id: ev.id, title: ev.summary || '(busy)', date: p.date, time: p.time, startAt: allDay ? `${ev.start.date}T00:00:00+05:30` : ev.start && ev.start.dateTime, endAt: ev.end ? (ev.end.dateTime || `${ev.end.date}T00:00:00+05:30`) : null, cancelled: ev.status === 'cancelled', attendees: (ev.attendees || []).map((a) => String(a.email || '').toLowerCase()).filter(Boolean), updated: ev.updated || null, tlTask: ev.extendedProperties && ev.extendedProperties.private ? ev.extendedProperties.private.tlTask : null };
  }
  const local = String((ev.start && ev.start.dateTime) || '').slice(0, 16);
  const allDay = !!ev.isAllDay;
  return { id: ev.id, title: ev.subject || '(busy)', date: local.slice(0, 10), time: allDay ? '' : local.slice(11, 16), startAt: `${local}:00+05:30`, endAt: ev.end && ev.end.dateTime ? `${String(ev.end.dateTime).slice(0, 16)}:00+05:30` : null, cancelled: !!ev.isCancelled, attendees: (ev.attendees || []).map((a) => String((a.emailAddress && a.emailAddress.address) || '').toLowerCase()).filter(Boolean), updated: ev.lastModifiedDateTime || null, tlTask: null };
}
async function listEvents(link, fromYmd, toYmd) {
  const timeMin = new Date(Date.parse(`${fromYmd}T00:00:00+05:30`)).toISOString(); const timeMax = new Date(Date.parse(`${toYmd}T00:00:00+05:30`) + 86400000).toISOString();
  if (link.provider === 'google') {
    const out = []; let pageToken = '';
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const j = await api(link, 'GET', `/calendars/${encodeURIComponent(link.calendarId || 'primary')}/events?${new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', showDeleted: 'true', maxResults: '250', ...(pageToken ? { pageToken } : {}) })}`);
      out.push(...(j.items || []));
      if (!j.nextPageToken) break;
      pageToken = j.nextPageToken;
    }
    return out.map((e) => readEvent('google', e));
  }
  const j = await api(link, 'GET', `/me/calendarView?${new URLSearchParams({ startDateTime: timeMin, endDateTime: timeMax, $top: '250' })}`, null, MS_TZ);
  return (j.value || []).map((e) => readEvent('microsoft', e));
}

// ---- one person's sync ---------------------------------------------------------------------------------------------------------
const stamp = (t) => `${t.dueDate}T${t.dueTime || ''}|${t.title}|${t.meetingUrl || ''}`;
async function syncLink(link) {
  const st = await P.settings();
  const today = S.istToday();
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const to = new Date(Date.parse(`${today}T00:00:00Z`) + 60 * 86400000).toISOString().slice(0, 10);
  const counts = { pushed: 0, updated: 0, removed: 0, pulled: 0, busy: 0 };
  const now = DB.nowIso();
  const tasks = await P.all(`SELECT t.*, COALESCE(d."title", l."company", a."name") AS "recordName" FROM "CrmTask" t LEFT JOIN "CrmDeal" d ON d."id" = t."dealId" LEFT JOIN "CrmLead" l ON l."id" = t."leadId" LEFT JOIN "CrmAccount" a ON a."id" = t."accountId"
    WHERE t."ownerId" = ? AND t."status" = 'Open' AND t."dueDate" >= ? AND t."dueDate" <= ?`, link.userId, from, to);
  const allMaps = await P.all('SELECT * FROM "CrmCalendarEvent" WHERE "userId" = ? AND "provider" = ? AND "direction" = \'out\'', link.userId, link.provider);
  const maps = allMaps.filter((m) => !m.deleted);
  const byTask = new Map(allMaps.map((m) => [m.taskId, m]));
  const remote = await listEvents(link, from, to);
  const byId = new Map(remote.map((e) => [e.id, e]));
  // 1. calendar -> CRM: an event we made that was moved there moves the follow-up (when the follow-up itself did not change since)
  for (const m of maps) {
    const ev = byId.get(m.eventId);
    const t = tasks.find((x) => x.id === m.taskId);
    if (!ev || !t) continue; // eslint-disable-line no-continue
    if (ev.cancelled) {
      // removed in the calendar: the follow-up stays (it is the CRM's), it is simply no longer on the calendar
      await P.run('UPDATE "CrmCalendarEvent" SET "deleted" = 1, "updatedAt" = ? WHERE "id" = ?', now, m.id); // eslint-disable-line no-await-in-loop
      m.deleted = 1; // a person took it off their calendar on purpose: it is made again only when the follow-up itself changes
      continue; // eslint-disable-line no-continue
    }
    const remoteWhen = `${ev.date}T${ev.time}`; const ourWhen = String(m.startAt || '');
    if (remoteWhen !== ourWhen && stamp(t).split('|')[0] === ourWhen) {
      await S.update('CrmTask', t.id, { dueDate: ev.date, dueTime: ev.time || null, reminderSentAt: null, remindedOn: null, escalatedAt: null, updatedAt: now }); // eslint-disable-line no-await-in-loop
      await S.insert('CrmActivity', { id: S.newId('act'), kind: 'note', subject: `Follow-up moved: ${t.title}`, note: `${t.dueDate}${t.dueTime ? ` ${t.dueTime}` : ''} → ${ev.date}${ev.time ? ` ${ev.time}` : ''} (moved in ${WORD[link.provider]})`, at: now, leadId: t.leadId || null, dealId: t.dealId || null, accountId: t.accountId || null, byId: link.userId, byName: null, createdAt: now }); // eslint-disable-line no-await-in-loop
      Object.assign(t, { dueDate: ev.date, dueTime: ev.time || null });
      await P.run('UPDATE "CrmCalendarEvent" SET "startAt" = ?, "title" = ?, "remoteUpdated" = ?, "updatedAt" = ? WHERE "id" = ?', remoteWhen, stamp(t), ev.updated, now, m.id); // eslint-disable-line no-await-in-loop
      m.startAt = remoteWhen; m.title = stamp(t);
      counts.pulled += 1;
    }
  }
  // 2. CRM -> calendar: new follow-ups made, changed ones moved
  for (const t of tasks) {
    const m = byTask.get(t.id);
    const body = eventBody(link.provider, t, st.meetingMinutes);
    if (m && m.deleted && m.title === stamp(t)) continue; // eslint-disable-line no-continue
    if (!m || m.deleted) {
      const path = link.provider === 'google' ? `/calendars/${encodeURIComponent(link.calendarId || 'primary')}/events?sendUpdates=none` : '/me/events';
      const ev = await api(link, 'POST', path, body); // eslint-disable-line no-await-in-loop
      if (!ev.id) continue; // eslint-disable-line no-continue
      if (m) await P.run('DELETE FROM "CrmCalendarEvent" WHERE "id" = ?', m.id); // eslint-disable-line no-await-in-loop
      await P.run('INSERT INTO "CrmCalendarEvent" ("id", "userId", "provider", "eventId", "direction", "taskId", "title", "startAt", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, \'out\', ?, ?, ?, ?, ?) ON CONFLICT("userId", "provider", "eventId") DO NOTHING', S.newId('cev'), link.userId, link.provider, ev.id, t.id, stamp(t), `${t.dueDate}T${t.dueTime || ''}`, now, now); // eslint-disable-line no-await-in-loop
      counts.pushed += 1;
    } else if (m.title !== stamp(t)) {
      const path = link.provider === 'google' ? `/calendars/${encodeURIComponent(link.calendarId || 'primary')}/events/${encodeURIComponent(m.eventId)}?sendUpdates=none` : `/me/events/${encodeURIComponent(m.eventId)}`;
      const ev = await api(link, 'PATCH', path, body); // eslint-disable-line no-await-in-loop
      await P.run('UPDATE "CrmCalendarEvent" SET "title" = ?, "startAt" = ?, "deleted" = ?, "updatedAt" = ? WHERE "id" = ?', stamp(t), `${t.dueDate}T${t.dueTime || ''}`, ev.gone ? 1 : 0, now, m.id); // eslint-disable-line no-await-in-loop
      counts.updated += 1;
    }
  }
  // 3. done / cancelled / deleted follow-ups (or moved out of the window): off the calendar
  const openIds = new Set(tasks.map((t) => t.id));
  for (const m of maps.filter((x) => !x.deleted)) {
    if (openIds.has(m.taskId)) continue; // eslint-disable-line no-continue
    const t = await DB.one('SELECT "status", "dueDate" FROM "CrmTask" WHERE "id" = ?', m.taskId); // eslint-disable-line no-await-in-loop
    if (t && t.status === 'Open') continue; // eslint-disable-line no-continue
    const path = link.provider === 'google' ? `/calendars/${encodeURIComponent(link.calendarId || 'primary')}/events/${encodeURIComponent(m.eventId)}?sendUpdates=none` : `/me/events/${encodeURIComponent(m.eventId)}`;
    await api(link, 'DELETE', path).catch(() => null); // eslint-disable-line no-await-in-loop
    await P.run('UPDATE "CrmCalendarEvent" SET "deleted" = 1, "updatedAt" = ? WHERE "id" = ?', now, m.id); // eslint-disable-line no-await-in-loop
    counts.removed += 1;
  }
  // 4. their own events = busy blocks (joined to a lead / contact by an attendee's email)
  const ours = new Set(allMaps.map((m) => m.eventId));
  await P.run('DELETE FROM "CrmCalendarEvent" WHERE "userId" = ? AND "provider" = ? AND "direction" = \'in\'', link.userId, link.provider);
  for (const ev of remote) {
    if (ours.has(ev.id) || ev.tlTask || ev.cancelled) continue; // eslint-disable-line no-continue
    let leadId = null; let contactId = null;
    if (ev.attendees.length) {
      const ph = ev.attendees.slice(0, 10).map(() => '?').join(',');
      const l = await DB.one(`SELECT "id" FROM "CrmLead" WHERE LOWER("email") IN (${ph}) LIMIT 1`, ...ev.attendees.slice(0, 10)); // eslint-disable-line no-await-in-loop
      const c = l ? null : await DB.one(`SELECT "id" FROM "CrmContact" WHERE LOWER("email") IN (${ph}) LIMIT 1`, ...ev.attendees.slice(0, 10)); // eslint-disable-line no-await-in-loop
      leadId = l ? l.id : null; contactId = c ? c.id : null;
    }
    await P.run('INSERT INTO "CrmCalendarEvent" ("id", "userId", "provider", "eventId", "direction", "title", "startAt", "endAt", "attendees", "leadId", "contactId", "remoteUpdated", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, \'in\', ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT("userId", "provider", "eventId") DO NOTHING', S.newId('cev'), link.userId, link.provider, ev.id, clip(ev.title, 200), `${ev.date}T${ev.time}`, ev.endAt, ev.attendees.slice(0, 10).join(','), leadId, contactId, ev.updated, now, now); // eslint-disable-line no-await-in-loop
    counts.busy += 1;
  }
  await P.run('UPDATE "CrmCalendarLink" SET "syncedAt" = ?, "lastError" = NULL, "updatedAt" = ? WHERE "id" = ?', now, now, link.id);
  return counts;
}
// one sync at a time per person (the sync right after joining, "Sync now" and the 10-minute run must never make the same event twice)
const running = new Map();
function syncUser(userId) {
  const prev = running.get(userId) || Promise.resolve();
  const next = prev.catch(() => null).then(() => syncUserNow(userId));
  running.set(userId, next);
  next.finally(() => { if (running.get(userId) === next) running.delete(userId); }).catch(() => null);
  return next;
}
async function syncUserNow(userId) {
  const links = Object.values(await linksOf(userId));
  const out = {};
  for (const l of links) {
    try { out[l.provider] = await syncLink(l); } catch (e) { // eslint-disable-line no-await-in-loop
      out[l.provider] = { error: clip(e.message, 200) };
      await P.run('UPDATE "CrmCalendarLink" SET "lastError" = ?, "updatedAt" = ? WHERE "id" = ?', clip(e.message, 300), DB.nowIso(), l.id).catch(() => null); // eslint-disable-line no-await-in-loop
    }
  }
  return out;
}
async function syncNow(user) {
  if (!S.roleOf(user)) return S.fail(403, 'No CRM access.');
  const st = await P.settings();
  if (!st.calendarSync) return S.fail(409, 'Calendar sync is off. An Admin turns it on in CRM settings.');
  const links = await linksOf(user.id);
  if (!Object.keys(links).length) return S.fail(409, 'Join your Google or Microsoft calendar first.');
  return S.okBody({ ok: true, result: await syncUser(user.id) });
}
// every 10 minutes while the Admin switch is on
async function tick() {
  const st = await P.settings();
  if (!st.calendarSync) return 0;
  const users = await P.all('SELECT DISTINCT "userId" FROM "CrmCalendarLink"');
  for (const u of users) await syncUser(u.userId).catch(() => null); // eslint-disable-line no-await-in-loop
  return users.length;
}
// the person's own busy events for the CRM calendar view
async function busy(user, { from, to } = {}) {
  if (!S.roleOf(user)) return S.fail(403, 'No CRM access.');
  const YMD = /^\d{4}-\d{2}-\d{2}$/;
  const f = YMD.test(String(from || '')) ? from : S.istToday(); const t = YMD.test(String(to || '')) ? to : f;
  const rows = await P.all(`SELECT e."provider", e."title", e."startAt", e."endAt", e."leadId", e."contactId", l."company" AS "leadName", c."name" AS "contactName"
    FROM "CrmCalendarEvent" e LEFT JOIN "CrmLead" l ON l."id" = e."leadId" LEFT JOIN "CrmContact" c ON c."id" = e."contactId"
    WHERE e."userId" = ? AND e."direction" = 'in' AND e."deleted" = 0 AND e."startAt" >= ? AND e."startAt" <= ? ORDER BY e."startAt" LIMIT 500`, user.id, f, `${t}T99`);
  return S.okBody({ events: rows.map((r) => ({ ...r, date: String(r.startAt).slice(0, 10), time: String(r.startAt).slice(11, 16) })) });
}
// a Meet / Teams meeting on the person's OWN joined calendar (crm/workPlus.js videoMeeting)
async function meetingOnMyCalendar(user, provider, { title, start, minutes, description }) {
  const link = (await linksOf(user.id))[provider];
  if (!link) return { ok: false, notJoined: true, error: `Join your ${WORD[provider]} first (Follow-ups → Calendar), or an Admin sets up the company calendar account.` };
  const end = new Date(start.getTime() + minutes * 60000);
  if (provider === 'google') {
    const ev = await api(link, 'POST', `/calendars/${encodeURIComponent(link.calendarId || 'primary')}/events?conferenceDataVersion=1&sendUpdates=none`, { summary: title, description, start: { dateTime: start.toISOString(), timeZone: 'Asia/Kolkata' }, end: { dateTime: end.toISOString(), timeZone: 'Asia/Kolkata' }, conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } } });
    const video = ((ev.conferenceData && ev.conferenceData.entryPoints) || []).find((e) => e.entryPointType === 'video');
    const url = ev.hangoutLink || (video && video.uri) || null;
    return url && /^https:\/\//.test(url) ? { ok: true, url, provider: 'Google Meet', ref: ev.id } : { ok: false, error: 'Google made the event but gave no Meet link (is Google Meet allowed for this account?).' };
  }
  const ist = (d) => new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 19);
  const ev = await api(link, 'POST', '/me/events', { subject: title, body: { contentType: 'text', content: description }, start: { dateTime: ist(start), timeZone: 'India Standard Time' }, end: { dateTime: ist(end), timeZone: 'India Standard Time' }, isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' });
  const url = ev.onlineMeeting && ev.onlineMeeting.joinUrl;
  return url && /^https:\/\//.test(url) ? { ok: true, url, provider: 'Microsoft Teams', ref: ev.id } : { ok: false, error: 'Microsoft made the event but gave no Teams link (is Teams on for this mailbox?).' };
}

module.exports = { CHANNEL, FIELDS: F, config, status, connectUrl, callback, disconnect, syncNow, syncUser, tick, busy, linksOf, meetingOnMyCalendar, makeState, readState, redirectFor };
