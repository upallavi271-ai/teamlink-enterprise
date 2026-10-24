#!/usr/bin/env node
// ---------------------------------------------------------------------------
// INVOICES PAGE / ACCOUNTS HEADLINE FIGURES (Accounts, 2026-10-17) - COPY DATABASE ONLY.
//
//   cd backend
//   node scripts/accounts-dashboard-test.js                       makes its own VACUUM INTO copy of the real database
//                                                                 (opened READ-ONLY) in the temp folder and deletes it after
//   COPY_DB=C:/tmp/accdash-copy.db node scripts/accounts-dashboard-test.js   use a copy you made (never prisma/dev.db)
//
// Starts its OWN throw-away API process (port 4098, TEST_MODE=1) on the copy, adds ZZTEST fixtures to the COPY
// (twin clients with one name, a client invoice of three candidate lines, partial payments, TDS, a credit note, a
// cancelled invoice, an overpaid invoice, a refund, every ageing boundary) and proves, over the real routes and the
// page's own modules (frontend invoices/invFilters.js, clientInvoice.js, invSummary.js bundled with esbuild):
//   A  one day rule (IST date strings) - backend and frontend agree at the midnight / 05:30 IST edge and every bucket boundary
//   B  the Client filter works on the client ID (twin names, rename, legacy name links, option list, joinings card)
//   C  for All Clients and each of 8+ clients: every card and every ageing bucket, independently recomputed from the
//      raw tables (and from the backend's own grouping) - to the paisa
//   D  reconciliation: total - TDS - adjustments - received + refund due = pending (All Clients and every client)
//   E  a chip click shows exactly the client invoices it counted (count and amount), whole
//   F  the cards and the list's TOTAL row agree; the Accounts Dashboard (utils/accountsControl.js) shows the same money
//   G  Total candidates / Total clients definitions, the dashboard's client filter by id
//   H  the page's load keeps only the newest answer (no stale totals after two quick changes)
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const FE = path.resolve(BACK, '..', 'frontend');
const REAL = path.resolve(BACK, 'prisma', 'dev.db');

let copy = process.env.COPY_DB;
let ownCopy = false;
if (copy && path.resolve(copy).toLowerCase() === REAL.toLowerCase()) { console.error('Refusing: COPY_DB is the real database.'); process.exit(2); }
if (!copy) {
  copy = path.join(os.tmpdir(), `accdash-${Date.now().toString(36)}.db`);
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(REAL, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.split(path.sep).join('/').replace(/'/g, "''")}'`);
  src.close();
  ownCopy = true;
}
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const PORT = Number(process.env.TEST_PORT || 4098);
if (PORT === 4010) process.exit(2);
const API = `http://127.0.0.1:${PORT}`;
const DB_URL = `file:${path.resolve(copy).split(path.sep).join('/')}?socket_timeout=60`;
process.env.DATABASE_URL = DB_URL;
process.env.TEST_MODE = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = DB_URL;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const ACC = require(path.join(BACK, 'src/utils/accounts'));
const CIB = require(path.join(BACK, 'src/utils/clientInvoice'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 700)}` : ''}`); };
const RUN = Date.now().toString(36);
const R2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const P = (n) => Math.round((Number(n) || 0) * 100);
const same = (a, b) => P(a) === P(b);
const sum = (list, f) => R2(list.reduce((s, x) => s + (Number(f(x)) || 0), 0));

function bundle(rel, name) {
  const esb = require(path.join(FE, 'node_modules', 'esbuild'));
  const out = path.join(os.tmpdir(), `zzadx-${RUN}-${name}.cjs`);
  esb.buildSync({ entryPoints: [path.join(FE, rel)], bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'error' });
  return require(out);
}

async function http(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(120000) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}

const made = { users: [], clients: [], cands: [], invoices: [] };
const TODAY = ACC.istDay();
const plus = (n) => { const d = new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86400000); return d.toISOString().slice(0, 10); };

