// ---------------------------------------------------------------------------
// BILLING FROM TIMESHEETS ON THE ATS SIDE
//   09.15  the pay / bill / document check of every placement before it is billed (rules in code; AI only explains, optional)
//   06.12  approved timesheets -> an invoice-READY batch per client (number STF-YYYY-NNNN, lines, GST) -> export files
//   06.11 / 14.08  the batch as a Tally XML / Zoho Books CSV / plain CSV / JSON file, and a signed push to an outside address
//          (Zapier / n8n / Zoho Flow / your own system) or straight into Zoho Books with the founder's Zoho keys.
// THE ACCOUNTS BOUNDARY: nothing here reads or writes TeamLink Accounts (invoices, ledgers, receivables). A batch is not an invoice;
// posting it into Accounts needs a founder decision.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../../db');
const S = require('./store');
const K = require('./contracts');
const T = require('./timesheets');
const H = require('./http');

const roleOf = (u) => K.roleOf(u);
const mayBill = (u) => ['admin', 'tl', 'stl', 'accounts'].includes(roleOf(u)) || require('../scope').isBdeTl(u); // eslint-disable-line global-require
const BATCH_STATES = ['Ready', 'Sent to accounting', 'Cancelled'];
const ACCOUNTS_BOUNDARY = 'Posting into TeamLink Accounts needs a founder decision. Until then the batch is an export file (and an optional push to your accounting software); Accounts is not touched.';

const ID_DOC = /aadhaar|aadhar|\bpan\b|passport|voter|driving|licen[cs]e|identity|\bid\b/i;
const ENGAGE_DOC = /offer|appointment|joining|contract|engagement|nda|agreement/i;
const safe = async (p, d) => { try { return await p; } catch { return d; } };

