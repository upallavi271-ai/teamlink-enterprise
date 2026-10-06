// ---------------------------------------------------------------------------
// RECRUITER REVENUE (ATS-100 B9.7) — ATS Reports → "Recruiter revenue" tab.
//
// Every invoice, NET of issued credit / debit notes (utils/invoiceTax.js
// withNotes — the Invoices page's own reading), attributed to the recruiter
// of the placement it bills: the invoice's job's recruiter, else the
// recruiter of the candidate's application at that client. Shown per
// recruiter, per recruiter × month and per recruiter × client; every money
// figure opens the invoices (or receipts) behind it.
//
// Same gate as Client revenue: Super Admin / Admin / Accounts
// (utils/reportsPlus.js mayRevenue). Filters: Department (the client's owner
// department), Client, Recruiter — cascading, with counts.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const A = require('./accounts');
const TAX = require('./invoiceTax');
const MF = require('./moneyFacts');
const dateRange = require('./dateRange');
const { invoiceWhere, scopeLabel } = require('./scope');

const rupees = (v) => Math.round(Number(v) || 0);
const inP = (day, p) => !!day && day >= p.from && day <= p.to;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (mk) => (/^\d{4}-\d{2}$/.test(mk) ? `${MONTHS[Number(mk.slice(5, 7)) - 1]} ${mk.slice(0, 4)}` : 'No date');
const UNATTRIBUTED = 'No recruiter on the placement';

class Cell {
  constructor(kind) { this.kind = kind; this.ids = new Set(); }
  add(id) { this.ids.add(id); return this; }
  get n() { return this.ids.size; }
}