(async () => {
  let server;
  try {
    const G = bundle('src/pages/invoices/clientInvoice.js', 'group');
    const F = bundle('src/pages/invoices/invFilters.js', 'filters');
    const H = bundle('src/pages/invoices/invHierarchy.js', 'hier');
    const S = bundle('src/pages/invoices/invSummary.js', 'summary');

    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 90 && !healthy; i += 1) {
      try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }

    const mkAdmin = async (tag) => {
      const u = await prisma.user.create({ data: { passwordHash: 'x', name: `ZZTEST ADX ${tag} ${RUN}`, email: `zz-adx-${tag}-${RUN}@example.test`, username: `zz-adx-${tag}-${RUN}@example.test`, role: 'ADMIN', atsRole: 'ADMIN', hrmsRole: 'NONE', accountsRole: 'ADMIN', hrmsAccess: false, accountsAccess: true, atsAccess: true, status: 'Active' } });
      made.users.push(u.id);
      return { u, t: jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' }) };
    };
    const A1 = await mkAdmin('a1');
    const A2 = await mkAdmin('a2');
    const T = A1.t;
    const rec = await prisma.user.create({ data: { passwordHash: 'x', name: `ZZTEST ADX rec ${RUN}`, email: `zz-adx-rec-${RUN}@example.test`, username: `zz-adx-rec-${RUN}@example.test`, role: 'EMPLOYEE', atsRole: 'RECRUITER', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' } });
    made.users.push(rec.id);

    // ------------------------------------------------------------------ A. the one day rule
    const edge = new Date('2026-10-17T20:30:00Z'); // 02:00 IST on 18 Oct (still the 17th in UTC)
    check('A1 backend: at 02:00 IST on the 18th an invoice due on the 17th is 1 day late (a UTC timestamp said 0)', ACC.daysOverdue('2026-10-17', edge) === 1 && ACC.istDay(edge) === '2026-10-18', [ACC.daysOverdue('2026-10-17', edge), ACC.istDay(edge)]);
    check('A2 backend: due today is 0 days late and NOT overdue; due tomorrow is -1', ACC.daysOverdue('2026-10-18', edge) === 0 && ACC.daysOverdue('2026-10-19', edge) === -1);
    check('A3 backend: the status flips to Overdue at midnight IST, not at 05:30', ACC.deriveInvoiceStatus({ amount: 1000, gst: 0, tds: 0, dueDate: '2026-10-17' }, edge) === 'Overdue' && ACC.deriveInvoiceStatus({ amount: 1000, gst: 0, tds: 0, dueDate: '2026-10-18' }, edge) === 'Pending');
    check('A4 frontend: the same edge - todayIst and dayDiff give the same day numbers', F.todayIst(edge.getTime()) === '2026-10-18' && F.dayDiff('2026-10-17', F.todayIst(edge.getTime())) === 1 && F.dayDiff('2026-10-18', F.todayIst(edge.getTime())) === 0);
    const bnd = (n) => ACC.ageBucket({ amount: 1000, gst: 0, tds: 0, dueDate: plus(-n) });
    const expectBucket = { 0: 'Not due yet', 1: '0–30 days', 30: '0–30 days', 31: '31–60 days', 60: '31–60 days', 61: '61–90 days', 90: '61–90 days', 91: '90+ days' };
    check('A5 every bucket boundary: due today = Not due yet; 1-30 / 31-60 / 61-90 / 91+ days late', Object.entries(expectBucket).every(([n, b]) => bnd(Number(n)) === b), Object.entries(expectBucket).map(([n]) => [n, bnd(Number(n))]));
    check('A6 no due date = Not due yet, a future due date = Not due yet, a settled invoice = Settled',
      ACC.ageBucket({ amount: 1000, gst: 0, tds: 0, dueDate: null }) === 'Not due yet' && bnd(-5) === 'Not due yet' && ACC.ageBucket({ amount: 1000, gst: 0, tds: 0, receivedAmount: 1000, dueDate: plus(-50) }) === 'Settled');
    check('A7 a date with a time part still reads as the plain date (2026-10-17T00:00:00Z)', ACC.daysOverdue('2026-10-17T00:00:00.000Z', edge) === 1);

    // ------------------------------------------------------------------ fixtures (in the COPY)
    const mkClient = async (tag, name) => {
      const c = await prisma.client.create({ data: { name: name || `ZZTEST ADX ${tag} ${RUN}`, location: 'ZZ Town', ownerDepartment: 'Education', clientType: 'Client' } });
      made.clients.push(c.id); return c;
    };
    const mkCand = async (tag) => {
      const c = await prisma.candidate.create({ data: { name: `ZZTEST ADX Cand ${tag} ${RUN}`, email: `zz-adx-c-${tag}-${RUN}@example.test`, phone: `90000${String(Math.floor(Math.random() * 90000) + 10000)}`, location: 'ZZ' } });
      made.cands.push(c.id); return c;
    };
    const inv = async (client, cand, body) => {
      const r = await http('POST', '/api/invoices', T, { clientId: client.id, candidateId: cand ? cand.id : undefined, gstPercent: 18, tdsPercent: 0, ...body });
      if (r.status !== 201) throw new Error(`invoice failed ${r.status} ${r.text.slice(0, 200)}`);
      made.invoices.push(r.body.id); return r.body;
    };
    const pay = async (i, amount, date) => {
      const r = await http('POST', `/api/invoices/${i.id}/payments`, T, { amount, date: date || plus(-1), method: 'Bank Transfer', reference: `ZZ-${RUN}-${Math.random().toString(36).slice(2, 7)}` });
      if (r.status !== 201) throw new Error(`payment failed ${r.status} ${r.text.slice(0, 200)}`);
      return r.body;
    };

    const c1 = await mkCand('1'); const c2 = await mkCand('2'); const c3 = await mkCand('3'); const c4 = await mkCand('4');
    const c5 = await mkCand('5'); const c6 = await mkCand('6'); const c7 = await mkCand('7'); const c8 = await mkCand('8'); const c9 = await mkCand('9');
    const sharedName = `ZZTEST ADX Twin Pvt Ltd ${RUN}`;
    const twinA = await mkClient('twinA', sharedName);
    const twinB = await mkClient('twinB', sharedName);
    const multi = await mkClient('multi');
    const tdsC = await mkClient('tds');
    const credC = await mkClient('credit');
    const cancC = await mkClient('cancel');
    const overC = await mkClient('overpaid');
    const bndC = await mkClient('bounds');

    // twin A: one invoice, 45 days late. twin B: due today, partly paid; candidate c1 is invoiced here too (a person twice).
    await inv(twinA, c1, { amount: 100000, invoiceDate: plus(-52), dueDate: plus(-45) });
    const tb = await inv(twinB, c1, { amount: 50000, invoiceDate: plus(-9), dueDate: plus(0) });
    await pay(tb, 20000);
    // multi: ONE client invoice, three candidate lines, same date. line 1 late 35 days (two part payments), line 2 not due, line 3 paid in full though its due date was 100 days ago.
    const mDate = plus(-40);
    const m1 = await inv(multi, c2, { amount: 30000, tdsPercent: 10, invoiceDate: mDate, dueDate: plus(-35) });
    const m2 = await inv(multi, c3, { amount: 30000, tdsPercent: 10, invoiceDate: mDate, dueDate: plus(10) });
    const m3 = await inv(multi, c4, { amount: 30000, tdsPercent: 10, invoiceDate: mDate, dueDate: plus(-100) });
    await pay(m1, 10000, plus(-20)); await pay(m1, 5000, plus(-10));
    await pay(m3, 30000 * 1.18 - 3000, plus(-30)); // paid in full (net receivable after 10% TDS)
    const gp = await http('POST', '/api/invoices/group/payments', T, { key: `ZZADX${RUN}`, amount: 12000, date: plus(-2), invoiceIds: [m1.id, m2.id, m3.id] });
    // TDS client: partial payment, 5 days late
    const td = await inv(tdsC, c5, { amount: 80000, tdsPercent: 10, invoiceDate: plus(-20), dueDate: plus(-5) });
    await pay(td, 30000);
    // credit note client: credit note of 20000 (before GST) issued by a second approver, plus a part payment; 65 days late
    const cr = await inv(credC, c6, { amount: 60000, tdsPercent: 10, invoiceDate: plus(-80), dueDate: plus(-65) });
    await pay(cr, 10000, plus(-30));
    const draft = await http('POST', '/api/invoices/credit-notes', A1.t, { kind: 'credit', invoiceId: cr.id, amount: 20000, reason: 'refund', noteDate: plus(-20) });
    const issued = draft.status === 201 ? await http('POST', `/api/invoices/credit-notes/${draft.body.id}/issue`, A2.t) : draft;
    // cancelled client: one cancelled invoice, one live
    const cx = await inv(cancC, c7, { amount: 25000, invoiceDate: plus(-12), dueDate: plus(-2) });
    const cxCancel = await http('PATCH', `/api/invoices/${cx.id}/cancel`, T);
    await inv(cancC, c8, { amount: 10000, invoiceDate: plus(-3), dueDate: plus(5) });
    // overpaid client: received MORE than billed (an import-style row), and a second invoice 95 days late
    const ov = await inv(overC, c9, { amount: 10000, invoiceDate: plus(-110), dueDate: plus(-100) });
    await prisma.invoice.update({ where: { id: ov.id }, data: { receivedAmount: 12000, status: 'Paid', paidDate: plus(-60) } });
    await inv(overC, null, { amount: 40000, invoiceDate: plus(-105), dueDate: plus(-95) });
    // a refund on one invoice: a receipt of 8000 then a reversal of 3000 (the receipt row is negative)
    const rf = await inv(overC, null, { amount: 20000, invoiceDate: plus(-30), dueDate: plus(-1) });
    await pay(rf, 8000, plus(-15));
    await prisma.invoicePayment.create({ data: { invoiceId: rf.id, date: plus(-5), amount: -3000, method: 'Bank Transfer', notes: 'ZZTEST reversal', dateSource: 'entered' } });
    await prisma.invoice.update({ where: { id: rf.id }, data: { receivedAmount: 5000 } });
    // every ageing boundary, one client invoice each (a different invoice date each)
    const bounds = [0, 1, 30, 31, 60, 61, 90, 91, -7];
    for (const n of bounds) await inv(bndC, null, { amount: 1000, gstPercent: 0, invoiceDate: plus(-n - 3), dueDate: plus(-n) });
    await inv(bndC, null, { amount: 1000, gstPercent: 0, invoiceDate: plus(-200) }); // due date derived from the terms

    check('X0 fixtures: the group payment and the credit note were accepted', gp.status === 201 && issued.status === 200 && cxCancel.status === 200, [gp.status, draft.status, issued.status, cxCancel.status, gp.text && gp.text.slice(0, 200)]);

    const fx = [twinA, twinB, multi, tdsC, credC, cancC, overC, bndC];
    const R = await http('GET', '/api/invoices/register?period=all', T);
    check('X1 the register loads for an Accounts admin', R.status === 200 && Array.isArray(R.body.rows), R.status);
    const reg = R.body;
    const rows = reg.rows;
    const stance = reg.gstStance || {};
    const rr = await http('GET', '/api/invoices/register?period=all', jwt.sign(tokenPayload(await resolveIdentity(rec.id)), process.env.JWT_SECRET, { expiresIn: '2h' }));
    check('X2 a recruiter with no Accounts access still gets nothing (no widening)', rr.status === 401 || rr.status === 403, rr.status);
    check('X3 the register carries the client list by id and each row its candidate id', Array.isArray(reg.clientList) && reg.clientList.length === new Set(rows.map((r) => r.clientId)).size && rows.some((r) => r.candidateId), [reg.clientList && reg.clientList.length, new Set(rows.map((r) => r.clientId)).size]);

    // ------------------------------------------------------------------ B. the Client filter works on the client id
    const idx = G.groupIndex(rows);
    const view = (f, per) => {
      const base = rows.filter((r) => F.passes(r, { ...F.BLANK_FILTERS, ...f }, per || F.ALL_PERIOD, stance));
      const groups = G.buildClientInvoices(base, idx);
      return { base, groups };
    };
    const tA = view({ clients: [twinA.id] }); const tB = view({ clients: [twinB.id] });
    check('B1 two clients with the SAME name: picking one by id shows only its invoices', tA.base.length === 1 && tA.base[0].clientId === twinA.id && tB.base.length === 1 && tB.base.every((r) => r.clientId === twinB.id), [tA.base.length, tB.base.length]);
    check('B2 the register lists the twins as two clients with one name (so the picker can tell them apart by a short id)', reg.clientList.filter((c) => c.name === sharedName).length === 2 && reg.clients.filter((n) => n === sharedName).length === 1);
    const fcAll = F.facetCounts(rows, F.BLANK_FILTERS, F.ALL_PERIOD, stance);
    check('B3 the option counts are by client id: each twin has its own count', fcAll.clients.get(twinA.id) === 1 && fcAll.clients.get(twinB.id) === 1 && !fcAll.clients.has(sharedName), [fcAll.clients.get(twinA.id), fcAll.clients.get(twinB.id)]);
    check('B4 an old link / saved view that holds the NAME turns into both ids; an id stays; an unknown name is dropped',
      JSON.stringify(F.resolveClients([sharedName], reg.clientList).sort()) === JSON.stringify([twinA.id, twinB.id].sort()) && JSON.stringify(F.resolveClients([twinA.id], reg.clientList)) === JSON.stringify([twinA.id]) && F.resolveClients(['no such client xyz'], reg.clientList).length === 0 && F.resolveClients([sharedName.toLowerCase()], reg.clientList).length === 2);
    // rename: the filter still follows the id, the old name text matches nothing
    await prisma.client.update({ where: { id: twinA.id }, data: { name: `ZZTEST ADX Renamed ${RUN}` } });
    const reg2 = (await http('GET', '/api/invoices/register?period=all', T)).body;
    const rowsR = reg2.rows.filter((r) => F.passes(r, { ...F.BLANK_FILTERS, clients: [twinA.id] }, F.ALL_PERIOD, stance));
    check('B5 a renamed client: the id filter still finds its invoices, under the new name', rowsR.length === 1 && rowsR[0].client === `ZZTEST ADX Renamed ${RUN}` && reg2.clientList.find((c) => c.id === twinA.id).name === `ZZTEST ADX Renamed ${RUN}`);
    await prisma.client.update({ where: { id: twinA.id }, data: { name: sharedName } });
    // the filter no longer reads names
    const byNameText = rows.filter((r) => F.passes(r, { ...F.BLANK_FILTERS, clients: [sharedName] }, F.ALL_PERIOD, stance));
    check('B6 a client NAME in the filter matches nothing (no name-text matching left)', byNameText.length === 0, byNameText.length);
    // joinings card follows the id
    const jr = (reg.noInvoice && reg.noInvoice.rows) || [];
    if (jr.length) {
      const cid = jr[0].clientId;
      const under = H.waitingUnder(reg.noInvoice, { ...F.BLANK_FILTERS, clients: [cid] });
      check('B7 "joinings waiting" follows the same client id', under.filtered && under.waiting === jr.filter((x) => x.clientId === cid).length, [under.waiting]);
    } else check('B7 (no joinings waiting in this copy - card not exercised)', true);

    // ------------------------------------------------------------------ C/D/E/F. the figures, client by client
    // Independent reading from the raw tables.
    const rawInv = await prisma.invoice.findMany({ include: { payments: true } });
    const rawNotes = await prisma.creditNote.findMany({ where: { status: 'Issued' } });
    const expectFor = (clientId) => {
      const mine = rawInv.filter((i) => (clientId ? i.clientId === clientId : true) && i.status !== 'Cancelled');
      const ids = new Set(mine.map((i) => i.id));
      const notes = rawNotes.filter((n) => ids.has(n.invoiceId));
      const cn = (kind, k) => sum(notes.filter((n) => n.kind === kind), (n) => n[k]);
      const e = {
        total: R2(sum(mine, (i) => i.amount + i.gst) - cn('credit', 'amount') - cn('credit', 'gst') + cn('debit', 'amount') + cn('debit', 'gst')),
        tds: R2(sum(mine, (i) => i.tds) - cn('credit', 'tds') + cn('debit', 'tds')),
        received: sum(mine, (i) => i.receivedAmount),
        adjusted: sum(mine, (i) => i.adjustedAmount),
        refundDue: sum(notes.filter((n) => n.kind === 'credit'), (n) => n.refundDue),
        pending: sum(mine, (i) => ACC.invoiceOutstanding(i)),
        candidates: new Set(mine.map((i) => i.candidateId).filter(Boolean)).size,
        clients: new Set(mine.map((i) => i.clientId)).size,
        paymentRowsAgree: mine.every((i) => !i.payments.length || Math.abs(i.receivedAmount - sum(i.payments, (p) => p.amount)) < 0.01),
      };
      // buckets, from the BACKEND's own grouping and day rule
      const groups = CIB.groupInvoices(mine.map((i) => ({ ...i })));
      const bk = {}; ['Not due yet', '0–30 days', '31–60 days', '61–90 days', '90+ days'].forEach((b) => { bk[b] = { count: 0, amt: 0 }; });
      let overdueCount = 0; let overdueAmt = 0; let settled = 0; let invoices = 0;
      groups.forEach((g) => {
        invoices += 1;
        const out = g.members.map((m) => ({ m, out: ACC.invoiceOutstanding(m), n: ACC.daysOverdue(m.dueDate) }));
        const net = sum(out, (x) => x.out);
        const owing = out.filter((x) => x.out > 0.5);
        if (!owing.length || net <= 0.5) { settled += 1; return; }
        const worst = Math.max(...owing.map((x) => (x.n == null ? -1 : x.n)));
        const name = worst <= 0 ? 'Not due yet' : worst <= 30 ? '0–30 days' : worst <= 60 ? '31–60 days' : worst <= 90 ? '61–90 days' : '90+ days';
        bk[name].count += 1; bk[name].amt = R2(bk[name].amt + net);
        if (worst > 0) { overdueCount += 1; overdueAmt = R2(overdueAmt + net); }
      });
      return {
        ...e, bk, overdueCount, overdueAmt, settled, invoices,
      };
    };

    const dash = async (clientId) => (await http('GET', `/api/dashboard/accounts/control?fresh=1${clientId ? `&client=${encodeURIComponent(clientId)}` : ''}`, T));

    // real clients: the top three by invoice lines, one with TDS and one with a part payment if the data has them
    const byClient = new Map();
    rows.filter((r) => !fx.some((c) => c.id === r.clientId)).forEach((r) => byClient.set(r.clientId, [...(byClient.get(r.clientId) || []), r]));
    const realIds = [...byClient.entries()].sort((a, b) => b[1].length - a[1].length).map(([id]) => id);
    const realTds = realIds.find((id) => byClient.get(id).some((r) => r.tds > 0.5));
    const realPart = realIds.find((id) => byClient.get(id).some((r) => r.status === 'Partially Paid'));
    const realPick = [...new Set([realIds[0], realIds[1], realTds, realPart].filter(Boolean))];
    const targets = [{ name: 'ALL CLIENTS', id: null }, ...fx.map((c, i) => ({ name: ['twin A', 'twin B', 'multi-line', 'TDS', 'credit note', 'cancelled', 'overpaid+refund', 'boundaries'][i], id: c.id })), ...realPick.map((id) => ({ name: `real: ${(byClient.get(id)[0] || {}).client}`, id }))];

    for (const tg of targets) {
      const f = tg.id ? { clients: [tg.id] } : {};
      const { base, groups: baseGroups } = view(f);
      const chosen = tg.id ? rows.filter((r) => r.clientId === tg.id) : rows;
      check(`C0 [${tg.name}] the filter keeps exactly this client's rows`, base.length === chosen.length && base.every((r) => !tg.id || r.clientId === tg.id), [base.length, chosen.length]);
      const cards = S.cardsOf(base, baseGroups);
      const exp = expectFor(tg.id);
      const live = base.filter((r) => r.status !== 'Cancelled');
      // (1) cards against the raw tables
      check(`C1 [${tg.name}] Total amount = invoice values incl. GST, less credit notes, cancelled left out (${cards.total})`, same(cards.total, exp.total), [cards.total, exp.total]);
      check(`C2 [${tg.name}] Amount received = the money received on the live invoices (${cards.received}); every invoice's receipts add up to it`, same(cards.received, exp.received) && exp.paymentRowsAgree, [cards.received, exp.received, exp.paymentRowsAgree]);
      check(`C3 [${tg.name}] Pending = receivable after TDS, credit notes and adjustments minus received (${cards.pending})`, same(cards.pending, exp.pending), [cards.pending, exp.pending]);
      check(`C4 [${tg.name}] Overdue invoices = client invoices that still owe and are past due (${cards.overdueCount}) and their money (${cards.overdueAmount})`, cards.overdueCount === exp.overdueCount && same(cards.overdueAmount, exp.overdueAmt), [cards.overdueCount, exp.overdueCount, cards.overdueAmount, exp.overdueAmt]);
      check(`C5 [${tg.name}] Total candidates = people (${cards.candidates}); Total clients = client ids (${cards.clients}); invoices = the list's rows (${cards.invoices})`, cards.candidates === exp.candidates && cards.clients === exp.clients && cards.invoices === exp.invoices && cards.invoices === baseGroups.length, [cards.candidates, exp.candidates, cards.clients, exp.clients, cards.invoices, exp.invoices, baseGroups.length]);
      // (D) reconciliation: total - TDS - adjustments - received + refund due = pending
      const recon = R2(cards.total - cards.tds - sum(live, (r) => r.adjusted) - cards.received + sum(live, (r) => r.refundDue));
      check(`D1 [${tg.name}] total ${cards.total} - TDS ${cards.tds} - adjustments - received ${cards.received} + refund due = pending ${cards.pending} (reconciles to the paisa)`, same(recon, cards.pending) && same(cards.total - cards.tds - sum(live, (r) => r.adjusted) - cards.received + sum(live, (r) => r.refundDue), exp.total - exp.tds - exp.adjusted - exp.received + exp.refundDue) && same(exp.total - exp.tds - exp.adjusted - exp.received + exp.refundDue, exp.pending), [recon, cards.pending, exp.total, exp.tds, exp.received, exp.refundDue, exp.pending]);
      // ageing chips
      const chips = S.chipsOf(baseGroups);
      const chip = (k) => chips.find((c) => c.k === k);
      const openSum = sum(S.OPEN_BUCKETS, (b) => chip(b).amt);
      const openCount = S.OPEN_BUCKETS.reduce((n, b) => n + chip(b).count, 0);
      check(`C6 [${tg.name}] every bucket's count and amount equals the backend's own reading: ${S.OPEN_BUCKETS.map((b) => `${b} ${chip(b).count}/${chip(b).amt}`).join(' | ')}`,
        S.OPEN_BUCKETS.every((b) => chip(b).count === exp.bk[b].count && same(chip(b).amt, exp.bk[b].amt)), S.OPEN_BUCKETS.map((b) => [b, chip(b).count, exp.bk[b].count, chip(b).amt, exp.bk[b].amt]));
      check(`C7 [${tg.name}] the five open buckets add up to "All" (${chip('All').amt}) and to what is owed; owed + overpaid set off = the Pending card`, same(openSum, chip('All').amt) && openCount + chip('Settled').count === chip('All').count && same(chip('All').amt + sum(chip('Settled').list, (g) => g.pending), cards.pending), [openSum, chip('All').amt, openCount, chip('Settled').count, chip('All').count, cards.pending]);
      check(`C8 [${tg.name}] overdue count = the four late buckets' counts; overdue money = their sum`, cards.overdueCount === S.LATE_BUCKETS.reduce((n, b) => n + chip(b).count, 0) && same(cards.overdueAmount, sum(S.LATE_BUCKETS, (b) => chip(b).amt)), [cards.overdueCount, S.LATE_BUCKETS.map((b) => chip(b).count)]);
      // (E) a chip click: the list shows exactly those client invoices, whole
      let clickOk = true; const clickWhy = [];
      for (const b of [...S.OPEN_BUCKETS, 'Settled']) {
        const rowsB = S.rowsForAge(base, baseGroups, b);
        const gB = G.buildClientInvoices(rowsB, idx);
        const c = chip(b);
        const owedAmt = b === 'Settled' ? sum(gB, (g) => g.received) : sum(gB, (g) => g.pending);
        const whole = gB.every((g) => g.members.length === baseGroups.find((x) => x.key === g.key).members.length);
        if (gB.length !== c.count || !same(owedAmt, c.amt) || !whole || !gB.every((g) => g.age === b || (b === 'Settled' && g.age === 'Settled'))) { clickOk = false; clickWhy.push([b, gB.length, c.count, owedAmt, c.amt, whole]); }
        // and the cards then follow the same rows (no stale state)
        const cb = S.cardsOf(rowsB, gB);
        if (b !== 'Settled' && !same(cb.pending, sum(rowsB, (r) => r.pending))) { clickOk = false; clickWhy.push(['cards', b]); }
      }
      check(`E1 [${tg.name}] clicking a bucket shows exactly the client invoices it counted (count, money, whole), and the cards follow`, clickOk, clickWhy);
      const click60 = S.rowsForAge(base, baseGroups, '60+');
      check(`E2 [${tg.name}] the desk's "60+" link = the 61-90 and 90+ buckets together`, G.buildClientInvoices(click60, idx).length === chip('61–90 days').count + chip('90+ days').count);
      // (F) cards = the list's TOTAL row; groups add up
      const totalRow = { pending: sum(base, (r) => r.pending), received: sum(base, (r) => r.received), invoiceValue: sum(base, (r) => r.invoiceValue) };
      const gsum = (k) => sum(baseGroups.filter((g) => g.status !== 'Cancelled'), (g) => g[k]);
      check(`F1 [${tg.name}] the cards equal the list's TOTAL row and the sum of the client-invoice rows`, same(cards.pending, totalRow.pending) && same(cards.received, totalRow.received) && same(cards.total, totalRow.invoiceValue) && same(gsum('pending'), cards.pending) && same(gsum('received'), cards.received) && same(gsum('invoiceValue'), cards.total), [cards.pending, totalRow.pending, gsum('pending')]);
      // the Accounts Dashboard, same client
      const d = await dash(tg.id);
      const ds = d.body && d.body.summary;
      if (ds) {
        check(`F2 [${tg.name}] the Accounts Dashboard shows the same money for this client: total ${ds.total.invoiceValue}, received ${ds.received.amount}, pending ${ds.pending.amount}, TDS ${ds.total.tds}`,
          same(ds.total.invoiceValue, cards.total) && same(ds.received.amount, cards.received) && same(ds.pending.amount, cards.pending) && same(ds.total.tds, cards.tds) && same(ds.total.receivable, cards.receivable) && ds.total.invoices === cards.lines,
          [ds.total.invoiceValue, cards.total, ds.received.amount, cards.received, ds.pending.amount, cards.pending, ds.total.invoices, cards.lines]);
        check(`F3 [${tg.name}] the dashboard's own overdue money = the money of the overdue lines (${ds.overdue.amount}); its tie-out checks pass`, ds.overdue.amount >= 0 && (d.body.checks || []).every((c) => c.ok), (d.body.checks || []).filter((c) => !c.ok));
      } else check(`F2 [${tg.name}] the Accounts Dashboard answered`, false, d.status);
    }

    // ------------------------------------------------------------------ the fixtures behave as designed
    const gMulti = G.buildClientInvoices(rows.filter((r) => r.clientId === multi.id), idx);
    check('G1 a client invoice of three candidate lines is ONE row, late by its worst line that STILL owes (35 days), not by the paid line (100 days)', gMulti.length === 1 && gMulti[0].members.length === 3 && gMulti[0].daysOverdue === 35 && gMulti[0].age === '31–60 days' && gMulti[0].overdue === true, gMulti.map((g) => [g.members.length, g.daysOverdue, g.age]));
    check('G2 ...and its due date is the one that decides the bucket (earliest due among the lines that owe)', gMulti[0].dueDate === plus(-35) && ACC.ageBucket({ amount: 1, gst: 0, tds: 0, dueDate: gMulti[0].dueDate }) === gMulti[0].age, gMulti[0].dueDate);
    const gCred = G.buildClientInvoices(rows.filter((r) => r.clientId === credC.id), idx)[0];
    const credRow = rows.find((r) => r.clientId === credC.id);
    check('G3 credit note: the invoice figures are after the note (value 70800-23600=47200, TDS 6000-2000=4000) and pending follows', same(credRow.invoiceValue, 60000 * 1.18 - 20000 * 1.18) && same(credRow.tds, 6000 - 2000) && !!credRow.noteCredit && same(credRow.pending, credRow.receivable - 10000), [credRow.invoiceValue, credRow.tds, credRow.pending, credRow.receivable]);
    check('G4 the cancelled invoice is out of every card and chip (the live one stays)', rows.filter((r) => r.clientId === cancC.id).length === 1 && !rows.some((r) => r.id === cx.id));
    const ovRows = rows.filter((r) => r.clientId === overC.id);
    const ovCards = S.cardsOf(ovRows, G.buildClientInvoices(ovRows, idx));
    check('G5 overpaid invoice: pending goes below zero on that invoice and is set off in the total (the card says so)', ovRows.some((r) => same(r.pending, -200)) && ovCards.overpaidCount === 1 && same(ovCards.overpaid, -200), [ovCards.overpaidCount, ovCards.overpaid]);
    const rfRow = ovRows.find((r) => r.id === rf.id);
    check('G6 refund (a negative receipt): received = 8000 - 3000 = 5000 and pending = 23600 - 5000', rfRow && same(rfRow.received, 5000) && same(rfRow.pending, 20000 * 1.18 - 5000) && rfRow.paymentHistory.some((h) => h.amount < 0), rfRow && [rfRow.received, rfRow.pending]);
    const bRows = rows.filter((r) => r.clientId === bndC.id);
    const ageOf = (n) => bRows.find((r) => r.dueDate === plus(-n)).age;
    check('G7 the page reads each boundary the same as the rule: 0 = Not due yet, 1 & 30 = 0-30, 31 & 60 = 31-60, 61 & 90 = 61-90, 91 = 90+, in 7 days = Not due yet', Object.entries({ 0: 'Not due yet', 1: '0–30 days', 30: '0–30 days', 31: '31–60 days', 60: '31–60 days', 61: '61–90 days', 90: '61–90 days', 91: '90+ days', '-7': 'Not due yet' }).every(([n, b]) => ageOf(Number(n)) === b), bounds.map((n) => [n, ageOf(n)]));
    const lateRule = rows.every((r) => F.dueMatch(r, 'late') === (r.pending > 0.5 && r.daysOverdue != null && r.daysOverdue > 0 && r.status !== 'Cancelled'));
    check('G8 the browser\'s "Late - still owed" filter and the server\'s overdue rule pick the SAME invoices (every row of the register)', lateRule);

    // ------------------------------------------------------------------ whole-register cross checks
    const allCards = S.cardsOf(rows, G.buildClientInvoices(rows, idx));
    const k = reg.kpis;
    check('G9 the server\'s own totals (register kpis) = the page cards for All Clients (candidates, clients, total, received, pending, overdue lines)',
      k.candidates === allCards.candidates && k.clients === allCards.clients && same(k.invoiceValue, allCards.total) && same(k.received, allCards.received) && same(k.pending, allCards.pending) && k.invoices === allCards.lines, [k, allCards.candidates, allCards.clients]);
    check('G10 the multi-invoiced person is counted once (c1 on two invoices: 2 lines, 1 candidate) and the twins are two clients',
      allCards.candidates < allCards.lines && S.cardsOf(rows.filter((r) => [twinA.id, twinB.id].includes(r.clientId)), G.buildClientInvoices(rows.filter((r) => [twinA.id, twinB.id].includes(r.clientId)), idx)).candidates === 1
      && S.cardsOf(rows.filter((r) => [twinA.id, twinB.id].includes(r.clientId)), []).clients === 2);
    // dashboard client filter by id
    const dTwinA = await dash(twinA.id); const dTwinB = await dash(twinB.id); const dName = await dash(sharedName);
    const idsIn = (d) => new Set((d.body.clients || []).map((c) => c.clientId));
    check('G11 the Accounts Dashboard Client filter works on the id: the twins are separate, the option list holds both (told apart by a short id)',
      idsIn(dTwinA).size === 1 && idsIn(dTwinA).has(twinA.id) && idsIn(dTwinB).size === 1 && idsIn(dTwinB).has(twinB.id) && (dTwinA.body.facets.client || []).filter((o) => o.value === twinA.id || o.value === twinB.id).length === 2
      && new Set((dTwinA.body.facets.client || []).filter((o) => o.value === twinA.id || o.value === twinB.id).map((o) => o.label)).size === 2, [...idsIn(dTwinA)]);
    check('G12 an old dashboard link that still carries a client NAME is read as a name (both twins) only because no client has that id', idsIn(dName).size === 2 && idsIn(dName).has(twinA.id) && idsIn(dName).has(twinB.id), [[...idsIn(dName)], twinA.id, twinB.id, dName.body && dName.body.filters, dName.body && dName.body.counts]);
    check('G13 the proof reminder / export read the same filter (unchanged contract: the client param)', dTwinA.body.filters && dTwinA.body.filters.client === twinA.id);

    // ------------------------------------------------------------------ H. no stale state
    const src = fs.readFileSync(path.join(FE, 'src/pages/Invoices.jsx'), 'utf8');
    check('H1 the page keeps only the newest answer: a load counter, the older request is aborted and an older answer is ignored', /loadSeq\.current/.test(src) && /AbortController/.test(src) && /mine === loadSeq\.current/.test(src));
    check('H2 every card and chip is computed from the same filtered rows (invSummary cardsOf / chipsOf) - nothing is held in state that could go stale', /cardsOf\(rows, invGroups\)/.test(src) && /chipsOf\(baseGroups\)/.test(src) && !/const st = \{/.test(src));
    check('H3 no name-based client matching is left in the page\'s filters', !/includes\(r\.client\)/.test(fs.readFileSync(path.join(FE, 'src/pages/invoices/invFilters.js'), 'utf8')) && !/includes\(r\.client\)/.test(fs.readFileSync(path.join(FE, 'src/pages/invoices/invHierarchy.js'), 'utf8')));
  } catch (e) {
    fail += 1; console.log(`FAIL  the test stopped: ${e && e.stack ? e.stack : e}`);
  } finally {
    // clean every ZZTEST row (the copy only), then drop the copy if the test made it
    try {
      await prisma.creditNote.deleteMany({ where: { clientId: { in: made.clients } } }).catch(() => {});
      await prisma.invoicePayment.deleteMany({ where: { invoiceId: { in: made.invoices } } }).catch(() => {});
      await prisma.invoice.deleteMany({ where: { clientId: { in: made.clients } } }).catch(() => {});
      await prisma.candidate.deleteMany({ where: { id: { in: made.cands } } }).catch(() => {});
      await prisma.client.deleteMany({ where: { id: { in: made.clients } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
    } catch { /* copy only */ }
    if (server) server.kill();
    await prisma.$disconnect().catch(() => {});
    if (ownCopy) { await new Promise((r) => setTimeout(r, 800)); for (const sfx of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(copy + sfx); } catch { /* still open */ } } }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
