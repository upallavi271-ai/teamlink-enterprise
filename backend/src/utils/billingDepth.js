// ---------------------------------------------------------------------------
// BILLING DEPTH (founder ATS audit 2026-11-18: items 386 / 389 / 394 / 395 / 410).
//
//   Overdue reminders   a daily worker tells the invoice's owner BDE (Owner BDE / second BDE / the job's BDE) about an overdue invoice, once per
//                       invoice per 3 days. Optionally (second switch) it also mails the client's finance contact. Both switches are OFF: Admin turns
//                       them on (AppSetting "billing.overdueReminders"). Sandbox: mail is the fake transport.
//   Profitability       per client: fee billed (net of credit notes), recruiter incentive, partner payout (the existing placement margin) and, when the
//                       HRMS has the recruiter's salary, the recruiter's salary cost: each recruiter's monthly salary (annual CTC / 12) is split equally
//                       over the placements credited to them that month, so what is shown is the cost of the people who actually produced the fee.
//   Payment approval    switch OFF. ON: a receipt recorded by an Accountant waits as "Pending approval"; an Admin or ANOTHER Accountant approves (or
//                       rejects with a reason) and only then is the receipt written. The person who recorded cannot approve it. An Admin's own receipt
//                       is recorded at once. Table "PaymentApproval".
//   Freelancer report   per Freelancer / Agency partner: submissions, joined, revenue (fee on the invoices of their joinings) vs cost (partner payouts).
// Raw tables, created on first use (no migration).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const { logAudit } = require('./audit');

let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      const ddl = [
        'CREATE TABLE IF NOT EXISTS "OverdueReminderLog" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "invoiceId" TEXT NOT NULL, "kind" TEXT NOT NULL, "to" TEXT, "at" TEXT NOT NULL)',
        'CREATE INDEX IF NOT EXISTS "OverdueReminderLog_inv" ON "OverdueReminderLog" ("invoiceId","kind","at")',
        `CREATE TABLE IF NOT EXISTS "PaymentApproval" ("id" TEXT PRIMARY KEY, "invoiceId" TEXT NOT NULL, "amount" REAL NOT NULL, "date" TEXT NOT NULL, "method" TEXT, "reference" TEXT, "notes" TEXT,
          "state" TEXT NOT NULL DEFAULT 'Pending', "requestedById" TEXT, "requestedByName" TEXT, "requestedAt" TEXT NOT NULL, "decidedById" TEXT, "decidedByName" TEXT, "decidedAt" TEXT, "reason" TEXT, "paymentId" TEXT)`,
        'CREATE INDEX IF NOT EXISTS "PaymentApproval_state" ON "PaymentApproval" ("state")',
      ];
      for (const s of ddl) await prisma.$executeRawUnsafe(s); // eslint-disable-line no-await-in-loop
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}
const now = () => new Date().toISOString();
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const isAdmin = (u) => ['SUPER_ADMIN', 'ADMIN'].includes(u && u.role);

// ------------------------------------------------------------------ settings
const KEYS = { overdue: { key: 'billing.overdueReminders', def: { enabled: false, client: false, everyDays: 3 } }, approval: { key: 'billing.paymentApproval', def: { enabled: false } } };
async function getSetting(name) {
  let v = { ...KEYS[name].def };
  try { const row = await prisma.appSetting.findUnique({ where: { key: KEYS[name].key } }); if (row) v = { ...v, ...JSON.parse(row.value) }; } catch { /* default */ }
  return v;
}
async function setSetting(name, patch, user) {
  const before = await getSetting(name);
  const v = { ...before, ...patch };
  await prisma.appSetting.upsert({ where: { key: KEYS[name].key }, create: { key: KEYS[name].key, value: JSON.stringify(v), updatedById: user.id, updatedByName: user.name }, update: { value: JSON.stringify(v), updatedById: user.id, updatedByName: user.name } });
  return { before, after: v };
}