async function build(user, q) {
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  const range = s(q.range) || 'all';
  const P = range === 'all' ? null : dateRange.resolve({ range, from: s(q.from), to: s(q.to) });
  const and = [invoiceWhere(user)];
  if (s(q.clientId)) and.push({ clientId: s(q.clientId) });
  if (s(q.department)) and.push({ client: { is: { ownerDepartment: s(q.department) } } });
  const invs = await prisma.invoice.findMany({
    where: { AND: and },
    select: {
      ...MF.INVOICE_SELECT,
      invoiceNumber: true, amount: true, gst: true, tds: true, dueDate: true, clientId: true, candidateId: true, requirementId: true,
      ...(TAX.hasCol('creditedAmount') ? { creditedAmount: true, debitedAmount: true } : {}),
      client: { select: { name: true, ownerDepartment: true } },
      candidate: { select: { name: true } },
      requirement: { select: { id: true, recruiterId: true, department: true, recruiter: { select: { id: true, name: true } } } },
      payments: { select: { id: true, date: true, amount: true, method: true, reference: true } },
    },
  });
  // Net of issued notes.
  const notesOf = await require('./creditNotes').notesByInvoice(invs.map((i) => i.id), { issuedOnly: true }); // eslint-disable-line global-require
  invs.forEach((i) => { const wn = TAX.withNotes(i, notesOf.get(i.id) || []); i.netAmount = wn.hasNotes ? wn.billing : Number(i.amount || 0); });
  // The recruiter: the job's, else the candidate's application at that client.
  const candIds = [...new Set(invs.filter((i) => !i.requirement?.recruiterId && i.candidateId).map((i) => i.candidateId))];
  const apps = candIds.length ? await prisma.application.findMany({
    where: { candidateId: { in: candIds } },
    select: { candidateId: true, stage: true, requirement: { select: { clientId: true, recruiterId: true, recruiter: { select: { id: true, name: true } } } } },
  }) : [];
  const byCand = new Map();
  apps.forEach((a) => byCand.set(a.candidateId, [...(byCand.get(a.candidateId) || []), a]));
  const recruiterOf = (i) => {
    if (i.requirement?.recruiter) return { key: `u:${i.requirement.recruiter.id}`, name: i.requirement.recruiter.name };
    const list = (byCand.get(i.candidateId) || []).filter((a) => a.requirement?.clientId === i.clientId && a.requirement?.recruiter);
    const a = list.find((x) => ['JOINED', 'HIRED'].includes(x.stage)) || list[0];
    if (a) return { key: `u:${a.requirement.recruiter.id}`, name: a.requirement.recruiter.name };
    return { key: '—', name: UNATTRIBUTED };
  };
  invs.forEach((i) => { i.rec = recruiterOf(i); });
  // The recruiter filter (u:<id> / id:<id> / n:<name> / name:<name>).
  let want = s(q.recruiter).replace(/^id:/, 'u:').replace(/^name:/, 'n:');
  if (want.startsWith('n:')) want = `n:${want.slice(2).toLowerCase()}`;
  const recOk = (i) => !want || i.rec.key === want || (want.startsWith('n:') && i.rec.name.toLowerCase() === want.slice(2));
  const scoped = invs.filter(recOk);
  const live = scoped.filter((i) => A.deriveInvoiceStatus(i) !== 'Cancelled');
  const inRange = live.filter((i) => !P || inP(String(i.invoiceDate || '').slice(0, 10), P));
  const invById = new Map(invs.map((i) => [i.id, i]));
  const payInfo = new Map();
  scoped.forEach((i) => (i.payments || []).forEach((p) => payInfo.set(p.id, p)));
  const pays = live.flatMap((i) => MF.receiptsOf(i)).filter((x) => !P || inP(x.date, P))
    .map((x) => ({ ...x, method: (payInfo.get(x.id) || {}).method, reference: (payInfo.get(x.id) || {}).reference }));
  const outstandingOf = (i) => Math.max(0, A.invoiceOutstanding(i));

  const cells = new Map();
  const cell = (key, kind) => { const c = new Cell(kind); cells.set(key, c); return c; };
  const tiles = [];
  const tile = (key, label, value, c, sub) => tiles.push({ key, label, value, cell: c, sub, type: 'money' });
  const tInv = cell('t:invoiced', 'inv'); inRange.forEach((i) => tInv.add(i.id));
  const tRec = cell('t:received', 'pay'); pays.forEach((p) => tRec.add(p.id));
  const tOut = cell('t:outstanding', 'inv'); live.filter((i) => outstandingOf(i) > 0.5).forEach((i) => tOut.add(i.id));
  tile('invoiced', 'Invoiced', rupees(inRange.reduce((n, i) => n + i.netAmount, 0)), tInv, inRange.length ? `${inRange.length} invoices · before GST, after credit notes` : 'no invoices in this period');
  tile('received', 'Received', rupees(pays.reduce((n, p) => n + Number(p.amount || 0), 0)), tRec, pays.length ? `${pays.length} payments` : 'no payments in this period');
  tile('outstanding', 'Still to come', rupees(live.reduce((n, i) => n + outstandingOf(i), 0)), tOut, 'all open invoices, now');
  tiles.push({ key: 'recruiters', label: 'Recruiters billed', value: new Set(inRange.map((i) => i.rec.key)).size, cell: null, sub: 'with an invoice in this period', type: 'num' });

  // One table builder: rows keyed by `keyOf`, the same four money columns.
  const table = (id, title, sub, first, keyOf, labelOf, refsOf) => {
    const rows = new Map();
    const rowOf = (i) => {
      const k = keyOf(i);
      if (!rows.has(k)) {
        rows.set(k, {
          key: k, refs: refsOf ? refsOf(i) : {},
          v: { [first.key]: labelOf(i), invoices: 0, invoiced: 0, received: 0, outstanding: 0 },
          cells: { invoices: cell(`${id}:${k}:inv`, 'inv'), received: cell(`${id}:${k}:rec`, 'pay'), outstanding: cell(`${id}:${k}:out`, 'inv') },
        });
      }
      return rows.get(k);
    };
    inRange.forEach((i) => { const r = rowOf(i); r.v.invoices += 1; r.v.invoiced += i.netAmount; r.cells.invoices.add(i.id); });
    pays.forEach((p) => { const i = invById.get(p.invoiceId); if (!i) return; const r = rowOf(i); r.v.received += Number(p.amount || 0); r.cells.received.add(p.id); });
    live.forEach((i) => { const o = outstandingOf(i); if (o <= 0.5) return; const r = rowOf(i); r.v.outstanding += o; r.cells.outstanding.add(i.id); });
    const list = [...rows.values()];
    const total = { [first.key]: 'Total', invoices: 0, invoiced: 0, received: 0, outstanding: 0 };
    list.forEach((r) => { ['invoiced', 'received', 'outstanding'].forEach((k) => { r.v[k] = rupees(r.v[k]); total[k] += r.v[k]; }); total.invoices += r.v.invoices; });
    const columns = [
      first,
      { key: 'invoices', label: 'Invoices', type: 'num', drill: true },
      { key: 'invoiced', label: 'Invoiced ₹', type: 'money', drill: true },
      { key: 'received', label: 'Received ₹', type: 'money', drill: true },
      { key: 'outstanding', label: 'Still to come ₹', type: 'money', drill: true, now: true },
    ];
    const cellFor = (r, col) => ({ invoices: r.cells.invoices, invoiced: r.cells.invoices, received: r.cells.received, outstanding: r.cells.outstanding })[col];
    const totalCells = { invoices: tInv, invoiced: tInv, received: tRec, outstanding: tOut };
    return { id, title, sub, columns, list, total, cellFor, totalCells, paged: list.length > 25 };
  };
  const byRec = table('recruiters', 'Money per recruiter', 'Invoiced is before GST and after issued credit notes. Click any amount for the invoices behind it.',
    { key: 'recruiter', label: 'Recruiter', type: 'text' }, (i) => i.rec.key, (i) => i.rec.name);
  byRec.list.sort((a, b) => b.v.invoiced - a.v.invoiced || b.v.outstanding - a.v.outstanding);
  const byMonth = table('months', 'Money per recruiter per month', 'Invoiced by the invoice date, Received by the payment date.',
    { key: 'who', label: 'Recruiter · month', type: 'text' },
    (i) => `${i.rec.key}|${String(i.invoiceDate || '').slice(0, 7) || '—'}`,
    (i) => `${i.rec.name} · ${monthLabel(String(i.invoiceDate || '').slice(0, 7))}`);
  byMonth.list.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  const byClient = table('clients', 'Money per recruiter per client', 'Which clients each recruiter\'s billing comes from.',
    { key: 'who', label: 'Recruiter · client', type: 'text', ref: 'client' },
    (i) => `${i.rec.key}|${i.clientId}`, (i) => `${i.rec.name} · ${(i.client && i.client.name) || '—'}`, (i) => ({ client: i.clientId }));
  byClient.list.sort((a, b) => b.v.invoiced - a.v.invoiced);

  const notes = [];
  const un = inRange.filter((i) => i.rec.key === '—');
  if (un.length) notes.push(`${un.length} invoice(s) name no recruiter: the job has no recruiter and the candidate has no application at that client. They are in the "${UNATTRIBUTED}" row.`);
  if (!invs.length) notes.push('No invoices in your area for these filters.');
  return {
    P, tiles, cells, sections: [byRec, byMonth, byClient], invById, pays, notes, options: { invs },
  };
}

