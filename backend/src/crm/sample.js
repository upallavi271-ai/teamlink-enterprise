// ---------------------------------------------------------------------------
// CRM SAMPLE DATA (founder 2026-11-02: "dummy sale data include cheyyu, yela work avuthundho test cheskodaniki").
// CRM settings -> "Load sample data" fills the CRM with a small, believable sales book so every screen can be tried:
//   12 leads (every status / rating / source), 6 accounts with contacts, 9 deals across the pipeline (won this month and
//   in earlier months, one lost), calls / meetings / emails over the last weeks, follow-ups (late, today, coming), 3 support
//   tickets, this month's target, one proposal.
// Everything belongs to the person who loads it, every name starts with "Sample · ", no reminder, email or WhatsApp is
// ever sent for it (follow-ups are marked as reminded), and "Remove sample data" deletes exactly what was made (the ids
// are kept in AppSetting crm.sample). A sales manager / Admin only.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const DB = require('./schema');
const S = require('./service');
const SETTINGS = require('./settings');

const KEY = 'crm.sample';
const P = 'Sample · ';
const TABLES = { leads: 'CrmLead', accounts: 'CrmAccount', contacts: 'CrmContact', deals: 'CrmDeal', activities: 'CrmActivity', tasks: 'CrmTask', tickets: 'CrmTicket', proposals: 'CrmProposal', targets: 'CrmTarget' };

async function made() {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  try { return row ? JSON.parse(row.value) : null; } catch { return null; }
}
async function status(user) {
  if (!S.mayAssign(S.roleOf(user))) return S.fail(403, 'Sample data is loaded by a Sales manager or an Admin.');
  const m = await made();
  return S.okBody({ loaded: !!m, by: m ? m.byName : null, at: m ? m.at : null, counts: m ? Object.fromEntries(Object.entries(m.ids).map(([k, v]) => [k, v.length])) : null });
}

