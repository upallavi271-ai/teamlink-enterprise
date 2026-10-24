// ---------------------------------------------------------------------------
// /api/outreach : Omni-Channel Outreach (Phase 1 contacts + Phase 2 channels / templates). Staff only. The server decides who may do
// what (outreach/access.js). Nothing here sends a message to a real person; email stays in TEST MODE until an Admin switches it live.
// Outreach never creates an ATS candidate.
// ---------------------------------------------------------------------------
const express = require('express');
const XLSX = require('xlsx');
const { requireAuth, requireProduct } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const S = require('../outreach/store');
const A = require('../outreach/access');
const C = require('../outreach/consent');
const K = require('../outreach/contacts');
const I = require('../outreach/import');
const G = require('../outreach/segments');
const T = require('../outreach/templates');
const adapters = require('../outreach/adapters');
const Camp = require('../outreach/campaigns');
const Runner = require('../outreach/runner');
const Hook = require('../outreach/webhook');
const MLog = require('../outreach/messageLog');
const Health = require('../outreach/health');
const Quiet = require('../outreach/quiet');
const Sender = require('../outreach/sender');
const CLog = require('../outreach/consentLog');
const Sched = require('../outreach/scheduled');
const Dist = require('../outreach/distribution');

const router = express.Router();
router.use(requireAuth);
router.use(require('./outreachEarly')); // /me and Insights > Credits: before the ATS gate (Finance has no ATS product)
const needAts = requireProduct('ats');
router.use((req, res, next) => (A.kind(req.user) === 'marketing' ? next() : needAts(req, res, next))); // Marketing (given by an Admin) needs no ATS role
router.use((req, res, next) => {
  if (!A.mayUse(req.user)) return res.status(403).json({ error: 'Omni-Channel is for the recruitment team and Admins.' });
  return next();
});
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res, next); } catch (e) { if (e instanceof S.OutreachError) return res.status(e.status).json({ error: e.message, code: e.code }); return next(e); } return undefined; };
const fail = (res, out) => res.status(out.status || 400).json({ error: out.error, code: out.code || undefined, problems: out.problems || undefined, totals: out.totals || undefined, duplicateId: out.duplicateId || undefined });
const send = (res, out) => (out && out.error ? fail(res, out) : res.json(out));
const needTables = wrap(async (req, res, next) => {
  if (await S.ready()) return next();
  return res.status(503).json({ error: 'Omni-Channel is being set up. Please try again in a little while.', setup: true });
});
const needCampaigns = wrap(async (req, res, next) => {
  if (await S.campaignsReady()) return next();
  return res.status(503).json({ error: 'Campaigns are being set up. Please try again in a little while.', setup: true });
});
const limit = (n = 240) => {
  const hits = new Map(); // one counter per route, per login
  return (req, res, next) => {
    const now = Date.now();
    const l = (hits.get(req.user.id) || []).filter((t) => now - t < 60000);
    if (l.length >= n) return res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' });
    l.push(now); hits.set(req.user.id, l);
    return next();
  };
};
const typeOf = (v) => (v === 'internal' ? 'internal' : 'candidate_lead');
const mustAdmin = (req, res) => { if (A.isAdmin(req.user)) return true; res.status(403).json({ error: 'Only an Admin can do this.' }); return false; };

// v3 (2026-10-17): the extra tables / columns of the Green Start rebuild are made here on first use (outreach/v3schema.js), before any route below reads them
router.use(wrap(async (req, res, next) => { await require('../outreach/v3schema').ensure(); next(); })); // eslint-disable-line global-require

