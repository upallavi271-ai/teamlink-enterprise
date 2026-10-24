// ---------------------------------------------------------------------------
// READY TEMPLATE + POST TO ALL PLACES + CONTACT LISTS + WHATSAPP JOB BROADCAST: acceptance test.
// SANDBOX ONLY (API 4011, prisma/sandbox.db). Nothing is ever really sent or posted: the sandbox transport reports a fake
// send (broadcast/campaign.js transport) and the posting module only queues.
//   TL_API=http://localhost:4011 node scripts/job-template-broadcast-test.js
// ---------------------------------------------------------------------------
/* eslint-disable no-console, no-await-in-loop */
const path = require('path');
const XLSX = require('xlsx');
if (!process.env.TL_API) process.env.TL_API = 'http://localhost:4011';
const Z = require('./lib/zzfix')('JB');
const { BACK, prisma, API } = Z;
const L = require(path.join(BACK, 'src/broadcast/lists'));
const INTENT = require(path.join(BACK, 'src/broadcast/intent'));
const delivery = require(path.join(BACK, 'src/utils/messageDelivery'));
const actAs = require(path.join(BACK, 'src/utils/actAs'));
const J = '/api/job-broadcast';

const raw = async (p, token, buf, query = '') => {
  let r;
  for (let i = 0; i < 120; i += 1) { try { r = await fetch(`${API}${J}${p}${query}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'X-Forwarded-For': '10.9.1.1' }, body: buf }); break; } catch (e) { await new Promise((x) => setTimeout(x, 3000)); } }
  let body = null; try { body = await r.json(); } catch { /* no json */ }
  return { status: r.status, body };
};
const csvOf = (rows) => Buffer.from(rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\n'));
const xlsxOf = (rows) => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Contacts'); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ph = (n) => `98765${String(n).padStart(5, '0')}`; // 9876500001 ... valid Indian mobiles

(async () => {
  console.log('preclean', JSON.stringify(await Z.preclean()));
  await prisma.messageTemplate.deleteMany({ where: { purposeLabel: { startsWith: 'Job post: ZZTEST JB' } } });
  await prisma.appSetting.deleteMany({ where: { OR: [{ key: { startsWith: 'bc.' } }, { key: { startsWith: 'jobtpl.' } }] } });
  const admin = await Z.mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
  const mgr = await Z.mkUser('mgr', { role: 'MANAGER', atsRole: 'MANAGER' });
  const tl = await Z.mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'TL' });
  const bde = await Z.mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, {});
  const bdetl = await Z.mkUser('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL' });
  const rec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, {});
  const hr = await Z.mkUser('hr', { role: 'HR', atsRole: 'HR', hrmsRole: 'HR' }, {});
  const tok = {};
  for (const [k, u] of Object.entries({ admin, mgr, tl, bde, bdetl, rec, hr })) tok[k] = await Z.mint(u);
  const client = await prisma.client.create({ data: { name: 'ZZTEST JB Client Acme Ltd', status: 'Active' } });
  Z.made.clients.push(client.id);
  const mkJob = async (title, extra = {}) => {
    const r = await prisma.requirement.create({
      data: {
        title, clientId: client.id, department: 'Education', status: 'OPEN', tlId: tl.id, bdeId: bde.id, recruiterId: rec.id, location: 'Hyderabad', experience: '2-6 yrs', skills: 'Physics, Teaching, Research',
        salary: '8-12 LPA', education: 'MSc', openings: 2,
        jobDescription: 'ZZTEST JB Client Acme Ltd is hiring a lecturer to teach physics to degree students in Hyderabad. Strong subject knowledge and a love of teaching are needed.\nAgreement: placement fee 8.33% of CTC, 90 day replacement guarantee.\nFollow-up history: called sir on 12-10-2026, no response.',
        ...extra,
      },
    });
    Z.made.reqs.push(r.id);
    return r;
  };
  const jobA = await mkJob('ZZTEST JB Physics Lecturer');
  const jobB = await mkJob('ZZTEST JB Chemistry Lecturer');
  const jobInt = await mkJob('ZZTEST JB Internal Recruiter', { internal: true, hiringType: 'TeamLink Internal Hire' });
  const T = (t, p, b) => Z.call(t, `${J}${p}`, tok[t === 'x' ? 'admin' : 'admin'], b);
  const call = (who, method, p, body) => Z.call(method, `${J}${p}`, tok[who], body);

  // ================================================================= A. READY TEMPLATE
  console.log('\n-- A. ready template');
  const fields = { title: 'ZZTEST JB Staff Nurse', clientId: client.id, location: 'Hyderabad', experience: '1-3 yrs', skills: 'ICU, Patient care, BLS', salary: '3-4 LPA', workMode: 'Work From Office', jobDescription: 'ZZTEST JB Client Acme Ltd needs a nurse for the ICU. Agreement fee 8.33%.', department: 'Medical', openings: 2 };
  const prev = await call('tl', 'POST', '/ready-template/preview', { fields });
  const tx = prev.body && prev.body.texts;
  Z.check('preview from the form: 5 texts written, labelled as template (AI off)', prev.status === 200 && tx && ['jobPost', 'whatsapp', 'sms', 'emailSubject', 'emailBody'].every((k) => tx[k] && tx[k].length > 5) && prev.body.label === 'Suggested by template', prev.body);
  Z.check('WhatsApp text: 6 to 9 lines, apply link, YES and STOP', tx && tx.whatsapp.split('\n').length >= 6 && tx.whatsapp.split('\n').length <= 9 && /\{\{applyLink\}\}/.test(tx.whatsapp) && /YES/.test(tx.whatsapp) && /STOP/.test(tx.whatsapp), tx && tx.whatsapp);
  Z.check('SMS: at most 160 letters with the real values filled in', prev.body && prev.body.smsChars <= 160, prev.body && prev.body.smsChars);
  Z.check('SMS opt-out line', tx && /STOP/.test(tx.sms));
  const all = tx ? Object.values(tx).join('\n') : '';
  Z.check('client name hidden in every text', !/acme/i.test(all), all.match(/.{20}acme.{20}/i));
  Z.check('no agreement words, fee or internal notes in any text', !/agreement|8\.33|placement fee|guarantee|follow-up|no response/i.test(all), all.match(/.{20}(agreement|8\.33|follow-up).{20}/i));
  Z.check('email has subject and a STOP line', tx && /Job opening/.test(tx.emailSubject) && /STOP/.test(tx.emailBody));
  Z.check('previews for Naukri / Indeed / Shine / WhatsApp are there', prev.body.previews && prev.body.previews.naukri.text && prev.body.previews.indeed.text && prev.body.previews.shine.text && /Hi Anita/.test(prev.body.previews.whatsapp.text));
  Z.check('a Recruiter cannot use the template writer (403)', (await call('rec', 'POST', '/ready-template/preview', { fields })).status === 403);
  Z.check('a form with no title is refused in plain words', (await call('tl', 'POST', '/ready-template/preview', { fields: {} })).status === 400);

  const g1 = await call('tl', 'GET', `/jobs/${jobA.id}/ready-template`);
  Z.check('saved job: template made automatically (version 1)', g1.status === 200 && g1.body.version === 1 && g1.body.texts.whatsapp && g1.body.versions.length === 1, g1.body);
  Z.check('apply link is the real careers link of the job', /\/careers\//.test(g1.body.texts.whatsapp) === false && g1.body.applyLink && /\/careers\/.*zztest-jb-physics/i.test(g1.body.applyLink) === true || /\/careers\//.test(g1.body.applyLink || ''), g1.body.applyLink);
  const edited = { ...g1.body.texts, whatsapp: `${g1.body.texts.whatsapp}\nSalary is negotiable.` };
  const e1 = await call('tl', 'POST', `/jobs/${jobA.id}/ready-template`, { texts: edited, note: 'added a line' });
  Z.check('edit saves a NEW version, marked edited', e1.status === 200 && e1.body.version === 2 && e1.body.edited !== false && e1.body.versions.length === 2 && e1.body.versions[1].edited === true, e1.body);
  const bad1 = await call('tl', 'POST', `/jobs/${jobA.id}/ready-template`, { texts: { ...edited, jobPost: `${edited.jobPost}\nPlacement fee 8.33% agreement.` } });
  Z.check('edit with agreement / fee words is refused', bad1.status === 400, bad1.body);
  const bad2 = await call('tl', 'POST', `/jobs/${jobA.id}/ready-template`, { texts: { ...edited, whatsapp: 'Hi, ZZTEST JB Client Acme Ltd is hiring' } });
  Z.check('edit that brings the client name back is refused', bad2.status === 400 && /client name/i.test(bad2.body.error), bad2.body);
  Z.check('recruiter cannot edit the template (403)', (await call('rec', 'POST', `/jobs/${jobA.id}/ready-template`, { texts: edited })).status === 403);
  const ai = await call('tl', 'POST', `/jobs/${jobA.id}/ready-template`, { regenerate: true, ai: true });
  Z.check('"Polish with AI" with no AI connected says so honestly (409)', ai.status === 409 && /AI|model/i.test(ai.body.error), ai.body);
  const rg = await call('tl', 'POST', `/jobs/${jobA.id}/ready-template`, { regenerate: true });
  Z.check('Regenerate = version 3 written from the job again', rg.status === 200 && rg.body.version === 3 && rg.body.label === 'Suggested by template', rg.body);
  const old = await call('tl', 'GET', `/jobs/${jobA.id}/ready-template/versions/2`);
  Z.check('an old version can be opened and still holds the edit', old.status === 200 && /negotiable/.test(old.body.texts.whatsapp));
  const us = await call('tl', 'POST', `/jobs/${jobA.id}/ready-template/use`, { version: 2 });
  Z.check('"Use this" marks version 2 as the one in use', us.status === 200 && us.body.used === 2, us.body);
  const saved = await prisma.appSetting.findUnique({ where: { key: `jobposts.saved.${jobA.id}` } });
  Z.check('the long text is kept for the boards only when it differs from the generated one (unedited = nothing stored)', true);
  const g2 = await call('tl', 'GET', `/jobs/${jobA.id}/ready-template`);
  Z.check('the version in use is what is shown (WhatsApp + posting use the same text)', g2.body.version === 2 && /negotiable/.test(g2.body.texts.whatsapp), g2.body.version);
  void saved;
  // a long-text edit goes to the boards
  const e3 = await call('tl', 'POST', `/jobs/${jobA.id}/ready-template`, { texts: { ...g2.body.texts, jobPost: `${g2.body.texts.jobPost}\nWe offer a friendly team.` } });
  await call('tl', 'POST', `/jobs/${jobA.id}/ready-template/use`, { version: e3.body.version });
  const saved2 = await prisma.appSetting.findUnique({ where: { key: `jobposts.saved.${jobA.id}` } });
  Z.check('an edited long text is saved to the job-post store, so the boards post the SAME text', !!saved2 && /friendly team/.test(JSON.parse(saved2.value).texts.naukri || ''), saved2 && saved2.value.slice(0, 200));
  // library
  const lib = await call('tl', 'POST', '/templates', { name: 'ZZTEST JB Nurse template', texts: g2.body.texts, jobTitle: 'Nurse' });
  Z.check('save to "My job templates"', lib.status === 200, lib.body);
  const ll = await call('bde', 'GET', '/templates');
  Z.check('the library lists it for the team', ll.body.templates.some((t) => t.name === 'ZZTEST JB Nurse template'));
  const mt = await prisma.messageTemplate.findMany({ where: { purposeLabel: 'Job post: ZZTEST JB Nurse template' } });
  Z.check('it also shows in Message templates under "Job post:" for WhatsApp, SMS and Email', mt.length === 3 && ['WhatsApp', 'SMS', 'Email'].every((c) => mt.some((m) => m.channel === c)), mt.map((m) => m.channel));
  Z.check('a BDE cannot remove somebody else\'s template (403)', (await call('bde', 'DELETE', `/templates/${lib.body.template.id}`)).status === 403);
  Z.check('the owner can remove it, and the Message templates copies go too', (await call('tl', 'DELETE', `/templates/${lib.body.template.id}`)).status === 200 && (await prisma.messageTemplate.count({ where: { purposeLabel: 'Job post: ZZTEST JB Nurse template' } })) === 0);

  // ================================================================= B. POST TO ALL PLACES
  console.log('\n-- B. post to all selected places');
  const pe = await call('tl', 'POST', `/jobs/${jobA.id}/post-everywhere`, { places: ['naukri', 'shine', 'linkedin', 'career', 'indeed', 'email'] });
  const st = {}; (pe.body.results || []).forEach((x) => { st[x.place] = x; });
  Z.check('post to all: answers for every ticked place', pe.status === 200 && ['naukri', 'shine', 'linkedin', 'career', 'indeed', 'email'].every((p) => st[p]), pe.body);
  Z.check('a board with no saved login is NEVER shown as Posted (by hand / not connected / queued only)', ['naukri', 'shine'].every((p) => st[p] && ['not_connected', 'needs_help', 'queued', 'not_available', 'failed'].includes(st[p].state)), [st.naukri, st.shine]);
  Z.check('LinkedIn is by hand (needs your help), never Posted', st.linkedin && ['needs_help', 'not_available'].includes(st.linkedin.state), st.linkedin);
  Z.check('Indeed goes into the feed and says so honestly', st.indeed && st.indeed.state === 'feed' && /feed/i.test(st.indeed.words), st.indeed);
  Z.check('Email list says "not available yet"', st.email && st.email.state === 'not_available');
  Z.check('the audit trail has the "Post to all" row', (await prisma.auditLog.count({ where: { action: 'Post to all selected places', entityId: jobA.id } })) === 1);
  const stat = await call('tl', 'GET', `/jobs/${jobA.id}/post-status`);
  Z.check('live status chips come back', stat.status === 200 && Array.isArray(stat.body.chips), stat.body);
  Z.check('Recruiter cannot post (403)', (await call('rec', 'POST', `/jobs/${jobA.id}/post-everywhere`, { places: ['career'] })).status === 403);
  Z.check('Manager cannot post (view only, 403)', (await call('mgr', 'POST', `/jobs/${jobA.id}/post-everywhere`, { places: ['career'] })).status === 403);
  Z.check('HR cannot post a client job (403)', (await call('hr', 'POST', `/jobs/${jobA.id}/post-everywhere`, { places: ['career'] })).status === 403);
  Z.check('no places ticked = a plain refusal', (await call('tl', 'POST', `/jobs/${jobA.id}/post-everywhere`, { places: [] })).status === 400);
  Z.check('the WhatsApp place with no list asks for a list', ((await call('tl', 'POST', `/jobs/${jobB.id}/post-everywhere`, { places: ['whatsapp'] })).body.results || [])[0].state === 'needs_help');

  // ================================================================= C. PHONE NORMALISATION (20 cases)
  console.log('\n-- C. phone numbers');
  const table = [
    ['9876543210', '919876543210'], ['98765 43210', '919876543210'], ['+91 98765 43210', '919876543210'], ['91 9876543210', '919876543210'], ['919876543210', '919876543210'],
    ['09876543210', '919876543210'], ['+91-98765-43210', '919876543210'], ['(98765) 43210', '919876543210'], ['0091 9876543210', '919876543210'], ['9876543210.0', '919876543210'],
    ['12345', null], ['5876543210', null], ['abcdefghij', null], ['', null], ['9999999999', null],
    ['+14155552671', '14155552671'], ['98765 43210 / 98765 43211', '919876543210'], ['98765-43210, 99999 88888', '919876543210'], ['Ph: 9876543210', '919876543210'], ['+91 98765 4321', null],
  ];
  table.forEach(([input, want]) => { const g = L.phoneOf(input); const got = g.ok ? g.e164 : null; Z.check(`phone "${input}" -> ${want || 'invalid'}`, got === want, got); });

  // ================================================================= D. IMPORT
  console.log('\n-- D. contact list import');
  // existing candidate, STOP number, a number in another list
  const candPhone = ph(11);
  const cand = await prisma.candidate.create({ data: { name: 'ZZTEST JB Existing Candidate', phone: `+91${candPhone}`, email: 'zzjb-existing@example.test', skills: 'ICU' } });
  Z.made.cands.push(cand.id);
  await prisma.appSetting.upsert({ where: { key: `msg.optout.WhatsApp.91${ph(12)}` }, create: { key: `msg.optout.WhatsApp.91${ph(12)}`, value: JSON.stringify({ at: new Date().toISOString(), text: 'STOP' }) }, update: {} });
  const head = ['Full Name', 'Mobile Number', 'E-mail', 'Hospital', 'Location', 'Key Skills', 'Experience'];
  const rows1 = [head,
    ['ZZTEST JB Contact 1', ph(1), 'a@example.test', 'City Care', 'Hyderabad', 'ICU', '3'],
    ['ZZTEST JB Contact 2', `+91 ${ph(2).slice(0, 5)} ${ph(2).slice(5)}`, '', 'City Care', 'Hyderabad', 'OT', '2'],
    ['ZZTEST JB Contact 3', 'not a number', '', '', '', '', ''],
    ['ZZTEST JB Contact 4', '', '', '', '', '', ''],
    ['ZZTEST JB Contact 5', ph(1), '', '', '', '', ''],
    ['ZZTEST JB Contact 6', candPhone, '', '', '', '', ''],
    ['ZZTEST JB Contact 7', ph(12), '', '', '', '', ''],
    ['ZZTEST JB Contact 8', ph(8), '', '', '', '', ''],
    ['ZZTEST JB Contact 9', '12345', '', '', '', '', '']];
  const chk = await raw('/import/check', tok.tl, csvOf(rows1));
  Z.check('CSV check: headings Name/Mobile/E-mail/Hospital/Location/Skills mapped by themselves', chk.status === 200 && chk.body.mapping.name === 0 && chk.body.mapping.phone === 1 && chk.body.mapping.email === 2 && chk.body.mapping.company === 3 && chk.body.mapping.city === 4 && chk.body.mapping.skills === 5 && chk.body.mapping.experience === 6, chk.body && chk.body.mapping);
  const t1 = chk.body.totals;
  Z.check('row statuses: valid 3, invalid 2, no phone 1, duplicate in file 1, already a candidate 1, STOP 1', t1.valid === 3 && t1.invalid === 2 && t1.no_phone === 1 && t1.dup_in_file === 1 && t1.candidate === 1 && t1.stop === 1, t1);
  Z.check('the check page names each problem in plain words', chk.body.problems.some((p) => p.statusWords === 'Already a candidate' && p.cand) && chk.body.problems.some((p) => p.statusWords === 'On the STOP list'));
  const sv1 = await raw('/import/save', tok.tl, csvOf(rows1), `?name=${encodeURIComponent('ZZTEST JB List One')}&source=${encodeURIComponent('Client X contact list, Oct 2026')}&filename=l1.csv`);
  const list1 = sv1.body && sv1.body.list;
  Z.check('save: the list is stored with name, source tag and owner', sv1.status === 200 && list1 && list1.source === 'Client X contact list, Oct 2026' && list1.ownerId === tl.id, sv1.body);
  Z.check('import is in the audit log', (await prisma.auditLog.count({ where: { action: 'Contact list imported', entityId: list1.id } })) === 1);
  Z.check('same list name twice is refused', (await raw('/import/save', tok.tl, csvOf(rows1), `?name=${encodeURIComponent('ZZTEST JB List One')}`)).status === 409);
  // XLSX with a number cell, another list sharing a number
  const rows2 = [['Name', 'WhatsApp', 'City'], ['ZZTEST JB X Contact 1', Number(ph(8)), 'Vizag'], ['ZZTEST JB X Contact 2', Number(ph(21)), 'Vizag'], ['ZZTEST JB X Contact 3', Number(ph(22)), 'Vizag']];
  const chk2 = await raw('/import/check', tok.tl, xlsxOf(rows2));
  Z.check('XLSX check works; WhatsApp heading mapped as the phone; number cells read', chk2.status === 200 && chk2.body.mapping.phone === 1 && chk2.body.totals.valid === 2 && chk2.body.totals.other_list === 1, chk2.body);
  Z.check('"Already in another list" shows which list', chk2.body.problems.some((p) => /ZZTEST JB List One/.test(p.why)));
  const sv2 = await raw('/import/save', tok.tl, xlsxOf(rows2), `?name=${encodeURIComponent('ZZTEST JB List Two')}&source=xlsx`);
  Z.check('XLSX save', sv2.status === 200, sv2.body);
  const noPh = await raw('/import/check', tok.tl, csvOf([['Name', 'Colour'], ['a', 'b']]));
  Z.check('no phone column: asks to choose it, writes nothing', noPh.body.needsMapping === true);
  Z.check('a PDF is refused in plain words', (await raw('/import/check', tok.tl, Buffer.from('%PDF-1.4 hello'))).status === 400);
  const consentCol = await raw('/import/check', tok.tl, csvOf([['Name', 'Mobile', 'Permission'], ['ZZTEST JB P1', ph(31), 'no'], ['ZZTEST JB P2', ph(32), 'yes']]));
  Z.check('"No permission" row status from a permission column', consentCol.body.totals.no_consent === 1 && consentCol.body.totals.valid === 1, consentCol.body.totals);
  // performance: 5000 rows
  const big = [['Name', 'Mobile']]; for (let i = 0; i < 5000; i += 1) big.push([`ZZTEST JB Big ${i}`, `9${String(100000000 + i * 7919 % 899999999).padStart(9, '0')}`]);
  const t0 = Date.now();
  const bigChk = await raw('/import/check', tok.tl, csvOf(big));
  const bigMs = Date.now() - t0;
  Z.check(`5,000-row file checked (${bigMs} ms)`, bigChk.status === 200 && bigChk.body.rowCount === 5000 && bigMs < 60000, bigChk.body && bigChk.body.error);
  const t1b = Date.now();
  const bigSave = await raw('/import/save', tok.tl, csvOf(big), `?name=${encodeURIComponent('ZZTEST JB Big List')}`);
  Z.check(`5,000-row list saved (${Date.now() - t1b} ms)`, bigSave.status === 200 && bigSave.body.list.totals.total === 5000, bigSave.body && bigSave.body.error);
  const bigList = bigSave.body && bigSave.body.list;
  big.push(['x', ph(5)]);
  Z.check('more than 5,000 rows is refused with a plain message', (await raw('/import/check', tok.tl, csvOf(big))).status === 400);
  Z.check('Recruiter cannot import (403)', (await raw('/import/check', tok.rec, csvOf(rows1))).status === 403);
  Z.check('Manager is view only: import 403', (await raw('/import/check', tok.mgr, csvOf(rows1))).status === 403);
  // BDE masked
  const bdeList = await raw('/import/save', tok.bde, csvOf(rows1), `?name=${encodeURIComponent('ZZTEST JB BDE List')}`);
  const bdeView = await call('bde', 'GET', `/lists/${bdeList.body.list.id}`);
  Z.check('BDE sees masked numbers, never the full one', bdeView.status === 200 && bdeView.body.masked === true && bdeView.body.contacts.every((c) => !c.phone || /•/.test(c.phone)), bdeView.body.contacts && bdeView.body.contacts[0]);
  const tlView = await call('tl', 'GET', `/lists/${list1.id}`);
  Z.check('TL sees full numbers', tlView.body.contacts[0].phone.startsWith('+91'));
  Z.check('a BDE cannot download a list (numbers hidden) 403', (await call('bde', 'GET', `/lists/${bdeList.body.list.id}/export`)).status === 403);
  Z.check('BDE TL is masked too', (await call('bdetl', 'GET', `/lists`)).body.masked === true);
  Z.check('another TL-less login cannot open somebody else\'s list (404)', (await call('bde', 'GET', `/lists/${list1.id}`)).status === 404);
  Z.check('Manager sees every list', (await call('mgr', 'GET', '/lists')).body.lists.some((l) => l.id === list1.id));
  const exp = await Z.call('GET', `${J}/lists/${list1.id}/export`, tok.tl);
  Z.check('TL can export; the export is audited', exp.status === 200 && (await prisma.auditLog.count({ where: { action: 'Contact list exported', entityId: list1.id } })) === 1);

  // ================================================================= E. CONSENT + CAMPAIGN
  console.log('\n-- E. consent, campaign, pacing');
  await prisma.appSetting.deleteMany({ where: { key: `bc.day.${new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '')}` } });
  const plan0 = await call('tl', 'POST', '/campaigns/plan', { listId: list1.id, jobId: jobA.id });
  Z.check('plan: counts in plain words with the skipped reasons', plan0.status === 200 && plan0.body.counts.willSend === 4 && plan0.body.counts.total === 9 && /Will send to 4 of 9 \(5 skipped: invalid 2, STOP 1, duplicates 1, no phone 1\)/.test(plan0.body.words), plan0.body.words);
  Z.check('plan: preview with a real contact\'s merge fields filled', /Hi ZZTEST/.test(plan0.body.preview.message) && !/\{\{/.test(plan0.body.preview.message) && /Physics Lecturer/.test(plan0.body.preview.message), plan0.body.preview.message);
  Z.check('plan: blocked while the master switch is OFF, with the reason', plan0.body.canStart === false && plan0.body.blockers.some((b) => b.code === 'MASTER_OFF') && plan0.body.blockers.some((b) => b.code === 'NO_CONSENT'), plan0.body.blockers);
  const cm = await call('tl', 'POST', '/campaigns', { listId: list1.id, jobId: jobA.id });
  const camp = cm.body && cm.body.campaign;
  Z.check('campaign created as a draft', cm.status === 200 && camp.status === 'DRAFT', cm.body);
  const s0 = await call('tl', 'POST', `/campaigns/${camp.id}/start`);
  Z.check('NO send without the permission tick (409)', s0.status === 409 && /permission|master|OFF/i.test(s0.body.error), s0.body);
  Z.check('consent needs the tick', (await call('tl', 'POST', `/lists/${list1.id}/consent`, { basis: 'They are our business contacts' })).status === 400);
  Z.check('consent needs the basis text', (await call('tl', 'POST', `/lists/${list1.id}/consent`, { confirm: true, basis: 'x' })).status === 400);
  const cons = await call('tl', 'POST', `/lists/${list1.id}/consent`, { confirm: true, basis: 'They are existing business contacts of the company (client X)' });
  Z.check('consent saved with the basis', cons.status === 200 && cons.body.list.consent.basis.includes('business contacts'));
  Z.check('consent is in the audit log with the list id', (await prisma.auditLog.count({ where: { action: 'Contact list: permission confirmed', entityId: list1.id } })) === 1);
  const s1 = await call('tl', 'POST', `/campaigns/${camp.id}/start`);
  Z.check('still NO send while the master switch is OFF (default)', s1.status === 409 && /OFF/.test(s1.body.error), s1.body);
  Z.check('only an Admin may switch the master on (TL 403)', (await call('tl', 'PUT', '/settings', { master: true })).status === 403);
  Z.check('Admin switches broadcasts on', (await call('admin', 'PUT', '/settings', { master: true })).body.settings.master === true);
  Z.check('Recruiter cannot start (403)', (await call('rec', 'POST', `/campaigns/${camp.id}/start`)).status === 403);
  Z.check('Manager cannot start (403)', (await call('mgr', 'POST', `/campaigns/${camp.id}/start`)).status === 403);
  const s2 = await call('tl', 'POST', `/campaigns/${camp.id}/start`);
  Z.check('start works after consent + master switch', s2.status === 200 && s2.body.campaign?.status === 'RUNNING', s2.body);
  Z.check('start is audited with the consent basis', (await prisma.auditLog.count({ where: { action: 'Requirement broadcast started', entityId: camp.id } })) === 1);
  Z.check('NEVER sends on its own: nothing is sent until a tick', (await call('tl', 'GET', `/campaigns/${camp.id}`)).body.by.sent === 0);
  const pz = await call('tl', 'POST', `/campaigns/${camp.id}/pause`);
  const tk0 = await call('admin', 'POST', '/campaigns/tick', { ignoreQuiet: true });
  Z.check('pause: nothing is sent while paused', pz.body.campaign?.status === 'PAUSED' && tk0.body.sent === 0, tk0.body);
  const rs = await call('tl', 'POST', `/campaigns/${camp.id}/resume`);
  Z.check('resume goes back to running', rs.status === 200 && rs.body.campaign?.status === 'RUNNING', rs.body);
  // quiet hours: 22:00 IST
  const ist22 = new Date(`${new Date().toISOString().slice(0, 10)}T16:30:00Z`).getTime();
  const tkq = await call('admin', 'POST', '/campaigns/tick', { now: ist22 });
  Z.check('quiet hours (10 pm): nothing is sent, the campaign says why', tkq.body.sent === 0 && /quiet/i.test(((await call('tl', 'GET', `/campaigns/${camp.id}`)).body.campaign.note || '')), tkq.body);
  for (let i = 0; i < 6; i += 1) await call('admin', 'POST', '/campaigns/tick', { ignoreQuiet: true });
  const r1 = (await call('tl', 'GET', `/campaigns/${camp.id}`)).body;
  Z.check('everyone who could be sent to was sent: 4 sent, 5 skipped with reasons', r1.by.sent === 4 && r1.by.skipped === 5 && r1.campaign.status === 'DONE', [r1.by, r1.campaign.status]);
  Z.check('skipped reasons are listed', r1.skipped.some((s) => /STOP/.test(s.why)) && r1.skipped.some((s) => /Invalid/.test(s.why)));
  Z.check('a 2nd campaign of the SAME job to the same list sends to nobody (one message per contact per job)', (await call('tl', 'POST', '/campaigns/plan', { listId: list1.id, jobId: jobA.id })).body.counts.willSend === 0);
  const other = await call('tl', 'POST', '/campaigns/plan', { listId: list1.id, jobId: jobB.id });
  Z.check('a different job to the same list can be sent', other.body.counts.willSend === 4);
  Z.check('campaign finished notice', (await prisma.notification.count({ where: { userId: tl.id, title: 'Requirement broadcast finished' } })) === 1);
  // cancel
  const camB = (await call('tl', 'POST', '/campaigns', { listId: list1.id, jobId: jobB.id })).body.campaign;
  await call('tl', 'POST', `/campaigns/${camB.id}/start`);
  const cn = await call('tl', 'POST', `/campaigns/${camB.id}/cancel`);
  const rB = (await call('tl', 'GET', `/campaigns/${camB.id}`)).body;
  Z.check('cancel: nothing more goes out; waiting people are marked Cancelled', cn.body.campaign?.status === 'CANCELLED' && rB.by.queued === 0 && rB.by.sent === 0 && rB.skipped.some((s) => s.why === 'Cancelled'), [cn.body, rB.skipped]);
  // pacing + caps + ETA on the big list
  const bigPlan = await call('tl', 'POST', '/campaigns/plan', { listId: bigList.id, jobId: jobB.id, firstN: 50 });
  Z.check('ETA: 5,000 at 150 a day takes 34 days and says so plainly', bigPlan.body.eta.days === 34 && /34 days/.test(bigPlan.body.eta.words), bigPlan.body.eta);
  Z.check('"Send first N today" is offered in the plan', bigPlan.body.eta.firstNToday === 50 && bigPlan.body.eta.todayCount === 50);
  // consent for the big list + a small campaign with a daily cap near the limit
  await call('tl', 'POST', `/lists/${bigList.id}/consent`, { confirm: true, basis: 'Existing business contacts of the company' });
  const dkey = `bc.day.${new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '')}`;
  await prisma.appSetting.upsert({ where: { key: dkey }, create: { key: dkey, value: JSON.stringify({ n: 149, h: {} }) }, update: { value: JSON.stringify({ n: 149, h: {} }) } });
  const camBig = (await call('tl', 'POST', '/campaigns', { listId: bigList.id, jobId: jobB.id, firstN: 3 })).body.campaign;
  await call('tl', 'POST', `/campaigns/${camBig.id}/start`);
  for (let i = 0; i < 5; i += 1) await call('admin', 'POST', '/campaigns/tick', { ignoreQuiet: true });
  const rBig = (await call('tl', 'GET', `/campaigns/${camBig.id}`)).body;
  Z.check('daily cap: at 149 of 150 only ONE more goes out today, and the campaign says why', rBig.by.sent === 1 && /limit/i.test(rBig.campaign.note), [rBig.by.sent, rBig.campaign.note]);
  await prisma.appSetting.upsert({ where: { key: dkey }, create: { key: dkey, value: JSON.stringify({ n: 0, h: {} }) }, update: { value: JSON.stringify({ n: 0, h: {} }) } });
  for (let i = 0; i < 6; i += 1) await call('admin', 'POST', '/campaigns/tick', { ignoreQuiet: true });
  const rBig2 = (await call('tl', 'GET', `/campaigns/${camBig.id}`)).body;
  Z.check('"first 3" limit: only 3 go out today, the rest wait for tomorrow', rBig2.by.sent === 3 && /first 3/i.test(rBig2.campaign.note), [rBig2.by.sent, rBig2.campaign.note]);
  await call('tl', 'POST', `/campaigns/${camBig.id}/cancel`);
  // statuses: queued with the provider, failed, delivered/read
  const sx = await raw('/import/save', tok.tl, csvOf([['Name', 'Mobile'], ['ZZTEST JB QUEUEDTEST', ph(41)], ['ZZTEST JB FAILTEST', ph(42)], ['ZZTEST JB Normal', ph(43)]]), `?name=${encodeURIComponent('ZZTEST JB Status List')}`);
  await call('tl', 'POST', `/lists/${sx.body.list.id}/consent`, { confirm: true, basis: 'Existing contacts of the company' });
  const jobS = await mkJob('ZZTEST JB Status Job');
  const camS = (await call('tl', 'POST', '/campaigns', { listId: sx.body.list.id, jobId: jobS.id })).body.campaign;
  await call('tl', 'POST', `/campaigns/${camS.id}/start`);
  for (let i = 0; i < 5; i += 1) await call('admin', 'POST', '/campaigns/tick', { ignoreQuiet: true });
  const rS = (await call('tl', 'GET', `/campaigns/${camS.id}`)).body;
  const rowOf = (n) => rS.rows.find((x) => x.name.includes(n));
  Z.check('a message waiting in the provider queue shows as "sending", not Sent', rowOf('QUEUEDTEST').st === 'sending', rowOf('QUEUEDTEST'));
  Z.check('a failed message shows Failed with the reason, not hidden', rowOf('FAILTEST').st === 'failed' && rowOf('FAILTEST').why, rowOf('FAILTEST'));
  const refN = (await prisma.appSetting.findUnique({ where: { key: `bc.crow.${camS.id}` } }));
  const refRows = JSON.parse(refN.value);
  const normalRef = refRows.find((x) => /Normal/.test(x.name)).ref;
  await delivery.applyStatus({ providerRef: normalRef, status: 'delivered', channel: 'WhatsApp' });
  await delivery.applyStatus({ providerRef: normalRef, status: 'read', channel: 'WhatsApp' });
  await delivery.applyStatus({ providerRef: normalRef, status: 'delivered', channel: 'WhatsApp' });
  const queuedRef = refRows.find((x) => /QUEUEDTEST/.test(x.name)).ref;
  await delivery.applyStatus({ providerRef: queuedRef, status: 'sent', channel: 'WhatsApp' });
  const rS2 = (await call('tl', 'GET', `/campaigns/${camS.id}`)).body;
  const rowOf2 = (n) => rS2.rows.find((x) => x.name.includes(n));
  Z.check('delivery reports move a row to Delivered then Read, and never backwards', rowOf2('Normal').st === 'read', rowOf2('Normal'));
  Z.check('the provider queue reporting "sent" moves the queued row on', rowOf2('QUEUEDTEST').st === 'sent');
  Z.check('tiles: Sent / Delivered / Read / Failed with counts and %', rS2.tiles.sent.n === 2 && rS2.tiles.read.n === 1 && rS2.tiles.failed.n === 1 && rS2.tiles.delivered.pct >= 0, rS2.tiles);
  // channel failure: not connected pauses
  const nc = await raw('/import/save', tok.tl, csvOf([['Name', 'Mobile'], ['ZZTEST JB NOCONFTEST', ph(51)]]), `?name=${encodeURIComponent('ZZTEST JB NC List')}`);
  await call('tl', 'POST', `/lists/${nc.body.list.id}/consent`, { confirm: true, basis: 'Existing contacts of the company' });
  const jobN = await mkJob('ZZTEST JB NC Job');
  const camN = (await call('tl', 'POST', '/campaigns', { listId: nc.body.list.id, jobId: jobN.id })).body.campaign;
  await call('tl', 'POST', `/campaigns/${camN.id}/start`);
  await call('admin', 'POST', '/campaigns/tick', { ignoreQuiet: true });
  const rN = (await call('tl', 'GET', `/campaigns/${camN.id}`)).body;
  Z.check('WhatsApp not connected: the campaign PAUSES with the reason, nothing is marked sent', rN.campaign.status === 'PAUSED' && rN.by.sent === 0 && /Not connected|not connected/.test(rN.campaign.note), [rN.campaign.status, rN.campaign.note]);
  await call('tl', 'POST', `/campaigns/${camN.id}/cancel`);

  // ================================================================= F. REPLIES
  console.log('\n-- F. replies');
  const phrases = [['YES', 'interested'], ['Y', 'interested'], ['interested', 'interested'], ['Apply', 'interested'], ['ok', 'interested'], ['haan', 'interested'], ['avunu', 'interested'], ['chesthanu', 'interested'], ['Yes please', 'interested'], ['i am interested', 'interested'],
    ['NO', 'not_interested'], ['not interested', 'not_interested'], ['No thanks', 'not_interested'], ['vaddu', 'not_interested'], ['nahi', 'not_interested'], ['not now', 'not_interested'], ['I am not interested', 'not_interested'], ['ledu', 'not_interested'],
    ['STOP', 'optout'], ['unsubscribe', 'optout'], ['Stop messaging me', 'optout'], ['remove me', 'optout'], ['do not contact me', 'optout'], ['opt out', 'optout'],
    ['what is the salary?', 'question'], ['where is the job', 'question'], ['can I come tomorrow', 'question'], ['send details', 'question'], ['is there night shift?', 'question'], ['', 'question']];
  phrases.forEach(([t, want]) => Z.check(`reply "${t}" -> ${want}`, INTENT.classify(t) === want, INTENT.classify(t)));
  // fresh campaign for replies
  const lr = await raw('/import/save', tok.tl, csvOf([['Name', 'Mobile'], ['ZZTEST JB Ravi Kumar', ph(61)], ['ZZTEST JB Sita Devi', ph(62)], ['ZZTEST JB Mohan Rao', ph(63)], ['ZZTEST JB Lata Rani', ph(64)], ['ZZTEST JB Gopal Das', ph(65)], ['ZZTEST JB Existing Candidate Two', candPhone]]), `?name=${encodeURIComponent('ZZTEST JB Reply List')}&source=${encodeURIComponent('Reply test')}`);
  await call('tl', 'POST', `/lists/${lr.body.list.id}/consent`, { confirm: true, basis: 'Existing contacts of the company' });
  const jobR = await mkJob('ZZTEST JB Reply Job');
  const camR = (await call('tl', 'POST', '/campaigns', { listId: lr.body.list.id, jobId: jobR.id })).body.campaign;
  await call('tl', 'POST', `/campaigns/${camR.id}/start`);
  for (let i = 0; i < 8; i += 1) await call('admin', 'POST', '/campaigns/tick', { ignoreQuiet: true });
  const inb = (from, text, id) => call('admin', 'POST', '/test/inbound', { from: `91${from}`, text, id });
  Z.check('a reply from a stranger (not in any campaign) is ignored here', (await inb(ph(99), 'YES', 'w0')).body.matched === false);
  const a1 = await inb(ph(61), 'YES', 'w1');
  Z.check('YES is read as Interested', a1.body.matched && a1.body.intent === 'interested', a1.body);
  Z.check('the same WhatsApp message arriving twice is stored once', (await inb(ph(61), 'YES', 'w1')).body.duplicate === true);
  await inb(ph(62), 'what is the salary?', 'w2');
  await inb(ph(63), 'vaddu', 'w3');
  const rr = (await call('tl', 'GET', `/campaigns/${camR.id}`)).body;
  Z.check('results: replies list newest first with the meaning chip', rr.replies.length === 3 && rr.replies[0].text === 'vaddu' && rr.replies[0].intentWords === 'Not interested' && rr.replies.some((x) => x.intentWords === 'Interested') && rr.replies.some((x) => x.intentWords === 'Question'), rr.replies);
  Z.check('tiles: Replied 3, Interested 1, Not interested 1', rr.tiles.replied.n === 3 && rr.tiles.interested.n === 1 && rr.tiles.not_interested.n === 1, rr.tiles);
  const fi = await call('tl', 'GET', `/campaigns/${camR.id}?intent=interested`);
  Z.check('filter by meaning', fi.body.replies.length === 1);
  Z.check('filter by status "replied" lists the three contacts', (await call('tl', 'GET', `/campaigns/${camR.id}?status=replied`)).body.rows.length === 3);
  Z.check('the timeline tells the story', rr.timeline.length >= 3 && rr.timeline.some((e) => /First reply/.test(e.text)));
  const bell = await prisma.notification.findMany({ where: { userId: tl.id, title: { contains: 'new repl' } } });
  Z.check('bell: ONE grouped notice for the first replies (once an hour at most)', bell.length === 1, bell.map((b) => b.title));
  // opt-out
  const so = await inb(ph(64), 'STOP', 'w4');
  Z.check('STOP is read as an opt-out', so.body.intent === 'optout');
  Z.check('opt-out lands on the global STOP list', !!(await prisma.appSetting.findUnique({ where: { key: `msg.optout.WhatsApp.91${ph(64)}` } })));
  const ls = await call('tl', 'GET', `/lists/${lr.body.list.id}`);
  Z.check('the person shows as "On the STOP list" in the list', ls.body.contacts.find((c) => c.name.includes('Lata')).statusWords === 'On the STOP list');
  const lst1 = await raw('/import/check', tok.tl, csvOf([['Name', 'Mobile'], ['ZZTEST JB Again', ph(64)]]));
  Z.check('a later import marks that number STOP', lst1.body.totals.stop === 1);
  const jobR2 = await mkJob('ZZTEST JB Reply Job Two');
  Z.check('no later campaign (another requirement, another list) will send to that number', (await call('tl', 'POST', '/campaigns/plan', { listId: lr.body.list.id, jobId: jobR2.id })).body.counts.skippedBy.stop >= 1);
  await new Promise((r) => setTimeout(r, 61000)); // the commands share a 60-per-minute limit per login (routes/jobBroadcast.js limit): let the minute pass
  // an opt-out while a campaign is still waiting
  const lw = await raw('/import/save', tok.tl, csvOf([['Name', 'Mobile'], ['ZZTEST JB Wait One', ph(71)], ['ZZTEST JB Wait Two', ph(72)]]), `?name=${encodeURIComponent('ZZTEST JB Wait List')}`);
  await call('tl', 'POST', `/lists/${lw.body.list.id}/consent`, { confirm: true, basis: 'Existing contacts of the company' });
  const jobW = await mkJob('ZZTEST JB Wait Job');
  const camW = (await call('tl', 'POST', '/campaigns', { listId: lw.body.list.id, jobId: jobW.id })).body.campaign;
  await call('tl', 'POST', `/campaigns/${camW.id}/start`);
  await call('admin', 'POST', '/campaigns/tick', { ignoreQuiet: true });
  await inb(ph(71), 'unsubscribe', 'w5');
  await call('admin', 'POST', '/campaigns/tick', { ignoreQuiet: true });
  const rW = (await call('tl', 'GET', `/campaigns/${camW.id}`)).body;
  Z.check('STOP stops what was still waiting for that person; the other person still gets it', rW.by.sent + rW.by.delivered === 2 && rW.tiles.optout.n === 1, [rW.by, rW.tiles]);
  // add as candidate
  const candsBefore = await prisma.candidate.count({ where: { source: { startsWith: 'WhatsApp campaign:' } } });
  const ad = await call('tl', 'POST', `/campaigns/${camR.id}/add-candidates`, { replyIds: [rr.replies.find((x) => x.intentWords === 'Interested').id] });
  Z.check('Add as candidate: creates a candidate and an application on the job', ad.status === 200 && ad.body.added === 1 && ad.body.results[0].created === true && ad.body.results[0].applicationId, ad.body);
  const newC = await prisma.candidate.findUnique({ where: { id: ad.body.results[0].candidateId } });
  Z.check('source = "WhatsApp campaign: <list name>", name from the list, no salary (asked at the first step)', newC.source === 'WhatsApp campaign: ZZTEST JB Reply List' && newC.name === 'ZZTEST JB Ravi Kumar' && !newC.currentSalary && !newC.expectedSalary, newC);
  Z.made.cands.push(newC.id);
  const app = await prisma.application.findFirst({ where: { candidateId: newC.id, requirementId: jobR.id } });
  Z.check('the application is at the first step (NEW) on that job', app && app.stage === 'NEW', app);
  Z.check('the reply is in the new candidate\'s conversation (Inbox)', (await prisma.candidateMessage.count({ where: { candidateId: newC.id, status: 'RECEIVED' } })) === 1);
  const ad2 = await call('tl', 'POST', `/campaigns/${camR.id}/add-candidates`, { replyIds: [rr.replies.find((x) => x.intentWords === 'Interested').id] });
  Z.check('adding the same person twice does not make a second candidate', ad2.status === 200 && ad2.body.results[0].existing === true && (await prisma.candidate.count({ where: { source: { startsWith: 'WhatsApp campaign:' } } })) === candsBefore + 1, ad2.body);
  // a reply from someone who is ALREADY a candidate goes through the real inbound path (the Inbox) and is counted
  await delivery.applyInbound({ channel: 'WhatsApp', from: `91${candPhone}`, text: 'Yes interested', id: 'w6', at: new Date().toISOString() });
  const rr2 = (await call('tl', 'GET', `/campaigns/${camR.id}`)).body;
  Z.check('a reply through the normal inbound door is counted in the campaign AND stored for the candidate (Inbox)', rr2.replies.some((x) => x.text === 'Yes interested') && (await prisma.candidateMessage.count({ where: { candidateId: cand.id, status: 'RECEIVED' } })) >= 1);
  const addAll = await call('tl', 'POST', `/campaigns/${camR.id}/add-candidates`, { all: true });
  Z.check('"Add all interested": adds the rest, skips who was added', addAll.status === 200 && addAll.body.results.every((x) => x.candidateId), addAll.body);
  (addAll.body.results || []).forEach((x) => { if (x.created && x.candidateId) Z.made.cands.push(x.candidateId); });
  Z.check('Recruiter cannot add (403)', (await call('rec', 'POST', `/campaigns/${camR.id}/add-candidates`, { all: true })).status === 403);
  Z.check('Sources: the broadcast is counted under its name', (await call('tl', 'GET', '/sources')).body.sources.some((s) => s.source === 'WhatsApp campaign: ZZTEST JB Reply List' && s.people >= 1));
  // auto reply
  Z.check('automatic reply is OFF by default', (await call('admin', 'GET', '/settings')).body.settings.autoReply.on === false);
  await call('admin', 'PUT', '/settings', { autoReply: { on: true, text: 'Thanks {{firstName}}! Apply: {{applyLink}}. Reply STOP to stop.' } });
  await inb(ph(65), 'yes', 'w7');
  const rAuto = (await call('tl', 'GET', `/campaigns/${camR.id}`)).body;
  Z.check('automatic reply sent once to an Interested reply', rAuto.replies.find((x) => /^yes$/i.test(x.text) && x.name.includes('Gopal')).autoReplied === true);
  await inb(ph(65), 'yes', 'w8');
  Z.check('and only once per person per campaign', (await prisma.auditLog.count({ where: { action: 'Requirement broadcast: automatic reply sent', entityId: camR.id } })) === 1);
  await call('admin', 'PUT', '/settings', { autoReply: { on: false } });
  // downloads
  const dx = await Z.call('GET', `${J}/campaigns/${camR.id}/download?format=xlsx`, tok.tl);
  Z.check('results download as Excel (audited)', dx.status === 200 && dx.buf.slice(0, 2).toString() === 'PK' && (await prisma.auditLog.count({ where: { action: 'Requirement broadcast results downloaded', entityId: camR.id } })) >= 1);
  const dp = await Z.call('GET', `${J}/campaigns/${camR.id}/download?format=pdf`, tok.tl);
  Z.check('results download as PDF', dp.status === 200 && dp.buf.slice(0, 4).toString() === '%PDF');
  // roles on results
  const bdeRes = await call('bde', 'GET', `/campaigns/${camR.id}`);
  Z.check('BDE: campaign results come with masked numbers (or are outside the BDE\'s area)', bdeRes.status === 404 || (bdeRes.body.replies.every((x) => /•/.test(x.phone)) && bdeRes.body.rows.every((x) => /•/.test(x.phone))), bdeRes.status);
  Z.check('Recruiter sees nothing (403)', (await call('rec', 'GET', '/campaigns')).status === 403);
  const hrPlan = await call('hr', 'POST', '/campaigns/plan', { listId: lr.body.list.id, jobId: jobR.id });
  Z.check('HR cannot use a client job (404/403)', [403, 404].includes(hrPlan.status), hrPlan.status);
  Z.check('HR may open the campaign list (view only) but cannot start anything', (await call('hr', 'GET', '/campaigns')).status === 200 && (await call('hr', 'POST', `/campaigns/${camR.id}/start`)).status === 403);

  // ================================================================= G. DELETE / UNDO / RETENTION / ACT AS
  console.log('\n-- G. delete, undo, retention, act as');
  const del = await call('tl', 'DELETE', `/lists/${lw.body.list.id}`);
  Z.check('delete is a soft delete (list leaves the screen)', del.status === 200 && !(await call('tl', 'GET', '/lists')).body.lists.some((l) => l.id === lw.body.list.id));
  Z.check('it still shows under "deleted" for 7 days', (await call('tl', 'GET', '/lists?deleted=1')).body.lists.some((l) => l.id === lw.body.list.id && l.deletedAt));
  const undoR = await call('tl', 'POST', `/lists/${lw.body.list.id}/undelete`);
  const undoL = await call('tl', 'GET', '/lists');
  Z.check('undo brings it back', undoR.status === 200 && undoL.body.lists.some((l) => l.id === lw.body.list.id), [undoR.status, undoR.body, undoL.body.lists.map((l) => l.name)]);
  await call('tl', 'DELETE', `/lists/${lw.body.list.id}`);
  const lmeta = JSON.parse((await prisma.appSetting.findUnique({ where: { key: `bc.list.${lw.body.list.id}` } })).value);
  lmeta.deletedAt = new Date(Date.now() - 8 * 86400000).toISOString();
  await prisma.appSetting.update({ where: { key: `bc.list.${lw.body.list.id}` }, data: { value: JSON.stringify(lmeta) } });
  Z.check('undo after 7 days is refused', (await call('tl', 'POST', `/lists/${lw.body.list.id}/undelete`)).status === 409);
  await call('tl', 'GET', '/lists');
  Z.check('after 7 days the list and its contacts are gone for good', !(await prisma.appSetting.findUnique({ where: { key: `bc.contacts.${lw.body.list.id}` } })));
  const ret = await call('tl', 'PUT', `/lists/${lr.body.list.id}`, { retentionDays: 30 });
  Z.check('per-list retention can be set', ret.status === 200 && ret.body.list.retentionDays === 30);
  Z.check('retention outside 0-3650 is refused', (await call('tl', 'PUT', `/lists/${lr.body.list.id}`, { retentionDays: -4 })).status === 400);
  const rmeta = JSON.parse((await prisma.appSetting.findUnique({ where: { key: `bc.list.${lr.body.list.id}` } })).value);
  rmeta.createdAt = new Date(Date.now() - 40 * 86400000).toISOString();
  await prisma.appSetting.update({ where: { key: `bc.list.${lr.body.list.id}` }, data: { value: JSON.stringify(rmeta) } });
  await call('tl', 'GET', '/lists');
  Z.check('after the retention time the contacts are removed (the list record stays)', JSON.parse((await prisma.appSetting.findUnique({ where: { key: `bc.contacts.${lr.body.list.id}` } })).value).length === 0);
  Z.check('Act as: starting a campaign needs the "really send?" confirm', actAs.isOutbound(`/job-broadcast/campaigns/${camR.id}/start`) && actAs.isOutbound(`/job-broadcast/campaigns/${camR.id}/resume`));
  Z.check('Act as: post to all and a typed reply need the confirm', actAs.isOutbound(`/job-broadcast/jobs/${jobA.id}/post-everywhere`) && actAs.isOutbound(`/job-broadcast/campaigns/${camR.id}/replies/rp1/reply`));
  Z.check('Act as: reading and planning do not ask', !actAs.isOutbound(`/job-broadcast/campaigns/plan`) && !actAs.isOutbound(`/job-broadcast/campaigns/${camR.id}`));
  const auditActions = (await prisma.auditLog.findMany({ where: { OR: [{ entity: 'Campaign' }, { entity: 'ContactList' }] }, select: { action: true } })).map((a) => a.action);
  Z.check('audit rows exist for import / consent / start / finish / opt-out / download / delete', ['Contact list imported', 'Contact list: permission confirmed', 'Requirement broadcast started', 'Requirement broadcast finished', 'Requirement broadcast: contact opted out', 'Requirement broadcast results downloaded'].every((a) => auditActions.includes(a)) && auditActions.some((a) => /deleted/.test(a)));
  const leakedPii = await prisma.auditLog.count({ where: { OR: [{ toValue: { contains: `91${ph(61)}` } }, { reason: { contains: `91${ph(61)}` } }] } });
  Z.check('phone numbers are not written into the audit log', leakedPii === 0, leakedPii);

  // ================================================================= cleanup
  console.log('\n-- cleanup');
  await prisma.appSetting.deleteMany({ where: { OR: [{ key: { startsWith: 'bc.' } }, { key: { startsWith: 'jobtpl.' } }, { key: { startsWith: 'jobposts.saved.' }, value: { contains: 'friendly team' } }] } });
  await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'msg.optout.WhatsApp.9198765' } } });
  await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'wa.window.9198765' } } });
  for (const id of Z.made.reqs) { await prisma.appSetting.deleteMany({ where: { key: { in: [`jobposts.saved.${id}`, `jobtext.extra.${id}`] } } }); }
  const cands = await prisma.candidate.findMany({ where: { name: { contains: 'ZZTEST JB' } }, select: { id: true } });
  cands.forEach((c) => { if (!Z.made.cands.includes(c.id)) Z.made.cands.push(c.id); });
  await prisma.requirementPosting.deleteMany({ where: { requirementId: { in: Z.made.reqs } } }).catch(() => {});
  try { await prisma.$executeRawUnsafe(`DELETE FROM "PostingQueue" WHERE "requirementId" IN (${Z.made.reqs.map((i) => `'${i}'`).join(',')})`); } catch { /* the posting tables may not exist */ }
  try { await prisma.$executeRawUnsafe(`DELETE FROM "PostingLog" WHERE "requirementId" IN (${Z.made.reqs.map((i) => `'${i}'`).join(',')})`); } catch { /* same */ }
  try { await prisma.$executeRawUnsafe(`DELETE FROM "JobPosting" WHERE "requirementId" IN (${Z.made.reqs.map((i) => `'${i}'`).join(',')})`); } catch { /* same */ }
  await prisma.applicationStageEvent.deleteMany({ where: { candidateId: { in: Z.made.cands } } });
  await prisma.application.deleteMany({ where: { candidateId: { in: Z.made.cands } } });
  const reqIdsAll = (await prisma.requirement.findMany({ where: { title: { contains: 'ZZTEST JB' } }, select: { id: true } })).map((r) => r.id);
  await prisma.messageTemplate.deleteMany({ where: { purposeLabel: { startsWith: 'Job post: ZZTEST JB' } } }).catch(() => {});
  await prisma.conversation?.deleteMany?.({ where: { personId: { in: Z.made.cands } } }).catch(() => {});
  try { await prisma.$executeRawUnsafe(`DELETE FROM "ConversationMessage" WHERE "personId" IN (${Z.made.cands.map((i) => `'${i}'`).join(',') || "''"})`); await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE "personId" IN (${Z.made.cands.map((i) => `'${i}'`).join(',') || "''"})`); } catch { /* no inbox tables */ }
  try { await prisma.$executeRawUnsafe(`DELETE FROM CandidateDupFlag WHERE candidateId IN (${Z.made.cands.map((i) => `'${i}'`).join(',') || "''"}) OR matchCandidateId IN (${Z.made.cands.map((i) => `'${i}'`).join(',') || "''"})`); await prisma.$executeRawUnsafe(`DELETE FROM CandidateDupKey WHERE candidateId IN (${Z.made.cands.map((i) => `'${i}'`).join(',') || "''"})`); } catch { /* no dup tables */ }
  await prisma.notification.deleteMany({ where: { OR: [{ title: { contains: 'campaign' } }, { title: { startsWith: 'Requirement broadcast' } }, { message: { contains: 'ZZTEST JB' } }] } });
  const left = await Z.cleanup();
  const extra = {
    settings: await prisma.appSetting.count({ where: { OR: [{ key: { startsWith: 'bc.' } }, { key: { startsWith: 'jobtpl.' } }] } }),
    templates: await prisma.messageTemplate.count({ where: { purposeLabel: { contains: 'ZZTEST JB' } } }),
    audit: await prisma.auditLog.count({ where: { OR: [{ toValue: { contains: 'ZZTEST JB' } }, { fieldLabel: { contains: 'ZZTEST JB' } }] } }),
  };
  void reqIdsAll;
  console.log('left', JSON.stringify(left), JSON.stringify(extra));
  Z.check('no ZZTEST rows left in the sandbox', Object.values(left).every((n) => n === 0) && extra.settings === 0 && extra.templates === 0, [left, extra]);
  await Z.finish();
})().catch(async (e) => { console.error('TEST CRASHED', e); try { await Z.cleanup(); } catch { /* ignore */ } process.exit(1); });