async function load(user) {
  if (!S.mayAssign(S.roleOf(user))) return S.fail(403, 'Sample data is loaded by a Sales manager or an Admin.');
  if (await made()) return S.fail(400, 'Sample data is in the CRM already. Remove it first to load it again.');
  const ids = Object.fromEntries(Object.keys(TABLES).map((k) => [k, []]));
  const own = { ownerId: user.id, ownerName: user.name || 'Me', createdById: user.id };
  const day = 86400000;
  const ago = (d, h = 11) => new Date(Date.now() - d * day + (h - 11) * 3600000).toISOString();
  const ymd = (d) => new Date(Date.now() + 5.5 * 3600000 + d * day).toISOString().slice(0, 10);
  const st = await SETTINGS.load();
  const add = async (kind, table, row) => { const r = await S.insert(table, { id: S.newId(kind.slice(0, -1)), ...row }); ids[kind].push(r.id); return r; };

  // ---- leads
  const L = [
    ['Apollo Diagnostics', 'Kavitha Reddy', 'HR Manager', 'Referral', 'Hot', 'Qualified', 'Healthcare', 'Hyderabad', 3],
    ['Sri Venkateswara Steels', 'Ramesh Babu', 'Plant HR', 'Cold call', 'Warm', 'Contacted', 'Manufacturing', 'Visakhapatnam', 6],
    ['Bright Minds School', 'Lakshmi Devi', 'Principal', 'Website', 'Warm', 'New', 'Education', 'Vijayawada', 1],
    ['CloudNine Software', 'Arjun Mehta', 'Talent Acquisition Lead', 'LinkedIn', 'Hot', 'Contacted', 'IT', 'Bengaluru', 2],
    ['Green Leaf Foods', 'Prakash Rao', 'GM - Operations', 'Job post signal', 'Cold', 'New', 'FMCG', 'Guntur', 9],
    ['MedPlus Pharmacy Chain', 'Sunitha K', 'Regional HR', 'Event', 'Warm', 'Qualified', 'Healthcare', 'Hyderabad', 12],
    ['Orbit Logistics', 'Imran Khan', 'Operations Head', 'Cold call', 'Cold', 'Junk', 'Logistics', 'Chennai', 20],
    ['Nova Auto Components', 'Suresh Kumar', 'HR Head', 'LinkedIn', 'Hot', 'New', 'Manufacturing', 'Pune', 0],
    ['Lotus Hospitals', 'Dr. Anitha', 'Medical Superintendent', 'Referral', 'Warm', 'Contacted', 'Healthcare', 'Warangal', 4],
    ['Pixel Edge Studios', 'Neha Sharma', 'Founder', 'Website', 'Warm', 'New', 'IT', 'Hyderabad', 1],
  ];
  const leads = [];
  for (const [i, [co, name, desig, source, rating, stat, ind, city, d]] of L.entries()) {
    // eslint-disable-next-line no-await-in-loop
    leads.push(await add('leads', 'CrmLead', { company: `${P}${co}`, contactName: name, designation: desig, phone: `90000${String(70000 + i * 137).slice(-5)}`, email: `sample.lead${i + 1}@example.test`, industry: ind, city, source: st.sources.includes(source) ? source : 'Other', rating, status: stat, notes: 'Sample data for trying the CRM.', ...own, createdAt: ago(d), updatedAt: ago(Math.max(0, d - 1)) }));
  }

  // ---- accounts, contacts and deals (some came from converted leads)
  const A = [
    ['Sunrise Multispeciality Hospital', 'Healthcare', 'Hyderabad', 'Client', [['Dr. Meena Rao', 'HR Head', 'Decision maker'], ['Srinivas', 'HR Executive', 'HR']]],
    ['TechNova Solutions', 'IT', 'Hyderabad', 'Prospect', [['Rahul Jain', 'CTO', 'Decision maker'], ['Pooja Verma', 'Talent Partner', 'HR']]],
    ['Deccan Textiles', 'Manufacturing', 'Warangal', 'Prospect', [['Venkat Rao', 'Factory Manager', 'Influencer']]],
    ['Global Systems India', 'IT', 'Bengaluru', 'Prospect', [['Ananya Iyer', 'HR Director', 'Decision maker']]],
    ['Harvest Agro Exports', 'FMCG', 'Guntur', 'Client', [['Krishna Murthy', 'Owner', 'Decision maker']]],
    ['Vista Learning Academy', 'Education', 'Vijayawada', 'Prospect', [['Shalini', 'Admin Head', 'HR']]],
  ];
  const accts = []; const contactsOf = {};
  for (const [i, [name, ind, city, kind, people]] of A.entries()) {
    // eslint-disable-next-line no-await-in-loop
    const a = await add('accounts', 'CrmAccount', { name: `${P}${name}`, industry: ind, city, kind, phone: `91000${String(30000 + i * 211).slice(-5)}`, email: `sample.account${i + 1}@example.test`, source: i % 2 ? 'LinkedIn' : 'Referral', ...own, createdAt: ago(40 - i * 3), updatedAt: ago(i) });
    accts.push(a); contactsOf[a.id] = [];
    for (const [j, [cn, d2, role]] of people.entries()) {
      // eslint-disable-next-line no-await-in-loop
      contactsOf[a.id].push(await add('contacts', 'CrmContact', { accountId: a.id, name: cn, designation: d2, role, phone: `92000${String(40000 + i * 97 + j).slice(-5)}`, email: `sample.contact${i + 1}${j + 1}@example.test`, ...own, createdAt: ago(38 - i), updatedAt: ago(i) }));
    }
  }
  const D = [
    // account, title, stage, openings, ctc, fee, close (days from today), created (days ago), won/lost (days ago)
    [0, 'Staff nurses - 12 positions', 'Proposal sent', 12, 360000, 8.33, 10, 18],
    [1, 'Java developers - 5 positions', 'Meeting', 5, 1200000, 8.33, 25, 9],
    [2, 'Machine operators - 20 positions', 'Requirement discussed', 20, 240000, 8.33, 20, 14],
    [3, 'Senior QA engineers - 3 positions', 'Negotiation', 3, 1500000, 8.33, 5, 22],
    [5, 'Teachers - 6 positions', 'Prospecting', 6, 300000, 10, 40, 3],
    [1, 'DevOps lead', 'Contacted', 1, 2400000, 8.33, -4, 30],
    [0, 'Lab technicians - 4 positions', 'Won', 4, 300000, 8.33, 0, 35, 0],
    [4, 'Supervisors - 8 positions', 'Won', 8, 360000, 10, -40, 70, 38],
    [4, 'Accounts executives - 2 positions', 'Won', 2, 420000, 10, -70, 100, 68],
    [2, 'Quality inspectors - 5 positions', 'Lost', 5, 300000, 8.33, -10, 45, 9],
  ];
  const deals = [];
  for (const [ai, title, stage, openings, ctc, fee, close, created, closedAgo] of D) {
    const a = accts[ai]; const c = contactsOf[a.id][0];
    const value = Math.round(openings * ctc * fee / 100);
    // eslint-disable-next-line no-await-in-loop
    deals.push(await add('deals', 'CrmDeal', {
      title: `${P}${title}`, accountId: a.id, contactId: c ? c.id : null, stage, openings, avgCtc: ctc, feePercent: fee, value, probability: st.stageProbability[stage],
      expectedClose: ymd(close), nextStep: stage === 'Proposal sent' ? 'Call for their decision on the proposal' : stage === 'Meeting' ? 'Share sample profiles after the meeting' : null,
      wonAt: stage === 'Won' ? ago(closedAgo) : null, lostAt: stage === 'Lost' ? ago(closedAgo) : null, lostReason: stage === 'Lost' ? 'Price / fee too high' : null,
      ...own, createdAt: ago(created), updatedAt: ago(closedAgo || Math.max(0, created - 10)),
    }));
  }
  // a converted lead pointing at a deal (so the funnel has a win)
  await S.update('CrmLead', leads[0].id, { status: 'Converted', convertedAt: ago(2), accountId: accts[0].id, dealId: deals[6].id });
  await S.update('CrmDeal', deals[6].id, { leadId: leads[0].id });

  // ---- activities (the timeline, the dashboard's "today", the activity report)
  const ACT = [
    ['deal', 0, 'call', 'Discussed 12 nurse positions', 'Need ICU experience; joining in 30 days.', 16, 10],
    ['deal', 0, 'email', 'Proposal TLP sent', 'Fee 8.33% of annual CTC, 90-day replacement.', 5, 15],
    ['deal', 1, 'meeting', 'Meeting with the CTO', 'Wants 5 Java devs with Spring Boot; budget up to 12 LPA.', 2, 12],
    ['deal', 1, 'call', 'Follow-up call with Pooja', 'Sharing JD by Friday.', 0, 10],
    ['deal', 2, 'whatsapp', 'Shared company profile', null, 7, 16],
    ['deal', 3, 'meeting', 'Commercial discussion', 'Asked for 7.5% fee; we offered 8% with 60-day guarantee.', 1, 15],
    ['deal', 3, 'call', 'Negotiation follow-up', null, 0, 14],
    ['deal', 6, 'call', 'Confirmed the order', 'Signing the agreement this week.', 3, 11],
    ['lead', 1, 'call', 'Intro call', 'Hiring 30 workers before Sankranti.', 5, 12],
    ['lead', 3, 'email', 'Sent our IT hiring deck', null, 1, 17],
    ['lead', 8, 'call', 'Spoke to the superintendent', 'Interested in nurses and lab techs.', 3, 10],
    ['account', 4, 'note', 'Happy with the last placements', 'Ask about Q1 hiring.', 12, 13],
  ];
  for (const [k, idx, kind, subject, note, d, h] of ACT) {
    const rec = k === 'deal' ? deals[idx] : k === 'lead' ? leads[idx] : accts[idx];
    // eslint-disable-next-line no-await-in-loop
    await add('activities', 'CrmActivity', { kind, subject, note, at: ago(d, h), dealId: k === 'deal' ? rec.id : null, leadId: k === 'lead' ? rec.id : null, accountId: k === 'deal' ? rec.accountId : (k === 'account' ? rec.id : null), byId: user.id, byName: user.name || null, createdAt: ago(d, h) });
  }

  // ---- follow-ups (no reminders: marked as reminded far ahead)
  const T = [
    ['deal', 0, 'Call Dr. Meena for the proposal decision', 0, '11:30'],
    ['deal', 1, 'Send 5 Java profiles to Rahul', 1, null],
    ['deal', 3, 'Send the revised fee terms', -2, null],
    ['lead', 1, 'Call back on the 30 workers', -1, '16:00'],
    ['lead', 3, 'Book a meeting with Arjun', 2, null],
    ['deal', 2, 'Visit the factory', 5, '10:00'],
    ['account', 4, 'Ask about Q1 hiring', 7, null],
  ];
  for (const [k, idx, title, d, time] of T) {
    const rec = k === 'deal' ? deals[idx] : k === 'lead' ? leads[idx] : accts[idx];
    // eslint-disable-next-line no-await-in-loop
    await add('tasks', 'CrmTask', { title, dueDate: ymd(d), dueTime: time, status: 'Open', dealId: k === 'deal' ? rec.id : null, leadId: k === 'lead' ? rec.id : null, accountId: k === 'deal' ? rec.accountId : (k === 'account' ? rec.id : null), remindedOn: '9999-12-31', ...own, createdAt: ago(3), updatedAt: ago(1) });
  }

  // ---- support tickets
  const SUP = require('./support'); // eslint-disable-line global-require
  const TK = [
    [0, 'Staff nurse left after 1 week - replacement needed', 'Candidate replacement', 'High', 'In progress', 1],
    [4, 'Invoice shows the wrong GST number', 'Invoice / payment', 'Medium', 'Open', 0],
    [0, 'Interview slots for Saturday', 'Interview scheduling', 'Low', 'Resolved', 6],
  ];
  const base = ((await DB.one('SELECT COUNT(*) AS "n" FROM "CrmTicket"')) || {}).n;
  for (const [i, [ai, subject, category, priority, stat, d]] of TK.entries()) {
    const a = accts[ai];
    const created = ago(d, 10);
    // eslint-disable-next-line no-await-in-loop
    await add('tickets', 'CrmTicket', { number: `TKT-${String(base + i + 1).padStart(4, '0')}`, subject: `${P}${subject}`, description: 'Sample ticket for trying Customer Support.', accountId: a.id, contactId: contactsOf[a.id][0].id, category, channel: 'Phone', priority, status: stat, dueAt: new Date(Date.parse(created) + SUP.SLA_HOURS[priority] * 3600000).toISOString(), firstReplyAt: stat !== 'Open' ? ago(d, 13) : null, resolvedAt: stat === 'Resolved' ? ago(d - 1, 12) : null, ...own, createdAt: created, updatedAt: ago(0) });
  }

  // ---- this month's target and a proposal
  const month = S.istToday().slice(0, 7);
  const cur = await DB.one('SELECT "id" FROM "CrmTarget" WHERE "ownerId" = ? AND "month" = ?', user.id, month);
  if (!cur) await add('targets', 'CrmTarget', { ownerId: user.id, ownerName: user.name || null, month, amount: 500000, deals: 3, setById: user.id, createdAt: DB.nowIso(), updatedAt: DB.nowIso() });
  await add('proposals', 'CrmProposal', {
    number: `TLP-SAMPLE-001`, dealId: deals[0].id, accountId: deals[0].accountId, status: 'Sent', sentAt: ago(5), sentTo: 'sample.contact11@example.test', createdById: user.id, createdByName: user.name || null, createdAt: ago(5), updatedAt: ago(5),
    dataJson: JSON.stringify({ roles: [{ title: 'Staff Nurse (ICU)', openings: 12, ctc: 360000 }], feePercent: 8.33, gstPercent: 18, paymentDays: 30, guaranteeDays: 90, validityDays: 30, company: accts[0].name, toName: 'Dr. Meena Rao', toEmail: 'sample.contact11@example.test', fromName: user.name || '', fromEmail: '', fromPhone: '', notes: 'Sample proposal.' }),
  });

  const now = DB.nowIso();
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify({ ids, byId: user.id, byName: user.name || null, at: now }) }, update: { value: JSON.stringify({ ids, byId: user.id, byName: user.name || null, at: now }) } });
  await S.audit(user, 'CRM sample data loaded', 'Crm', 'sample', Object.entries(ids).map(([k, v]) => `${v.length} ${k}`).join(', '));
  return S.okBody({ ok: true, counts: Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, v.length])) });
}