// ---- who am I here -----------------------------------------------------------------
router.get('/access', wrap(async (req, res) => {
  const ready = await S.ready();
  const campaignsReady = ready && (await S.campaignsReady());
  const st = ready ? await S.settings() : null;
  return res.json({ ...A.summary(req.user), ready, campaignsReady, internalHrMaySend: !!(st && st.internalHrMaySend), canCampaignInternal: A.kind(req.user) === 'admin' || (A.kind(req.user) === 'hr' && !!(st && st.internalHrMaySend)), industries: ready ? await S.industries() : [], variables: T.VARS.map((v) => ({ name: v, words: T.VAR_WORDS[v] })), sample: T.SAMPLE });
}));
router.get('/industries', needTables, wrap(async (req, res) => res.json({ industries: await S.industries() })));
router.post('/industries', needTables, wrap(async (req, res) => {
  if (!mustAdmin(req, res)) return undefined;
  const out = await S.addIndustry(req.body && req.body.name, req.body && req.body.department, req.user);
  if (!out.error) await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Outreach kind added', entity: 'OutreachIndustry', entityId: S.clip(req.body.name, 40), toValue: S.clip(req.body.name, 40) });
  return send(res, out);
}));

// ---- contacts ------------------------------------------------------------------------
router.get('/contacts', needTables, limit(), wrap(async (req, res) => {
  const q = req.query;
  const arr = (v) => (Array.isArray(v) ? v : (v ? String(v).split('|') : []));
  return res.json(await K.list(req.user, { type: typeOf(q.type), q: q.q, industries: arr(q.industries), cities: arr(q.cities), importIds: arr(q.importIds), channel: q.channel, optin: q.optin, page: q.page, pageSize: q.pageSize }));
}));
router.get('/contacts/export', needTables, wrap(async (req, res) => {
  if (!mustAdmin(req, res)) return undefined;
  const type = typeOf(req.query.type);
  const out = await K.list(req.user, { type, page: 1, pageSize: 100 });
  const rows = [['Name', 'Phone', 'Email', 'Company', 'City', 'Kinds', 'Email permission', 'WhatsApp permission', 'SMS permission']];
  let page = 1; let got = out;
  for (;;) {
    got.contacts.forEach((c) => { const st = (ch) => (c.channels.find((x) => x.channel === ch) || {}).optIn || ''; rows.push([c.name, c.phone, c.email, c.company, c.city, c.industries.join(', '), st('email'), st('whatsapp'), st('sms')]); });
    if (page * got.pageSize >= got.total) break;
    page += 1; got = await K.list(req.user, { type, page, pageSize: 100 }); // eslint-disable-line no-await-in-loop
  }
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Contacts');
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Outreach contacts downloaded', entity: 'OutreachContact', entityId: type, toValue: `${rows.length - 1} contacts` });
  res.set('Content-Disposition', 'attachment; filename="outreach-contacts.xlsx"');
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}));
router.post('/contacts', needTables, limit(60), wrap(async (req, res) => send(res, await K.createManual(req.user, req.body || {}))));
router.get('/contacts/:id', needTables, wrap(async (req, res) => {
  const one = await K.getOne(req.user, req.params.id);
  if (!one) return res.status(404).json({ error: 'This person was not found.' });
  const canSeeHistory = A.kind(req.user) !== 'recruiter';
  return res.json({ contact: one.view, history: canSeeHistory ? await C.history(req.params.id) : [] });
}));
router.put('/contacts/:id/industries', needTables, limit(120), wrap(async (req, res) => send(res, await K.setIndustries(req.user, req.params.id, (req.body || {}).industries))));
router.post('/contacts/:id/opt-out', needTables, limit(120), wrap(async (req, res) => {
  const one = await K.getOne(req.user, req.params.id);
  if (!one) return res.status(404).json({ error: 'This person was not found.' });
  if (!A.mayOptOut(req.user) || !A.mayWrite(req.user, one.row.contactType)) return res.status(403).json({ error: 'You cannot change who is opted out.' });
  const why = S.clip((req.body || {}).reason, 300);
  if (why.length < 5) return res.status(400).json({ error: 'Write in a few words why (for example: "Asked us on the phone to stop").' });
  const out = await C.optOut(req.params.id, (req.body || {}).channel || 'all', { reason: A.isAdmin(req.user) ? 'admin' : 'manual', source: 'screen', evidence: why, by: req.user });
  return send(res, out.error ? out : { ok: out.changed.length ? 'Opted out. They will not get messages on that channel.' : 'They were already opted out.', changed: out.changed });
}));
router.post('/contacts/:id/opt-in', needTables, limit(60), wrap(async (req, res) => {
  if (!A.mayOptIn(req.user)) return res.status(403).json({ error: 'Only an Admin can opt someone in again.' });
  const one = await K.getOne(req.user, req.params.id);
  if (!one) return res.status(404).json({ error: 'This person was not found.' });
  const out = await C.optIn(req.params.id, (req.body || {}).channel || 'all', { reason: (req.body || {}).reason, by: req.user });
  return send(res, out.error ? out : { ok: out.changed.length ? 'Opted in again (the history is kept).' : 'Nothing changed.', changed: out.changed });
}));
router.delete('/contacts/:id', needTables, wrap(async (req, res) => {
  if (!mustAdmin(req, res)) return undefined;
  return send(res, await C.erase(req.params.id, { by: req.user, reason: (req.body || {}).reason || req.query.reason }));
}));

