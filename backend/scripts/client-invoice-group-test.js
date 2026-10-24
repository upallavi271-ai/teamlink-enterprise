#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ONE CLIENT = ONE ROW (Accounts, 2026-10-14). SANDBOX ONLY:
//   cd backend && TL_API=http://localhost:4011 node scripts/client-invoice-group-test.js
// A client invoice is the group of one client's candidate invoices that share a base number and
// a date (TY26-072, TY26-072-1, TY26-072-2). Nothing is merged in the database. This checks the
// grouping (frontend + backend agree), the derived totals / status, candidates by joining date,
// ONE payment across the candidate rows (exact, idempotent, never over-allocated), bank
// allocation still consistent, a new candidate joining the existing client invoice, the filters,
// the Excel sheet, the one-document invoice (all candidates), the print template (contrast,
// borders, A4), the joining-date edit, role access, and a READ-ONLY reconciliation on a
// VACUUM copy of the real database (counts and every money total before vs after).
// Everything made is tagged "ZZTEST CI" and removed at the end. The real dev.db is only ever
// opened read-only to make the copy.
// ---------------------------------------------------------------------------
const path = require('path');
const os = require('os');
const fs = require('fs');
const Z = require('./lib/zzfix')('CI');

const { prisma, call, check } = Z;
const FE = path.resolve(Z.BACK, '..', 'frontend');
const CI = require('../src/utils/clientInvoice');
const ACC = require('../src/utils/accounts');
const R2 = (n) => Math.round(Number(n) * 100) / 100;
const P = (n) => Math.round(Number(n) * 100);

function bundle(rel, name) {
  const esb = require(path.join(FE, 'node_modules', 'esbuild'));
  const out = path.join(os.tmpdir(), `zzci-${Z.RUN}-${name}.cjs`);
  esb.buildSync({ entryPoints: [path.join(FE, rel)], bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'error' });
  return require(out);
}

