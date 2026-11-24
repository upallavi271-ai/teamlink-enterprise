// ---------------------------------------------------------------------------
// GOOGLE WORKSPACE / MICROSOFT 365 FOR THE ATS (market benchmark 07.01 calendar sync + 14.05 mail, calendar and contacts; ATS wave 2 Z,
// 2026-11-25). Market wave C built the per-person OAuth connection and the push (utils/mkt/interviews.js: connectStart / connectCallback /
// pushToCalendars / calendarBusy); this file finishes it:
//
//   ONE PLACE FOR THE APP KEYS   Administration > Integrations > "Google Workspace / Microsoft 365 (ATS)" (integrationStore channel
//                                ats-workspace, secrets encrypted). appKeys() in utils/mkt/interviews.js falls back to it, and to the
//                                older ATS settings > Integrations > Google / Microsoft 365 boxes, so a key typed in any of them works.
//   FOLLOWS THE BOOKING          a booked / rescheduled interview is put in (or moved in) the connected calendars of its recruiter and
//                                panel; a cancelled / no-show one is taken out. Only while the Admin switch "calendarPush" is ON
//                                (Administration > Step timing and alerts > Add-on switches) - OFF by default.
//   CONTACTS                     GET /calendarz/contacts?provider&q reads the person's own Google / Outlook contacts (People API /
//                                Graph), so a client contact is picked instead of typed. Nothing is stored until they press Use.
//   OVERVIEW                     GET /calendarz/overview: app keys ready?, my connections, the switch, the redirect addresses to register.
// Every outside address can be pointed at a stub (MKT_GOOGLE_*_URL, MKT_MS_*_URL, MKT_GOOGLE_PEOPLE_URL); the sandbox only calls a stub.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../../db');
const { logAudit } = require('../audit');
const S = require('./store');

const IV = () => require('../mkt/interviews'); // eslint-disable-line global-require
const MC = () => require('../mkt/core'); // eslint-disable-line global-require

// ------------------------------------------------------------------ the app keys (founder's Google Cloud / Microsoft Entra apps)
async function workspaceKeys(provider) {
  const { readConfig } = require('../integrationStore'); // eslint-disable-line global-require
  const v = (await readConfig('ats-workspace').catch(() => ({ values: {} }))).values || {};
  const old = await S.settings.get('workspace', {}); // the ATS settings > Integrations > Google / Microsoft 365 boxes (before wave 2)
  const dec = (e) => { try { return e ? require('../secrets').decryptSecret(e) : ''; } catch { return ''; } }; // eslint-disable-line global-require
  if (provider === 'google') {
    const clientId = String(v['Google client ID'] || old.googleClientId || '').trim();
    const secret = String(v['Google client secret'] || dec(old.googleSecretEnc) || '').trim();
    return { clientId, secret, tenant: 'common', saved: !!(clientId && secret), from: v['Google client ID'] ? 'integrations' : (old.googleClientId ? 'ats-settings' : null) };
  }
  if (provider === 'microsoft') {
    const clientId = String(v['Microsoft app (client) ID'] || old.msClientId || '').trim();
    const secret = String(v['Microsoft client secret'] || dec(old.msSecretEnc) || '').trim();
    const tenant = String(v['Microsoft tenant ID (common = any)'] || old.msTenantId || 'common').trim() || 'common';
    return { clientId, secret, tenant, saved: !!(clientId && secret), from: v['Microsoft app (client) ID'] ? 'integrations' : (old.msClientId ? 'ats-settings' : null) };
  }
  return { clientId: '', secret: '', tenant: 'common', saved: false, from: null };
}