// ---- import --------------------------------------------------------------------------------
const raw = express.raw({ type: () => true, limit: '12mb' });
router.get('/import/template', (req, res) => {
  const csv = req.query.format === 'csv';
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(I.templateRows(typeOf(req.query.type))), 'Contacts');
  res.set('Content-Disposition', `attachment; filename="outreach-contacts-template.${csv ? 'csv' : 'xlsx'}"`);
  res.type(csv ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return res.send(XLSX.write(wb, { type: 'buffer', bookType: csv ? 'csv' : 'xlsx' }));
});
const uploadOpts = (req) => {
  let mapping = null; try { mapping = req.query.mapping ? JSON.parse(req.query.mapping) : null; } catch { mapping = null; }
  const inds = String(req.query.industries || '').split('|').filter(Boolean);
  let resolutions = null; try { resolutions = req.query.resolutions ? JSON.parse(req.query.resolutions) : null; } catch { resolutions = null; }
  return { mapping, contactType: req.query.type, dupMode: req.query.dupMode, industries: inds, permission: req.query.permission, basis: req.query.basis, source: req.query.source, fileName: req.query.filename, confirmOverwrite: req.query.confirmOverwrite, resolutions };
};
router.post('/import/check', needTables, limit(120), raw, wrap(async (req, res) => send(res, await I.check(req.user, Buffer.isBuffer(req.body) ? req.body : null, uploadOpts(req)))));
router.post('/import/save', needTables, limit(40), raw, wrap(async (req, res) => send(res, await I.save(req.user, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), uploadOpts(req)))));
router.get('/imports', needTables, wrap(async (req, res) => res.json({ imports: await I.history(req.user, { type: typeOf(req.query.type) }) })));
// the rows of an import that need a look (or all of them), as a file: no phone, no email in it
router.get('/imports/:id/rows.csv', needTables, wrap(async (req, res) => {
  const out = await I.rowsCsv(req.user, req.params.id, { only: req.query.only === 'all' ? 'all' : 'problems' });
  if (out.error) return fail(res, out);
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Outreach import rows downloaded', entity: 'OutreachImport', entityId: req.params.id, toValue: `${out.count} rows` });
  res.set('Content-Disposition', `attachment; filename="${String(out.fileName).replace(/[^w.-]+/g, '_').slice(0, 60)}-rows-with-problems.csv"`);
  res.type('text/csv; charset=utf-8');
  return res.send(out.csv);
}));
router.post('/imports/:id/undo', needTables, limit(30), wrap(async (req, res) => send(res, await I.undoBatch(req.user, req.params.id))));