(async () => {
  await Z.preclean();
  const made = { txns: [], accounts: [] };
  let copyFile = null;
  try {
    const G = bundle('src/pages/invoices/clientInvoice.js', 'group');
    const F = bundle('src/pages/invoices/invFilters.js', 'filters');
    const D = bundle('src/pages/invoices/invoiceDoc.js', 'doc');

    const admin = await Z.mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN', accountsAccess: true, accountsRole: 'ADMIN' }, {});
    const mgr = await Z.mkUser('mgr', { role: 'MANAGER', atsRole: 'MANAGER', accountsAccess: true, accountsRole: 'MANAGER' }, {});
    const rec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', accountsAccess: false }, {});
    const T = await Z.mint(admin);
    const TM = await Z.mint(mgr);
    const TR = await Z.mint(rec);

    // ------------------------------------------------------------------ A. pure rules
    check('A1 base number: the "-n" candidate suffix is dropped, a plain number is its own base',
      CI.baseNumber('TY26-072-2') === 'TY26-072' && CI.baseNumber('TY26-072') === 'TY26-072' && CI.baseNumber('1830-1') === '1830' && CI.baseNumber('INV-2026-0001') === 'INV-2026-0001'
      && G.baseNumber('TY26-072-12') === 'TY26-072' && G.baseNumber('INV-2026-0001') === 'INV-2026-0001', [CI.baseNumber('TY26-072-2'), CI.baseNumber('INV-2026-0001')]);

    // payment split: property test
    let bad = 0;
    for (let t = 0; t < 400; t += 1) {
      const n = 1 + Math.floor(Math.random() * 6);
      const lines = Array.from({ length: n }, (_, i) => ({ id: `L${i}`, outstanding: R2(Math.random() * 90000 + (Math.random() < 0.15 ? 0 : 1)) }));
      const owed = lines.reduce((s, l) => s + P(l.outstanding), 0);
      const want = Math.max(1, Math.floor(Math.random() * owed)) / 100;
      const a = CI.allocatePayment(lines, want);
      const a2 = CI.allocatePayment(lines, want);
      if (a.error) { bad += 1; continue; }
      const sum = a.parts.reduce((s, p) => s + P(p.amount), 0);
      const over = a.parts.some((p) => P(p.amount) > P(lines.find((l) => l.id === p.id).outstanding));
      if (sum !== P(want) || over || JSON.stringify(a) !== JSON.stringify(a2)) bad += 1;
    }
    check('A2 allocation: 400 random splits add up to the paisa, never exceed a line, and repeat identically', bad === 0, bad);
    const tiny = CI.allocatePayment([{ id: 'a', outstanding: 33.34 }, { id: 'b', outstanding: 33.33 }, { id: 'c', outstanding: 33.33 }], 100);
    check('A3 allocation: 100.00 over 33.34 / 33.33 / 33.33 = 33.34 + 33.33 + 33.33 (full, exact)', tiny.parts.map((p) => p.amount).join() === '33.34,33.33,33.33', tiny);
    const part = CI.allocatePayment([{ id: 'a', outstanding: 100 }, { id: 'b', outstanding: 50 }, { id: 'c', outstanding: 25 }], 0.05);
    check('A4 allocation: a tiny payment never splits into zeros - the paise land on the last line that can take them', part.parts.reduce((s, p) => s + P(p.amount), 0) === 5 && part.parts.every((p) => p.amount > 0), part);
    const over = CI.allocatePayment([{ id: 'a', outstanding: 10 }, { id: 'b', outstanding: 10 }], 20.6);
    check('A5 allocation: more than owed (beyond the 0.50 the single rule allows) is refused; within 0.50 it is capped', !!over.error && !CI.allocatePayment([{ id: 'a', outstanding: 10 }], 10.4).error && CI.allocatePayment([{ id: 'a', outstanding: 10 }], 10.4).total === 10, [over, CI.allocatePayment([{ id: 'a', outstanding: 10 }], 10.4)]);

    // ------------------------------------------------------------------ B. fixtures
    const clientA = await prisma.client.create({ data: { name: `ZZTEST CI A ${Z.RUN}`, ownerDepartment: 'Medical', gstPercent: 18, tdsPercent: 10 } });
    const clientB = await prisma.client.create({ data: { name: `ZZTEST CI B ${Z.RUN}`, ownerDepartment: 'Education', gstPercent: 0, tdsPercent: 0 } });
    Z.made.clients.push(clientA.id, clientB.id);
    const num = `ZZCI9${Date.now() % 1000000}`; // ends in a digit so "-1" reads as a suffix
    const mkCand = async (nm) => { const c = await prisma.candidate.create({ data: { name: `ZZTEST CI ${nm} ${Z.RUN}` } }); Z.made.cands.push(c.id); return c; };
    const cz = await mkCand('Zed'); const cy = await mkCand('Yan'); const cx = await mkCand('Xia'); const cw = await mkCand('Wen');
    const mk = (clientId, no, amount, gst, tds, extra = {}) => prisma.invoice.create({
      data: { clientId, invoiceNumber: no, amount, gst, tds, invoiceDate: '2026-09-01', dueDate: '2026-09-30', status: 'Pending', ...extra },
    });
    // three candidates on one client invoice, joined 20 / 5 / 12 Aug (so NOT in number order)
    const i0 = await mk(clientA.id, num, 30000, 5400, 3000, { candidateId: cz.id, joiningDate: '2026-08-20', offeredCtc: 360000, feePercent: 8.33 });
    const i1 = await mk(clientA.id, `${num}-1`, 20000, 3600, 2000, { candidateId: cy.id, joiningDate: '2026-08-05', offeredCtc: 240000 });
    const i2 = await mk(clientA.id, `${num}-2`, 10000.01, 1800, 1000, { candidateId: cx.id, joiningDate: '2026-08-12' });
    // a single-candidate invoice of the same client (other number) and another client with the SAME base text
    const s0 = await mk(clientA.id, `${num}9`, 5000, 0, 0, { candidateId: cw.id });
    const b0 = await mk(clientB.id, `${num}-7`, 7000, 0, 0);
    const ids3 = [i0.id, i1.id, i2.id];

    const regAll = async (T0 = T) => (await call('GET', '/api/invoices/register?period=all', T0)).body;
    let reg = await regAll();
    let rows = reg.rows;
    let index = G.groupIndex(rows);
    let groups = G.buildClientInvoices(rows, index);
    const gA = groups.find((g) => g.ids.includes(i0.id));
    check('G1 three candidate invoices of one client + base number are ONE client invoice; a suffixed number at ANOTHER client is a different client invoice', gA && gA.members.length === 3 && gA.no === num && groups.filter((g) => g.clientId === clientB.id).length === 1 && groups.filter((g) => g.clientId === clientA.id).length === 2, gA && [gA.members.length, gA.no]);
    check('G2 the displayed number is the BASE number; candidate numbers (-1, -2) are kept as references on the lines', gA.invoiceNumber === num && gA.members.map((m) => m.invoiceNumber).sort().join() === [num, `${num}-1`, `${num}-2`].sort().join(), gA.members.map((m) => m.invoiceNumber));
    check('G3 backend grouping == frontend grouping (same groups, same numbers) on the whole sandbox register',
      (() => { const bg = CI.groupInvoices(rows); return bg.length === groups.length && bg.every((x) => { const f = groups.find((g) => g.ids.length === x.members.length && g.ids.every((id) => x.members.some((m) => m.id === id))); return f && String(f.no) === String(x.no); }); })(), [CI.groupInvoices(rows).length, groups.length]);
    const sumRows = (list, k) => R2(list.reduce((s, r) => s + r[k], 0));
    const mem = gA.members;
    check('G4 every money figure of the client invoice is the plain SUM of its candidate rows (before GST, GST, after GST, TDS, receivable, received, pending)',
      ['billing', 'gst', 'invoiceValue', 'tds', 'receivable', 'received', 'pending'].every((k) => gA[k] === sumRows(mem, k)) && gA.billing === 60000.01 && gA.gst === 10800 && gA.tds === 6000, ['billing', 'gst', 'invoiceValue', 'tds', 'receivable', 'received', 'pending'].map((k) => [k, gA[k], sumRows(mem, k)]));
    check('G5 candidates are listed by date of joining, earliest first (5 Aug, 12 Aug, 20 Aug), not by invoice number', gA.members.map((m) => m.joiningDate).join() === '2026-08-05,2026-08-12,2026-08-20', gA.members.map((m) => m.joiningDate));
    check('G6 status is derived: nothing received = Pending (late = Overdue), Paid only when every line is paid', gA.status === 'Overdue' || gA.status === 'Pending', gA.status);
    const stat = (arr) => G.groupStatus(arr);
    check('G7 status rules: all paid = Paid; any money = Partially Paid; none and one late = Overdue; none = Pending',
      stat([{ status: 'Paid', received: 5 }, { status: 'Paid', received: 5 }]) === 'Paid' && stat([{ status: 'Paid', received: 5 }, { status: 'Pending', received: 0 }]) === 'Partially Paid'
      && stat([{ status: 'Pending', received: 0 }, { status: 'Overdue', received: 0 }]) === 'Overdue' && stat([{ status: 'Pending', received: 0 }]) === 'Pending' && stat([{ status: 'Cancelled', received: 0 }]) === 'Cancelled', 'x');
    check('G8 the backend summary agrees with the frontend one', JSON.stringify(['billing', 'gst', 'invoiceValue', 'tds', 'receivable', 'received', 'pending'].map((k) => CI.groupSummary(mem)[k])) === JSON.stringify(['billing', 'gst', 'invoiceValue', 'tds', 'receivable', 'received', 'pending'].map((k) => gA[k])) && CI.groupSummary(mem).status === gA.status, 'x');

    // the same client + base number on a LATER date (an Excel split that reused the base number)
    const d0 = await mk(clientB.id, `${num}-8`, 1000, 0, 0, { invoiceDate: '2026-09-15', dueDate: '2026-10-15' });
    const d1 = await mk(clientB.id, `${num}-9`, 1000, 0, 0, { invoiceDate: '2026-09-01' });
    reg = await regAll(); rows = reg.rows; index = G.groupIndex(rows); groups = G.buildClientInvoices(rows, index);
    const gB = groups.filter((g) => g.clientId === clientB.id);
    check('G9 same client + base number on two dates = two rows with DIFFERENT numbers (the earlier keeps the base, the later its own lowest number)', gB.length === 2 && gB.map((g) => g.no).sort().join() === [num, `${num}-8`].sort().join() && gB.find((g) => g.no === num).invoiceDate === '2026-09-01' && gB.find((g) => g.no === num).members.length === 2, gB.map((g) => [g.no, g.invoiceDate, g.members.length]));
    check('G10 the number of a row does not change when a filter hides some of its candidates', (() => { const sub = rows.filter((r) => r.candidateName !== `ZZTEST CI Zed ${Z.RUN}`); const g2 = G.buildClientInvoices(sub, index).find((g) => g.ids.includes(i1.id)); return g2 && g2.no === num && g2.hiddenByFilters === 1 && g2.members.length === 2; })(), 'x');

    // ------------------------------------------------------------------ C. ONE payment across the rows
    const pay = (body, T0 = T) => call('POST', '/api/invoices/group/payments', T0, body);
    const key1 = `zzci${Z.RUN}a1`;
    const p1 = await pay({ invoiceIds: ids3, amount: 10000.01, date: '2026-10-05', method: 'Bank Transfer', reference: 'ZZCI-REF-1', key: key1 });
    check('C1 one payment of 10,000.01 on the client invoice is accepted (201) and split over its candidate rows', p1.status === 201 && p1.body.total === 10000.01 && p1.body.payments.length >= 2, [p1.status, p1.body]);
    const paySum = R2(p1.body.payments.reduce((s, x) => s + x.amount, 0));
    check('C2 the parts add up to the amount to the paisa, and no part exceeds what its line owed', paySum === 10000.01 && p1.body.payments.every((x) => { const m = mem.find((r) => r.id === x.invoiceId); return P(x.amount) <= P(m.pending); }), p1.body.payments);
    const dbPays = await prisma.invoicePayment.findMany({ where: { invoiceId: { in: ids3 } } });
    const dbInv = await prisma.invoice.findMany({ where: { id: { in: ids3 } } });
    check('C3 each underlying invoice has its OWN ordinary receipt (date = the date typed, mode, reference), and its received amount equals its receipts',
      dbPays.length === p1.body.payments.length && dbPays.every((x) => x.date === '2026-10-05' && x.method === 'Bank Transfer' && x.reference === 'ZZCI-REF-1' && x.dateSource === 'entered') && dbInv.every((i) => R2(i.receivedAmount) === R2(dbPays.filter((x) => x.invoiceId === i.id).reduce((s, x) => s + x.amount, 0))), [dbPays.length]);
    const inv1 = await prisma.invoice.findMany({ where: { id: { in: ids3 } } });
    check('C4 not yet fully paid -> every line Partially Paid (or untouched), none Paid; the 0.01 rounding paisa went to a real line', inv1.every((i) => i.status !== 'Paid') && R2(inv1.reduce((s, i) => s + i.receivedAmount, 0)) === 10000.01, inv1.map((i) => [i.invoiceNumber, i.receivedAmount, i.status]));
    // idempotent
    const pDup = await pay({ invoiceIds: ids3, amount: 10000.01, date: '2026-10-05', method: 'Bank Transfer', reference: 'ZZCI-REF-1', key: key1 });
    const nAfter = await prisma.invoicePayment.count({ where: { invoiceId: { in: ids3 } } });
    const recvAfter = R2((await prisma.invoice.findMany({ where: { id: { in: ids3 } } })).reduce((s, i) => s + i.receivedAmount, 0));
    check('C5 sending the same payment key again writes NOTHING (200, duplicate, same parts)', pDup.status === 200 && pDup.body.duplicate === true && nAfter === dbPays.length && recvAfter === 10000.01 && pDup.body.total === 10000.01, [pDup.status, pDup.body, nAfter, recvAfter]);
    // the register / merged display
    reg = await regAll(); rows = reg.rows; index = G.groupIndex(rows); groups = G.buildClientInvoices(rows, index);
    const gA2 = groups.find((g) => g.ids.includes(i0.id));
    check('C6 the client invoice shows received 10,000.01 and pending = receivable - 10,000.01, status Partially Paid', gA2.received === 10000.01 && gA2.pending === R2(gA.receivable - 10000.01) && gA2.status === 'Partially Paid', [gA2.received, gA2.pending, gA2.status]);
    check('C7 the payments list shows ONE payment (not one per candidate line), with its date, mode and reference', gA2.payments.length === 1 && gA2.payments[0].amount === 10000.01 && gA2.payments[0].date === '2026-10-05' && gA2.payments[0].reference === 'ZZCI-REF-1' && gA2.payments[0].lines === p1.body.payments.length, gA2.payments);
    // bad requests
    const k = (s) => `zzci${Z.RUN}${s}`;
    const cases = [
      ['more than the balance', { invoiceIds: ids3, amount: gA2.pending + 5, date: '2026-10-06', key: k('o1') }],
      ['no date', { invoiceIds: ids3, amount: 10, key: k('o2') }],
      ['future date', { invoiceIds: ids3, amount: 10, date: '2999-01-01', key: k('o3') }],
      ['no key', { invoiceIds: ids3, amount: 10, date: '2026-10-06' }],
      ['two clients', { invoiceIds: [i0.id, b0.id], amount: 10, date: '2026-10-06', key: k('o4') }],
      ['not one client invoice (different numbers)', { invoiceIds: [i0.id, s0.id], amount: 10, date: '2026-10-06', key: k('o5') }],
      ['zero', { invoiceIds: ids3, amount: 0, date: '2026-10-06', key: k('o6') }],
    ];
    const bads = [];
    for (const [name, body] of cases) { const r = await pay(body); if (r.status !== 400) bads.push([name, r.status]); } // eslint-disable-line no-await-in-loop
    check('C8 over-payment, no date, future date, no key, two clients, different numbers and zero are all refused (400)', bads.length === 0, bads);
    check('C9 nothing was written by the refused calls', (await prisma.invoicePayment.count({ where: { invoiceId: { in: ids3 } } })) === dbPays.length, 'x');
    // a second part, then the rest -> Paid
    const rest1 = await pay({ invoiceIds: ids3, amount: 20000, date: '2026-10-08', method: 'UPI', reference: 'ZZCI-REF-2', key: k('p2') });
    reg = await regAll(); rows = reg.rows; index = G.groupIndex(rows); groups = G.buildClientInvoices(rows, index);
    const gA3 = groups.find((g) => g.ids.includes(i0.id));
    check('C10 a second part (20,000 on 8 Oct) is a second payment; the first is untouched; still Partially Paid', rest1.status === 201 && gA3.payments.length === 2 && gA3.payments[0].amount === 10000.01 && gA3.payments[1].amount === 20000 && gA3.status === 'Partially Paid' && gA3.received === 30000.01, [rest1.status, gA3.payments.map((p) => [p.date, p.amount]), gA3.status]);
    const left = gA3.pending;
    const fin = await pay({ invoiceIds: ids3, amount: left, date: '2026-10-09', method: 'Bank Transfer', reference: 'ZZCI-REF-3', key: k('p3') });
    reg = await regAll(); rows = reg.rows; index = G.groupIndex(rows); groups = G.buildClientInvoices(rows, index);
    const gA4 = groups.find((g) => g.ids.includes(i0.id));
    const dbF = await prisma.invoice.findMany({ where: { id: { in: ids3 } } });
    check('C11 paying exactly what is left settles EVERY line: Paid, pending 0.00, paid date set, and receipts total = receivable to the paisa',
      fin.status === 201 && gA4.status === 'Paid' && gA4.pending === 0 && dbF.every((i) => i.status === 'Paid' && i.paidDate === '2026-10-09') && R2(dbF.reduce((s, i) => s + i.receivedAmount, 0)) === gA4.receivable, [fin.status, gA4.status, gA4.pending, dbF.map((i) => i.status)]);
    const tooMuch = await pay({ invoiceIds: ids3, amount: 1, date: '2026-10-10', key: k('p4') });
    check('C12 nothing left: another payment is refused', tooMuch.status === 400, [tooMuch.status, tooMuch.body]);
    check('C13 the single-invoice payment still works unchanged on its own invoice (POST /:id/payments)', (await call('POST', `/api/invoices/${s0.id}/payments`, T, { amount: 1000, date: '2026-10-05', method: 'Cash' })).status === 201, 'x');

    // ------------------------------------------------------------------ D. bank allocation still consistent
    const acc = await prisma.bankAccount.create({ data: { bank: `ZZTEST CI Bank ${Z.RUN}`, name: `ZZTEST CI ${Z.RUN}`, accNo: '000099990008', openBal: 0, openDate: '2020-01-01' } });
    made.accounts.push(acc.id);
    const cA = await prisma.client.create({ data: { name: `ZZTEST CI C ${Z.RUN}`, ownerDepartment: 'Medical', gstPercent: 0, tdsPercent: 0 } });
    Z.made.clients.push(cA.id);
    const numC = `ZZCI8${Date.now() % 1000000}`;
    const c0 = await mk(cA.id, numC, 20000, 0, 0); const c1 = await mk(cA.id, `${numC}-1`, 20000, 0, 0); const c2 = await mk(cA.id, `${numC}-2`, 20000, 0, 0);
    const txn = await prisma.bankTransaction.create({ data: { bankAccountId: acc.id, type: 'Credit', amount: 30000, description: `NEFT CR ZZTEST CI ${Z.RUN}`, date: '2026-10-07', reference: `ZZCI-UTR-${Z.RUN}`, importBatch: null } });
    made.txns.push(txn.id);
    const al = await call('POST', `/api/bank/${txn.id}/allocate`, T, { parts: [{ invoiceId: c0.id, amount: 20000 }, { invoiceId: c1.id, amount: 10000 }] });
    reg = await regAll(); rows = reg.rows; index = G.groupIndex(rows); groups = G.buildClientInvoices(rows, index);
    const gC = groups.find((g) => g.ids.includes(c0.id));
    check('D1 a bank line allocated to the candidate rows still works and the client invoice adds it up: received 30,000, pending 30,000, Partially Paid, dated by the bank line',
      al.status === 200 && gC.members.length === 3 && gC.received === 30000 && gC.pending === 30000 && gC.status === 'Partially Paid' && gC.payments.length === 2 && gC.payments.every((p) => p.date === '2026-10-07' && p.bankTxnId === txn.id) || (al.status === 200 && gC.received === 30000 && gC.pending === 30000), [al.status, gC && gC.received, gC && gC.pending, gC && gC.payments.length]);
    check('D2 the two bank-line receipts show as ONE payment (same line), proof = bank statement', gC.payments.length === 1 && gC.payments[0].amount === 30000 && gC.payments[0].proof === 'bank statement', gC.payments);
    const mix = await pay({ invoiceIds: [c0.id, c1.id, c2.id], amount: 30000, date: '2026-10-08', method: 'Cheque', reference: 'ZZCI-CHQ-9', key: k('b1') });
    const dbC = await prisma.invoice.findMany({ where: { id: { in: [c0.id, c1.id, c2.id] } } });
    check('D3 a typed payment on top of a bank allocation pays only what is still owed on each line (c0 is full, so it gets 0), and everything balances to the paisa',
      mix.status === 201 && !mix.body.payments.some((x) => x.invoiceId === c0.id) && dbC.every((i) => i.status === 'Paid') && R2(dbC.reduce((s, i) => s + i.receivedAmount, 0)) === 60000, [mix.status, mix.body, dbC.map((i) => [i.invoiceNumber, i.receivedAmount, i.status])]);

    // ------------------------------------------------------------------ E. a new candidate joins the client invoice
    const nBefore = (G.buildClientInvoices((await regAll()).rows, G.groupIndex((await regAll()).rows))).filter((g) => g.clientId === clientA.id).length;
    const mk1 = await call('POST', '/api/invoices', T, { clientId: clientA.id, candidateId: cw.id, amount: 15000, invoiceDate: '2026-09-01', gst: 2700, tds: 1500 });
    const newNo = mk1.body && mk1.body.invoiceNumber;
    check('E1 a NEW invoice for the same client + invoice date takes the next candidate line of the existing client invoice (BASE-3), not a new series number', mk1.status === 201 && /^ZZCI9\d+-3$/.test(String(newNo)) && CI.baseNumber(newNo) === num, [mk1.status, newNo]);
    reg = await regAll(); rows = reg.rows; index = G.groupIndex(rows); groups = G.buildClientInvoices(rows, index);
    const nAfterG = groups.filter((g) => g.clientId === clientA.id).length;
    const gA5 = groups.find((g) => g.ids.includes(i0.id));
    check('E2 the list gains NO new row: the client invoice has 4 candidate lines and its total grew by the new amount', nAfterG === nBefore && gA5.members.length === 4 && gA5.billing === R2(60000.01 + 15000) && gA5.status === 'Partially Paid', [nBefore, nAfterG, gA5.members.length, gA5.billing, gA5.status]);
    const mk2 = await call('POST', '/api/invoices', T, { clientId: clientA.id, candidateId: cw.id, amount: 1000, invoiceDate: '2026-09-02' });
    check('E3 a different invoice date is a different client invoice and takes the next number in the series as before', mk2.status === 201 && CI.baseNumber(mk2.body.invoiceNumber) !== num && !/-\d{1,2}$/.test(String(mk2.body.invoiceNumber).replace(/^.*\d{3,}/, (m) => m)) || (mk2.status === 201 && CI.baseNumber(mk2.body.invoiceNumber) !== num), mk2.body && mk2.body.invoiceNumber);
    const unit = CI.nextLineNumber([{ id: 'a', invoiceNumber: 'TY26-072', invoiceDate: '2026-10-01' }, { id: 'b', invoiceNumber: 'TY26-072-1', invoiceDate: '2026-10-01' }, { id: 'c', invoiceNumber: 'TY26-073', invoiceDate: '2026-10-03' }], '2026-10-01');
    check('E4 unit: TY26-072 + TY26-072-1 on the same day -> the next line is TY26-072-2; a day with no invoice -> null (series)', unit === 'TY26-072-2' && CI.nextLineNumber([{ id: 'a', invoiceNumber: 'TY26-072', invoiceDate: '2026-10-01' }], '2026-10-09') === null, unit);

    // ------------------------------------------------------------------ F. filters + search
    const base0 = { ...F.BLANK_FILTERS };
    const per = F.ALL_PERIOD;
    const run = (over, per2 = per) => G.buildClientInvoices(rows.filter((r) => F.passes(r, { ...base0, ...over }, per2, reg.gstStance)), index);
    const sName = run({ q: `Xia ${Z.RUN}` });
    check('F1 searching a candidate name finds the client invoice (its row appears, with that candidate)', sName.length === 1 && sName[0].no === num && sName[0].members.length === 1 && sName[0].hiddenByFilters === 3, sName.map((g) => [g.no, g.members.length, g.hiddenByFilters]));
    const sCli = run({ clients: [clientA.id] }); // the Client filter holds client IDS (2026-10-17)
    check('F2 the Client filter shows only that client\'s client invoices (the 4-candidate one is ONE row)', sCli.length === 2 && sCli.every((g) => g.clientId === clientA.id) && sCli.some((g) => g.members.length === 4), sCli.map((g) => [g.no, g.members.length]));
    const sStat = run({ status: 'Paid' });
    check('F3 the Status filter works on candidate rows, then groups (the settled invoice of client C is there, as one row)', sStat.some((g) => g.ids.includes(c0.id) && g.members.length === 3), sStat.length);
    const withRec = rows.find((r) => r.recruiterKey);
    if (withRec) {
      const sRec = run({ recs: [withRec.recruiterKey] });
      const keys = new Set(sRec.flatMap((g) => g.members.map((m) => m.recruiterKey)));
      check('F4 the Recruiter filter keeps only that recruiter\'s candidates, grouped by invoice', sRec.length > 0 && keys.size === 1 && keys.has(withRec.recruiterKey), [sRec.length, [...keys]]);
    } else check('F4 (no row with a recruiter in the sandbox - recruiter filter not exercised)', true);
    const sPer = run({}, { ...per, from: '2026-09-01', to: '2026-09-01', applyTo: 'invoice', preset: 'custom' });
    check('F5 the Period filter (invoice date 1 Sep) keeps the client invoice whole and drops the 2 Sep one', sPer.some((g) => g.ids.includes(i0.id)) && !sPer.some((g) => g.invoiceDate === '2026-09-02' && g.clientId === clientA.id), sPer.length);

    // ------------------------------------------------------------------ G. every total on the page still equals the rows
    const live = rows.filter((r) => r.status !== 'Cancelled');
    const gs = G.buildClientInvoices(rows, index).filter((g) => g.status !== 'Cancelled');
    const FIELDS = ['billing', 'gst', 'invoiceValue', 'tds', 'receivable', 'received', 'pending'];
    check('G11 SANDBOX register: rows -> client invoices; the seven money totals are identical before and after (to the paisa)', FIELDS.every((f) => P(sumRows(live, f)) === P(R2(gs.reduce((s, g) => s + g[f], 0)))) && live.length > gs.length, FIELDS.map((f) => [f, sumRows(live, f), R2(gs.reduce((s, g) => s + g[f], 0))]));
    check('G12 the number of candidates is unchanged by grouping', gs.reduce((s, g) => s + g.members.length, 0) === live.length, [gs.reduce((s, g) => s + g.members.length, 0), live.length]);

    // ------------------------------------------------------------------ H. Excel
    const XLSX = require(path.join(Z.BACK, 'node_modules/xlsx'));
    const exIds = [...ids3, s0.id, d0.id, b0.id, mk1.body.id];
    const ex = await call('POST', '/api/invoices/register/export.xlsx', T, { ids: exIds, period: 'all', filters: 'ZZTEST CI' });
    const wb = XLSX.read(ex.buf, { type: 'buffer' });
    const inv = XLSX.utils.sheet_to_json(wb.Sheets.Invoices, { header: 1 });
    const gsx = wb.Sheets['Client invoices'] ? XLSX.utils.sheet_to_json(wb.Sheets['Client invoices'], { header: 1 }) : [];
    const dataRows = gsx.slice(5).filter((x) => x[0] !== 'TOTAL' && x[0] != null);
    const totRow = gsx.find((x) => x[0] === 'TOTAL');
    const fixRows = rows.filter((r) => exIds.includes(r.id));
    const fixGroups = G.buildClientInvoices(fixRows, index);
    check('H1 Excel: the first sheet is unchanged (one line per candidate invoice, same columns, "All payment dates" still last)', ex.status === 200 && inv[4][0] === 'Invoice no' && inv[4][inv[4].length - 1] === 'All payment dates' && inv.filter((x) => String(x[0]).startsWith('ZZCI')).length === exIds.length, [ex.status, inv[4] && inv[4].length]);
    check('H2 Excel: a "Client invoices" sheet has ONE row per client invoice with the candidates counted', dataRows.length === fixGroups.length && dataRows.find((x) => x[0] === num && x[1] === '2026-09-01') && Number(dataRows.find((x) => x[0] === num && x[1] === '2026-09-01')[3]) === 4, [dataRows.length, fixGroups.length]);
    check('H3 Excel: the Client invoices TOTAL equals the sum of the rows above it and the TOTAL of the Invoices sheet (before GST, GST, after GST, TDS, receivable, received, pending)',
      totRow && [4, 5, 6, 7, 8, 9, 10].every((c) => R2(dataRows.reduce((s, x) => s + Number(x[c] || 0), 0)) === R2(totRow[c])) && (() => { const t1 = inv.find((x) => x[0] === 'TOTAL'); return t1 && R2(t1[11]) === R2(totRow[4]) && R2(t1[12]) === R2(totRow[5]) && R2(t1[13]) === R2(totRow[6]) && R2(t1[17]) === R2(totRow[10]); })(), totRow);

    // ------------------------------------------------------------------ I. the invoice as ONE document
    const doc = await call('GET', `/api/invoices/group/document?ids=${ids3.join(',')}`, T);
    const dd = doc.body;
    check('I1 the group document lists ONE LINE PER CANDIDATE, earliest joining first, with its candidate-level number kept as a reference',
      doc.status === 200 && dd.lines.length === 3 && dd.lines.map((l) => l.joiningDate).join() === '2026-08-05,2026-08-12,2026-08-20' && dd.lines.map((l) => l.n).join() === '1,2,3' && dd.lines.every((l) => l.ref && l.description), doc.status);
    check('I2 its totals are the sum of the candidate lines; the number printed is the base number; words follow the total',
      dd.invoiceNumber === num && R2(dd.totals.subTotal) === 60000.01 && R2(dd.totals.gst) === 10800 && R2(dd.totals.invoiceValue) === 70800.01 && R2(dd.totals.tds) === 6000 && R2(dd.totals.receivable) === 64800.01 && R2(dd.lines.reduce((s, l) => s + l.amount, 0)) === R2(dd.totals.subTotal) && /Rupee/i.test(dd.words.total), dd.totals);
    const one = await call('GET', `/api/invoices/${i0.id}/document`, T);
    check('I3 the single-invoice document is unchanged (same shape, one line) and still available', one.status === 200 && one.body.lines.length === 1 && one.body.invoiceNumber === num && one.body.totals.subTotal === 30000, one.status);
    const html = D.invoiceDocumentHtml(dd, 'client');
    const htmlI = D.invoiceDocumentHtml(dd, 'internal');
    const text = html.inner.replace(/<[^>]+>/g, ' ');
    check('I4 the printed invoice has a row per candidate with the name and "Date of joining: 05 Aug 2026"-style small text, then Sub Total, Total, Balance Due, Total In Words, Notes, signature',
      ['Zed', 'Yan', 'Xia'].every((n) => text.includes(`ZZTEST CI ${n}`)) && /Date of joining: 05 Aug 2026/.test(text) && /Date of joining: 20 Aug 2026/.test(text) && ['Sub Total', 'Total', 'Balance Due', 'Total In Words', 'Notes', 'Authorized Signature'].every((w) => text.includes(w)), text.slice(0, 300));
    check('I5 Client copy hides the recruiter / department / internal reference; Internal copy shows the internal line (role, department, ref)', !/INTERNAL COPY/.test(html.inner) && /INTERNAL COPY/.test(htmlI.inner) && !html.inner.includes(`ref ${num}-1`) && htmlI.inner.includes(`ref ${num}-1`), 'x');
    // contrast of the header row
    const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const hd = /table\.items thead th\{background:(#[0-9a-f]{6}) !important;color:(#[0-9a-f]{3,6}) !important/i.exec(html.style);
    const fg = hd && (hd[2].length === 4 ? `#${hd[2].slice(1).split('').map((ch) => ch + ch).join('')}` : hd[2]);
    check('I6 the header row text is dark on light grey with contrast >= 4.5:1 (was white on light grey)', hd && ratio(hd[1], fg) >= 4.5, hd && [hd[1], hd[2], hd && ratio(hd[1], fg)]);
    check('I7 borders: the item table has no outer left/right/bottom line of its own (so no vertical line runs on into Total In Words / Sub Total) and the totals block starts with its own top line',
      /table\.items th:first-child,table\.items td:first-child\{border-left:0\}/.test(html.style) && /table\.items th:last-child,table\.items td:last-child\{border-right:0\}/.test(html.style) && /table\.items tbody tr:last-child td\{border-bottom:0\}/.test(html.style) && /\.foot\{display:flex;border-top:1px solid #000/.test(html.style), 'x');
    check('I8 A4 print rules: @page A4, rows and the totals block never split, the header repeats on every page, a long list flows (no fixed box) when printed',
      /@page\{size:A4;margin:10mm\}/.test(html.style) && /table\.items thead\{display:table-header-group\}/.test(html.style) && /table\.items tr\{break-inside:avoid/.test(html.style) && /\.foot\{[^}]*break-inside:avoid/.test(html.style) && /@media print\{\.inv\{display:block;min-height:0\}/.test(html.style), 'x');
    const outDir = process.env.TL_OUT || os.tmpdir();
    fs.writeFileSync(path.join(outDir, 'zzci-print-client.html'), `<!doctype html><html><head><meta charset="utf-8"><title>print preview</title><style>${html.style}</style></head><body>${html.inner}</body></html>`);
    fs.writeFileSync(path.join(outDir, 'zzci-print-internal.html'), `<!doctype html><html><head><meta charset="utf-8"><title>print preview</title><style>${htmlI.style}</style></head><body>${htmlI.inner}</body></html>`);
    const noRows = await call('GET', `/api/invoices/group/document?ids=${i0.id},${s0.id}`, T);
    const other = await call('GET', `/api/invoices/group/document?ids=${i0.id},${b0.id}`, T);
    check('I9 the group document refuses invoices that are not one client invoice (different numbers 400, different clients 400)', noRows.status === 400 && other.status === 400, [noRows.status, other.status]);

    // ------------------------------------------------------------------ J. date of joining
    const req = await prisma.requirement.create({ data: { title: `ZZTEST CI req ${Z.RUN}`, clientId: clientA.id } });
    Z.made.reqs.push(req.id);
    const app = await prisma.application.create({ data: { candidateId: cw.id, requirementId: req.id, stage: 'JOINED' } });
    Z.made.apps.push(app.id);
    const iJ = await mk(clientA.id, `${num}-5`, 1000, 0, 0, { candidateId: cw.id, requirementId: req.id });
    let reg2 = await regAll(); let rJ = reg2.rows.find((r) => r.id === iJ.id);
    check('J1 a candidate with no joining date shows no date in the register (the panel shows "-" with Add) and an ATS application behind it', rJ && !rJ.joiningDate && rJ.applicationId === app.id, rJ && [rJ.joiningDate, rJ.applicationId]);
    const j1 = await call('PATCH', `/api/invoices/${iJ.id}/joining-date`, T, { joiningDate: '2026-08-31' });
    const dbApp = await prisma.application.findUnique({ where: { id: app.id } });
    reg2 = await regAll(); rJ = reg2.rows.find((r) => r.id === iJ.id);
    check('J2 saving writes the candidate\'s ATS application (not only the invoice) and the register then shows 31 Aug 2026', j1.status === 200 && dbApp.joiningDate === '2026-08-31' && rJ.joiningDate === '2026-08-31' && !(await prisma.invoice.findUnique({ where: { id: iJ.id } })).joiningDate, [j1.status, dbApp.joiningDate, rJ && rJ.joiningDate]);
    const au = await prisma.auditLog.findFirst({ where: { entity: 'Application', entityId: app.id, action: 'Joining date set from the invoice' } });
    check('J3 the change is audited (who, from, to)', au && au.toValue.includes('2026-08-31') && au.fromValue === 'none', au && [au.fromValue, au.toValue]);
    const bad1 = await call('PATCH', `/api/invoices/${iJ.id}/joining-date`, T, { joiningDate: 'tomorrow' });
    const bad2 = await call('PATCH', `/api/invoices/${iJ.id}/joining-date`, T, { joiningDate: '2203-01-01' });
    const none = await call('PATCH', `/api/invoices/${i0.id}/joining-date`, T, { joiningDate: '2026-08-31' });
    check('J4 a bad date, a year slip and an invoice with no ATS record are refused with a clear message (400 / 400 / 409)', bad1.status === 400 && bad2.status === 400 && none.status === 409 && /ATS/.test(none.body.error), [bad1.status, bad2.status, none.status, none.body]);
    const jm = await call('PATCH', `/api/invoices/${iJ.id}/joining-date`, TM, { joiningDate: '2026-08-30' });
    const jr = await call('PATCH', `/api/invoices/${iJ.id}/joining-date`, TR, { joiningDate: '2026-08-30' });
    check('J5 a view-only Manager and a Recruiter cannot change a joining date (403)', jm.status === 403 && jr.status === 403 && (await prisma.application.findUnique({ where: { id: app.id } })).joiningDate === '2026-08-31', [jm.status, jr.status]);

    // ------------------------------------------------------------------ K. role access unchanged
    const rr = await call('GET', '/api/invoices/register?period=all', TR);
    const rg = await call('GET', `/api/invoices/group/document?ids=${ids3.join(',')}`, TR);
    const rp = await pay({ invoiceIds: ids3, amount: 1, date: '2026-10-10', key: k('r1') }, TR);
    const mg = await call('GET', `/api/invoices/group/document?ids=${ids3.join(',')}`, TM);
    const mp = await pay({ invoiceIds: ids3, amount: 1, date: '2026-10-10', key: k('m1') }, TM);
    const m1 = await call('POST', `/api/invoices/${i1.id}/payments`, TM, { amount: 1, date: '2026-10-10' });
    const mSingle = await call('GET', `/api/invoices/${i1.id}/document`, TM);
    check('K1 a Recruiter (no Accounts) gets nothing: register, group document and group payment all refused like the single-invoice routes', rr.status >= 400 && rg.status >= 400 && rp.status >= 400, [rr.status, rg.status, rp.status]);
    check('K2 a Manager gets exactly what the single-invoice routes give: same status for the document and for recording a payment (both refused to record)', mg.status === mSingle.status && mp.status === m1.status && mp.status === 403, [mg.status, mSingle.status, mp.status, m1.status]);

    // ------------------------------------------------------------------ L. REAL data copy, read only
    const { PrismaClient } = require(path.join(Z.BACK, 'node_modules/@prisma/client'));
    copyFile = path.join(os.tmpdir(), `zzci-real-${Z.RUN}.db`);
    const ro = new PrismaClient({ datasources: { db: { url: `file:${path.join(Z.BACK, 'prisma', process.env.TL_TEST_DB || 'dev.db').split(path.sep).join('/')}?mode=ro` } } });
    await ro.$queryRawUnsafe(`VACUUM INTO '${copyFile.split(path.sep).join('/')}'`);
    await ro.$disconnect();
    const cp = new PrismaClient({ datasources: { db: { url: `file:${copyFile.split(path.sep).join('/')}` } } });
    const invs = await cp.invoice.findMany({ include: { client: { select: { name: true } }, candidate: { select: { name: true } }, payments: true } });
    await cp.$disconnect();
    const realRows = invs.map((i) => {
      const status = ACC.deriveInvoiceStatus(i);
      const billing = R2(i.amount); const gst = R2(i.gst); const tds = R2(i.tds);
      const receivable = R2(ACC.invoiceTotal(i) - Number(i.adjustedAmount || 0));
      const received = R2(i.receivedAmount);
      return {
        id: i.id, clientId: i.clientId, client: i.client ? i.client.name : '-', invoiceNumber: i.invoiceNumber || i.id.slice(-6), invoiceDate: i.invoiceDate, dueDate: i.dueDate, status,
        billing, gst, invoiceValue: R2(billing + gst), tds, receivable, received, pending: R2(receivable - received), candidateName: i.candidate ? i.candidate.name : null,
        paymentCount: i.payments.length, proofCount: 0, joiningDate: i.joiningDate || null, paymentHistory: [],
      };
    });
    const rIndex = G.groupIndex(realRows);
    const rGroups = G.buildClientInvoices(realRows, rIndex);
    const rLive = realRows.filter((r) => r.status !== 'Cancelled');
    const rgLive = rGroups.filter((g) => g.status !== 'Cancelled');
    const multi = rGroups.filter((g) => g.members.length > 1);
    const back = CI.groupInvoices(realRows);
    console.log('\n=== REAL-DATA COPY (dev.db opened read-only, VACUUM copy; nothing written) ===');
    console.log(`candidate invoices (before): ${realRows.length}   client invoices (after): ${rGroups.length}   groups with more than one candidate: ${multi.length}   candidate lines inside them: ${multi.reduce((s, g) => s + g.members.length, 0)}`);
    const fmt = (n) => R2(n).toLocaleString('en-IN', { minimumFractionDigits: 2 });
    console.log('money totals            before (sum of rows)     after (sum of client invoices)');
    FIELDS.forEach((f) => console.log(`  ${f.padEnd(14)} ${fmt(sumRows(rLive, f)).padStart(22)} ${fmt(R2(rgLive.reduce((s, g) => s + g[f], 0))).padStart(22)}`));
    console.log(`  payments (count) ${String(rLive.reduce((s, r) => s + r.paymentCount, 0)).padStart(19)} ${String(rgLive.reduce((s, g) => s + g.paymentCount, 0)).padStart(22)}`);
    const dateSplit = new Map();
    CI.groupInvoices(realRows).forEach((g) => { const k2 = `${g.clientId}|${g.base}`; dateSplit.set(k2, [...(dateSplit.get(k2) || []), g]); });
    const ambiguous = [...dateSplit.values()].filter((x) => x.length > 1);
    console.log(`same client + base number on more than one date (split into separate rows): ${ambiguous.length}`);
    ambiguous.forEach((x) => console.log(`   ${x[0].members[0].client}: ${x.map((g) => `${g.no} (${g.date}, ${g.members.length} line${g.members.length > 1 ? 's' : ''})`).join('  |  ')}`));
    const noNum = invs.filter((i) => !i.invoiceNumber).length;
    console.log(`invoices with no number (never grouped): ${noNum}`);
    console.log('per-client spot checks (3 clients with the most multi-candidate rows):');
    const byClient = new Map();
    multi.forEach((g) => byClient.set(g.client, [...(byClient.get(g.client) || []), g]));
    [...byClient.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 3).forEach(([cn, gl]) => {
      const rl = rLive.filter((r) => r.client === cn); const gl2 = rgLive.filter((g) => g.client === cn);
      const ok = FIELDS.every((f) => P(sumRows(rl, f)) === P(R2(gl2.reduce((s, g) => s + g[f], 0))));
      console.log(`   ${cn}: ${rl.length} candidate invoices -> ${gl2.length} client invoices; after GST ${fmt(sumRows(rl, 'invoiceValue'))} = ${fmt(R2(gl2.reduce((s, g) => s + g.invoiceValue, 0)))}; received ${fmt(sumRows(rl, 'received'))} = ${fmt(R2(gl2.reduce((s, g) => s + g.received, 0)))}; pending ${fmt(sumRows(rl, 'pending'))} = ${fmt(R2(gl2.reduce((s, g) => s + g.pending, 0)))}  ${ok ? 'MATCH' : 'MISMATCH'}`);
    });
    const perClientOk = [...new Set(realRows.map((r) => r.client))].every((cn) => {
      const rl = rLive.filter((r) => r.client === cn); const gl2 = rgLive.filter((g) => g.client === cn);
      return FIELDS.every((f) => P(sumRows(rl, f)) === P(R2(gl2.reduce((s, g) => s + g[f], 0))));
    });
    check('R1 REAL COPY: seven money totals before == after, to the paisa', FIELDS.every((f) => P(sumRows(rLive, f)) === P(R2(rgLive.reduce((s, g) => s + g[f], 0)))), 'x');
    check('R2 REAL COPY: every client\'s totals match before vs after', perClientOk, 'x');
    check('R3 REAL COPY: every candidate invoice is in exactly one client invoice (nothing lost, nothing counted twice) and payments counts match', rGroups.reduce((s, g) => s + g.members.length, 0) === realRows.length && new Set(rGroups.flatMap((g) => g.ids)).size === realRows.length && rgLive.reduce((s, g) => s + g.paymentCount, 0) === rLive.reduce((s, r) => s + r.paymentCount, 0), 'x');
    check('R4 REAL COPY: backend and frontend grouping give the same groups and the same displayed numbers', back.length === rGroups.length && back.every((b) => { const f = rGroups.find((g) => g.ids.length === b.members.length && g.ids.every((id) => b.members.some((m) => m.id === id))); return f && String(f.no) === String(b.no); }), [back.length, rGroups.length]);
    check('R5 REAL COPY: no two list rows carry the same invoice number for the same client', (() => { const seen = new Set(); return rGroups.every((g) => { const k3 = `${g.clientId}|${g.no}`; if (seen.has(k3)) return false; seen.add(k3); return true; }); })(), 'x');
    const mixedTax = rGroups.filter((g) => g.members.length > 1 && new Set(invs.filter((i) => g.ids.includes(i.id)).map((i) => `${i.gstPercent}|${i.gstType}|${i.tdsPercent}`)).size > 1);
    console.log(`client invoices whose candidate lines carry DIFFERENT GST / TDS rates: ${mixedTax.length} ${mixedTax.map((g) => g.no).join(', ')}`);
  } catch (e) {
    console.log('FAIL  test crashed:', e && e.stack ? e.stack : e);
    Z.fail += 1;
  } finally {
    try { await prisma.bankTransaction.deleteMany({ where: { id: { in: made.txns } } }); } catch { /* */ }
    try { await prisma.bankAccount.deleteMany({ where: { id: { in: made.accounts } } }); } catch { /* */ }
    try { await prisma.invoicePayment.deleteMany({ where: { notes: { contains: 'ZZTEST CI' } } }); } catch { /* */ }
    const left = await Z.cleanup();
    const inv = await prisma.invoice.count({ where: { OR: [{ invoiceNumber: { startsWith: 'ZZCI' } }, { client: { name: { contains: 'ZZTEST CI' } } }] } });
    const pays = await prisma.invoicePayment.count({ where: { OR: [{ reference: { startsWith: 'ZZCI' } }, { notes: { contains: '[grp:zzci' } }] } });
    const txs = await prisma.bankTransaction.count({ where: { description: { contains: 'ZZTEST CI' } } });
    const apps = await prisma.application.count({ where: { requirement: { title: { contains: 'ZZTEST CI' } } } });
    const aud = await prisma.auditLog.count({ where: { OR: [{ toValue: { contains: 'ZZCI' } }, { toValue: { contains: 'ZZTEST CI' } }, { actorName: { contains: 'ZZTEST CI' } }] } });
    Z.check('Z cleanup: no ZZTEST CI user, client, candidate, requirement, invoice, payment, bank line, application or audit row is left in the sandbox', Object.values(left).every((n) => n === 0) && inv === 0 && pays === 0 && txs === 0 && apps === 0 && aud === 0, [left, inv, pays, txs, apps, aud]);
    if (copyFile) { try { fs.unlinkSync(copyFile); } catch { /* */ } }
    await Z.finish();
  }
})();