// ---- 09.15 the check ------------------------------------------------------------------------------------------------------------
async function auditMany(user, contractors) {
  const cs = contractors || await K.list(user);
  const ids = cs.map((c) => c.applicationId);
  if (!ids.length) return [];
  const cands = [...new Set(cs.map((c) => c.candidateId))];
  const clientIds = [...new Set(cs.map((c) => c.clientId))];
  const today = new Date().toISOString().slice(0, 10);
  const [docs, clients, rates, sheets, bgv, extra, expiry, vms, minMargin] = await Promise.all([
    prisma.candidateDocument.findMany({ where: { candidateId: { in: cands }, deletedAt: null }, select: { candidateId: true, docType: true, name: true } }),
    prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true, gst: true, state: true, agreementStatus: true, agreementEnd: true } }),
    K.rateRows(ids),
    T.rowsFor(ids),
    safe(S.q(S.inList('SELECT "applicationId","overall" FROM "ApplicationBgv" WHERE "applicationId" IN (?)', ids), ...ids), []),
    safe(S.q(S.inList('SELECT "requirementId","bgvNeeded" FROM "RequirementExtra" WHERE "requirementId" IN (?)', [...new Set(cs.map((c) => c.requirementId))]), ...new Set(cs.map((c) => c.requirementId))), []),
    safe(S.q(S.inList('SELECT "candidateId","expiresOn" FROM "MktDocExpiry" WHERE "candidateId" IN (?)', cands), ...cands), []),
    safe(S.q(S.inList('SELECT s."applicationId", j."maxBillRate", j."system" FROM "StfVmsSub" s JOIN "StfVmsJob" j ON j."id" = s."vmsJobId" WHERE s."applicationId" IN (?)', ids), ...ids), []),
    S.setting('margin.min'),
  ]);
  const D = new Map(); docs.forEach((d) => { if (!D.has(d.candidateId)) D.set(d.candidateId, []); D.get(d.candidateId).push(d); });
  const CL = new Map(clients.map((c) => [c.id, c]));
  const B = new Map(bgv.map((b) => [b.applicationId, b.overall]));
  const X = new Map(extra.map((e) => [e.requirementId, S.num(e.bgvNeeded) > 0]));
  const EXP = new Map(); expiry.forEach((e) => { if (e.expiresOn < today) EXP.set(e.candidateId, (EXP.get(e.candidateId) || 0) + 1); });
  const V = new Map(vms.map((v) => [v.applicationId, v]));
  const blind = require('../agreementPrivacy').blindTo(user); // eslint-disable-line global-require
  const SH = new Map(); sheets.forEach((r) => { if (!SH.has(r.applicationId)) SH.set(r.applicationId, []); SH.get(r.applicationId).push(r); });

  return cs.map((c) => {
    const errors = []; const warnings = []; const passed = [];
    const add = (lvl, key, text) => (lvl === 'error' ? errors : lvl === 'warn' ? warnings : passed).push({ key, text });
    // rates
    const rs = rates.get(c.applicationId) || [];
    const cur = K.rateFor(rs, S.mondayOf(today)) || rs[rs.length - 1] || null;
    if (!cur) add('error', 'rate.missing', 'No pay and bill rate is set.');
    else {
      const pay = Number(cur.payRate) || 0; const bill = Number(cur.billRate) || 0; const cost = pay * (1 + (Number(cur.loadPercent) || 0) / 100);
      const margin = bill > 0 ? ((bill - cost) / bill) * 100 : -100;
      if (bill <= cost) add('error', 'rate.loss', `The bill rate (${bill}) does not cover the cost (${S.money(cost)}).`);
      else if (margin < Number(minMargin || 0)) add('warn', 'rate.lowMargin', `Margin ${S.money(margin)}% is below the healthy ${minMargin}%.`);
      else add('ok', 'rate.ok', `Rates set: margin ${S.money(margin)}%.`);
      if (cost > 0 && ((bill - cost) / cost) * 100 > 150) add('warn', 'rate.typo', `Markup over 150% (${S.money(((bill - cost) / cost) * 100)}%): check for a typo.`);
      const v = V.get(c.applicationId);
      if (v && v.maxBillRate != null && bill > Number(v.maxBillRate)) add('error', 'rate.vmsMax', `The bill rate ${bill} is above the VMS job's highest rate ${Number(v.maxBillRate)}.`);
    }
    // documents
    const ds = D.get(c.candidateId) || [];
    if (!ds.some((d) => d.docType === 'ID' || ID_DOC.test(`${d.docType} ${d.name}`))) add('error', 'doc.id', 'No ID proof on the candidate\'s documents.');
    else add('ok', 'doc.id', 'ID proof on file.');
    if (!ds.some((d) => ['Offer', 'Joining'].includes(d.docType) || ENGAGE_DOC.test(`${d.docType} ${d.name}`))) add('warn', 'doc.engagement', 'No offer, joining or contract letter on the candidate\'s documents.');
    else add('ok', 'doc.engagement', 'Offer / contract letter on file.');
    if (EXP.get(c.candidateId)) add('warn', 'doc.expired', `${EXP.get(c.candidateId)} document(s) past their expiry date.`);
    // background check
    const overall = B.get(c.applicationId);
    if (overall === 'Discrepancy') add('error', 'bgv.discrepancy', 'The background check found a discrepancy.');
    else if (X.get(c.requirementId) && overall !== 'Clear') add('error', 'bgv.pending', `The job needs a background check; it is ${overall || 'not started'}.`);
    else if (overall === 'Clear') add('ok', 'bgv.ok', 'Background check clear.');
    // client
    // agreements are not for TLs / STLs / recruiters / HR (utils/agreementPrivacy.js): they get the plain "on hold" sentence instead
    const cl = CL.get(c.clientId) || {};
    const agreeOk = ['ACTIVE', 'CONFIRMED'].includes(String(cl.agreementStatus || '').toUpperCase()) && !(cl.agreementEnd && cl.agreementEnd < today);
    if (!agreeOk && blind) add('error', 'client.onHold', 'This client is on hold for billing. Ask your Business Development manager.');
    else if (!['ACTIVE', 'CONFIRMED'].includes(String(cl.agreementStatus || '').toUpperCase())) add('error', 'client.agreement', `The client agreement is ${String(cl.agreementStatus || 'missing').toLowerCase()}, not active.`);
    else if (cl.agreementEnd && cl.agreementEnd < today) add('error', 'client.agreementEnded', `The client agreement ended on ${cl.agreementEnd}.`);
    else if (!blind) add('ok', 'client.agreement', 'Client agreement active.');
    if (!String(cl.gst || '').trim()) add('warn', 'client.gst', 'The client has no GSTIN on file (a B2B invoice needs it).');
    if (!c.poNumber) add('warn', 'contract.po', 'No PO number on the contract (many clients reject an invoice without it).');
    if (c.endOn && c.endOn < today && c.status !== 'Ended') add('warn', 'contract.ended', `The contract ended on ${c.endOn} but is still marked active.`);
    // timesheets waiting to be billed
    const open = (SH.get(c.applicationId) || []).filter((r) => r.status === 'Approved' && !r.batchId);
    open.forEach((r) => {
      const h = S.parse(r.hours, []);
      if (Number(r.totalHours) > 84) add('error', 'ts.tooMany', `Week of ${r.weekStart}: ${r.totalHours} hours (more than 84).`);
      else if (h.some((v) => Number(v) > 16)) add('warn', 'ts.longDay', `Week of ${r.weekStart}: a day over 16 hours.`);
      if (r.submittedById && r.submittedById === r.decidedById) add('error', 'ts.selfApproved', `Week of ${r.weekStart} was approved by the person who entered it.`);
      if ((c.startOn && S.addDays(r.weekStart, 6) < c.startOn) || (c.endOn && r.weekStart > c.endOn)) add('error', 'ts.outside', `Week of ${r.weekStart} is outside the contract dates.`);
      const rate = K.rateFor(rs, r.weekStart);
      if (!rate) add('error', 'ts.noRate', `Week of ${r.weekStart} has no rate in force.`);
      else {
        const m = K.calc(rate, h, c.weeklyHours);
        if (r.billAmount == null) add('warn', 'ts.unpriced', `Week of ${r.weekStart} was approved before a rate was set; it is priced at billing.`);
        else if (Math.abs(m.bill - Number(r.billAmount)) > 0.5) add('warn', 'ts.rateChanged', `Week of ${r.weekStart}: the rate changed after approval (${Number(r.billAmount)} then, ${m.bill} now). The approved figure is billed.`);
      }
    });
    if (open.length) add('ok', 'ts.open', `${open.length} approved week(s) waiting to be billed.`);
    return { applicationId: c.applicationId, name: c.name, client: c.client, clientId: c.clientId, requirement: c.requirement, errors, warnings, passed, ready: !errors.length, unbilledWeeks: open.length };
  });
}
async function audit(user, { clientId = null, applicationId = null } = {}) {
  const cs = await K.list(user, { clientId, applicationId });
  const rows = await auditMany(user, cs.filter((c) => !c.ended || applicationId));
  return { rows, ready: rows.filter((r) => r.ready).length, blocked: rows.filter((r) => !r.ready).length };
}

