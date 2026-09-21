import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { canManageAccounts } from '../permissions';


// "Received and Paid mean the same thing — the whole invoice is in."
const FALLBACK_STATUS = ['All', 'Pending', 'Received', 'Partially Paid', 'Paid', 'Overdue', 'Cancelled'];

// Indian digit grouping, with and without paise — the two the accounting
// application uses: money() in tables and totals, money2() wherever the exact
// rupee matters (an invoice account, an instalment, the printed document).
export const money = (n) => (n === '' || n == null ? '—' : `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`);
export const money2 = (n) => `₹${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "18 Aug 2026" — dates read the way the application writes them, never ISO.
export const fmtD = (s) => {
  if (!s) return '—';
  const d = new Date(String(s).slice(0, 10));
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

export function statusClass(status) {
  if (status === 'Overdue') return 'priority-high';
  if (status === 'Paid') return 'priority-low';
  if (status === 'Partially Paid') return 'priority-medium';
  return '';
}

export function Stat({ n, l, s, tone }) {
  return (
    <div className={`statitem${tone ? ` acct-${tone}` : ''}`}>
      <div className="n">{n}</div>
      <div className="l">{l}</div>
      {s && <div className="s">{s}</div>}
    </div>
  );
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------------------
// The printable tax invoice. Everything on it comes from
// GET /invoices/:id/document, so the paper copy can never disagree with the
// register. The client copy is what gets emailed; the internal copy adds the
// recruiter and the department and is never sent out.
// ---------------------------------------------------------------------------
export function invoiceDocumentHtml(d, mode) {
  const forClient = mode !== 'internal';
  const showRec = !forClient && d.lines.some((l) => l.recruiter);
  const gst = d.totals.gst;
  const n = (v) => money2(v).replace('₹', '');
  const taxHead = d.inter
    ? '<th colspan="2" class="grp">IGST</th>'
    : '<th colspan="2" class="grp">CGST</th><th colspan="2" class="grp">SGST</th>';
  const taxSub = d.inter
    ? '<th class="n sm">%</th><th class="n sm">Amt</th>'
    : '<th class="n sm">%</th><th class="n sm">Amt</th><th class="n sm">%</th><th class="n sm">Amt</th>';
  const style = `
  @page{size:A4;margin:10mm}
  *{box-sizing:border-box}
  body{margin:0;font:11px/1.4 Arial,Helvetica,sans-serif;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .inv{border:1px solid #000;max-width:190mm;margin:0 auto;min-height:272mm;display:flex;flex-direction:column}
  .pageno{max-width:190mm;margin:2mm auto 0;text-align:right;font-size:9px;color:#333}
  table{border-collapse:collapse;width:100%}
  .hd{display:flex;border-bottom:1px solid #000}
  .hd .lg{width:140px;padding:10px;display:flex;align-items:flex-start}
  .hd .lg img{max-width:130px;max-height:52px;object-fit:contain}
  .hd .co{flex:1;padding:10px 8px}
  .hd .co h1{margin:0 0 4px;font-size:14px;font-weight:bold;text-transform:uppercase;max-width:30ch;line-height:1.25}
  .hd .co .l{font-size:10px;line-height:1.5}
  .hd .ti{width:230px;padding:12px 14px;display:flex;align-items:center;justify-content:flex-end}
  .hd .ti span{font-size:26px}
  .meta{display:flex;border-bottom:1px solid #000}
  .meta .l{flex:1;border-right:1px solid #000}
  .meta .r{flex:1;padding:6px 10px;font-size:10.5px}
  .meta table td{padding:3px 10px;font-size:10.5px;vertical-align:top}
  .meta table td.k{color:#333;width:44%}
  .meta table td.v{font-weight:bold}
  .band{background:#e8e8e8;padding:4px 10px;font-weight:bold;font-size:10.5px;border-bottom:1px solid #000}
  .bill{padding:9px 10px;border-bottom:1px solid #000;font-size:10.5px;line-height:1.55}
  .bill .nm{font-weight:bold;font-size:12px;text-transform:uppercase;margin-bottom:2px}
  table.items th{background:#e8e8e8;border:1px solid #000;padding:5px 6px;font-size:10px;font-weight:bold;text-align:left}
  table.items th.grp{text-align:center}
  table.items th.sm{font-weight:normal;font-size:9.5px}
  table.items td{border:1px solid #000;padding:6px;font-size:10.5px;vertical-align:top}
  table.items td.n,table.items th.n{text-align:right}
  table.items td.c{text-align:center}
  .desc .sub{color:#555;font-size:9.5px;margin-top:2px}
  td.rec{text-align:center;font-weight:600;font-size:10px}
  .foot{display:flex;border-top:1px solid #000}
  .foot .lft{flex:1.15;padding:9px 10px;border-right:1px solid #000;position:relative}
  .foot .rgt{width:44%}
  .blank{flex:1}
  .words b{display:block;font-size:10px;font-weight:normal;color:#333}
  .words i{font-style:italic;font-weight:bold;font-size:10.5px;display:block;margin-top:2px}
  .notes{margin-top:10px;font-size:10px;line-height:1.5}
  .notes b{display:block;font-size:10px;color:#333;font-weight:normal;margin-bottom:2px}
  .tot td{padding:5px 12px;font-size:11px}
  .tot td.n{text-align:right;white-space:nowrap}
  .tot tr.g td{font-weight:bold;border-top:1px solid #000}
  .tot tr.b td{font-weight:bold;font-size:12.5px;border-top:1px solid #000;border-bottom:1px solid #000}
  .sign{min-height:120px;border-top:1px solid #000;text-align:center;padding:6px 4px 10px}
  .sign span{display:block;font-size:10.5px;padding-top:3px;border-top:1px solid #000;width:70%;margin:46px auto 0}
  .tdsnote{padding:6px 10px;border-top:1px solid #000;font-size:9.5px;color:#333}
  `;
  const co = d.company;
  const rows = d.lines.map((l) => `<tr>
    <td class="c">${l.n}</td>
    <td class="desc">${esc(l.description)}${(!forClient && l.department) ? `<div class="sub">${esc(l.department)}</div>` : ''}</td>
    ${showRec ? `<td class="rec">${esc(l.recruiter || '—')}</td>` : ''}
    <td class="n">${l.salary != null ? String(Math.round(l.salary)) : ''}</td>
    <td class="n">${esc(l.sac)}</td>
    <td class="n">${Number(l.qty).toFixed(2)}</td>
    <td class="n">${n(l.rate)}</td>
    ${gst > 0 ? (d.inter
    ? `<td class="n">${d.gstPct}%</td><td class="n">${n(l.gst)}</td>`
    : `<td class="n">${d.halfPct}%</td><td class="n">${n(l.cgst)}</td><td class="n">${d.halfPct}%</td><td class="n">${n(l.sgst)}</td>`) : ''}
    <td class="n">${n(l.amount)}</td>
  </tr>`).join('');

  const inner = `<div class="inv">
    <div class="hd">
      <div class="lg">${co.logoUrl ? `<img src="${esc(co.logoUrl)}" alt="">` : ''}</div>
      <div class="co">
        <h1>${esc(co.legalName)}</h1>
        <div class="l">${co.addressLines.map(esc).join('<br>')}${co.gstin ? `<br>GSTIN ${esc(co.gstin)}` : ''}</div>
      </div>
      <div class="ti"><span>${d.title}</span></div>
    </div>
    <div class="meta">
      <div class="l"><table>
        <tr><td class="k">#</td><td class="v">: ${esc(d.invoiceNumber)}</td></tr>
        <tr><td class="k">Invoice Date</td><td class="v">: ${fmtD(d.invoiceDate)}</td></tr>
        <tr><td class="k">Terms</td><td class="v">: ${esc(d.terms)}</td></tr>
        <tr><td class="k">Due Date</td><td class="v">: ${fmtD(d.dueDate)}</td></tr>
        <tr><td class="k">Billing Type</td><td class="v">: ${esc(d.billingType)}</td></tr>
      </table></div>
      <div class="r"><table><tr><td class="k">Place Of Supply</td><td class="v">: ${esc(d.placeOfSupply)}</td></tr></table></div>
    </div>
    ${forClient ? '' : '<div class="band" style="background:#FBF3DE;color:#7A5A08">INTERNAL COPY — recruiter and department shown · not for the client</div>'}
    <div class="band">Bill To</div>
    <div class="bill">
      <div class="nm">${esc(d.client.name)}</div>
      ${d.client.addressLines.map(esc).join(',<br>')}${d.client.addressLines.length ? '<br>' : ''}
      ${d.client.gstin ? `GSTIN ${esc(d.client.gstin)}` : (forClient ? '' : '<span style="color:#B3261E">Client GSTIN not on file — add it in Client Master</span>')}
    </div>
    <table class="items">
      <thead>
        <tr>
          <th rowspan="2" style="width:26px">#</th>
          <th rowspan="2">Item &amp; Description</th>
          ${showRec ? '<th rowspan="2" style="width:74px">Recruiter</th>' : ''}
          <th rowspan="2" class="n" style="width:60px">Salary</th>
          <th rowspan="2" class="n" style="width:66px">HSN/SAC</th>
          <th rowspan="2" class="n" style="width:40px">Qty</th>
          <th rowspan="2" class="n" style="width:76px">Rate</th>
          ${gst > 0 ? taxHead : ''}
          <th rowspan="2" class="n" style="width:82px">Amount</th>
        </tr>
        <tr>${gst > 0 ? taxSub : ''}</tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="foot">
      <div class="lft">
        <div class="words"><b>Total In Words</b><i>${esc(d.words.total)}</i></div>
        ${d.words.netAfterTds ? `<div class="words"><b>Net Payable After TDS In Words</b><i>${esc(d.words.netAfterTds)}</i></div>` : ''}
        <div class="notes"><b>Notes</b>
          ${esc(co.bank.accountName)}<br>
          ${co.bank.accountNumber ? `Account Number: ${esc(co.bank.accountNumber)}<br>` : ''}
          ${co.bank.ifsc ? `IFSC: ${esc(co.bank.ifsc)}<br>` : ''}
          ${co.bank.branch ? `Branch: ${esc(co.bank.branch)}<br>` : ''}
          ${co.bank.accountType ? `Account Type: ${esc(co.bank.accountType)}<br>` : ''}
          ${co.bank.upi ? `Virtual Payment Address: ${esc(co.bank.upi)}` : ''}
        </div>
      </div>
      <div class="rgt">
        <table class="tot">
          <tr><td>Sub Total</td><td class="n">${n(d.totals.subTotal)}</td></tr>
          ${gst > 0 ? (d.inter
    ? `<tr><td>IGST${d.gstPct} (${d.gstPct}%)</td><td class="n">${n(d.totals.gst)}</td></tr>`
    : `<tr><td>CGST${d.halfPct} (${d.halfPct}%)</td><td class="n">${n(d.totals.cgst)}</td></tr>
                 <tr><td>SGST${d.halfPct} (${d.halfPct}%)</td><td class="n">${n(d.totals.sgst)}</td></tr>`) : ''}
          <tr class="g"><td>Total</td><td class="n">${money2(d.totals.invoiceValue)}</td></tr>
          ${d.totals.tds > 0 ? `<tr><td>Less: TDS @ ${d.tdsPct}% u/s 194J</td><td class="n">(${n(d.totals.tds)})</td></tr>
            <tr class="g"><td>Net Payable After TDS</td><td class="n">${money2(d.totals.receivable)}</td></tr>` : ''}
          ${d.totals.paid > 0 ? `<tr><td>Amount Received</td><td class="n">${n(d.totals.paid)}</td></tr>` : ''}
          <tr class="b"><td>Balance Due</td><td class="n">${money2(d.totals.balance)}</td></tr>
        </table>
        <div class="sign"><span>Authorized Signature</span></div>
      </div>
    </div>
    <div class="blank"></div>
    ${d.totals.tds > 0 ? `<div class="tdsnote">TDS @ ${d.tdsPct}% u/s 194J (${money2(d.totals.tds)}) is deductible on the professional fee only, not on GST. Net payable after TDS: ${money2(d.totals.balance)}. Kindly share Form 16A after deduction.</div>` : ''}
  </div>
  <div class="pageno">1</div>`;
  return { style, inner };
}

// Open the printable copy in its own window and send it to the printer.
export async function openInvoicePrint(invoiceId, mode) {
  const { data } = await api.get(`/invoices/${invoiceId}/document`);
  const { style, inner } = invoiceDocumentHtml(data, mode);
  const w = window.open('', '_blank');
  if (!w) throw new Error('Allow pop-ups to print');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(data.invoiceNumber)} — ${esc(data.client.name)}</title><style>${style}</style></head><body>${inner}</body></html>`);
  w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch { /* blocked */ } }, 450);
}

// The invoice lens: the column set the accounting application offers, in its
// own order. Invoice no, date, client, received and pending are always on; the
// rest are yours to show or hide.
const WORK_COLS = [
  ['btype', 'Billing type'], ['gstyn', 'Client paying GST'], ['cgstin', 'Client GSTIN'],
  ['dept', 'Department'], ['rec', 'Recruiter'], ['cand', 'Candidates'],
  ['before', 'Before GST'], ['gst', 'GST'], ['after', 'After GST'], ['tds', 'TDS'], ['receivable', 'Receivable'],
  ['pays', 'Payments'], ['proof', 'Proof'], ['tdscert', 'TDS certificate'],
  ['status', 'Status'], ['due', 'Due date'], ['age', 'Age'], ['sent', 'Sent'],
];

// Everything except "Sent" is on out of the box, exactly as the application
// opens: the accountant hides what they do not want, rather than hunting for
// the column they do.
const DEFAULT_COLS = {
  btype: true, gstyn: true, cgstin: true, dept: true, rec: true, cand: true,
  before: true, gst: true, after: true, tds: true, receivable: true,
  pays: true, proof: true, tdscert: true, status: true, due: true, age: true, sent: false,
};

// The table header says "TDS cert"; the column chooser spells it out.
const HEADER_LABEL = { tdscert: 'TDS cert' };

const GROUP_BY = [['inv', 'Invoice'], ['client', 'Client'], ['dept', 'Department'], ['rec', 'Recruiter'], ['month', 'Invoice month']];

const NUM_COLS = new Set(['cand', 'before', 'gst', 'after', 'tds', 'receivable', 'received', 'pending', 'pays']);

const VIEWS_KEY = 'tl.invoices.savedViews';

const loadViews = () => {
  try { return JSON.parse(localStorage.getItem(VIEWS_KEY) || '[]'); } catch { return []; }
};

const BLANK_FILTERS = { client: 'All', dept: 'All', rec: 'All', gstin: 'All', status: 'All', q: '' };

export default function Invoices() {
  const { user } = useAuth();
  const canManage = canManageAccounts(user);

  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [period, setPeriod] = useState('all');
  const [filters, setFilters] = useState(BLANK_FILTERS);
  const [age, setAge] = useState('All');
  const [group, setGroup] = useState('inv');
  const [cols, setCols] = useState(DEFAULT_COLS);
  const [showCols, setShowCols] = useState(false);
  const [open, setOpen] = useState({});
  const [views, setViews] = useState(loadViews);

  const load = useCallback(() => {
    api.get('/invoices/register', { params: { period } })
      .then((res) => setData(res.data))
      .catch((e) => setError(e.response?.data?.error || 'That did not work.'));
  }, [period]);
  useEffect(load, [load]);

  async function run(fn) {
    setError('');
    try { await fn(); load(); } catch (e) { setError(e.response?.data?.error || e.message || 'That did not work.'); }
  }

  const stance = data?.gstStance || {};

  const rows = useMemo(() => {
    if (!data) return [];
    return data.rows.filter((r) => {
      if (filters.client !== 'All' && r.client !== filters.client) return false;
      if (filters.dept !== 'All' && r.department !== filters.dept) return false;
      if (filters.rec !== 'All' && r.recruiter !== filters.rec) return false;
      // "Received and Paid mean the same thing — the whole invoice is in."
      if (filters.status !== 'All' && r.status !== (filters.status === 'Received' ? 'Paid' : filters.status)) return false;
      // Yes / No read the invoice in front of you. Never, Always and Both ways
      // read the client's whole history.
      if (filters.gstin === 'Yes' && !r.clientPayingGst) return false;
      if (filters.gstin === 'No' && r.clientPayingGst) return false;
      if (filters.gstin === 'Never' && stance[r.client] !== 'never') return false;
      if (filters.gstin === 'Always' && stance[r.client] !== 'always') return false;
      if (filters.gstin === 'Mixed' && stance[r.client] !== 'mixed') return false;
      if (age !== 'All' && r.age !== age) return false;
      const q = filters.q.trim().toLowerCase();
      if (q && ![r.invoiceNumber, r.client, r.candidateName, r.department, r.recruiter, r.clientGstin]
        .join(' ').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, filters, age, stance]);

  // The table's own column order, which is not the column chooser's order:
  // invoice no, date and client are always on, then the optional columns in
  // the order the invoice lens lays them out, then received / pending, then
  // the paperwork columns and the actions.
  const active = useMemo(() => {
    const C = [['inv', 'Invoice no'], ['date', 'Invoice date'], ['client', 'Client']];
    const push = (k) => { if (cols[k]) C.push([k, HEADER_LABEL[k] || WORK_COLS.find((c) => c[0] === k)[1]]); };
    ['btype', 'cgstin', 'dept', 'rec', 'cand', 'gstyn', 'before', 'gst', 'after', 'tds', 'receivable'].forEach(push);
    C.push(['received', 'Received'], ['pending', 'Pending']);
    ['pays', 'proof', 'tdscert', 'status', 'due', 'age', 'sent'].forEach(push);
    C.push(['act', 'Actions']);
    return C;
  }, [cols]);

  if (!data) return <div className="small-muted">Loading…</div>;
  const k = data.kpis;
  const ni = data.noInvoice || { waiting: 0, groups: [], notBillable: [] };

  const groupKeyOf = (r) => (group === 'client' ? r.client
    : group === 'dept' ? (r.department || '—')
      : group === 'rec' ? (r.recruiter || 'not assigned')
        : group === 'month' ? (r.invoiceMonthLabel || '—') : null);

  const sum = (list, f) => Math.round(list.reduce((s, r) => s + f(r), 0) * 100) / 100;
  const totals = {
    cand: sum(rows, (r) => r.candidates),
    before: sum(rows, (r) => r.billing),
    gst: sum(rows, (r) => r.gst),
    after: sum(rows, (r) => r.invoiceValue),
    tds: sum(rows, (r) => r.tds),
    receivable: sum(rows, (r) => r.receivable),
    received: sum(rows, (r) => r.received),
    pending: sum(rows, (r) => r.pending),
  };

  const cell = (key, r) => {
    switch (key) {
      case 'inv': return (
        <td key={key}>
          <button className="acct-exp" onClick={() => setOpen({ ...open, [r.id]: !open[r.id] })} title="Open everything about this invoice here">{open[r.id] ? '▾' : '▸'}</button>
          <Link to={`/invoices/${r.id}`}>{r.invoiceNumber}</Link>
        </td>
      );
      case 'date': return <td key={key}>{fmtD(r.invoiceDate)}</td>;
      case 'client': return <td key={key}>{r.client}</td>;
      case 'btype': return <td key={key} className="small-muted">{r.billingType}</td>;
      case 'gstyn': return <td key={key}><span className={`status ${r.clientPayingGst ? 'priority-low' : ''}`}>{r.clientPayingGst ? 'Yes' : 'No'}</span></td>;
      case 'cgstin': return (
        <td key={key} className="small-muted">
          {r.clientGstinKind === 'number' ? r.clientGstinText
            : r.clientGstinKind === 'warn' ? <span className="status priority-medium">{r.clientGstinText}</span>
              : (r.gst > 0.5 ? <span className="status priority-high">missing</span> : r.clientGstinText)}
        </td>
      );
      case 'dept': return <td key={key}>{r.department}</td>;
      case 'rec': return <td key={key}>{r.recruiter || <span className="status priority-medium">not assigned</span>}</td>;
      case 'cand': return <td key={key} className="num">{r.candidates}</td>;
      case 'before': return <td key={key} className="num" style={{ fontWeight: 600 }}>{money(r.billing)}</td>;
      case 'gst': return <td key={key} className="num">{money(r.gst)}</td>;
      case 'after': return <td key={key} className="num" style={{ fontWeight: 600 }}>{money(r.invoiceValue)}</td>;
      case 'tds': return <td key={key} className="num">{money(r.tds)}</td>;
      case 'receivable': return <td key={key} className="num">{money(r.receivable)}</td>;
      case 'received': return <td key={key} className="num">{money(r.received)}</td>;
      case 'pending': return <td key={key} className="num" style={{ fontWeight: 600 }}>{money(r.pending)}</td>;
      case 'pays': return (
        <td key={key} className="num">
          {r.paymentCount || '—'}
          {r.paymentCount ? <div className="small-muted">{r.paymentMethods.join(', ')}</div> : null}
        </td>
      );
      case 'proof': return <td key={key}>{r.proof ? <span className={`status ${r.proof === 'attached' ? 'priority-low' : 'priority-high'}`}>{r.proof}</span> : <span className="small-muted">—</span>}</td>;
      case 'tdscert': return (
        <td key={key} style={{ whiteSpace: 'nowrap' }}>
          {/* The amount is what matters — how much TDS is riding on this
              invoice — so it leads. */}
          {r.tdsCert
            ? (
              <>
                <b>{money2(r.tds)}</b>{' '}
                <span className={`status ${r.tdsCert === 'in hand' ? 'priority-low' : 'priority-high'}`}>{r.tdsCert}</span>
                {canManage && (
                  <button className="btn btn-sm" style={{ marginLeft: 6 }} onClick={() => run(() => api.patch(`/invoices/${r.id}/tds-certificate`, { received: r.tdsCert !== 'in hand' }))}>
                    {r.tdsCert === 'in hand' ? 'Undo' : 'Got it'}
                  </button>
                )}
              </>
            )
            : <span className="small-muted">no TDS</span>}
        </td>
      );
      case 'status': return <td key={key}><span className={`status ${statusClass(r.status)}`}>{r.status}</span></td>;
      case 'due': return <td key={key}>{fmtD(r.dueDate)}</td>;
      case 'age': return (
        <td key={key}>
          <span className={`status ${r.age === '90+ days' || r.age === '61–90 days' ? 'priority-high' : r.age === 'Settled' ? 'priority-low' : ''}`}>{r.age}</span>
          {r.daysOverdue > 0 && r.pending > 0.5 && <div className="small-muted">{r.daysOverdue} day(s)</div>}
        </td>
      );
      case 'sent': return (
        <td key={key}>
          {r.sentVia
            ? <span className="status priority-low">{r.sentVia} · {fmtD(r.sentDate)}</span>
            : (
              <>
                <span className="status">Not sent</span>
                {canManage && <button className="btn btn-sm" style={{ marginLeft: 6 }} onClick={() => run(() => api.patch(`/invoices/${r.id}/sent`, { via: 'Email' }))}>Mark sent</button>}
              </>
            )}
        </td>
      );
      default: return (
        <td key={key} style={{ whiteSpace: 'nowrap' }}>
          <div className="qa-row">
            <Link className="btn btn-sm btn-primary" to={`/invoices/${r.id}`}>₹ Account</Link>
            <button className="btn btn-sm" onClick={() => run(() => openInvoicePrint(r.id, 'client'))}>👁 View</button>
            {canManage && r.pending > 0.5 && r.status !== 'Cancelled' && (
              <Link className="btn btn-sm" to={`/invoices/${r.id}`}>＋ Payment</Link>
            )}
            {canManage && r.pending > 0.5 && r.status !== 'Cancelled' && (
              <button className="btn btn-sm" onClick={() => run(() => api.patch(`/invoices/${r.id}/pay`))}>Settle in full</button>
            )}
          </div>
        </td>
      );
    }
  };

  // Everything about one invoice, opened inside the row.
  const expandRow = (r) => (
    <tr key={`${r.id}-exp`} className="acct-kid">
      <td colSpan={active.length}>
        <div className="grid-2">
          <div>
            <div className="section-label">What this invoice is made of</div>
            <div className="kv"><span className="k">Fee before GST</span><span>{money2(r.billing)}</span></div>
            <div className="kv"><span className="k">GST charged{r.gstPercent != null ? ` @ ${r.gstPercent}%` : ''}</span><span>{money2(r.gst)}</span></div>
            <div className="kv"><span className="k">Invoice value after GST</span><span>{money2(r.invoiceValue)}</span></div>
            <div className="kv"><span className="k">Less TDS deducted by client{r.tdsPercent != null ? ` @ ${r.tdsPercent}%` : ''}</span><span>({money2(r.tds)})</span></div>
            <div className="kv" style={{ fontWeight: 700 }}><span className="k">Amount receivable</span><span>{money2(r.receivable)}</span></div>
            <div className="kv"><span className="k">Received so far</span><span>{money2(r.received)}</span></div>
            <div className="kv" style={{ fontWeight: 700 }}><span className="k">Still pending</span><span>{money2(r.pending)}</span></div>
          </div>
          <div>
            <div className="section-label">Dates &amp; papers</div>
            <div className="kv"><span className="k">Invoice date</span><span>{fmtD(r.invoiceDate)}</span></div>
            <div className="kv"><span className="k">Payment due</span><span>{fmtD(r.dueDate)}</span></div>
            <div className="kv"><span className="k">Age</span><span>{r.age}</span></div>
            <div className="kv"><span className="k">Sent to client</span><span>{r.sentVia ? `${r.sentVia} · ${fmtD(r.sentDate)}` : 'not sent'}</span></div>
            <div className="kv"><span className="k">TDS certificate</span><span>{r.tdsCert ? `${money2(r.tds)} ${r.tdsCert}` : 'no TDS'}</span></div>
            <div className="kv"><span className="k">Candidate</span><span>{r.candidateName || '—'}</span></div>
            <div className="kv"><span className="k">Recruiter</span><span>{r.recruiter || 'not assigned'}</span></div>
            <div className="kv"><span className="k">Billing type</span><span>{r.billingType}</span></div>
          </div>
        </div>
        <div className="section-label" style={{ marginTop: 14 }}>Payments against this invoice</div>
        {r.payments.length === 0
          ? <div className="small-muted">No payment recorded against this invoice yet.</div>
          : (
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="num">#</th><th>Paid on</th><th className="num">Amount</th>
                    <th>Method</th><th>Reference</th><th className="num">Balance after</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    let run2 = 0;
                    return r.payments.map((p, i) => {
                      run2 += Number(p.amount || 0);
                      return (
                        <tr key={p.id}>
                          <td className="num">{i + 1}</td>
                          <td>{fmtD(p.date)}</td>
                          <td className="num" style={{ fontWeight: 600 }}>{money2(p.amount)}</td>
                          <td>{p.method || '—'}</td>
                          <td>{p.reference || '—'}</td>
                          <td className="num">{money2(Math.max(0, r.receivable - run2))}</td>
                        </tr>
                      );
                    });
                  })()}
                </tbody>
              </table>
            </div>
          )}
        <div className="qa-row" style={{ marginTop: 10 }}>
          <button className="btn btn-sm" onClick={() => setOpen({ ...open, [r.id]: false })}>▴ Close</button>
          <Link className="btn btn-sm btn-primary" to={`/invoices/${r.id}`}>₹ Full account</Link>
          <button className="btn btn-sm" onClick={() => run(() => openInvoicePrint(r.id, 'client'))}>👁 Printable invoice</button>
          {canManage && <Link className="btn btn-sm" to={`/invoices/${r.id}`}>＋ Record a payment</Link>}
        </div>
      </td>
    </tr>
  );

  let body;
  if (group === 'inv') {
    body = rows.flatMap((r) => (open[r.id] ? [<tr key={r.id}>{active.map(([key]) => cell(key, r))}</tr>, expandRow(r)] : [<tr key={r.id}>{active.map(([key]) => cell(key, r))}</tr>]));
  } else {
    const map = new Map();
    rows.forEach((r) => {
      const gk = String(groupKeyOf(r) || '—');
      if (!map.has(gk)) map.set(gk, []);
      map.get(gk).push(r);
    });
    body = [...map.entries()].map(([gk, list]) => (
      <Fragment key={`g-${gk}`}>
        <tr style={{ fontWeight: 600 }}>
          <td>
            <button className="acct-exp" onClick={() => setOpen({ ...open, [`G:${gk}`]: !open[`G:${gk}`] })}>{open[`G:${gk}`] ? '▾' : '▸'}</button>
            {gk}
          </td>
          <td className="small-muted">{list.length} invoice(s)</td>
          {active.slice(2).map(([key]) => (NUM_COLS.has(key)
            ? <td key={key} className="num">{key === 'cand' ? sum(list, (r) => r.candidates) : money(sum(list, (r) => ({ before: r.billing, gst: r.gst, after: r.invoiceValue, tds: r.tds, receivable: r.receivable, received: r.received, pending: r.pending, pays: r.paymentCount }[key] || 0)))}</td>
            : <td key={key} />))}
        </tr>
        {open[`G:${gk}`] && list.flatMap((r) => [<tr key={r.id} className="acct-kid">{active.map(([key]) => cell(key, r))}</tr>, ...(open[r.id] ? [expandRow(r)] : [])])}
      </Fragment>
    ));
  }

  const saveView = () => {
    const name = window.prompt('Name this view');
    if (!name) return;
    const next = [...views.filter((v) => v.name !== name), { name, period, filters, age, group, cols }];
    setViews(next);
    try { localStorage.setItem(VIEWS_KEY, JSON.stringify(next)); } catch { /* private window */ }
  };
  const applyView = (v) => { setPeriod(v.period); setFilters(v.filters); setAge(v.age); setGroup(v.group); setCols(v.cols); };
  const deleteView = (name) => {
    const next = views.filter((v) => v.name !== name);
    setViews(next);
    try { localStorage.setItem(VIEWS_KEY, JSON.stringify(next)); } catch { /* private window */ }
  };

  // What is switched on, in the words the user picked, so a filter that finds
  // nothing can say why and be turned off one at a time.
  const activeBits = [
    period !== 'all' && { t: 'Period', v: (data.period.options.find((o) => o.value === period) || {}).label || period, fix: () => setPeriod('all') },
    filters.q.trim() && { t: 'Search', v: `"${filters.q.trim()}"`, fix: () => setFilters({ ...filters, q: '' }) },
    filters.client !== 'All' && { t: 'Client', v: filters.client, fix: () => setFilters({ ...filters, client: 'All' }) },
    filters.dept !== 'All' && { t: 'Department', v: filters.dept, fix: () => setFilters({ ...filters, dept: 'All' }) },
    filters.rec !== 'All' && { t: 'Recruiter', v: filters.rec, fix: () => setFilters({ ...filters, rec: 'All' }) },
    filters.gstin !== 'All' && { t: 'GST charged', v: filters.gstin, fix: () => setFilters({ ...filters, gstin: 'All' }) },
    filters.status !== 'All' && { t: 'Status', v: filters.status, fix: () => setFilters({ ...filters, status: 'All' }) },
    age !== 'All' && { t: 'Age', v: age, fix: () => setAge('All') },
  ].filter(Boolean);
  const resetAll = () => { setFilters(BLANK_FILTERS); setAge('All'); setPeriod('all'); };

  const anyFilter = activeBits.length > 0;
  const tc = data.tdsCertificates;
  const stanceCount = (kind) => Object.values(stance).filter((v) => v === kind).length;

  // Toggling a money chip shows or hides that column in the invoice table.
  const chip = (key, label, value) => (
    <button
      key={key}
      className={`btn btn-sm ${cols[key] ? 'btn-primary' : ''}`}
      title="Show or hide this column in the invoice table"
      onClick={() => setCols({ ...cols, [key]: !cols[key] })}
    >
      {label} <b>{money(value)}</b>
    </button>
  );

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Invoice</h1>
          <div className="page-sub">
            Everything about a client invoice on one page — filters, the headline numbers, the candidates
            and the invoice table with its account, printable copy and payments.
          </div>
        </div>
      </div>

      {error && <div className="card section error-text" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="filter-row">
        <label className="field"><span>Client · {data.clients.length}</span>
          <select value={filters.client} onChange={(e) => setFilters({ ...filters, client: e.target.value })}>
            <option>All</option>{data.clients.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label className="field" style={{ minWidth: 210 }}><span>Period</span>
          <select value={period} onChange={(e) => setPeriod(e.target.value)}>
            {data.period.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label className="field"><span>Department</span>
          <select value={filters.dept} onChange={(e) => setFilters({ ...filters, dept: e.target.value })}>
            <option>All</option>{data.departments.map((d) => <option key={d}>{d}</option>)}
          </select>
        </label>
        <label className="field"><span>Recruiter · {data.recruiters.length}</span>
          <select value={filters.rec} onChange={(e) => setFilters({ ...filters, rec: e.target.value })}>
            <option>All</option>{data.recruiters.map((r) => <option key={r}>{r}</option>)}
          </select>
        </label>
        <label className="field"><span>GST charged</span>
          <select
            title="Yes / No read the invoice in front of you. Never, Always and Both ways read the client's whole history."
            value={filters.gstin}
            onChange={(e) => setFilters({ ...filters, gstin: e.target.value })}
          >
            <option value="All">All</option>
            <option value="Yes">Yes — GST on this invoice</option>
            <option value="No">No — no GST on this invoice</option>
            <optgroup label="By the client's whole history">
              <option value="Never">Never charged GST · {stanceCount('never')}</option>
              <option value="Always">Always charged GST · {stanceCount('always')}</option>
              <option value="Mixed">Both ways — worth a look · {stanceCount('mixed')}</option>
            </optgroup>
          </select>
        </label>
        <label className="field"><span>Status</span>
          <select title="Received and Paid mean the same thing — the whole invoice is in" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
            {(data.payStatuses || FALLBACK_STATUS).map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <label className="field" style={{ minWidth: 220 }}><span>Search anything</span>
          <input value={filters.q} placeholder="Candidate, client, invoice no, position…" onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
        </label>
        {chip('gst', 'Total GST', k.gst)}
        {chip('before', 'Before GST', k.billing)}
        {chip('after', 'After GST', k.invoiceValue)}
        {chip('tds', 'TDS', k.tds)}
        {anyFilter && <button className="btn btn-sm" onClick={resetAll}>Reset all</button>}
      </div>

      {/* Joinings that are on the register and in every total, but carry no
          invoice number yet — so they cannot appear in the table below. */}
      {ni.waiting > 0 && (
        <div className="card section">
          <h3>{ni.waiting} joining(s) have no invoice number yet</h3>
          <div className="small-muted" style={{ marginBottom: 10 }}>
            They are on the register and in every total — but the invoice table below lists invoices,
            so they cannot appear there until they have a number
          </div>
          <div className="statbar">
            <Stat n={ni.waiting} l="Candidates waiting" s="no invoice raised" />
            <Stat n={money(ni.billing)} l="Fee not yet billed" s="before GST" />
            <Stat n={money(ni.invoiceValue)} l="Would invoice for" s="after GST" />
            <Stat n={ni.nextNumber} l="Next number in the series" s="carries on from your last one" />
          </div>
          <div className="tbl-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th>Client</th><th>Joining month</th><th className="num">Candidates</th>
                  <th className="num">Before GST</th><th className="num">GST</th><th className="num">After GST</th>
                  <th>Who is in it</th><th>Raise it</th>
                </tr>
              </thead>
              <tbody>
                {ni.groups.map((g) => (
                  <tr key={`${g.clientId}|${g.month}`}>
                    <td><b>{g.client}</b></td>
                    <td>{g.monthLabel}</td>
                    <td className="num">{g.rows.length}</td>
                    <td className="num">{money(g.billing)}</td>
                    <td className="num">{g.gst > 0.5 ? money(g.gst) : '—'}</td>
                    <td className="num" style={{ fontWeight: 600 }}>{money(g.invoiceValue)}</td>
                    <td className="small-muted">{g.rows.slice(0, 3).map((x) => x.name).join(', ')}{g.rows.length > 3 ? ` +${g.rows.length - 3}` : ''}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {canManage && (
                        <button className="btn btn-sm btn-primary" onClick={() => run(() => api.post('/invoices/register/raise', { clientId: g.clientId, month: g.month }))}>Give it a number</button>
                      )}
                    </td>
                  </tr>
                ))}
                {ni.groups.length === 0 && <tr><td colSpan="8" className="small-muted">Nothing can be invoiced yet.</td></tr>}
              </tbody>
            </table>
          </div>
          {ni.notBillable.length > 0 && (
            <div className="notice" style={{ marginTop: 10 }}>
              <span>
                <b>{ni.notBillable.length} of them cannot be invoiced yet</b> — there is no billing amount on the row,
                so there would be nothing to bill. Usually the client&apos;s rate or the candidate&apos;s offered CTC is
                missing. Open the row and fill it in: {ni.notBillable.slice(0, 6).map((x) => x.name).join(', ')}
                {ni.notBillable.length > 6 ? ` and ${ni.notBillable.length - 6} more` : ''}
              </span>
            </div>
          )}
          <div className="notice" style={{ marginTop: 10 }}>
            <span>
              One invoice per client per joining month, the way the tracker has always done it. The number carries on
              from the last one you used, the invoice date is today, and the payment due date follows the client&apos;s
              terms. Nothing about the billing changes — only the number and the date are written.
            </span>
          </div>
          {canManage && ni.groups.length > 0 && (
            <div className="qa-row" style={{ marginTop: 10 }}>
              <button className="btn btn-sm btn-primary" onClick={() => run(() => api.post('/invoices/register/raise', { all: true }))}>
                Give all {ni.groups.length} an invoice number
              </button>
            </div>
          )}
        </div>
      )}

      {/* A filter that finds nothing leaves a screenful of ₹0 cards and no
          reason. This says what is switched on, and clears it in one press. */}
      {rows.length === 0 && (
        <div className="card section">
          <h3>Nothing matches what is switched on</h3>
          <div className="small-muted" style={{ marginBottom: 10 }}>
            {data.rows.length} invoice(s) are in the register — none of them get past these
          </div>
          {activeBits.length > 0
            ? (
              <>
                <div className="qa-row">
                  {activeBits.map((b) => (
                    <button key={b.t} className="btn btn-sm" title="Turn this one off" onClick={b.fix}>{b.t}: {String(b.v).slice(0, 40)} ✕</button>
                  ))}
                </div>
                <div className="small-muted" style={{ marginTop: 8 }}>Press any one to turn just that off.</div>
              </>
            )
            : <div className="small-muted">No filter is on — the invoices simply are not there.</div>}
          <div className="qa-row" style={{ marginTop: 10 }}>
            <button className="btn btn-sm btn-primary" onClick={resetAll}>Clear everything and show all {data.rows.length}</button>
          </div>
        </div>
      )}

      <div className="statbar">
        <Stat n={k.candidates} l="Total candidates" s={`${k.candidates} billed · no drops`} />
        <Stat n={k.clients} l="Total clients" s={`${k.invoices} invoice(s)${ni.waiting ? ` · ${ni.waiting} not invoiced yet` : ''}`} />
        <Stat n={money(k.invoiceValue)} l="Total amount" s={`before GST ${money(k.billing)} + GST ${money(k.gst)} = ${money(k.invoiceValue)} − TDS ${money(k.tds)} = ${money(k.receivable)} receivable`} />
        <Stat n={money(k.received)} l="Amount received" s={`${k.receivable ? Math.round((k.received / k.receivable) * 100) : 0}% of ${money(k.receivable)} receivable`} tone="good" />
        <Stat n={money(k.pending)} l="Pending amount" s={`of ${money(k.receivable)} receivable`} tone="bad" />
        <Stat n={k.overdueCount} l="Overdue invoices" s={k.overdueCount ? `${money(k.overdueValue)} past due date` : 'nothing past due'} tone="bad" />
      </div>

      <div className="filter-row">
        <span className="section-label" style={{ marginRight: 4 }}>How old is the outstanding</span>
        <button className={`btn btn-sm ${age === 'All' ? 'btn-primary' : ''}`} onClick={() => setAge('All')}>All {data.rows.length}</button>
        {data.ageing.map((b) => (
          <button key={b.bucket} className={`btn btn-sm ${age === b.bucket ? 'btn-primary' : ''}`} disabled={!b.count} onClick={() => setAge(age === b.bucket ? 'All' : b.bucket)}>
            {b.bucket} <b>{b.count}</b>{b.outstanding ? ` ${money(b.outstanding)}` : ''}
          </button>
        ))}
        {tc.toCollect > 0
          ? <span className="status priority-high" title="Form 16A still to be collected from the client">TDS to collect {money(tc.toCollectValue)} · {tc.toCollect} certificate(s)</span>
          : tc.inHandValue > 0
            ? <span className="status priority-low">All TDS certificates in hand · {money(tc.inHandValue)}</span>
            : <span className="small-muted">Click a bucket to see only those invoices</span>}
      </div>

      <div className="filter-row">
        <span className="section-label" style={{ marginRight: 4 }}>Saved views</span>
        {views.length === 0 && <span className="small-muted">None yet — set your filters, then save the combination so you never set them again.</span>}
        {views.map((v) => (
          <span className="chip" key={v.name}>
            <button className="link-btn" onClick={() => applyView(v)}>{v.name}</button>
            <button title="Remove" onClick={() => deleteView(v.name)}>×</button>
          </span>
        ))}
        <button className="btn btn-sm" onClick={saveView}>＋ Save this view</button>
        <label className="field"><span>Group by</span>
          <select value={group} onChange={(e) => { setGroup(e.target.value); setOpen({}); }}>
            {GROUP_BY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <button className="btn btn-sm" onClick={() => setShowCols((v) => !v)}>▦ Columns</button>
      </div>

      {showCols && (
        <div className="card section">
          <h3>Show these columns</h3>
          <div className="grid-4">
            {WORK_COLS.map(([key, label]) => (
              <label key={key} className="small-muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={!!cols[key]} onChange={(e) => setCols({ ...cols, [key]: e.target.checked })} /> {label}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="card section">
        <h3>Invoices · {rows.length}</h3>
        <div className="small-muted" style={{ marginBottom: 10 }}>
          {k.candidates} candidate(s) — click ▸ on an invoice to see its candidates, its instalments and the GST / TDS breakdown
        </div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>{active.map(([key, label]) => <th key={key} className={NUM_COLS.has(key) ? 'num' : ''}>{label}</th>)}</tr>
            </thead>
            <tbody>
              {body}
              {rows.length === 0 && <tr><td colSpan={active.length} className="small-muted">No invoice matches these filters.</td></tr>}
            </tbody>
            <tfoot>
              <tr>
                {active.map(([key]) => {
                  if (key === 'inv') return <td key={key}>TOTAL</td>;
                  if (key === 'cand') return <td key={key} className="num">{totals.cand}</td>;
                  if (totals[key] !== undefined) return <td key={key} className="num">{money(totals[key])}</td>;
                  return <td key={key} />;
                })}
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}
