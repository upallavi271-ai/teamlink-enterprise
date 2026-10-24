// ---------------------------------------------------------------------------
// OMNI-CHANNEL OUTREACH, QUICK WINS: acceptance test. SANDBOX ONLY (API 4011, prisma/sandbox.db). Nothing is ever really sent: Email stays in
// TEST MODE (rehearsals); the one live-mode scenario uses a MOCK sender that refuses every message.
//   node scripts/outreach-p3-apply-sandbox.js ; node scripts/outreach-quickwins-apply-sandbox.js      (once: the tables, sandbox only)
//   TL_API=http://localhost:4011 node scripts/outreach-quickwins-test.js
// Covers T1 message log (filters, paging, CSV, masking, audit), T2 stop reasons + "Check before sending" + bell notices,
// T4 smarter import (email-or-phone match, conflicts, update modes, tags, per-row problem file, opt-out never overridden),
// T5 live group counts (per channel == direct SQL), empty-rule safeguard, the ten-people preview, and the role gates.
// Tag "ZZTEST OQ": every row made here is removed at the end (the real dev.db is never opened).
// ---------------------------------------------------------------------------
/* eslint-disable no-console, no-await-in-loop */
const path = require('path');
if (!process.env.TL_API) process.env.TL_API = 'http://localhost:4011';
const Z = require('./lib/zzfix')('OQ');
const { BACK, prisma, API } = Z;
const S = require(path.join(BACK, 'src/outreach/store'));
const Camp = require(path.join(BACK, 'src/outreach/campaigns'));
const Run = require(path.join(BACK, 'src/outreach/runner'));
const Health = require(path.join(BACK, 'src/outreach/health'));
const email = require(path.join(BACK, 'src/outreach/adapters/email'));
const O = '/api/outreach';
const RUN = Z.RUN;
const RUNNUM = parseInt(RUN, 36) % 90000;
const em = (k) => `zz-oq-${RUN}-${k}@example.test`;
let phN = 0;
const PHBASE = 9000000000 + (RUNNUM % 9000) * 100000;
const nextPhone = () => { phN += 1; return String(PHBASE + phN); };
const istDay = (t = Date.now()) => new Date(t + 5.5 * 3600000).toISOString().slice(0, 10);
const csvOf = (rows) => Buffer.from(rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\n'));
const created = { contactIds: [], hashes: [], campaignIds: [], segIds: [], tplIds: [] };

(async () => {
  console.log('preclean', JSON.stringify(await Z.preclean()));
  const settingsBefore = await prisma.appSetting.findUnique({ where: { key: 'outreach.settings' } });
  const wipe = async () => {
    const camps = (await S.q('SELECT id FROM "OutreachCampaign" WHERE name LIKE \'ZZTEST OQ%\'')).map((r) => r.id);
    for (const id of camps) { await S.run('DELETE FROM "OutreachEvent" WHERE campaignId = ?', id); await S.run('DELETE FROM "OutreachMessage" WHERE campaignId = ?', id); await S.run('DELETE FROM "OutreachCampaignNote" WHERE campaignId = ?', id); }
    await S.run('DELETE FROM "OutreachCampaign" WHERE name LIKE \'ZZTEST OQ%\'');
    const imps = (await S.q('SELECT id FROM "OutreachImport" WHERE fileName LIKE \'ZZTEST OQ%\' OR source LIKE \'ZZTEST OQ%\'')).map((r) => r.id);
    for (const id of imps) { await S.run('DELETE FROM "OutreachImportRow" WHERE importId = ?', id); }
    const cs = (await S.q('SELECT id, email, phoneE164 FROM "OutreachContact" WHERE name LIKE \'ZZTEST OQ%\' OR source LIKE \'ZZTEST OQ%\' OR importId LIKE \'ZZOQ-%\'')).map((r) => r);
    for (const c of cs) {
      await S.run('DELETE FROM "OutreachContactChannel" WHERE contactId = ?', c.id); await S.run('DELETE FROM "OutreachContactTag" WHERE contactId = ?', c.id);
      await S.run('DELETE FROM "OutreachConsentEvent" WHERE contactId = ?', c.id); await S.run('DELETE FROM "OutreachSendLog" WHERE contactId = ?', c.id); await S.run('DELETE FROM "OutreachEvent" WHERE contactId = ?', c.id);
      if (c.email) { const h = S.hashAddress('email', c.email); await S.run('DELETE FROM "OutreachSuppression" WHERE addressHash = ?', h); await S.run('DELETE FROM "OutreachConsentEvent" WHERE addressHash = ?', h); }
      if (c.phoneE164) { const h = S.hashAddress('phone', c.phoneE164); await S.run('DELETE FROM "OutreachSuppression" WHERE addressHash = ?', h); await S.run('DELETE FROM "OutreachConsentEvent" WHERE addressHash = ?', h); }
    }
    await S.run('DELETE FROM "OutreachContact" WHERE name LIKE \'ZZTEST OQ%\' OR source LIKE \'ZZTEST OQ%\' OR importId LIKE \'ZZOQ-%\' OR importId IN (SELECT id FROM "OutreachImport" WHERE fileName LIKE \'ZZTEST OQ%\')');
    for (const id of imps) await S.run('DELETE FROM "OutreachImport" WHERE id = ?', id);
    for (const h of created.hashes) { await S.run('DELETE FROM "OutreachSuppression" WHERE addressHash = ?', h); await S.run('DELETE FROM "OutreachConsentEvent" WHERE addressHash = ?', h); }
    await S.run('DELETE FROM "OutreachSegment" WHERE name LIKE \'ZZTEST OQ%\'');
    await S.run('DELETE FROM "OutreachTemplate" WHERE name LIKE \'ZZTEST OQ%\'');
    await S.run('DELETE FROM "OutreachSendLog" WHERE subject LIKE \'%ZZTEST OQ%\'');
    await S.run('DELETE FROM "OutreachRunnerLease" WHERE holder LIKE \'zzoq-%\'');
    // the older Phase 1-3 test scripts do not know the quick-wins tables: sweep rows whose campaign / import is already gone
    await S.run('DELETE FROM "OutreachCampaignNote" WHERE campaignId NOT IN (SELECT id FROM "OutreachCampaign")');
    await S.run('DELETE FROM "OutreachImportRow" WHERE importId NOT IN (SELECT id FROM "OutreachImport")');
  };
  await wipe();
  Z.check('Phase 3 and quick-wins tables exist in the sandbox', (await S.campaignsReady()) && (await S.quickReady()), 'run: node scripts/outreach-p3-apply-sandbox.js ; node scripts/outreach-quickwins-apply-sandbox.js');
  if (!((await S.campaignsReady()) && (await S.quickReady()))) { await Z.finish(); return; }

  // ----------------------------------------------------------------- people + a job
  const admin = await Z.mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
  const admin2 = await Z.mkUser('admin2', { role: 'ADMIN', atsRole: 'ADMIN' });
  const mgr = await Z.mkUser('mgr', { role: 'MANAGER', atsRole: 'MANAGER' });
  const tl = await Z.mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'TL' });
  const bde = await Z.mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, {});
  const rec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, {});
  const rec2 = await Z.mkUser('rec2', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }, {});
  const hr = await Z.mkUser('hr', { role: 'HR', atsRole: 'HR', hrmsRole: 'HR' }, {});
  const acct = await Z.mkUser('acct', { role: 'EMPLOYEE', atsRole: 'ACCOUNTANT', accountsRole: 'ACCOUNTANT' }, {});
  const tok = {};
  for (const [k, u] of Object.entries({ admin, admin2, mgr, tl, bde, rec, rec2, hr, acct })) tok[k] = await Z.mint(u);
  const api = (who, method, p, body) => Z.call(method, `${O}${p}`, tok[who], body);
  const rawCall = async (who, p, buf, query) => {
    let r;
    for (let i = 0; i < 60; i += 1) { try { r = await fetch(`${API}${O}${p}?${new URLSearchParams(query).toString()}`, { method: 'POST', headers: { Authorization: `Bearer ${tok[who]}`, 'Content-Type': 'application/octet-stream', 'X-Forwarded-For': `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }, body: buf }); break; } catch (e) { await new Promise((x) => setTimeout(x, 3000)); } }
    let body = null; try { body = await r.json(); } catch { /* no json */ }
    return { status: r.status, body };
  };
  const client = await prisma.client.create({ data: { name: `ZZTEST OQ Client ${RUN}`, location: 'ZZ Town', ownerDepartment: 'Education', clientType: 'Client', contactName: 'ZZ Contact', contactEmail: em('client'), agreementStatus: 'ACTIVE' } });
  Z.made.clients.push(client.id);
  const mkJob = async (tag, extra = {}) => { const r = await prisma.requirement.create({ data: { title: `ZZTEST OQ Job ${tag} ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Education', openings: 2, portalPublished: true, ...extra } }); Z.made.reqs.push(r.id); return r; };
  const JA = await mkJob('A', { bdeId: bde.id, tlId: tl.id, recruiterId: rec.id });
  const JNoPortal = await mkJob('NoPortal', { bdeId: bde.id, tlId: tl.id, portalPublished: false });

  // ----------------------------------------------------------------- helpers: contacts, groups, templates, campaigns
  const mkContact = async (n, o = {}) => {
    const id = S.newId('oc'); const now = Date.now();
    const mail = o.email === undefined ? em(n) : o.email; const ph = o.phone === undefined ? nextPhone() : o.phone;
    const mailKey = mail && /@/.test(mail) ? mail.toLowerCase() : null;
    const name = o.name === undefined ? `ZZTEST OQ Person ${n}` : o.name;
    await S.run(`INSERT INTO "OutreachContact" (id, contactType, name, phoneE164, email, phoneKey, emailKey, city, source, importId, status, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?)`,
      id, o.type || 'candidate_lead', name, ph ? `91${ph}` : null, mail || null, ph || null, mailKey, 'Hyderabad', 'ZZTEST OQ source', o.importId || 'ZZOQ-LOG', o.createdBy || admin.id, 'ZZTEST OQ', now - (o.age || 0), now);
    const chan = async (channel, address, optIn, health) => S.run('INSERT INTO "OutreachContactChannel" (id, contactId, channel, address, optIn, optInAt, health) VALUES (?,?,?,?,?,?,?)', S.newId('occ'), id, channel, address, optIn, now, health || 'ok');
    if (mail !== null) await chan('email', mail, o.optIn || 'opted_in', o.health);
    if (ph) { await chan('whatsapp', `91${ph}`, o.wa || 'opted_in', 'ok'); await chan('sms', `91${ph}`, o.sms || 'opted_in', o.smsHealth || 'ok'); }
    created.contactIds.push(id);
    if (mail) created.hashes.push(S.hashAddress('email', mail));
    if (ph) created.hashes.push(S.hashAddress('phone', `91${ph}`));
    return id;
  };
  const mkSeg = async (name, rules, who = 'admin', type = 'candidate_lead') => { const r = await api(who, 'POST', '/segments', { name: `ZZTEST OQ ${name}`, contactType: type, rules }); if (r.status !== 200) throw new Error(`segment ${name}: ${JSON.stringify(r.body)}`); created.segIds.push(r.body.segment.id); return r.body.segment.id; };
  const mkTpl = async (name, body, subject = 'ZZTEST OQ {{job_title}}') => { const r = await api('admin', 'POST', '/templates', { name: `ZZTEST OQ ${name}`, channel: 'email', audience: 'candidate_lead', subject, body, promotional: true }); if (r.status !== 200) throw new Error(`template ${name}: ${JSON.stringify(r.body)}`); created.tplIds.push(r.body.template.id); return r.body.template.id; };
  const tplJob = await mkTpl('Job email', 'Hi {{name}}, {{company}} has a job for you: {{job_title}}.\nApply here: {{apply_link}}\nStop these emails: {{unsubscribe}}');
  const settings0 = await S.settings();
  const setS = async (patch) => S.saveSettings({ ...(await S.settings()), ...patch });
  await setS({ master: true, emailTestMode: true, emailPerMinute: 600, emailDailyCap: 100000, suppressDays: 7, internalHrMaySend: false });
  const newCamp = async (who, name, job, segs, tpl) => { const r = await api(who, 'POST', '/campaigns', { name: `ZZTEST OQ ${name}`, type: 'job_promotion', requirementId: job, segmentIds: segs, templateId: tpl || tplJob, channel: 'email' }); if (r.status !== 200) throw new Error(`campaign ${name}: ${r.status} ${JSON.stringify(r.body)}`); created.campaignIds.push(r.body.id); return r.body.id; };
  const sendCamp = async (who, id, b) => { const r = await api(who, 'POST', `/campaigns/${id}/send`, b || { when: 'now' }); if (r.status !== 200) throw new Error(`send ${id}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const bellsFor = (uid, part) => prisma.notification.findMany({ where: { userId: uid, title: { contains: part } } });

  // ================================================================= T1. THE MESSAGE LOG
  const LOGN = 121;
  for (let i = 1; i <= LOGN; i += 1) await mkContact(`log${i}`, i === 1 ? { name: '=HYPERLINK("http://evil.example/x","click")' } : {});
  for (let i = 1; i <= 3; i += 1) await mkContact(`logOut${i}`, { optIn: 'opted_out' });
  for (let i = 1; i <= 2; i += 1) await mkContact(`logNoPerm${i}`, { optIn: 'unknown' });
  const segLog = await mkSeg('Log group', { importIds: ['ZZOQ-LOG'] });
  const campLog = await newCamp('admin', 'Log campaign', JA.id, [segLog]);
  const sentLog = await sendCamp('admin', campLog);
  Z.check('T1 setup: a 126-person rehearsal campaign: 121 queued, 5 skipped', sentLog.queued === LOGN && sentLog.skipped === 5 && sentLog.mode === 'rehearsal', sentLog);
  const t1 = await Run.tick({ maxMessages: 500 });
  const logState = (await S.q('SELECT status, COUNT(*) n FROM "OutreachMessage" WHERE campaignId = ? GROUP BY status', campLog)).reduce((a, r) => ({ ...a, [r.status]: S.num(r.n) }), {});
  Z.check('T1 setup: the worker rehearsed all 121 (nothing really sent) and the campaign is done', logState.test_captured === LOGN && logState.skipped === 5 && (await S.q('SELECT status FROM "OutreachCampaign" WHERE id = ?', campLog))[0].status === 'done', [t1, logState]);

  const day = istDay();
  const p1 = await api('admin', 'GET', `/messages?campaignId=${campLog}&pageSize=50&page=1`);
  const p2 = await api('admin', 'GET', `/messages?campaignId=${campLog}&pageSize=50&page=2`);
  const p3 = await api('admin', 'GET', `/messages?campaignId=${campLog}&pageSize=50&page=3`);
  const allIds = [...p1.body.messages, ...p2.body.messages, ...p3.body.messages].map((m) => m.id);
  Z.check('T1a: a 126-row campaign pages correctly (50 + 50 + 26, no row twice, total 126)', p1.body.total === 126 && p1.body.messages.length === 50 && p2.body.messages.length === 50 && p3.body.messages.length === 26 && new Set(allIds).size === 126, [p1.body.total, p1.body.messages.length, p2.body.messages.length, p3.body.messages.length]);
  const direct = await Camp.countsFor([campLog]);
  const f = p1.body.facets;
  Z.check('T1c: the number next to each status button equals the campaign totals', f.rehearsed === direct[campLog].sent && f.skipped === direct[campLog].skipped && Object.values(f).reduce((a, b) => a + b, 0) === 126, [f, direct[campLog]]);
  const sk = await api('admin', 'GET', `/messages?campaignId=${campLog}&status=skipped`);
  Z.check('T1f: skipped rows show the plain reason (Opted out, No permission ...)', sk.body.total === 5 && sk.body.messages.every((m) => m.reasonWords && m.statusKey === 'skipped') && sk.body.messages.some((m) => /opted out/i.test(m.reasonWords)) && sk.body.messages.some((m) => /permission/i.test(m.reasonWords)), sk.body.messages[0]);
  const rh = await api('admin', 'GET', `/messages?campaignId=${campLog}&status=rehearsed&pageSize=200`);
  Z.check('T1: the Rehearsed filter gives the 121 rehearsed rows, none skipped', rh.body.total === LOGN && rh.body.messages.every((m) => m.status === 'test_captured'));
  const byName = await api('admin', 'GET', `/messages?campaignId=${campLog}&q=${encodeURIComponent('Person log77')}`);
  Z.check('T1b: search by name finds the one person', byName.body.total === 1 && /log77/.test(byName.body.messages[0].name), byName.body.total);
  const byMailAdmin = await api('admin', 'GET', `/messages?campaignId=${campLog}&q=${encodeURIComponent(em('log77'))}`);
  const byMailBde = await api('bde', 'GET', `/messages?campaignId=${campLog}&q=${encodeURIComponent(em('log77'))}`);
  Z.check('T1b: an Admin can search by email; a masked role (BDE) cannot find a person by the hidden email', byMailAdmin.body.total === 1 && byMailBde.body.total === 0, [byMailAdmin.body.total, byMailBde.body.total]);
  const bdeList = await api('bde', 'GET', `/messages?campaignId=${campLog}&pageSize=200`);
  Z.check('T1e: a BDE sees masked contacts (no clear email) and the masked flag', bdeList.status === 200 && bdeList.body.masked === true && bdeList.body.total === 126 && bdeList.body.messages.every((m) => !m.email || (/•/.test(m.email) && !/zz-oq/.test(m.email))), bdeList.body.messages[0]);
  const adminList = await api('admin', 'GET', `/messages?campaignId=${campLog}&pageSize=200`);
  Z.check('T1e: an Admin sees full contacts', adminList.body.masked === false && adminList.body.messages.some((m) => m.email === em('log5')));
  const chWa = await api('admin', 'GET', `/messages?campaignId=${campLog}&channel=whatsapp`);
  const chEm = await api('admin', 'GET', `/messages?campaignId=${campLog}&channel=email`);
  Z.check('T1: channel filter (email 126, WhatsApp 0)', chEm.body.total === 126 && chWa.body.total === 0);
  const dToday = await api('admin', 'GET', `/messages?campaignId=${campLog}&from=${day}&to=${day}`);
  const dFuture = await api('admin', 'GET', `/messages?campaignId=${campLog}&from=${istDay(Date.now() + 3 * 86400000)}`);
  const dPast = await api('admin', 'GET', `/messages?campaignId=${campLog}&to=${istDay(Date.now() - 3 * 86400000)}`);
  const dBad = await api('admin', 'GET', `/messages?campaignId=${campLog}&from=garbage`);
  Z.check('T1: date range (today = 126, from three days ahead = 0, up to three days ago = 0, a bad date is ignored)', dToday.body.total === 126 && dFuture.body.total === 0 && dPast.body.total === 0 && dBad.body.total === 126, [dToday.body.total, dFuture.body.total, dPast.body.total, dBad.body.total]);
  const global = await api('admin', 'GET', `/messages?pageSize=5`);
  const perCamp = await api('admin', 'GET', `/campaigns/${campLog}/messages?pageSize=5`);
  Z.check('T1: the global log includes this campaign; the per-campaign route gives the same 126 rows', global.body.total >= 126 && perCamp.body.total === 126 && perCamp.body.messages[0].reasonWords !== undefined);
  const choices = await api('admin', 'GET', '/messages/campaigns?q=Log%20campaign');
  Z.check('T1: the campaign picker lists the campaign with its message count', choices.body.campaigns.some((c) => c.id === campLog && c.messages === 126), choices.body);
  const rec2List = await api('rec2', 'GET', `/messages?campaignId=${campLog}`);
  const recList = await api('rec', 'GET', `/messages?campaignId=${campLog}`);
  const acctList = await api('acct', 'GET', '/messages');
  Z.check('T1: a login outside the job area sees nothing; a recruiter on the job sees it (masked); an accountant is refused', rec2List.status === 200 && rec2List.body.total === 0 && recList.body.total === 126 && recList.body.masked === true && acctList.status === 403, [rec2List.body.total, recList.body.total, acctList.status]);

  const csvAdmin = await api('admin', 'GET', `/messages/export?campaignId=${campLog}`);
  const csvLines = csvAdmin.text.replace(/^﻿/, '').split('\r\n').filter(Boolean);
  Z.check('T1: Admin downloads the log as CSV (126 rows + header, UTF-8 file)', csvAdmin.status === 200 && /text\/csv/.test(csvAdmin.headers.get('content-type')) && csvLines.length === 127 && /^"Person"/.test(csvLines[0]), [csvAdmin.status, csvLines.length]);
  Z.check("T1d: a name that starts with '=' is neutralised in the CSV (leading apostrophe, never a formula)", csvAdmin.text.includes('"\'=HYPERLINK(') && !/(^|,)"[=@]/m.test(csvAdmin.text.replace(/^﻿/, '')), csvLines.find((l) => /HYPERLINK/.test(l)));
  const csvSk = await api('admin', 'GET', `/messages/export?campaignId=${campLog}&status=skipped`);
  Z.check('T1: the CSV follows the same filters (skipped only = 5 rows)', csvSk.text.split('\r\n').filter(Boolean).length === 6);
  const csvMgr = await api('mgr', 'GET', `/messages/export?campaignId=${campLog}&status=skipped`);
  Z.check('T1: a Manager (view + export) may download', csvMgr.status === 200 && /@example\.test/.test(csvMgr.text));
  const noExp = await Promise.all(['bde', 'rec', 'tl', 'hr', 'acct', 'rec2'].map((w) => api(w, 'GET', `/messages/export?campaignId=${campLog}`)));
  Z.check('T1e: BDE, recruiter, TL, HR desk, accountant cannot download (403)', noExp.every((r) => r.status === 403), noExp.map((r) => r.status));
  const accs = {}; for (const k of ['admin', 'mgr', 'bde', 'rec', 'tl', 'hr']) accs[k] = (await api(k, 'GET', '/access')).body.canExportLog;
  Z.check('T1: the access summary tells the screen who may download', accs.admin === true && accs.mgr === true && !accs.bde && !accs.rec && !accs.tl && !accs.hr, accs);
  const aud = await prisma.auditLog.findMany({ where: { userId: { in: [admin.id, mgr.id] }, action: 'Outreach message log downloaded' } });
  Z.check('T1: every download is audited (who, how many rows, which filters) and holds no phone or email', aud.length === 3 && aud.every((a) => /rows/.test(a.toValue || '') && !/@|zz-oq/i.test(`${a.toValue} ${a.actorName}`.replace(/ZZTEST OQ/g, ''))), aud.map((a) => a.toValue));

  // ================================================================= T2. BELL: finished (the log campaign finished on the tick above)
  const bellFin = await bellsFor(admin.id, 'finished');
  const note1 = await S.q('SELECT * FROM "OutreachCampaignNote" WHERE campaignId = ? AND kind = \'finished\'', campLog);
  Z.check('T2: when the campaign finished, its creator got ONE bell notice with the counts (no phone, no email)', bellFin.length === 1 && /121 rehearsed/.test(bellFin[0].message) && !/@/.test(bellFin[0].message) && note1.length === 1, [bellFin.length, bellFin[0] && bellFin[0].message]);
  Z.check('T2: a test login is never picked up as an Admin to notify (admin2 got nothing)', (await bellsFor(admin2.id, 'ZZTEST OQ')).length === 0);
  await Run.tick({ maxMessages: 50 }); await Run.tick({ maxMessages: 50 });
  Z.check('T2c: repeat ticks make no duplicate notice (one bell row, one note)', (await bellsFor(admin.id, 'finished')).length === 1 && S.num((await S.q('SELECT COUNT(*) n FROM "OutreachCampaignNote" WHERE campaignId = ?', campLog))[0].n) === 1);
  const finHealth = (await api('admin', 'GET', `/campaigns/${campLog}`)).body;
  Z.check('T2: a finished campaign shows no stop banner', finHealth.health.primary === null || finHealth.health.primary.level === 'info', finHealth.health);

  // ================================================================= T2. STOP REASONS (each cause)
  const segS = await mkSeg('Stop group', { importIds: ['ZZOQ-STOP'] });
  for (let i = 1; i <= 4; i += 1) await mkContact(`stop${i}`, { importId: 'ZZOQ-STOP' });
  const campS = await newCamp('admin', 'Stop reasons', JA.id, [segS]);
  await sendCamp('admin', campS);
  const hp = async (id) => (await api('admin', 'GET', `/campaigns/${id}`)).body.health;
  const codes = (h) => h.reasons.map((r) => r.code);
  let h = await hp(campS);
  Z.check('T2: a running rehearsal with the switch on and test mode on has no stopper', !codes(h).includes('sending_off') && !codes(h).includes('daily_cap') && !codes(h).includes('test_mode_hold'), h);
  await setS({ master: false }); h = await hp(campS);
  const lst = (await api('admin', 'GET', '/campaigns?type=job_promotion&pageSize=100')).body.campaigns.find((c) => c.id === campS);
  Z.check('T2: switch OFF -> "Outreach sending is switched OFF" with the Admin fix, on the campaign AND in the list', h.primary.code === 'sending_off' && h.primary.level === 'stop' && /Admin/.test(h.primary.fix.text) && lst.health.primary.code === 'sending_off', [h.primary, lst.health.primary]);
  await setS({ master: true });
  await S.run('UPDATE "OutreachCampaign" SET mode = \'live\' WHERE id = ?', campS); h = await hp(campS);
  Z.check('T2: a live campaign while Email is in test mode -> held, says what to do', codes(h).includes('test_mode_hold') && /test mode/i.test(h.reasons.find((r) => r.code === 'test_mode_hold').words), codes(h));
  await S.run('UPDATE "OutreachCampaign" SET mode = \'rehearsal\' WHERE id = ?', campS);
  const usedToday = await email.sentToday('test');
  await setS({ emailDailyCap: usedToday }); h = await hp(campS);
  const capR = h.reasons.find((r) => r.code === 'daily_cap');
  Z.check('T2: daily cap reached -> "daily limit is reached", how many are waiting, goes on tomorrow', !!capR && capR.level === 'wait' && /4 people are waiting/.test(capR.words) && /tomorrow|midnight/i.test(capR.words), capR);
  await setS({ emailDailyCap: 100000 });
  const synthRow = { status: 'running', mode: 'live', lastError: null };
  const synth = Health.holdReasons(synthRow, { waiting: 5, sent: 0, failed: 0, cancelled: 0, skipped: 0 }, { st: { master: true, emailTestMode: false, emailDailyCap: 100 }, adapter: { ready: false, reason: 'No mail server is set up.' }, sentLive: 0, sentTest: 0, secretOk: false });
  Z.check('T2: mail not set up and a missing webhook secret are reported with the Admin fix', synth.some((r) => r.code === 'mail_not_set_up' && /Integrations/.test(r.fix.text)) && synth.some((r) => r.code === 'webhook_secret'), synth.map((r) => r.code));
  const synthPrep = Health.holdReasons({ status: 'preparing', mode: 'rehearsal', lastError: 'boom' }, { waiting: 0 }, { st: { master: true }, adapter: { ready: true }, sentLive: 0, sentTest: 0, secretOk: true });
  const synthFail = Health.holdReasons({ status: 'done', mode: 'live' }, { waiting: 0, sent: 0, failed: 9, cancelled: 0, skipped: 0 }, { st: { master: true } });
  Z.check('T2: a send that could not be prepared, and a finished campaign where nothing could be sent, are explained', synthPrep.some((r) => r.code === 'prepare_failed') && synthFail.some((r) => r.code === 'all_failed' && r.level === 'stop'), [synthPrep.map((r) => r.code), synthFail.map((r) => r.code)]);

  // pause by someone else -> the creator gets the bell; the person who paused does not
  const pz = await api('bde', 'POST', `/campaigns/${campS}/pause`, {});
  h = await hp(campS);
  Z.check('T2: Paused -> banner "Paused", fix "Press Resume"; the creator got a bell notice, the person who paused did not', pz.status === 200 && h.primary.code === 'paused' && h.primary.fix.action === 'resume' && (await bellsFor(admin.id, 'paused')).length === 1 && (await bellsFor(bde.id, 'paused')).length === 0, [pz.status, h.primary]);
  await api('bde', 'POST', `/campaigns/${campS}/resume`, {});
  const st1 = await api('bde', 'POST', `/campaigns/${campS}/stop`, {});
  h = await hp(campS);
  const st2 = await api('bde', 'POST', `/campaigns/${campS}/stop`, {});
  Z.check('T2: Stopped -> banner "Stopped by ... 4 people did not get the message", ONE bell notice, a second stop is refused with no second notice', st1.status === 200 && h.primary.code === 'stopped' && /4 people did not get/.test(h.primary.words) && st2.status === 409 && (await bellsFor(admin.id, 'stopped')).length === 1, [st1.status, h.primary, st2.status]);

  // a failing live send: every message refused by the (mock) mail server -> "has a problem" bell + all_failed banner
  const segF = await mkSeg('Fail group', { importIds: ['ZZOQ-FAIL'] });
  for (let i = 1; i <= 3; i += 1) await mkContact(`fail${i}`, { importId: 'ZZOQ-FAIL' });
  const campF = await newCamp('admin', 'Fail campaign', JA.id, [segF]);
  await sendCamp('admin', campF);
  await S.run('UPDATE "OutreachCampaign" SET mode = \'live\' WHERE id = ?', campF);
  await setS({ emailTestMode: false });
  const refuse = async () => ({ ok: false, error: 'mailbox unavailable', transient: false });
  await Run.tick({ maxMessages: 50, mailSender: refuse });
  await setS({ emailTestMode: true });
  const fh = await hp(campF);
  Z.check('T2: when nothing could be sent the campaign says so and the creator gets a "has a problem" notice', fh.primary.code === 'all_failed' && (await bellsFor(admin.id, 'has a problem')).length === 1, [fh.primary, (await bellsFor(admin.id, 'has a problem')).length]);

  // a live campaign held by test mode rings the bell ONCE (not every tick)
  const segH = await mkSeg('Hold group', { importIds: ['ZZOQ-HOLD'] });
  await mkContact('hold1', { importId: 'ZZOQ-HOLD' });
  const campH = await newCamp('admin', 'Hold campaign', JA.id, [segH]);
  await sendCamp('admin', campH);
  await S.run('UPDATE "OutreachCampaign" SET mode = \'live\' WHERE id = ?', campH);
  await Run.tick({ maxMessages: 10 }); await Run.tick({ maxMessages: 10 });
  Z.check('T2c: a live campaign held by test mode rings the bell once, not on every tick', (await bellsFor(admin.id, 'on hold')).length === 1);
  await S.run('UPDATE "OutreachCampaign" SET status = \'stopped\' WHERE id = ?', campH);

  // the stale-schedule guard: a scheduled campaign whose time moved later does nothing
  const segSch = await mkSeg('Schedule group', { importIds: ['ZZOQ-SCH'] });
  await mkContact('sch1', { importId: 'ZZOQ-SCH' });
  const campSch = await newCamp('admin', 'Schedule campaign', JA.id, [segSch]);
  const sch = await sendCamp('admin', campSch, { when: 'at', at: Date.now() + 5 * 60000 });
  await S.run('UPDATE "OutreachCampaign" SET scheduledAt = ? WHERE id = ?', Date.now() + 3600000, campSch);
  await Run.tick({ maxMessages: 20 });
  const afterLater = (await S.q('SELECT status FROM "OutreachCampaign" WHERE id = ?', campSch))[0].status;
  const schHealth = await hp(campSch);
  await S.run('UPDATE "OutreachCampaign" SET scheduledAt = ? WHERE id = ?', Date.now() - 1000, campSch);
  await S.run('UPDATE "OutreachMessage" SET nextRunAt = 0 WHERE campaignId = ?', campSch); // the rows carry the first time; pretend that time has come
  await Run.tick({ maxMessages: 20 });
  Z.check('T2d: a schedule moved later does nothing; once due it starts; the banner says when', sch.status === 'scheduled' && afterLater === 'scheduled' && schHealth.reasons.some((r) => r.code === 'scheduled') && (await S.q('SELECT COUNT(*) n FROM "OutreachMessage" WHERE campaignId = ? AND status = \'test_captured\'', campSch))[0].n > 0, [sch.status, afterLater]);

  // ================================================================= T2. CHECK BEFORE SENDING
  const segC = await mkSeg('Check group', { importIds: ['ZZOQ-CHK'] });
  for (let i = 1; i <= 5; i += 1) await mkContact(`chk${i}`, { importId: 'ZZOQ-CHK', name: i === 5 ? null : undefined });
  const chkBody = { type: 'job_promotion', requirementId: JA.id, segmentIds: [segC], templateId: tplJob, channel: 'email', when: 'now' };
  const ck = await api('admin', 'POST', '/campaigns/check', chkBody);
  const pl = await api('admin', 'POST', '/campaigns/plan', chkBody);
  const ids = (c) => ck.body.checks.filter((x) => x.id === c)[0];
  Z.check('T2: Check before sending PASSES for a good campaign: 5 will send, who is left out, test mode, cap left, finish time, stop link, words', ck.status === 200 && ck.body.ok === true && ck.body.blocked === false && ck.body.willSend === 5 && pl.body.willGet === 5 && ids('people').status === 'ok' && ids('stop_link').status === 'ok' && ids('words').status === 'ok' && ids('test_mode').status === 'warn' && ids('cap').status === 'ok' && !!ck.body.estimate.words && !!ck.body.estimate.finishAt && ck.body.capLeft > 0, ck.body);
  Z.check('T2: it warns about a person with no name ("Hi there")', !!ids('names') && /1 person has no name/.test(ids('names').label), ck.body.checks.map((c) => c.id));
  await setS({ master: false });
  const ckOff = await api('admin', 'POST', '/campaigns/check', chkBody);
  await setS({ master: true });
  Z.check('T2: sending switched OFF is a warning (it can wait), not a block', ckOff.body.ok === true && ckOff.body.checks.find((c) => c.id === 'switch').status === 'warn');
  const usedNow = await email.sentToday('test');
  await setS({ emailDailyCap: usedNow + 2 });
  const ckCap = await api('admin', 'POST', '/campaigns/check', chkBody);
  await setS({ emailDailyCap: 100000 });
  Z.check('T2: when the limit left today is smaller than the list, it says so and the finish time runs into more days', /Only 2 more/.test(ckCap.body.checks.find((c) => c.id === 'cap').label) && /day/.test(ckCap.body.estimate.words) && ckCap.body.ok === true, ckCap.body.estimate);
  // template without the stop link
  const tplBad = await mkTpl('No stop link', 'Hi {{name}}, {{job_title}}\n{{apply_link}}\n{{unsubscribe}}');
  await S.run('UPDATE "OutreachTemplate" SET body = ? WHERE id = ?', 'Hi {{name}}, {{job_title}}\n{{apply_link}}', tplBad);
  const ckBad = await api('admin', 'POST', '/campaigns/check', { ...chkBody, templateId: tplBad });
  const mkBad = await api('admin', 'POST', '/campaigns', { name: 'ZZTEST OQ bad', type: 'job_promotion', requirementId: JA.id, segmentIds: [segC], templateId: tplBad, channel: 'email' });
  Z.check('T2a: a template without the stop link BLOCKS (plain words), and the server refuses to make the campaign too', ckBad.body.blocked === true && ckBad.body.ok === false && ckBad.body.checks.some((c) => c.status === 'block' && /stop/i.test(c.detail)) && mkBad.status === 400 && /stop/i.test(mkBad.body.error), [ckBad.body.checks, mkBad.body]);
  const ckNoPortal = await api('admin', 'POST', '/campaigns/check', { ...chkBody, requirementId: JNoPortal.id });
  Z.check('T2: a job that is not on the Job Portal blocks (the apply link would not open)', ckNoPortal.body.blocked === true && ckNoPortal.body.checks.some((c) => c.id === 'words' && c.status === 'block' && /Job Portal/.test(c.detail)), ckNoPortal.body.checks);
  const segNo = await mkSeg('Nobody group', { importIds: ['ZZOQ-NOBODY'] });
  for (let i = 1; i <= 2; i += 1) await mkContact(`nobody${i}`, { importId: 'ZZOQ-NOBODY', optIn: 'opted_out' });
  const ckNo = await api('admin', 'POST', '/campaigns/check', { ...chkBody, segmentIds: [segNo] });
  Z.check('T2: a group where nobody can get it blocks', ckNo.body.blocked === true && ckNo.body.willSend === 0 && ckNo.body.checks.some((c) => c.id === 'people' && c.status === 'block') && ckNo.body.skipReasons.some((r) => r.reason === 'opted_out' && r.n === 2), ckNo.body.checks);
  const ckRoles = await Promise.all(['rec', 'mgr', 'hr', 'acct'].map((w) => api(w, 'POST', '/campaigns/check', chkBody)));
  Z.check('T2: only the people who may send can run the check (recruiter, manager, HR desk, accountant refused)', ckRoles.every((r) => r.status === 403), ckRoles.map((r) => r.status));

  // ================================================================= T5. LIVE GROUP COUNTS, EMPTY RULE, PREVIEW
  const segG = await mkSeg('Counts group', { importIds: ['ZZOQ-G'] });
  for (let i = 1; i <= 10; i += 1) await mkContact(`g${i}`, { importId: 'ZZOQ-G' });
  await mkContact('gOutEmail1', { importId: 'ZZOQ-G', optIn: 'opted_out' }); await mkContact('gOutEmail2', { importId: 'ZZOQ-G', optIn: 'opted_out' });
  await mkContact('gOutWa', { importId: 'ZZOQ-G', wa: 'opted_out' });
  await mkContact('gBadSms', { importId: 'ZZOQ-G', smsHealth: 'invalid' });
  await mkContact('gNoEmail', { importId: 'ZZOQ-G', email: null });
  await mkContact('gBounced', { importId: 'ZZOQ-G', health: 'hard_bounced' });
  const gSupp = await mkContact('gSuppressed', { importId: 'ZZOQ-G' });
  await S.run('INSERT OR IGNORE INTO "OutreachSuppression" (addressHash, channel, reason, at, source) VALUES (?,?,?,?,?)', S.hashAddress('email', em('gSuppressed')), 'email', 'unsubscribe_link', Date.now(), 'test');
  await mkContact('gStaff', { importId: 'ZZOQ-G', type: 'internal' });
  const gDeleted = await mkContact('gDeleted', { importId: 'ZZOQ-G' });
  await S.run('UPDATE "OutreachContact" SET status = \'deleted\' WHERE id = ?', gDeleted);
  // the answer worked out independently, straight from SQL
  const sqlCount = async (ch) => {
    const rows = await S.q(`SELECT c.id, c.email, c.phoneE164 FROM "OutreachContact" c JOIN "OutreachContactChannel" h ON h.contactId = c.id AND h.channel = ? WHERE c.importId = 'ZZOQ-G' AND c.status = 'active' AND c.contactType = 'candidate_lead' AND h.optIn = 'opted_in' AND h.health = 'ok' AND ${ch === 'email' ? "c.email LIKE '%@%'" : 'c.phoneE164 IS NOT NULL'}`, ch);
    let n = 0;
    for (const r of rows) { const hash = S.hashAddress(ch === 'email' ? 'email' : 'phone', ch === 'email' ? r.email : r.phoneE164); const s = await S.q('SELECT 1 x FROM "OutreachSuppression" WHERE addressHash = ? AND channel IN (?, \'*\')', hash, ch); if (!s.length) n += 1; }
    return n;
  };
  const sqlTotal = S.num((await S.q('SELECT COUNT(*) n FROM "OutreachContact" WHERE importId = \'ZZOQ-G\' AND status = \'active\' AND contactType = \'candidate_lead\''))[0].n);
  const want = { total: sqlTotal, email: await sqlCount('email'), whatsapp: await sqlCount('whatsapp'), sms: await sqlCount('sms') };
  const gl = (await api('admin', 'GET', '/segments')).body.segments.find((s) => s.id === segG).counts;
  const gp = (await api('admin', 'GET', `/segments/${segG}/preview`)).body;
  const gp2 = (await api('admin', 'POST', '/segments/preview', { rules: { importIds: ['ZZOQ-G'] } })).body;
  Z.check('T5: live counts per channel equal the direct SQL answer (list, "Count again", and preview all agree)', gl.total === want.total && gl.reachable.email === want.email && gl.reachable.whatsapp === want.whatsapp && gl.reachable.sms === want.sms && JSON.stringify(gp.counts) === JSON.stringify(gl) && JSON.stringify(gp2.counts) === JSON.stringify(gl), [want, gl]);
  Z.check('T5c: "can receive" leaves out opted-out, bad address, do-not-contact, no address and deleted people (17 active job contacts; email 12, WhatsApp 16, SMS 16)', gl.total === 17 && gl.reachable.email === 12 && gl.reachable.whatsapp === 16 && gl.reachable.sms === 16, [want, gl]);
  const planG = (await api('admin', 'POST', '/campaigns/plan', { type: 'job_promotion', requirementId: JA.id, segmentIds: [segG], templateId: tplJob, channel: 'email' })).body;
  Z.check('T5b: the campaign plan counts exactly the same people as the group says can receive email (one function)', planG.willGet === gl.reachable.email && planG.people === gl.total, [planG.willGet, planG.people, gl]);
  Z.check('T5: the group preview shows at most ten people, always masked', gp.people.length === 10 && gp.people.every((p) => !p.email || /•/.test(p.email)) && gp.people.every((p) => !p.phone || /•/.test(p.phone)), gp.people[0]);
  const staffNotIn = (await S.q('SELECT COUNT(*) n FROM "OutreachContact" WHERE importId = \'ZZOQ-G\' AND contactType = \'internal\''))[0].n;
  Z.check('T5d: an internal (staff) contact with the same file never counts in a job group', Number(staffNotIn) === 1 && gl.total === sqlTotal && !gp.people.some((p) => /gStaff/.test(p.name)));
  // the safe default
  const empty1 = (await api('admin', 'POST', '/segments/preview', { rules: {} })).body;
  const empty2 = (await api('admin', 'POST', '/segments/preview', { rules: { text: 'hello' } })).body;
  Z.check('T5a: an EMPTY rule matches nobody (never everybody) and says so in plain words', empty1.counts.total === 0 && empty1.counts.emptyRule === true && empty1.people.length === 0 && /no rule/i.test(empty1.warning) && empty2.counts.emptyRule === true && empty2.counts.total === 0, [empty1, empty2]);
  const segEmpty = await mkSeg('Empty rule group', {});
  const emptyList = (await api('admin', 'GET', '/segments')).body.segments.find((s) => s.id === segEmpty);
  const planE = await api('admin', 'POST', '/campaigns/plan', { type: 'job_promotion', requirementId: JA.id, segmentIds: [segEmpty], templateId: tplJob, channel: 'email' });
  const ckE = await api('admin', 'POST', '/campaigns/check', { type: 'job_promotion', requirementId: JA.id, segmentIds: [segEmpty], templateId: tplJob, channel: 'email' });
  const G = require(path.join(BACK, 'src/outreach/segments'));
  Z.check('T5a: a saved group with no rule counts 0, plans 0 people, and the pre-send check blocks it; the target resolver returns nobody', emptyList.counts.total === 0 && emptyList.counts.emptyRule === true && planE.body.people === 0 && ckE.body.blocked === true && (await G.resolveTargets({ segmentIds: [segEmpty], channel: 'email', purpose: 'job_promotion' })).length === 0, [emptyList.counts, planE.body.people]);
  const bdeP = await api('bde', 'POST', '/segments/preview', { rules: { importIds: ['ZZOQ-G'] } });
  const hrP = await api('hr', 'POST', '/segments/preview', { rules: { importIds: ['ZZOQ-G'] } });
  Z.check("T5: the ten-people sample respects the viewer's own scope (a BDE sees none of an Admin's people); the HR desk cannot preview job contacts", bdeP.status === 200 && bdeP.body.people.length === 0 && bdeP.body.counts.total === sqlTotal && hrP.status === 403, [bdeP.body.people.length, hrP.status]);
  const mkR = await Promise.all([api('rec', 'POST', '/segments', { name: 'ZZTEST OQ rec seg', rules: { importIds: ['ZZOQ-G'] } }), api('mgr', 'POST', '/segments', { name: 'ZZTEST OQ mgr seg', rules: { importIds: ['ZZOQ-G'] } })]);
  Z.check('role gates as built: a recruiter and a Manager cannot make groups', mkR.every((r) => r.status === 403), mkR.map((r) => r.status));

  // ================================================================= T4. SMARTER IMPORT
  const IPH = (n) => `93${String(RUNNUM).padStart(5, '0')}${String(n).padStart(3, '0')}`;
  const IEM = (n) => em(`imp${n}`);
  const HEAD = ['Name', 'Phone', 'Email', 'Company', 'City', 'Skills', 'Experience', 'Kind', 'Tags', 'Permission'];
  const row = (name, phone, mail, extra = {}) => [name, phone, mail, extra.company || '', extra.city || '', '', '', extra.kind || '', extra.tags || '', extra.consent === undefined ? 'yes' : extra.consent];
  const baseQ = { type: 'candidate_lead', industries: '', mapping: '{}' };
  const imp = (who, p, rows, q) => rawCall(who, p, csvOf([HEAD, ...rows]), { ...baseQ, ...q });
  const save = (who, rows, q) => imp(who, '/import/save', rows, { permission: '1', basis: 'ZZTEST OQ our own list', filename: `ZZTEST OQ ${q.tag || 'f'}.csv`, source: `ZZTEST OQ source ${q.tag || 'f'}`, ...q });
  // people already there
  const PA = await mkContact('impA', { importId: 'ZZOQ-IMP', phone: IPH(1), email: IEM('A'), name: 'ZZTEST OQ Anna' });
  await S.run('UPDATE "OutreachContact" SET city = ?, company = NULL, ownerUserId = ?, createdById = ? WHERE id = ?', 'Pune', admin.id, admin.id, PA);
  const PB = await mkContact('impB', { importId: 'ZZOQ-IMP', phone: IPH(2), email: IEM('B'), name: 'ZZTEST OQ Bobby' });
  const PD = await mkContact('impD', { importId: 'ZZOQ-IMP', phone: IPH(4), email: IEM('D'), name: 'ZZTEST OQ Dina' });
  const optOut = await api('admin', 'POST', `/contacts/${PD}/opt-out`, { channel: 'email', reason: 'ZZTEST OQ asked us to stop' });
  Z.check('T4 setup: three existing people (one opted out of email)', optOut.status === 200, optOut.body);
  const cState = async (id) => (await S.q('SELECT name, company, city, phoneE164, email FROM "OutreachContact" WHERE id = ?', id))[0];
  const tagsOf = async (id) => (await S.q('SELECT industry FROM "OutreachContactTag" WHERE contactId = ? ORDER BY industry', id)).map((t) => t.industry);

  // 1. the same person written five ways imports once; tags column; unusable row; formula name
  const P = IPH(10);
  const five = [`+91 ${P.slice(0, 5)} ${P.slice(5)}`, `0${P}`, `0091${P}`, `91-${P}`, P];
  const f1 = [
    ...five.map((v, i) => row(i === 0 ? 'ZZTEST OQ Five' : `ZZTEST OQ Five again ${i}`, v, '')),
    row('ZZTEST OQ Tagged', IPH(11), IEM('T'), { tags: 'Medical, Education; medical , Gardening', city: 'Delhi' }),
    row('=cmd|\' /C calc\'!A0', '123', 'not-an-email'),
  ];
  const c1 = await imp('admin', '/import/check', f1, { dupMode: 'skip' });
  Z.check('T4a: check: the same phone written five ways is ONE new person (4 repeats), a row with nothing usable, an unknown tag is reported', c1.status === 200 && c1.body.totals.new === 2 && c1.body.totals.dup_in_file === 4 && c1.body.totals.invalid === 1 && c1.body.totals.unknownTags === 1, c1.body.totals);
  const s1 = await save('admin', f1, { dupMode: 'skip', tag: 'one' });
  const fiveRows = await S.q('SELECT id FROM "OutreachContact" WHERE phoneKey = ? AND status = \'active\'', P);
  const taggedId = (await S.q('SELECT id FROM "OutreachContact" WHERE emailKey = ?', IEM('T').toLowerCase()))[0].id;
  Z.check('T4a/e: saved: one person for the five spellings; the Tags column added Education + Medical once each (a repeated word and an unknown one not added)', s1.status === 200 && s1.body.counts.created === 2 && fiveRows.length === 1 && JSON.stringify(await tagsOf(taggedId)) === JSON.stringify(['Education', 'Medical']), [s1.body, await tagsOf(taggedId)]);
  const csv1 = await Z.call('GET', `${O}/imports/${s1.body.importId}/rows.csv`, tok.admin);
  const csv1Lines = csv1.text.replace(/^﻿/, '').split('\r\n').filter(Boolean);
  Z.check('T4: the per-row problem file lists every row that needs a look (4 repeats, 1 unusable, 1 with an unknown tag) in words, and neutralises a formula name', csv1.status === 200 && csv1Lines.length === 7 && /Row/.test(csv1Lines[0]) && csv1.text.includes('\'=cmd') && /not in the kinds list/.test(csv1.text) && !/@|9[0-9]{9}/.test(csv1.text.replace(/\'=cmd[^\r\n]*/g, '')), csv1Lines);
  const csvStranger = await Z.call('GET', `${O}/imports/${s1.body.importId}/rows.csv`, tok.bde);
  Z.check("T4: another person's import file is not found for a login that did not make it", csvStranger.status === 404, csvStranger.status);

  // 2. match by email OR phone (either), whichever way the number is written
  const m1 = await imp('admin', '/import/check', [row('ZZTEST OQ x', `+91 ${IPH(1).slice(0, 5)} ${IPH(1).slice(5)}`, '', { company: 'Z' }), row('ZZTEST OQ y', '', IEM('A').toUpperCase(), { company: 'Z' })], { dupMode: 'merge' });
  Z.check('T4: an existing person is matched by phone alone OR by email alone (capitals and spaces do not matter)', m1.body.totals.duplicate === 2 && m1.body.totals.new === 0, m1.body.totals);

  // 3. conflict: the phone is Anna, the email is Bobby
  const conflictRows = [row('ZZTEST OQ Conflict', IPH(1), IEM('B'), { company: 'ConflictCo' }), row('ZZTEST OQ Fresh', IPH(12), IEM('F'))];
  const before = { A: await cState(PA), B: await cState(PB) };
  const c3 = await imp('admin', '/import/check', conflictRows, { dupMode: 'update' });
  const cItem = c3.body.problems.find((p) => p.status === 'conflict');
  Z.check('T4b: conflict: phone = one person, email = another -> listed as "needs a person to choose", with both people (masked hints), counted separately', c3.body.totals.conflict === 1 && cItem && cItem.matches.length === 2 && cItem.matches.every((m) => /•/.test(m.hint)), c3.body.totals);
  const s3 = await save('admin', conflictRows, { dupMode: 'update', tag: 'conflict' });
  Z.check('T4b: saving with the conflict untouched: nobody changed, the conflict is in the problem list, the fresh person was added', s3.status === 200 && s3.body.counts.conflicts === 1 && JSON.stringify(await cState(PA)) === JSON.stringify(before.A) && JSON.stringify(await cState(PB)) === JSON.stringify(before.B) && s3.body.problems.some((p) => p.result === 'conflict'), s3.body);
  const pick = await imp('admin', '/import/check', conflictRows, { dupMode: 'merge', resolutions: JSON.stringify({ [cItem.i]: PA }) });
  Z.check('T4b: once a person is chosen the row goes on as an ordinary "already here" row', pick.body.totals.conflict === 0 && pick.body.totals.duplicate === 2 /* the chosen row + the fresh person saved a moment ago */, pick.body.totals);
  const pickBad = await imp('admin', '/import/check', conflictRows, { dupMode: 'merge', resolutions: JSON.stringify({ [cItem.i]: PD }) });
  Z.check('T4b: a choice that is not one of the two matching people is ignored (still a conflict)', pickBad.body.totals.conflict === 1, pickBad.body.totals);
  const s3b = await save('admin', [conflictRows[0], row('ZZTEST OQ Fresh2', IPH(13), IEM('F2'))], { dupMode: 'merge', resolutions: JSON.stringify({ [cItem.i]: PA }), tag: 'conflict-picked' });
  const aAfterPick = await cState(PA); const bAfterPick = await cState(PB);
  Z.check("T4b: the chosen person (Anna) is filled in (company), keeps her own email; Bobby is untouched even though the file had his email", s3b.status === 200 && aAfterPick.company === 'ConflictCo' && aAfterPick.email === IEM('A') && JSON.stringify(bAfterPick) === JSON.stringify(before.B), [aAfterPick, bAfterPick, s3b.body]);

  // 4. update modes: fill blanks only / overwrite with confirm; undo after an update run
  const stateBeforeMerge = await cState(PA); const tagsBeforeMerge = await tagsOf(PA);
  const upRows = [row('ZZTEST OQ Anna Renamed', '', IEM('A'), { company: 'ZZTEST OQ NewCo', city: 'Mumbai', tags: 'Education' })];
  const sMerge = await save('admin', [...upRows, row('ZZTEST OQ Fresh3', IPH(14), IEM('F3'))], { dupMode: 'merge', tag: 'merge' });
  const aMerge = await cState(PA);
  Z.check('T4: "Fill their empty boxes only": name and city stay, company only fills a blank (it was filled by the earlier step so it stays), tag added', sMerge.status === 200 && aMerge.name === stateBeforeMerge.name && aMerge.city === stateBeforeMerge.city && aMerge.company === stateBeforeMerge.company && (await tagsOf(PA)).includes('Education'), [stateBeforeMerge, aMerge]);
  await S.run('UPDATE "OutreachContact" SET company = NULL WHERE id = ?', PA);
  const sMerge2 = await save('admin', [...upRows, row('ZZTEST OQ Fresh3b', IPH(15), IEM('F3b'))], { dupMode: 'merge', tag: 'merge2' });
  const aMerge2 = await cState(PA);
  Z.check('T4c: fill-blanks fills the company when it IS empty and still leaves name and city alone', aMerge2.company === 'ZZTEST OQ NewCo' && aMerge2.name === 'ZZTEST OQ Anna' && aMerge2.city === 'Pune', aMerge2);
  const noConf = await save('admin', upRows, { dupMode: 'overwrite', tag: 'ow-no' });
  const chkOw = await imp('admin', '/import/check', upRows, { dupMode: 'overwrite' });
  Z.check('T4c: "Update them from the file" is refused without the confirm tick (plain words), the check says it needs one', noConf.status === 400 && noConf.body.code === 'CONFIRM_OVERWRITE' && chkOw.body.needsConfirm === true, [noConf.status, noConf.body]);
  const sOw = await save('admin', [...upRows, row('ZZTEST OQ Fresh4', IPH(16), IEM('F4'))], { dupMode: 'overwrite', confirmOverwrite: '1', tag: 'overwrite' });
  const aOw = await cState(PA);
  Z.check('T4c: with the confirm tick the file wins: name and city are replaced', sOw.status === 200 && aOw.name === 'ZZTEST OQ Anna Renamed' && aOw.city === 'Mumbai', [sOw.body.counts, aOw]);
  const un = await Z.call('POST', `${O}/imports/${sOw.body.importId}/undo`, tok.admin);
  const aUndo = await cState(PA);
  Z.check('T4d: undo after an update run restores the person exactly as before (and removes the people it added)', un.status === 200 && aUndo.name === 'ZZTEST OQ Anna' && aUndo.city === 'Pune' && aUndo.company === 'ZZTEST OQ NewCo' && S.num((await S.q('SELECT COUNT(*) n FROM "OutreachContact" WHERE emailKey = ?', IEM('F4').toLowerCase()))[0].n) === 0, [un.body, aUndo]);
  const un2 = await Z.call('POST', `${O}/imports/${sMerge2.body.importId}/undo`, tok.admin);
  const aUndo2 = await cState(PA);
  Z.check('T4d: undoing the fill-blanks run puts the empty company back', un2.status === 200 && aUndo2.company === null, aUndo2);

  // 5. opt-out is never overridden
  const evBefore = S.num((await S.q('SELECT COUNT(*) n FROM "OutreachConsentEvent" WHERE contactId = ? AND action = \'opt_in\'', PD))[0].n);
  const chBefore = await S.q('SELECT channel, optIn FROM "OutreachContactChannel" WHERE contactId = ? ORDER BY channel', PD);
  const dRow = row('ZZTEST OQ Dina', '', IEM('D'), { company: 'DinaCo', consent: 'yes' });
  const sDm = await save('admin', [dRow, row('ZZTEST OQ Fresh5', IPH(17), IEM('F5'))], { dupMode: 'merge', tag: 'optout-m' });
  const sDo = await save('admin', [dRow, row('ZZTEST OQ Fresh6', IPH(18), IEM('F6'))], { dupMode: 'overwrite', confirmOverwrite: '1', tag: 'optout-o' });
  const chAfter = await S.q('SELECT channel, optIn FROM "OutreachContactChannel" WHERE contactId = ? ORDER BY channel', PD);
  const evAfter = S.num((await S.q('SELECT COUNT(*) n FROM "OutreachConsentEvent" WHERE contactId = ? AND action = \'opt_in\'', PD))[0].n);
  const supp = (await S.q('SELECT 1 x FROM "OutreachSuppression" WHERE addressHash = ?', S.hashAddress('email', IEM('D')))).length;
  Z.check('T4: an opted-out person stays opted out in BOTH update modes, even when the file says "yes": channel rows unchanged, no new opt-in event, still on the do-not-contact list', sDm.status === 200 && sDo.status === 200 && JSON.stringify(chBefore) === JSON.stringify(chAfter) && chAfter.find((c) => c.channel === 'email').optIn === 'opted_out' && evAfter === evBefore && supp === 1, [chBefore, chAfter, evBefore, evAfter, supp]);

  // role gates for import
  const rg = await Promise.all([imp('rec', '/import/check', f1, { dupMode: 'skip' }), imp('mgr', '/import/check', f1, { dupMode: 'skip' }), imp('hr', '/import/check', f1, { dupMode: 'skip' })]);
  Z.check('role gates as built: a recruiter, a Manager and the HR desk cannot import job contacts (403)', rg.every((r) => r.status === 403), rg.map((r) => r.status));
  const hist = (await Z.call('GET', `${O}/imports`, tok.admin)).body.imports.find((i) => i.id === s1.body.importId);
  Z.check('T4: the import history knows which imports have a saved per-row file (and how many rows need a look)', hist && hist.rowsSaved === true && hist.problemRows === 6, hist);

  // ================================================================= no PII in the audit rows; cleanup + proof
  const myAudit = await prisma.auditLog.findMany({ where: { OR: [{ userId: { in: Z.made.users } }, { actorName: { contains: 'ZZTEST OQ' } }] } });
  const piiRe = new RegExp(`zz-oq-|example\\.test|${String(PHBASE).slice(0, 6)}\\d{4}|93${String(RUNNUM).padStart(5, '0')}\\d{3}`, 'i');
  const leak = myAudit.filter((a) => piiRe.test(`${a.action} ${a.toValue || ''} ${a.fromValue || ''} ${a.reason || ''} ${a.entityId || ''}`));
  Z.check('no phone number and no email address in any audit row these tests caused', leak.length === 0, leak.slice(0, 3).map((a) => `${a.action}: ${a.toValue}`));
  await S.saveSettings(settings0);
  await wipe();
  await prisma.appSetting.deleteMany({ where: { key: 'outreach.settings' } });
  if (settingsBefore) await prisma.appSetting.create({ data: { key: settingsBefore.key, value: settingsBefore.value } });
  const left = await Z.cleanup();
  const count = async (sql) => S.num((await S.q(sql))[0].n);
  const rest = {
    campaigns: await count('SELECT COUNT(*) n FROM "OutreachCampaign" WHERE name LIKE \'ZZTEST OQ%\''),
    messages: await count('SELECT COUNT(*) n FROM "OutreachMessage" WHERE campaignId NOT IN (SELECT id FROM "OutreachCampaign")'),
    notes: await count('SELECT COUNT(*) n FROM "OutreachCampaignNote" WHERE campaignId NOT IN (SELECT id FROM "OutreachCampaign")'),
    importRows: await count('SELECT COUNT(*) n FROM "OutreachImportRow" WHERE importId NOT IN (SELECT id FROM "OutreachImport")'),
    contacts: await count('SELECT COUNT(*) n FROM "OutreachContact" WHERE name LIKE \'ZZTEST OQ%\' OR source LIKE \'ZZTEST OQ%\' OR importId LIKE \'ZZOQ-%\''),
    segs: await count('SELECT COUNT(*) n FROM "OutreachSegment" WHERE name LIKE \'ZZTEST OQ%\''),
    tpls: await count('SELECT COUNT(*) n FROM "OutreachTemplate" WHERE name LIKE \'ZZTEST OQ%\''),
    imports: await count('SELECT COUNT(*) n FROM "OutreachImport" WHERE fileName LIKE \'ZZTEST OQ%\''),
    sendLog: await count('SELECT COUNT(*) n FROM "OutreachSendLog" WHERE subject LIKE \'%ZZTEST OQ%\''),
    bells: await prisma.notification.count({ where: { OR: [{ title: { contains: 'ZZTEST OQ' } }, { message: { contains: 'ZZTEST OQ' } }] } }),
    audit: await prisma.auditLog.count({ where: { OR: [{ userId: { in: Z.made.users } }, { actorName: { contains: 'ZZTEST OQ' } }, { toValue: { contains: 'ZZTEST OQ' } }] } }),
  };
  console.log('cleanup', JSON.stringify(left), JSON.stringify(rest));
  Z.check('cleanup: zero ZZTEST OQ rows left', Object.values(left).every((v) => v === 0) && Object.values(rest).every((v) => v === 0));
  await Z.finish();
})().catch(async (e) => { console.error('CRASH', e); try { await prisma.$disconnect(); } catch { /* */ } process.exit(1); });