// AI explains the result in plain words (optional). The model gets the check results only: no name, no client, no money.
async function explain(user, applicationId, { useAi = false } = {}) {
  const [row] = (await audit(user, { applicationId })).rows;
  if (!row) return { error: 'Contractor not found (or not in your scope).', status: 404 };
  const facts = [...row.errors.map((e) => `MUST FIX: ${e.text}`), ...row.warnings.map((w) => `CHECK: ${w.text}`)];
  const strip = (t) => t.replace(/\d[\d,.]*/g, (m) => m); // numbers stay (rates / dates are not personal data)
  const code = () => {
    if (!facts.length) return 'Everything checks out: rates, documents, the agreement and the approved weeks are in order. This placement can be billed.';
    const must = row.errors.length ? `Before billing, fix ${row.errors.length} thing${row.errors.length === 1 ? '' : 's'}: ${row.errors.map((e) => e.text.replace(/\.$/, '')).join('; ')}.` : 'Nothing stops the billing.';
    const look = row.warnings.length ? ` Also look at: ${row.warnings.map((w) => w.text.replace(/\.$/, '')).join('; ')}.` : '';
    return `${must}${look}`;
  };
  if (!useAi || !facts.length) return { text: code(), source: 'rules', row };
  try {
    const FA = require('../fastAi'); // eslint-disable-line global-require
    const sys = 'You check contract-staffing billing in India. You get the results of a rule check of ONE placement. Write 2-4 short plain-English sentences for the billing team: what must be fixed first and why it matters (rejected invoice, GST, compliance), then what to look at. Never invent facts that are not in the list.';
    const out = await FA.chat(sys, [{ role: 'user', content: facts.map(strip).join('\n') }], { purpose: 'Billing document check', maxTokens: 300, temperature: 0.1, deadlineMs: 20000, fallbackToApp: false });
    const text = String((out && out.text) || '').trim();
    if (text.length > 20) return { text: text.slice(0, 1200), source: `AI (${out.provider || 'fast AI'})`, row };
  } catch { /* the rules answer */ }
  return { text: code(), source: 'rules (the AI did not answer)', row };
}

// ---- 06.12 batches ------------------------------------------------------------------------------------------------------------------
async function clientsInScope(user) { return new Map((await K.list(user)).map((c) => [c.applicationId, c])); }

async function unbilled(user, { clientId = null } = {}) {
  const C = await clientsInScope(user);
  const ids = [...C.keys()].filter((id) => !clientId || C.get(id).clientId === clientId);
  const rows = (await T.rowsFor(ids, { status: 'Approved' })).filter((r) => !r.batchId);
  const by = new Map();
  rows.forEach((r) => {
    const c = C.get(r.applicationId);
    const g = by.get(c.clientId) || { clientId: c.clientId, client: c.client, weeks: 0, hours: 0, bill: 0, from: r.weekStart, to: r.weekStart, contractors: new Set() };
    g.weeks += 1; g.hours += Number(r.totalHours) || 0; g.bill += Number(r.billAmount) || 0; g.contractors.add(r.applicationId);
    if (r.weekStart < g.from) g.from = r.weekStart; if (r.weekStart > g.to) g.to = r.weekStart;
    by.set(c.clientId, g);
  });
  return { rows: [...by.values()].map((g) => ({ ...g, contractors: g.contractors.size, hours: S.money(g.hours), bill: S.money(g.bill) })) };
}

async function nextNumber() {
  const y = new Date().getFullYear();
  const [r] = await S.q('SELECT COUNT(*) AS n FROM "StfBatch" WHERE "number" LIKE ?', `STF-${y}-%`);
  let k = S.num(r && r.n) + 1;
  // never reuse a number
  for (;;) {
    const no = `STF-${y}-${String(k).padStart(4, '0')}`;
    // eslint-disable-next-line no-await-in-loop
    if (!(await S.q('SELECT 1 FROM "StfBatch" WHERE "number" = ?', no)).length) return no;
    k += 1;
  }
}