// ------------------------------------------------------------------ take an interview out of the calendars it was put in
async function removeFromCalendars(appId) {
  const C = MC(); const I = IV();
  await C.ensure();
  const rows = await C.q('SELECT * FROM "MktCalPush" WHERE "applicationId" = ?', String(appId));
  let removed = 0; const errors = [];
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    const tok = await I.accessToken(r.userId, r.provider).catch(() => null);
    if (tok && r.eventId) {
      const P = I.PROVIDERS[r.provider];
      const url = r.provider === 'google' ? `${P.api()}/calendars/primary/events/${encodeURIComponent(r.eventId)}` : `${P.api()}/me/events/${encodeURIComponent(r.eventId)}`;
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } }).catch(() => null);
      if (!res || (!res.ok && res.status !== 404 && res.status !== 410)) { errors.push(`${r.provider}: ${res ? res.status : 'no answer'}`); continue; } // eslint-disable-line no-continue
    }
    // eslint-disable-next-line no-await-in-loop
    await C.x('DELETE FROM "MktCalPush" WHERE "applicationId" = ? AND "round" = ? AND "userId" = ? AND "provider" = ?', r.applicationId, r.round, r.userId, r.provider);
    removed += 1;
  }
  return { removed, errors };
}

// ------------------------------------------------------------------ follow the booking (index.js: app.use('/api/ats', autoPushMiddleware))
const WATCH = /^\/interviews\/([^/]+)\/(book|reschedule|cancel|no-show)\/?$/;
const lastRun = new Map(); // appId -> promise (tests wait on it)
function autoPushMiddleware(req, res, next) {
  if (req.method !== 'POST') return next();
  const m = WATCH.exec(String(req.path || ''));
  if (!m) return next();
  const [, appId, what] = m;
  res.on('finish', () => {
    if (res.statusCode >= 300) return;
    const job = (async () => {
      if (!(await MC().switchOn('calendarPush'))) return { off: true };
      const out = ['cancel', 'no-show'].includes(what) ? await removeFromCalendars(appId) : await IV().pushToCalendars(appId);
      if ((out.pushed || out.removed) && req.user) await logAudit({ userId: req.user.id, action: ['cancel', 'no-show'].includes(what) ? 'Interview taken out of the connected calendars' : 'Interview put in the connected calendars', entity: 'Application', entityId: appId, toValue: JSON.stringify(out).slice(0, 200) });
      return out;
    })().catch((e) => { console.error('[calendar push]', e.message); return { error: e.message }; });
    lastRun.set(appId, job);
  });
  return next();
}

// ------------------------------------------------------------------ contacts (14.05)
const PEOPLE = () => process.env.MKT_GOOGLE_PEOPLE_URL || 'https://people.googleapis.com/v1';
async function contacts(userId, provider, q) {
  const I = IV();
  const tok = await I.accessToken(userId, provider).catch(() => null);
  if (!tok) return { status: 409, error: `Connect your ${provider === 'google' ? 'Google' : 'Microsoft'} account first (Interview Calendar > an interview > Scheduling > Calendars, or here).` };
  const needle = String(q || '').trim().toLowerCase().slice(0, 60);
  let out = [];
  if (provider === 'google') {
    const r = await fetch(`${PEOPLE()}/people/me/connections?personFields=names,emailAddresses,phoneNumbers,organizations&pageSize=500`, { headers: { Authorization: `Bearer ${tok}` } }).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => ({})) : null;
    if (!j) return { status: 502, error: 'Google did not give the contacts. Connect again (the contacts permission may be missing).' };
    out = (j.connections || []).map((p) => ({ name: ((p.names || [])[0] || {}).displayName || '', email: ((p.emailAddresses || [])[0] || {}).value || '', phone: ((p.phoneNumbers || [])[0] || {}).value || '', company: ((p.organizations || [])[0] || {}).name || '', title: ((p.organizations || [])[0] || {}).title || '' }));
  } else {
    const P = I.PROVIDERS.microsoft;
    const r = await fetch(`${P.api()}/me/contacts?$top=500&$select=displayName,emailAddresses,mobilePhone,businessPhones,companyName,jobTitle`, { headers: { Authorization: `Bearer ${tok}` } }).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => ({})) : null;
    if (!j) return { status: 502, error: 'Microsoft did not give the contacts. Connect again (the Contacts.Read permission may be missing).' };
    out = (j.value || []).map((p) => ({ name: p.displayName || '', email: ((p.emailAddresses || [])[0] || {}).address || '', phone: p.mobilePhone || (p.businessPhones || [])[0] || '', company: p.companyName || '', title: p.jobTitle || '' }));
  }
  out = out.filter((c) => c.name || c.email).filter((c) => !needle || `${c.name} ${c.email} ${c.company}`.toLowerCase().includes(needle)).slice(0, 100);
  return { status: 200, provider, contacts: out };
}