async function remove(user) {
  if (!S.mayAssign(S.roleOf(user))) return S.fail(403, 'Sample data is removed by a Sales manager or an Admin.');
  const m = await made();
  if (!m) return S.fail(400, 'There is no sample data in the CRM.');
  let n = 0;
  for (const [k, table] of Object.entries(TABLES)) {
    const list = (m.ids && m.ids[k]) || [];
    for (const id of list) n += await DB.run(`DELETE FROM "${table}" WHERE "id" = ?`, id); // eslint-disable-line no-await-in-loop
  }
  // what the person added on top of sample records (a note on a sample deal, a comment on a sample ticket ...)
  const dealIds = m.ids.deals || []; const leadIds = m.ids.leads || []; const accIds = m.ids.accounts || []; const tktIds = m.ids.tickets || [];
  const inList = (col, arr) => (arr.length ? `"${col}" IN (${arr.map(() => '?').join(', ')})` : '1=0');
  await DB.run(`DELETE FROM "CrmActivity" WHERE ${inList('dealId', dealIds)} OR ${inList('leadId', leadIds)} OR ${inList('accountId', accIds)}`, ...dealIds, ...leadIds, ...accIds);
  await DB.run(`DELETE FROM "CrmTask" WHERE ${inList('dealId', dealIds)} OR ${inList('leadId', leadIds)} OR ${inList('accountId', accIds)}`, ...dealIds, ...leadIds, ...accIds);
  await DB.run(`DELETE FROM "CrmTicketComment" WHERE ${inList('ticketId', tktIds)}`, ...tktIds);
  await DB.run(`DELETE FROM "CrmProposal" WHERE ${inList('dealId', dealIds)}`, ...dealIds);
  await DB.run(`DELETE FROM "CrmContact" WHERE ${inList('accountId', accIds)}`, ...accIds);
  // an invoice (and its payment lines) raised on a sample deal or sample customer goes too: left behind it would count in Invoiced / Collected / Still to collect
  const invs = await DB.all(`SELECT "id" FROM "CrmInvoice" WHERE ${inList('dealId', dealIds)} OR ${inList('accountId', accIds)}`, ...dealIds, ...accIds).catch(() => []);
  const invIds = invs.map((x) => x.id);
  await DB.run(`DELETE FROM "CrmPayment" WHERE ${inList('invoiceId', invIds)} OR ${inList('dealId', dealIds)} OR ${inList('accountId', accIds)}`, ...invIds, ...dealIds, ...accIds);
  await DB.run(`DELETE FROM "CrmInvoice" WHERE ${inList('id', invIds)}`, ...invIds);
  const freed = await S.resetCodeCounters().catch(() => ({}));
  await prisma.appSetting.delete({ where: { key: KEY } }).catch(() => null);
  await S.audit(user, 'CRM sample data removed', 'Crm', 'sample', `${n} rows, ${invIds.length} invoices`);
  return S.okBody({ ok: true, removed: n, invoicesRemoved: invIds.length, numbersFreed: freed });
}

module.exports = { status, load, remove };
