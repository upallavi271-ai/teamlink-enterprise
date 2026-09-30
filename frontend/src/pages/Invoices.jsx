import {
  Fragment, useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { can } from '../permissions';
import Combo from '../components/Combo.jsx';
import FilterChips from '../components/FilterChips.jsx';
import Pager, { usePaged } from '../components/Pager.jsx';
import '../components/ui/ui.css';
import AccountsImport from '../components/AccountsImport.jsx';
import PaymentModal from './invoices/PaymentModal.jsx';
import NewJoinModal from './invoices/NewJoinModal.jsx';
import ClientAccountModal from './invoices/ClientAccountModal.jsx';
import {
  money, money2, fmtD, daysSince,
} from './invoices/invFormat';
import { saveBlob } from './office/officeUtil';
import {
  ALL, changeFilter, reconcile, departmentOptions, sectionOptions, employeeOptions, describeEmployee,
  matchesHierarchy, waitingUnder, sectionByKey, personByKey, deptLabelOf,
} from './invoices/invHierarchy';
import './invoices/invoices.css';
import './invoices/invTable.css';

// AccountsDashboard and InvoiceDetail import these from here.
export { money, money2, fmtD };

// "Received and Paid mean the same thing — the whole invoice is in."
const FALLBACK_STATUS = ['All', 'Pending', 'Received', 'Partially Paid', 'Paid', 'Overdue', 'Cancelled'];

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

// ---------------------------------------------------------------------------
// THE INVOICE PAGE — the approved "TeamLink Accounts / Invoice" layout on the
// real register (GET /invoices/register): header actions, the filter panel
// with its four totals, the joinings that have no invoice number yet, the six
// headline figures, the aging chips, and the invoice table with its grouping,
// column chooser and rows that open in place.
// ---------------------------------------------------------------------------

// THE INVOICE TABLE (Accounts spec 2) — exactly these 21 columns, in this
// order, always. Invoice No + Client are pinned left, Actions pinned right.
const COLUMNS = [
  ['inv', 'Invoice No'], ['date', 'Invoice Date'], ['client', 'Client'], ['btype', 'Billing Type'],
  ['cgstin', 'Client GSTIN'], ['dept', 'Department'], ['rec', 'Recruiter'], ['before', 'Before GST'],
  ['gst', 'GST'], ['after', 'After GST'], ['tds', 'TDS'], ['receivable', 'Receivable'],
  ['received', 'Received'], ['pending', 'Pending'], ['pays', 'Payments'], ['proof', 'Proof'],
  ['tdscert', 'TDS Cert'], ['due', 'Due Date'], ['age', 'Age'], ['sent', 'Sent'], ['act', 'Actions'],
];
// Pinned columns' classes (invoices/invTable.css). The Client column's left
// offset is the Invoice No column's width (--inv-c1 there).
const STICKY = { inv: 'stk-l1', client: 'stk-l2', act: 'stk-r' };

const GROUP_BY = [['inv', 'Invoice'], ['client', 'Client'], ['dept', 'Department'], ['rec', 'Recruiter'], ['month', 'Invoice month']];

const NUM_COLS = new Set(['before', 'gst', 'after', 'tds', 'receivable', 'received', 'pending', 'pays']);
// The money columns the totals row adds up, with the row field behind each.
const MONEY_FIELD = {
  before: 'billing', gst: 'gst', after: 'invoiceValue', tds: 'tds', receivable: 'receivable', received: 'received', pending: 'pending',
};

// The age buckets the register computes (utils/accounts.js ageBucket), with
// the labels the approved design prints.
const BUCKETS = [
  { k: 'All', t: 'All' },
  { k: 'Not due yet', t: 'Not due yet', sev: 0 },
  { k: '0–30 days', t: '0-30 days', sev: 1 },
  { k: '31–60 days', t: '31-60 days', sev: 2 },
  { k: '61–90 days', t: '61-90 days', sev: 3 },
  { k: '90+ days', t: '90+ days', sev: 3 },
];

const VIEWS_KEY = 'tl.invoices.savedViews';
const GROUP_KEY = 'tl.invoices.group';
const readStore = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const writeStore = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private window */ } };

const loadViews = () => {
  try { return JSON.parse(readStore(VIEWS_KEY) || '[]'); } catch { return []; }
};
const loadGroup = () => {
  const g = readStore(GROUP_KEY);
  return GROUP_BY.some(([v]) => v === g) ? g : 'inv';
};

const BLANK_FILTERS = {
  client: 'All', dept: 'All', section: 'All', role: 'All', rec: 'All', gstin: 'All', status: 'All', q: '',
};

