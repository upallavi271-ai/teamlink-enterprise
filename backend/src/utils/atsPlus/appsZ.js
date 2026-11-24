// ---------------------------------------------------------------------------
// THE ATS APP CATALOGUE (market benchmark 14.03, ATS wave 2 Z 2026-11-25). Bullhorn / Zoho / Recruit CRM show a marketplace of apps to
// install. TeamLink's apps are BUILT IN: nothing is downloaded, each one is switched on by typing its keys or flipping its switch. This is
// the one list of them, with the REAL status read from where each one lives, and a "Set up" link to that place:
//
//   Connected        it has its keys / proof and is on          Ready      keys typed, not yet proven (or waiting for the first use)
//   Switched off     keys typed, but its switch is off          Not set up nothing typed yet (needsFounder: it needs an outside account
//   Built in         works without any outside account                     only the founder can open: partner / vendor / OAuth app)
//
//   GET /api/ats-plus/apps   -> { apps: [{ id, name, category, what, status, tone, needsFounder, setUpLink, detail }], categories, counts }
// Read only, no secrets: a status word and a count at most. Every internal ATS login may read it; the Set up links are for Admins.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../../db');
const S = require('./store');

const INTEG = (id) => `/admin/integrations?tab=connections&channel=${id}`;
const ATS = (sub) => `/admin/ats-settings?tab=integrations&sub=${sub}`;
const TONE = { Connected: 'green', 'Built in': 'green', Ready: 'blue', 'Switched off': 'amber', 'Not set up': 'grey' };

async function channelState(id) {
  const row = await prisma.integration.findUnique({ where: { id } }).catch(() => null);
  let filled = 0;
  try { filled = Object.values(row && row.values ? JSON.parse(row.values) : {}).filter((v) => String(v || '').trim()).length; } catch { filled = 0; }
  if (row && row.connected && row.enabled) return { status: 'Connected', detail: row.connectedAt ? `since ${new Date(row.connectedAt).toISOString().slice(0, 10)}` : null };
  if (filled && row && row.enabled === false) return { status: 'Switched off', detail: 'keys saved, switched off' };
  if (filled) return { status: 'Ready', detail: 'keys saved' };
  return { status: 'Not set up', detail: null };
}
async function safe(fn, fallback) { try { return await fn(); } catch { return fallback; } }

