// ---------------------------------------------------------------------------
// OMNI-CHANNEL LAYOUT PASS (2026-10-14): acceptance test. SANDBOX ONLY (API 4011, prisma/sandbox.db). Nothing is ever really sent: Email stays in
// TEST MODE (rehearsals); the mail sender of the test-to-me check is a mock.
//   TL_API=http://localhost:4011 node scripts/outreach-layout-test.js
// Covers: quiet hours (IST decision function, overnight window, boundaries, runner / "Send now (one round)" / schedule / pre-send check, internal exempt or ticked),
// sender-details validation, consent log (role gates, masking, CSV audit, nothing deletable), scheduled staff messages (birthday / anniversary match, once-only keys,
// OFF sends nothing, test-to-me only to the sender, internal-only audience, role gates), staff template CRUD gates, Industry filter counts == direct SQL,
// Distribution scope, the Roles table == real rules, and the page navigation (pure omniNav.js). Tag "ZZTEST OS": every row made here is removed at the end.
// ---------------------------------------------------------------------------
/* eslint-disable no-console, no-await-in-loop */
const path = require('path');
const { pathToFileURL } = require('url');
if (!process.env.TL_API) process.env.TL_API = 'http://localhost:4011';
const Z = require('./lib/zzfix')('OS');
const { BACK, prisma } = Z;
const S = require(path.join(BACK, 'src/outreach/store'));
const A = require(path.join(BACK, 'src/outreach/access'));
const C = require(path.join(BACK, 'src/outreach/consent'));
const Q = require(path.join(BACK, 'src/outreach/quiet'));
const Sender = require(path.join(BACK, 'src/outreach/sender'));
const CLog = require(path.join(BACK, 'src/outreach/consentLog'));
const Sched = require(path.join(BACK, 'src/outreach/scheduled'));
const Run = require(path.join(BACK, 'src/outreach/runner'));
const Dist = require(path.join(BACK, 'src/outreach/distribution'));
const O = '/api/outreach';
const RUN = Z.RUN;
const RUNNUM = parseInt(RUN, 36) % 90000;
const em = (k) => `zz-os-${RUN}-${k}@example.test`;
let phN = 0;
const PHBASE = 9100000000 + (RUNNUM % 9000) * 100000;
const nextPhone = () => { phN += 1; return String(PHBASE + phN); };
const created = { contactIds: [], hashes: [], segIds: [], tplIds: [] };
const IST = 5.5 * 3600000;
const hm = (min) => `${String(Math.floor(((min % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((min % 60) + 60) % 60).padStart(2, '0')}`;
const utc = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi); // a UTC moment