// The Sort dropdown over the invoice table (newest first by default).
const SORTS = [
  ['new', 'Newest first', (a, b) => String(b.invoiceDate || '').localeCompare(String(a.invoiceDate || '')) || String(b.invoiceNumber || '').localeCompare(String(a.invoiceNumber || ''), undefined, { numeric: true })],
  ['old', 'Oldest first', (a, b) => String(a.invoiceDate || '').localeCompare(String(b.invoiceDate || '')) || String(a.invoiceNumber || '').localeCompare(String(b.invoiceNumber || ''), undefined, { numeric: true })],
  ['no', 'Invoice no', (a, b) => String(a.invoiceNumber || '').localeCompare(String(b.invoiceNumber || ''), undefined, { numeric: true })],
  ['client', 'Client A–Z', (a, b) => String(a.client || '').localeCompare(String(b.client || '')) || String(b.invoiceDate || '').localeCompare(String(a.invoiceDate || ''))],
  ['pending', 'Pending high → low', (a, b) => (Number(b.pending) || 0) - (Number(a.pending) || 0)],
  ['due', 'Due date (soonest)', (a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999'))],
];
const MORE_KEY = 'tl.morefilters.invoices';

const sumOf = (list, f) => Math.round(list.reduce((s, r) => s + (Number(f(r)) || 0), 0) * 100) / 100;

function Icon({ d }) {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
const UP_BAR = 'M12 20V8M6 14l6-6 6 6M5 4h14';
const DOWN_BAR = 'M12 4v12M6 10l6 6 6-6M5 20h14';

function Field({ label, children, className }) {
  return <label className={`field${className ? ` ${className}` : ''}`}><span>{label}</span>{children}</label>;
}

export default function Invoices() {
  const { user } = useAuth();
  const canCreate = can(user, 'accounts', 'accounts', 'Invoices', 'create');
  const canPay = can(user, 'accounts', 'accounts', 'Payments', 'create');
  const canExport = can(user, 'accounts', 'accounts', 'Invoices', 'export');

  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [period, setPeriod] = useState('all');
  const [filters, setFilters] = useState(BLANK_FILTERS);
  const [age, setAge] = useState('All');
  const [group, setGroup] = useState(loadGroup);
  const [hot, setHot] = useState(null); // the row just paid / picked, briefly highlighted
  const [views, setViews] = useState(loadViews);
  const [importing, setImporting] = useState(false);
  const [payFor, setPayFor] = useState(null); // null | { id }
  const [accountFor, setAccountFor] = useState(null); // null | { clientId, client }
  const [joinFor, setJoinFor] = useState(null); // null | '' | applicationId
  const [menu, setMenu] = useState(null); // null | 'bell'
  const [exporting, setExporting] = useState(false);
  const [sort, setSort] = useState('new');
  const [moreOpen, setMoreOpen] = useState(() => readStore(MORE_KEY) === '1');
  const toggleMore = () => {
    const next = !moreOpen;
    setMoreOpen(next);
    writeStore(MORE_KEY, next ? '1' : '0');
  };
  const navigate = useNavigate();
  const bellRef = useRef(null);
  const noticeRef = useRef(null);
  const tableRef = useRef(null);

  // LINKS INTO THIS PAGE (the Accounts desk / Management dashboards):
  //   ?period=M:2026-09 | Q2:2026 | FY:2026   ?status=Overdue   ?client=<name>
  //   ?age=0-30 | 31-60 | 61-90 | 90+ | 60+   ?join=new | <applicationId>
  //   ?pay=1 | <invoiceId>   — read once on arrival.
  const [urlQ] = useSearchParams();
  useEffect(() => {
    const p = urlQ.get('period');
    if (p) setPeriod(p);
    const status = urlQ.get('status');
    const client = urlQ.get('client');
    if (status || client) setFilters((f) => ({ ...f, ...(status ? { status } : {}), ...(client ? { client } : {}) }));
    const AGE = { '0-30': '0–30 days', '31-60': '31–60 days', '61-90': '61–90 days', '90+': '90+ days', '60+': '60+' };
    if (AGE[urlQ.get('age')]) setAge(AGE[urlQ.get('age')]);
    const join = urlQ.get('join');
    if (join && canCreate) setJoinFor(join === 'new' ? '' : join);
    const pay = urlQ.get('pay');
    if (pay && canPay) setPayFor({ id: pay === '1' ? null : pay });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(() => {
    api.get('/invoices/register', { params: { period } })
      .then((res) => setData(res.data))
      .catch((e) => setError(e.response?.data?.error || 'That did not work.'));
  }, [period]);
  useEffect(load, [load]);

  useEffect(() => { writeStore(GROUP_KEY, group); }, [group]);
  useEffect(() => {
    if (!flash) return undefined;
    const t = setTimeout(() => setFlash(''), 4500);
    return () => clearTimeout(t);
  }, [flash]);

  // A menu closes on a click anywhere outside it, and on Escape.
  useEffect(() => {
    if (!menu) return undefined;
    const ref = bellRef;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setMenu(null); };
    const onKey = (e) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menu]);

  async function run(fn) {
    setError('');
    try { await fn(); load(); } catch (e) { setError(e.response?.data?.error || e.message || 'That did not work.'); }
  }

  const stance = data?.gstStance || {};
  const hier = data?.hierarchy;
  // Departments an invoice can be filtered to: the hierarchy's, then any other.
  const deptOpts = useMemo(() => departmentOptions(hier, (data?.rows || []).map((r) => r.department)), [hier, data]);
  const validDepts = useMemo(() => deptOpts.map((o) => o.value), [deptOpts]);
  // Client -> Department -> Section -> Employee: one change, and every filter
  // below it that no longer fits goes back to All (invoices/invHierarchy.js).
  const setF = (field, value) => setFilters((f) => changeFilter(f, field, value, hier, validDepts));
  const secOpts = useMemo(() => sectionOptions(hier, filters.dept), [hier, filters.dept]);
  const empOpts = useMemo(() => employeeOptions(hier, filters.dept, filters.section), [hier, filters.dept, filters.section]);
  const empInfo = filters.rec !== ALL ? describeEmployee(hier, filters.rec, filters.dept, filters.section) : null;

  // Every filter except the age chips — the chips count what these leave.
  const base = useMemo(() => {
    if (!data) return [];
    return data.rows.filter((r) => {
      if (filters.client !== 'All' && r.client !== filters.client) return false;
      // Department / Section / Employee — by the invoice's attributed seat and
      // employee keys (utils/invoiceHierarchy.js), never by a name string.
      if (!matchesHierarchy(r, filters)) return false;
      if (filters.role !== 'All' && r.role !== filters.role) return false;
      // "Received and Paid mean the same thing — the whole invoice is in."
      if (filters.status !== 'All' && r.status !== (filters.status === 'Received' ? 'Paid' : filters.status)) return false;
      // Yes / No read the invoice in front of you. Never, Always and Both ways
      // read the client's whole history.
      if (filters.gstin === 'Yes' && !r.clientPayingGst) return false;
      if (filters.gstin === 'No' && r.clientPayingGst) return false;
      if (filters.gstin === 'Never' && stance[r.client] !== 'never') return false;
      if (filters.gstin === 'Always' && stance[r.client] !== 'always') return false;
      if (filters.gstin === 'Mixed' && stance[r.client] !== 'mixed') return false;
      const q = filters.q.trim().toLowerCase();
      if (q) {
        const hay = [r.invoiceNumber, r.client, r.candidateName, r.department, r.section, r.role, r.recruiter,
          r.clientGstin, r.billingType, r.status].join(' ').toLowerCase();
        if (!q.split(/\s+/).every((t) => hay.includes(t))) return false;
      }
      return true;
    });
  }, [data, filters, stance]);
  const rows = useMemo(() => {
    // '60+' (the Accounts desk's aging bucket) = 61–90 and 90+ together.
    const list = age === 'All' ? base : base.filter((r) => (age === '60+' ? ['61–90 days', '90+ days'].includes(r.age) : r.age === age));
    const cmp = (SORTS.find(([k]) => k === sort) || SORTS[0])[2];
    return [...list].sort(cmp);
  }, [base, age, sort]);

  // The table's own column order — fixed (COLUMNS).
  const active = COLUMNS;

  // The groups in display order — also the order ⭳ Excel writes.
  const grouped = useMemo(() => {
    if (group === 'inv') return null;
    const keyOf = (r) => (group === 'client' ? r.client
      : group === 'dept' ? (r.department || '—')
        : group === 'rec' ? (r.recruiter || 'not assigned')
          : (r.invoiceMonth || '—'));
    const map = new Map();
    rows.forEach((r) => {
      const k = String(keyOf(r) || '—');
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    });
    const keys = [...map.keys()];
    if (group === 'month') keys.sort().reverse(); else keys.sort((a, b) => a.localeCompare(b));
    return keys.map((k) => ({
      key: k,
      label: group === 'month' ? (map.get(k)[0].invoiceMonthLabel || k) : k,
      list: map.get(k),
    }));
  }, [rows, group]);
  const displayRows = useMemo(() => (grouped ? grouped.flatMap((g) => g.list) : rows), [grouped, rows]);
  // Paged 25 / 50 / 100 when the table is one flat list; grouped, every group
  // shows whole so its subtotals always match the rows under it.
  const page = usePaged(rows);

  // "Needs attention" — the bell.
  const notes = useMemo(() => {
    if (!data) return { list: [], count: 0 };
    const live = data.rows.filter((r) => r.status !== 'Cancelled');
    const list = [];
    const overdue = live.filter((r) => r.pending > 0.5 && r.daysOverdue > 0).sort((a, b) => b.daysOverdue - a.daysOverdue);
    overdue.forEach((r) => list.push({
      tone: 'bad', id: r.id, no: r.invoiceNumber, text: <><b>{r.invoiceNumber}</b> is {r.daysOverdue} days overdue</>, sub: `${r.client} · ${money(r.pending)} pending`,
    }));
    const certs = live.filter((r) => r.received > 0 && r.tds > 0.5 && r.tdsCert !== 'in hand');
    certs.forEach((r) => list.push({
      tone: 'warn', id: r.id, no: r.invoiceNumber, text: <>TDS certificate missing for <b>{r.invoiceNumber}</b></>, sub: `${r.client} withheld ${money(r.tds)} — ask for Form 16A`,
    }));
    const unsent = live.filter((r) => !r.sentVia);
    unsent.slice(0, 6).forEach((r) => list.push({
      tone: 'info', id: r.id, no: r.invoiceNumber, text: <><b>{r.invoiceNumber}</b> has not been sent to the client</>, sub: r.client,
    }));
    if (unsent.length > 6) {
      list.push({
        tone: 'info', table: true, text: <>{unsent.length - 6} more invoice(s) not sent to the client</>, sub: 'The Sent column shows every one — open an invoice to mark it sent',
      });
    }
    const waiting = data.noInvoice?.waiting || 0;
    if (waiting) {
      list.push({
        tone: 'warn', join: true, text: <>{waiting} joining(s) waiting for an invoice number</>, sub: 'Raise them from the notice card',
      });
    }
    return { list, count: list.length };
  }, [data]);

  if (!data) {
    return error ? <div className="notice red"><span>{error}</span></div> : <div className="small-muted">Loading…</div>;
  }
  // The waiting joinings under the same Client / Department / Section /
  // Employee filters as the table.
  const ni = waitingUnder(data.noInvoice || {
    waiting: 0, groups: [], notBillable: [], recent: [],
  }, filters);

  const live = rows.filter((r) => r.status !== 'Cancelled');
  // THE TOTALS ROW — over every invoice the current filters and search leave
  // (`rows` is the whole filtered register the server sent, never a page of
  // it), so it is always the sum of the rows the table shows. It is worked
  // out from the same data on every load, so a payment moves it at once.
  const totals = {
    count: rows.length,
    before: sumOf(rows, (r) => r.billing),
    gst: sumOf(rows, (r) => r.gst),
    after: sumOf(rows, (r) => r.invoiceValue),
    tds: sumOf(rows, (r) => r.tds),
    receivable: sumOf(rows, (r) => r.receivable),
    received: sumOf(rows, (r) => r.received),
    pending: sumOf(rows, (r) => r.pending),
    pays: sumOf(rows, (r) => r.paymentCount),
  };
  const st = {
    candidates: sumOf(live, (r) => r.candidates),
    clients: new Set(live.map((r) => r.client)).size,
    total: sumOf(live, (r) => r.invoiceValue),
    received: sumOf(live, (r) => r.received),
    receivable: sumOf(live, (r) => r.receivable),
    pending: sumOf(live, (r) => Math.max(0, r.pending)),
    overdue: live.filter((r) => r.pending > 0.5 && r.daysOverdue > 0),
  };

  // Aging chips over everything the other filters leave.
  const openBase = base.filter((r) => r.status !== 'Cancelled' && r.pending > 0.5);
  const chipData = BUCKETS.map((b) => {
    const list = b.k === 'All' ? base : openBase.filter((r) => r.age === b.k);
    const amt = sumOf(b.k === 'All' ? openBase : list, (r) => r.pending);
    return { ...b, count: list.length, amt };
  });
  const maxAmt = Math.max(1, ...chipData.slice(1).map((c) => c.amt));
  const certDue = base.filter((r) => r.status !== 'Cancelled' && r.received > 0 && r.tds > 0.5 && r.tdsCert !== 'in hand');
  const openTds = sumOf(openBase, (r) => r.tds);

  const saveView = () => {
    const name = window.prompt('Name this view');
    if (!name) return;
    const next = [...views.filter((v) => v.name !== name), {
      name, period, filters, age, group,
    }];
    setViews(next);
    writeStore(VIEWS_KEY, JSON.stringify(next));
  };
  const applyView = (v) => {
    setPeriod(v.period);
    // A view saved before the hierarchy filter held names; anything that is
    // not a valid department / section / employee now goes back to All.
    setFilters(reconcile({ ...BLANK_FILTERS, ...v.filters }, hier, validDepts));
    setAge(v.age);
    setGroup(v.group);
  };
  const deleteView = (name) => {
    const next = views.filter((v) => v.name !== name);
    setViews(next);
    writeStore(VIEWS_KEY, JSON.stringify(next));
  };

  // What is switched on, in the words the user picked, so a filter that finds
  // nothing can say why and be turned off one at a time.
  const activeBits = [
    period !== 'all' && { t: 'Period', v: (data.period.options.find((o) => o.value === period) || {}).label || period, fix: () => setPeriod('all') },
    filters.q.trim() && { t: 'Search', v: `"${filters.q.trim()}"`, fix: () => setFilters({ ...filters, q: '' }) },
    filters.client !== 'All' && { t: 'Client', v: filters.client, fix: () => setFilters({ ...filters, client: 'All' }) },
    filters.dept !== 'All' && { t: 'Department', v: deptLabelOf(hier, filters.dept), fix: () => setF('dept', ALL) },
    filters.section !== 'All' && { t: 'Section', v: (sectionByKey(hier, filters.section) || {}).label || filters.section, fix: () => setF('section', ALL) },
    filters.role !== 'All' && { t: 'Role', v: filters.role, fix: () => setFilters({ ...filters, role: 'All' }) },
    filters.rec !== 'All' && { t: 'Employee', v: (personByKey(hier, filters.rec) || {}).name || filters.rec, fix: () => setF('rec', ALL) },
    filters.gstin !== 'All' && { t: 'GST charged', v: filters.gstin, fix: () => setFilters({ ...filters, gstin: 'All' }) },
    filters.status !== 'All' && { t: 'Status', v: filters.status, fix: () => setFilters({ ...filters, status: 'All' }) },
    age !== 'All' && { t: 'Age', v: age, fix: () => setAge('All') },
  ].filter(Boolean);
  const resetAll = () => { setFilters(BLANK_FILTERS); setAge('All'); setPeriod('all'); };
  const moreActive = ['section', 'role', 'rec', 'gstin'].filter((k) => filters[k] !== 'All').length;
  const chipList = activeBits.map((b) => ({ key: b.t, label: b.t, value: String(b.v), onRemove: b.fix }));
  const stanceCount = (kind) => Object.values(stance).filter((v) => v === kind).length;

  const doExport = async () => {
    setExporting(true); setError('');
    try {
      const res = await api.post('/invoices/register/export.xlsx', {
        period,
        ids: displayRows.map((r) => r.id),
        filters: activeBits.map((b) => `${b.t}: ${b.v}`).join(' · '),
      }, { responseType: 'blob' });
      saveBlob(res, 'invoices.xlsx');
      setFlash(`Exported ${displayRows.length} invoice(s) to Excel.`);
    } catch {
      setError('The Excel file could not be made.');
    }
    setExporting(false);
  };

  // Bring one row into view inside the table's own scroll box and light it
  // up for a moment — after a payment, or from the bell.
  const focusRow = (id) => {
    setHot(id);
    if (!grouped) {
      const ix = rows.findIndex((r) => r.id === id);
      if (ix >= 0) page.setPage(Math.floor(ix / page.size) + 1);
    }
    setTimeout(() => {
      const el = document.querySelector(`tr[data-inv="${id}"]`);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus({ preventScroll: true }); }
    }, 150);
    setTimeout(() => setHot((h) => (h === id ? null : h)), 4000);
  };
  const pickNote = (n) => {
    setMenu(null);
    if (n.join) { noticeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    if (n.table) { tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    setFilters({ ...BLANK_FILTERS, q: n.no });
    setAge('All');
    focusRow(n.id);
  };

  // The four money figures beside the filters — totals of what is filtered.
  const badge = (key, label, value) => (
    <div key={key} className="inv-badge" title={`${label} across the ${rows.length} invoice(s) the filters leave`}>
      <span>{label}</span>
      <strong>{money2(value)}</strong>
    </div>
  );

  // The Form 16A file itself, fetched with the login's token (never a public URL).
  const viewTdsCert = async (r) => {
    try {
      const res = await api.get(`/invoices/${r.id}/tds-certificate/file`, { params: { inline: 1 }, responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch {
      setError('The TDS certificate file could not be opened.');
    }
  };

  const payable = (r) => canPay && r.pending > 0.5 && r.status !== 'Cancelled';

  const cell = (key, r) => {
    const cls = [STICKY[key], NUM_COLS.has(key) ? 'num' : ''].filter(Boolean).join(' ') || undefined;
    switch (key) {
      case 'inv': return (
        <td key={key} className={`${cls} inv-no`}>
          <Link className="inv-mono" to={`/invoices/${r.id}`} title="Open the full invoice">{r.invoiceNumber}</Link>
          {r.status === 'Cancelled' && <div className="small-muted">cancelled</div>}
        </td>
      );
      case 'date': return <td key={key}>{fmtD(r.invoiceDate)}</td>;
      case 'client': return (
        <td key={key} className={cls} title={r.client}>
          <div className="inv-cell-ellip" style={{ fontWeight: 500 }}>{r.client}</div>
          <div className="small-muted inv-cell-ellip">{r.candidateName || 'no candidate linked'}</div>
        </td>
      );
      case 'btype': return <td key={key}>{r.billingType || '—'}</td>;
      case 'cgstin': return (
        <td key={key} className="inv-mono">
          {r.clientGstin || <span className="small-muted">{r.clientGstinText && r.clientGstinKind !== 'number' ? r.clientGstinText : '—'}</span>}
        </td>
      );
      case 'dept': return <td key={key}>{r.department && r.department !== '—' ? deptLabelOf(hier, r.department) : '—'}</td>;
      case 'rec': return <td key={key} title={r.recruiter ? undefined : r.attribution || undefined}>{r.recruiter || <span className="small-muted">—</span>}</td>;
      case 'before': case 'gst': case 'after': case 'tds': case 'receivable': case 'received':
        return <td key={key} className={cls}>{money2(r[MONEY_FIELD[key]])}</td>;
      case 'pending': return (
        <td key={key} className={cls} style={{ fontWeight: 600, color: r.pending > 0.5 ? 'var(--red)' : undefined }}>
          {money2(r.pending)}
        </td>
      );
      case 'pays': return <td key={key} className={cls}>{r.paymentCount}</td>;
      case 'proof': return (
        <td key={key}>
          {r.proofCount > 0
            ? (
              <Link to={`/invoices/${r.id}#proof`} className="inv-proof" title={`${r.proofCount} bank statement line(s) prove the payment — open them`}>
                <span aria-hidden="true">🔗</span>{r.proofCount > 1 ? ` ${r.proofCount}` : ''}
                <span className="sr-only"> bank proof</span>
              </Link>
            )
            : <span className="small-muted">-</span>}
        </td>
      );
      case 'tdscert': {
        if (!(r.tds > 0.5)) return <td key={key}><span className="small-muted">-</span></td>;
        if (r.tdsCertHasFile) return <td key={key}><button type="button" className="link-btn" onClick={() => viewTdsCert(r)}>View</button></td>;
        if (r.tdsCertReceived) return <td key={key}><Link to={`/invoices/${r.id}#tds`} title="Received — no file uploaded yet">View</Link></td>;
        return <td key={key}><span className="status priority-medium">Pending</span></td>;
      }
      case 'due': return <td key={key}>{fmtD(r.dueDate)}</td>;
      case 'age': {
        const old = daysSince(r.invoiceDate);
        return <td key={key}>{r.pending > 0.5 && r.status !== 'Cancelled' && old != null ? `${Math.max(0, old)} days` : '-'}</td>;
      }
      case 'sent': return (
        <td key={key}>
          {r.sentVia ? <span className="status priority-low">{r.sentVia} · {fmtD(r.sentDate)}</span> : <span className="status">Not sent</span>}
        </td>
      );
      default: return (
        <td key={key} className={cls}>
          <div className="inv-acts">
            {r.clientId && (
              <button type="button" className="btn btn-sm" title={`${r.client} — every invoice and receipt, as a ledger`} onClick={() => setAccountFor({ clientId: r.clientId, client: r.client })}>Account</button>
            )}
            <button type="button" className="btn btn-sm" onClick={() => navigate(`/invoices/${r.id}`)}>View Invoice</button>
            {payable(r) && (
              <button type="button" className="btn btn-sm btn-gold" onClick={() => setPayFor({ id: r.id })}>+ Payment</button>
            )}
          </div>
        </td>
      );
    }
  };

  const rowEl = (r) => (
    <tr key={r.id} data-inv={r.id} tabIndex={-1} className={`inv-row${hot === r.id ? ' hot' : ''}`}>
      {active.map(([key]) => cell(key, r))}
    </tr>
  );

  let body;
  if (!grouped) {
    body = page.slice.map(rowEl);
  } else {
    body = grouped.map((g) => (
      <Fragment key={`g-${g.key}`}>
        <tr className="inv-grp">
          <td colSpan={active.length}>
            {/* Pinned to the left edge so the heading stays in view while the table scrolls sideways. */}
            <div className="inv-grp-in">
              <div>
                <strong>{g.label}</strong>
                <span className="small-muted" style={{ marginLeft: 8 }}>{g.list.length} invoice(s)</span>
              </div>
              <div className="inv-grp-sums">
                <span>Before GST<b>{money2(sumOf(g.list, (r) => r.billing))}</b></span>
                <span>After GST<b>{money2(sumOf(g.list, (r) => r.invoiceValue))}</b></span>
                <span>Received<b>{money2(sumOf(g.list, (r) => r.received))}</b></span>
                <span>Pending<b>{money2(sumOf(g.list, (r) => r.pending))}</b></span>
              </div>
            </div>
          </td>
        </tr>
        {g.list.map(rowEl)}
      </Fragment>
    ));
  }

  return (
    <div className="inv-page">
      <header className="inv-head">
        <div className="inv-head-main">
          <nav className="inv-crumbs" aria-label="Breadcrumb">
            <span>TeamLink Accounts</span><span aria-hidden="true">/</span><span aria-current="page">Invoice</span>
          </nav>
          <h1>Invoice</h1>
          <p className="inv-lede">Bills raised to clients for the candidates we placed — what was billed, what came in, and what is still owed after TDS.</p>
        </div>
        <div className="inv-head-actions">
          <div className="inv-bellwrap" ref={bellRef}>
            <button
              type="button"
              className="btn inv-hbtn inv-bell"
              aria-haspopup="true"
              aria-expanded={menu === 'bell'}
              aria-label={`Notifications (${notes.count})`}
              onClick={() => setMenu(menu === 'bell' ? null : 'bell')}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
              {notes.count > 0 && <span className="inv-dot">{notes.count > 99 ? '99+' : notes.count}</span>}
            </button>
            {menu === 'bell' && (
              <div className="inv-menu" role="menu">
                <h4>Needs attention</h4>
                {notes.list.length === 0 && <p className="small-muted" style={{ padding: '8px 10px', margin: 0 }}>All clear.</p>}
                {notes.list.map((n, i) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <button type="button" key={i} className={`inv-note ${n.tone}`} role="menuitem" onClick={() => pickNote(n)}>
                    <i />
                    <span><span>{n.text}</span><div className="small-muted">{n.sub}</div></span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {canCreate && <button type="button" className="btn btn-gold" onClick={() => setJoinFor('')}>+ New join</button>}
          {canPay && <button type="button" className="btn inv-hbtn" onClick={() => setPayFor({ id: null })}>+ Payment</button>}
          {canCreate && (
            <button type="button" className="btn inv-hbtn" onClick={() => setImporting(true)}>
              <Icon d={UP_BAR} /> Import Excel
            </button>
          )}
          {canExport && (
            <button type="button" className="btn inv-hbtn" disabled={exporting} onClick={doExport} title="Download exactly the invoices shown below">
              <Icon d={DOWN_BAR} /> {exporting ? 'Preparing…' : 'Excel'}
            </button>
          )}
        </div>
      </header>

      {importing && <AccountsImport kind="invoices" onClose={() => setImporting(false)} onDone={load} />}
      {error && <div className="notice red" style={{ margin: 0 }}><span>{error} <button type="button" className="link-btn" onClick={() => setError('')}>Dismiss</button></span></div>}
      {flash && <div className="notice" style={{ margin: 0 }} role="status"><span>{flash}</span></div>}

      <section className="inv-panel inv-filters" aria-label="Filters">
        <div className="inv-fgrid">
          <Field label="Search" className="inv-fsearch">
            <input type="search" value={filters.q} placeholder="Invoice no, client, candidate, recruiter…" autoComplete="off" onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
          </Field>
          <Field label={`Client · ${data.clients.length}`}>
            <Combo value={filters.client} onChange={(e) => setF('client', e.target.value)}>
              <option value="All">All clients</option>{data.clients.map((c) => <option key={c}>{c}</option>)}
            </Combo>
          </Field>
          <Field label="Period">
            <Combo value={period} onChange={(e) => setPeriod(e.target.value)}>
              {data.period.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Combo>
          </Field>
          <Field label="Department">
            <Combo value={filters.dept} onChange={(e) => setF('dept', e.target.value)}>
              <option value="All">All departments</option>{deptOpts.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </Combo>
          </Field>
          <Field label="Status">
            <Combo title="Received and Paid mean the same thing — the whole invoice is in" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value || 'All' })}>
              {(data.payStatuses || FALLBACK_STATUS).map((s) => <option key={s} value={s}>{s === 'All' ? 'All statuses' : s}</option>)}
            </Combo>
          </Field>
          <div className="field">
            <span>&nbsp;</span>
            <button type="button" className={`mf-toggle${moreOpen ? ' on' : ''}`} onClick={toggleMore} aria-expanded={moreOpen}>
              More Filters{moreActive ? ` (${moreActive})` : ''} {moreOpen ? '▴' : '▾'}
            </button>
          </div>
          {moreOpen && (
          <>
          <Field label="Section">
            <Combo title="Only the chosen department's sections" value={filters.section} onChange={(e) => setF('section', e.target.value)}>
              <option value="All">All sections</option>{secOpts.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </Combo>
          </Field>
          <Field label="Role">
            <Combo value={filters.role} onChange={(e) => setFilters({ ...filters, role: e.target.value })}>
              <option value="All">All roles</option>{(data.roles || []).map((d) => <option key={d}>{d}</option>)}
            </Combo>
          </Field>
          <Field label={`Employee name · ${empOpts.length}`}>
            <Combo
              title={empInfo ? empInfo.text : 'The TL and recruiters of the chosen section — current and former'}
              value={filters.rec}
              onChange={(e) => setF('rec', e.target.value)}
            >
              <option value="All">Everyone</option>
              {empOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              {empOpts.length === 0 && <option value="__none" disabled>No employees found in this section.</option>}
            </Combo>
            {empInfo && <span className="inv-empchip" title={empInfo.text}>{empInfo.text}</span>}
          </Field>
          <Field label="GST charged">
            <Combo
              title="Yes / No read the invoice in front of you. Never, Always and Both ways read the client's whole history."
              value={filters.gstin}
              onChange={(e) => setFilters({ ...filters, gstin: e.target.value })}
            >
              <option value="All">Any</option>
              <option value="Yes">Yes — GST on this invoice</option>
              <option value="No">No — no GST on this invoice</option>
              <optgroup label="By the client's whole history">
                <option value="Never">Never charged GST · {stanceCount('never')}</option>
                <option value="Always">Always charged GST · {stanceCount('always')}</option>
                <option value="Mixed">Both ways — worth a look · {stanceCount('mixed')}</option>
              </optgroup>
            </Combo>
          </Field>
          </>
          )}
        </div>
        <div className="inv-fside">
          <div className="inv-badges" aria-live="polite">
            {badge('gst', 'Total GST', totals.gst)}
            {badge('before', 'Before GST', totals.before)}
            {badge('after', 'After GST', totals.after)}
            {badge('tds', 'TDS', totals.tds)}
          </div>
          <div className="inv-ffoot">
            <span>
              {activeBits.length
                ? `${activeBits.length} filter${activeBits.length > 1 ? 's' : ''} applied · ${rows.length} of ${data.rows.length} invoices`
                : `No filters applied · ${data.rows.length} invoices`}
            </span>
            <button type="button" className="btn btn-sm" disabled={!activeBits.length} onClick={resetAll}>Reset all</button>
          </div>
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <FilterChips filters={chipList} onClearAll={activeBits.length ? resetAll : undefined} />
        </div>
      </section>

      {/* Joinings that are on the register and in every total, but carry no
          invoice number yet — so they cannot appear in the table below. */}
      <section className={`inv-notice${ni.waiting ? '' : ' calm'}`} ref={noticeRef} aria-live="polite">
        <div className="inv-notice-head">
          <div>
            <strong>
              <span className="inv-notice-icon">{ni.waiting ? '!' : '✓'}</span>
              {ni.waiting ? `${ni.waiting} joining(s) have no invoice number yet${ni.filtered ? ' — under these filters' : ''}`
                : (ni.filtered ? 'No joining under these filters is waiting for an invoice number' : 'Every joining has an invoice number')}
            </strong>
            <p>
              {ni.waiting
                ? 'These candidates have joined but have not been billed. The invoice table lists invoices, so they cannot appear there until the invoice is raised and takes the next number in the series.'
                : 'When the ATS marks a candidate Joined, they wait here until the invoice is raised.'}
            </p>
          </div>
          {canCreate && ni.waiting > 0 && (
            <div className="qa-row" style={{ marginTop: 0 }}>
              {ni.groups.length > 0 && (
                <button
                  type="button"
                  className="btn btn-sm btn-gold"
                  // Under a filter, only the groups the card is showing are raised.
                  onClick={() => run(async () => { const r = await api.post('/invoices/register/raise', ni.filtered ? { groups: ni.groups.map((g) => ({ clientId: g.clientId, month: g.month })) } : { all: true }); setFlash(`Raised ${r.data.count} invoice(s): ${r.data.raised.join(', ')}.`); })}
                >
                  Raise invoice{ni.groups.length > 1 ? `s for all ${ni.groups.length}` : ''}
                </button>
              )}
              <button type="button" className="btn btn-sm" onClick={() => setJoinFor('')}>Pick one to invoice…</button>
            </div>
          )}
        </div>
        {ni.waiting > 0 && (ni.recent || []).length > 0 && (
          <div className="inv-waiting">
            {ni.recent.map((x) => (
              <button
                type="button"
                key={x.applicationId}
                className="status priority-medium"
                style={{ border: 0, cursor: canCreate ? 'pointer' : 'default' }}
                title={canCreate ? 'Raise the invoice for this joining' : undefined}
                onClick={() => canCreate && setJoinFor(x.applicationId)}
              >
                {x.name} · {x.client}{x.joiningDate ? ` · joined ${fmtD(x.joiningDate)}` : ''} · {x.billing != null ? money(x.billing) : 'fee not known yet'}
              </button>
            ))}
            {ni.waiting > ni.recent.length && <span className="small-muted" style={{ alignSelf: 'center' }}>+ {ni.waiting - ni.recent.length} more</span>}
          </div>
        )}
        <div className="inv-minis">
          <div className="inv-mini"><span>Candidates waiting</span><strong>{ni.waiting}</strong></div>
          <div className="inv-mini"><span>Fee not yet billed</span><strong>{money(ni.billing || 0)}</strong></div>
          <div className="inv-mini"><span>Would invoice for</span><strong>{money(ni.invoiceValue || 0)}</strong></div>
          <div className="inv-mini"><span>Next number in series</span><strong className="inv-mono">{ni.nextNumber || '—'}</strong></div>
        </div>
        {ni.groups.length > 0 && (
          <details>
            <summary>Ready to invoice — {ni.groups.length} client / joining-month group(s)</summary>
            <div className="tbl-wrap">
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
                      <td className="num" title={ni.filtered && g.inView < g.rows.length ? `${g.inView} of them match the filters — the group is raised as one invoice` : undefined}>
                        {g.rows.length}{ni.filtered && g.inView < g.rows.length ? <div className="small-muted">{g.inView} in filter</div> : null}
                      </td>
                      <td className="num">{money(g.billing)}</td>
                      <td className="num">{g.gst > 0.5 ? money(g.gst) : '—'}</td>
                      <td className="num" style={{ fontWeight: 600 }}>{money(g.invoiceValue)}</td>
                      <td className="small-muted">{g.rows.slice(0, 3).map((x) => x.name).join(', ')}{g.rows.length > 3 ? ` +${g.rows.length - 3}` : ''}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {canCreate && (
                          <button type="button" className="btn btn-sm btn-primary" onClick={() => run(async () => { const r = await api.post('/invoices/register/raise', { clientId: g.clientId, month: g.month }); setFlash(`Raised ${r.data.raised.join(', ')}.`); })}>Give it a number</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="small-muted" style={{ marginTop: 8 }}>
              One invoice per client per joining month, the way the tracker has always done it. The number carries on from the
              last one you used, the invoice date is today, and the payment due date follows the client&apos;s terms.
            </div>
          </details>
        )}
        {(ni.notBillable || []).length > 0 && (
          <div className="notice amber" style={{ margin: 0 }}>
            <span>
              <b>{ni.notBillable.length} of them cannot be invoiced yet</b> — there is no billing amount on the row, usually because
              the client&apos;s rate or the candidate&apos;s CTC is missing. “Pick one to invoice…” lets you enter the CTC and raise it:
              {' '}{ni.notBillable.slice(0, 6).map((x) => x.name).join(', ')}
              {ni.notBillable.length > 6 ? ` and ${ni.notBillable.length - 6} more` : ''}
            </span>
          </div>
        )}
      </section>

      {/* A filter that finds nothing leaves a screenful of ₹0 cards and no
          reason. This says what is switched on, and clears it in one press. */}
      {rows.length === 0 && (
        <div className="card section">
          <h3>{filters.rec !== ALL ? 'No invoices generated for this employee.' : 'No invoices found for the selected filters.'}</h3>
          <div className="small-muted" style={{ marginBottom: 10 }}>
            {data.rows.length} invoice(s) are in the register — none of them get past these
          </div>
          {activeBits.length > 0
            ? (
              <>
                <div className="qa-row">
                  {activeBits.map((b) => (
                    <button type="button" key={b.t} className="btn btn-sm" title="Turn this one off" onClick={b.fix}>{b.t}: {String(b.v).slice(0, 40)} ✕</button>
                  ))}
                </div>
                <div className="small-muted" style={{ marginTop: 8 }}>Press any one to turn just that off.</div>
              </>
            )
            : <div className="small-muted">No filter is on — the invoices simply are not there.</div>}
          <div className="qa-row" style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-sm btn-primary" onClick={resetAll}>Clear everything and show all {data.rows.length}</button>
          </div>
        </div>
      )}

      <section className="inv-stats" aria-label="Headline figures">
        <div className="inv-stat"><div className="inv-stat-l">Total candidates</div><div className="inv-stat-v">{st.candidates}</div><div className="small-muted">on {live.length} invoice{live.length === 1 ? '' : 's'}</div></div>
        <div className="inv-stat"><div className="inv-stat-l">Total clients</div><div className="inv-stat-v">{st.clients}</div><div className="small-muted">{live.length} invoice(s){ni.waiting ? ` · ${ni.waiting} not invoiced yet` : ''}</div></div>
        <div className="inv-stat"><div className="inv-stat-l">Total amount</div><div className="inv-stat-v">{money(st.total)}</div><div className="small-muted">after GST</div></div>
        <div className="inv-stat good"><div className="inv-stat-l">Amount received</div><div className="inv-stat-v">{money(st.received)}</div><div className="small-muted">{st.receivable ? Math.round((st.received / st.receivable) * 100) : 0}% of what&apos;s receivable</div></div>
        <div className="inv-stat"><div className="inv-stat-l">Pending amount</div><div className="inv-stat-v">{money(st.pending)}</div><div className="small-muted">after TDS is withheld</div></div>
        <div className={`inv-stat${st.overdue.length ? ' bad' : ''}`}><div className="inv-stat-l">Overdue invoices</div><div className="inv-stat-v">{st.overdue.length}</div><div className="small-muted">{st.overdue.length ? `${money(sumOf(st.overdue, (r) => r.pending))} past due` : 'nothing past due'}</div></div>
      </section>

      <section className="inv-panel" aria-label="Aging">
        <div className="inv-aging-head">
          <h3>Aging of what&apos;s still owed</h3>
          <p className="inv-tdsline">
            TDS to collect: <b>{money(sumOf(certDue, (r) => r.tds))}</b> in Form 16A certificates not yet received
            ({certDue.length} invoice{certDue.length === 1 ? '' : 's'}) · <b>{money(openTds)}</b> more will be withheld on open invoices
          </p>
        </div>
        <div className="inv-chips" role="group" aria-label="Filter by age">
          {chipData.map((c) => (
            <button
              type="button"
              key={c.k}
              className={`inv-chip sev-${c.sev || 0}`}
              aria-pressed={age === c.k}
              onClick={() => setAge(age === c.k && c.k !== 'All' ? 'All' : c.k)}
            >
              <span className="c-t"><span>{c.t}</span><span className="c-n">{c.count}</span></span>
              <span className="c-a">{money(c.amt)}</span>
              <span className="inv-chip-bar" aria-hidden="true"><i style={{ width: `${c.k === 'All' ? 100 : Math.round((c.amt / maxAmt) * 100)}%` }} /></span>
            </button>
          ))}
        </div>
      </section>

      <div className="filter-row" style={{ margin: 0 }}>
        <span className="section-label" style={{ margin: '0 4px 0 0' }}>Saved views</span>
        {views.length === 0 && <span className="small-muted">None yet — set your filters, then save the combination so you never set them again.</span>}
        {views.map((v) => (
          <span className="chip" key={v.name}>
            <button type="button" className="link-btn" onClick={() => applyView(v)}>{v.name}</button>
            <button type="button" title="Remove" onClick={() => deleteView(v.name)}>×</button>
          </span>
        ))}
        <button type="button" className="btn btn-sm" onClick={saveView}>＋ Save this view</button>
      </div>

      <section className="inv-panel inv-tpanel" aria-label="Invoices">
        <div className="inv-tbar">
          <h3>Invoices <span className="count">{rows.length} shown</span></h3>
          <div className="inv-tbar-r">
            <label className="inv-inline">Sort
              <select value={sort} onChange={(e) => setSort(e.target.value)}>
                {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label className="inv-inline">Group by
              <select value={group} onChange={(e) => setGroup(e.target.value)}>
                {GROUP_BY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
          </div>
        </div>
        {/* Scrolls both ways inside its own box; Invoice No + Client stay
            pinned left, Actions pinned right, the header on top and the
            totals row at the bottom (invoices/invTable.css). */}
        <div className="inv-grid-wrap" ref={tableRef} tabIndex={0} aria-label="Invoice table — scrolls sideways and down">
          <table className="inv-grid">
            <thead>
              <tr>
                {active.map(([key, label]) => (
                  <th key={key} scope="col" className={[STICKY[key], NUM_COLS.has(key) ? 'num' : '', `c-${key}`].filter(Boolean).join(' ')}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={active.length} className="small-muted" style={{ textAlign: 'center', padding: 28 }}>
                    <div className="inv-grp-in" style={{ justifyContent: 'center' }}>
                      {filters.rec !== ALL ? 'No invoices generated for this employee.' : 'No invoices found for the selected filters.'}
                      {' '}<button type="button" className="link-btn" onClick={resetAll}>Clear filters</button>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr>
                  {active.map(([key]) => {
                    const cls = [STICKY[key], NUM_COLS.has(key) ? 'num' : ''].filter(Boolean).join(' ') || undefined;
                    if (key === 'inv') return <td key={key} className={cls}>Total ({totals.count} invoice{totals.count === 1 ? '' : 's'})</td>;
                    if (key === 'pays') return <td key={key} className={cls}>{totals.pays}</td>;
                    if (MONEY_FIELD[key]) return <td key={key} className={cls}>{money2(totals[key])}</td>;
                    return <td key={key} className={cls} />;
                  })}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        {!grouped && rows.length > 25 && <Pager page={page} noun="invoices" />}
        <p className="inv-foot">
          Fee is the client&apos;s agreed percentage of the candidate&apos;s annual CTC (or a flat fee per hire). GST is charged at the
          client&apos;s rate on the fee — CGST + SGST within our state, IGST when the client is in another state. Clients withhold
          TDS under section 194J on the fee before GST, so “pending” is what will actually reach the bank. Aging counts days past
          each invoice&apos;s payment due date.
        </p>
      </section>

      {accountFor && (
        <ClientAccountModal
          clientId={accountFor.clientId}
          clientName={accountFor.client}
          onClose={() => setAccountFor(null)}
        />
      )}
      {payFor && (
        <PaymentModal
          rows={data.rows}
          initialId={payFor.id}
          onClose={() => setPayFor(null)}
          onSaved={(id, msg) => { setPayFor(null); setFlash(msg); load(); focusRow(id); }}
        />
      )}
      {joinFor !== null && (
        <NewJoinModal
          initialId={joinFor}
          onClose={() => setJoinFor(null)}
          onSaved={(id, msg) => { setJoinFor(null); setFlash(msg); load(); focusRow(id); }}
        />
      )}
    </div>
  );
}