// ---- groups (segments) ---------------------------------------------------------------------------
router.get('/segments', needTables, wrap(async (req, res) => res.json({ segments: await G.list(req.user, { type: typeOf(req.query.type) }) })));
router.post('/segments/preview', needTables, wrap(async (req, res) => {
  const type = typeOf((req.body || {}).contactType);
  if (!A.mayRead(req.user, type)) return res.status(403).json({ error: 'You cannot look at this kind of contact.' });
  const rules = require('../outreach/rules').cleanRules((req.body || {}).rules); // eslint-disable-line global-require
  const d = await G.describe({ filterRules: JSON.stringify(rules), contactType: type }, await K.scopeConds(req.user, type));
  return res.json({ counts: d.counts, people: d.people, warning: d.warning });
}));
// a saved group again: live counts + the ten (masked) people. The "Count again" button.
router.get('/segments/:id/preview', needTables, wrap(async (req, res) => {
  const seg = await G.get(req.user, req.params.id);
  if (!seg) return res.status(404).json({ error: 'This group was not found.' });
  const d = await G.describe({ filterRules: JSON.stringify(seg.rules), contactType: seg.contactType }, await K.scopeConds(req.user, seg.contactType));
  return res.json({ counts: d.counts, people: d.people, warning: d.warning });
}));
router.post('/segments', needTables, limit(60), wrap(async (req, res) => send(res, await G.create(req.user, req.body || {}))));
router.put('/segments/:id', needTables, limit(60), wrap(async (req, res) => send(res, await G.update(req.user, req.params.id, req.body || {}))));
router.delete('/segments/:id', needTables, wrap(async (req, res) => send(res, await G.remove(req.user, req.params.id))));

// ---- templates ---------------------------------------------------------------------------------------
router.get('/templates', needTables, wrap(async (req, res) => res.json({ templates: await T.list(req.user, { type: typeOf(req.query.type) }), variables: T.VARS.map((v) => ({ name: v, words: T.VAR_WORDS[v] })) })));
router.post('/templates/preview', needTables, wrap(async (req, res) => {
  const t = T.fromBody(req.body || {});
  return res.json({ problems: T.problems(t), preview: T.preview(t), sample: T.SAMPLE, sender: Sender.shown(await S.settings()), ...T.readiness({ ...t, status: 'active' }) });
}));
router.post('/templates', needTables, limit(60), wrap(async (req, res) => send(res, await T.create(req.user, req.body || {}))));
router.put('/templates/:id', needTables, limit(60), wrap(async (req, res) => send(res, await T.update(req.user, req.params.id, req.body || {}))));
router.delete('/templates/:id', needTables, wrap(async (req, res) => send(res, await T.archive(req.user, req.params.id))));
router.post('/templates/:id/duplicate', needTables, limit(60), wrap(async (req, res) => send(res, await T.duplicate(req.user, req.params.id))));