async function createBatch(user, { clientId, from = null, to = null, override = null } = {}) {
  if (!mayBill(user)) return { error: 'An Admin, a team lead, a BDE TL or the accounts team builds billing batches.', status: 403 };
  const C = await clientsInScope(user);
  const cs = [...C.values()].filter((c) => c.clientId === clientId);
  if (!cs.length) return { error: 'Pick a client that has your contractors.', status: 404 };
  const ids = cs.map((c) => c.applicationId);
  let lines = (await T.rowsFor(ids, { status: 'Approved', from: S.isDate(from) ? from : null, to: S.isDate(to) ? to : null })).filter((r) => !r.batchId);
  if (!lines.length) return { error: 'No approved, unbilled weeks for this client in that period.', status: 400 };
  // weeks approved before a rate was set are priced now, from the rate of their week
  const R = await K.rateRows(ids);
  for (const r of lines.filter((l) => l.billAmount == null)) {
    const rate = K.rateFor(R.get(r.applicationId) || [], r.weekStart);
    if (!rate) return { error: `${C.get(r.applicationId).name}, week of ${r.weekStart}: no rate in force. Set the rate first.`, status: 409 };
    const m = K.calc(rate, S.parse(r.hours, []), C.get(r.applicationId).weeklyHours);
    // eslint-disable-next-line no-await-in-loop
    await S.x('UPDATE "StfTimesheet" SET "rateId"=?,"payAmount"=?,"costAmount"=?,"billAmount"=? WHERE "id"=?', rate.id, m.pay, m.cost, m.bill, r.id);
    Object.assign(r, { rateId: rate.id, payAmount: m.pay, costAmount: m.cost, billAmount: m.bill });
  }
  // 09.15: a placement with a MUST-FIX stops the batch, unless an Admin bills anyway with a reason
  const checks = await auditMany(user, cs.filter((c) => lines.some((l) => l.applicationId === c.applicationId)));
  const blocked = checks.filter((r) => !r.ready);
  const why = S.clean(override, 300);
  if (blocked.length) {
    if (!why) return { error: `The billing check stops ${blocked.length} placement(s): ${blocked.map((b) => `${b.name} (${b.errors[0].text})`).join('; ')}`, blocked, status: 409 };
    if (roleOf(user) !== 'admin') return { error: 'Only an Admin bills past the billing check.', status: 403 };
    if (why.length < 10) return { error: 'Say clearly why it is billed anyway (at least 10 letters).' };
  }
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true, gstPercent: true } });
  const sum = (k) => S.money(lines.reduce((a, r) => a + (Number(r[k]) || 0), 0));
  const bill = sum('billAmount'); const gstP = client && client.gstPercent != null ? Number(client.gstPercent) : 18;
  const gst = S.money((bill * gstP) / 100);
  const id = S.newId(); const number = await nextNumber();
  const weeks = lines.map((l) => l.weekStart).sort();
  await S.x(`INSERT INTO "StfBatch" ("id","number","clientId","clientName","fromWeek","toWeek","lines","hours","billTotal","payTotal","costTotal","gstPercent","gstAmount","grandTotal","status","override","byId","byName","at")
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, number, clientId, client ? client.name : null, weeks[0], weeks[weeks.length - 1], lines.length, sum('totalHours'), bill, sum('payAmount'), sum('costAmount'), gstP, gst, S.money(bill + gst), 'Ready', blocked.length ? why : null, user.id, user.name, S.now());
  await S.x(S.inList('UPDATE "StfTimesheet" SET "batchId" = ? WHERE "id" IN (?) AND "batchId" IS NULL', lines), id, ...lines.map((l) => l.id));
  await require('../audit').logAudit({ userId: user.id, action: 'Contract billing batch made', entity: 'StfBatch', entityId: id, toValue: `${number} · ${client ? client.name : ''} · ${lines.length} weeks · ${bill} + GST`, reason: blocked.length ? `Billed past the check: ${why}` : undefined }); // eslint-disable-line global-require
  let pushed = null;
  if (await S.setting('accounting.autoPush')) pushed = await push(user, id).catch((e) => ({ error: e.message }));
  return { ok: true, id, number, lines: lines.length, bill, gstAmount: gst, total: S.money(bill + gst), pushed, boundary: ACCOUNTS_BOUNDARY }; // never a key named "gst": the client-field guard reads that as a client row
}

const batchView = (b, user) => ({
  id: b.id, number: b.number, clientId: b.clientId, client: b.clientName, fromWeek: b.fromWeek, toWeek: S.addDays(b.toWeek, 6), lines: S.num(b.lines), hours: Number(b.hours) || 0,
  billTotal: Number(b.billTotal) || 0, gstPercent: Number(b.gstPercent) || 0, gstAmount: Number(b.gstAmount) || 0, grandTotal: Number(b.grandTotal) || 0,
  ...(K.seesPay(user) ? { costTotal: Number(b.costTotal) || 0, margin: S.money((Number(b.billTotal) || 0) - (Number(b.costTotal) || 0)) } : {}),
  status: b.status, override: b.override || null, pushedAt: b.pushedAt || null, pushResult: b.pushResult || null, byName: b.byName, at: b.at,
});
async function batches(user) {
  const C = await clientsInScope(user);
  const clientIds = [...new Set([...C.values()].map((c) => c.clientId))];
  const rows = roleOf(user) === 'admin' ? await S.q('SELECT * FROM "StfBatch" ORDER BY "at" DESC LIMIT 300')
    : (clientIds.length ? await S.q(`${S.inList('SELECT * FROM "StfBatch" WHERE "clientId" IN (?)', clientIds)} ORDER BY "at" DESC LIMIT 300`, ...clientIds) : []);
  return { rows: rows.map((b) => batchView(b, user)), boundary: ACCOUNTS_BOUNDARY };
}
async function batchOf(user, id) {
  const b = (await S.q('SELECT * FROM "StfBatch" WHERE "id" = ?', String(id || '')))[0];
  if (!b) return null;
  if (roleOf(user) === 'admin') return b;
  const C = await clientsInScope(user);
  return [...C.values()].some((c) => c.clientId === b.clientId) ? b : null;
}
async function batchLines(b) {
  const rows = await S.q('SELECT * FROM "StfTimesheet" WHERE "batchId" = ? ORDER BY "weekStart"', b.id);
  const ids = [...new Set(rows.map((r) => r.applicationId))];
  const apps = ids.length ? await prisma.application.findMany({ where: { id: { in: ids } }, select: { id: true, candidate: { select: { name: true } }, requirement: { select: { title: true } } } }) : [];
  const A = new Map(apps.map((a) => [a.id, a]));
  const C = await K.contractRows(ids);
  const R = new Map((rows.length ? await S.q(S.inList('SELECT * FROM "StfRate" WHERE "id" IN (?)', rows.map((r) => r.rateId).filter(Boolean)), ...rows.map((r) => r.rateId).filter(Boolean)) : []).map((r) => [r.id, r]));
  return rows.map((r) => {
    const a = A.get(r.applicationId); const rate = R.get(r.rateId) || {};
    return {
      timesheetId: r.id, applicationId: r.applicationId, name: a ? a.candidate.name : '', role: a ? a.requirement.title : '', weekStart: r.weekStart, weekEnd: S.addDays(r.weekStart, 6),
      regHours: Number(r.regHours) || 0, otHours: Number(r.otHours) || 0, totalHours: Number(r.totalHours) || 0, days: S.num(r.daysWorked), unit: rate.unit || 'Hour',
      billRate: Number(rate.billRate) || 0, otBill: rate.otBill != null ? Number(rate.otBill) : 1.5, billAmount: Number(r.billAmount) || 0, payAmount: Number(r.payAmount) || 0, costAmount: Number(r.costAmount) || 0,
      poNumber: (C.get(r.applicationId) || {}).poNumber || '', costCentre: (C.get(r.applicationId) || {}).costCentre || '', approvedBy: `${r.decidedByName || ''} (${r.decidedByKind || ''})`,
    };
  });
}
async function batchDetail(user, id) {
  const b = await batchOf(user, id);
  if (!b) return { error: 'Batch not found (or not in your scope).', status: 404 };
  const lines = await batchLines(b);
  const pay = K.seesPay(user);
  return { batch: batchView(b, user), lines: lines.map((l) => (pay ? l : { ...l, payAmount: undefined, costAmount: undefined })), boundary: ACCOUNTS_BOUNDARY };
}
async function cancelBatch(user, id, reason) {
  if (!mayBill(user)) return { error: 'An Admin, a team lead, a BDE TL or the accounts team cancels billing batches.', status: 403 };
  const b = await batchOf(user, id);
  if (!b) return { error: 'Batch not found (or not in your scope).', status: 404 };
  if (b.status === 'Cancelled') return { error: 'Already cancelled.', status: 409 };
  const why = S.clean(reason, 300);
  if (!why) return { error: 'Say why the batch is cancelled.' };
  await S.x('UPDATE "StfBatch" SET "status"=\'Cancelled\',"pushResult"=COALESCE("pushResult",\'\') || ? WHERE "id"=?', ` · Cancelled by ${user.name}: ${why}`, b.id);
  await S.x('UPDATE "StfTimesheet" SET "batchId"=NULL WHERE "batchId"=?', b.id);
  await require('../audit').logAudit({ userId: user.id, action: 'Contract billing batch cancelled', entity: 'StfBatch', entityId: b.id, toValue: b.number, reason: why }); // eslint-disable-line global-require
  return { ok: true, warning: b.status === 'Sent to accounting' ? 'This batch was already sent to the accounting address: cancel it there too.' : null };
}

// ---- the files -------------------------------------------------------------------------------------------------------------------
async function gstSplit(b) {
  const client = await prisma.client.findUnique({ where: { id: b.clientId }, select: { gst: true, state: true } });
  const ours = String((await S.setting('billing.homeGstin')) || '').trim().toUpperCase();
  const theirs = String((client && client.gst) || '').trim().toUpperCase();
  const gst = Number(b.gstAmount) || 0;
  const known = /^\d{2}/.test(ours) && /^\d{2}/.test(theirs);
  if (!known) return { gstin: theirs, kind: 'GST', lines: gst > 0 ? [['Output GST', gst]] : [], state: client && client.state };
  if (ours.slice(0, 2) === theirs.slice(0, 2)) { const half = S.money(gst / 2); return { gstin: theirs, kind: 'CGST_SGST', lines: [['Output CGST', half], ['Output SGST', S.money(gst - half)]], state: client.state }; }
  return { gstin: theirs, kind: 'IGST', lines: [['Output IGST', gst]], state: client.state };
}
async function exportBatch(user, id, format = 'csv') {
  const b = await batchOf(user, id);
  if (!b) return { error: 'Batch not found (or not in your scope).', status: 404 };
  if (b.status === 'Cancelled') return { error: 'A cancelled batch is not exported.', status: 409 };
  const AE = S; // xml / csvCell
  const lines = await batchLines(b);
  const tax = await gstSplit(b);
  const sac = (await S.setting('billing.sac')) || '998513';
  const date = String(b.at || S.now()).slice(0, 10);
  const desc = (l) => `${l.name} · ${l.role} · ${l.weekStart} to ${l.weekEnd} · ${l.regHours} h${l.otHours ? ` + ${l.otHours} h overtime` : ''}${l.poNumber ? ` · PO ${l.poNumber}` : ''}`;
  await require('../audit').logAudit({ userId: user.id, action: 'Contract billing batch exported', entity: 'StfBatch', entityId: b.id, toValue: `${b.number} as ${format}` }); // eslint-disable-line global-require
  if (format === 'json') return { name: `${b.number}.json`, type: 'application/json', body: JSON.stringify(payloadOf(b, lines, tax, sac, 'teamlink'), null, 2) };
  if (format === 'zoho') {
    const head = ['Invoice Date', 'Invoice Number', 'Invoice Status', 'Customer Name', 'GST Treatment', 'GST Identification Number (GSTIN)', 'Place of Supply', 'Currency Code', 'PurchaseOrder', 'Item Name', 'Item Desc', 'SAC', 'Quantity', 'Usage unit', 'Item Price', 'Item Tax %', 'Item Tax Type', 'Notes'];
    const out = [head.map((h) => AE.csvCell(h)).join(',')];
    lines.forEach((l) => {
      const pct = Number(b.gstPercent) || 0;
      out.push([[date, false], [b.number, true], ['Draft', true], [b.clientName, true], [tax.gstin ? 'business_gst' : 'business_none', true], [tax.gstin, true], [tax.gstin ? tax.gstin.slice(0, 2) : '', true], ['INR', false], [l.poNumber, true],
        ['Contract staffing', true], [desc(l), true], [sac, false], ['1', false], ['week', true], [S.money(l.billAmount).toFixed(2), false], [pct ? String(pct) : '', false], [pct ? (tax.kind === 'IGST' ? 'Tax' : 'Tax Group') : '', true], [`TeamLink contract billing batch ${b.number}`, true]]
        .map(([v, t]) => AE.csvCell(v, t)).join(','));
    });
    return { name: `${b.number}-zoho-books.csv`, type: 'text/csv; charset=utf-8', body: `﻿${out.join('\r\n')}\r\n` };
  }
  if (format === 'tally') {
    const party = b.clientName || 'Unknown client';
    const sales = 'Contract Staffing Services';
    const L = (name, amount, debit) => ['      <ALLLEDGERENTRIES.LIST>', `       <LEDGERNAME>${AE.xml(name)}</LEDGERNAME>`, `       <ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`, `       <ISPARTYLEDGER>${name === party ? 'Yes' : 'No'}</ISPARTYLEDGER>`, `       <AMOUNT>${debit ? '-' : ''}${S.money(amount).toFixed(2)}</AMOUNT>`, '      </ALLLEDGERENTRIES.LIST>'].join('\n');
    const xmlBody = ['<?xml version="1.0" encoding="UTF-8"?>', '<ENVELOPE>', ' <HEADER>', '  <TALLYREQUEST>Import Data</TALLYREQUEST>', ' </HEADER>', ' <BODY>', '  <IMPORTDATA>', '   <REQUESTDESC>', '    <REPORTNAME>Vouchers</REPORTNAME>', '   </REQUESTDESC>', '   <REQUESTDATA>',
      '    <TALLYMESSAGE xmlns:UDF="TallyUDF">', '     <VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Accounting Voucher View">', `      <DATE>${date.replace(/-/g, '')}</DATE>`, '      <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>',
      `      <VOUCHERNUMBER>${AE.xml(b.number)}</VOUCHERNUMBER>`, `      <PARTYLEDGERNAME>${AE.xml(party)}</PARTYLEDGERNAME>`, tax.gstin ? `      <PARTYGSTIN>${AE.xml(tax.gstin)}</PARTYGSTIN>` : null,
      `      <NARRATION>${AE.xml(`Contract staffing ${b.fromWeek} to ${S.addDays(b.toWeek, 6)}: ${lines.length} timesheet weeks (SAC ${sac}). ${lines.map(desc).join(' | ')}`.slice(0, 3000))}</NARRATION>`,
      L(party, Number(b.grandTotal) || 0, true), L(sales, Number(b.billTotal) || 0, false), ...tax.lines.map(([n2, v]) => L(n2, v, false)),
      '     </VOUCHER>', '    </TALLYMESSAGE>', '   </REQUESTDATA>', '  </IMPORTDATA>', ' </BODY>', '</ENVELOPE>', ''].filter((v) => v !== null).join('\n');
    return { name: `${b.number}-tally.xml`, type: 'application/xml', body: xmlBody };
  }
  // plain CSV (the invoice-ready sheet)
  const head = ['Batch', 'Client', 'Client GSTIN', 'PO', 'Cost centre', 'Contractor', 'Role', 'Week from', 'Week to', 'Regular hours', 'Overtime hours', 'Days', 'Rate per', 'Bill rate', 'Overtime factor', 'Bill amount', 'Approved by'];
  const out = [head.map((h) => AE.csvCell(h)).join(',')];
  lines.forEach((l) => out.push([b.number, b.clientName, tax.gstin, l.poNumber, l.costCentre, l.name, l.role, l.weekStart, l.weekEnd, l.regHours, l.otHours, l.days, l.unit, l.billRate, l.otBill, S.money(l.billAmount).toFixed(2), l.approvedBy].map((v, i) => AE.csvCell(v, i < 9 || i === 12 || i === 16)).join(',')));
  out.push('');
  out.push(['', '', '', '', '', '', '', '', '', '', '', '', '', '', 'Before GST', S.money(b.billTotal).toFixed(2)].map((v) => AE.csvCell(v)).join(','));
  tax.lines.forEach(([n2, v]) => out.push(['', '', '', '', '', '', '', '', '', '', '', '', '', '', `${n2} (${b.gstPercent}%)`, S.money(v).toFixed(2)].map((x) => AE.csvCell(x)).join(',')));
  out.push(['', '', '', '', '', '', '', '', '', '', '', '', '', '', 'Total', S.money(b.grandTotal).toFixed(2)].map((v) => AE.csvCell(v)).join(','));
  return { name: `${b.number}.csv`, type: 'text/csv; charset=utf-8', body: `﻿${out.join('\r\n')}\r\n` };
}

// the pay side (who is owed what for the approved weeks): a file for payroll / the vendors. Never sent into HRMS payroll.
async function payRegister(user, { from = null, to = null } = {}) {
  if (!K.seesPay(user)) return { error: 'The pay side is not for this login.', status: 403 };
  const C = await clientsInScope(user);
  const today = new Date().toISOString().slice(0, 10);
  const f = S.isDate(from) ? from : `${today.slice(0, 7)}-01`; const t = S.isDate(to) ? to : today;
  const rows = await T.rowsFor([...C.keys()], { status: 'Approved', from: f, to: t });
  const AE = S;
  const head = ['Contractor', 'Client', 'Role', 'Paid as', 'Week from', 'Week to', 'Regular hours', 'Overtime hours', 'Pay amount', 'Cost with load', 'Billed in'];
  const out = [head.map((h) => AE.csvCell(h)).join(',')];
  rows.forEach((r) => { const c = C.get(r.applicationId); out.push([c.name, c.client, c.requirement, c.payType || '', r.weekStart, S.addDays(r.weekStart, 6), Number(r.regHours) || 0, Number(r.otHours) || 0, S.money(r.payAmount).toFixed(2), S.money(r.costAmount).toFixed(2), r.batchId ? 'yes' : 'not yet'].map((v, i) => AE.csvCell(v, i < 6 || i === 10)).join(',')); });
  await require('../audit').logAudit({ userId: user.id, action: 'Contractor pay register exported', entity: 'StfTimesheet', entityId: 'pay-register', toValue: `${f} to ${t}: ${rows.length} weeks` }); // eslint-disable-line global-require
  return { name: `contractor-pay-${f}-to-${t}.csv`, type: 'text/csv; charset=utf-8', body: `﻿${out.join('\r\n')}\r\n` };
}

// ---- 06.11 / 14.08 the push ------------------------------------------------------------------------------------------------------
// teamlink: our own JSON. zoho-books: the body of Zoho Books' POST /invoices. xero: the body of Xero's PUT /Invoices.
function payloadOf(b, lines, tax, sac, kind) {
  const due = S.addDays(String(b.at || S.now()).slice(0, 10), 15);
  const item = (l) => ({ description: `${l.name} · ${l.role} · ${l.weekStart} to ${l.weekEnd} · ${l.regHours} h${l.otHours ? ` + ${l.otHours} h OT` : ''}`, amount: S.money(l.billAmount), po: l.poNumber || null });
  if (kind === 'zoho-books') {
    return { customer_name: b.clientName, reference_number: b.number, date: String(b.at || S.now()).slice(0, 10), due_date: due, gst_treatment: tax.gstin ? 'business_gst' : 'business_none', gst_no: tax.gstin || undefined, place_of_supply: tax.gstin ? tax.gstin.slice(0, 2) : undefined, notes: `TeamLink contract billing batch ${b.number}`, line_items: lines.map((l) => ({ name: 'Contract staffing', description: item(l).description, rate: item(l).amount, quantity: 1, hsn_or_sac: sac, tax_percentage: Number(b.gstPercent) || 0 })) };
  }
  if (kind === 'xero') {
    return { Invoices: [{ Type: 'ACCREC', Contact: { Name: b.clientName }, Reference: b.number, Date: String(b.at || S.now()).slice(0, 10), DueDate: due, Status: 'DRAFT', LineAmountTypes: 'Exclusive', LineItems: lines.map((l) => ({ Description: item(l).description, Quantity: 1, UnitAmount: item(l).amount, AccountCode: '200' })) }] };
  }
  return { kind: 'teamlink.contract_billing_batch', number: b.number, client: { id: b.clientId, name: b.clientName, gstin: tax.gstin || null }, period: { from: b.fromWeek, to: S.addDays(b.toWeek, 6) }, sac, currency: 'INR', lines: lines.map(item), subtotal: Number(b.billTotal) || 0, gst: { percent: Number(b.gstPercent) || 0, type: tax.kind, lines: tax.lines.map(([name, amount]) => ({ name, amount })) }, total: Number(b.grandTotal) || 0, dueDate: due };
}
const CHANNEL = 'accounting-push';
async function pushConfig() {
  const { readConfig } = require('../integrationStore'); // eslint-disable-line global-require
  const r = await readConfig(CHANNEL).catch(() => ({ values: {} }));
  const v = r.values || {};
  return {
    url: String(v['Endpoint URL'] || '').trim(), secret: String(v['Signing secret'] || ''), kind: (String(v['Payload (teamlink, zoho-books or xero)'] || 'teamlink').trim().toLowerCase()),
    zoho: { org: String(v['Zoho Books organization ID'] || '').trim(), clientId: String(v['Zoho client ID'] || '').trim(), secret: String(v['Zoho client secret'] || ''), refresh: String(v['Zoho refresh token'] || ''), dc: String(v['Zoho data centre (in, com, eu)'] || 'in').trim().toLowerCase() },
  };
}
function pushStatus(c) {
  const zoho = !!(c.zoho.org && c.zoho.clientId && c.zoho.secret && c.zoho.refresh);
  return { webhook: !!c.url, zoho, ready: !!c.url || zoho, kind: c.kind, state: !!c.url || zoho ? 'Set up' : 'Not set up: needs founder credentials (Administration > Integrations > Accounting push)' };
}
async function zohoPush(c, body) {
  const accounts = c.zoho.dc === 'stub' ? `${H.stubBase()}/zoho` : `https://accounts.zoho.${c.zoho.dc}`;
  const api = c.zoho.dc === 'stub' ? `${H.stubBase()}/zoho` : `https://www.zohoapis.${c.zoho.dc}`;
  const tok = await H.send(`${accounts}/oauth/v2/token`, { method: 'POST', form: { refresh_token: c.zoho.refresh, client_id: c.zoho.clientId, client_secret: c.zoho.secret, grant_type: 'refresh_token' } });
  if (!tok.ok || !tok.json || !tok.json.access_token) return { ok: false, status: tok.status, detail: `Zoho sign-in failed (HTTP ${tok.status})` };
  const h = { Authorization: `Zoho-oauthtoken ${tok.json.access_token}` };
  const found = await H.send(`${api}/books/v3/contacts?organization_id=${encodeURIComponent(c.zoho.org)}&contact_name=${encodeURIComponent(body.customer_name || '')}`, { headers: h });
  let contactId = found.json && Array.isArray(found.json.contacts) && found.json.contacts[0] ? found.json.contacts[0].contact_id : null;
  if (!contactId) {
    const made = await H.send(`${api}/books/v3/contacts?organization_id=${encodeURIComponent(c.zoho.org)}`, { method: 'POST', headers: h, body: { contact_name: body.customer_name, gst_treatment: body.gst_treatment, gst_no: body.gst_no } });
    contactId = made.json && made.json.contact ? made.json.contact.contact_id : null;
    if (!contactId) return { ok: false, status: made.status, detail: `Zoho could not find or add the customer (HTTP ${made.status})` };
  }
  const { customer_name: _cn, ...rest } = body;
  const inv = await H.send(`${api}/books/v3/invoices?organization_id=${encodeURIComponent(c.zoho.org)}`, { method: 'POST', headers: h, body: { ...rest, customer_id: contactId } });
  const no = inv.json && inv.json.invoice ? inv.json.invoice.invoice_number || inv.json.invoice.invoice_id : null;
  return inv.ok && no ? { ok: true, status: inv.status, detail: `Draft invoice ${no} made in Zoho Books` } : { ok: false, status: inv.status, detail: `Zoho Books refused the invoice (HTTP ${inv.status}${inv.json && inv.json.message ? `: ${String(inv.json.message).slice(0, 120)}` : ''})` };
}
async function push(user, id) {
  if (!mayBill(user)) return { error: 'An Admin, a team lead, a BDE TL or the accounts team sends batches.', status: 403 };
  const b = await batchOf(user, id);
  if (!b) return { error: 'Batch not found (or not in your scope).', status: 404 };
  if (b.status === 'Cancelled') return { error: 'A cancelled batch is not sent.', status: 409 };
  const c = await pushConfig();
  const st = pushStatus(c);
  if (!st.ready) return { error: 'Set up the accounting push first: Administration > Integrations > Accounting push (an address, or the Zoho Books keys).', status: 409, state: st.state };
  const lines = await batchLines(b);
  const tax = await gstSplit(b);
  const sac = (await S.setting('billing.sac')) || '998513';
  let r;
  try {
    if (st.zoho) r = await zohoPush(c, payloadOf(b, lines, tax, sac, 'zoho-books'));
    else {
      const kind = ['teamlink', 'zoho-books', 'xero'].includes(c.kind) ? c.kind : 'teamlink';
      const raw = JSON.stringify({ id: S.newId(), event: 'contract_billing.batch', at: S.now(), format: kind, data: payloadOf(b, lines, tax, sac, kind) });
      const sig = c.secret ? `sha256=${crypto.createHmac('sha256', c.secret).update(raw).digest('hex')}` : '';
      const res = await H.send(c.url, { method: 'POST', headers: { 'x-teamlink-event': 'contract_billing.batch', ...(sig ? { 'x-teamlink-signature': sig } : {}) }, body: raw });
      r = { ok: res.ok, status: res.status, detail: res.ok ? `Delivered to ${new URL(c.url).host} (HTTP ${res.status}, ${kind})` : `HTTP ${res.status}` };
    }
  } catch (e) { r = { ok: false, status: 0, detail: String(e.message || e).slice(0, 200) }; }
  await S.x('UPDATE "StfBatch" SET "pushedAt"=?,"pushResult"=?,"status"=? WHERE "id"=?', r.ok ? S.now() : b.pushedAt, r.detail.slice(0, 300), r.ok ? 'Sent to accounting' : b.status, b.id);
  await require('../integrationStore').recordEvent(CHANNEL, { action: `Batch ${b.number}`, by: user.name, result: r.ok ? r.detail : `Failed: ${r.detail}` }).catch(() => {}); // eslint-disable-line global-require
  await require('../audit').logAudit({ userId: user.id, action: r.ok ? 'Contract billing batch sent to accounting' : 'Contract billing batch send failed', entity: 'StfBatch', entityId: b.id, toValue: `${b.number}: ${r.detail}`.slice(0, 300) }); // eslint-disable-line global-require
  return r.ok ? { ok: true, result: r.detail } : { error: `Not sent: ${r.detail}`, status: 502 };
}

module.exports = { ACCOUNTS_BOUNDARY, BATCH_STATES, mayBill, auditMany, audit, explain, unbilled, createBatch, batches, batchDetail, cancelBatch, exportBatch, payRegister, push, pushConfig, pushStatus, payloadOf, CHANNEL };