// ------------------------------------------------------------------ routes (/api/ats-plus)
const router = express.Router();
router.get('/calendarz/overview', S.internal, S.wrap(async (req, res) => {
  const C = MC(); const I = IV();
  const keys = { google: await workspaceKeys('google'), microsoft: await workspaceKeys('microsoft') };
  const app = { google: await I.appKeys('google'), microsoft: await I.appKeys('microsoft') };
  res.json({
    apps: Object.fromEntries(Object.keys(keys).map((p) => [p, { ready: app[p].saved, from: app[p].saved ? (keys[p].saved ? keys[p].from : 'step-timing') : null }])),
    connections: await I.connections(req.user.id), pushSwitch: await C.switchOn('calendarPush'),
    redirect: { google: `${C.publicBase(req)}/api/public/mkt/cal-oauth/google/callback`, microsoft: `${C.publicBase(req)}/api/public/mkt/cal-oauth/microsoft/callback` },
    setUpLink: '/admin/integrations?tab=connections&channel=ats-workspace', switchLink: '/admin/step-timing', canEdit: S.isAdmin(req.user) && !req.viewAs,
  });
}));
router.get('/calendarz/contacts', S.writer, S.wrap(async (req, res) => {
  const provider = req.query.provider === 'microsoft' ? 'microsoft' : 'google';
  const r = await contacts(req.user.id, provider, req.query.q);
  res.status(r.status).json(r);
}));
// "Use" a contact on a client: the client's own edit route (the caller's rights, the client's audit trail)
router.post('/calendarz/contacts/use', S.writer, S.wrap(async (req, res) => {
  const b = req.body || {};
  const which = b.slot === 'secondary' ? 'secondary' : 'primary';
  const c = b.contact || {};
  if (!b.clientId || !(c.name || c.email)) return res.status(400).json({ error: 'Pick a client and a contact.' });
  const data = which === 'primary'
    ? { contactName: c.name || undefined, contactEmail: c.email || undefined, contactPhone: c.phone || undefined, contactDesignation: c.title || undefined }
    : { secondaryContactName: c.name || undefined, secondaryContactEmail: c.email || undefined, secondaryContactPhone: c.phone || undefined, secondaryContactDesignation: c.title || undefined };
  const r = await fetch(`http://127.0.0.1:${process.env.PORT || 4000}/api/clients/${encodeURIComponent(String(b.clientId))}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: req.headers.authorization || '' }, body: JSON.stringify(data) });
  let j = {}; try { j = await r.json(); } catch { /* none */ }
  if (!r.ok) return res.status(r.status).json(j);
  await logAudit({ userId: req.user.id, action: `Client ${which} contact taken from ${b.provider === 'microsoft' ? 'Outlook' : 'Google'} contacts`, entity: 'Client', entityId: String(b.clientId), toValue: c.name || c.email });
  return res.json({ ok: true });
}));
router.get('/calendarz/clients', S.writer, S.wrap(async (req, res) => {
  const { clientWhere } = require('../scope'); // eslint-disable-line global-require
  res.json({ clients: await prisma.client.findMany({ where: clientWhere(req.user), select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 2000 }) });
}));

module.exports = { router, workspaceKeys, removeFromCalendars, autoPushMiddleware, contacts, lastRun };