// ---- campaigns (Phase 3) --------------------------------------------------------------------------------------
router.get('/campaigns', needCampaigns, wrap(async (req, res) => res.json(await Camp.list(req.user, { tab: req.query.tab, kind: req.query.kind, group: req.query.group, status: req.query.status, q: req.query.q, page: req.query.page, pageSize: req.query.pageSize, type: req.query.type === 'internal' ? 'internal' : (req.query.type === 'job_promotion' ? 'job_promotion' : undefined) }))));
router.get('/campaigns/jobs', needCampaigns, wrap(async (req, res) => res.json(await Camp.jobs(req.user, { q: req.query.q }))));
// the review step: "Check before sending" (blocks the Send button when something is wrong)
router.post('/campaigns/check', needCampaigns, limit(120), wrap(async (req, res) => send(res, await Health.checkBeforeSending(req.user, req.body || {}))));
// the message log: every message of the campaigns this login may see (filters: status, campaign, channel, from / to day, q), and the same as a file
const logFilters = (q) => ({ campaignId: q.campaignId, status: q.status, reason: q.reason, channel: q.channel, from: q.from, to: q.to, q: q.q, page: q.page, pageSize: q.pageSize });
router.get('/messages', needCampaigns, limit(), wrap(async (req, res) => res.json(await MLog.list(req.user, logFilters(req.query)))));
router.get('/messages/campaigns', needCampaigns, limit(), wrap(async (req, res) => res.json({ campaigns: await MLog.campaignChoices(req.user, req.query.q) })));
router.get('/messages/export', needCampaigns, limit(20), wrap(async (req, res) => {
  const f = logFilters(req.query);
  const out = await MLog.csv(req.user, f);
  if (out.error) return fail(res, out);
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Outreach message log downloaded', entity: 'OutreachMessage', entityId: 'log', toValue: `${out.count} rows; ${MLog.filterWords(f)}` });
  res.set('Content-Disposition', 'attachment; filename="outreach-message-log.csv"');
  res.type('text/csv; charset=utf-8');
  return res.send(out.csv);
}));
router.post('/campaigns/plan', needCampaigns, limit(120), wrap(async (req, res) => send(res, await Camp.plan(req.user, req.body || {}))));
router.post('/campaigns/test-send', needCampaigns, limit(30), wrap(async (req, res) => send(res, await Camp.testSend(req.user, req.body || {}))));
router.post('/campaigns', needCampaigns, limit(60), wrap(async (req, res) => send(res, await Camp.create(req.user, req.body || {}))));
router.get('/campaigns/:id', needCampaigns, wrap(async (req, res) => send(res, await Camp.get(req.user, req.params.id))));
router.get('/campaigns/:id/messages', needCampaigns, limit(), wrap(async (req, res) => send(res, await Camp.messages(req.user, req.params.id, { status: req.query.status, reason: req.query.reason, q: req.query.q, page: req.query.page, pageSize: req.query.pageSize, channel: req.query.channel, from: req.query.from, to: req.query.to }))));
router.post('/campaigns/:id/send', needCampaigns, limit(30), wrap(async (req, res) => send(res, await Camp.send(req.user, req.params.id, req.body || {}))));
['pause', 'resume', 'stop'].forEach((a) => router.post(`/campaigns/:id/${a}`, needCampaigns, limit(60), wrap(async (req, res) => send(res, await Camp.control(req.user, req.params.id, a)))));
router.delete('/campaigns/:id', needCampaigns, wrap(async (req, res) => send(res, await Camp.removeDraft(req.user, req.params.id))));
// Admin: the sending switch and limits, the webhook address + secret, and a manual "Send now" pass (the loop does the same every 5 seconds)
router.get('/sending', needCampaigns, wrap(async (req, res) => {
  if (!mustAdmin(req, res)) return undefined;
  const st = await S.settings();
  const lease = (await S.q("SELECT holder, expiresAt FROM \"OutreachRunnerLease\" WHERE name = 'sender'"))[0] || null;
  return res.json({ settings: { master: st.master, suppressDays: st.suppressDays, emailPerMinute: st.emailPerMinute, emailDailyCap: st.emailDailyCap, internalHrMaySend: st.internalHrMaySend, emailTestMode: st.emailTestMode, quietHours: st.quietHours }, quietWords: Quiet.describe(st.quietHours),
    webhook: { path: '/api/public/outreach/webhook/email', secret: Hook.secret(), note: 'Sign each request: x-outreach-timestamp (unix seconds) and x-outreach-signature = hex HMAC-SHA256(secret, timestamp + "." + body).' },
    loopHolder: lease && S.ms(lease.expiresAt) > Date.now() ? 'running' : 'idle' });
}));
router.post('/runner/tick', needCampaigns, limit(30), wrap(async (req, res) => {
  if (!mustAdmin(req, res)) return undefined;
  const st = await S.settings();
  if (!st.master) return res.status(400).json({ error: 'Outreach sending is switched OFF. Switch it on first.' });
  const out = await Runner.tick({ maxMessages: 25 });
  return res.json({ ok: true, result: out });
}));