function payload(user, b) {
  return {
    report: 'recruiter-revenue',
    title: 'Recruiter revenue',
    scope: scopeLabel(user, 'accounts'),
    period: b.P ? { key: b.P.key, label: b.P.label, from: b.P.from, to: b.P.to } : { key: 'all', label: 'All time' },
    dateBasis: 'Date range: Invoiced by the invoice date, Received by the payment date. Still to come is as of today. Figures are after issued credit / debit notes.',
    tiles: b.tiles.map((t) => ({ key: t.key, label: t.label, sub: t.sub, type: t.type, value: t.value, drill: !!(t.cell && t.cell.n), now: t.key === 'outstanding' })),
    sections: b.sections.map((sec) => ({
      id: sec.id, title: sec.title, sub: sec.sub, paged: !!sec.paged, groupBy: null, groupings: null,
      columns: sec.columns.map((c) => ({ ...c, drill: !!c.drill, ref: c.ref || null })),
      rows: sec.list.map((r) => ({ key: r.key, refs: r.refs, c: sec.columns.map((c) => r.v[c.key]) })),
      total: sec.columns.map((c) => sec.total[c.key]),
    })),
    notes: b.notes,
    counts: { applications: b.options.invs.length, requirements: b.options.invs.length },
    plain: true,
  };
}

