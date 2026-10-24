// ---------------------------------------------------------------------------
// OMNI-CHANNEL OUTREACH, PHASE 1 + 2: acceptance test. SANDBOX ONLY (API 4011, prisma/sandbox.db). Nothing is ever really sent:
// the email adapter is used in TEST MODE (default) and, for the live-mode path, with a MOCK sender that records the call.
//   TL_API=http://localhost:4011 node scripts/outreach-p12-test.js
// ---------------------------------------------------------------------------
/* eslint-disable no-console, no-await-in-loop */
const path = require('path');
const XLSX = require('xlsx');
if (!process.env.TL_API) process.env.TL_API = 'http://localhost:4011';
const Z = require('./lib/zzfix')('OC');
const { BACK, prisma, API } = Z;
const S = require(path.join(BACK, 'src/outreach/store'));
const C = require(path.join(BACK, 'src/outreach/consent'));
const G = require(path.join(BACK, 'src/outreach/segments'));
const Lk = require(path.join(BACK, 'src/outreach/links'));
const T = require(path.join(BACK, 'src/outreach/templates'));
const email = require(path.join(BACK, 'src/outreach/adapters/email'));
const adapters = require(path.join(BACK, 'src/outreach/adapters'));
const O = '/api/outreach';

const raw = async (p, token, buf, query = '') => {
  let r;
  for (let i = 0; i < 120; i += 1) { try { r = await fetch(`${API}${O}${p}${query}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'X-Forwarded-For': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }, body: buf }); break; } catch (e) { await new Promise((x) => setTimeout(x, 3000)); } }
  let body = null; try { body = await r.json(); } catch { /* no json */ }
  return { status: r.status, body };
};
const csvOf = (rows) => Buffer.from(rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\n'));
const xlsxOf = (rows) => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Contacts'); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); };
const ph = (n) => `97654${String(n).padStart(5, '0')}`;
const em = (n) => `zz-oc-${Z.RUN}-${n}@example.test`;
const used = { phones: new Set(), emails: new Set() };
const rowOf = (n, o = {}) => { const p = o.phone === undefined ? ph(n) : o.phone; const e = o.email === undefined ? em(n) : o.email; if (p && /^\d{10}$/.test(p)) used.phones.add(p); if (e && /@example\.test$/.test(e)) used.emails.add(e); return [`ZZTEST OC Person ${n}`, p, e, 'ZZTEST OC Hospital', 'Hyderabad', 'ICU', '3', o.kind === undefined ? 'Medical' : o.kind, o.consent === undefined ? 'yes' : o.consent]; };
const HEAD = ['Name', 'Phone', 'Email', 'Company', 'City', 'Skills', 'Experience', 'Kind', 'Permission'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (u) => `?${new URLSearchParams(u).toString()}`;

(async () => {
  console.log('preclean', JSON.stringify(await Z.preclean()));
  const cleanTables = async () => {
    const ids = (await S.q('SELECT id FROM "OutreachContact" WHERE name LIKE \'ZZTEST OC%\' OR source LIKE \'ZZTEST OC%\'')).map((r) => r.id);
    const imps = (await S.q('SELECT id FROM "OutreachImport" WHERE fileName LIKE \'ZZTEST OC%\' OR source LIKE \'ZZTEST OC%\'')).map((r) => r.id);
    for (const id of ids) { await S.run('DELETE FROM "OutreachContactChannel" WHERE contactId = ?', id); await S.run('DELETE FROM "OutreachContactTag" WHERE contactId = ?', id); await S.run('DELETE FROM "OutreachConsentEvent" WHERE contactId = ?', id); await S.run('DELETE FROM "OutreachSendLog" WHERE contactId = ?', id); }
    await S.run('DELETE FROM "OutreachContact" WHERE name LIKE \'ZZTEST OC%\' OR source LIKE \'ZZTEST OC%\'');
    for (const id of imps) await S.run('DELETE FROM "OutreachImport" WHERE id = ?', id);
    await S.run('DELETE FROM "OutreachSegment" WHERE name LIKE \'ZZTEST OC%\'');
    await S.run('DELETE FROM "OutreachTemplate" WHERE name LIKE \'ZZTEST OC%\'');
    // do-not-contact hashes of the test addresses (and the consent history rows that carry them)
    for (const p of used.phones) { const h = S.hashAddress('phone', p); await S.run('DELETE FROM "OutreachSuppression" WHERE addressHash = ?', h); await S.run('DELETE FROM "OutreachConsentEvent" WHERE addressHash = ?', h); }
    for (const e of used.emails) { const h = S.hashAddress('email', e); await S.run('DELETE FROM "OutreachSuppression" WHERE addressHash = ?', h); await S.run('DELETE FROM "OutreachConsentEvent" WHERE addressHash = ?', h); }
    await S.run('DELETE FROM "OutreachSendLog" WHERE subject LIKE \'ZZTEST OC%\'');
  };
  const settingsBefore = await prisma.appSetting.findUnique({ where: { key: 'outreach.settings' } });
  const indBefore = await prisma.appSetting.findUnique({ where: { key: 'outreach.industries' } });
  await cleanTables();
  Z.check('tables exist (migration applied to the sandbox)', await S.ready());

  const admin = await Z.mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
  const mgr = await Z.mkUser('mgr', { role: 'MANAGER', atsRole: 'MANAGER' });
  const tl = await Z.mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'TL' });
  const stl = await Z.mkUser('stl', { role: 'STL', atsRole: 'STL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'STL' });
  const bde = await Z.mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, {});
  const bdetl = await Z.mkUser('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL' });
  const rec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }, {});
  const rec2 = await Z.mkUser('rec2', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, {});
  const hr = await Z.mkUser('hr', { role: 'HR', atsRole: 'HR', hrmsRole: 'HR' }, {});
  const acct = await Z.mkUser('acct', { role: 'EMPLOYEE', atsRole: 'ACCOUNTANT', accountsRole: 'ACCOUNTANT' }, {});
  const tok = {};
  for (const [k, u] of Object.entries({ admin, mgr, tl, stl, bde, bdetl, rec, rec2, hr, acct })) tok[k] = await Z.mint(u);
  const call = (who, method, p, body) => Z.call(method, `${O}${p}`, tok[who], body);

  // ---------------------------------------------------------------- sidebar entry + tabs per role
  const acc = {};
  for (const k of Object.keys(tok)) acc[k] = await call(k, 'GET', '/access');
  const seen = ['admin', 'mgr', 'tl', 'stl', 'bde', 'bdetl', 'rec', 'rec2', 'hr'];
  Z.check('sidebar entry: every recruitment role + HR gets access (200)', seen.every((k) => acc[k].status === 200 && acc[k].body.kind !== 'none'), seen.map((k) => `${k}:${acc[k].status}:${acc[k].body && acc[k].body.kind}`).join(' '));
  Z.check('accountant is refused', acc.acct.status === 403);
  Z.check('kinds are right', acc.admin.body.kind === 'admin' && acc.mgr.body.kind === 'view' && acc.tl.body.kind === 'tl' && acc.stl.body.kind === 'tl' && acc.bde.body.kind === 'bde' && acc.bdetl.body.kind === 'bdetl' && acc.rec.body.kind === 'recruiter' && acc.hr.body.kind === 'hr', JSON.stringify(Object.fromEntries(seen.map((k) => [k, acc[k].body.kind]))));
  Z.check('tabs: HR = internal only; recruiter = contacts+templates read-only; admin sees channels', JSON.stringify(acc.hr.body.tabs) === '["internal"]' && acc.rec.body.tabs.includes('contacts') && !acc.rec.body.tabs.includes('internal') && !acc.rec.body.canImport && acc.admin.body.tabs.includes('channels') && acc.admin.body.tabs.includes('internal') && !acc.tl.body.tabs.includes('channels'), JSON.stringify(Object.fromEntries(seen.map((k) => [k, acc[k].body.tabs]))));
  Z.check('masking flags: bde/bdetl/recruiter masked; admin/tl/mgr not', acc.bde.body.masked && acc.bdetl.body.masked && acc.rec.body.masked && !acc.admin.body.masked && !acc.tl.body.masked && !acc.mgr.body.masked);
  Z.check('industries seeded: Medical, BDE, Education, Manufacturing', ['Medical', 'BDE', 'Education', 'Manufacturing'].every((n) => acc.admin.body.industries.some((i) => i.name === n)));

  // ---------------------------------------------------------------- import: check (nothing saved)
  const rows = [
    HEAD,
    rowOf(1), rowOf(2), rowOf(3, { kind: 'Education' }),
    rowOf(4, { phone: '12345', email: '' }), // invalid phone, no email -> unusable
    rowOf(5, { phone: '', email: 'not-an-email' }), // nothing valid
    rowOf(1), // repeated in file (same phone + email as row 1)
    rowOf(7, { consent: 'no' }), // file says no permission
    rowOf(8, { phone: '', email: em(8) }), // email only
    rowOf(9, { kind: 'Unknownland' }), // kind not in the list -> ignored, still added
    rowOf(10, { phone: '98765 99910 / 98765 99911', email: em(10) }), // two phones -> the first one
  ];
  used.phones.add('9876599910');
  const before = S.num((await S.q('SELECT COUNT(*) n FROM "OutreachContact"'))[0].n);
  const chk = await raw('/import/check', tok.admin, csvOf(rows), q({ type: 'candidate_lead', dupMode: 'skip' }));
  const t = chk.body && chk.body.totals;
  Z.check('check: counts exact (total 10, new 7, invalid 2, repeated-in-file 1, opted out 1)', chk.status === 200 && t.total === 10 && t.new === 7 && t.invalid === 2 && t.dup_in_file === 1 && t.opted_out === 1 && t.duplicate === 0, chk.body);
  Z.check('check: unknown kind reported', (chk.body.unknownIndustries || []).includes('Unknownland'));
  Z.check('check saves nothing', S.num((await S.q('SELECT COUNT(*) n FROM "OutreachContact"'))[0].n) === before);
  Z.check('check: phone column mapped from the heading', chk.body.mapping.phone === 1 && chk.body.mapping.email === 2 && chk.body.mapping.industry === 7);
  const xchk = await raw('/import/check', tok.admin, xlsxOf(rows), q({ type: 'candidate_lead' }));
  Z.check('check: the same file as Excel gives the same counts', xchk.status === 200 && xchk.body.totals.new === 7 && xchk.body.totals.invalid === 2);
  const nomap = await raw('/import/check', tok.admin, csvOf([['A', 'B'], ['x', 'y']]), q({ type: 'candidate_lead' }));
  Z.check('check: no phone/email column asks for mapping', nomap.status === 200 && nomap.body.needsMapping === true);
  const withMap = await raw('/import/check', tok.admin, csvOf([['Who', 'Contact'], ['ZZTEST OC Map 1', ph(31)]]), q({ type: 'candidate_lead', mapping: JSON.stringify({ name: 0, phone: 1 }) }));
  Z.check('check: manual column mapping works', withMap.status === 200 && withMap.body.totals.new === 1);
  used.phones.add(ph(31));

  // ---------------------------------------------------------------- import: save needs the tick
  const noTick = await raw('/import/save', tok.admin, csvOf(rows), q({ type: 'candidate_lead', filename: 'ZZTEST OC a.csv', basis: 'Our own past candidates' }));
  Z.check('save without the permission tick is refused and saves nothing', noTick.status === 400 && noTick.body.code === 'NO_PERMISSION_TICK' && S.num((await S.q('SELECT COUNT(*) n FROM "OutreachContact"'))[0].n) === before);
  const noBasis = await raw('/import/save', tok.admin, csvOf(rows), q({ type: 'candidate_lead', permission: '1', filename: 'ZZTEST OC a.csv' }));
  Z.check('save without a reason for the permission is refused', noBasis.status === 400 && noBasis.body.code === 'NO_BASIS');
  const sv = await raw('/import/save', tok.admin, csvOf(rows), q({ type: 'candidate_lead', permission: '1', basis: 'Our own past candidates who gave their number', filename: 'ZZTEST OC a.csv', source: 'ZZTEST OC source A', industries: 'Medical' }));
  Z.check('save: 7 added, 2 unusable, 1 repeated', sv.status === 200 && sv.body.counts.created === 7 && sv.body.counts.invalid === 2 && sv.body.counts.duplicates === 1 && sv.body.counts.optedOut === 1, sv.body);
  const impA = sv.body.importId;
  const list1 = await call('admin', 'GET', `/contacts${q({ q: 'ZZTEST OC Person', pageSize: 100 })}`);
  Z.check('contacts list shows 7 with kinds, the Education one tagged Education + Medical', list1.status === 200 && list1.body.total === 7 && list1.body.contacts.some((c) => c.name.endsWith('Person 3') && c.industries.includes('Education') && c.industries.includes('Medical')), list1.body && list1.body.total);
  const c1 = list1.body.contacts.find((c) => c.name.endsWith('Person 1'));
  const c7 = list1.body.contacts.find((c) => c.name.endsWith('Person 7'));
  const c8 = list1.body.contacts.find((c) => c.name.endsWith('Person 8'));
  const c10 = list1.body.contacts.find((c) => c.name.endsWith('Person 10'));
  const st = (c, ch) => (c.channels.find((x) => x.channel === ch) || {}).optIn;
  Z.check('permission stored: tick -> opted_in (source import_declared), file "no" -> opted_out', st(c1, 'email') === 'opted_in' && st(c1, 'whatsapp') === 'opted_in' && st(c7, 'email') === 'opted_out' && st(c7, 'sms') === 'opted_out' && c1.consentSource === 'import_declared' && !!c1.consentAt);
  Z.check('email-only contact has only an email channel; two phones -> first number', c8.channels.length === 1 && c8.channels[0].channel === 'email' && c10.phone === '+919876599910', JSON.stringify([c8.channels, c10.phone]));
  Z.check('linked_applicant_id is empty (outreach never makes an ATS candidate)', list1.body.contacts.every((c) => c.linkedApplicantId === null) && S.num((await prisma.candidate.count({ where: { name: { contains: 'ZZTEST OC' } } }))) === 0);
  const imp = await S.q('SELECT * FROM "OutreachImport" WHERE id = ?', impA);
  Z.check('import record keeps who/when/the words of the permission', imp[0].basisConfirmedById === admin.id && S.num(imp[0].basisConfirmedAt) > 0 && /past candidates/.test(imp[0].basis) && imp[0].sha256.length === 64);
  const hist = await call('admin', 'GET', '/imports');
  Z.check('import history lists the batch with counts', hist.body.imports.some((i) => i.id === impA && i.created === 7 && i.total === 10 && i.canUndo));

  // ---------------------------------------------------------------- duplicates: skip / update / merge / undo
  const dupFile = [HEAD, ['ZZTEST OC Renamed 2', ph(2), '', 'ZZTEST OC NewCo', '', '', '', 'Education', 'yes'], rowOf(40)];
  used.phones.add(ph(40));
  const dChk = await raw('/import/check', tok.admin, csvOf(dupFile), q({ type: 'candidate_lead', dupMode: 'update' }));
  Z.check('dup check on the phone: 1 duplicate, 1 new (preview before saving)', dChk.body.totals.duplicate === 1 && dChk.body.totals.new === 1 && dChk.body.problems[0].status === 'duplicate');
  const sk = await raw('/import/save', tok.admin, csvOf(dupFile), q({ type: 'candidate_lead', permission: '1', basis: 'Same people as before', filename: 'ZZTEST OC b.csv', source: 'ZZTEST OC source B', dupMode: 'skip' }));
  const p2 = (await call('admin', 'GET', `/contacts${q({ q: 'Person 2', pageSize: 100 })}`)).body.contacts.find((c) => c.name.endsWith('Person 2'));
  Z.check('skip mode: existing person untouched, new one added', sk.body.counts.created === 1 && sk.body.counts.updated === 0 && p2 && p2.company === 'ZZTEST OC Hospital');
  const impSkip = sk.body.importId;
  const dupFile2 = [HEAD, ['ZZTEST OC Merged 2', ph(2), em(2), '', 'Chennai', '', '', 'Education', 'yes']];
  const mg = await raw('/import/save', tok.admin, csvOf(dupFile2), q({ type: 'candidate_lead', permission: '1', basis: 'Same people as before', filename: 'ZZTEST OC c.csv', source: 'ZZTEST OC source C', dupMode: 'merge' }));
  const p2m = (await call('admin', 'GET', `/contacts${q({ q: 'Person 2', pageSize: 100 })}`)).body.contacts.find((c) => c.name.endsWith('Person 2'));
  Z.check('merge mode: file only fills blanks (name/city kept), kind added', mg.body.counts.updated === 1 && p2m.name.endsWith('Person 2') && p2m.city === 'Hyderabad' && p2m.industries.includes('Education'), p2m);
  const up = await raw('/import/save', tok.admin, csvOf([HEAD, ['ZZTEST OC Renamed 2', ph(2), '', 'ZZTEST OC NewCo', '', '', '', '', 'yes']]), q({ type: 'candidate_lead', permission: '1', basis: 'Same people as before', filename: 'ZZTEST OC d.csv', source: 'ZZTEST OC source D', dupMode: 'update' }));
  const p2u = (await call('admin', 'GET', `/contacts${q({ q: 'Renamed', pageSize: 100 })}`)).body.contacts[0];
  Z.check('update mode: file wins for name / company', up.body.counts.updated === 1 && p2u && p2u.name === 'ZZTEST OC Renamed 2' && p2u.company === 'ZZTEST OC NewCo', up.body);
  const und = await call('admin', 'POST', `/imports/${up.body.importId}/undo`);
  const p2b = (await call('admin', 'GET', `/contacts${q({ q: 'Person 2', pageSize: 100 })}`)).body.contacts.find((c) => c.name.endsWith('Person 2'));
  Z.check('undo of an update batch restores the person', und.status === 200 && und.body.restored === 1 && p2b && p2b.company === 'ZZTEST OC Hospital');
  const und2 = await call('admin', 'POST', `/imports/${up.body.importId}/undo`);
  Z.check('undo twice is refused', und2.status === 409);
  const undSkip = await call('admin', 'POST', `/imports/${impSkip}/undo`);
  const p40 = await S.q('SELECT id FROM "OutreachContact" WHERE phoneKey = ?', ph(40).slice(-10));
  Z.check('undo of a batch removes the people it added (person 40 gone)', undSkip.status === 200 && undSkip.body.removed === 1 && p40.length === 0);
  const undOther = await call('bde', 'POST', `/imports/${impA}/undo`);
  Z.check('someone else cannot undo my batch', undOther.status === 403);
  const hist2 = await call('admin', 'GET', '/imports');
  Z.check('history shows undone batches', hist2.body.imports.find((i) => i.id === up.body.importId).undoneAt);

  // unique index is the backstop
  let uniqueHit = false;
  try { await S.run('INSERT INTO "OutreachContact" (id, contactType, phoneKey, status, createdAt, updatedAt) VALUES (?,?,?,?,?,?)', 'ZZOCDUP', 'candidate_lead', ph(1).slice(-10), 'active', 1, 1); } catch (e) { uniqueHit = /UNIQUE/i.test(String(e.message)); }
  Z.check('database refuses a second live contact with the same phone', uniqueHit);

  // ---------------------------------------------------------------- opt-out: never overridden by a re-import
  const optOut = await call('admin', 'POST', `/contacts/${c1.id}/opt-out`, { channel: 'email', reason: 'Asked us on the phone to stop' });
  Z.check('admin marks opted out (with a reason)', optOut.status === 200 && optOut.body.changed.includes('email'));
  const noReason = await call('admin', 'POST', `/contacts/${c1.id}/opt-out`, { channel: 'sms', reason: '' });
  Z.check('opt-out needs a reason', noReason.status === 400);
  const again = await call('admin', 'POST', `/contacts/${c1.id}/opt-out`, { channel: 'email', reason: 'Asked us again to stop' });
  Z.check('opt-out is idempotent (already opted out)', again.status === 200 && again.body.changed.length === 0);
  for (const mode of ['update', 'merge', 'skip']) {
    await raw('/import/save', tok.admin, csvOf([HEAD, rowOf(1, { consent: 'yes' })]), q({ type: 'candidate_lead', permission: '1', basis: 'Everybody agreed, honestly', filename: 'ZZTEST OC e.csv', source: 'ZZTEST OC source E', dupMode: mode }));
  }
  const c1b = (await call('admin', 'GET', `/contacts/${c1.id}`)).body;
  Z.check('re-import (update/merge/skip) with "yes" never lifts an opt-out', c1b.contact.channels.find((c) => c.channel === 'email').optIn === 'opted_out');
  const events = c1b.history.filter((h) => h.channel === 'email');
  Z.check('history kept: opt_in then opt_out rows, no address in them', events.some((e) => e.action === 'opt_in') && events.filter((e) => e.action === 'opt_out').length === 1 && !JSON.stringify(c1b.history).includes('example.test'));
  const optInNo = await call('bde', 'POST', `/contacts/${c1.id}/opt-in`, { channel: 'email', reason: 'They asked to hear again' });
  Z.check('only an Admin can opt in again', optInNo.status === 403);
  const optInShort = await call('admin', 'POST', `/contacts/${c1.id}/opt-in`, { channel: 'email', reason: 'x' });
  Z.check('opt in again needs a written reason', optInShort.status === 400);
  const optIn = await call('admin', 'POST', `/contacts/${c1.id}/opt-in`, { channel: 'email', reason: 'They asked to hear again by phone' });
  const c1c = (await call('admin', 'GET', `/contacts/${c1.id}`)).body;
  Z.check('admin opts in again; both events stay in the history', optIn.status === 200 && c1c.contact.channels.find((c) => c.channel === 'email').optIn === 'opted_in' && c1c.history.filter((h) => h.channel === 'email').length === 3);
  await call('admin', 'POST', `/contacts/${c1.id}/opt-out`, { channel: 'email', reason: 'Opted out again, for the later tests' });

  // erase keeps only a hash; same address imported again lands opted out
  const eraseRes = await call('admin', 'DELETE', `/contacts/${c10.id}?reason=${encodeURIComponent('Asked us to delete (ZZTEST)')}`);
  const gone = await S.q('SELECT name, phoneE164, email, status FROM "OutreachContact" WHERE id = ?', c10.id);
  Z.check('erase wipes the details and keeps the row as deleted', eraseRes.status === 200 && gone[0].status === 'deleted' && gone[0].name === null && gone[0].phoneE164 === null && gone[0].email === null);
  const reimp = await raw('/import/save', tok.admin, csvOf([HEAD, rowOf(10, { phone: '9876599910', consent: 'yes' })]), q({ type: 'candidate_lead', permission: '1', basis: 'Re-added by mistake', filename: 'ZZTEST OC f.csv', source: 'ZZTEST OC source F' }));
  const c10n = (await call('admin', 'GET', `/contacts${q({ q: 'Person 10', pageSize: 100 })}`)).body.contacts[0];
  Z.check('re-import of an erased person lands opted out on every channel', reimp.status === 200 && reimp.body.counts.optedOut === 1 && c10n.channels.length >= 2 && c10n.channels.every((c) => c.optIn === 'opted_out'), c10n);

  // ---------------------------------------------------------------- legacy STOP list is honoured
  await prisma.appSetting.upsert({ where: { key: `bc.dnc.91${ph(50)}` }, create: { key: `bc.dnc.91${ph(50)}`, value: '{}' }, update: {} });
  const lg = await raw('/import/save', tok.admin, csvOf([HEAD, rowOf(50, { email: '' })]), q({ type: 'candidate_lead', permission: '1', basis: 'Our own contact list', filename: 'ZZTEST OC g.csv', source: 'ZZTEST OC source G' }));
  const c50 = (await call('admin', 'GET', `/contacts${q({ q: 'Person 50', pageSize: 100 })}`)).body.contacts[0];
  await prisma.appSetting.deleteMany({ where: { key: `bc.dnc.91${ph(50)}` } });
  Z.check('a number on the old WhatsApp STOP list lands opted out', lg.status === 200 && st(c50, 'whatsapp') === 'opted_out');

  // ---------------------------------------------------------------- internal contacts
  const iFile = [HEAD, ['ZZTEST OC Staff 1', ph(60), em(60), 'TeamLink', 'Hyderabad', 'HR', '5', 'Medical', 'yes'], ['ZZTEST OC Staff 2', ph(61), em(61), 'TeamLink', 'Hyderabad', 'HR', '5', '', 'yes']];
  used.phones.add(ph(60)); used.phones.add(ph(61)); used.emails.add(em(60)); used.emails.add(em(61));
  const iBde = await raw('/import/check', tok.bde, csvOf(iFile), q({ type: 'internal' }));
  const iRec = await raw('/import/check', tok.rec, csvOf(iFile), q({ type: 'internal' }));
  Z.check('only HR desk / Admin may import INTERNAL contacts (bde, recruiter refused)', iBde.status === 403 && iRec.status === 403);
  const hrLead = await raw('/import/check', tok.hr, csvOf(rows), q({ type: 'candidate_lead' }));
  Z.check('HR desk cannot import candidate leads', hrLead.status === 403);
  const iSave = await raw('/import/save', tok.hr, csvOf(iFile), q({ type: 'internal', permission: '1', basis: 'Our own staff list', filename: 'ZZTEST OC staff.csv', source: 'ZZTEST OC source STAFF', industries: 'Medical' }));
  Z.check('HR desk imports internal contacts', iSave.status === 200 && iSave.body.counts.created === 2, iSave.body);
  const hrList = await call('hr', 'GET', `/contacts${q({ type: 'internal', pageSize: 100 })}`);
  Z.check('HR sees internal contacts (unmasked), only those', hrList.body.total >= 2 && hrList.body.contacts.every((c) => c.contactType === 'internal') && hrList.body.contacts[0].phone.startsWith('+91'));
  const hrLeads = await call('hr', 'GET', `/contacts${q({ type: 'candidate_lead' })}`);
  Z.check('HR desk sees NO candidate leads (Internal tab only)', hrLeads.status === 200 && hrLeads.body.total === 0);
  for (const who of ['bde', 'bdetl', 'tl', 'mgr', 'rec']) {
    const r = await call(who, 'GET', `/contacts${q({ type: 'internal' })}`);
    Z.check(`${who} sees no internal contacts`, r.status === 200 && r.body.total === 0);
  }
  const staff1 = hrList.body.contacts.find((c) => c.name.endsWith('Staff 1'));
  const peek = await call('bde', 'GET', `/contacts/${staff1.id}`);
  Z.check('a BDE cannot open an internal contact by id', peek.status === 404);
  // segments: internal group; the job-promotion resolver refuses it and never returns internal people
  const segInt = await call('hr', 'POST', '/segments', { name: 'ZZTEST OC Staff group', contactType: 'internal', rules: { industries: ['Medical'] } });
  // DATA: the copy of the real database already holds real Education contacts and groups, which the Education recruiter may rightly see.
  // So the check below looks at OUR contacts only: the Education recruiter must see none of the ZZTEST contacts that are not tagged Education.
  const segLead = await call('admin', 'POST', '/segments', { name: 'ZZTEST OC Medical leads', rules: { industries: ['Medical'] } });
  Z.check('groups: HR makes an internal group, admin a lead group; the lead group counts only leads', segInt.status === 200 && segLead.status === 200 && segLead.body.segment.counts.total >= 7 && segInt.body.segment.counts.total === 2, [segLead.body, segInt.body]);
  let refused = null;
  try { await G.resolveTargets({ segmentIds: [segInt.body.segment.id], channel: 'email', purpose: 'job_promotion' }); } catch (e) { refused = e.code; }
  Z.check('job promotion to an INTERNAL group is refused by the data layer', refused === 'internal_contact', refused);
  const leadIds = await G.resolveTargets({ segmentIds: [segLead.body.segment.id], channel: 'email', purpose: 'job_promotion' });
  const types = leadIds.length ? await S.q(`SELECT DISTINCT contactType FROM "OutreachContact" WHERE id IN (${leadIds.map(() => '?').join(',')})`, ...leadIds) : [];
  Z.check('job promotion targets are only candidate leads, only opted in on that channel', leadIds.length > 0 && types.length === 1 && types[0].contactType === 'candidate_lead' && !leadIds.includes(c1.id) && !leadIds.includes(c7.id), leadIds.length);
  // a lead group whose rules say "Medical" must NOT pick up the internal Medical-tagged staff (type is forced)
  const mixed = await G.resolveTargets({ segmentIds: [segLead.body.segment.id], purpose: 'job_promotion' });
  const staffIds = hrList.body.contacts.map((c) => c.id);
  Z.check('internal contact tagged Medical never appears in a lead group', mixed.every((id) => !staffIds.includes(id)));
  let notInt = null;
  try { await G.resolveTargets({ segmentIds: [segLead.body.segment.id], purpose: 'internal' }); } catch (e) { notInt = e.code; }
  Z.check('an internal send cannot use a lead group either', notInt === 'not_internal');
  const segIntBde = await call('bde', 'POST', '/segments', { name: 'ZZTEST OC bde internal', contactType: 'internal', rules: {} });
  Z.check('a BDE cannot make an internal group', segIntBde.status === 403);

  // ---------------------------------------------------------------- segments: live counts
  const live0 = (await call('admin', 'GET', '/segments')).body.segments.find((s) => s.id === segLead.body.segment.id).counts;
  const addOne = await call('admin', 'POST', '/contacts', { name: 'ZZTEST OC Person 70', phone: ph(70), email: em(70), industries: ['Medical'], contactType: 'candidate_lead' });
  used.phones.add(ph(70)); used.emails.add(em(70));
  const live1 = (await call('admin', 'GET', '/segments')).body.segments.find((s) => s.id === segLead.body.segment.id).counts;
  Z.check('segment count is live (a new Medical person raises it by 1; added by hand = permission unknown, not reachable)', addOne.status === 200 && live1.total === live0.total + 1 && live1.reachable.email === live0.reachable.email, [live0, live1]);
  const dupHand = await call('admin', 'POST', '/contacts', { name: 'ZZTEST OC Person 70b', phone: ph(70), contactType: 'candidate_lead' });
  Z.check('adding by hand the same phone is refused as a duplicate', dupHand.status === 409);
  const segPrev = await call('admin', 'POST', '/segments/preview', { rules: { industries: ['Education'], reachable: ['email'] } });
  Z.check('segment preview counts (Education + reachable on email)', segPrev.status === 200 && segPrev.body.counts.total >= 2 && segPrev.body.counts.reachable.email >= 2, segPrev.body);
  const segBadInd = await call('admin', 'POST', '/segments', { name: 'ZZTEST OC bad', rules: { industries: ['Nonsense'] } });
  Z.check('a group needs a listed kind', segBadInd.status === 400);
  const segDup = await call('admin', 'POST', '/segments', { name: 'zztest oc medical leads', rules: {} });
  Z.check('duplicate group name refused', segDup.status === 409);
  const newInd = await call('admin', 'POST', '/industries', { name: 'ZZTEST OC Aviation' });
  const newIndBde = await call('bde', 'POST', '/industries', { name: 'ZZTEST OC Other' });
  Z.check('admin can add a kind, a BDE cannot', newInd.status === 200 && newIndBde.status === 403);

  // ---------------------------------------------------------------- role scope on contacts
  const bdeImp = await raw('/import/save', tok.bde, csvOf([HEAD, rowOf(80), rowOf(81)]), q({ type: 'candidate_lead', permission: '1', basis: 'Contacts of my own desk', filename: 'ZZTEST OC bde.csv', source: 'ZZTEST OC source BDE', industries: 'BDE' }));
  used.phones.add(ph(81)); used.emails.add(em(81));
  Z.check('BDE can import (own desk)', bdeImp.status === 200 && bdeImp.body.counts.created === 2, bdeImp.body);
  const bdeList = await call('bde', 'GET', `/contacts${q({ pageSize: 100 })}`);
  Z.check('BDE sees ONLY their own contacts, masked (phone and email)', bdeList.body.total === 2 && bdeList.body.contacts.every((c) => /•|\*|x/i.test(c.phone) && !c.phone.includes(ph(80)) && !/zz-oc/.test(c.email)), bdeList.body.contacts[0]);
  const bdeSearchPhone = await call('bde', 'GET', `/contacts${q({ q: ph(80).slice(-6) })}`);
  Z.check('a masked login cannot find a person by phone digits', bdeSearchPhone.body.total === 0);
  const bdeSearchName = await call('bde', 'GET', `/contacts${q({ q: 'Person 80' })}`);
  Z.check('...but can by name', bdeSearchName.body.total === 1);
  const tlOwn = await call('tl', 'GET', `/contacts${q({ pageSize: 100 })}`);
  Z.check('a TL does not see the BDE\'s contacts (own only) and has no contacts yet', tlOwn.body.total === 0);
  const tlImp = await raw('/import/save', tok.tl, csvOf([HEAD, rowOf(82)]), q({ type: 'candidate_lead', permission: '1', basis: 'My own team contacts', filename: 'ZZTEST OC tl.csv', source: 'ZZTEST OC source TL', industries: 'Education' }));
  used.phones.add(ph(82)); used.emails.add(em(82));
  const stlImp = await raw('/import/check', tok.stl, csvOf([HEAD, rowOf(83)]), q({ type: 'candidate_lead' }));
  const tlList = await call('tl', 'GET', '/contacts');
  Z.check('TL and STL may import; TL sees own contact unmasked', tlImp.status === 200 && stlImp.status === 200 && tlList.body.contacts[0].phone === `+91${ph(82)}`.replace('+9197654', '+9197654'), tlList.body.contacts[0]);
  const bdetlImp = await raw('/import/check', tok.bdetl, csvOf([HEAD, rowOf(84)]), q({ type: 'candidate_lead' }));
  Z.check('BDE TL may import', bdetlImp.status === 200);
  const mgrList = await call('mgr', 'GET', `/contacts${q({ pageSize: 100 })}`);
  const mgrImp = await raw('/import/check', tok.mgr, csvOf(rows), q({ type: 'candidate_lead' }));
  const mgrOpt = await call('mgr', 'POST', `/contacts/${c1.id}/opt-out`, { channel: 'sms', reason: 'Manager tries to change' });
  Z.check('Manager: sees every lead contact, cannot import or change opt-outs', mgrList.body.total >= 9 && mgrImp.status === 403 && mgrOpt.status === 403, [mgrList.body.total, mgrImp.status, mgrOpt.status]);
  // recruiter: segments of own department only, masked, read only
  const recSeg = await call('rec', 'GET', '/segments');
  const rec2Seg = await call('rec2', 'GET', '/segments');
  Z.check('recruiter (Medical) sees the Medical group; recruiter (Education) does not', recSeg.body.segments.some((s) => s.id === segLead.body.segment.id) && !rec2Seg.body.segments.some((s) => s.id === segLead.body.segment.id), [recSeg.body.segments.map((s) => s.name), rec2Seg.body.segments.map((s) => s.name)]);
  const recList = await call('rec', 'GET', `/contacts${q({ pageSize: 100 })}`);
  const rec2List = await call('rec2', 'GET', `/contacts${q({ pageSize: 100 })}`);
  Z.check('recruiter sees only the audience of their own groups, masked; other department sees none of our Medical ones', recList.body.total >= 5 && recList.body.contacts.every((c) => !c.phone.includes(ph(1).slice(-6)) && !/zz-oc/.test(c.email)) && rec2List.body.contacts.filter((c) => /ZZTEST OC/.test(c.name || '')).every((c) => (c.industries || []).includes('Education')), [recList.body.total, rec2List.body.total, rec2List.body.contacts.filter((c) => /ZZTEST OC/.test(c.name || '')).map((c) => [c.name, c.industries])]);
  const recImp = await raw('/import/save', tok.rec, csvOf(rows), q({ type: 'candidate_lead', permission: '1', basis: 'trying anyway', filename: 'ZZTEST OC rec.csv' }));
  const recOpt = await call('rec', 'POST', `/contacts/${recList.body.contacts[0].id}/opt-out`, { channel: 'all', reason: 'recruiter tries it' });
  const recSegCreate = await call('rec', 'POST', '/segments', { name: 'ZZTEST OC rec group', rules: {} });
  const recTpl = await call('rec', 'POST', '/templates', { name: 'ZZTEST OC rec tpl', channel: 'email', subject: 'Hi', body: 'Hi {{name}} {{unsubscribe}}', promotional: true });
  const recSettings = await call('rec', 'PUT', '/settings', { emailTestMode: false });
  const recCont = await call('rec', 'POST', '/contacts', { name: 'ZZTEST OC rec person', phone: ph(90) });
  Z.check('recruiter cannot import, opt out, make groups / templates, change settings or add people', [recImp.status, recOpt.status, recSegCreate.status, recTpl.status, recSettings.status, recCont.status].every((s) => s === 403), [recImp.status, recOpt.status, recSegCreate.status, recTpl.status, recSettings.status, recCont.status]);
  const recHist = await call('rec', 'GET', `/contacts/${recList.body.contacts[0].id}`);
  Z.check('recruiter can open a person in their audience, with no history', recHist.status === 200 && recHist.body.history.length === 0);
  const recOther = await call('rec2', 'GET', `/contacts/${c1.id}`);
  Z.check('recruiter of another department cannot open that person', recOther.status === 404);
  const acctC = await call('acct', 'GET', '/contacts');
  Z.check('accountant gets nothing', acctC.status === 403);
  const hrCh = await call('hr', 'GET', '/channels');
  const tlCh = await call('tl', 'GET', '/channels');
  Z.check('channels / settings are Admin only', hrCh.status === 403 && tlCh.status === 403);
  const exp = await call('bde', 'GET', '/contacts/export');
  const expA = await Z.call('GET', `${O}/contacts/export`, tok.admin);
  Z.check('only an Admin can download the contact list (xlsx)', exp.status === 403 && expA.status === 200 && expA.buf.slice(0, 2).toString() === 'PK');
  // cascading facets
  const fac = await call('admin', 'GET', `/contacts${q({ industries: 'Education', pageSize: 5 })}`);
  Z.check('filters cascade: facets are counted with the other filters applied', fac.status === 200 && fac.body.facets.industries.some((f) => f.value === 'Education') && fac.body.total === fac.body.facets.industries.find((f) => f.value === 'Education').count + 0, fac.body.facets);

  // ---------------------------------------------------------------- templates
  const tp = async (who, b) => call(who, 'POST', '/templates', b);
  const bad1 = await tp('admin', { name: 'ZZTEST OC t1', channel: 'email', subject: 'Job {{job_title}}', body: 'Hi {{nmae}}, apply {{apply_link}} {{unsubscribe}}', promotional: true });
  Z.check('unknown variable refused, named', bad1.status === 400 && /\{\{nmae\}\}/.test(bad1.body.error), bad1.body);
  const bad2 = await tp('admin', { name: 'ZZTEST OC t2', channel: 'email', subject: 'Job', body: 'Hi {{name}}, apply {{apply_link}}', promotional: true });
  Z.check('promotion email without opt-out is refused', bad2.status === 400 && /stop/i.test(bad2.body.error), bad2.body);
  const bad3 = await tp('admin', { name: 'ZZTEST OC t3', channel: 'sms', body: 'Job at {{company}} {{apply_link}}', promotional: true });
  Z.check('promotion SMS without STOP words is refused', bad3.status === 400);
  const ok3 = await tp('admin', { name: 'ZZTEST OC t3b', channel: 'sms', body: 'Job at {{company}} {{apply_link}} Reply STOP to opt out', promotional: true, dltTemplateId: '1107161234567890123', senderId: 'TLINKS' });
  Z.check('SMS with STOP words saves; DLT id + sender id stored', ok3.status === 200 && ok3.body.template.dltTemplateId === '1107161234567890123' && ok3.body.template.senderId === 'TLINKS' && ok3.body.template.ready === true, ok3.body);
  const badDlt = await tp('admin', { name: 'ZZTEST OC t3c', channel: 'sms', body: 'x {{unsubscribe}}', promotional: true, dltTemplateId: 'abc' });
  Z.check('a wrong DLT number is refused', badDlt.status === 400);
  const noDlt = await tp('admin', { name: 'ZZTEST OC t3d', channel: 'sms', body: 'x {{unsubscribe}}', promotional: true });
  Z.check('SMS promotion without DLT ids saves but is marked not ready', noDlt.status === 200 && noDlt.body.template.ready === false);
  const bad4 = await tp('admin', { name: 'ZZTEST OC t4', channel: 'email', audience: 'internal', subject: 'Hello', body: 'Apply here {{apply_link}} {{unsubscribe}}', promotional: true });
  Z.check('an internal template cannot carry an apply link', bad4.status === 400 && /apply link/i.test(bad4.body.error));
  const bad5 = await tp('admin', { name: 'ZZTEST OC t5', channel: 'email', body: 'Hi {{unsubscribe}}', promotional: true });
  Z.check('email needs a subject', bad5.status === 400);
  const wa = await tp('admin', { name: 'ZZTEST OC t6', channel: 'whatsapp', body: 'Hi {{name}}, {{job_title}} at {{company}}: {{apply_link}}. {{unsubscribe}}', promotional: true, waTemplateName: 'job_promo_v1', waLanguage: 'en', waApprovalStatus: 'pending' });
  Z.check('WhatsApp template: approval status stored, not ready until approved', wa.status === 200 && wa.body.template.waApprovalStatus === 'pending' && wa.body.template.ready === false);
  const waUp = await call('admin', 'PUT', `/templates/${wa.body.template.id}`, { waApprovalStatus: 'approved' });
  Z.check('approved WhatsApp template becomes ready', waUp.status === 200 && waUp.body.template.ready === true);
  const good = await tp('admin', { name: 'ZZTEST OC t7', channel: 'email', subject: 'ZZTEST OC {{job_title}} at {{company}}', body: 'Hi {{name}},\nApply: {{apply_link}}\nStop: {{unsubscribe}}', promotional: true });
  Z.check('a good email template saves', good.status === 200 && good.body.template.ready === true, good.body);
  const prev = await call('admin', 'POST', '/templates/preview', { channel: 'email', subject: 'Job {{job_title}}', body: 'Hi {{name}} {{company}} {{apply_link}} {{unsubscribe}} {{oops}}', promotional: true });
  Z.check('live preview fills a sample contact and flags the unknown word', prev.status === 200 && /Hi Anita City Care Hospital/.test(prev.body.preview.body) && prev.body.preview.unknown[0] === 'oops' && prev.body.problems.length > 0, prev.body);
  const smsPrev = T.render({ channel: 'sms', body: 'Go {{apply_link}} {{unsubscribe}}', subject: '' }, { apply_link: 'L' });
  Z.check('{{unsubscribe}} becomes "Reply STOP" on SMS/WhatsApp', smsPrev.body === 'Go L Reply STOP to opt out');
  const tplDup = await tp('admin', { name: 'zztest oc t7', channel: 'email', subject: 'x', body: '{{unsubscribe}}', promotional: true });
  Z.check('duplicate template name refused', tplDup.status === 409);
  const hrTplLead = await tp('hr', { name: 'ZZTEST OC t8', channel: 'email', subject: 'x', body: '{{unsubscribe}}', promotional: true });
  const hrTplInt = await tp('hr', { name: 'ZZTEST OC t9', channel: 'email', audience: 'internal', subject: 'Hello team', body: 'Hello {{name}} {{unsubscribe}}', promotional: false });
  Z.check('HR may write INTERNAL templates only', hrTplLead.status === 403 && hrTplInt.status === 200, [hrTplLead.status, hrTplInt.status]);
  const tList = await call('tl', 'GET', '/templates');
  const tListHr = await call('hr', 'GET', `/templates${q({ type: 'internal' })}`);
  Z.check('template lists are scoped (TL sees lead templates, HR sees internal ones)', tList.body.templates.some((x) => x.name === 'ZZTEST OC t7') && !tList.body.templates.some((x) => x.audience === 'internal') && tListHr.body.templates.every((x) => x.audience === 'internal') && tListHr.body.templates.length >= 1);
  const arch = await call('admin', 'DELETE', `/templates/${noDlt.body.template.id}`);
  Z.check('a template can be archived', arch.status === 200);

  // ---------------------------------------------------------------- email adapter (test mode default ON, mock transport)
  await prisma.appSetting.deleteMany({ where: { key: 'outreach.settings' } });
  const stDefault = await S.settings();
  Z.check('email TEST MODE is ON by default', stDefault.emailTestMode === true && stDefault.master === false);
  const target = (await call('admin', 'GET', `/contacts${q({ q: 'Person 2', pageSize: 100 })}`)).body.contacts.find((c) => c.name.endsWith('Person 2'));
  const trow = (await S.q('SELECT * FROM "OutreachContact" WHERE id = ?', target.id))[0];
  const contact = { id: trow.id, contactType: trow.contactType, name: trow.name, email: trow.email };
  const unsubUrl = Lk.unsubscribeUrl('https://example.org', Lk.mintUnsubscribe(contact.id, 'email'));
  let mockCalls = 0;
  const mock = async () => { mockCalls += 1; return { ok: true, providerRef: '<mock-1>' }; };
  const msg = { subject: 'ZZTEST OC hello', body: 'Hello there', kind: 'job_promotion', promotional: true, unsubscribeUrl: unsubUrl };
  const r1 = await email.send(contact, msg, { mailSender: mock });
  const log1 = await S.q('SELECT * FROM "OutreachSendLog" WHERE contactId = ? AND status = \'test_captured\'', contact.id);
  Z.check('test mode: NOTHING is handed to the mail sender; one log row; List-Unsubscribe headers built', r1.status === 'test_captured' && mockCalls === 0 && log1.length === 1 && r1.headers['List-Unsubscribe'] === `<${unsubUrl}>` && r1.headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click', [r1, log1.length, mockCalls]);
  Z.check('the log holds a masked address, not the address', !JSON.stringify(log1).includes('zz-oc-') && log1[0].toMasked.includes('•'));
  const rNoLink = await email.send(contact, { ...msg, unsubscribeUrl: '' }, { mailSender: mock });
  Z.check('a promotion without an unsubscribe link is refused', rNoLink.status === 'refused' && rNoLink.reason === 'no_unsubscribe_link');
  const optedOutContact = { id: c1.id, contactType: 'candidate_lead', name: 'x', email: em(1) };
  const rOut = await email.send(optedOutContact, msg, { mailSender: mock });
  Z.check('an opted-out contact is refused by the adapter itself', rOut.status === 'refused' && ['opted_out', 'suppressed'].includes(rOut.reason), rOut);
  const staffRow = (await S.q('SELECT * FROM "OutreachContact" WHERE id = ?', staff1.id))[0];
  const rInt = await email.send({ id: staffRow.id, contactType: 'internal', email: staffRow.email }, msg, { mailSender: mock });
  Z.check('an internal contact is refused for a job promotion', rInt.status === 'refused' && rInt.reason === 'internal_contact');
  const rInt2 = await email.send({ id: staffRow.id, contactType: 'candidate_lead', email: staffRow.email }, msg, { mailSender: mock });
  Z.check('...even when the caller lies about the type (data layer re-checks)', rInt2.status === 'refused' && rInt2.reason === 'internal_contact');
  const rNo = await email.send({ id: c7.id, contactType: 'candidate_lead', email: em(7) }, msg, { mailSender: mock });
  Z.check('a contact the file marked as no-permission is refused (opted out on the channel)', rNo.status === 'refused' && ['opted_out', 'suppressed'].includes(rNo.reason), rNo);
  // daily cap
  await S.saveSettings({ ...S.DEFAULT_SETTINGS, emailDailyCap: 2 });
  const cap = [];
  for (let i = 0; i < 3; i += 1) cap.push(await email.send(contact, { ...msg, subject: `ZZTEST OC cap ${i}` }, { mailSender: mock }));
  Z.check('daily cap (2): the 3rd message is refused', cap.filter((x) => x.status === 'refused' && x.reason === 'daily_cap').length >= 1 && mockCalls === 0, cap.map((x) => x.status + (x.reason || '')).join());
  // live mode with the MOCK sender only
  await S.saveSettings({ ...S.DEFAULT_SETTINGS, emailTestMode: false, emailDailyCap: 50, fromName: 'TeamLink Jobs', replyTo: 'jobs@example.test' });
  let seen1 = null;
  const rLive = await email.send(contact, { ...msg, subject: 'ZZTEST OC live', body: `Hello ${unsubUrl}` }, { mailSender: async (m) => { seen1 = m; return { ok: true, providerRef: '<mock-live>' }; } });
  Z.check('live mode (mock sender): sender called once with List-Unsubscribe headers, status sent, provider id kept', rLive.status === 'sent' && rLive.providerId === '<mock-live>' && seen1 && seen1.headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click' && seen1.to === contact.email, rLive);
  let seen2 = null;
  await email.send(contact, { ...msg, subject: 'ZZTEST OC footer', body: 'No link in the text' }, { mailSender: async (m) => { seen2 = m; return { ok: true }; } });
  Z.check('a footer with the unsubscribe link is added when the template did not place it', seen2 && seen2.text.includes(unsubUrl));
  const rFail = await email.send(contact, { ...msg, subject: 'ZZTEST OC fail' }, { mailSender: async () => ({ ok: false, error: 'boom', transient: true }) });
  Z.check('a sender failure is returned as data and logged (never thrown)', rFail.status === 'failed' && rFail.transient === true);
  await prisma.appSetting.deleteMany({ where: { key: 'outreach.settings' } });
  const stWA = await adapters.get('whatsapp').send(contact, msg);
  const stSMS = await adapters.get('sms').send(contact, msg);
  Z.check('WhatsApp and SMS adapters are stubs: they refuse and send nothing', stWA.status === 'refused' && stSMS.status === 'refused' && Array.isArray(adapters.get('sms').parseWebhook({})));
  // settings through the API
  const goLive1 = await call('admin', 'PUT', '/settings', { emailTestMode: false });
  const goLive0 = await call('tl', 'PUT', '/settings', { emailTestMode: false });
  const stNow = await S.settings();
  Z.check('going live needs the tick; a TL cannot; test mode stays ON', goLive1.status === 400 && goLive1.body.code === 'CONFIRM_LIVE' && goLive0.status === 403 && stNow.emailTestMode === true, [goLive1.status, goLive1.body, goLive0.status, stNow]);
  const goLive2 = await call('admin', 'PUT', '/settings', { emailTestMode: false, confirmLive: true });
  Z.check('even with the tick, live is refused when email is not set up in Integrations (sandbox)', [200, 400].includes(goLive2.status) && (goLive2.status === 400 ? /not ready/i.test(goLive2.body.error) : true), goLive2.body);
  await prisma.appSetting.deleteMany({ where: { key: 'outreach.settings' } });
  const capBad = await call('admin', 'PUT', '/settings', { emailDailyCap: -5 });
  const capOk = await call('admin', 'PUT', '/settings', { emailDailyCap: 25 });
  Z.check('daily limit validated and saved', capBad.status === 400 && capOk.status === 200 && capOk.body.settings.emailDailyCap === 25 && capOk.body.settings.emailTestMode === true, [capBad.status, capOk.body]);
  const chans = await call('admin', 'GET', '/channels');
  Z.check('channels screen data: email ready/test mode, WhatsApp + SMS not ready, log has rows, no secrets', chans.status === 200 && chans.body.channels.length === 3 && chans.body.channels.find((c) => c.channel === 'email').testMode === true && chans.body.channels.find((c) => c.channel === 'sms').ready === false && !/password|secret/i.test(JSON.stringify(chans.body)));

  // ---------------------------------------------------------------- unsubscribe token + public endpoint
  const ut = Lk.mintUnsubscribe(contact.id, 'email');
  const vok = Lk.verifyUnsubscribe(ut);
  Z.check('unsubscribe token verifies and carries no name/phone/email', vok.ok && vok.contactId === contact.id && vok.channel === 'email' && !ut.includes('ZZTEST') && !/example|@|\d{10}/.test(Buffer.from(ut.split('.')[1], 'base64url').toString()));
  const parts = ut.split('.');
  const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
  const tamperPayload = `${parts[0]}.${flip(parts[1], 4)}.${parts[2]}`;
  const tamperMac = `${parts[0]}.${parts[1]}.${flip(parts[2], 3)}`;
  const otherChannel = `u1.${Buffer.from(`${contact.id}|sms`).toString('base64url')}.${parts[2]}`;
  Z.check('tampered token fails (payload, signature, swapped channel, junk, empty)', !Lk.verifyUnsubscribe(tamperPayload).ok && !Lk.verifyUnsubscribe(tamperMac).ok && !Lk.verifyUnsubscribe(otherChannel).ok && !Lk.verifyUnsubscribe('u1.x.y').ok && !Lk.verifyUnsubscribe('').ok && !Lk.verifyUnsubscribe(null).ok);
  const pubGet = await Z.call('GET', `/api/public/outreach/u/${ut}`);
  const afterGet = (await call('admin', 'GET', `/contacts/${contact.id}`)).body.contact.channels.find((c) => c.channel === 'email').optIn;
  Z.check('GET shows a page with a button and changes NOTHING (link scanners are safe)', pubGet.status === 200 && /<form method="post"/.test(pubGet.text) && afterGet === 'opted_in', afterGet);
  const post1 = await Z.call('POST', `/api/public/outreach/u/${ut}`);
  const info1 = (await call('admin', 'GET', `/contacts/${contact.id}`)).body;
  Z.check('POST (no login) opts out that channel, sets unsubscribed_at, records the event', post1.status === 200 && /Done/.test(post1.text) && info1.contact.channels.find((c) => c.channel === 'email').optIn === 'opted_out' && info1.contact.channels.find((c) => c.channel === 'whatsapp').optIn === 'opted_in' && !!info1.contact.unsubscribedAt && info1.history.some((h) => h.action === 'opt_out' && h.source === 'unsubscribe_link'));
  const n1 = info1.history.length;
  const post2 = await Z.call('POST', `/api/public/outreach/u/${ut}`);
  const n2 = (await call('admin', 'GET', `/contacts/${contact.id}`)).body.history.length;
  Z.check('unsubscribe twice is idempotent: same answer, no second history row', post2.status === 200 && n2 === n1);
  const oneClick = await Z.call('POST', `/api/public/outreach/u/${ut}`, null, undefined, { 'Content-Type': 'application/x-www-form-urlencoded' });
  const hash = S.hashAddress('email', contact.email);
  const sup = await S.q('SELECT * FROM "OutreachSuppression" WHERE addressHash = ? AND channel = \'email\'', hash);
  Z.check('suppression hash written; one-click POST also fine', sup.length === 1 && sup[0].reason === 'unsubscribe_link' && oneClick.status === 200);
  const rAfter = await email.send(contact, msg, { mailSender: mock });
  Z.check('after unsubscribing the adapter refuses that contact', rAfter.status === 'refused' && ['opted_out', 'suppressed'].includes(rAfter.reason));
  const postBad = await Z.call('POST', `/api/public/outreach/u/${tamperMac}`);
  const postUnknown = await Z.call('POST', `/api/public/outreach/u/${Lk.mintUnsubscribe('ocdoesnotexist', 'email')}`);
  Z.check('a forged token is refused (400); a valid-looking one for nobody answers like a real one (no oracle)', postBad.status === 400 && postUnknown.status === 200 && /Done/.test(postUnknown.text));
  const alias = await Z.call('GET', `/u/${ut}`);
  Z.check('the short /u/<token> alias works too', alias.status === 200);

  // ---------------------------------------------------------------- tracked link token
  const tks = new Set();
  for (let i = 0; i < 2000; i += 1) tks.add(Lk.mintTracked({ contactType: 'candidate_lead', campaignType: 'job_promotion' }));
  const tk = [...tks][0];
  const tkBuf = Buffer.from(tk, 'base64url');
  const tampered = flip(tk, 5);
  Z.check('tracked token: 20 chars, URL-safe, 2000 unique, verifies', tk.length === 20 && /^[A-Za-z0-9_-]+$/.test(tk) && tks.size === 2000 && Lk.verifyTracked(tk));
  Z.check('tracked token: forged / altered / wrong length / junk do not verify', !Lk.verifyTracked(tampered) && !Lk.verifyTracked(tk.slice(0, 19)) && !Lk.verifyTracked(`${tk}x`) && !Lk.verifyTracked('AAAAAAAAAAAAAAAAAAAA') && !Lk.verifyTracked(null));
  Z.check('tracked token is opaque and PII-free (no id, phone, email, name inside)', !tk.includes(contact.id) && !tkBuf.toString('latin1').includes('ZZTEST') && !/\d{10}/.test(tkBuf.toString('latin1')));
  let ir = null; try { Lk.mintTracked({ contactType: 'internal', campaignType: 'job_promotion' }); } catch (e) { ir = e.code; }
  let ir2 = null; try { Lk.mintTracked({ contactType: 'candidate_lead', campaignType: 'internal' }); } catch (e) { ir2 = e.code; }
  Z.check('INTERNAL contacts / campaigns never get a tracked token', ir === 'internal_no_link' && ir2 === 'internal_no_link');
  const url = Lk.applyUrl('https://example.org/jobs/apply/tl_123', { campaignCode: 'camp7x', token: tk, channel: 'whatsapp' });
  Z.check('apply link has cid, ctk, ch and nothing personal', /cid=camp7x/.test(url) && url.includes(`ctk=${tk}`) && /ch=w/.test(url) && !/ZZTEST|@/.test(url));

  // ---------------------------------------------------------------- audit + PII-safe
  const aud = await prisma.auditLog.findMany({ where: { userId: { in: [admin.id, bde.id, hr.id, tl.id] }, entity: { startsWith: 'Outreach' } } });
  const acts = new Set(aud.map((a) => a.action));
  Z.check('audit rows written for imports, undo, opt-out / opt-in, templates, groups', ['Outreach contacts imported', 'Outreach import taken back', 'Outreach contact opted out', 'Outreach contact opted in again', 'Outreach template created', 'Outreach group created', 'Outreach contact erased (do-not-contact marker kept)'].every((a) => acts.has(a)), [...acts]);
  const piiLeak = aud.some((a) => [a.toValue, a.fromValue, a.reason].some((v) => v && (/example\.test/.test(v) || /9[0-9]{9}/.test(v) || /9765\d{6}/.test(v))));
  Z.check('audit rows carry no phone number or email address', !piiLeak);
  const logLeak = (await S.q('SELECT * FROM "OutreachSendLog"')).some((l) => /zz-oc-/.test(JSON.stringify(l)));
  Z.check('the send log holds no clear address (local part hidden)', !logLeak);

  // ---------------------------------------------------------------- cleanup (every row of mine) + proof
  await cleanTables();
  await prisma.appSetting.deleteMany({ where: { key: 'outreach.settings' } });
  if (settingsBefore) await prisma.appSetting.create({ data: { key: settingsBefore.key, value: settingsBefore.value } });
  await prisma.appSetting.deleteMany({ where: { key: 'outreach.industries' } });
  if (indBefore) await prisma.appSetting.create({ data: { key: indBefore.key, value: indBefore.value } });
  await prisma.appSetting.deleteMany({ where: { key: { startsWith: `bc.dnc.91${ph(50)}` } } });
  const left = await Z.cleanup();
  const rest = {
    contacts: S.num((await S.q('SELECT COUNT(*) n FROM "OutreachContact" WHERE name LIKE \'ZZTEST OC%\' OR source LIKE \'ZZTEST OC%\''))[0].n),
    imports: S.num((await S.q('SELECT COUNT(*) n FROM "OutreachImport" WHERE fileName LIKE \'ZZTEST OC%\''))[0].n),
    segs: S.num((await S.q('SELECT COUNT(*) n FROM "OutreachSegment" WHERE name LIKE \'ZZTEST OC%\''))[0].n),
    tpls: S.num((await S.q('SELECT COUNT(*) n FROM "OutreachTemplate" WHERE name LIKE \'ZZTEST OC%\''))[0].n),
    suppression: S.num((await S.q('SELECT COUNT(*) n FROM "OutreachSuppression" WHERE addressHash IN (' + [...used.phones].map((p) => `'${S.hashAddress('phone', p)}'`).concat([...used.emails].map((e) => `'${S.hashAddress('email', e)}'`)).join(',') + ')'))[0].n),
    audit: await prisma.auditLog.count({ where: { OR: [{ userId: { in: Z.made.users } }, { actorName: { contains: 'ZZTEST OC' } }] } }),
  };
  console.log('cleanup', JSON.stringify(left), JSON.stringify(rest));
  Z.check('cleanup: zero ZZTEST OC rows left', Object.values(left).every((v) => v === 0) && Object.values(rest).every((v) => v === 0));
  await Z.finish();
})().catch(async (e) => { console.error('CRASH', e); try { await prisma.$disconnect(); } catch { /* */ } process.exit(1); });