// ---- channels + settings (Admin) -----------------------------------------------------------------------
router.get('/channels', needTables, wrap(async (req, res) => {
  if (!mustAdmin(req, res)) return undefined;
  const st = await S.settings();
  const channels = [];
  for (const a of adapters.all()) channels.push({ channel: a.channel, label: a.label, ...(await a.status()) }); // eslint-disable-line no-await-in-loop
  const log = await S.q('SELECT id, channel, toMasked, status, mode, reason, subject, at FROM "OutreachSendLog" ORDER BY at DESC, id DESC LIMIT 30');
  return res.json({ channels, settings: st, log: log.map((l) => ({ ...l, at: S.iso(l.at) })) });
}));
router.put('/settings', needTables, limit(30), wrap(async (req, res) => {
  if (!mustAdmin(req, res)) return undefined;
  const b = req.body || {};
  const cur = await S.settings();
  const next = { ...cur };
  if (b.emailDailyCap !== undefined) {
    const n = Math.floor(Number(b.emailDailyCap));
    if (!Number.isFinite(n) || n < 0 || n > 100000) return res.status(400).json({ error: 'The daily limit must be a number between 0 and 100000.' });
    next.emailDailyCap = n;
  }
  if (b.suppressDays !== undefined) {
    const n = Math.floor(Number(b.suppressDays));
    if (!Number.isFinite(n) || n < 0 || n > 365) return res.status(400).json({ error: 'The number of days must be between 0 and 365.' });
    next.suppressDays = n;
  }
  if (b.emailPerMinute !== undefined) {
    const n = Math.floor(Number(b.emailPerMinute));
    if (!Number.isFinite(n) || n < 1 || n > 600) return res.status(400).json({ error: 'Emails per minute must be between 1 and 600.' });
    next.emailPerMinute = n;
  }
  if (b.internalHrMaySend !== undefined) next.internalHrMaySend = b.internalHrMaySend === true;
  if (b.master !== undefined) next.master = b.master === true;
  if (b.fromName !== undefined) next.fromName = S.clip(b.fromName, 80);
  if (b.replyTo !== undefined) { const r = S.clip(b.replyTo, 160); if (r && !require('../utils/messagingCore').validEmail(r)) return res.status(400).json({ error: 'The reply-to address is not a valid email.' }); next.replyTo = r; } // eslint-disable-line global-require
  if (b.emailTestMode !== undefined) {
    const wantTest = b.emailTestMode !== false;
    if (!wantTest && cur.emailTestMode) {
      if (b.confirmLive !== true) return res.status(400).json({ error: 'To send real emails, tick "I understand real people will get emails".', code: 'CONFIRM_LIVE' });
      const st = await adapters.get('email').status();
      if (!st.ready) return res.status(400).json({ error: `Email is not ready: ${st.reason}` });
    }
    next.emailTestMode = wantTest;
  }
  if (b.quietHours !== undefined) { const v = Quiet.validate(b.quietHours, cur.quietHours); if (v.error) return res.status(400).json({ error: v.error }); next.quietHours = v.value; }
  const sv = Sender.validate(b);
  if (sv.error) return res.status(400).json({ error: sv.error });
  ['fromEmail', 'whatsappNumber', 'smsSenderId', 'smsDltEntityId'].forEach((k) => { if (sv.value[k] !== undefined) next[k] = sv.value[k]; });
  await S.saveSettings(next, req.user);
  if (JSON.stringify(next.quietHours) !== JSON.stringify(cur.quietHours)) await logAudit({ userId: req.user.id, actorName: req.user.name, action: next.quietHours.enabled ? 'Outreach quiet hours ON' : 'Outreach quiet hours OFF', entity: 'OutreachSettings', entityId: 'quiet', toValue: `${next.quietHours.start} to ${next.quietHours.end} India time; staff messages ${next.quietHours.applyInternal ? 'held too' : 'not held'}` });
  const senderChanged = ['fromEmail', 'whatsappNumber', 'smsSenderId', 'smsDltEntityId', 'fromName', 'replyTo'].filter((k) => String(next[k] || '') !== String(cur[k] || ''));
  if (senderChanged.length) await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Outreach sender details changed', entity: 'OutreachSettings', entityId: 'sender', toValue: `changed: ${senderChanged.join(', ')}` });
  if (next.emailTestMode !== cur.emailTestMode) await logAudit({ userId: req.user.id, actorName: req.user.name, action: next.emailTestMode ? 'Outreach email: test mode switched ON' : 'Outreach email: test mode switched OFF (real sending allowed)', entity: 'OutreachSettings', entityId: 'email', toValue: next.emailTestMode ? 'test mode' : 'live' });
  else await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Outreach settings changed', entity: 'OutreachSettings', entityId: 'email', toValue: `daily limit ${next.emailDailyCap}; per minute ${next.emailPerMinute}; same-job days ${next.suppressDays}; sending ${next.master ? 'ON' : 'OFF'}; internal HR may send ${next.internalHrMaySend ? 'yes' : 'no'}` });
  if (next.master !== cur.master) await logAudit({ userId: req.user.id, actorName: req.user.name, action: next.master ? 'Outreach sending switched ON' : 'Outreach sending switched OFF', entity: 'OutreachSettings', entityId: 'master', toValue: next.master ? 'on' : 'off' });
  return res.json({ ok: 'Saved.', settings: await S.settings() });
}));