function drill(b, q) {
  const secId = String(q.section || '');
  const col = String(q.col || '');
  let c = null;
  let title = '';
  if (secId === 'tiles') {
    const t = b.tiles.find((x) => x.key === col);
    if (t) { c = t.cell; title = t.label; }
  } else {
    const sec = b.sections.find((x) => x.id === secId);
    if (sec) {
      const row = String(q.row || '');
      const label = (sec.columns.find((x) => x.key === col) || {}).label || '';
      if (row === '__total__') { c = sec.totalCells[col]; title = `Total · ${label}`; } else {
        const r = sec.list.find((x) => x.key === row);
        if (r) { c = sec.cellFor(r, col); title = `${r.v[sec.columns[0].key]} · ${label}`; }
      }
    }
  }
  if (!c) return null;
  if (c.kind === 'pay') {
    const pays = b.pays.filter((p) => c.ids.has(p.id)).sort((x, y) => String(y.date).localeCompare(String(x.date)));
    return {
      title, kind: 'pay', total: pays.length,
      columns: [{ key: 'date', label: 'Paid on' }, { key: 'number', label: 'Invoice', ref: 'inv' }, { key: 'recruiter', label: 'Recruiter' }, { key: 'client', label: 'Client' }, { key: 'amount', label: 'Amount ₹', type: 'num' }, { key: 'method', label: 'How' }, { key: 'reference', label: 'Reference' }],
      rows: pays.map((p) => {
        const i = b.invById.get(p.invoiceId) || {};
        return { refs: { inv: p.invoiceId }, cells: { date: p.date, number: i.invoiceNumber || '—', recruiter: i.rec ? i.rec.name : '—', client: (i.client && i.client.name) || '—', amount: rupees(p.amount), method: p.method || '—', reference: p.reference || '—' } };
      }),
    };
  }
  const invs = [...c.ids].map((id) => b.invById.get(id)).filter(Boolean).sort((x, y) => String(y.invoiceDate).localeCompare(String(x.invoiceDate)));
  return {
    title, kind: 'inv', total: invs.length,
    columns: [{ key: 'number', label: 'Invoice', ref: 'inv' }, { key: 'recruiter', label: 'Recruiter' }, { key: 'client', label: 'Client' }, { key: 'candidate', label: 'For' }, { key: 'date', label: 'Invoice date' }, { key: 'amount', label: 'Amount ₹ (before GST, after notes)', type: 'num' }, { key: 'outstanding', label: 'Still to come ₹', type: 'num' }, { key: 'status', label: 'Status' }],
    rows: invs.map((i) => {
      const status = A.deriveInvoiceStatus(i);
      return {
        refs: { inv: i.id },
        cells: {
          number: i.invoiceNumber || '—', recruiter: i.rec ? i.rec.name : '—', client: (i.client && i.client.name) || '—', candidate: (i.candidate && i.candidate.name) || '—',
          date: i.invoiceDate || '—', amount: rupees(i.netAmount), outstanding: rupees(Math.max(0, A.invoiceOutstanding(i))), status: status === 'Overdue' ? 'Late' : status,
        },
      };
    }),
  };
}

// The cascading filter options, counted over the report's own invoices.
function facets(b, q) {
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  let want = s(q.recruiter).replace(/^id:/, 'u:').replace(/^name:/, 'n:');
  if (want.startsWith('n:')) want = `n:${want.slice(2).toLowerCase()}`;
  const recOk = (i) => !want || i.rec.key === want || (want.startsWith('n:') && i.rec.name.toLowerCase() === want.slice(2));
  const pickWithout = (key) => b.options.invs.filter((i) => {
    if (key !== 'clientId' && s(q.clientId) && i.clientId !== s(q.clientId)) return false;
    if (key !== 'department' && s(q.department) && (i.client && i.client.ownerDepartment) !== s(q.department)) return false;
    if (key !== 'recruiter' && !recOk(i)) return false;
    return true;
  });
  const count = (list, get, label) => {
    const m = new Map();
    list.forEach((i) => { const v = get(i); if (!v) return; const e = m.get(v) || { value: v, label: label(i), count: 0 }; e.count += 1; m.set(v, e); });
    return [...m.values()].sort((a, b2) => b2.count - a.count || a.label.localeCompare(b2.label));
  };
  return {
    department: count(pickWithout('department'), (i) => i.client && i.client.ownerDepartment, (i) => i.client.ownerDepartment),
    clientId: count(pickWithout('clientId'), (i) => i.clientId, (i) => (i.client && i.client.name) || '—'),
    recruiter: count(pickWithout('recruiter'), (i) => (i.rec.key === '—' ? null : i.rec.key), (i) => i.rec.name),
  };
}

module.exports = { build, payload, drill, facets };
