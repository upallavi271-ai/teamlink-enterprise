// ---------------------------------------------------------------------------
// OMNI-CHANNEL OUTREACH, PHASE 3: acceptance test (campaigns, tracked links, queue, suppression, webhook). SANDBOX ONLY (API 4011,
// prisma/sandbox.db). Nothing is ever really sent: Email stays in TEST MODE; the live path is exercised with a MOCK sender that records calls.
//   node scripts/outreach-p3-apply-sandbox.js      (once: creates the five Phase 3 tables in the sandbox)
//   TL_API=http://localhost:4011 node scripts/outreach-p3-test.js
// Tag "ZZTEST OC3": every row made here is removed at the end (and the real dev.db is never opened).
// ---------------------------------------------------------------------------
/* eslint-disable no-console, no-await-in-loop */
const path = require('path');
const crypto = require('crypto');
if (!process.env.TL_API) process.env.TL_API = 'http://localhost:4011';
const Z = require('./lib/zzfix')('OC3');
const { BACK, prisma, API } = Z;
const S = require(path.join(BACK, 'src/outreach/store'));
const Sup = require(path.join(BACK, 'src/outreach/suppress'));
const Lk = require(path.join(BACK, 'src/outreach/links'));
const Ev = require(path.join(BACK, 'src/outreach/events'));
const Camp = require(path.join(BACK, 'src/outreach/campaigns'));
const Run = require(path.join(BACK, 'src/outreach/runner'));
const Hook = require(path.join(BACK, 'src/outreach/webhook'));
const email = require(path.join(BACK, 'src/outreach/adapters/email'));
const bridge = require(path.join(BACK, 'src/utils/jobPortalBridge'));
const O = '/api/outreach';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Z.RUN;
const HUMAN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const em = (k) => `zz-oc3-${RUN}-${k}@example.test`;
let phN = 0;
const PHBASE = 9000000000 + (parseInt(RUN, 36) % 9000) * 100000;
const nextPhone = () => { phN += 1; return String(PHBASE + phN); };
let mockSeq = 0;
const mkMock = (script) => {
  const calls = [];
  const fn = async (m) => { calls.push(m.to); return script ? script(m, calls) : { ok: true, providerRef: `<zz-mock-${(mockSeq += 1)}-${RUN}@zz.test>` }; };
  fn.calls = calls;
  return fn;
};
const created = { contactIds: [], hashes: [], campaignIds: [], segIds: [], tplIds: [], eventIds: [] };