(async () => {
  console.log('preclean', JSON.stringify(await Z.preclean()));
  // ================================================================= pure: quiet hours (no server needed)
  const win = { enabled: true, start: '21:00', end: '08:00', applyInternal: false };
  const ist = (h, m) => utc(2026, 10, 14, h, m) - IST; // 14 Oct 2026 h:m India time -> UTC ms
  Z.check('Q1 the window is OFF by default (a fresh setting is disabled, 21:00 to 08:00)', (() => { const n = Q.normalize(undefined); return n.enabled === false && n.start === '21:00' && n.end === '08:00' && n.applyInternal === false; })());
  Z.check('Q2 OFF means never quiet, whatever the time', !Q.state(ist(23, 0), { ...win, enabled: false }).active && !Q.state(ist(3, 0), { ...win, enabled: false }).active);
  Z.check('Q3 overnight window boundaries (IST): 20:59 free, 21:00 quiet, 23:59 quiet, 00:00 quiet, 07:59 quiet, 08:00 free', !Q.state(ist(20, 59), win).active && Q.state(ist(21, 0), win).active && Q.state(ist(23, 59), win).active && Q.state(ist(0, 0), win).active && Q.state(ist(7, 59), win).active && !Q.state(ist(8, 0), win).active);
  Z.check('Q4 the time is India time, not UTC (15:30 UTC = 21:00 IST is quiet; 15:29 UTC is not)', Q.state(utc(2026, 10, 14, 15, 30), win).active && !Q.state(utc(2026, 10, 14, 15, 29), win).active);
  const s23 = Q.state(ist(23, 0), win);
  const s03 = Q.state(ist(3, 0), win);
  Z.check('Q5 when quiet hours end: from 23:00 -> next day 08:00 IST; from 03:00 -> the same day 08:00 IST; the banner words name the time', s23.resumeAt === ist(8, 0) + 86400000 && s03.resumeAt === ist(8, 0) && s23.words === 'Waiting for quiet hours to end (08:00)', [s23, s03]);
  const day = { enabled: true, start: '13:00', end: '15:00', applyInternal: false };
  Z.check('Q6 a same-day window (13:00-15:00): 12:59 free, 13:00 quiet, 14:59 quiet, 15:00 free', !Q.state(ist(12, 59), day).active && Q.state(ist(13, 0), day).active && Q.state(ist(14, 59), day).active && !Q.state(ist(15, 0), day).active);
  Z.check('Q7 start = end is refused, bad times are refused, good ones are kept', !!Q.validate({ start: '09:00', end: '09:00' }, win).error && !!Q.validate({ start: '25:00' }, win).error && !!Q.validate({ end: 'abc' }, win).error && Q.validate({ start: '22:30', end: '06:15', enabled: true }, win).value.start === '22:30');
  Z.check('Q8 internal (staff) messages are exempt by default and held only with the tick', !Q.state(ist(23, 0), win, 'internal').active && Q.state(ist(23, 0), { ...win, applyInternal: true }, 'internal').active && Q.state(ist(23, 0), win, 'job_promotion').active);
  const mv = Q.moveOutOfQuiet(ist(22, 30), win, 'job_promotion');
  const mv2 = Q.moveOutOfQuiet(ist(10, 0), win, 'job_promotion');
  const mv3 = Q.moveOutOfQuiet(ist(22, 30), win, 'internal');
  Z.check('Q9 a campaign scheduled inside quiet hours moves to the end of them; outside it stays; staff messages stay unless ticked', mv.moved && mv.at === ist(8, 0) + 86400000 && !mv2.moved && mv2.at === ist(10, 0) && !mv3.moved);

  // ================================================================= pure: sender-details validation
  Z.check('S1 sender details: good values are cleaned (email lower-cased, WhatsApp to digits with 91, SMS ID upper-cased)', (() => { const r = Sender.validate({ fromEmail: ' Jobs@Example.Test ', whatsappNumber: '+91 98765 43210', smsSenderId: 'teamlk', smsDltEntityId: '1234567890123456789' }); return r.value && r.value.fromEmail === 'jobs@example.test' && r.value.whatsappNumber === '919876543210' && r.value.smsSenderId === 'TEAMLK'; })());
  Z.check('S2 sender details: bad email / WhatsApp / SMS ID / DLT number each give a plain error', !!Sender.validate({ fromEmail: 'nope' }).error && !!Sender.validate({ replyTo: 'a@' }).error && !!Sender.validate({ whatsappNumber: '123' }).error && !!Sender.validate({ smsSenderId: 'AB1' }).error && !!Sender.validate({ smsSenderId: 'TOOLONGID' }).error && !!Sender.validate({ smsDltEntityId: '12ab' }).error);
  Z.check('S3 empty values clear the field', (() => { const r = Sender.validate({ fromEmail: '', whatsappNumber: '', smsSenderId: '', smsDltEntityId: '' }); return r.value && Object.values(r.value).every((v) => v === ''); })());

  // ================================================================= pure: scheduled-message rules
  const ruleB = { trigger: { type: 'birthday' }, time: '09:00' };
  Z.check('R1 a Feb 29 birthday is matched on Feb 28 in a normal year and on Feb 29 in a leap year, never on Mar 1', Sched.sameMonthDay(new Date('2000-02-29T00:00:00+05:30'), '2026-02-28') && !Sched.sameMonthDay(new Date('2000-02-29T00:00:00+05:30'), '2026-03-01') && !Sched.sameMonthDay(new Date('2000-02-29T00:00:00+05:30'), '2028-02-28') && Sched.sameMonthDay(new Date('2000-02-29T00:00:00+05:30'), '2028-02-29'));
  Z.check('R2 triggers: weekly (Wednesday), monthly day 31 falls on the last day of a short month, a fixed date fires once', Sched.triggerHits({ trigger: { type: 'weekly', weekday: 3 } }, '2026-10-14') && !Sched.triggerHits({ trigger: { type: 'weekly', weekday: 3 } }, '2026-10-15') && Sched.triggerHits({ trigger: { type: 'monthly', day: 31 } }, '2026-02-28') && !Sched.triggerHits({ trigger: { type: 'monthly', day: 31 } }, '2026-02-27') && Sched.triggerHits({ trigger: { type: 'fixed', date: '2026-10-14' } }, '2026-10-14') && !Sched.triggerHits({ trigger: { type: 'fixed', date: '2026-10-14' } }, '2026-10-15'));
  Z.check('R3 due window: not before the time, due from the time for 6 hours, not later', !Sched.dueNow(ruleB, ist(8, 59)).due && Sched.dueNow(ruleB, ist(9, 0)).due && Sched.dueNow(ruleB, ist(15, 0)).due && !Sched.dueNow(ruleB, ist(15, 1)).due);
  const nx = Sched.nextRuns({ trigger: { type: 'weekly', weekday: 1 }, time: '10:30' }, ist(12, 0), 3);
  Z.check('R4 next-run preview: the next three Mondays at 10:30 IST', nx.length === 3 && nx.every((x) => { const d = new Date(new Date(x).getTime() + IST); return d.getUTCDay() === 1 && d.getUTCHours() === 10 && d.getUTCMinutes() === 30; }), nx);
  Z.check('R5 a rule needs a valid name, template, date / day; WhatsApp is refused', !!Sched.clean({ kind: 'custom', name: 'x', templateId: 't' }).error && !!Sched.clean({ kind: 'policy', name: 'Policy', trigger: { type: 'fixed', date: '2026-13-40' }, templateId: 't' }).error && !!Sched.clean({ kind: 'policy', name: 'Policy', trigger: { type: 'weekly', weekday: 9 }, templateId: 't' }).error && !!Sched.clean({ kind: 'policy', name: 'Policy', trigger: { type: 'monthly', day: 0 }, templateId: 't' }).error && !!Sched.clean({ kind: 'policy', name: 'Policy', trigger: { type: 'monthly', day: 5 }, templateId: 't', channel: 'whatsapp' }).error && !Sched.clean({ kind: 'policy', name: 'Policy', trigger: { type: 'monthly', day: 5 }, templateId: 't' }).error);

  // ================================================================= pure: the page navigation (five hubs, 2026-10-17) and the sidebar children
  const nav = await import(pathToFileURL(path.join(BACK, '..', 'frontend', 'src', 'components', 'outreach', 'omniNav.js')).href);
  const side = await import(pathToFileURL(path.join(BACK, '..', 'frontend', 'src', 'components', 'outreach', 'omniSidebar.js')).href);
  const H = (insights, cfg = false, extra = {}) => ({ dashboard: true, communication: true, campaigns: true, insights, configuration: cfg, ...extra });
  const accOf = (k) => ({
    admin: { level: 'admin', hubs: H(['performance', 'credits', 'roi', 'reports'], true), canPromo: true, canInternal: true, seesDistribution: true },
    hr: { level: 'hr', hubs: H(['reports']), canPromo: false, canInternal: true, seesDistribution: false },
    rec: { level: 'recruiter', hubs: H(['reports']), canPromo: true, canInternal: false, seesDistribution: true },
    fin: { level: 'finance', hubs: { dashboard: false, communication: false, campaigns: false, insights: ['credits'], configuration: false }, canPromo: false, canInternal: false },
    none: { level: 'none', hubs: { dashboard: false, communication: false, campaigns: false, insights: [], configuration: false } },
  }[k]);
  const nAdmin = nav.resolveNav(accOf('admin'), {}, null);
  Z.check('N1 Admin sees the five hubs in order (Dashboard, Communication, Campaigns, Insights, Configuration) and opens on the Dashboard', nAdmin.hubs.join() === 'dashboard,communication,campaigns,insights,configuration' && nAdmin.hub === 'dashboard' && nAdmin.tab === 'overview', nAdmin);
  Z.check('N2 the Campaigns hub tabs are Campaigns, Promotions, Templates, Automations, Contacts, Audiences, Distribution; Communication has Inbox, WhatsApp, SMS, Email, Calls, Conversations', nav.subTabs(accOf('admin'), 'campaigns').map((m) => m[1]).join() === 'Campaigns,Promotions,Templates,Automations,Contacts,Audiences,Distribution' && nav.subTabs(accOf('admin'), 'communication').map((m) => m[1]).join() === 'Inbox,WhatsApp,SMS,Email,Calls,Conversations');
  Z.check('N3 the staff side of Campaigns is Messages, Templates, Automations, People, Groups, Imports, Scheduled messages; Configuration is Meta WhatsApp, Channels, Departments, Permissions, Settings; Insights is Performance, Credits, ROI, Reports', nav.subTabs(accOf('admin'), 'campaigns', 'internal').map((m) => m[1]).join() === 'Messages,Templates,Automations,People,Groups,Imports,Scheduled messages' && nav.subTabs(accOf('admin'), 'configuration').map((m) => m[1]).join() === 'Meta WhatsApp,Channels,Departments,Permissions,Settings' && nav.subTabs(accOf('admin'), 'insights').map((m) => m[1]).join() === 'Performance,Credits,ROI,Reports');
  const nHr = nav.resolveNav(accOf('hr'), { mode: 'promo', tab: 'campaigns' }, 'campaigns');
  Z.check('N4 the HR desk gets the staff side only: an old promo link lands in Campaigns with the staff tabs', nHr.hub === 'campaigns' && nHr.aud === 'internal' && nHr.subs.map((m) => m[0]).includes('people') && !nHr.subs.map((m) => m[0]).includes('contacts'), nHr);
  const nRec = nav.resolveNav(accOf('rec'), { mode: 'settings', tab: 'channels' }, 'insights');
  Z.check('N5 a Recruiter has no Configuration: an old settings link falls back to a hub it has, and Configuration is not in its list', !nRec.hubs.includes('configuration') && nRec.hub !== 'configuration' && nRec.hubs.join() === 'dashboard,communication,campaigns,insights', nRec);
  Z.check('N6 deep links work: /campaigns?tab=promotions, /insights?tab=roi; an unknown tab falls back to the hub home', nav.resolveNav(accOf('admin'), { hub: 'campaigns', tab: 'promotions' }).tab === 'promotions' && nav.resolveNav(accOf('admin'), { hub: 'insights', tab: 'roi' }).tab === 'roi' && nav.resolveNav(accOf('admin'), { hub: 'communication', tab: 'nope' }).tab === 'inbox');
  Z.check('N7 old links still work: ?tab=contacts -> Campaigns > Contacts, ?mode=internal&tab=people -> Campaigns (staff) > People, ?tab=channels -> Configuration > Channels, ?mode=settings&tab=roles -> Configuration > Permissions, ?mode=promo&tab=inbox -> Communication > Inbox', (() => {
    const a1 = nav.resolveNav(accOf('admin'), { tab: 'contacts' }); const b1 = nav.resolveNav(accOf('admin'), { mode: 'internal', tab: 'people' }); const c1 = nav.resolveNav(accOf('admin'), { tab: 'channels' }); const d1 = nav.resolveNav(accOf('admin'), { mode: 'settings', tab: 'roles' }); const e1 = nav.resolveNav(accOf('admin'), { mode: 'promo', tab: 'inbox' });
    return a1.hub === 'campaigns' && a1.tab === 'contacts' && b1.hub === 'campaigns' && b1.aud === 'internal' && b1.tab === 'people' && c1.hub === 'configuration' && c1.tab === 'channels' && d1.hub === 'configuration' && d1.tab === 'permissions' && e1.hub === 'communication' && e1.tab === 'inbox';
  })());
  Z.check('N8 the last hub is remembered (stored "insights" opens Insights for an Admin) and an explicit hub wins over it', nav.resolveNav(accOf('admin'), {}, 'insights').hub === 'insights' && nav.resolveNav(accOf('admin'), { hub: 'campaigns' }, 'insights').hub === 'campaigns');
  Z.check('N9 a blocked localStorage never breaks the page (read gives null, write does nothing)', nav.readStored() === null && (() => { try { nav.writeStored('campaigns'); return true; } catch { return false; } })());
  Z.check('N10 Distribution is left out for a login that may not open it; a login with no hubs gets "none"; nobody sees the word Draft', !nav.subTabs({ ...accOf('rec'), seesDistribution: false }, 'campaigns').some((m) => m[0] === 'distribution') && nav.resolveNav(accOf('none'), {}).none === true && !/draft/i.test(JSON.stringify(['dashboard', 'communication', 'campaigns', 'insights', 'configuration'].map((h) => nav.subTabs(accOf('admin'), h)))));
  // the sidebar: Omni-Channel is ONE group whose children are the hubs the login may open
  const kids = (k) => side.omniChildren(accOf(k)).map((c) => c.id).join();
  Z.check('SB1 sidebar children: Admin has all five, in order, each with an icon and a /omni-channel/<hub> address', kids('admin') === 'dashboard,communication,campaigns,insights,configuration' && side.omniChildren(accOf('admin')).every((c) => c.icon && c.to === '/omni-channel/' + c.id && c.label), side.omniChildren(accOf('admin')));
  Z.check('SB2 Recruiter: four children (no Configuration); HR: four (its Internal side lives inside Campaigns); Finance: Insights only; no access: no group at all', kids('rec') === 'dashboard,communication,campaigns,insights' && kids('hr') === 'dashboard,communication,campaigns,insights' && kids('fin') === 'insights' && side.omniChildren(accOf('none')).length === 0 && side.omniChildren(null).length === 0);
  Z.check('SB3 the highlight follows the address: /omni-channel/insights?tab=roi belongs to Insights, a wrong or old address to no hub', side.hubOfPath('/omni-channel/insights') === 'insights' && side.hubOfPath('/omni-channel/campaigns/x') === 'campaigns' && side.hubOfPath('/omni') === null && side.hubOfPath('/omni-channel/zzz') === null && side.hubOfPath('/ats') === null);
  Z.check('SB4 Finance opens straight on Insights > Credits', (() => { const f = nav.resolveNav(accOf('fin'), {}); return f.hub === 'insights' && f.tab === 'credits' && f.hubs.join() === 'insights'; })());

  // ================================================================= server needed from here
  if (!((await S.campaignsReady()) && (await S.quickReady()))) { Z.check('Phase 3 and quick-wins tables exist in the sandbox', false, 'run: node scripts/outreach-p3-apply-sandbox.js ; node scripts/outreach-quickwins-apply-sandbox.js'); await Z.finish(); return; }
  const settingsBefore = await prisma.appSetting.findUnique({ where: { key: 'outreach.settings' } });
  const rulesBefore = await prisma.appSetting.findUnique({ where: { key: 'outreach.scheduled.rules' } });
  const runsBefore = await prisma.appSetting.findUnique({ where: { key: 'outreach.scheduled.runs' } });
  const wipe = async () => {
    const camps = (await S.q('SELECT id FROM "OutreachCampaign" WHERE name LIKE \'ZZTEST OS%\'')).map((r) => r.id);
    for (const id of camps) { await S.run('DELETE FROM "OutreachEvent" WHERE campaignId = ?', id); await S.run('DELETE FROM "OutreachMessage" WHERE campaignId = ?', id); await S.run('DELETE FROM "OutreachCampaignNote" WHERE campaignId = ?', id); }
    await S.run('DELETE FROM "OutreachCampaign" WHERE name LIKE \'ZZTEST OS%\'');
    const cs = await S.q('SELECT id, email, phoneE164 FROM "OutreachContact" WHERE name LIKE \'ZZTEST OS%\' OR source LIKE \'ZZTEST OS%\'');
    for (const c of cs) {
      await S.run('DELETE FROM "OutreachContactChannel" WHERE contactId = ?', c.id); await S.run('DELETE FROM "OutreachContactTag" WHERE contactId = ?', c.id);
      await S.run('DELETE FROM "OutreachConsentEvent" WHERE contactId = ?', c.id); await S.run('DELETE FROM "OutreachSendLog" WHERE contactId = ?', c.id); await S.run('DELETE FROM "OutreachEvent" WHERE contactId = ?', c.id);
      if (c.email) { const h = S.hashAddress('email', c.email); await S.run('DELETE FROM "OutreachSuppression" WHERE addressHash = ?', h); await S.run('DELETE FROM "OutreachConsentEvent" WHERE addressHash = ?', h); }
      if (c.phoneE164) { const h = S.hashAddress('phone', c.phoneE164); await S.run('DELETE FROM "OutreachSuppression" WHERE addressHash = ?', h); await S.run('DELETE FROM "OutreachConsentEvent" WHERE addressHash = ?', h); }
    }
    await S.run('DELETE FROM "OutreachContact" WHERE name LIKE \'ZZTEST OS%\' OR source LIKE \'ZZTEST OS%\'');
    for (const h of created.hashes) { await S.run('DELETE FROM "OutreachSuppression" WHERE addressHash = ?', h); await S.run('DELETE FROM "OutreachConsentEvent" WHERE addressHash = ?', h); }
    await S.run('DELETE FROM "OutreachSegment" WHERE name LIKE \'ZZTEST OS%\'');
    await S.run('DELETE FROM "OutreachTemplate" WHERE name LIKE \'ZZTEST OS%\'');
    await S.run('DELETE FROM "OutreachSendLog" WHERE subject LIKE \'%ZZTEST OS%\' OR contactId LIKE \'self:%\' AND subject LIKE \'%ZZTEST OS%\'');
    await S.run('DELETE FROM "OutreachRunnerLease" WHERE holder LIKE \'zzos-%\'');
    await S.run('DELETE FROM "OutreachCampaignNote" WHERE campaignId NOT IN (SELECT id FROM "OutreachCampaign")');
  };
  await wipe();

  // ----------------------------------------------------------------- people
  const admin = await Z.mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
  const mgr = await Z.mkUser('mgr', { role: 'MANAGER', atsRole: 'MANAGER' });
  const tl = await Z.mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'TL' });
  const bde = await Z.mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, {});
  const rec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, {});
  const hr = await Z.mkUser('hr', { role: 'HR', atsRole: 'HR', hrmsRole: 'HR' }, {});
  const acct = await Z.mkUser('acct', { role: 'EMPLOYEE', atsRole: 'ACCOUNTANT', accountsRole: 'ACCOUNTANT' }, {});
  const tok = {};
  for (const [k, u] of Object.entries({ admin, mgr, tl, bde, rec, hr, acct })) tok[k] = await Z.mint(u);
  const api = (who, method, p, body) => Z.call(method, `${O}${p}`, tok[who], body);
  const client = await prisma.client.create({ data: { name: `ZZTEST OS Client ${RUN}`, location: 'ZZ Town', ownerDepartment: 'Education', clientType: 'Client', contactName: 'ZZ Contact', contactEmail: em('client'), agreementStatus: 'ACTIVE' } });
  Z.made.clients.push(client.id);
  const mkJob = async (tag, extra = {}) => { const r = await prisma.requirement.create({ data: { title: `ZZTEST OS Job ${tag} ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Education', openings: 2, portalPublished: true, ...extra } }); Z.made.reqs.push(r.id); return r; };
  const JA = await mkJob('A', { bdeId: bde.id, tlId: tl.id, recruiterId: rec.id });
  const JB = await mkJob('B', { department: 'Medical' });

  const mkContact = async (n, o = {}) => {
    const id = S.newId('oc'); const now = Date.now();
    const mail = o.email === undefined ? em(n) : o.email; const ph = o.phone === undefined ? nextPhone() : o.phone;
    const mailKey = mail && /@/.test(mail) ? mail.toLowerCase() : null;
    const name = o.name === undefined ? `ZZTEST OS Person ${n}` : o.name;
    await S.run(`INSERT INTO "OutreachContact" (id, contactType, name, phoneE164, email, phoneKey, emailKey, city, source, importId, status, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?)`,
      id, o.type || 'candidate_lead', name, ph ? `91${ph}` : null, mail || null, ph || null, mailKey, o.city || 'Hyderabad', 'ZZTEST OS source', o.importId || 'ZZOS-A', o.createdBy || admin.id, 'ZZTEST OS', now, now);
    const chan = async (channel, address, optIn) => S.run('INSERT INTO "OutreachContactChannel" (id, contactId, channel, address, optIn, optInAt, health) VALUES (?,?,?,?,?,?,?)', S.newId('occ'), id, channel, address, optIn, now, 'ok');
    if (mail) await chan('email', mail, o.optIn || 'opted_in');
    if (ph) { await chan('whatsapp', `91${ph}`, 'opted_in'); await chan('sms', `91${ph}`, 'opted_in'); }
    for (const t of o.tags || []) await S.run('INSERT OR IGNORE INTO "OutreachContactTag" (contactId, industry) VALUES (?,?)', id, t);
    created.contactIds.push(id);
    if (mail) created.hashes.push(S.hashAddress('email', mail));
    if (ph) created.hashes.push(S.hashAddress('phone', `91${ph}`));
    return id;
  };
  const mkSeg = async (name, rules, who = 'admin', type = 'candidate_lead') => { const r = await api(who, 'POST', '/segments', { name: `ZZTEST OS ${name}`, contactType: type, rules }); if (r.status !== 200) throw new Error(`segment ${name}: ${JSON.stringify(r.body)}`); created.segIds.push(r.body.segment.id); return r.body.segment.id; };
  const mkTpl = async (name, body, subject, audience = 'candidate_lead', who = 'admin') => { const r = await api(who, 'POST', '/templates', { name: `ZZTEST OS ${name}`, channel: 'email', audience, subject, body, promotional: audience !== 'internal' }); if (r.status !== 200) throw new Error(`template ${name}: ${r.status} ${JSON.stringify(r.body)}`); created.tplIds.push(r.body.template.id); return r.body.template.id; };
  const settings0 = await S.settings();
  const setS = async (patch) => S.saveSettings({ ...(await S.settings()), ...patch });
  await setS({ master: true, emailTestMode: true, emailPerMinute: 600, emailDailyCap: 100000, suppressDays: 7, internalHrMaySend: false, quietHours: { enabled: false, start: '21:00', end: '08:00', applyInternal: false } });

  // ================================================================= access summary per role (the page's modes)
  const accOfRole = async (who) => (await api(who, 'GET', '/access')).body;
  const aAdmin = await accOfRole('admin'); const aHr = await accOfRole('hr'); const aRec = await accOfRole('rec'); const aMgr = await accOfRole('mgr'); const aBde = await accOfRole('bde'); const aTl = await accOfRole('tl');
  Z.check('A1 /access modes: Admin all three, HR desk internal only, Recruiter / TL / BDE / Manager Job Promotions only', aAdmin.modes.join() === 'promo,internal,settings' && aHr.modes.join() === 'internal' && [aRec, aTl, aBde, aMgr].every((a) => a.modes.join() === 'promo'), [aAdmin.modes, aHr.modes, aRec.modes]);
  Z.check('A2 the accountant has no access at all (403)', (await api('acct', 'GET', '/access')).status === 403);
  Z.check('A3 /access flags: only Admin sees Settings and downloads the consent log; Distribution is hidden for the HR desk; scheduled messages are managed by Admin + HR only', aAdmin.seesSettings && aAdmin.canExportConsent && !aHr.seesSettings && !aMgr.seesSettings && !aBde.seesSettings && aHr.canManageScheduled && aAdmin.canManageScheduled && !aMgr.canManageScheduled && !aRec.canManageScheduled && !aTl.canManageScheduled && !aBde.canManageScheduled && aRec.seesDistribution && !aHr.seesDistribution);

  // ================================================================= Roles table == the real rules
  const rt = await api('admin', 'GET', '/roles');
  const table = rt.body;
  const real = { admin: aAdmin, hr: aHr, recruiter: aRec, bde: aBde, tl: aTl, view: aMgr };
  const bad = [];
  const map = { seesLeads: 'seesLeads', mayRun: 'canImport', masked: 'masked', mayOptOut: 'canOptOut', mayOptIn: 'canOptIn', seesInternal: 'seesInternal', mayRunInternal: 'canImportInternal', manageScheduled: 'canManageScheduled', mayExportLog: 'canExportLog', seesDistribution: 'seesDistribution', seesSettings: 'seesSettings', mayExportConsent: 'canExportConsent' };
  Object.entries(real).forEach(([kind, a]) => { Object.entries(map).forEach(([rule, field]) => { const row = table.rows.find((r) => r.id === rule); if (!row || row.allowed[kind] !== !!a[field]) bad.push(`${kind}/${rule}`); }); });
  Z.check('RT1 the Roles table is made from the real rules: it agrees with /access for Admin, HR, Recruiter, BDE, TL and Manager on every row', rt.status === 200 && bad.length === 0 && table.roles.length >= 7 && table.notes.length >= 3, bad);
  Z.check('RT2 only an Admin can read the Roles table', (await api('mgr', 'GET', '/roles')).status === 403 && (await api('hr', 'GET', '/roles')).status === 403 && (await api('rec', 'GET', '/roles')).status === 403 && (await api('tl', 'GET', '/roles')).status === 403 && (await api('bde', 'GET', '/roles')).status === 403);

  // ================================================================= sender details + quiet-hours setting through the API
  const put = (who, b) => api(who, 'PUT', '/settings', b);
  const pS = await put('admin', { fromEmail: 'Jobs@Example.Test', fromName: 'ZZTEST OS Jobs', whatsappNumber: '+91 98765 43210', smsSenderId: 'teamlk', smsDltEntityId: '1234567890123456789' });
  const got = (await api('admin', 'GET', '/sender-details')).body;
  Z.check('S4 sender details save and come back cleaned (WhatsApp +91 98765 43210, sender ID TEAMLK)', pS.status === 200 && got.details.fromEmail === 'jobs@example.test' && got.details.whatsappShown === '+91 98765 43210' && got.details.smsSenderId === 'TEAMLK' && got.details.smsDltEntityId === '1234567890123456789', got);
  Z.check('S5 a bad value is refused with a plain sentence and nothing is saved', (await put('admin', { smsSenderId: 'AB1' })).status === 400 && (await put('admin', { whatsappNumber: '12' })).status === 400 && (await api('admin', 'GET', '/sender-details')).body.details.smsSenderId === 'TEAMLK');
  Z.check('S6 only an Admin can read or change sender details and rules', (await put('hr', { fromEmail: 'a@b.co' })).status === 403 && (await put('mgr', { quietHours: { enabled: true } })).status === 403 && (await api('hr', 'GET', '/sender-details')).status === 403 && (await api('rec', 'GET', '/sender-details')).status === 403);
  const tp = await api('admin', 'POST', '/templates/preview', { name: 'x', channel: 'email', audience: 'internal', subject: 'Hi {{name}}', body: 'Hello {{name}}' });
  Z.check('S7 the template preview shows who the message comes from (sender details)', tp.status === 200 && tp.body.sender && tp.body.sender.fromName === 'ZZTEST OS Jobs' && tp.body.sender.fromEmail === 'jobs@example.test' && tp.body.sender.smsSenderId === 'TEAMLK', tp.body);
  const dflt = (await api('admin', 'GET', '/sending')).body;
  Z.check('Q10 the sending rules answer carries the quiet-hours setting (OFF here) and plain words', dflt.settings.quietHours.enabled === false && /OFF/.test(dflt.quietWords), dflt.settings);
  const q1 = await put('admin', { quietHours: { enabled: true, start: '22:00', end: '06:30', applyInternal: true } });
  const q1g = (await api('admin', 'GET', '/sending')).body.settings.quietHours;
  Z.check('Q11 Admin turns quiet hours ON with their own times and the staff tick; it is kept and audited', q1.status === 200 && q1g.enabled && q1g.start === '22:00' && q1g.end === '06:30' && q1g.applyInternal === true && (await prisma.auditLog.count({ where: { userId: admin.id, action: 'Outreach quiet hours ON' } })) >= 1, [q1.body, q1g]);
  Z.check('Q12 bad quiet-hours input is refused (same start and end, 25:00)', (await put('admin', { quietHours: { start: '10:00', end: '10:00' } })).status === 400 && (await put('admin', { quietHours: { start: '25:00' } })).status === 400);
  await put('admin', { quietHours: { enabled: false, start: '21:00', end: '08:00', applyInternal: false } });

  // ================================================================= quiet hours in the runner, the one-round send, the schedule and the pre-send check
  const nowReal = Date.now();
  const minNow = Q.minuteOfDayIST(nowReal);
  const around = { enabled: true, start: hm(minNow - 60), end: hm(minNow + 60), applyInternal: false };
  const tplJob = await mkTpl('Job email', 'Hi {{name}}, {{company}} has a job for you: {{job_title}}.\nApply here: {{apply_link}}\nStop these emails: {{unsubscribe}}', 'ZZTEST OS {{job_title}}');
  const tplStaff = await mkTpl('Staff note', 'Hello {{name}}, a reminder from HR.\nStop these emails: {{unsubscribe}}', 'ZZTEST OS reminder', 'internal');
  for (let i = 1; i <= 3; i += 1) await mkContact(`lead${i}`, { importId: 'ZZOS-LEADS' });
  const segLeads = await mkSeg('Leads', { importIds: ['ZZOS-LEADS'] });
  const campQ = (await api('admin', 'POST', '/campaigns', { name: 'ZZTEST OS Quiet promo', type: 'job_promotion', requirementId: JA.id, segmentIds: [segLeads], templateId: tplJob, channel: 'email' })).body.id;
  await setS({ quietHours: around });
  const sQ = await api('admin', 'POST', `/campaigns/${campQ}/send`, { when: 'now' });
  Z.check('Q13 a job campaign sent now inside quiet hours is accepted and queued', sQ.status === 200 && sQ.body.queued === 3, sQ.body);
  const t0 = await Run.tick({ now: Date.now(), maxMessages: 100 });
  const stQ = (await S.q('SELECT status, COUNT(*) n FROM "OutreachMessage" WHERE campaignId = ? GROUP BY status', campQ)).reduce((a, r) => ({ ...a, [r.status]: S.num(r.n) }), {});
  Z.check('Q14 the worker sends nothing of a job campaign during quiet hours (all 3 stay waiting) and says why', stQ.queued === 3 && !stQ.test_captured && t0.quiet && t0.quiet.active && t0.quiet.endLabel === around.end, [t0, stQ]);
  const logQ = await api('admin', 'GET', `/messages?campaignId=${campQ}`);
  Z.check('Q15 the message log says "Waiting for quiet hours to end (HH:MM)" on each waiting row', logQ.status === 200 && logQ.body.messages.length === 3 && logQ.body.messages.every((m) => m.reasonWords === `Waiting for quiet hours to end (${around.end})`), logQ.body.messages[0]);
  const dq = await api('admin', 'GET', `/campaigns/${campQ}`);
  Z.check('Q16 the campaign stop-reason banner names quiet hours', dq.status === 200 && JSON.stringify(dq.body).includes('quiet_hours') && JSON.stringify(dq.body).includes(`Waiting for quiet hours to end (${around.end})`), Object.keys(dq.body));
  const oneRound = await api('admin', 'POST', '/runner/tick', {});
  const stQ2 = (await S.q('SELECT status, COUNT(*) n FROM "OutreachMessage" WHERE campaignId = ? GROUP BY status', campQ)).reduce((a, r) => ({ ...a, [r.status]: S.num(r.n) }), {});
  Z.check('Q17 "Send now (one round)" obeys quiet hours too: the answer says it is waiting and nothing was sent', oneRound.status === 200 && oneRound.body.result.quiet && oneRound.body.result.quiet.active && stQ2.queued === 3, [oneRound.body, stQ2]);
  const t1 = await Run.tick({ now: nowReal + 3 * 3600000, maxMessages: 100 });
  const stQ3 = (await S.q('SELECT status, COUNT(*) n FROM "OutreachMessage" WHERE campaignId = ? GROUP BY status', campQ)).reduce((a, r) => ({ ...a, [r.status]: S.num(r.n) }), {});
  Z.check('Q18 after quiet hours end the same rows go out by themselves (rehearsed: nothing really sent)', stQ3.test_captured === 3 && !stQ3.queued && !t1.quiet, [t1, stQ3]);
  // pre-send check
  const chk = await api('admin', 'POST', '/campaigns/check', { type: 'job_promotion', requirementId: JA.id, segmentIds: [segLeads], templateId: tplJob, when: 'now' });
  const qc = chk.body && chk.body.checks && chk.body.checks.find((c) => c.id === 'quiet');
  Z.check('Q19 the "Check before sending" step has a quiet-hours line: orange while quiet hours are on right now', chk.status === 200 && qc && qc.status === 'warn' && /Quiet hours/i.test(qc.label), chk.body);
  const chk2 = await api('admin', 'POST', '/campaigns/check', { type: 'job_promotion', requirementId: JA.id, segmentIds: [segLeads], templateId: tplJob, when: 'at', at: new Date(nowReal + 5 * 3600000).toISOString() });
  const qc2 = chk2.body && chk2.body.checks && chk2.body.checks.find((c) => c.id === 'quiet');
  Z.check('Q20 a time outside quiet hours gives a green quiet-hours line', qc2 && qc2.status === 'ok', qc2);
  const chk3 = await api('admin', 'POST', '/campaigns/check', { type: 'job_promotion', requirementId: JA.id, segmentIds: [segLeads], templateId: tplJob, when: 'at', at: new Date(nowReal + 120000).toISOString() });
  const qc3 = chk3.body && chk3.body.checks && chk3.body.checks.find((c) => c.id === 'quiet');
  Z.check('Q21 a time INSIDE quiet hours says it will start when quiet hours end', qc3 && qc3.status === 'warn' && qc3.detail.includes(around.end), qc3);
  // scheduling
  const campS = (await api('admin', 'POST', '/campaigns', { name: 'ZZTEST OS Scheduled promo', type: 'job_promotion', requirementId: JA.id, segmentIds: [segLeads], templateId: tplJob, channel: 'email' })).body.id;
  const sS = await api('admin', 'POST', `/campaigns/${campS}/send`, { when: 'at', at: new Date(nowReal + 120000).toISOString() });
  const endMs = Q.state(nowReal, around, 'job_promotion').resumeAt;
  Z.check('Q22 a campaign scheduled inside quiet hours is moved to the end of quiet hours, with a plain note', sS.status === 200 && sS.body.quietNote && sS.body.quietNote.includes(around.end) && Date.parse(sS.body.scheduledAt) === endMs, sS.body);
  // a campaign scheduled before quiet hours were on, due while they are on: the worker moves it
  await setS({ quietHours: { ...around, enabled: false } });
  const campS2 = (await api('admin', 'POST', '/campaigns', { name: 'ZZTEST OS Scheduled promo 2', type: 'job_promotion', requirementId: JA.id, segmentIds: [segLeads], templateId: tplJob, channel: 'email' })).body.id;
  const sS2 = await api('admin', 'POST', `/campaigns/${campS2}/send`, { when: 'at', at: new Date(nowReal + 90000).toISOString() });
  await setS({ quietHours: around });
  await Run.startDue(nowReal + 180000, await S.settings());
  const c2 = (await S.q('SELECT status, scheduledAt FROM "OutreachCampaign" WHERE id = ?', campS2))[0];
  const m2 = (await S.q('SELECT nextRunAt FROM "OutreachMessage" WHERE campaignId = ? AND status = \'queued\' LIMIT 1', campS2))[0];
  Z.check('Q23 a scheduled campaign that falls due inside quiet hours is NOT started: it waits for the end, its messages too', sS2.status === 200 && c2.status === 'scheduled' && S.ms(c2.scheduledAt) === endMs && m2 && S.ms(m2.nextRunAt) === endMs, [c2, m2]);
  // internal (staff) messages: exempt by default, held with the tick
  const stIds = [];
  for (let i = 1; i <= 2; i += 1) stIds.push(await mkContact(`staffq${i}`, { type: 'internal', importId: 'ZZOS-STAFFQ' }));
  const segStaffQ = await mkSeg('Staff Q', { importIds: ['ZZOS-STAFFQ'] }, 'admin', 'internal');
  const campStaff = (await api('admin', 'POST', '/campaigns', { name: 'ZZTEST OS Staff quiet', type: 'internal', segmentIds: [segStaffQ], templateId: tplStaff, channel: 'email' })).body.id;
  await setS({ quietHours: around });
  await api('admin', 'POST', `/campaigns/${campStaff}/send`, { when: 'now' });
  await Run.tick({ now: Date.now(), maxMessages: 100 });
  const stSt = (await S.q('SELECT status, COUNT(*) n FROM "OutreachMessage" WHERE campaignId = ? GROUP BY status', campStaff)).reduce((a, r) => ({ ...a, [r.status]: S.num(r.n) }), {});
  Z.check('Q24 staff messages are exempt from quiet hours by default (rehearsed during the quiet window)', stSt.test_captured === 2, stSt);
  const campStaff2 = (await api('admin', 'POST', '/campaigns', { name: 'ZZTEST OS Staff quiet 2', type: 'internal', segmentIds: [segStaffQ], templateId: tplStaff, channel: 'email' })).body.id;
  await setS({ quietHours: { ...around, applyInternal: true }, suppressDays: 0 });
  await api('admin', 'POST', `/campaigns/${campStaff2}/send`, { when: 'now' });
  const ti = await Run.tick({ now: Date.now(), maxMessages: 100 });
  const stSt2 = (await S.q('SELECT status, COUNT(*) n FROM "OutreachMessage" WHERE campaignId = ? GROUP BY status', campStaff2)).reduce((a, r) => ({ ...a, [r.status]: S.num(r.n) }), {});
  Z.check('Q25 with "Apply to internal messages too" ticked, staff messages wait too (and go after the window)', stSt2.queued === 2 && ti.quiet && ti.quiet.staffHeld === true && (await Run.tick({ now: nowReal + 3 * 3600000, maxMessages: 100 })) && (await S.q('SELECT COUNT(*) n FROM "OutreachMessage" WHERE campaignId = ? AND status = \'test_captured\'', campStaff2))[0].n >= 2, [stSt2, ti]);
  await setS({ quietHours: { enabled: false, start: '21:00', end: '08:00', applyInternal: false } });

  // ================================================================= consent log
  const cIds = [];
  for (let i = 1; i <= 4; i += 1) cIds.push(await mkContact(`consent${i}`, { importId: 'ZZOS-CONSENT' }));
  await C.optOut(cIds[0], 'email', { reason: 'unsubscribe_link', source: 'unsubscribe_link', evidence: 'Used the unsubscribe link', by: null });
  await C.optOut(cIds[1], 'whatsapp', { reason: 'stop_reply', source: 'stop_reply', evidence: 'Replied STOP', by: null });
  await C.optOut(cIds[2], 'email', { reason: 'admin', source: 'screen', evidence: 'Asked on the phone', by: admin });
  await C.optIn(cIds[2], 'email', { reason: 'Said yes again on the phone', by: admin });
  const direct = S.num((await S.q('SELECT COUNT(*) n FROM "OutreachConsentEvent" e JOIN "OutreachContact" c ON c.id = e.contactId WHERE c.name LIKE \'ZZTEST OS%\' AND c.importId = ?', 'ZZOS-CONSENT'))[0].n);
  const cl = await api('admin', 'GET', `/consent-log?q=${encodeURIComponent('ZZTEST OS Person consent')}&pageSize=100`);
  Z.check('CL1 the consent log lists every event of those contacts (count equals direct SQL) with who / when / channel / source / reason', cl.status === 200 && cl.body.total === direct && direct >= 4 && cl.body.events.every((e) => e.channelWords && e.at && e.actionWords && e.who && e.name), [cl.body.total, direct]);
  const byAct = (a) => cl.body.events.filter((e) => e.action === a).length;
  Z.check('CL2 an unsubscribe-link opt-out reads "Unsubscribed (link)" by "The person themselves"; a STOP reply reads "Replied STOP"; an Admin opt-in names the Admin', byAct('unsubscribe') === 1 && byAct('stop') === 1 && cl.body.events.find((e) => e.action === 'unsubscribe').who === 'The person themselves' && cl.body.events.find((e) => e.action === 'opt_in' && e.why.includes('Said yes')).who === admin.name, cl.body.events.map((e) => [e.action, e.who]));
  const fa = await api('admin', 'GET', `/consent-log?q=${encodeURIComponent('ZZTEST OS Person consent')}&action=stop`);
  const fc = await api('admin', 'GET', `/consent-log?q=${encodeURIComponent('ZZTEST OS Person consent')}&channel=whatsapp`);
  Z.check('CL3 the filters work: What happened = STOP gives 1, Channel = WhatsApp gives 1; the counts next to the options are live', fa.body.total === 1 && fc.body.total === 1 && cl.body.counts.unsubscribe === 1 && cl.body.counts.stop === 1);
  Z.check('CL4 role gates: Manager, TL, BDE, Recruiter and the HR desk cannot open or download the consent log (403)', (await Promise.all(['mgr', 'tl', 'bde', 'rec', 'hr'].map(async (w) => [(await api(w, 'GET', '/consent-log')).status, (await api(w, 'GET', '/consent-log/export')).status]))).every(([a, b]) => a === 403 && b === 403));
  const row = (await S.q('SELECT e.id, e.contactId, e.channel, e.action, e.source, e.evidence, e.byUserId, e.at, c.name, c.email, c.phoneE164, c.contactType, c.status AS contactStatus FROM "OutreachConsentEvent" e JOIN "OutreachContact" c ON c.id = e.contactId WHERE e.contactId = ? LIMIT 1', cIds[0]))[0];
  const maskedView = CLog.rowView({ ...row, channel: 'email' }, true, new Map());
  const openView = CLog.rowView({ ...row, channel: 'email' }, false, new Map());
  Z.check('CL5 masking: a masked role would see a hidden email (not the real one); an unmasked one sees it', row.email && !maskedView.contact.includes(row.email) && maskedView.contact.includes('@') && maskedView.contact !== openView.contact && openView.contact === row.email, [maskedView.contact, openView.contact]);
  const ex = await api('admin', 'GET', `/consent-log/export?q=${encodeURIComponent('ZZTEST OS Person consent')}`);
  const lines = ex.text.replace(/^﻿/, '').trim().split(/\r?\n/);
  Z.check('CL6 Admin downloads the CSV (header + one row per event, India time, plain words)', ex.status === 200 && /text\/csv/.test(ex.headers.get('content-type') || '') && lines.length === direct + 1 && /Unsubscribed/.test(ex.text) && /Replied STOP/.test(ex.text), [ex.status, lines.length, direct]);
  const aud = await prisma.auditLog.findFirst({ where: { userId: admin.id, action: 'Outreach consent log downloaded' }, orderBy: { createdAt: 'desc' } });
  Z.check('CL7 the download is audited (who, row count, filters) and the audit row holds no phone or email', aud && /rows/.test(aud.toValue || '') && !/@|\d{10}/.test(aud.toValue || ''), aud);
  Z.check('CL8 nothing can be deleted or changed from the log: DELETE / PUT / POST on it are refused (404)', [(await api('admin', 'DELETE', `/consent-log/${row.id}`)).status, (await api('admin', 'PUT', `/consent-log/${row.id}`, {})).status, (await api('admin', 'POST', '/consent-log', {})).status].every((s2) => s2 === 404) && S.num((await S.q('SELECT COUNT(*) n FROM "OutreachConsentEvent" WHERE id = ?', row.id))[0].n) === 1);

  // ================================================================= staff templates: CRUD + role gates + usage
  const tid = await mkTpl('Staff reminder A', 'Hello {{name}}, please read the new policy.\nStop these emails: {{unsubscribe}}', 'ZZTEST OS policy', 'internal', 'hr');
  Z.check('IT1 the HR desk creates a staff template (reminder), and an apply link in a staff template is refused', !!tid && (await api('hr', 'POST', '/templates', { name: 'ZZTEST OS bad', channel: 'email', audience: 'internal', subject: 's', body: 'Apply {{apply_link}} {{unsubscribe}}', promotional: false })).status === 400);
  Z.check('IT2 Manager, TL, BDE and Recruiter cannot write a staff template (403)', (await Promise.all(['mgr', 'tl', 'bde', 'rec'].map((w) => api(w, 'POST', '/templates', { name: 'ZZTEST OS no', channel: 'email', audience: 'internal', subject: 's', body: 'x {{unsubscribe}}', promotional: false })))).every((r) => r.status === 403 || r.status === 400 && false));
  Z.check('IT3 only HR / Admin see the staff template list; the Recruiter gets an empty list', (await api('hr', 'GET', '/templates?type=internal')).body.templates.some((t) => t.id === tid) && (await api('rec', 'GET', '/templates?type=internal')).body.templates.length === 0 && (await api('mgr', 'GET', '/templates?type=internal')).body.templates.length === 0);
  const ed = await api('hr', 'PUT', `/templates/${tid}`, { name: 'ZZTEST OS Staff reminder A2', subject: 'ZZTEST OS policy v2', body: 'Hello {{name}}, the policy changed.\nStop these emails: {{unsubscribe}}' });
  Z.check('IT4 Edit and rename work (name and text change, live preview words come back)', ed.status === 200 && ed.body.template.name === 'ZZTEST OS Staff reminder A2' && /changed/.test(ed.body.template.body));
  const dup = await api('hr', 'POST', `/templates/${tid}/duplicate`);
  if (dup.status === 200) created.tplIds.push(dup.body.template.id);
  const dup2 = await api('hr', 'POST', `/templates/${tid}/duplicate`);
  if (dup2.status === 200) created.tplIds.push(dup2.body.template.id);
  Z.check('IT5 Duplicate makes a copy with a free name ("... (copy)", "... (copy 2)"), same channel and audience', dup.status === 200 && dup.body.template.name === 'ZZTEST OS Staff reminder A2 (copy)' && dup2.status === 200 && dup2.body.template.name === 'ZZTEST OS Staff reminder A2 (copy 2)' && dup.body.template.audience === 'internal', [dup.body, dup2.body]);
  Z.check('IT6 a Manager / BDE / Recruiter cannot duplicate or delete a staff template (403)', (await api('mgr', 'POST', `/templates/${tid}/duplicate`)).status !== 200 && (await api('bde', 'DELETE', `/templates/${tid}`)).status !== 200 && (await api('rec', 'DELETE', `/templates/${tid}`)).status !== 200);
  const del1 = await api('hr', 'DELETE', `/templates/${dup2.body.template.id}`);
  Z.check('IT7 an unused staff template can be deleted', del1.status === 200 && (await api('hr', 'GET', '/templates?type=internal')).body.templates.every((t) => t.id !== dup2.body.template.id));
  const lst = (await api('hr', 'GET', '/templates?type=internal')).body.templates.find((t) => t.id === tid);
  Z.check('IT8 the staff template list says how many times each is used (0 for this one)', lst && lst.usedByCampaigns === 0 && lst.usedByRules === 0, lst);
  const usedCamp = (await api('admin', 'POST', '/campaigns', { name: 'ZZTEST OS Staff used', type: 'internal', segmentIds: [segStaffQ], templateId: tplStaff, channel: 'email' }));
  const delUsed = await api('admin', 'DELETE', `/templates/${tplStaff}`);
  Z.check('IT9 a staff template that a campaign used cannot be deleted (409, plain reason: make a copy instead)', usedCamp.status === 200 && delUsed.status === 409 && /copy/i.test(delUsed.body.error), delUsed.body);

  // ================================================================= scheduled staff messages
  const todayIst = Sched.istDate(Date.now());
  const md = (n) => new Date(Date.parse(`${todayIst}T00:00:00Z`) + n * 86400000).toISOString().slice(5, 10); // mm-dd, n days from today
  const at = (h, m) => Date.parse(`${todayIst}T${h}:${m}:00+05:30`);
  const empB1 = await Z.mkUser('bday1', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education' }, { dateOfBirth: new Date(`1990-${md(0)}T00:00:00+05:30`), dateOfJoining: new Date(`2020-${md(3)}T00:00:00+05:30`) });
  const empB2 = await Z.mkUser('bday2', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical' }, { dateOfBirth: new Date(`1991-${md(5)}T00:00:00+05:30`), dateOfJoining: new Date(`${todayIst.slice(0, 4)}-${md(0)}T00:00:00+05:30`) });
  const empB3 = await Z.mkUser('anniv1', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education' }, { dateOfBirth: new Date(`1992-${md(7)}T00:00:00+05:30`), dateOfJoining: new Date(`2019-${md(0)}T00:00:00+05:30`) });
  const empGone = await Z.mkUser('gone1', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education' }, { dateOfBirth: new Date(`1989-${md(0)}T00:00:00+05:30`), employmentStatus: 'Relieved' });
  const stB1 = await mkContact('staffB1', { type: 'internal', email: empB1.email, importId: 'ZZOS-STAFF' });
  const stB2 = await mkContact('staffB2', { type: 'internal', email: empB2.email, importId: 'ZZOS-STAFF' });
  const stB3 = await mkContact('staffB3', { type: 'internal', email: empB3.email, importId: 'ZZOS-STAFF' });
  const stGone = await mkContact('staffGone', { type: 'internal', email: empGone.email, importId: 'ZZOS-STAFF' });
  const leadSame = await mkContact('leadSameEmail', { type: 'candidate_lead', email: empB1.email.replace('zz-os-bday1', 'zz-os-lead-bday1'), importId: 'ZZOS-LEADS2' });
  const tBirthday = await mkTpl('Birthday email', 'Happy birthday {{name}}!\nStop these emails: {{unsubscribe}}', 'ZZTEST OS happy birthday', 'internal', 'hr');
  const segStaff = await mkSeg('Staff group', { importIds: ['ZZOS-STAFF'] }, 'admin', 'internal');
  await setS({ master: true, emailTestMode: true, suppressDays: 0, quietHours: { enabled: false, start: '21:00', end: '08:00', applyInternal: false } });
  const rule = { name: 'ZZTEST OS Birthday', kind: 'birthday', time: '09:00', audience: { type: 'group', segmentId: segStaff }, templateId: tBirthday };
  const mk = await api('hr', 'POST', '/scheduled', rule);
  const rid = mk.body && mk.body.rule && mk.body.rule.id;
  Z.check('SC1 the HR desk makes a birthday rule: it is OFF by default', mk.status === 200 && mk.body.rule.enabled === false && mk.body.rule.trigger.type === 'birthday', mk.body);
  Z.check('SC2 Manager, TL, BDE and Recruiter cannot see or change scheduled messages (403)', (await Promise.all(['mgr', 'tl', 'bde', 'rec'].map(async (w) => [(await api(w, 'GET', '/scheduled')).status, (await api(w, 'POST', '/scheduled', rule)).status, (await api(w, 'POST', `/scheduled/${rid}/on`)).status, (await api(w, 'DELETE', `/scheduled/${rid}`)).status]))).every((r) => r.every((x) => x === 403)));
  Z.check('SC3 a rule cannot use a job-lead group or a job template (staff only)', (await api('admin', 'POST', '/scheduled', { ...rule, audience: { type: 'group', segmentId: segLeads } })).status === 400 && (await api('admin', 'POST', '/scheduled', { ...rule, templateId: tplJob })).status === 400);
  const t = (now2) => Sched.tick({ now: now2, holder: 'zzos-1' });
  const offTick = await t(at('09', '05'));
  Z.check('SC4 a rule that is OFF sends nothing (no queue rows at all)', offTick.skipped === 'no_rules' && S.num((await S.q('SELECT COUNT(*) n FROM "OutreachCampaign" WHERE name LIKE \'ZZTEST OS Birthday%\''))[0].n) === 0);
  const hrOn = await api('hr', 'POST', `/scheduled/${rid}/on`);
  Z.check('SC5 the HR desk cannot turn a rule On until an Admin allows Internal HR to send (403); an Admin can', hrOn.status === 403 && (await api('admin', 'POST', `/scheduled/${rid}/on`)).status === 200 && (await Sched.loadRules()).find((r) => r.id === rid).enabled === true);
  await setS({ master: false });
  const masterOff = await t(at('09', '05'));
  Z.check('SC6 with Outreach sending switched OFF the engine does nothing', masterOff.skipped === 'sending_off' && S.num((await S.q('SELECT COUNT(*) n FROM "OutreachCampaign" WHERE name LIKE \'ZZTEST OS Birthday%\''))[0].n) === 0);
  await setS({ master: true });
  const early = await t(at('08', '59'));
  const late = await t(at('15', '30'));
  Z.check('SC7 before the send time and more than 6 hours after it nothing runs', early.ran.length === 0 && late.ran.length === 0 && S.num((await S.q('SELECT COUNT(*) n FROM "OutreachCampaign" WHERE name LIKE \'ZZTEST OS Birthday%\''))[0].n) === 0, [early, late]);
  const run1 = await t(at('09', '05'));
  const cid = Sched.campaignIdOf(rid, todayIst);
  const msgs = await S.q('SELECT m.contactId, m.idempotencyKey, m.status, m.token, m.requirementId FROM "OutreachMessage" m WHERE m.campaignId = ?', cid);
  Z.check('SC8 at 09:05 the birthday engine queues exactly ONE message: the person whose birthday is today (not the relieved person, not the others, not the job lead with a similar email)', run1.ran.length === 1 && run1.ran[0].status === 'queued' && msgs.length === 1 && msgs[0].contactId === stB1 && msgs[0].status === 'queued', [run1, msgs]);
  Z.check('SC9 the message is a staff message: key sched:<rule>:<date>:<contact>, no tracked link, no job', msgs[0].idempotencyKey === `sched:${rid}:${todayIst}:${stB1}` && msgs[0].token === null && msgs[0].requirementId === null && (await S.q('SELECT type FROM "OutreachCampaign" WHERE id = ?', cid))[0].type === 'internal');
  const run2 = await t(at('09', '06')); const run3 = await Sched.tick({ now: at('09', '07'), holder: 'zzos-2' });
  const msgs2 = await S.q('SELECT id FROM "OutreachMessage" WHERE campaignId = ?', cid);
  Z.check('SC10 ticking again (and from a second server) never makes a second message: once only per rule + date + person', msgs2.length === 1 && run2.ran[0].fresh === 0 && (run3.skipped === 'other_server' || (run3.ran[0] && run3.ran[0].fresh === 0)), [run2.ran, run3]);
  const sent = await Run.tick({ now: at('09', '08'), maxMessages: 50 });
  const done = (await S.q('SELECT status FROM "OutreachMessage" WHERE campaignId = ?', cid))[0].status;
  Z.check('SC11 the existing staff path then rehearses it (test mode: nothing is really sent) and no funnel event is written', done === 'test_captured' && S.num((await S.q('SELECT COUNT(*) n FROM "OutreachEvent" WHERE campaignId = ? AND type IN (\'clicked\',\'applied\',\'delivered\')', cid))[0].n) === 0, [sent, done]);
  const runs = await api('hr', 'GET', `/scheduled/${rid}/runs`);
  Z.check('SC12 the run history shows the day, people and counts', runs.status === 200 && runs.body.runs.length >= 1 && runs.body.runs[0].date === todayIst && runs.body.runs[0].queued === 1 && runs.body.runs[0].people === 1, runs.body);
  const ls = await api('hr', 'GET', '/scheduled');
  const lr = ls.body.rules.find((r) => r.id === rid);
  Z.check('SC13 the list shows the next run, who is matched today, a plain status ("test mode: rehearsed") and the audience / message names', ls.status === 200 && lr.nextRuns.length === 3 && lr.todayPeople === 1 && lr.status.key === 'rehearsal' && lr.audienceWords.includes('Staff group') && lr.templateName === 'ZZTEST OS Birthday email', lr);
  // anniversary + department audience + all staff
  const mkA = await api('admin', 'POST', '/scheduled', { name: 'ZZTEST OS Anniversary', kind: 'anniversary', time: '09:00', audience: { type: 'group', segmentId: segStaff }, templateId: tBirthday });
  await api('admin', 'POST', `/scheduled/${mkA.body.rule.id}/on`);
  await Sched.tick({ now: at('09', '10'), holder: 'zzos-1' });
  const aMsgs = await S.q('SELECT contactId FROM "OutreachMessage" WHERE campaignId = ?', Sched.campaignIdOf(mkA.body.rule.id, todayIst));
  Z.check('SC14 the work-anniversary rule picks the person whose joining date is today (years ago), not the one who joined this year', aMsgs.length === 1 && aMsgs[0].contactId === stB3, aMsgs);
  const allPeople = await Sched.people({ trigger: { type: 'weekly', weekday: 1 }, audience: { type: 'all' } }, todayIst);
  Z.check('SC15 "All active staff" is staff contacts only: no job lead, no relieved employee', allPeople.ids.includes(stB1) && allPeople.ids.includes(stB2) && !allPeople.ids.includes(stGone) && !allPeople.ids.includes(leadSame) && !allPeople.ids.some((id) => created.contactIds.includes(id) && id === leadSame));
  const deptPeople = await Sched.people({ trigger: { type: 'weekly', weekday: 1 }, audience: { type: 'department', department: 'Medical' } }, todayIst);
  Z.check('SC16 a department audience gives only that department (Medical: the one Medical employee)', deptPeople.ids.includes(stB2) && !deptPeople.ids.includes(stB1) && !deptPeople.ids.includes(stB3), deptPeople.ids);
  // quiet hours apply to staff messages only when ticked
  const mkQ = await api('admin', 'POST', '/scheduled', { name: 'ZZTEST OS Weekly note', kind: 'policy', trigger: { type: 'fixed', date: todayIst }, time: '23:00', audience: { type: 'group', segmentId: segStaff }, templateId: tBirthday });
  await api('admin', 'POST', `/scheduled/${mkQ.body.rule.id}/on`);
  await setS({ quietHours: { enabled: true, start: '22:00', end: '06:00', applyInternal: true } });
  const qTick = await Sched.tick({ now: at('23', '05'), holder: 'zzos-1' });
  const qMsgs = S.num((await S.q('SELECT COUNT(*) n FROM "OutreachMessage" WHERE campaignId = ?', Sched.campaignIdOf(mkQ.body.rule.id, todayIst)))[0].n);
  Z.check('SC17 when quiet hours are ticked for staff messages, a rule due at night waits (nothing queued)', qTick.ran.some((r) => r.ruleId === mkQ.body.rule.id && r.status === 'waiting_quiet') && qMsgs === 0, [qTick.ran, qMsgs]);
  await setS({ quietHours: { enabled: true, start: '22:00', end: '06:00', applyInternal: false } });
  const qTick2 = await Sched.tick({ now: at('23', '06'), holder: 'zzos-1' });
  const qMsgs2 = S.num((await S.q('SELECT COUNT(*) n FROM "OutreachMessage" WHERE campaignId = ?', Sched.campaignIdOf(mkQ.body.rule.id, todayIst)))[0].n);
  Z.check('SC18 staff messages are exempt by default: the same rule runs inside quiet hours when the tick is not set', qTick2.ran.some((r) => r.ruleId === mkQ.body.rule.id && r.status === 'queued') && qMsgs2 === 3, [qTick2.ran, qMsgs2]);
  await setS({ quietHours: { enabled: false, start: '21:00', end: '08:00', applyInternal: false } });
  // test to me
  const sentBefore = S.num((await S.q('SELECT COUNT(*) n FROM "OutreachMessage" WHERE campaignId LIKE \'osch_%\'' ))[0].n);
  const sentMail = [];
  const mine = await Sched.testToMe(admin, rid, { mailSender: async (m) => { sentMail.push(m); return { ok: true, messageId: 'zz' }; } });
  const log = (await S.q('SELECT contactId, status, toMasked, subject FROM "OutreachSendLog" WHERE contactId = ? ORDER BY at DESC LIMIT 1', `self:${admin.id}`))[0];
  Z.check('SC19 "Send a test to me" goes only to the signed-in person (test mode: captured in the log for their own address) and queues nothing for staff', mine.ok === true && mine.status === 'test_captured' && log && log.status === 'test_captured' && /\[TEST\]/.test(log.subject) && S.num((await S.q('SELECT COUNT(*) n FROM "OutreachMessage" WHERE campaignId LIKE \'osch_%\''))[0].n) === sentBefore && sentMail.length === 0, [mine, log]);
  Z.check('SC20 only HR / Admin can send a test (Manager gets 403)', (await api('mgr', 'POST', `/scheduled/${rid}/test-to-me`)).status === 403 && (await api('rec', 'POST', `/scheduled/${rid}/test-to-me`)).status === 403);
  const ch = await api('admin', 'PUT', `/scheduled/${rid}`, { name: 'ZZTEST OS Birthday changed', time: '10:30' });
  Z.check('SC21 Edit works (new name and send time) and the list shows it', ch.status === 200 && ch.body.rule.time === '10:30' && ch.body.rule.name === 'ZZTEST OS Birthday changed');
  const usedByRule = await api('hr', 'DELETE', `/templates/${tBirthday}`);
  Z.check('SC22 a staff template used by a scheduled rule cannot be deleted (409)', usedByRule.status === 409 && /scheduled rule/.test(usedByRule.body.error), usedByRule.body);
  const off = await api('admin', 'POST', `/scheduled/${rid}/off`);
  Z.check('SC23 turning a rule Off works; deleting works; a deleted rule is gone', off.status === 200 && (await api('admin', 'DELETE', `/scheduled/${rid}`)).status === 200 && (await api('admin', 'GET', '/scheduled')).body.rules.every((r) => r.id !== rid));
  Z.check('SC24 the engine writes audit rows without phone or email', (await prisma.auditLog.count({ where: { userId: admin.id, action: { startsWith: 'Outreach scheduled message' } } })) >= 3);

  // ================================================================= Industry filter == direct SQL
  const indIds = [];
  indIds.push(await mkContact('indM1', { importId: 'ZZOS-IND', tags: ['Medical'], city: 'ZZOS Hyderabad' }));
  indIds.push(await mkContact('indM2', { importId: 'ZZOS-IND', tags: ['Medical'], city: 'ZZOS Hyderabad' }));
  indIds.push(await mkContact('indM3', { importId: 'ZZOS-IND', tags: ['Medical'], city: 'ZZOS Chennai' }));
  indIds.push(await mkContact('indB1', { importId: 'ZZOS-IND', tags: ['BDE'], city: 'ZZOS Hyderabad' }));
  indIds.push(await mkContact('indB2', { importId: 'ZZOS-IND', tags: ['BDE', 'Education'], city: 'ZZOS Chennai' }));
  indIds.push(await mkContact('indE1', { importId: 'ZZOS-IND', tags: ['Education'], city: 'ZZOS Hyderabad' }));
  const sqlCount = async (ind, city) => S.num((await S.q(`SELECT COUNT(DISTINCT c.id) n FROM "OutreachContact" c JOIN "OutreachContactTag" t ON t.contactId = c.id WHERE c.status = 'active' AND c.contactType = 'candidate_lead' AND t.industry = ?${city ? ' AND LOWER(c.city) = ?' : ''}`, ...(city ? [ind, city.toLowerCase()] : [ind])))[0].n);
  const listInd = (qs) => api('admin', 'GET', `/contacts?type=candidate_lead&pageSize=5&${qs}`);
  const iMed = await listInd('industries=Medical');
  const iBde = await listInd('industries=BDE');
  const iMedBde = await listInd(`industries=${encodeURIComponent('Medical|BDE')}`);
  Z.check('IF1 the Industry filter total equals direct SQL (Medical, BDE, Medical + BDE)', iMed.body.total === await sqlCount('Medical') && iBde.body.total === await sqlCount('BDE') && iMedBde.body.total === S.num((await S.q('SELECT COUNT(DISTINCT c.id) n FROM "OutreachContact" c JOIN "OutreachContactTag" t ON t.contactId = c.id WHERE c.status = \'active\' AND c.contactType = \'candidate_lead\' AND t.industry IN (\'Medical\',\'BDE\')'))[0].n), [iMed.body.total, iBde.body.total, iMedBde.body.total]);
  const iAll = await listInd('');
  const facetOf = (r, v) => (r.body.facets.industries.find((i) => i.value === v) || {}).count || 0;
  Z.check('IF2 every industry option shows its count, equal to direct SQL (Medical / BDE / Education)', facetOf(iAll, 'Medical') === await sqlCount('Medical') && facetOf(iAll, 'BDE') === await sqlCount('BDE') && facetOf(iAll, 'Education') === await sqlCount('Education'), iAll.body.facets.industries);
  const iCity = await listInd(`cities=${encodeURIComponent('ZZOS Hyderabad')}`);
  Z.check('IF3 the options are cascading: with the city "ZZOS Hyderabad" picked, each industry count equals direct SQL for that city (Medical 2, BDE 1, Education 1)', facetOf(iCity, 'Medical') === await sqlCount('Medical', 'ZZOS Hyderabad') && facetOf(iCity, 'BDE') === await sqlCount('BDE', 'ZZOS Hyderabad') && facetOf(iCity, 'Education') === await sqlCount('Education', 'ZZOS Hyderabad') && facetOf(iCity, 'Medical') === 2, iCity.body.facets.industries);
  const iBoth = await listInd(`industries=Medical&cities=${encodeURIComponent('ZZOS Chennai')}`);
  Z.check('IF4 industry + city together equals direct SQL (Medical in Chennai = 1)', iBoth.body.total === await sqlCount('Medical', 'ZZOS Chennai') && iBoth.body.total === 1);
  Z.check('IF5 the list carries each person\'s industry tags (shown as the Industry column)', iBde.body.contacts.every((c) => c.industries.includes('BDE')));
  Z.check('IF6 the access answer lists the admin-added industries too (Medical, BDE, Education, Manufacturing at least)', ['Medical', 'BDE', 'Education', 'Manufacturing'].every((n) => aAdmin.industries.some((i) => i.name === n)));

  // ================================================================= Distribution
  const qJobs = encodeURIComponent(`ZZTEST OS Job `);
  const dAdmin = await api('admin', 'GET', `/distribution?q=${qJobs}`);
  if (dAdmin.body && dAdmin.body.notReady) {
    Z.check('D0 Distribution answers honestly when job distribution is not switched on (notReady, no error)', dAdmin.status === 200 && dAdmin.body.jobs.length === 0);
  } else {
    const dRec = await api('rec', 'GET', `/distribution?q=${qJobs}`);
    const dBde = await api('bde', 'GET', `/distribution?q=${qJobs}`);
    const ids = (r) => (r.body.jobs || []).map((j) => j.id);
    Z.check('D1 Distribution: Admin sees both test jobs; a Recruiter sees the job assigned to them and not the other department\'s job; the BDE sees their job', dAdmin.status === 200 && ids(dAdmin).includes(JA.id) && ids(dAdmin).includes(JB.id) && ids(dRec).includes(JA.id) && !ids(dRec).includes(JB.id) && ids(dBde).includes(JA.id), [ids(dAdmin).length, ids(dRec), ids(dBde)]);
    const Plat = require(path.join(BACK, 'src/jobDist/platforms'));
    const places = (await Plat.list()).filter((p) => p.kind !== 'auto').length;
    const ja = (dAdmin.body.jobs || []).find((j) => j.id === JA.id);
    Z.check('D2 a job with nothing posted shows every place as "waiting" (counts equal the number of places) and no posted / expired', ja && ja.waiting === places && ja.posted === 0 && ja.expired === 0 && dAdmin.body.counts.jobsNotPosted >= 1, [ja, places]);
    const one = await api('admin', 'GET', `/distribution?q=${encodeURIComponent(`ZZTEST OS Job A ${RUN}`)}`);
    Z.check('D3 the search narrows to the one job', one.body.jobs.length === 1 && one.body.jobs[0].id === JA.id, one.body.jobs);
  }
  Z.check('D4 the HR desk and the accountant cannot open Distribution (403)', (await api('hr', 'GET', '/distribution')).status === 403 && (await api('acct', 'GET', '/distribution')).status === 403);

  // ================================================================= no real sending happened
  const realSent = S.num((await S.q('SELECT COUNT(*) n FROM "OutreachSendLog" WHERE mode = \'live\' AND status = \'sent\' AND subject LIKE \'%ZZTEST OS%\''))[0].n);
  Z.check('X1 nothing was really sent: no live "sent" row for these tests (all rehearsed / test captured)', realSent === 0);

  // ================================================================= cleanup
  await wipe();
  await Sched.stop();
  if (settingsBefore) await prisma.appSetting.update({ where: { key: 'outreach.settings' }, data: { value: settingsBefore.value } }); else await prisma.appSetting.deleteMany({ where: { key: 'outreach.settings' } });
  if (rulesBefore) await prisma.appSetting.update({ where: { key: 'outreach.scheduled.rules' }, data: { value: rulesBefore.value } }); else await prisma.appSetting.deleteMany({ where: { key: 'outreach.scheduled.rules' } });
  if (runsBefore) await prisma.appSetting.update({ where: { key: 'outreach.scheduled.runs' }, data: { value: runsBefore.value } }); else await prisma.appSetting.deleteMany({ where: { key: 'outreach.scheduled.runs' } });
  await S.run('DELETE FROM "OutreachRunnerLease" WHERE name = \'scheduler\' AND holder LIKE \'zzos-%\'');
  const left = await Z.cleanup();
  const leftOutreach = {
    contacts: S.num((await S.q('SELECT COUNT(*) n FROM "OutreachContact" WHERE name LIKE \'ZZTEST OS%\' OR source LIKE \'ZZTEST OS%\''))[0].n),
    campaigns: S.num((await S.q('SELECT COUNT(*) n FROM "OutreachCampaign" WHERE name LIKE \'ZZTEST OS%\''))[0].n),
    templates: S.num((await S.q('SELECT COUNT(*) n FROM "OutreachTemplate" WHERE name LIKE \'ZZTEST OS%\''))[0].n),
    segments: S.num((await S.q('SELECT COUNT(*) n FROM "OutreachSegment" WHERE name LIKE \'ZZTEST OS%\''))[0].n),
    consentOrphans: S.num((await S.q('SELECT COUNT(*) n FROM "OutreachConsentEvent" WHERE contactId NOT IN (SELECT id FROM "OutreachContact")'))[0].n),
  };
  console.log('left', JSON.stringify(left), JSON.stringify(leftOutreach));
  Z.check('Z1 cleanup: no ZZTEST OS rows are left (users, jobs, contacts, campaigns, templates, groups)', Object.values(left).every((v) => v === 0) && leftOutreach.contacts === 0 && leftOutreach.campaigns === 0 && leftOutreach.templates === 0 && leftOutreach.segments === 0, [left, leftOutreach]);
  await Z.finish();
})().catch(async (e) => { console.error('TEST CRASHED', e); try { await Z.cleanup(); } catch (e2) { /* best effort */ } process.exit(1); });