// ---- Phase "layout": Distribution, Settings (consent log, roles, sender details), Internal scheduled messages -----------------------------------
router.get('/distribution', limit(60), wrap(async (req, res) => send(res, await Dist.summary(req.user, { q: req.query.q }))));
router.get('/sender-details', needTables, wrap(async (req, res) => { if (!mustAdmin(req, res)) return undefined; const st = await S.settings(); return res.json({ details: Sender.shown(st), quietHours: st.quietHours, quietWords: Quiet.describe(st.quietHours), suppressDays: st.suppressDays, sample: T.SAMPLE }); }));
router.get('/roles', wrap(async (req, res) => { if (!mustAdmin(req, res)) return undefined; return res.json(A.rolesTable()); }));
router.get('/consent-log', needTables, limit(120), wrap(async (req, res) => send(res, await CLog.list(req.user, req.query))));
router.get('/consent-log/export', needTables, limit(20), wrap(async (req, res) => {
  const out = await CLog.csv(req.user, req.query);
  if (out.error) return fail(res, out);
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Outreach consent log downloaded', entity: 'OutreachConsentEvent', entityId: 'log', toValue: `${out.count} rows; ${CLog.filterWords(req.query)}` });
  res.set('Content-Disposition', 'attachment; filename="outreach-consent-log.csv"');
  res.type('text/csv; charset=utf-8');
  return res.send(out.csv);
}));
router.get('/scheduled', wrap(async (req, res) => send(res, await Sched.list(req.user))));
router.get('/scheduled/options', wrap(async (req, res) => send(res, await Sched.options(req.user))));
router.post('/scheduled', limit(60), wrap(async (req, res) => send(res, await Sched.create(req.user, req.body || {}))));
router.put('/scheduled/:id', limit(60), wrap(async (req, res) => send(res, await Sched.update(req.user, req.params.id, req.body || {}))));
router.post('/scheduled/:id/on', limit(60), wrap(async (req, res) => send(res, await Sched.toggle(req.user, req.params.id, true))));
router.post('/scheduled/:id/off', limit(60), wrap(async (req, res) => send(res, await Sched.toggle(req.user, req.params.id, false))));
router.post('/scheduled/:id/test-to-me', limit(30), wrap(async (req, res) => send(res, await Sched.testToMe(req.user, req.params.id))));
router.get('/scheduled/:id/runs', wrap(async (req, res) => send(res, await Sched.runs(req.user, req.params.id))));
router.delete('/scheduled/:id', wrap(async (req, res) => send(res, await Sched.remove(req.user, req.params.id))));

// v2 (2026-10-17): /me, credits + activity, template hub, connections (routes/outreachV2.js)
router.use(require('./outreachV2'));

// v3 (2026-10-17): one route file per area of the Green Start rebuild, each mounted at /api/outreach/gs/<area>. A file that is missing or broken only loses its
// own area (it is logged); it can never take the rest of the API down.
['overview', 'campaigns', 'console', 'inbox', 'analytics', 'templates', 'studio', 'crm', 'automation', 'bots', 'admin', 'external', 'library'].forEach((area) => {
  const file = `./omniGs${area.charAt(0).toUpperCase()}${area.slice(1)}`;
  try { router.use(`/gs/${area}`, require(file)); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND' || !String(e.message).includes(file.slice(2))) console.error(`[omni-gs] ${area} routes not loaded:`, e.message); } // eslint-disable-line global-require, no-console
});

module.exports = router;