(async () => {
  console.log('preclean', JSON.stringify(await Z.preclean()));
  const settingsBefore = await prisma.appSetting.findUnique({ where: { key: 'outreach.settings' } });
  const wipe = async () => {
    const camps = (await S.q('SELECT id FROM "OutreachCampaign" WHERE name LIKE \'ZZTEST OC3%\'')).map((r) => r.id);
    for (const id of camps) { await S.run('DELETE FROM "OutreachEvent" WHERE campaignId = ?', id); await S.run('DELETE FROM "OutreachMessage" WHERE campaignId = ?', id); }
    await S.run('DELETE FROM "OutreachCampaign" WHERE name LIKE \'ZZTEST OC3%\'');
    const cs = (await S.q('SELECT id, email, phoneKey FROM "OutreachContact" WHERE name LIKE \'ZZTEST OC3%\' OR source LIKE \'ZZTEST OC3%\'')).map((r) => r);
    for (const c of cs) {
      await S.run('DELETE FROM "OutreachContactChannel" WHERE contactId = ?', c.id); await S.run('DELETE FROM "OutreachContactTag" WHERE contactId = ?', c.id);
      await S.run('DELETE FROM "OutreachConsentEvent" WHERE contactId = ?', c.id); await S.run('DELETE FROM "OutreachSendLog" WHERE contactId = ?', c.id);
      await S.run('DELETE FROM "OutreachEvent" WHERE contactId = ?', c.id);
      if (c.email) { const h = S.hashAddress('email', c.email); await S.run('DELETE FROM "OutreachSuppression" WHERE addressHash = ?', h); await S.run('DELETE FROM "OutreachConsentEvent" WHERE addressHash = ?', h); }
    }
    await S.run('DELETE FROM "OutreachContact" WHERE name LIKE \'ZZTEST OC3%\' OR source LIKE \'ZZTEST OC3%\'');
    for (const h of created.hashes) { await S.run('DELETE FROM "OutreachSuppression" WHERE addressHash = ?', h); await S.run('DELETE FROM "OutreachConsentEvent" WHERE addressHash = ?', h); }
    await S.run('DELETE FROM "OutreachSegment" WHERE name LIKE \'ZZTEST OC3%\'');
    await S.run('DELETE FROM "OutreachTemplate" WHERE name LIKE \'ZZTEST OC3%\'');
    await S.run('DELETE FROM "OutreachSendLog" WHERE subject LIKE \'%ZZTEST OC3%\' OR contactId LIKE \'self:%\' AND subject LIKE \'%ZZTEST OC3%\'');
    await S.run('DELETE FROM "OutreachWebhookReceipt" WHERE providerEventId LIKE \'zzoc3-%\'');
    await S.run('DELETE FROM "OutreachRunnerLease" WHERE holder LIKE \'zzoc3-%\'');
  };
  await wipe();
  Z.check('Phase 3 tables exist in the sandbox', await S.campaignsReady(), 'run: node scripts/outreach-p3-apply-sandbox.js');
  if (!(await S.campaignsReady())) { await Z.finish(); return; }

  // ----------------------------------------------------------------- people + jobs
  const admin = await Z.mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
  const mgr = await Z.mkUser('mgr', { role: 'MANAGER', atsRole: 'MANAGER' });
  const tl = await Z.mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'TL' });
  const bde = await Z.mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, {});
  const rec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, {});
  const rec2 = await Z.mkUser('rec2', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }, {});
  const hr = await Z.mkUser('hr', { role: 'HR', atsRole: 'HR', hrmsRole: 'HR' }, {});
  const acct = await Z.mkUser('acct', { role: 'EMPLOYEE', atsRole: 'ACCOUNTANT', accountsRole: 'ACCOUNTANT' }, {});
  const tok = {};
  for (const [k, u] of Object.entries({ admin, mgr, tl, bde, rec, rec2, hr, acct })) tok[k] = await Z.mint(u);
  const api = (who, method, p, body) => Z.call(method, `${O}${p}`, tok[who], body);
  const identity = {};
  for (const [k, u] of Object.entries({ admin, bde, tl, rec, hr })) identity[k] = await Z.identity(u);

  const client = await prisma.client.create({ data: { name: `ZZTEST OC3 Client ${RUN}`, location: 'ZZ Town', ownerDepartment: 'Education', clientType: 'Client', contactName: 'ZZ Contact', contactEmail: em('client'), agreementStatus: 'ACTIVE' } });
  Z.made.clients.push(client.id);
  const client2 = await prisma.client.create({ data: { name: `ZZTEST OC3 Client2 ${RUN}`, location: 'ZZ Town', ownerDepartment: 'Medical', bdeOwner: 'ZZTEST OC3 Someone Else', clientType: 'Client', contactName: 'ZZ Contact', contactEmail: em('client2'), agreementStatus: 'ACTIVE' } });
  Z.made.clients.push(client2.id);
  const mkJob = async (tag, extra = {}) => { const r = await prisma.requirement.create({ data: { title: `ZZTEST OC3 Job ${tag} ${RUN}`, clientId: extra.clientId || client.id, status: 'OPEN', department: 'Education', openings: 2, ...extra } }); Z.made.reqs.push(r.id); return r; };
  const JA = await mkJob('A', { bdeId: bde.id, tlId: tl.id, recruiterId: rec.id }); // in the scope of bde, tl, rec
  const JB = await mkJob('B', { clientId: client2.id, tlId: admin.id, recruiterId: rec2.id, department: 'Medical' }); // not bde's, not tl's, not rec's
  const JClosed = await mkJob('C', { bdeId: bde.id, tlId: tl.id, status: 'CLOSED' });

  // ----------------------------------------------------------------- contacts, groups, templates
  const mkContact = async (n, o = {}) => {
    const id = S.newId('oc'); const now = Date.now();
    const mail = o.email === undefined ? em(n) : o.email; const ph = o.phone === undefined ? nextPhone() : o.phone;
    const mailKey = mail && /@/.test(mail) ? mail.toLowerCase() : null;
    await S.run(`INSERT INTO "OutreachContact" (id, contactType, name, phoneE164, email, phoneKey, emailKey, city, source, importId, status, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?)`,
      id, o.type || 'candidate_lead', `ZZTEST OC3 Person ${n}`, ph ? `91${ph}` : null, mail || null, ph || null, mailKey, 'Hyderabad', 'ZZTEST OC3 source', o.importId || 'ZZOC3-A', admin.id, admin.name, now, now);
    await S.run('INSERT INTO "OutreachContactChannel" (id, contactId, channel, address, optIn, optInAt, health) VALUES (?,?,?,?,?,?,?)', S.newId('occ'), id, 'email', mail || null, o.optIn || 'opted_in', now, o.health || 'ok');
    created.contactIds.push(id);
    if (mail) created.hashes.push(S.hashAddress('email', mail));
    return id;
  };
  const mkSeg = async (name, rules, type = 'candidate_lead', who = 'admin') => { const r = await api(who, 'POST', '/segments', { name: `ZZTEST OC3 ${name}`, contactType: type, rules }); if (r.status !== 200) throw new Error(`segment ${name}: ${JSON.stringify(r.body)}`); created.segIds.push(r.body.segment.id); return r.body.segment.id; };
  const mkTpl = async (name, body, audience = 'candidate_lead', subject = 'ZZTEST OC3 {{job_title}}') => { const r = await api('admin', 'POST', '/templates', { name: `ZZTEST OC3 ${name}`, channel: 'email', audience, subject, body, promotional: true }); if (r.status !== 200) throw new Error(`template ${name}: ${JSON.stringify(r.body)}`); created.tplIds.push(r.body.template.id); return r.body.template.id; };
  const tplJob = await mkTpl('Job email', 'Hi {{name}}, {{company}} has a job for you: {{job_title}}.\nApply here: {{apply_link}}\nStop these emails: {{unsubscribe}}');
  const tplInt = await mkTpl('Staff note', 'Hello {{name}}, a note for the team.\nStop these emails: {{unsubscribe}}', 'internal', 'ZZTEST OC3 Staff note');

  // the matrix group (importId ZZOC3-A)
  const C = {};
  for (let i = 1; i <= 6; i += 1) C[`ok${i}`] = await mkContact(`ok${i}`);
  C.optout = await mkContact('optout', { optIn: 'opted_out' });
  C.supp = await mkContact('supp');
  const suppHash = S.hashAddress('email', em('supp')); await S.run('INSERT OR IGNORE INTO "OutreachSuppression" (addressHash, channel, reason, at, source) VALUES (?,?,?,?,?)', suppHash, 'email', 'unsubscribe_link', Date.now(), 'test');
  C.noperm = await mkContact('noperm', { optIn: 'unknown' });
  C.bounced = await mkContact('bounced', { health: 'hard_bounced' });
  C.bademail = await mkContact('bademail', { email: 'not-an-email' });
  C.appliedAts = await mkContact('appliedats');
  const appCand = await prisma.candidate.create({ data: { name: `ZZTEST OC3 Cand ${RUN}`, email: em('appliedats').toUpperCase(), phone: '+91 98765 43210', location: 'ZZ' } }); Z.made.cands.push(appCand.id);
  const appRow = await prisma.application.create({ data: { candidateId: appCand.id, requirementId: JA.id, stage: 'RECRUITER_REVIEW' } }); Z.made.apps.push(appRow.id);
  C.appliedEvt = await mkContact('appliedevt');
  await S.run('INSERT INTO "OutreachEvent" (id, eventKey, type, contactId, campaignId, messageId, requirementId, channel, source, occurredAt, receivedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)', S.newId('oev'), `applied:zzoc3-${RUN}`, 'applied', C.appliedEvt, 'zzoc3-none', 'zzoc3-none', JA.id, 'email', 'test', Date.now(), Date.now());
  C.recent = await mkContact('recent'); C.old = await mkContact('old');
  // an earlier LIVE campaign for the same job messaged "recent" 2 days ago and "old" 10 days ago
  const priorId = S.newId('oc');
  await S.run(`INSERT INTO "OutreachCampaign" (id, code, name, type, requirementId, segmentIds, channel, status, mode, suppressDays, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, priorId, `zzp${RUN}`.slice(0, 12), 'ZZTEST OC3 prior', 'job_promotion', JA.id, '[]', 'email', 'done', 'live', 7, admin.id, admin.name, Date.now(), Date.now());
  for (const [k, days] of [['recent', 2], ['old', 10]]) await S.run('INSERT INTO "OutreachMessage" (id, campaignId, contactId, channel, requirementId, status, idempotencyKey, nextRunAt, queuedAt, sentAt) VALUES (?,?,?,?,?,\'sent\',?,0,?,?)', S.newId('om'), priorId, C[k], 'email', JA.id, `${priorId}:${C[k]}:email`, Date.now(), Date.now() - days * 86400000);
  // staff
  const I1 = await mkContact('int1', { type: 'internal', importId: 'ZZOC3-I' }); const I2 = await mkContact('int2', { type: 'internal', importId: 'ZZOC3-I' });
  const segA = await mkSeg('Group A', { importIds: ['ZZOC3-A'] });
  const segA2 = await mkSeg('Group A again', { importIds: ['ZZOC3-A'] });
  const segInt = await mkSeg('Staff', { importIds: ['ZZOC3-I'] }, 'internal');
  const settings0 = await S.settings();
  const setS = async (patch) => S.saveSettings({ ...(await S.settings()), ...patch });
  await setS({ master: true, emailTestMode: true, emailPerMinute: 600, emailDailyCap: 100000, suppressDays: 7, internalHrMaySend: false });
  const makeLive = (id) => S.run('UPDATE "OutreachCampaign" SET mode = \'live\' WHERE id = ?', id);
  const rowsOf = (id) => S.q('SELECT * FROM "OutreachMessage" WHERE campaignId = ? ORDER BY queuedAt, id', id);
  const countBy = async (id) => { const o = {}; (await rowsOf(id)).forEach((r) => { o[r.status] = (o[r.status] || 0) + 1; }); return o; };
  const newCamp = async (who, o) => { const r = await api(who, 'POST', '/campaigns', { name: `ZZTEST OC3 ${o.name}`, type: o.type || 'job_promotion', requirementId: o.job, segmentIds: o.segs, templateId: o.tpl || tplJob, channel: 'email' }); if (r.status !== 200) throw new Error(`campaign ${o.name}: ${r.status} ${JSON.stringify(r.body)}`); created.campaignIds.push(r.body.id); return r.body.id; };
  // a fresh isolated pool of N people + a job (so one scenario never suppresses another)
  const pool = async (tag, n, extra = {}) => { const imp = `ZZOC3-${tag}`; for (let i = 1; i <= n; i += 1) await mkContact(`${tag}${i}`, { importId: imp, ...extra }); const seg = await mkSeg(`Pool ${tag}`, { importIds: [imp] }); const job = await mkJob(tag, { clientId: client2.id, tlId: admin.id, department: 'Medical' }); return { seg, job: job.id }; };

  // ================================================================= 1. SUPPRESSION: pure matrix
  const camp = { type: 'job_promotion', channel: 'email', requirementId: JA.id };
  const goodContact = { status: 'active', contactType: 'candidate_lead', email: 'a@b.co' };
  const goodChan = { optIn: 'opted_in', health: 'ok' };
  const d = (over, c = camp) => Sup.decide({ campaign: c, contact: goodContact, chan: goodChan, suppressed: false, alreadyApplied: false, recentlyMessaged: false, ...over });
  Z.check('matrix: a good contact is sent', d({}).send === true);
  Z.check('matrix: internal contact in a job promotion -> internal_contact', d({ contact: { ...goodContact, contactType: 'internal' } }).reason === 'internal_contact');
  Z.check('matrix: a lead in an internal campaign -> not_internal', d({}, { type: 'internal', channel: 'email' }).reason === 'not_internal');
  Z.check('matrix: invalid email -> invalid_email', d({ contact: { ...goodContact, email: 'nope' } }).reason === 'invalid_email');
  Z.check('matrix: do-not-contact hash -> suppressed', d({ suppressed: true }).reason === 'suppressed');
  Z.check('matrix: opted out -> opted_out', d({ chan: { optIn: 'opted_out', health: 'ok' } }).reason === 'opted_out');
  Z.check('matrix: bounced / invalid / complained address -> bad_address', ['hard_bounced', 'invalid', 'complained'].every((h) => d({ chan: { optIn: 'opted_in', health: h } }).reason === 'bad_address'));
  Z.check('matrix: no permission (unknown, or no channel row) -> no_opt_in', d({ chan: { optIn: 'unknown', health: 'ok' } }).reason === 'no_opt_in' && d({ chan: null }).reason === 'no_opt_in');
  Z.check('matrix: already applied -> already_applied; recently messaged -> recently_messaged', d({ alreadyApplied: true }).reason === 'already_applied' && d({ recentlyMessaged: true }).reason === 'recently_messaged');
  Z.check('matrix: order (internal beats opted-out; opted-out beats applied)', d({ contact: { ...goodContact, contactType: 'internal' }, chan: { optIn: 'opted_out', health: 'ok' } }).reason === 'internal_contact' && d({ chan: { optIn: 'opted_out', health: 'ok' }, alreadyApplied: true }).reason === 'opted_out');
  Z.check('matrix: deleted contact -> gone', d({ contact: { ...goodContact, status: 'deleted' } }).reason === 'gone');
  Z.check('matrix: an internal campaign does not check applied / recent', d({ contact: { ...goodContact, contactType: 'internal' }, alreadyApplied: true, recentlyMessaged: true }, { type: 'internal', channel: 'email' }).send === true);

  // ================================================================= 2. SUPPRESSION: against the database
  const ids = Object.values(C);
  const ev = await Sup.evaluate({ id: 'zz-none', ...camp }, ids, { days: 7 });
  const why = Object.fromEntries(Object.entries(C).map(([k, id]) => [k, (ev.find((r) => r.contactId === id).decision.reason) || 'SEND']));
  const expected = { optout: 'opted_out', supp: 'suppressed', noperm: 'no_opt_in', bounced: 'bad_address', bademail: 'invalid_email', appliedAts: 'already_applied', appliedEvt: 'already_applied', recent: 'recently_messaged' };
  const matrixOk = Object.entries(expected).every(([k, v]) => why[k] === v) && ['ok1', 'ok2', 'ok3', 'ok4', 'ok5', 'ok6', 'old'].every((k) => !ev.find((r) => r.contactId === C[k]).decision.reason);
  Z.check('database matrix: every skip reason lands on the right person; the 10-day-old message does not block', matrixOk, why);
  const evInternal = await Sup.evaluate({ id: 'zz-none', ...camp }, [I1], { days: 7 });
  Z.check('database: an internal contact id forced into a job promotion is refused (internal_contact)', evInternal[0].decision.reason === 'internal_contact');
  const tl1 = Sup.tally(ev);
  Z.check('tally groups the reasons in plain groups', tl1.willGet === 7 && tl1.skipped.optedOut === 2 && tl1.skipped.noPermission === 1 && tl1.skipped.badAddress === 2 && tl1.skipped.alreadyApplied === 2 && tl1.skipped.recentlyMessaged === 1, tl1);

  // ================================================================= 3. THE PLAN (live counts), via the API
  const body = { type: 'job_promotion', requirementId: JA.id, segmentIds: [segA, segA2], templateId: tplJob, channel: 'email' };
  const pl = await api('admin', 'POST', '/campaigns/plan', body);
  Z.check('plan: 15 people (two groups with the same people count once), 7 will get it, 8 skipped with the groups', pl.status === 200 && pl.body.people === 15 && pl.body.willGet === 7 && pl.body.skippedTotal === 8 && pl.body.skipped.optedOut === 2 && pl.body.skipped.alreadyApplied === 2 && pl.body.duplicates === 15, pl.body);
  Z.check('plan: says rehearsal (test mode), shows a preview with a sample person and the job title, never the client name', pl.body.testMode === true && /ZZTEST OC3 Job A/.test(pl.body.preview.body) && !/ZZTEST OC3 Client/.test(`${pl.body.preview.subject} ${pl.body.preview.body}`) && /\/r\/SAMPLETOKEN/.test(pl.body.preview.body), pl.body.preview);
  const plInt = await api('admin', 'POST', '/campaigns/plan', { ...body, segmentIds: [segInt] });
  Z.check('plan: an internal group in a job promotion is refused (403)', plInt.status === 403 && plInt.body.code === 'internal_contact', plInt.body);
  const plWa = await api('admin', 'POST', '/campaigns/plan', { ...body, channel: 'whatsapp' });
  Z.check('plan: WhatsApp now exists (2026-10-17), so an EMAIL message cannot be used for a WhatsApp campaign (400, plain words)', plWa.status === 400 && !!plWa.body.error, plWa.body);
  const tplNoApply = await mkTpl('No apply', 'Hi {{name}}\nStop: {{unsubscribe}}');
  const plNa = await api('admin', 'POST', '/campaigns/plan', { ...body, templateId: tplNoApply });
  Z.check('plan: a template without {{apply_link}} is refused in plain words', plNa.status === 400 && /apply link/i.test(plNa.body.error), plNa.body);
  const plIntTpl = await api('admin', 'POST', '/campaigns/plan', { ...body, templateId: tplInt });
  Z.check('plan: an internal template cannot be used for a job promotion', plIntTpl.status === 400, plIntTpl.body);
  const plClosed = await api('admin', 'POST', '/campaigns/plan', { ...body, requirementId: JClosed.id });
  Z.check('plan: a closed job cannot be promoted', plClosed.status === 400);
  const plNoSeg = await api('admin', 'POST', '/campaigns/plan', { ...body, segmentIds: [] });
  Z.check('plan: no group picked -> asks for one', plNoSeg.status === 400 && /group/i.test(plNoSeg.body.error));

  // ================================================================= 4. ROLE GATES
  const rolesBody = { ...body, segmentIds: [segA] };
  const rc = await api('rec', 'POST', '/campaigns', rolesBody);
  const mc = await api('mgr', 'POST', '/campaigns', rolesBody);
  const hc = await api('hr', 'POST', '/campaigns', rolesBody);
  const ac = await api('acct', 'POST', '/campaigns/plan', rolesBody);
  Z.check('recruiter / manager / HR / accountant cannot create a job campaign (403)', [rc, mc, hc, ac].every((r) => r.status === 403), [rc.status, mc.status, hc.status, ac.status]);
  const bdeSeg = await mkSeg('Bde group', { importIds: ['ZZOC3-A'] }, 'candidate_lead', 'bde');
  const bdeOk = await api('bde', 'POST', '/campaigns', { ...body, segmentIds: [bdeSeg], name: 'ZZTEST OC3 bde own' });
  Z.check('BDE can create a campaign for a job in their own area (with their own group)', bdeOk.status === 200, bdeOk.body);
  if (bdeOk.body && bdeOk.body.id) created.campaignIds.push(bdeOk.body.id);
  const bdeOther = await api('bde', 'POST', '/campaigns', { ...body, segmentIds: [bdeSeg], requirementId: JB.id });
  Z.check('BDE cannot promote a job outside their area (403)', bdeOther.status === 403 && /not in your area/i.test(bdeOther.body.error), bdeOther.body);
  const bdeAdminSeg = await api('bde', 'POST', '/campaigns/plan', { ...body, segmentIds: [segA] });
  Z.check("BDE cannot use another person's group (403)", bdeAdminSeg.status === 403, bdeAdminSeg.body);
  const tlSeg = await mkSeg('Tl group', { importIds: ['ZZOC3-A'] }, 'candidate_lead', 'tl');
  const tlOk = await api('tl', 'POST', '/campaigns/plan', { ...body, segmentIds: [tlSeg] });
  const tlOther = await api('tl', 'POST', '/campaigns/plan', { ...body, segmentIds: [tlSeg], requirementId: JB.id });
  Z.check('TL: own team job is fine, another team job is refused', tlOk.status === 200 && tlOther.status === 403, [tlOk.status, tlOther.status]);
  const jb = await api('bde', 'GET', '/campaigns/jobs');
  Z.check("job picker: BDE sees only jobs in their scope (A yes, B no, closed no); recruiter gets nothing", jb.status === 200 && jb.body.jobs.some((j) => j.id === JA.id) && !jb.body.jobs.some((j) => j.id === JB.id || j.id === JClosed.id) && (await api('rec', 'GET', '/campaigns/jobs')).body.jobs.length === 0, jb.body.jobs && jb.body.jobs.map((j) => j.title));
  const hrInt = await api('hr', 'POST', '/campaigns', { type: 'internal', segmentIds: [segInt], templateId: tplInt, name: 'ZZTEST OC3 staff off' });
  Z.check('HR desk cannot send internal campaigns until an Admin ticks "Internal HR may send" (403)', hrInt.status === 403 && /Internal HR may send/.test(hrInt.body.error), hrInt.body);
  const stSet = await api('bde', 'PUT', '/settings', { master: true });
  Z.check('only an Admin can change the sending settings', stSet.status === 403);
  const bdeTick = await api('bde', 'POST', '/runner/tick', {});
  Z.check('only an Admin can press "Send now"', bdeTick.status === 403);
  const bdeSending = await api('bde', 'GET', '/sending');
  Z.check('only an Admin can read the sending settings and webhook secret', bdeSending.status === 403);

  // ================================================================= 5. A REHEARSAL, end to end (test mode: rows + logs, nothing sent)
  const camp1 = await newCamp('admin', { name: 'rehearsal', job: JA.id, segs: [segA, segA2] });
  const draftView = await api('admin', 'GET', `/campaigns/${camp1}`);
  Z.check('a new campaign is a Draft with Send / Stop / delete-draft buttons for its owner', draftView.body.campaign.status === 'draft' && draftView.body.can.send && draftView.body.can.remove);
  const rec1 = await api('rec', 'GET', `/campaigns/${camp1}`);
  const recList = await api('rec', 'GET', '/campaigns');
  Z.check('recruiter sees the campaign of a job assigned to them, with no buttons', rec1.status === 200 && Object.values(rec1.body.can).every((v) => v === false) && recList.body.campaigns.some((c) => c.id === camp1) && recList.body.canCreate === false, [rec1.status, rec1.body && rec1.body.can]);
  const rec2v = await api('rec2', 'GET', `/campaigns/${camp1}`);
  Z.check('another recruiter (not on that job) does not see it (404)', rec2v.status === 404);
  const sendTwiceA = await Promise.all([api('admin', 'POST', `/campaigns/${camp1}/send`, { when: 'now' }), api('admin', 'POST', `/campaigns/${camp1}/send`, { when: 'now' })]);
  Z.check('pressing Send twice at once makes ONE send (the other gets "already sent")', sendTwiceA.filter((r) => r.status === 200).length === 1 && sendTwiceA.filter((r) => r.status === 409).length === 1, sendTwiceA.map((r) => r.status));
  const rows1 = await rowsOf(camp1);
  const c1 = await countBy(camp1);
  Z.check('rows: one per person (15), 7 queued, 8 skipped, each skip with a reason code', rows1.length === 15 && c1.queued === 7 && c1.skipped === 8 && rows1.filter((r) => r.status === 'skipped').every((r) => !!r.reason) && new Set(rows1.map((r) => r.contactId)).size === 15, c1);
  Z.check('only the queued rows carry a tracked token (skipped ones none); tokens are unique', rows1.filter((r) => r.status === 'queued').every((r) => Lk.verifyTracked(r.token)) && rows1.filter((r) => r.status === 'skipped').every((r) => !r.token) && new Set(rows1.filter((r) => r.token).map((r) => r.token)).size === 7);
  const cv = (await api('admin', 'GET', `/campaigns/${camp1}`)).body;
  Z.check('campaign is Running, mode = rehearsal, counts show Waiting 7 / Skipped 8', cv.campaign.status === 'running' && cv.campaign.mode === 'rehearsal' && cv.counts.waiting === 7 && cv.counts.skipped === 8, cv);
  const mock1 = mkMock();
  const t1 = await Run.tick({ mailSender: mock1 });
  const c1b = await countBy(camp1);
  Z.check('REHEARSAL: all 7 rows become test_captured; the mail sender was never called', t1.test_captured === 7 && c1b.test_captured === 7 && mock1.calls.length === 0, [t1, c1b, mock1.calls.length]);
  const logs1 = await S.q('SELECT status, mode FROM "OutreachSendLog" WHERE contactId IN (' + ids.map(() => '?').join(',') + ')', ...ids);
  Z.check('rehearsal wrote send-log rows with mode test and nothing with status sent', logs1.length >= 7 && logs1.every((l) => l.status === 'test_captured' && l.mode === 'test'));
  const cv1 = (await api('admin', 'GET', `/campaigns/${camp1}`)).body;
  Z.check('the campaign is Done after the last row; funnel has Sent 7 and Skipped 8 events; Applied is 0 ("after Phase 4")', cv1.campaign.status === 'done' && cv1.funnel.sent === 7 && cv1.funnel.skipped === 8 && cv1.funnel.applied === 0 && cv1.counts.sent === 7, [cv1.campaign.status, cv1.funnel]);

  // what the message says
  const sample = rows1.find((r) => r.status === 'queued');
  const sContact = (await S.q('SELECT * FROM "OutreachContact" WHERE id = ?', sample.contactId))[0];
  const snap = S.parse((await S.q('SELECT templateSnapshot FROM "OutreachCampaign" WHERE id = ?', camp1))[0].templateSnapshot, null);
  const msgOut = Camp.renderFor(snap, { contact: sContact, requirement: JA, message: sample, settings: await S.settings() });
  const campRow1 = (await S.q('SELECT * FROM "OutreachCampaign" WHERE id = ?', camp1))[0];
  Z.check('message text: first name, job title, the sender name as company (never the client), a short /r/<token> link, a valid unsubscribe link', msgOut.body.startsWith('Hi ZZTEST,') && msgOut.body.includes(JA.title) && msgOut.body.includes(`${(await S.settings()).fromName || 'TeamLink'} has a job`) && !msgOut.body.includes('ZZTEST OC3 Client') && msgOut.body.includes(`/r/${sample.token}`) && Lk.verifyUnsubscribe(msgOut.unsubscribeUrl.split('/u/')[1]).ok, msgOut.body);

  // ================================================================= 6. TRACKED LINK + CLICKS
  const tk = sample.token;
  Z.check('token: opaque (no contact id, name, email, phone in it), 20 characters, signed', tk.length === 20 && Lk.verifyTracked(tk) && !tk.includes(sContact.id) && !/zz|oc3|example/i.test(tk) && !Buffer.from(tk, 'base64url').toString('latin1').includes(sContact.name || 'x'));
  const tail = (u) => String(u || '').replace(/^https?:\/\/[^/]+/, '');
  const wantUrl = Lk.applyUrl(bridge.jobUrl(JA.id), { campaignCode: campRow1.code, token: tk, channel: 'email' });
  Z.check('apply URL form: <portal url>?cid=<campaign code>&ctk=<token>&ch=e#/job/tl_<job> (no name/phone/email)', /[?&]cid=/.test(wantUrl) && wantUrl.includes(`ctk=${tk}`) && wantUrl.includes('ch=e') && wantUrl.includes(`#/job/tl_${JA.id}`) && !/example|ZZTEST/i.test(wantUrl), wantUrl);
  await S.run('UPDATE "OutreachMessage" SET sentAt = ? WHERE id = ?', Date.now(), sample.id);
  const click0 = await Z.call('GET', `/api/public/outreach/r/${tk}`, null, undefined, { 'user-agent': HUMAN });
  Z.check('a click within seconds of the send is a mail scanner: redirects, is not counted', click0.status === 302 && tail(click0.headers.get('location')) === tail(wantUrl) && (await S.q('SELECT firstClickAt FROM "OutreachMessage" WHERE id = ?', sample.id))[0].firstClickAt == null, [click0.status, click0.headers.get('location')]);
  await S.run('UPDATE "OutreachMessage" SET sentAt = ? WHERE id = ?', Date.now() - 60000, sample.id);
  const bots = ['Googlebot/2.1 (+http://www.google.com/bot.html)', 'Microsoft Office Protocol Discovery', 'Mozilla/5.0 (compatible; Proofpoint URL Defense)', 'WhatsApp/2.23', 'python-requests/2.31', 'facebookexternalhit/1.1', 'curl/8.4', ' '];
  let botCounted = false; let botRedirects = true;
  for (const ua of bots) { const r = await Z.call('GET', `/api/public/outreach/r/${tk}`, null, undefined, { 'user-agent': ua }); botRedirects = botRedirects && r.status === 302; }
  botCounted = (await S.q('SELECT firstClickAt FROM "OutreachMessage" WHERE id = ?', sample.id))[0].firstClickAt != null;
  const headR = await Z.call('HEAD', `/api/public/outreach/r/${tk}`, null, undefined, { 'user-agent': HUMAN });
  Z.check('bots / scanners / link previews / HEAD: still redirected, never counted', botRedirects && !botCounted && headR.status === 302 && (await S.q('SELECT COUNT(*) n FROM "OutreachEvent" WHERE messageId = ? AND type = \'clicked\'', sample.id))[0].n == 0, { botRedirects, botCounted });
  const click1 = await Z.call('GET', `/api/public/outreach/r/${tk}`, null, undefined, { 'user-agent': HUMAN });
  const click2 = await Z.call('GET', `/r/${tk}`, null, undefined, { 'user-agent': HUMAN });
  const clickEv = await S.q('SELECT * FROM "OutreachEvent" WHERE messageId = ? AND type = \'clicked\'', sample.id);
  Z.check('first human click: redirected to the portal apply URL and counted ONCE (the root /r/<token> path works too, a second click adds nothing)', click1.status === 302 && tail(click1.headers.get('location')) === tail(wantUrl) && click2.status === 302 && tail(click2.headers.get('location')) === tail(wantUrl) && clickEv.length === 1 && (await S.q('SELECT firstClickAt FROM "OutreachMessage" WHERE id = ?', sample.id))[0].firstClickAt != null, [click1.status, click2.status, clickEv.length]);
  Z.check('the click event stores a user-agent CLASS only, no address, no IP', clickEv.length === 1 && /^\{"ua":"desktop"\}$/.test(clickEv[0].detail) && !/\d+\.\d+\.\d+\.\d+/.test(JSON.stringify(clickEv[0])));
  const forged = crypto.randomBytes(15).toString('base64url');
  const tampered = `${tk.slice(0, -1)}${tk.slice(-1) === 'A' ? 'B' : 'A'}`;
  const minted = Lk.mintTracked({ contactType: 'candidate_lead', campaignType: 'job_promotion' });
  const fr = [forged, tampered, minted, 'short', 'x'.repeat(40), '..%2f..%2fetc'].map((t) => Z.call('GET', `/api/public/outreach/r/${t}`, null, undefined, { 'user-agent': HUMAN }));
  const frs = await Promise.all(fr);
  Z.check('forged / tampered / never-issued / malformed tokens: 404, no redirect', frs.every((r) => r.status === 404 && !r.headers.get('location')), frs.map((r) => r.status));
  const open = await Z.call('GET', `/api/public/outreach/r/${tk}?url=https://evil.example/x&next=//evil.example&redirect=http://evil.example`, null, undefined, { 'user-agent': HUMAN });
  Z.check('no open redirect: extra address parameters change nothing, the target is built from the campaign job', open.status === 302 && tail(open.headers.get('location')) === tail(wantUrl) && !/evil/.test(open.headers.get('location')));
  const clicksNow = await Camp.countsFor([camp1]);
  Z.check('campaign counts show Clicked 1', clicksNow[camp1].clicked === 1);

  // ================================================================= 7. INTERNAL CAMPAIGN: no link, no events
  await setS({ internalHrMaySend: true });
  const intId = await (async () => { const r = await api('hr', 'POST', '/campaigns', { type: 'internal', segmentIds: [segInt], templateId: tplInt, name: 'ZZTEST OC3 staff note' }); if (r.status !== 200) throw new Error(JSON.stringify(r.body)); created.campaignIds.push(r.body.id); return r.body.id; })();
  const hrSend = await api('hr', 'POST', `/campaigns/${intId}/send`, { when: 'now' });
  const intRows = await rowsOf(intId);
  Z.check('HR may send an internal campaign once an Admin allowed it; 2 staff rows queued, NO token on any row', hrSend.status === 200 && intRows.length === 2 && intRows.every((r) => r.status === 'queued' && r.token == null && r.requirementId == null), [hrSend.status, hrSend.body]);
  const mockI = mkMock();
  await Run.tick({ mailSender: mockI });
  const evI = S.num((await S.q('SELECT COUNT(*) n FROM "OutreachEvent" WHERE campaignId = ?', intId))[0].n);
  const cI = await countBy(intId);
  Z.check('internal campaign runs (rehearsal), writes NO funnel events at all', cI.test_captured === 2 && evI === 0 && mockI.calls.length === 0, [cI, evI]);
  Z.check('mintTracked refuses internal; the click route has nothing to resolve for internal messages', (() => { try { Lk.mintTracked({ contactType: 'internal' }); return false; } catch (e) { return e.code === 'internal_no_link'; } })() && (await Camp.resolveClick(minted)).status === 404);
  const evRecordInternal = await Ev.record('sent', { id: 'x', contactId: 'y', campaignId: 'z' }, { type: 'internal' });
  Z.check('events.record() refuses internal campaigns', evRecordInternal.skipped === 'internal');
  const hrSee = await api('hr', 'GET', '/campaigns');
  Z.check('HR sees internal campaigns only (not job campaigns)', hrSee.body.campaigns.length >= 1 && hrSee.body.campaigns.every((c) => c.type === 'internal'));
  const intForced = await api('hr', 'POST', '/campaigns', { type: 'internal', segmentIds: [segA], templateId: tplInt, name: 'ZZTEST OC3 staff wrong group' });
  Z.check('an internal campaign cannot use a lead group (403)', intForced.status === 403, intForced.body);
  await setS({ internalHrMaySend: false });
  // runner-level hard rule: an internal contact forced into a job campaign's queue is skipped, never sent
  const hardPool = await pool('HARD', 2);
  const hardCamp = await newCamp('admin', { name: 'hard rule', job: hardPool.job, segs: [hardPool.seg] });
  await api('admin', 'POST', `/campaigns/${hardCamp}/send`, { when: 'now' });
  await S.run('INSERT INTO "OutreachMessage" (id, campaignId, contactId, channel, requirementId, status, token, idempotencyKey, nextRunAt, queuedAt) VALUES (?,?,?,?,?,\'queued\',?,?,0,?)', S.newId('om'), hardCamp, I1, 'email', hardPool.job, Lk.mintTracked({ contactType: 'candidate_lead' }), `${hardCamp}:${I1}:email`, Date.now());
  await makeLive(hardCamp); await setS({ emailTestMode: false });
  const mockH = mkMock();
  await Run.tick({ mailSender: mockH });
  const hardRow = (await S.q('SELECT status, reason FROM "OutreachMessage" WHERE campaignId = ? AND contactId = ?', hardCamp, I1))[0];
  Z.check('HARD RULE at send time: an internal contact forced into a job queue is skipped (internal_contact); the two real people were sent', hardRow.status === 'skipped' && hardRow.reason === 'internal_contact' && mockH.calls.length === 2 && !mockH.calls.includes(em('int1')), [hardRow, mockH.calls]);
  await setS({ emailTestMode: true });

  // ================================================================= 8. QUEUE: double worker, crash, resume
  const P1 = await pool('Q1', 14);
  const q1 = await newCamp('admin', { name: 'double worker', job: P1.job, segs: [P1.seg] });
  await api('admin', 'POST', `/campaigns/${q1}/send`, { when: 'now' });
  await makeLive(q1); await setS({ emailTestMode: false });
  const mockQ = mkMock();
  await Promise.all([Run.tick({ workerId: 'zzoc3-w1', mailSender: mockQ, maxMessages: 30 }), Run.tick({ workerId: 'zzoc3-w2', mailSender: mockQ, maxMessages: 30 }), Run.tick({ workerId: 'zzoc3-w3', mailSender: mockQ, maxMessages: 30 })]);
  const perTo = {}; mockQ.calls.forEach((t) => { perTo[t] = (perTo[t] || 0) + 1; });
  const cq = await countBy(q1);
  Z.check('DOUBLE WORKER (3 at once): every one of the 14 people got exactly ONE send, none twice', mockQ.calls.length === 14 && Object.keys(perTo).length === 14 && Object.values(perTo).every((n) => n === 1) && cq.sent === 14, [mockQ.calls.length, cq]);
  const lock = await Run.acquireLease('zzoc3-a'); const lock2 = await Run.acquireLease('zzoc3-b'); const lock1b = await Run.acquireLease('zzoc3-a');
  await Run.releaseLease('zzoc3-a'); const lock3 = await Run.acquireLease('zzoc3-b'); await Run.releaseLease('zzoc3-b');
  Z.check('lease: only one sending loop at a time (a second holder is refused until the first lets go)', lock && !lock2 && lock1b && lock3);
  // kill mid-run
  const P2 = await pool('Q2', 8);
  const q2 = await newCamp('admin', { name: 'crash', job: P2.job, segs: [P2.seg] });
  await api('admin', 'POST', `/campaigns/${q2}/send`, { when: 'now' });
  await makeLive(q2);
  const mockC = mkMock();
  let died = false;
  try { await Run.tick({ mailSender: mockC, maxMessages: 30, afterEach: async (m, r, ) => { if (mockC.calls.length >= 3) { died = true; throw new Error('simulated process death'); } } }); } catch (e) { /* the "kill" */ }
  const before = mockC.calls.length;
  // two rows were claimed by the dead worker: one before the mail server was called, one after
  const q2rows = await S.q('SELECT * FROM "OutreachMessage" WHERE campaignId = ? AND status = \'queued\' ORDER BY id', q2);
  const stuckA = (await Run.claimOne('zzoc3-dead', { perMinute: 600 })); const stuckB = (await Run.claimOne('zzoc3-dead', { perMinute: 600 }));
  await S.run('UPDATE "OutreachMessage" SET sendStartedAt = ? WHERE id = ?', Date.now() - 20 * 60000, stuckB.id);
  await S.run('UPDATE "OutreachMessage" SET lockedAt = ? WHERE id IN (?, ?)', Date.now() - 20 * 60000, stuckA.id, stuckB.id);
  const rec0 = await Run.recoverStale({ staleMs: 10 * 60000 });
  const aRow = (await S.q('SELECT status, attempts FROM "OutreachMessage" WHERE id = ?', stuckA.id))[0]; const bRow = (await S.q('SELECT status, reason FROM "OutreachMessage" WHERE id = ?', stuckB.id))[0];
  Z.check('crash recovery: a row that never reached the mail server goes back to the queue; one that might have is "unknown" (never re-sent by the machine)', died && aRow.status === 'queued' && bRow.status === 'unknown' && bRow.reason === 'interrupted', [aRow, bRow, rec0]);
  await Run.tick({ mailSender: mockC, maxMessages: 30 });
  const perToC = {}; mockC.calls.forEach((t) => { perToC[t] = (perToC[t] || 0) + 1; });
  const cc = await countBy(q2);
  Z.check('RESUME after the kill: zero duplicate sends; the unsure row was not sent again; everything else was sent', Object.values(perToC).every((n) => n === 1) && cc.unknown === 1 && cc.sent === 7 && mockC.calls.length === 7 && mockC.calls.length >= before, [cc, mockC.calls.length]);
  const ucontact = (await S.q('SELECT email FROM "OutreachContact" WHERE id = ?', stuckB.contactId))[0].email;
  Z.check('the "unknown" person was never handed to the mail server', !mockC.calls.includes(ucontact));
  // the send itself stopping while the rows are made, then finishing
  const P3 = await pool('Q3', 9);
  const q3 = await newCamp('admin', { name: 'half made', job: P3.job, segs: [P3.seg] });
  await S.run('UPDATE "OutreachCampaign" SET status = \'preparing\', mode = \'rehearsal\', updatedAt = ? WHERE id = ?', Date.now() - 60000, q3);
  let threw = false; try { await Camp.materialize(q3, { batch: 3, failAfterBatches: 1 }); } catch { threw = true; }
  const half = (await rowsOf(q3)).length;
  const fin = await Run.finishPreparing(Date.now(), 0);
  const all = (await rowsOf(q3)).length;
  const again = await Camp.materialize(q3, { batch: 4 });
  const q3c = (await S.q('SELECT status FROM "OutreachCampaign" WHERE id = ?', q3))[0].status;
  await api('admin', 'POST', `/campaigns/${q3}/stop`, {});
  Z.check('rows made in batches: a stop in the middle leaves a part; the worker finishes the rest; running it again adds nothing (9 people, 9 rows, then Running)', threw && half === 3 && fin >= 1 && all === 9 && (await rowsOf(q3)).length === 9 && again.queued === 9 && q3c === 'running', [half, all, q3c]);

  // ================================================================= 9. RETRY / BACKOFF
  const P4 = await pool('Q4', 3);
  const q4 = await newCamp('admin', { name: 'retry', job: P4.job, segs: [P4.seg] });
  await api('admin', 'POST', `/campaigns/${q4}/send`, { when: 'now' });
  await makeLive(q4); await setS({ emailTestMode: false });
  const tries = {};
  const retryMock = mkMock((m) => {
    tries[m.to] = (tries[m.to] || 0) + 1;
    if (m.to === em('Q41')) return tries[m.to] < 3 ? { ok: false, transient: true, error: 'connection timed out' } : { ok: true, providerRef: '<zz-retry-ok>' }; // fails twice, third works
    if (m.to === em('Q42')) return { ok: false, transient: true, error: 'connection timed out' }; // always
    return { ok: false, transient: false, error: '550 mailbox does not exist' }; // definitive
  });
  const T0 = Date.now() + 3600000; // simulated clock (an hour ahead so the earlier rows never interfere)
  await S.run('UPDATE "OutreachMessage" SET nextRunAt = ? WHERE campaignId = ?', T0 - 1, q4);
  await Run.tick({ now: T0, mailSender: retryMock, noComplete: true });
  const r1 = await S.q('SELECT m.status, m.attempts, m.nextRunAt, c.email FROM "OutreachMessage" m JOIN "OutreachContact" c ON c.id = m.contactId WHERE m.campaignId = ?', q4);
  const byMail = Object.fromEntries(r1.map((r) => [r.email, r]));
  Z.check('transient error: back in the queue with a delay (backoff 2 min); definitive refusal: failed at once, not retried', byMail[em('Q41')].status === 'queued' && S.ms(byMail[em('Q41')].nextRunAt) === T0 + Run.BACKOFF[0] && byMail[em('Q42')].status === 'queued' && byMail[em('Q43')].status === 'failed' && tries[em('Q43')] === 1, r1);
  await Run.tick({ now: T0 + 60000, mailSender: retryMock, noComplete: true });
  Z.check('not tried again before the backoff has passed', tries[em('Q41')] === 1 && tries[em('Q42')] === 1);
  await Run.tick({ now: T0 + Run.BACKOFF[0] + 1000, mailSender: retryMock, noComplete: true });
  Z.check('2nd attempt after the backoff; the second delay is longer (10 min)', tries[em('Q41')] === 2 && (await S.q('SELECT nextRunAt FROM "OutreachMessage" m JOIN "OutreachContact" c ON c.id = m.contactId WHERE m.campaignId = ? AND c.email = ?', q4, em('Q41')))[0].nextRunAt != null && S.ms((await S.q('SELECT m.nextRunAt FROM "OutreachMessage" m JOIN "OutreachContact" c ON c.id = m.contactId WHERE m.campaignId = ? AND c.email = ?', q4, em('Q41')))[0].nextRunAt) === T0 + Run.BACKOFF[0] + 1000 + Run.BACKOFF[1]);
  await Run.tick({ now: T0 + 60 * 60000, mailSender: retryMock, noComplete: true });
  const r3 = await S.q('SELECT m.status, m.attempts, m.reason, c.email FROM "OutreachMessage" m JOIN "OutreachContact" c ON c.id = m.contactId WHERE m.campaignId = ?', q4);
  const bm3 = Object.fromEntries(r3.map((r) => [r.email, r]));
  Z.check('3rd attempt: the one that recovers is sent (attempts 3); the one that never works is "gave_up" after 3 tries and is not tried a 4th time', bm3[em('Q41')].status === 'sent' && bm3[em('Q41')].attempts === 3 && bm3[em('Q42')].status === 'failed' && bm3[em('Q42')].reason === 'gave_up' && tries[em('Q42')] === 3, r3);
  await Run.tick({ now: T0 + 5 * 60 * 60000, mailSender: retryMock, noComplete: true });
  Z.check('nothing is retried again afterwards (a definitive failure and a gave-up stay as they are)', tries[em('Q42')] === 3 && tries[em('Q43')] === 1 && tries[em('Q41')] === 3);
  const failEv = await S.q('SELECT type FROM "OutreachEvent" WHERE campaignId = ?', q4);
  Z.check('funnel: 1 sent and 2 failed events', failEv.filter((e) => e.type === 'sent').length === 1 && failEv.filter((e) => e.type === 'failed').length === 2, failEv.map((e) => e.type));
  await setS({ emailTestMode: true });

  // ================================================================= 10. PAUSE / RESUME / STOP
  const P5 = await pool('Q5', 10);
  const q5 = await newCamp('admin', { name: 'pause', job: P5.job, segs: [P5.seg] });
  await api('admin', 'POST', `/campaigns/${q5}/send`, { when: 'now' });
  const p1 = await Run.tick({ maxMessages: 3, noComplete: true, mailSender: mkMock() });
  const pa = await api('admin', 'POST', `/campaigns/${q5}/pause`, {});
  const p2 = await Run.tick({ maxMessages: 10, noComplete: true, mailSender: mkMock() });
  const pausedCounts = await countBy(q5);
  Z.check('PAUSE: 3 were handled, then paused; a paused campaign hands out nothing more (7 still waiting)', p1.test_captured === 3 && pa.status === 200 && p2.test_captured === 0 && pausedCounts.queued === 7 && pausedCounts.test_captured === 3, [p1, p2, pausedCounts]);
  const resumeBad = await api('admin', 'POST', `/campaigns/${camp1}/resume`, {});
  const rs = await api('admin', 'POST', `/campaigns/${q5}/resume`, {});
  const p3 = await Run.tick({ maxMessages: 4, noComplete: true, mailSender: mkMock() });
  Z.check('RESUME: sending continues from where it stopped; resuming a finished campaign is refused (409)', rs.status === 200 && p3.test_captured === 4 && resumeBad.status === 409, [rs.status, p3, resumeBad.status]);
  let paused2 = false;
  const p4 = await Run.tick({ maxMessages: 10, noComplete: true, mailSender: mkMock(), afterEach: async (m) => { if (!paused2) { paused2 = true; await api('admin', 'POST', `/campaigns/${q5}/pause`, {}); } } });
  Z.check('pause is honoured BETWEEN messages: pressing Pause after one message stops the loop right there', p4.test_captured === 1, p4);
  await api('admin', 'POST', `/campaigns/${q5}/resume`, {});
  const stopR = await api('admin', 'POST', `/campaigns/${q5}/stop`, {});
  const p5 = await Run.tick({ maxMessages: 10, noComplete: true, mailSender: mkMock() });
  const stopCounts = await countBy(q5);
  Z.check('STOP: the rest is cancelled (2 people not messaged), nothing is sent afterwards, the campaign is Stopped', stopR.status === 200 && stopCounts.cancelled === 2 && p5.test_captured === 0 && (await api('admin', 'GET', `/campaigns/${q5}`)).body.campaign.status === 'stopped', stopCounts);
  const stopTwice = await api('admin', 'POST', `/campaigns/${q5}/stop`, {});
  Z.check('stopping twice is refused (409)', stopTwice.status === 409);
  const bdeStop = await api('bde', 'POST', `/campaigns/${q3}/stop`, {});
  Z.check('a BDE cannot stop a campaign of a job outside their area (404)', bdeStop.status === 404 || bdeStop.status === 403, bdeStop.status);

  // ================================================================= 11. TEST MODE SENDS NOTHING (even a live campaign is held)
  const P6 = await pool('Q6', 3);
  const q6 = await newCamp('admin', { name: 'held', job: P6.job, segs: [P6.seg] });
  await api('admin', 'POST', `/campaigns/${q6}/send`, { when: 'now' });
  await makeLive(q6); await setS({ emailTestMode: true });
  const mockT = mkMock();
  const th = await Run.tick({ mailSender: mockT, noComplete: true });
  Z.check('a LIVE campaign is held while test mode is ON: nothing handed to the mail sender', th.held === 3 && mockT.calls.length === 0 && (await countBy(q6)).queued === 3, [th, mockT.calls.length]);
  const swOff = await setS({ master: false });
  const t0 = await Run.tick({ mailSender: mockT });
  Z.check('"Outreach sending" OFF: the worker does nothing at all', t0.skippedTick === 'sending_off' && mockT.calls.length === 0);
  await setS({ master: true, emailTestMode: false });
  const th2 = await Run.tick({ mailSender: mockT, now: Date.now() + 120000 });
  Z.check('with test mode OFF the held live campaign is sent through the (mock) sender', mockT.calls.length === 3 && (await countBy(q6)).sent === 3, [mockT.calls.length, th2]);
  await setS({ emailTestMode: true });
  const stRehearsalForced = await (async () => { const P = await pool('Q6b', 2); const c = await newCamp('admin', { name: 'rehearsal forced', job: P.job, segs: [P.seg] }); await api('admin', 'POST', `/campaigns/${c}/send`, { when: 'now' }); await setS({ emailTestMode: false }); const m = mkMock(); await Run.tick({ mailSender: m }); await setS({ emailTestMode: true }); return { calls: m.calls.length, st: await countBy(c) }; })();
  Z.check('a campaign pressed as a REHEARSAL stays a rehearsal even if test mode is switched off afterwards', stRehearsalForced.calls === 0 && stRehearsalForced.st.test_captured === 2, stRehearsalForced);

  // ================================================================= 12. RATE LIMIT + DAILY CAP
  const P7 = await pool('Q7', 8);
  const q7 = await newCamp('admin', { name: 'rate', job: P7.job, segs: [P7.seg] });
  await api('admin', 'POST', `/campaigns/${q7}/send`, { when: 'now' });
  await setS({ emailPerMinute: 3 });
  const base7 = Date.now() + 10 * 3600000;
  await S.run('UPDATE "OutreachMessage" SET nextRunAt = ? WHERE campaignId = ?', base7 - 1, q7);
  const r7a = await Run.tick({ now: base7, maxMessages: 10, noComplete: true, mailSender: mkMock() });
  const r7b = await Run.tick({ now: base7 + 5000, maxMessages: 10, noComplete: true, mailSender: mkMock() });
  const r7c = await Run.tick({ now: base7 + 61000, maxMessages: 10, noComplete: true, mailSender: mkMock() });
  Z.check('PER-MINUTE limit: 3 in the first minute (a second pass in the same minute sends 0), 3 more a minute later', r7a.test_captured === 3 && r7b.test_captured === 0 && r7c.test_captured === 3, [r7a.test_captured, r7b.test_captured, r7c.test_captured]);
  await setS({ emailPerMinute: 600 });
  const sentNow = await email.sentToday('test', base7 + 120000);
  await setS({ emailDailyCap: sentNow + 1 });
  const r7d = await Run.tick({ now: base7 + 120000, maxMessages: 10, noComplete: true, mailSender: mkMock() });
  const left7 = await S.q('SELECT status, attempts, nextRunAt FROM "OutreachMessage" WHERE campaignId = ? AND status = \'queued\'', q7);
  Z.check('DAILY CAP: stops at the daily limit; the rest wait for tomorrow with no failed try counted', r7d.test_captured === 1 && r7d.cap >= 1 && left7.length === 1 && S.num(left7[0].attempts) === 0 && S.ms(left7[0].nextRunAt) > base7 + 120000, [r7d, left7]);
  await setS({ emailDailyCap: 100000 });
  await S.run('UPDATE "OutreachMessage" SET nextRunAt = 0 WHERE campaignId = ? AND status = \'queued\'', q7);
  await Run.tick({ maxMessages: 10, mailSender: mkMock() });

  // ================================================================= 13. SCHEDULED START
  const P8 = await pool('Q8', 3);
  const q8 = await newCamp('admin', { name: 'scheduled', job: P8.job, segs: [P8.seg] });
  const pastTry = await api('admin', 'POST', `/campaigns/${q8}/send`, { when: 'at', at: new Date(Date.now() - 3600000).toISOString() });
  const at8 = Date.now() + 2 * 60000;
  const sch = await api('admin', 'POST', `/campaigns/${q8}/send`, { when: 'at', at: new Date(at8).toISOString() });
  const tn = await Run.tick({ mailSender: mkMock() });
  const stNow = (await api('admin', 'GET', `/campaigns/${q8}`)).body.campaign;
  Z.check('SCHEDULED: a time in the past is refused; a future time = status Scheduled, rows made, nothing sent before the time', pastTry.status === 400 && sch.status === 200 && stNow.status === 'scheduled' && tn.test_captured === 0 && (await countBy(q8)).queued === 3, [pastTry.status, sch.status, stNow.status]);
  const tAt = await Run.tick({ now: at8 + 1000, mailSender: mkMock() });
  const stAfter = (await api('admin', 'GET', `/campaigns/${q8}`)).body.campaign;
  Z.check('SCHEDULED: at the time it starts by itself and finishes (Running -> Done)', tAt.test_captured === 3 && stAfter.status === 'done' && !!stAfter.startedAt, [tAt, stAfter.status]);
  const pauseSched = await (async () => { const P = await pool('Q8b', 2); const c = await newCamp('admin', { name: 'sched pause', job: P.job, segs: [P.seg] }); await api('admin', 'POST', `/campaigns/${c}/send`, { when: 'at', at: new Date(Date.now() + 3600000).toISOString() }); const pz = await api('admin', 'POST', `/campaigns/${c}/pause`, {}); const rz = await api('admin', 'POST', `/campaigns/${c}/resume`, {}); return [pz.status, rz.status, rz.body.campaign.status]; })();
  Z.check('a scheduled campaign can be paused and resumed (resume goes back to Scheduled)', pauseSched[0] === 200 && pauseSched[1] === 200 && pauseSched[2] === 'scheduled', pauseSched);

  // ================================================================= 14. SUPPRESSION AT SEND TIME + the same-job window
  const P9 = await pool('Q9', 4);
  const q9 = await newCamp('admin', { name: 'late stop', job: P9.job, segs: [P9.seg] });
  await api('admin', 'POST', `/campaigns/${q9}/send`, { when: 'now' });
  const lateOut = await S.q('SELECT contactId FROM "OutreachMessage" WHERE campaignId = ? ORDER BY id LIMIT 1', q9);
  const lc = require(path.join(BACK, 'src/outreach/consent'));
  await lc.optOut(lateOut[0].contactId, 'email', { reason: 'unsubscribe_link', source: 'test', evidence: 'test' });
  const mockL = mkMock();
  await makeLive(q9); await setS({ emailTestMode: false });
  await Run.tick({ mailSender: mockL });
  await setS({ emailTestMode: true });
  const lateRow = (await S.q('SELECT status, reason FROM "OutreachMessage" WHERE campaignId = ? AND contactId = ?', q9, lateOut[0].contactId))[0];
  Z.check('a STOP that arrives while the message waits is honoured at send time (skipped: opted_out); the others are sent', lateRow.status === 'skipped' && ['opted_out', 'suppressed'].includes(lateRow.reason) && mockL.calls.length === 3, [lateRow, mockL.calls.length]);
  // the same job again within N days: a second LIVE campaign for Q9's job
  const q9b = await newCamp('admin', { name: 'same job again', job: P9.job, segs: [P9.seg] });
  await api('admin', 'POST', `/campaigns/${q9b}/send`, { when: 'now' });
  const c9b = await countBy(q9b);
  Z.check('the same job within the window: people messaged by the earlier live campaign are skipped (recently_messaged), the opted-out one too', c9b.skipped === 4 && (await S.q('SELECT COUNT(*) n FROM "OutreachMessage" WHERE campaignId = ? AND reason = \'recently_messaged\'', q9b))[0].n == 3, c9b);
  await setS({ suppressDays: 0 });
  const plan0 = await api('admin', 'POST', '/campaigns/plan', { type: 'job_promotion', requirementId: P9.job, segmentIds: [P9.seg], templateId: tplJob });
  Z.check('the window is an Admin setting: with 0 days nobody is held back for "messaged recently"', plan0.status === 200 && (plan0.body.reasons.recently_messaged || 0) === 0, plan0.body.reasons);
  await setS({ suppressDays: 7 });

  // ================================================================= 15. WEBHOOK
  const P10 = await pool('Q10', 4);
  const q10 = await newCamp('admin', { name: 'webhook', job: P10.job, segs: [P10.seg] });
  await api('admin', 'POST', `/campaigns/${q10}/send`, { when: 'now' });
  await makeLive(q10); await setS({ emailTestMode: false });
  const mockW = mkMock();
  await Run.tick({ mailSender: mockW });
  await setS({ emailTestMode: true });
  const wrows = await S.q('SELECT m.*, c.email FROM "OutreachMessage" m JOIN "OutreachContact" c ON c.id = m.contactId WHERE m.campaignId = ? ORDER BY m.id', q10);
  const post = (bodyObj, over = {}) => {
    const raw = JSON.stringify(bodyObj); const ts = String(over.ts || Math.floor(Date.now() / 1000));
    const sig = over.sig || Hook.sign(ts, raw);
    return Z.call('POST', '/api/public/outreach/webhook/email', null, bodyObj, { 'x-outreach-timestamp': ts, 'x-outreach-signature': sig });
  };
  const e1 = { eventId: `zzoc3-${RUN}-1`, type: 'delivered', providerRef: wrows[0].providerRef, at: new Date().toISOString() };
  const noSig = await Z.call('POST', '/api/public/outreach/webhook/email', null, { events: [e1] });
  const badSig = await post({ events: [e1] }, { sig: 'a'.repeat(64) });
  const stale = await post({ events: [e1] }, { ts: Math.floor(Date.now() / 1000) - 3600 });
  Z.check('webhook: no signature, a wrong signature, or a timestamp an hour old = 401 and nothing changes', noSig.status === 401 && badSig.status === 401 && stale.status === 401 && (await S.q('SELECT status FROM "OutreachMessage" WHERE id = ?', wrows[0].id))[0].status === 'sent');
  const okWh = await post({ events: [e1] });
  const dupWh = await post({ events: [e1] });
  const delEv = await S.q('SELECT COUNT(*) n FROM "OutreachEvent" WHERE messageId = ? AND type = \'delivered\'', wrows[0].id);
  Z.check('webhook: delivered -> Delivered; the SAME event again is a no-op (idempotent by provider event id)', okWh.status === 200 && okWh.body.updated === 1 && dupWh.body.duplicates === 1 && dupWh.body.updated === 0 && (await S.q('SELECT status FROM "OutreachMessage" WHERE id = ?', wrows[0].id))[0].status === 'delivered' && delEv[0].n == 1, [okWh.body, dupWh.body, Number(delEv[0].n), wrows[0].providerRef, wrows[0].status]);
  const hard = await post({ events: [{ eventId: `zzoc3-${RUN}-2`, type: 'bounce', bounceType: 'hard', providerRef: wrows[1].providerRef }] });
  const lateDel = await post({ events: [{ eventId: `zzoc3-${RUN}-3`, type: 'delivered', providerRef: wrows[1].providerRef }] });
  const hrow = (await S.q('SELECT status, reason FROM "OutreachMessage" WHERE id = ?', wrows[1].id))[0];
  const hch = (await S.q('SELECT optIn, health FROM "OutreachContactChannel" WHERE contactId = ? AND channel = \'email\'', wrows[1].contactId))[0];
  const hsup = await lc.isSuppressedHash(S.hashAddress('email', wrows[1].email), 'email');
  Z.check('webhook: a hard bounce wins, is never undone by a late "delivered", marks the address bad, opts out and puts it on the do-not-contact list', hard.body.updated === 1 && hrow.status === 'bounced' && hrow.reason === 'hard_bounce' && hch.optIn === 'opted_out' && hch.health === 'hard_bounced' && hsup && lateDel.body.updated === 0, [hard.status, hard.body, hrow, hch, hsup, wrows[1].providerRef]);
  const comp = await post({ events: [{ eventId: `zzoc3-${RUN}-4`, type: 'complaint', providerRef: wrows[2].providerRef }] });
  const crow = (await S.q('SELECT status FROM "OutreachMessage" WHERE id = ?', wrows[2].id))[0];
  const cch = (await S.q('SELECT optIn, health FROM "OutreachContactChannel" WHERE contactId = ? AND channel = \'email\'', wrows[2].contactId))[0];
  Z.check('webhook: a spam complaint -> complained, opted out, health complained, on the do-not-contact list', comp.body.updated === 1 && crow.status === 'complained' && cch.optIn === 'opted_out' && cch.health === 'complained' && await lc.isSuppressedHash(S.hashAddress('email', wrows[2].email), 'email'));
  const soft = await post({ events: [{ eventId: `zzoc3-${RUN}-5`, type: 'bounce', bounceType: 'soft', providerRef: wrows[3].providerRef }] });
  const srow = (await S.q('SELECT status FROM "OutreachMessage" WHERE id = ?', wrows[3].id))[0];
  const sch2 = (await S.q('SELECT optIn FROM "OutreachContactChannel" WHERE contactId = ? AND channel = \'email\'', wrows[3].contactId))[0];
  Z.check('webhook: a soft bounce is a failure but does NOT suppress the person', soft.body.updated === 1 && srow.status === 'failed' && sch2.optIn === 'opted_in');
  const unm = await post({ events: [{ eventId: `zzoc3-${RUN}-6`, type: 'delivered', providerRef: '<nobody@zz>' }, { eventId: '', type: 'delivered' }, { eventId: `zzoc3-${RUN}-7`, type: 'weird' }] });
  Z.check('webhook: unknown message / bad events are answered 200 and ignored', unm.status === 200 && unm.body.unmatched === 1 && unm.body.ignored === 2, unm.body);
  // the new people: the bounced / complained ones are skipped in the next campaign
  const evW = await Sup.evaluate({ id: 'zz-none', type: 'job_promotion', channel: 'email', requirementId: P10.job }, wrows.map((r) => r.contactId), { days: 0 });
  Z.check('after bounce / complaint the engine skips them (suppressed / opted_out) in any later campaign', evW.filter((r) => !r.decision.send).length === 2, evW.map((r) => r.decision.reason));
  const adminSending = await api('admin', 'GET', '/sending');
  Z.check('Admin can read the webhook address and the secret', adminSending.status === 200 && adminSending.body.webhook.path === '/api/public/outreach/webhook/email' && adminSending.body.webhook.secret === Hook.secret());

  // ================================================================= 16. test send to myself
  const ts1 = await api('admin', 'POST', '/campaigns/test-send', { type: 'job_promotion', requirementId: JA.id, templateId: tplJob });
  const selfLog = await S.q('SELECT status, mode, toMasked FROM "OutreachSendLog" WHERE contactId = ? ORDER BY at DESC', `self:${admin.id}`);
  Z.check('"Send a small test to myself": in test mode it is captured (nothing sent), goes to the sender only', ts1.status === 200 && ts1.body.status === 'test_captured' && /nothing was really sent/i.test(ts1.body.words) && selfLog.length >= 1 && selfLog[0].mode === 'test', [ts1.body, selfLog]);
  const tsRec = await api('rec', 'POST', '/campaigns/test-send', { type: 'job_promotion', requirementId: JA.id, templateId: tplJob });
  Z.check('a recruiter cannot use it (403)', tsRec.status === 403);
  const selfRefuse = await email.send({ id: 'self:x', contactType: 'self', email: 'a@zz.test' }, { subject: 'x', body: 'x', kind: 'job_promotion', promotional: true, unsubscribeUrl: 'u' }, { selfTest: true });
  Z.check('the self-test path cannot be used for a promotion (refused)', selfRefuse.status === 'refused' && selfRefuse.reason === 'self_test_only');

  // ================================================================= 17. admin "Send now", drafts, misc
  const adminTick = await api('admin', 'POST', '/runner/tick', {});
  Z.check('Admin "Send now" runs one pass', adminTick.status === 200 && adminTick.body.ok);
  await api('admin', 'PUT', '/settings', { master: false });
  const offTick = await api('admin', 'POST', '/runner/tick', {});
  Z.check('"Send now" says so when sending is switched OFF (400)', offTick.status === 400);
  const sv = await api('admin', 'PUT', '/settings', { suppressDays: 9, emailPerMinute: 40, internalHrMaySend: true, master: true });
  const svBad = await api('admin', 'PUT', '/settings', { suppressDays: -1 });
  const svBad2 = await api('admin', 'PUT', '/settings', { emailPerMinute: 0 });
  Z.check('settings: valid values are saved, nonsense is refused in words', sv.status === 200 && sv.body.settings.suppressDays === 9 && sv.body.settings.emailPerMinute === 40 && sv.body.settings.internalHrMaySend === true && svBad.status === 400 && svBad2.status === 400);
  await setS({ suppressDays: 7, emailPerMinute: 600, internalHrMaySend: false });
  const dr = await newCamp('admin', { name: 'delete me', job: JA.id, segs: [segA] });
  const del = await api('admin', 'DELETE', `/campaigns/${dr}`);
  const delSent = await api('admin', 'DELETE', `/campaigns/${camp1}`);
  Z.check('a draft can be deleted; a sent campaign cannot (409)', del.status === 200 && delSent.status === 409);
  const msgs = await api('admin', 'GET', `/campaigns/${camp1}/messages?status=skipped`);
  const msgsRec = await api('rec', 'GET', `/campaigns/${camp1}/messages`);
  const msgsBde = await api('bde', 'GET', `/campaigns/${camp1}/messages`);
  Z.check('message list: skip reasons in words; Admin sees full addresses, a recruiter sees them masked', msgs.body.total === 8 && msgs.body.messages.every((m) => m.reasonWords) && msgs.body.messages.some((m) => /@/.test(m.email) && !/•/.test(m.email)) && msgsRec.body.messages.every((m) => !m.email || /•/.test(m.email)) && msgsRec.body.masked === true && msgsBde.status === 200, [msgs.body.messages[0], msgsRec.body.messages[0]]);
  const msgsFilter = await api('admin', 'GET', `/campaigns/${camp1}/messages?status=test_captured`);
  Z.check('message list filters by status (7 test_captured)', msgsFilter.body.total === 7);
  const listAll = await api('admin', 'GET', '/campaigns?status=done');
  Z.check('campaign list has counts per campaign and a status filter with counts', listAll.status === 200 && listAll.body.campaigns.every((c) => c.status === 'done' && c.counts && typeof c.counts.sent === 'number') && listAll.body.facets.done >= 1);

  // ================================================================= 18. AUDIT has no PII
  const aud = await prisma.auditLog.findMany({ where: { OR: [{ userId: { in: [admin.id, bde.id, hr.id, tl.id] } }, { actorName: { contains: 'ZZTEST OC3' } }], entity: { in: ['OutreachCampaign', 'OutreachSettings'] } } });
  const acts = new Set(aud.map((a) => a.action));
  const need = ['Outreach campaign created', 'Outreach campaign sent', 'Outreach campaign scheduled', 'Outreach campaign skip summary', 'Outreach campaign paused', 'Outreach campaign resumed', 'Outreach campaign stopped', 'Outreach sending switched ON', 'Outreach sending switched OFF'];
  Z.check('audit has rows for create / send / schedule / skip summary / pause / resume / stop / sending switch', need.every((a) => acts.has(a)), need.filter((a) => !acts.has(a)));
  const leak = aud.some((a) => [a.toValue, a.fromValue, a.reason].some((v) => v && (/example\.test/.test(v) || /@/.test(v) || /9765\d{6}/.test(v) || /\b\d{10}\b/.test(v))));
  Z.check('audit rows carry ids and counts only: no phone number, no email address', !leak);
  const logLeak = (await S.q('SELECT * FROM "OutreachSendLog" WHERE contactId LIKE \'self:%\' OR contactId IN (' + ids.map(() => '?').join(',') + ')', ...ids)).some((l) => /zz-oc3-/.test(JSON.stringify(l)));
  const evLeak = (await S.q('SELECT * FROM "OutreachEvent" WHERE campaignId IN (' + created.campaignIds.map(() => '?').join(',') + ')', ...created.campaignIds)).some((e) => /@|example\.test|ZZTEST/.test(JSON.stringify(e)));
  Z.check('send log holds no clear address; funnel events hold no name / phone / email', !logLeak && !evLeak);

  // ================================================================= 19. summary view of one campaign (funnel strip numbers)
  const cvF = (await api('admin', 'GET', `/campaigns/${camp1}`)).body;
  Z.check('campaign detail: counts + funnel strip (Sent 7 > Delivered 0 > Clicked 1), reasons in words', cvF.counts.sent === 7 && cvF.counts.clicked === 1 && cvF.funnel.clicked === 1 && cvF.reasons.length >= 5 && cvF.reasons.every((r) => r.words), cvF.reasons);

  // ================================================================= cleanup (every row of mine) + proof
  await S.saveSettings(settings0);
  await wipe();
  await S.run('DELETE FROM "OutreachEvent" WHERE eventKey LIKE \'applied:zzoc3-%\'');
  await prisma.appSetting.deleteMany({ where: { key: 'outreach.settings' } });
  if (settingsBefore) await prisma.appSetting.create({ data: { key: settingsBefore.key, value: settingsBefore.value } });
  const left = await Z.cleanup();
  const rest = {
    campaigns: S.num((await S.q('SELECT COUNT(*) n FROM "OutreachCampaign" WHERE name LIKE \'ZZTEST OC3%\''))[0].n),
    messages: S.num((await S.q('SELECT COUNT(*) n FROM "OutreachMessage" WHERE campaignId NOT IN (SELECT id FROM "OutreachCampaign")'))[0].n),
    events: S.num((await S.q('SELECT COUNT(*) n FROM "OutreachEvent" WHERE campaignId NOT IN (SELECT id FROM "OutreachCampaign")'))[0].n),
    contacts: S.num((await S.q('SELECT COUNT(*) n FROM "OutreachContact" WHERE name LIKE \'ZZTEST OC3%\' OR source LIKE \'ZZTEST OC3%\''))[0].n),
    segs: S.num((await S.q('SELECT COUNT(*) n FROM "OutreachSegment" WHERE name LIKE \'ZZTEST OC3%\''))[0].n),
    tpls: S.num((await S.q('SELECT COUNT(*) n FROM "OutreachTemplate" WHERE name LIKE \'ZZTEST OC3%\''))[0].n),
    sendLog: S.num((await S.q('SELECT COUNT(*) n FROM "OutreachSendLog" WHERE subject LIKE \'%ZZTEST OC3%\''))[0].n),
    receipts: S.num((await S.q('SELECT COUNT(*) n FROM "OutreachWebhookReceipt" WHERE providerEventId LIKE \'zzoc3-%\''))[0].n),
    audit: await prisma.auditLog.count({ where: { OR: [{ userId: { in: Z.made.users } }, { actorName: { contains: 'ZZTEST OC3' } }] } }),
  };
  console.log('cleanup', JSON.stringify(left), JSON.stringify(rest));
  Z.check('cleanup: zero ZZTEST OC3 rows left', Object.values(left).every((v) => v === 0) && Object.values(rest).every((v) => v === 0));
  await Z.finish();
})().catch(async (e) => { console.error('CRASH', e); try { await wipeSafe(); } catch { /* */ } try { await prisma.$disconnect(); } catch { /* */ } process.exit(1); });
async function wipeSafe() { /* the next run's preclean removes leftovers of a crashed run */ }