async function catalogue() {
  const apps = [];
  const add = (a) => apps.push({ needsFounder: false, detail: null, ...a, tone: TONE[a.status] || 'grey' });
  const JC = require('../jobConnectors'); // eslint-disable-line global-require
  // ---- job boards and sourcing
  for (const [id, name, founder] of [['naukri', 'Naukri', true], ['shine', 'Shine', true], ['foundit', 'foundit (Monster India)', true], ['indeed', 'Indeed', true], ['linkedin', 'LinkedIn Jobs', true], ['google-jobs', 'Google for Jobs', false]]) {
    // eslint-disable-next-line no-await-in-loop
    const b = await safe(() => JC.boardStatus(id), null);
    const word = b ? b.word : 'Not connected';
    const status = word === 'Connected' ? 'Connected' : (b && b.ready) ? 'Ready' : word === 'Waiting for approval' ? 'Ready' : 'Not set up';
    add({ id, name, category: 'Job boards', what: `Save & Post sends each requirement to ${name}${founder ? ' (partner account)' : ''}; one job, every ticked board.`, status: id === 'google-jobs' && status === 'Not set up' ? 'Built in' : status, needsFounder: founder && status === 'Not set up', setUpLink: INTEG(id), detail: b ? (b.jobs && b.jobs.posted ? `${b.jobs.posted} posted` : b.wordWhy || null) : null });
  }
  const pull = await channelState('ats-board-pull');
  const pullSet = await S.settings.get('boardPullZ', { autoRead: false });
  add({ id: 'ats-board-pull', name: 'Job-board responses', category: 'Job boards', what: 'Applicants on Naukri / Shine / foundit read back into the ATS.', status: pull.status === 'Not set up' ? 'Not set up' : (pullSet.autoRead ? 'Connected' : 'Ready'), needsFounder: pull.status === 'Not set up', setUpLink: INTEG('ats-board-pull'), detail: pullSet.autoRead ? 'read every hour' : 'hourly read OFF' });
  add({ id: 'career-site', name: 'Career page and Job Portal', category: 'Job boards', what: 'Your own jobs page and the candidate Job Portal.', status: 'Built in', setUpLink: '/admin/integrations?tab=jobportal' });
  add({ id: 'linkedin-capture', name: 'LinkedIn profile capture (browser extension)', category: 'Job boards', what: 'Save a LinkedIn profile into the ATS with one click (each recruiter makes their own key).', status: 'Built in', setUpLink: '/ats/candidates' });
  // ---- calendar, mail, meetings
  const I = require('../mkt/interviews'); // eslint-disable-line global-require
  const gReady = (await safe(() => I.appKeys('google'), {})).saved; const mReady = (await safe(() => I.appKeys('microsoft'), {})).saved;
  const push = await safe(() => require('../mkt/core').switchOn('calendarPush'), false); // eslint-disable-line global-require
  const links = await safe(async () => { await require('../mkt/core').ensure(); return (await require('../mkt/core').q('SELECT COUNT(*) AS n FROM "MktCalLink" WHERE "refreshEnc" IS NOT NULL'))[0].n; }, 0); // eslint-disable-line global-require
  const wsStatus = !(gReady || mReady) ? 'Not set up' : (Number(links) > 0 ? (push ? 'Connected' : 'Switched off') : 'Ready');
  add({ id: 'ats-workspace', name: 'Google Workspace / Microsoft 365', category: 'Calendar and mail', what: 'Interviews in each interviewer\'s Google / Outlook calendar, busy times, contacts.', status: wsStatus, needsFounder: !(gReady || mReady), setUpLink: INTEG('ats-workspace'), detail: `${[gReady && 'Google', mReady && 'Microsoft'].filter(Boolean).join(' + ') || 'no app'} · ${Number(links) || 0} calendar(s) connected · follow bookings ${push ? 'ON' : 'OFF'}` });
  add({ id: 'calendar-feed', name: 'Calendar feed (.ics) and Add to Google / Outlook', category: 'Calendar and mail', what: 'A private calendar address per person, an .ics per interview, one-click Add to Google / Outlook.', status: 'Built in', setUpLink: '/ats/interviews' });
  for (const [id, name, what, founder] of [['calendar', 'Meeting links (Google Meet / Teams)', 'A real Meet / Teams link when an interview is booked.', true], ['email', 'E-mail (SMTP)', 'Mails from the ATS (interview invites, offers).', false], ['email-inbox', 'Shared inbox (IMAP)', 'Candidate and client replies into the ATS.', false]]) {
    const st = await channelState(id); // eslint-disable-line no-await-in-loop
    add({ id, name, category: 'Calendar and mail', what, status: st.status, needsFounder: founder && st.status === 'Not set up', setUpLink: INTEG(id), detail: st.detail });
  }
  // ---- messaging
  for (const [id, name, what] of [['whatsapp', 'WhatsApp Business', 'Messages to candidates and clients on WhatsApp.'], ['sms', 'SMS (DLT)', 'SMS to candidates (DLT templates).'], ['telephony', 'Calling / IVR', 'Click-to-call and recorded calls.']]) {
    const st = await channelState(id); // eslint-disable-line no-await-in-loop
    add({ id, name, category: 'Messaging and calling', what, status: st.status, needsFounder: st.status === 'Not set up', setUpLink: INTEG(id), detail: st.detail });
  }
  const hooks = await S.settings.get('webhooks', { enabled: false, chatEnabled: false });
  const allHooks = await S.items.list('webhook', {});
  const chat = allHooks.filter((h) => h.type !== 'generic' && h.status === 'ON').length;
  add({ id: 'slack-teams', name: 'Slack / Microsoft Teams', category: 'Messaging and calling', what: 'A short message to a channel when a candidate moves, joins, an interview is booked.', status: !chat ? 'Not set up' : (hooks.chatEnabled ? 'Connected' : 'Switched off'), setUpLink: ATS('chat'), detail: `${chat} channel(s)` });
  // ---- hiring checks
  const V = require('./vendorsZ'); // eslint-disable-line global-require
  for (const [kind, id, name, what] of [['bgv', 'ats-bgv', 'Background verification vendor', 'Order education / employment / address / criminal / identity checks; the result fills the BGV card.'], ['assessment', 'ats-assessment', 'Assessment vendor', 'Send a coding or skills test; the score comes back on the record.']]) {
    const c = await safe(() => V.vendorConfig(kind), { ready: false }); // eslint-disable-line no-await-in-loop
    const n = (await S.items.list('vendor-order', {}, { limit: 20000 })).filter((o) => o.kind === kind).length; // eslint-disable-line no-await-in-loop
    add({ id, name, category: 'Hiring checks', what, status: c.ready ? (n ? 'Connected' : 'Ready') : 'Not set up', needsFounder: !c.ready, setUpLink: INTEG(id), detail: c.ready ? `${c.vendor} · ${n} order(s)` : null });
  }
  const idv = await S.settings.get('idVerify', { sendEnabled: false });
  add({ id: 'idverify', name: 'Candidate identity check (one-time code)', category: 'Hiring checks', what: 'The candidate proves their phone / e-mail with a code.', status: idv.sendEnabled ? 'Connected' : 'Switched off', setUpLink: ATS('idv'), detail: idv.sendEnabled ? 'codes ON' : 'codes OFF' });
  const es = await channelState('esign');
  add({ id: 'esign', name: 'Aadhaar eSign (eMudhra)', category: 'Hiring checks', what: 'Aadhaar eSign of client agreements.', status: es.status, needsFounder: es.status === 'Not set up', setUpLink: INTEG('esign'), detail: es.detail });
  // ---- developers and automation
  const keys = (await S.items.list('api-key', {})).filter((k) => k.status === 'ACTIVE').length;
  add({ id: 'open-api', name: 'Open REST API', category: 'Automation and developers', what: 'Read jobs, candidates and applications, add candidates, with API keys and scopes.', status: keys ? 'Connected' : 'Built in', setUpLink: ATS('api'), detail: `${keys} active key(s) · docs at /api/docs` });
  const gen = allHooks.filter((h) => h.type === 'generic' && h.status === 'ON').length;
  add({ id: 'webhooks', name: 'Webhooks (Zapier, n8n, Make)', category: 'Automation and developers', what: 'Signed JSON to your address when something happens; ready recipes.', status: !gen ? 'Not set up' : (hooks.enabled ? 'Connected' : 'Switched off'), setUpLink: ATS('api'), detail: `${gen} address(es)` });
  // ---- sign-in
  const sso = ((await S.settings.get('sso', { providers: [] })).providers || []);
  const on = sso.filter((p) => p.enabled).length;
  add({ id: 'sso', name: 'Single sign-on (Google, Microsoft Entra, Okta, SAML)', category: 'Sign-in and security', what: 'Staff sign in with the company identity provider.', status: on ? 'Connected' : (sso.length ? 'Switched off' : 'Not set up'), needsFounder: !sso.length, setUpLink: ATS('sso'), detail: sso.length ? `${on} of ${sso.length} on the login page` : null });
  // ---- AI
  const ai = await channelState('ai-fast');
  add({ id: 'ai-fast', name: 'AI (Groq / Gemini / OpenRouter) and speech-to-text', category: 'AI', what: 'Summaries, drafts, matching and call transcripts (contact details are never sent).', status: ai.status === 'Not set up' && (process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY) ? 'Connected' : ai.status, setUpLink: INTEG('ai-fast'), detail: ai.detail });
  // ---- phone app
  const mob = await S.settings.get('mobileAppZ', {});
  add({ id: 'phone-app', name: 'TeamLink on the phone (installable app)', category: 'Phone app', what: 'Install TeamLink from the browser (Add to Home screen) with shortcuts to the ATS screens; store apps need the founder\'s Google Play / Apple developer accounts.', status: mob.androidPackage ? 'Ready' : 'Built in', needsFounder: !mob.androidPackage, setUpLink: '/admin/ats-settings?tab=org', detail: mob.androidPackage ? `Android package ${mob.androidPackage}` : 'installable now; store listing needs founder accounts' });
  const cats = [...new Set(apps.map((a) => a.category))];
  const counts = apps.reduce((o, a) => ({ ...o, [a.status]: (o[a.status] || 0) + 1 }), {});
  return { apps, categories: cats, counts, total: apps.length };
}

const router = express.Router();
router.get('/apps', S.internal, S.wrap(async (req, res) => {
  const out = await catalogue();
  const admin = S.isAdmin(req.user) && !req.viewAs;
  res.json({ ...out, apps: out.apps.map((a) => ({ ...a, setUpLink: admin ? a.setUpLink : null })), canSetUp: admin });
}));

module.exports = { router, catalogue };