// ------------------------------------------------------------------ overdue reminders (386)
const outstandingOf = (i) => Math.max(0, r2(Number(i.amount || 0) + Number(i.gst || 0) - Number(i.tds || 0) - Number(i.receivedAmount || 0) - Number(i.creditedAmount || 0) - Number(i.adjustedAmount || 0) + Number(i.debitedAmount || 0)));
const inr = (n) => `Rs. ${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
async function clientMailTo(clientId) {
  const CD = require('./clientDepth'); // eslint-disable-line global-require
  const fin = (await CD.listContacts(clientId, 'full')).find((c) => c.role === 'Finance' && c.email);
  if (fin) return { email: fin.email, name: fin.name };
  const c = await prisma.client.findUnique({ where: { id: clientId }, select: { billingContactEmail: true, billingContactName: true, contactEmail: true, contactName: true } });
  if (!c) return null;
  if (c.billingContactEmail) return { email: c.billingContactEmail, name: c.billingContactName };
  return c.contactEmail ? { email: c.contactEmail, name: c.contactName } : null;
}
// -> { enabled, checked, owner: [..], client: [..] }. dryRun lists who would be told and changes nothing.
async function runOverdueReminders({ dryRun = false, force = false } = {}) {
  await ensure();
  const s = await getSetting('overdue');
  const out = { enabled: !!s.enabled, checked: 0, owner: [], client: [], skipped: 0 };
  if (!s.enabled && !force) return out;
  const everyMs = Math.max(1, Number(s.everyDays) || 3) * 86400000 - 3600000; // a little under N days: a daily run never skips a due one
  const today = todayIst();
  const list = await prisma.invoice.findMany({
    where: { status: { notIn: ['Cancelled', 'Paid'] }, dueDate: { lt: today } },
    include: { client: { select: { id: true, name: true, bdeOwner: true, secondaryBde: true } }, requirement: { select: { bdeId: true, title: true } } },
  });
  const BD = require('./clientBdes'); // eslint-disable-line global-require
  const { notifyUsers } = require('./notify'); // eslint-disable-line global-require
  for (const inv of list) {
    const owing = outstandingOf(inv);
    if (owing <= 0.5) continue;
    out.checked += 1;
    const days = Math.round((new Date(`${today}T00:00:00Z`) - new Date(`${inv.dueDate}T00:00:00Z`)) / 86400000);
    const since = new Date(Date.now() - everyMs).toISOString();
    for (const kind of ['owner', 'client']) {
      if (kind === 'client' && !s.client) continue;
      // eslint-disable-next-line no-await-in-loop
      const [recent] = await prisma.$queryRawUnsafe('SELECT "id" FROM "OverdueReminderLog" WHERE "invoiceId" = ? AND "kind" = ? AND "at" > ? LIMIT 1', inv.id, kind, since);
      if (recent) { out.skipped += 1; continue; }
      const label = `${inv.invoiceNumber || 'Invoice'} (${inv.client ? inv.client.name : 'client'})`;
      if (kind === 'owner') {
        // eslint-disable-next-line no-await-in-loop
        const ids = await BD.ownerBdeIds({ bdeId: inv.requirement && inv.requirement.bdeId, clientId: inv.clientId, client: inv.client });
        if (!ids.length) continue;
        out.owner.push({ invoice: label, days, owing, to: ids.length });
        if (dryRun) continue;
        // eslint-disable-next-line no-await-in-loop
        await notifyUsers(ids, { title: `Payment overdue: ${label}`, message: `${inr(owing)} was due on ${inv.dueDate} (${days} day${days === 1 ? '' : 's'} ago). Please follow up with the client.` });
        // eslint-disable-next-line no-await-in-loop
        await prisma.$executeRawUnsafe('INSERT INTO "OverdueReminderLog" ("invoiceId","kind","to","at") VALUES (?,?,?,?)', inv.id, 'owner', ids.join(','), now());
      } else {
        // eslint-disable-next-line no-await-in-loop
        const to = await clientMailTo(inv.clientId);
        if (!to || !to.email) continue;
        out.client.push({ invoice: label, days, owing, to: to.email });
        if (dryRun) continue;
        // eslint-disable-next-line no-await-in-loop
        const r = await require('./mailer').sendMail({ // eslint-disable-line global-require
          to: to.email, subject: `Payment reminder: invoice ${inv.invoiceNumber || ''}`.trim(),
          text: `Dear ${to.name || 'Sir / Madam'},\n\nThis is a gentle reminder that ${inr(owing)} against invoice ${inv.invoiceNumber || ''} was due on ${inv.dueDate}. Please arrange the payment or let us know when to expect it. If you have already paid, kindly share the payment details.\n\nThank you,\nTeamLink Consultants`,
          useEmployeeFrom: false, fromName: 'TeamLink Consultants',
        }).catch((e) => ({ ok: false, error: e.message }));
        // eslint-disable-next-line no-await-in-loop
        await prisma.$executeRawUnsafe('INSERT INTO "OverdueReminderLog" ("invoiceId","kind","to","at") VALUES (?,?,?,?)', inv.id, 'client', `${to.email}${r && r.ok === false ? ' (not sent)' : ''}`, now());
      }
    }
  }
  if (!dryRun && (out.owner.length || out.client.length)) await logAudit({ action: 'Overdue payment reminders sent', entity: 'Invoice', entityId: 'overdue-reminders', toValue: `${out.owner.length} to owner BDEs, ${out.client.length} to clients` }).catch(() => null);
  return out;
}
let sweepTimer = null;
function startSweep() {
  if (sweepTimer || require('./sandbox').isSandbox()) return; // eslint-disable-line global-require
  const tick = () => runOverdueReminders().catch((e) => console.error('[overdue reminders]', e.message)); // eslint-disable-line no-console
  sweepTimer = setInterval(tick, 6 * 3600000);
  if (sweepTimer.unref) sweepTimer.unref();
  setTimeout(tick, 120000).unref?.();
  const renew = () => require('./clientDepth').runRenewalReminders().catch((e) => console.error('[renewal reminders]', e.message)); // eslint-disable-line no-console, global-require
  setInterval(renew, 6 * 3600000).unref?.();
}

// ------------------------------------------------------------------ profitability (389)
async function clientProfitability(user, { from, to } = {}) {
  const CN = require('./creditNotes'); // eslint-disable-line global-require
  const { rows } = await CN.marginRows(user);
  const inRange = rows.filter((r) => (!from || String(r.invoiceDate) >= from) && (!to || String(r.invoiceDate) <= to));
  // salary cost: HRMS annual CTC / 12 per recruiter, split over that recruiter's placements of the month
  const emps = await prisma.employee.findMany({ where: { salaryStructure: { isNot: null } }, select: { name: true, salaryStructure: { select: { ctc: true } } } }).catch(() => []);
  const monthly = new Map(emps.filter((e) => e.salaryStructure && Number(e.salaryStructure.ctc) > 0).map((e) => [String(e.name).trim().toLowerCase(), Number(e.salaryStructure.ctc) / 12]));
  const perRecruiterMonth = new Map();
  inRange.forEach((r) => { if (r.recruiter && monthly.has(String(r.recruiter).trim().toLowerCase())) { const k = `${String(r.recruiter).trim().toLowerCase()}|${r.month}`; perRecruiterMonth.set(k, (perRecruiterMonth.get(k) || 0) + 1); } });
  const by = new Map();
  inRange.forEach((r) => {
    const g = by.get(r.clientId) || { clientId: r.clientId, client: r.client, placements: 0, fee: 0, net: 0, incentive: 0, payout: 0, recruiterCost: 0, salaryKnown: 0 };
    g.placements += 1; g.fee += r.fee; g.net += r.net; g.incentive += r.incentive; g.payout += r.payout;
    const key = r.recruiter ? `${String(r.recruiter).trim().toLowerCase()}|${r.month}` : null;
    if (key && perRecruiterMonth.has(key)) { g.recruiterCost += monthly.get(String(r.recruiter).trim().toLowerCase()) / perRecruiterMonth.get(key); g.salaryKnown += 1; }
    by.set(r.clientId, g);
  });
  const list = [...by.values()].map((g) => {
    const margin = r2(g.net - g.incentive - g.payout);
    const withSalary = g.salaryKnown > 0 ? r2(margin - g.recruiterCost) : null;
    return { ...g, fee: r2(g.fee), net: r2(g.net), incentive: r2(g.incentive), payout: r2(g.payout), margin, recruiterCost: g.salaryKnown ? r2(g.recruiterCost) : null, marginAfterSalary: withSalary, marginPct: g.net > 0 ? Math.round(((withSalary == null ? margin : withSalary) / g.net) * 1000) / 10 : null, salaryCoverage: `${g.salaryKnown} of ${g.placements} placements` };
  }).sort((a, b) => b.net - a.net);
  const tot = (k) => r2(list.reduce((s, g) => s + (g[k] || 0), 0));
  return { rows: list, totals: { placements: list.reduce((s, g) => s + g.placements, 0), net: tot('net'), incentive: tot('incentive'), payout: tot('payout'), margin: tot('margin'), recruiterCost: tot('recruiterCost'), marginAfterSalary: tot('marginAfterSalary') }, salaryNote: 'Recruiter cost = the recruiter\'s monthly salary from the HRMS, split equally over the placements credited to them that month. Shown only where the HRMS has the salary.' };
}

// ------------------------------------------------------------------ payment approval (394)
const approvalOn = async () => !!(await getSetting('approval')).enabled;
// Does THIS login's receipt wait? (Admin / Super Admin never wait.)
async function mustWait(user) { return (await approvalOn()) && !isAdmin(user); }
async function requestPayment(invoice, d, user) {
  await ensure();
  const id = `pa${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
  await prisma.$executeRawUnsafe('INSERT INTO "PaymentApproval" ("id","invoiceId","amount","date","method","reference","notes","requestedById","requestedByName","requestedAt") VALUES (?,?,?,?,?,?,?,?,?,?)',
    id, invoice.id, d.amount, d.date, d.method || 'Bank Transfer', d.reference || null, d.notes || null, user.id, user.name, now());
  return id;
}
async function listApprovals(state) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "PaymentApproval" ${state ? 'WHERE "state" = ?' : ''} ORDER BY "requestedAt" DESC LIMIT 300`, ...(state ? [state] : []));
  const invs = await prisma.invoice.findMany({ where: { id: { in: rows.map((r) => r.invoiceId) } }, select: { id: true, invoiceNumber: true, client: { select: { name: true } } } });
  const m = new Map(invs.map((i) => [i.id, i]));
  return rows.map((r) => ({ ...r, amount: Number(r.amount), invoiceNumber: m.get(r.invoiceId) && m.get(r.invoiceId).invoiceNumber, client: m.get(r.invoiceId) && m.get(r.invoiceId).client && m.get(r.invoiceId).client.name }));
}
// Approve: the receipt is written by the same rules as POST /invoices/:id/payments. -> { ok, payment } | { error, status }
async function approve(id, user) {
  await ensure();
  const [a] = await prisma.$queryRawUnsafe('SELECT * FROM "PaymentApproval" WHERE "id" = ?', String(id));
  if (!a) return { error: 'Not found', status: 404 };
  if (a.state !== 'Pending') return { error: `This receipt was already ${a.state.toLowerCase()}.`, status: 409 };
  if (a.requestedById === user.id) return { error: 'You recorded this receipt, so someone else has to approve it.', status: 403 };
  const AC = require('./accounts'); // eslint-disable-line global-require
  const invoice = await prisma.invoice.findUnique({ where: { id: a.invoiceId } });
  if (!invoice) return { error: 'The invoice is gone.', status: 404 };
  const problem = AC.receiptProblem(invoice, Number(a.amount));
  if (problem) return { error: `It can no longer be recorded: ${problem}`, status: 409 };
  const payment = await prisma.invoicePayment.create({ data: { invoiceId: invoice.id, date: a.date, dateSource: 'entered', amount: Number(a.amount), method: a.method || 'Bank Transfer', reference: a.reference, notes: a.notes, recordedBy: a.requestedByName } });
  await prisma.invoice.update({ where: { id: invoice.id }, data: AC.invoiceAfterReceipt(invoice, Number(a.amount), a.date) });
  await prisma.$executeRawUnsafe('UPDATE "PaymentApproval" SET "state"=\'Approved\',"decidedById"=?,"decidedByName"=?,"decidedAt"=?,"paymentId"=? WHERE "id"=?', user.id, user.name, now(), payment.id, a.id);
  await logAudit({ userId: user.id, action: 'Payment approved and recorded', entity: 'Invoice', entityId: invoice.id, toValue: `Rs. ${a.amount} (recorded by ${a.requestedByName})` });
  return { ok: true, payment };
}
async function reject(id, user, reason) {
  await ensure();
  const [a] = await prisma.$queryRawUnsafe('SELECT * FROM "PaymentApproval" WHERE "id" = ?', String(id));
  if (!a) return { error: 'Not found', status: 404 };
  if (a.state !== 'Pending') return { error: `This receipt was already ${a.state.toLowerCase()}.`, status: 409 };
  if (!String(reason || '').trim()) return { error: 'Say why it is rejected.', status: 400 };
  await prisma.$executeRawUnsafe('UPDATE "PaymentApproval" SET "state"=\'Rejected\',"decidedById"=?,"decidedByName"=?,"decidedAt"=?,"reason"=? WHERE "id"=?', user.id, user.name, now(), String(reason).trim().slice(0, 300), a.id);
  await logAudit({ userId: user.id, action: 'Payment rejected', entity: 'Invoice', entityId: a.invoiceId, toValue: `Rs. ${a.amount}: ${String(reason).trim().slice(0, 200)}` });
  return { ok: true };
}

// ------------------------------------------------------------------ freelancer revenue vs cost (410)
async function freelancerReport({ type } = {}) {
  const partners = await prisma.partner.findMany({ where: type && ['Freelancer', 'Agency'].includes(type) ? { type } : {}, select: { id: true, code: true, name: true, type: true, status: true } });
  if (!partners.length) return { rows: [], totals: { submissions: 0, joined: 0, revenue: 0, cost: 0, margin: 0 } };
  const subs = await prisma.partnerSubmission.findMany({ where: { partnerId: { in: partners.map((p) => p.id) } }, select: { partnerId: true, status: true, applicationId: true } });
  const apps = await prisma.application.findMany({ where: { id: { in: subs.map((s) => s.applicationId).filter(Boolean) } }, select: { id: true, candidateId: true, requirementId: true } });
  const invoices = apps.length ? await prisma.invoice.findMany({ where: { status: { not: 'Cancelled' }, OR: apps.map((a) => ({ candidateId: a.candidateId, requirementId: a.requirementId })) }, select: { candidateId: true, requirementId: true, amount: true } }) : [];
  const payouts = await prisma.partnerPayout.findMany({ where: { partnerId: { in: partners.map((p) => p.id) }, status: { not: 'Cancelled' } }, select: { partnerId: true, fee: true, status: true } });
  const rows = partners.map((p) => {
    const mine = subs.filter((s) => s.partnerId === p.id);
    const myApps = mine.map((s) => apps.find((a) => a.id === s.applicationId)).filter(Boolean);
    const revenue = r2(myApps.reduce((sum, a) => sum + invoices.filter((i) => i.candidateId === a.candidateId && i.requirementId === a.requirementId).reduce((x, i) => x + Number(i.amount || 0), 0), 0));
    const cost = r2(payouts.filter((x) => x.partnerId === p.id).reduce((sum, x) => sum + Number(x.fee || 0), 0));
    return { partnerId: p.id, code: p.code, name: p.name, type: p.type, status: p.status, submissions: mine.length, joined: mine.filter((s) => s.status === 'Joined').length, revenue, cost, margin: r2(revenue - cost), marginPct: revenue > 0 ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : null };
  }).sort((a, b) => b.revenue - a.revenue);
  const t = (k) => r2(rows.reduce((s, r) => s + r[k], 0));
  return { rows, totals: { submissions: rows.reduce((s, r) => s + r.submissions, 0), joined: rows.reduce((s, r) => s + r.joined, 0), revenue: t('revenue'), cost: t('cost'), margin: t('margin') } };
}

module.exports = {
  ensure, getSetting, setSetting, runOverdueReminders, startSweep, clientProfitability, approvalOn, mustWait, requestPayment, listApprovals, approve, reject, freelancerReport, isAdmin,
};
