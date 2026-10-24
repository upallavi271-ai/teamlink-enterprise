import {
  Fragment, useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { can } from '../permissions';
import Combo from '../components/Combo.jsx';
import FilterChips from '../components/FilterChips.jsx';
import Pager, { usePaged } from '../components/Pager.jsx';
import ClientGroups, { buildClientGroups } from './invoices/ClientGroups.jsx';
// One client = one row: the client-invoice rows + panel, the invoice window, the grouping.
import ClientInvoiceRows, { CI_HEADS, ciHeadClass } from './invoices/ClientInvoiceRows.jsx';
// WhatsApp quick chat (free wa.me links): row ticks + 'Send WhatsApp' for payment reminders, Resume bar (components/wa/)
import WaBulkModal from '../components/wa/WaBulkModal.jsx';
import WaResume from '../components/wa/WaResume.jsx';
import { useWaConfig, waMayUse } from '../components/wa/waKit.js';
import ClientInvoiceView from './invoices/ClientInvoiceView.jsx';
import { groupIndex, buildClientInvoices } from './invoices/clientInvoice';
import { cardsOf, chipsOf, rowsForAge } from './invoices/invSummary';
import '../components/ui/ui.css';
import AccountsImport from '../components/AccountsImport.jsx';
import PaymentModal from './invoices/PaymentModal.jsx';
import NewJoinModal from './invoices/NewJoinModal.jsx';
import NewInvoiceModal from './invoices/NewInvoiceModal.jsx';
import AddClientModal from './invoices/AddClientModal.jsx';
import ClientAccountModal from './invoices/ClientAccountModal.jsx';
// B2 — the Credit & debit notes tab.
import CreditNotesPanel from './invoices/CreditNotesPanel.jsx';
import PartnerPayoutsPanel from './invoices/PartnerPayoutsPanel.jsx'; // B7: agency / freelancer payouts
import {
  money, money2, fmtD,
} from './invoices/invFormat';
import { saveBlob } from './office/officeUtil';
import { invoiceDocumentHtml, esc } from './invoices/invoiceDoc';
import {
  ALL, changeFilter, reconcile, departmentOptions, sectionOptions, employeeOptions, roleOptions, describeEmployee,
  waitingUnder, sectionByKey, personByKey, deptLabelOf,
} from './invoices/invHierarchy';
import PeriodPicker, { periodText } from '../components/accounts/PeriodPicker.jsx';
import MultiPick from './invoices/MultiPick.jsx';
import ScrollSync from '../components/accounts/ScrollSync.jsx';
import {
  NONE, APPLY_TO, PERIOD_PRESETS, ALL_PERIOD, periodOn, STATUS_OPTS, statusLabel, GST_OPTS, GST_HISTORY,
  BLANK_FILTERS, normFilters, normPeriod, passes, facetCounts, resolveClients,
  DUE_OPTS, TDS_STATUS_OPTS, GST_TYPE_OPTS, rateLabel,
} from './invoices/invFilters';
import AppOmniPanel from '../components/omni/AppOmniPanel.jsx'; // Omni-Channel: the shared template library + payment follow-up campaigns of Accounts (inside this screen)
import AppCampaignModal from '../components/omni/library/AppCampaignModal.jsx';
import { shared as omniShared } from '../components/omni/omniApi.js';
import useClientLabel from '../components/clients/useClientLabel.js'; // "Name - Location" for same-name clients (2026-10-22)
import './invoices/invoices.css';
import './invoices/invTable.css';
import './invoices/invFilters.css';
import './invoices/invTax.css';

// AccountsDashboard and InvoiceDetail import these from here.
export { money, money2, fmtD };

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

// The printable invoice template lives in invoices/invoiceDoc.js (pure, testable); re-exported for InvoiceDetail.
export { invoiceDocumentHtml };

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

// THE INVOICE LIST (2026-10-14, founder spec "one client = one row"): ONE row per
// client invoice with 7 columns (invoices/ClientInvoiceRows.jsx CI_HEADS). Every
// other figure of the old 23 columns lives in the row's detail panel.
const GROUP_BY = [['inv', 'Invoice'], ['client', 'Client'], ['dept', 'Department'], ['rec', 'Recruiter'], ['month', 'Invoice month']];

// The age buckets the register computes (utils/accounts.js ageBucket), with
// the labels the approved design prints.
const BUCKETS = [
  { k: 'All', t: 'All' },
  { k: 'Not due yet', t: 'Not due yet', sev: 0 },
  { k: '0–30 days', t: '0-30 days', sev: 1 },
  { k: '31–60 days', t: '31-60 days', sev: 2 },
  { k: '61–90 days', t: '61-90 days', sev: 3 },
  { k: '90+ days', t: '90+ days', sev: 3 },
  // Nothing left to collect — its amount is what came in, not what is owed.
  { k: 'Settled', t: 'Settled', sev: 'ok' },
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
  // Default: the invoice list, one row per client invoice (Group by Client is one click away).
  return GROUP_BY.some(([v]) => v === g) ? g : 'inv';
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
// "Show all filters" (S7.5) — ON by default; OFF keeps Client, Period,
// Recruiter, Status and Search.
const SHOWALL_KEY = 'tl.invoices.showAllFilters';
// The three downloads, all over the invoices on screen (S7.6).
const EXPORTS = [
  { k: 'excel', label: 'Excel', path: '/invoices/register/export.xlsx', file: 'invoices.xlsx', title: 'Download exactly the invoices shown below' },
  { k: 'accounts', label: 'Invoice accounts', path: '/invoices/register/accounts.xlsx', file: 'invoice-accounts.xlsx', title: 'Each client’s account (billed, received, pending) and the ledger behind it — for the invoices shown' },
  { k: 'instalments', label: 'Instalments', path: '/invoices/register/instalments.xlsx', file: 'instalments.xlsx', title: 'Every payment received against the invoices shown' },
];

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

// One filter cell: a small uppercase label with its count badge ("CLIENT · 33").
function Field({
  label, count, children, className, htmlFor, as = 'label',
}) {
  const Tag = as;
  return (
    <Tag className={`invf-field${className ? ` ${className}` : ''}`} {...(as === 'label' && htmlFor ? { htmlFor } : {})}>
      <span className="invf-lbl">{label}{count != null && <b className="invf-badge">{Number(count).toLocaleString('en-IN')}</b>}</span>
      {children}
    </Tag>
  );
}
const readShowAll = () => { const v = readStore(SHOWALL_KEY); return v == null ? true : v === '1'; };

export default function Invoices() {
  const { user } = useAuth();
  const clientLabel = useClientLabel();
  const canCreate = can(user, 'accounts', 'accounts', 'Invoices', 'create');
  const canPay = can(user, 'accounts', 'accounts', 'Payments', 'create');
  const canExport = can(user, 'accounts', 'accounts', 'Invoices', 'export');
  const canBankView = can(user, 'accounts', 'accounts', 'Bank & Reconciliation', 'view'); // eslint-disable-line no-unused-vars
  // Who may add a missing date of joining from the panel: the joining editors and Accounts.
  const canJoin = can(user, 'ats', 'interviews', 'Joining', 'edit') || can(user, 'accounts', 'accounts', 'Invoices', 'edit');

  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [payCampaign, setPayCampaign] = useState(null); // { ids } = the clients behind the ticked invoices, for a payment follow-up campaign
  const [payErr, setPayErr] = useState('');
  const [waSel, setWaSel] = useState(() => new Set()); // client invoices ticked for WhatsApp (the lead invoice id of each)
  const [waBulk, setWaBulk] = useState(null);
  const [waTick, setWaTick] = useState(0);
  const waOn = waMayUse(useWaConfig(), 'invoice');
  // { from, to, preset, applyTo } — the shared Accounts calendar (S7.3).
  const [period, setPeriod] = useState(ALL_PERIOD);
  const [filters, setFilters] = useState(BLANK_FILTERS);
  const [age, setAge] = useState('All');
  const [group, setGroup] = useState(loadGroup);
  const [hot, setHot] = useState(null); // the row just paid / picked, briefly highlighted
  const [views, setViews] = useState(loadViews);
  const [importing, setImporting] = useState(false);
  const [payFor, setPayFor] = useState(null); // null | { id }
  const [accountFor, setAccountFor] = useState(null); // null | { clientId, client }
  const [joinFor, setJoinFor] = useState(null); // null | '' | applicationId
  const [newInvoice, setNewInvoice] = useState(false); // manual invoice (client picked from the central list)
  const [addClient, setAddClient] = useState(false); // "+ Add client" (a draft client in the central list)
  const [menu, setMenu] = useState(null); // null | 'bell'
  const [exporting, setExporting] = useState(''); // '' | an EXPORTS key
  const [sort, setSort] = useState('new');
  const [showAll, setShowAllState] = useState(readShowAll);
  const setShowAll = (next) => { setShowAllState(next); writeStore(SHOWALL_KEY, next ? '1' : '0'); };
  // Which client invoices have their detail panel open (several at once). ONE toggle serves the row, the Invoice No and the arrow.
  const [openInv, setOpenInv] = useState(() => new Set());
  const toggleInv = useCallback((k) => setOpenInv((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; }), []);
  const [viewFor, setViewFor] = useState(null); // null | a client invoice (the invoice window)
  const bellRef = useRef(null);
  const noticeRef = useRef(null);
  const tableRef = useRef(null);

  // LINKS INTO THIS PAGE (the Accounts desk / Management dashboards):
  //   ?period=M:2026-09 | Q2:2026 | FY:2026   ?status=Overdue   ?clientId=<client id>  (or ?client=<name>, turned into the id(s) once the register is in)
  //   ?age=0-30 | 31-60 | 61-90 | 90+ | 60+   ?join=new | <applicationId>
  //   ?pay=1 | <invoiceId>   — read once on arrival.
  const [urlQ, setUrlQ] = useSearchParams();
  const tab = ['notes', 'payouts'].includes(urlQ.get('tab')) ? urlQ.get('tab') : 'invoices';
  const setTab = (t) => { const n = new URLSearchParams(urlQ); if (t === 'notes' || t === 'payouts') n.set('tab', t); else n.delete('tab'); n.delete('raise'); setUrlQ(n, { replace: true }); };
  useEffect(() => {
    // The desk's period words (M:2026-09, Q2:2026, FY:2026) become the same
    // dates on the calendar, applied to the invoice date.
    const p = urlQ.get('period');
    if (p) setPeriod(normPeriod(p));
    const status = urlQ.get('status');
    const client = urlQ.get('clientId') || urlQ.get('client');
    if (status || client) setFilters((f) => normFilters({ ...f, ...(status ? { status } : {}), ...(client ? { clients: [client] } : {}) }));
    const AGE = { '0-30': '0–30 days', '31-60': '31–60 days', '61-90': '61–90 days', '90+': '90+ days', '60+': '60+' };
    if (AGE[urlQ.get('age')]) setAge(AGE[urlQ.get('age')]);
    const join = urlQ.get('join');
    if (join && canCreate) setJoinFor(join === 'new' ? '' : join);
    const pay = urlQ.get('pay');
    if (pay && canPay) setPayFor({ id: pay === '1' ? null : pay });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The whole register once; the Period and every other filter then work in
  // the browser over the same rows (invoices/invFilters.js), instantly.
  // Two loads can overlap (a payment, then a quick second change): only the LATEST answer is shown, an older
  // one that arrives late is ignored (and its request is aborted), so the cards never show stale money.
  const loadSeq = useRef(0);
  const loadCtl = useRef(null);
  const load = useCallback(() => {
    loadSeq.current += 1;
    const mine = loadSeq.current;
    if (loadCtl.current) loadCtl.current.abort();
    const ctl = new AbortController();
    loadCtl.current = ctl;
    api.get('/invoices/register', { params: { period: 'all' }, signal: ctl.signal })
      .then((res) => { if (mine === loadSeq.current) setData(res.data); })
      .catch((e) => { if (mine === loadSeq.current && !(e && (e.code === 'ERR_CANCELED' || e.name === 'CanceledError'))) setError(e.response?.data?.error || 'That did not work.'); });
  }, []);
  useEffect(() => () => { loadSeq.current += 1; if (loadCtl.current) loadCtl.current.abort(); }, []);
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

  // S7.7a — the table header never hides under the app's sticky top bar:
  // the shared ScrollSync box (below) lifts it to sit just under the bar.

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
  const setOne = (field, value) => setFilters((f) => ({ ...f, [field]: value }));
  // CASCADING (filter rule): every list is counted over the rows the OTHER
  // filters leave; options with nothing behind them are hidden.
  const fc = useMemo(() => facetCounts(data?.rows || [], filters, period, stance), [data, filters, period, stance]);
  const keep = (n, picked) => n > 0 || picked;
  // The Client list is made of client IDS (two clients may share a name: told apart by their Location on screen).
  const clientList = useMemo(() => {
    if (data?.clientList) return data.clientList;
    const m = new Map();
    (data?.rows || []).forEach((r) => { if (r.clientId && !m.has(r.clientId)) m.set(r.clientId, { id: r.clientId, name: r.client }); });
    return [...m.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }, [data]);
  const clientName = useMemo(() => {
    // Same-name clients are two LOCATIONS: "Name - Location" (components/clients/useClientLabel.js). Only if two still read the same, a short id is added.
    const labels = clientList.map((c) => [c.id, clientLabel(c)]);
    const dup = new Set(labels.map(([, l]) => l).filter((n, i, a) => a.indexOf(n) !== i));
    return new Map(labels.map(([id, l]) => [id, dup.has(l) ? `${l} (id …${String(id).slice(-5)})` : l]));
  }, [clientList, clientLabel]);
  const clientOpts = useMemo(() => clientList.map((c) => ({ value: c.id, label: clientName.get(c.id) || c.name, count: fc.clients.get(c.id) || 0 })), [clientList, clientName, fc]);
  // A client name from an old link / saved view becomes the client id(s) as soon as the list is known.
  useEffect(() => {
    if (!clientList.length) return;
    setFilters((f) => {
      if (!f.clients.length || f.clients.every((v) => clientList.some((c) => c.id === v))) return f;
      return { ...f, clients: resolveClients(f.clients, clientList) };
    });
  }, [clientList]);
  const recOpts = useMemo(() => {
    const list = [...fc.recs.keys(), ...filters.recs.filter((k) => !fc.recs.has(k))]
      .filter((k) => k !== NONE)
      .map((k) => ({ value: k, label: fc.recLabel.get(k) || (personByKey(hier, k) || {}).name || k, count: fc.recs.get(k) || 0 }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    return [{ value: NONE, label: 'Unassigned (no recruiter)', count: fc.recs.get(NONE) || 0, special: true }, ...list];
  }, [fc, filters.recs, hier]);
  const deptList = deptOpts.map((o) => ({ ...o, count: fc.dept.get(o.value) || 0 })).filter((o) => keep(o.count, filters.dept === o.value));
  const secOpts = useMemo(() => sectionOptions(hier, filters.dept), [hier, filters.dept]);
  const secList = secOpts.map((o) => ({ ...o, count: fc.section.get(o.value) || 0 })).filter((o) => keep(o.count, filters.section === o.value));
  // Role = the department's seats (EDU-1…, TL) and Employee = whoever held the chosen seat, current or former.
  const empOpts = useMemo(() => employeeOptions(hier, filters.dept, filters.section, filters.role), [hier, filters.dept, filters.section, filters.role]);
  // Current holders always show; former holders only when they have invoices in view.
  const empList = empOpts.map((o) => ({ ...o, count: fc.rec.get(o.value) || 0 })).filter((o) => keep(o.count, filters.rec === o.value || o.current));
  const roleOpts = useMemo(() => roleOptions(hier, filters.dept, filters.section), [hier, filters.dept, filters.section]);
  const roleList = roleOpts.map((o) => ({ ...o, count: fc.role.get(o.value) || 0 })).filter((o) => keep(o.count, filters.role === o.value));
  const empInfo = filters.rec !== ALL ? describeEmployee(hier, filters.rec, filters.dept, filters.section, filters.role) : null;
  // P4 — GST / TDS lists, counted over what the OTHER filters leave; a value
  // with nothing behind it is hidden unless it is the one picked.
  const rateList = (m, picked) => [...m.keys()].sort((a, b) => Number(a) - Number(b))
    .map((k) => ({ value: k, count: m.get(k) || 0 })).filter((o) => keep(o.count, picked === o.value));
  const gstRateList = rateList(fc.gstRate, filters.gstRate);
  const tdsRateList = rateList(fc.tdsRate, filters.tdsRate);
  const gstTypeList = GST_TYPE_OPTS.map((o) => ({ ...o, count: fc.gstType.get(o.value) || 0 })).filter((o) => keep(o.count, filters.gstType === o.value));
  const tdsStatusList = TDS_STATUS_OPTS.map((v) => ({ value: v, count: fc.tdsStatus.get(v) || 0 })).filter((o) => keep(o.count, filters.tdsStatus === o.value));
  const dueList = DUE_OPTS.map((o) => ({ ...o, count: fc.due.get(o.value) || 0 })).filter((o) => keep(o.count, filters.due === o.value));

  // Every filter except the age chips — the chips count what these leave.
  // Department / Section / Employee match on the invoice's attributed seat
  // and employee keys (utils/invoiceHierarchy.js), never on a name string.
  const base = useMemo(() => {
    if (!data) return [];
    return data.rows.filter((r) => passes(r, filters, period, stance));
  }, [data, filters, period, stance]);
  // ONE CLIENT = ONE ROW. The register's candidate rows are grouped (invoices/clientInvoice.js)
  // AFTER the filters, so every card, chip, the TOTAL and the downloads still add up the same rows.
  const index = useMemo(() => groupIndex(data?.rows || []), [data]);
  // The client invoices of everything the other filters leave: the age chips count THESE, and a chip keeps
  // each client invoice whole ('60+' = the Accounts desk's link: 61–90 and 90+ together).
  const baseGroups = useMemo(() => buildClientInvoices(base, index), [base, index]);
  const rows = useMemo(() => {
    const list = rowsForAge(base, baseGroups, age);
    const cmp = (SORTS.find(([k]) => k === sort) || SORTS[0])[2];
    return [...list].sort(cmp);
  }, [base, baseGroups, age, sort]);
  const allGroups = useMemo(() => buildClientInvoices(data?.rows || [], index), [data, index]);
  const cmpOf = (SORTS.find(([k]) => k === sort) || SORTS[0])[2];
  const invGroups = useMemo(() => buildClientInvoices(rows, index).sort(cmpOf), [rows, index, cmpOf]);
  // any candidate invoice id -> the id its row answers to
  const leadOf = useMemo(() => {
    const m = new Map();
    allGroups.forEach((g) => g.ids.forEach((id) => m.set(id, g.id)));
    return m;
  }, [allGroups]);

  // The other groupings: heading rows, each holding its client invoices.
  const grouped = useMemo(() => {
    if (group === 'inv' || group === 'client') return null; // the plain list / the client table (ClientGroups)
    const keyOf = (r) => (group === 'dept' ? (r.department || '—')
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
      rows: map.get(k),
      list: buildClientInvoices(map.get(k), index).sort(cmpOf),
    }));
  }, [rows, group, index, cmpOf]);
  // The downloads follow the screen's order (a client invoice's candidates stay together).
  const displayRows = useMemo(() => {
    if (grouped) return grouped.flatMap((g) => g.list.flatMap((x) => x.members));
    if (group === 'client') return buildClientGroups(rows, sort, index).flatMap((g) => g.inv.flatMap((x) => x.members));
    return invGroups.flatMap((x) => x.members);
  }, [grouped, rows, group, sort, index, invGroups]);
  // Paged 25 / 50 / 100 when the list is flat; grouped, every group shows whole so its subtotals always match the rows under it.
  const page = usePaged(invGroups);
  // The client table pages over CLIENTS (a client's invoices are never split across pages).
  const clientGroups = useMemo(() => buildClientGroups(rows, sort, index), [rows, sort, index]);
  const cpage = usePaged(clientGroups, 25);

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

  // ONE reading of the money for the six cards and the age chips (invoices/invSummary.js).
  const st = cardsOf(rows, invGroups);
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
    // TDS by where it stands (P4 point 11).
    tdsPending: sumOf(rows.filter((r) => r.tdsStatus === 'Pending'), (r) => r.tds),
    tdsDeducted: sumOf(rows.filter((r) => r.tdsStatus === 'Deducted'), (r) => r.tds),
    tdsCertified: sumOf(rows.filter((r) => r.tdsStatus === 'Certificate Received'), (r) => r.tds),
  };
  // Aging chips over everything the other filters leave: every client invoice that still owes sits in ONE bucket.
  const chipData = chipsOf(baseGroups).map((c) => ({ ...c, ...(BUCKETS.find((b) => b.k === c.k) || {}) }));
  const maxAmt = Math.max(1, ...chipData.filter((c) => c.k !== 'All' && c.k !== 'Settled').map((c) => c.amt));
  // The TDS pill reads the same rows as the cards and the table.
  const certDue = rows.filter((r) => r.status !== 'Cancelled' && r.received > 0 && r.tds > 0.5 && r.tdsCert !== 'in hand');
  const openTds = sumOf(rows.filter((r) => r.status !== 'Cancelled' && r.pending > 0.5), (r) => r.tds);
  // Header counts (S7.6): candidates on the invoices shown, and how many of
  // those placements the ATS marks as dropped.
  const shownCands = new Set(rows.map((r) => r.candidateId).filter(Boolean)).size;
  const dropped = rows.filter((r) => /drop/i.test(String(r.joiningStatus || ''))).length;

  // A saved view keeps EVERYTHING on screen: period (with its "Apply to"),
  // every filter incl. Recruiter, the age chip, grouping, sort and the
  // Show-all toggle.
  const saveView = () => {
    const name = window.prompt('Name this view');
    if (!name) return;
    const next = [...views.filter((v) => v.name !== name), {
      name, v: 2, period, filters, age, group, sort, showAll,
    }];
    setViews(next);
    writeStore(VIEWS_KEY, JSON.stringify(next));
    setFlash(`Saved the view “${name}”.`);
  };
  const applyView = (v) => {
    // Older views held a period word ('M:2026-09') and a single client name.
    setPeriod(normPeriod(v.period));
    // Anything that is not a valid department / section / employee now goes back to All.
    setFilters(reconcile({ ...normFilters(v.filters), clients: resolveClients(normFilters(v.filters).clients, clientList) }, hier, validDepts));
    setAge(v.age || 'All');
    if (GROUP_BY.some(([g]) => g === v.group)) setGroup(v.group);
    if (SORTS.some(([s]) => s === v.sort)) setSort(v.sort);
    if (typeof v.showAll === 'boolean') setShowAll(v.showAll);
    setFlash(`Showing the view “${v.name}”.`);
  };
  const deleteView = (name) => {
    const next = views.filter((v) => v.name !== name);
    setViews(next);
    writeStore(VIEWS_KEY, JSON.stringify(next));
  };

  // What is switched on, in the words the user picked, so a filter that finds
  // nothing can say why and be turned off one at a time.
  const many = (list, labelOf) => (list.length === 1 ? labelOf(list[0]) : `${labelOf(list[0])} +${list.length - 1}`);
  const recName = (k) => (k === NONE ? 'Unassigned' : (recOpts.find((o) => o.value === k) || {}).label || (personByKey(hier, k) || {}).name || k);
  const gstWord = (v) => ([...GST_OPTS, ...GST_HISTORY].find((o) => o.value === v) || {}).label || v;
  const activeBits = [
    periodOn(period) && { t: 'Period', v: `${periodText(period)} · by ${(APPLY_TO.find((o) => o.value === period.applyTo) || APPLY_TO[0]).label.toLowerCase()}`, fix: () => setPeriod(ALL_PERIOD) },
    filters.q.trim() && { t: 'Search', v: `"${filters.q.trim()}"`, fix: () => setOne('q', '') },
    filters.clients.length > 0 && { t: 'Client', v: many(filters.clients, (c) => clientName.get(c) || c), fix: () => setOne('clients', []) },
    filters.dept !== ALL && { t: 'Department', v: deptLabelOf(hier, filters.dept), fix: () => setF('dept', ALL) },
    filters.section !== ALL && { t: 'Section', v: (sectionByKey(hier, filters.section) || {}).label || filters.section, fix: () => setF('section', ALL) },
    filters.role !== ALL && { t: 'Role', v: filters.role, fix: () => setOne('role', ALL) },
    filters.recs.length > 0 && { t: 'Recruiter', v: many(filters.recs, recName), fix: () => setOne('recs', []) },
    filters.rec !== ALL && { t: 'Employee', v: (personByKey(hier, filters.rec) || {}).name || filters.rec, fix: () => setF('rec', ALL) },
    filters.gstin !== ALL && { t: 'GST applicable', v: gstWord(filters.gstin), fix: () => setOne('gstin', ALL) },
    filters.gstType !== ALL && { t: 'GST type', v: (GST_TYPE_OPTS.find((o) => o.value === filters.gstType) || {}).label || filters.gstType, fix: () => setOne('gstType', ALL) },
    filters.gstRate !== ALL && { t: 'GST rate', v: rateLabel(filters.gstRate, 'No GST'), fix: () => setOne('gstRate', ALL) },
    filters.tds !== ALL && { t: 'TDS applicable', v: filters.tds, fix: () => setOne('tds', ALL) },
    filters.tdsRate !== ALL && { t: 'TDS rate', v: rateLabel(filters.tdsRate, 'No TDS'), fix: () => setOne('tdsRate', ALL) },
    filters.tdsStatus !== ALL && { t: 'TDS status', v: filters.tdsStatus, fix: () => setOne('tdsStatus', ALL) },
    filters.due !== ALL && { t: 'Due date', v: (DUE_OPTS.find((o) => o.value === filters.due) || {}).label || filters.due, fix: () => setOne('due', ALL) },
    filters.status !== ALL && { t: 'Status', v: statusLabel(filters.status), fix: () => setOne('status', ALL) },
    age !== 'All' && { t: 'Age', v: age, fix: () => setAge('All') },
  ].filter(Boolean);
  const resetAll = () => { setFilters(BLANK_FILTERS); setAge('All'); setPeriod(ALL_PERIOD); };
  const chipList = activeBits.map((b) => ({ key: b.t, label: b.t, value: String(b.v), onRemove: b.fix }));
  const stanceCount = (kind) => Object.values(stance).filter((v) => v === kind).length;
  // Filters hidden while "Show all filters" is OFF but still switched on.
  const hiddenOn = showAll ? 0 : ['dept', 'section', 'role', 'rec', 'gstin', 'gstType', 'gstRate', 'tds', 'tdsRate', 'tdsStatus', 'due'].filter((k) => filters[k] !== ALL).length;

  // The three downloads — exactly the invoices on screen, in screen order.
  const doExport = async (x) => {
    setExporting(x.k); setError('');
    try {
      const res = await api.post(x.path, {
        period: 'all',
        ids: displayRows.map((r) => r.id),
        filters: activeBits.map((b) => `${b.t}: ${b.v}`).join(' · '),
      }, { responseType: 'blob' });
      saveBlob(res, x.file);
      setFlash(`Downloaded “${x.label}” for ${displayRows.length} invoice(s).`);
    } catch {
      setError(`The “${x.label}” file could not be made. Please try again.`);
    }
    setExporting('');
  };

  // Bring one row into view inside the table's own scroll box and light it
  // up for a moment — after a payment, or from the bell.
  const focusRow = (id) => {
    const lead = leadOf.get(id) || id;
    setHot(lead);
    if (!grouped && group !== 'client') {
      const ix = invGroups.findIndex((g) => g.id === lead);
      if (ix >= 0) page.setPage(Math.floor(ix / page.size) + 1);
    }
    setTimeout(() => {
      const el = document.querySelector(`tr[data-inv="${lead}"]`);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus({ preventScroll: true }); }
    }, 150);
    setTimeout(() => setHot((h) => (h === lead ? null : h)), 4000);
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


  // What every client-invoice row and panel can do (ONE set of handlers for both groupings).
  const handlers = {
    canPay,
    canJoin,
    onPay: (g) => setPayFor({ id: g.id }),
    onAccount: (g) => setAccountFor({ clientId: g.clientId, client: g.client }),
    onView: (g) => setViewFor(g),
    onChanged: load,
    wa: waOn ? { sel: waSel, toggle: (id) => setWaSel((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; }) } : null,
  };
  const rowsOf = (list) => <ClientInvoiceRows groups={list} open={openInv} toggle={toggleInv} hot={hot} handlers={handlers} />;

  let body;
  if (!grouped) {
    body = rowsOf(page.slice);
  } else {
    body = grouped.map((g) => (
      <Fragment key={`g-${g.key}`}>
        <tr className="inv-grp">
          <td colSpan={CI_HEADS.length}>
            {/* Pinned to the left edge so the heading stays in view while the table scrolls sideways. */}
            <div className="inv-grp-in">
              <div>
                <strong>{g.label}</strong>
                <span className="small-muted" style={{ marginLeft: 8 }}>{g.list.length} invoice(s)</span>
              </div>
              <div className="inv-grp-sums">
                <span>Before GST<b>{money2(sumOf(g.rows, (r) => r.billing))}</b></span>
                <span>After GST<b>{money2(sumOf(g.rows, (r) => r.invoiceValue))}</b></span>
                <span>Received<b>{money2(sumOf(g.rows, (r) => r.received))}</b></span>
                <span>Pending<b>{money2(sumOf(g.rows, (r) => r.pending))}</b></span>
              </div>
            </div>
          </td>
        </tr>
        {rowsOf(g.list)}
      </Fragment>
    ));
  }

  // B2 — Invoices | Credit & debit notes (tabs inside this module, no new sidebar entry).
  const tabBar = (
    <div className="cn-tabs" role="tablist" aria-label="Invoices">
      <button type="button" role="tab" aria-selected={tab === 'invoices'} className={`cn-tab${tab === 'invoices' ? ' is-on' : ''}`} onClick={() => setTab('invoices')}>Invoices</button>
      <button type="button" role="tab" aria-selected={tab === 'notes'} className={`cn-tab${tab === 'notes' ? ' is-on' : ''}`} onClick={() => setTab('notes')}>
        Credit &amp; debit notes{data?.kpis?.withNotes ? <em>{data.kpis.withNotes}</em> : null}
      </button>
      {/* B7 — what we owe agencies / freelancers for their joinings. */}
      <button type="button" role="tab" aria-selected={tab === 'payouts'} className={`cn-tab${tab === 'payouts' ? ' is-on' : ''}`} onClick={() => setTab('payouts')}>Partner payouts</button>
    </div>
  );
  if (tab === 'payouts') {
    return (
      <div className="inv-page">
        <header className="inv-head">
          <div className="inv-head-main">
            <nav className="inv-crumbs" aria-label="Breadcrumb">
              <span>TeamLink Accounts</span><span aria-hidden="true">/</span><span>Invoice</span><span aria-hidden="true">/</span><span aria-current="page">Partner payouts</span>
            </nav>
            <h1>Partner payouts</h1>
            <p className="inv-lede">What we owe an agency or freelancer when a candidate they sent joins: fee + GST − TDS = net. On hold until the guarantee ends, approved by a second person, then paid. Approved payouts are booked as an office cost “Partner payout”.</p>
          </div>
        </header>
        {tabBar}
        <PartnerPayoutsPanel canExport={canExport} />
      </div>
    );
  }
  if (tab === 'notes') {
    return (
      <div className="inv-page">
        <header className="inv-head">
          <div className="inv-head-main">
            <nav className="inv-crumbs" aria-label="Breadcrumb">
              <span>TeamLink Accounts</span><span aria-hidden="true">/</span><span>Invoice</span><span aria-hidden="true">/</span><span aria-current="page">Credit &amp; debit notes</span>
            </nav>
            <h1>Credit &amp; debit notes</h1>
            <p className="inv-lede">Money taken off an invoice (a candidate left inside the guarantee, a refund, a wrong amount) or added to it (a fee that was missed). A note changes nothing until another Accounts approver issues it.</p>
          </div>
        </header>
        {tabBar}
        <CreditNotesPanel
          invoiceRows={data?.rows || []}
          raiseFor={urlQ.get('raise') || ''}
          onRaiseUsed={() => { const n = new URLSearchParams(urlQ); n.delete('raise'); setUrlQ(n, { replace: true }); }}
          canCreate={canCreate}
          canExport={canExport}
          onChanged={load}
        />
      </div>
    );
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
          <AppOmniPanel app="Accounts" className="btn inv-hbtn" />
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
          {canCreate && <button type="button" className="btn inv-hbtn" onClick={() => setNewInvoice(true)} title="Raise an invoice for any client in your list">+ New invoice</button>}
          {canCreate && <button type="button" className="btn inv-hbtn" onClick={() => setAddClient(true)} title="Add a client to the client list">+ Add client</button>}
          {canPay && <button type="button" className="btn inv-hbtn" onClick={() => setPayFor({ id: null })}>+ Payment</button>}
          {canCreate && (
            <button type="button" className="btn inv-hbtn" onClick={() => setImporting(true)}>
              <Icon d={UP_BAR} /> Import Excel
            </button>
          )}
          {canExport && EXPORTS.map((x) => (
            <button key={x.k} type="button" className="btn inv-hbtn" disabled={!!exporting || rows.length === 0} onClick={() => doExport(x)} title={rows.length ? x.title : 'No invoices match these filters'}>
              <Icon d={DOWN_BAR} /> {exporting === x.k ? 'Preparing…' : x.label}
            </button>
          ))}
        </div>
      </header>

      {tabBar}
      {importing && <AccountsImport kind="invoices" onClose={() => setImporting(false)} onDone={load} />}
      {error && <div className="notice red" style={{ margin: 0 }}><span>{error} <button type="button" className="link-btn" onClick={() => setError('')}>Dismiss</button></span></div>}
      {flash && <div className="notice" style={{ margin: 0 }} role="status"><span>{flash}</span></div>}

      <section className={`inv-panel invf${showAll ? '' : ' compact'}`} aria-label="Filters">
        <div className="invf-top">
          <h2 className="invf-title">Filters</h2>
          <label className="invf-switch" title="OFF keeps only Client, Period, Recruiter, Status and Search">
            <input type="checkbox" role="switch" aria-label="Show all filters" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} aria-checked={showAll} />
            <span className="invf-switch-ui" aria-hidden="true" />
            Show all filters
          </label>
          <span className="invf-count" aria-live="polite">
            {activeBits.length
              ? `${activeBits.length} filter${activeBits.length > 1 ? 's' : ''} applied · ${invGroups.length} of ${allGroups.length} invoices`
              : `No filters applied · all ${allGroups.length} invoices`}
            {hiddenOn > 0 && ` · ${hiddenOn} of them hidden — turn on “Show all filters” to see`}
          </span>
          <button type="button" className="btn btn-sm invf-clear" disabled={!activeBits.length} onClick={resetAll}>Clear all</button>
        </div>
        <div className="invf-body">
          <div className="invf-grid">
            <Field label="Client" count={clientOpts.filter((o) => o.count > 0).length} as="div">
              <MultiPick id="invf-client" value={filters.clients} onChange={(v) => setOne('clients', v)} options={clientOpts} allLabel="All clients" noun="client" />
            </Field>
            <Field label="Period" as="div" className="invf-period">
              <PeriodPicker
                value={period}
                onChange={(v) => setPeriod(normPeriod(v))}
                presets={PERIOD_PRESETS}
                twoMonths
                applyTo={APPLY_TO}
                label=""
              />
            </Field>
            {showAll && (
              <Field label="Department" count={deptList.length} htmlFor="invf-dept">
                <Combo id="invf-dept" value={filters.dept} onChange={(e) => setF('dept', e.target.value)}>
                  <option value="All">All departments</option>
                  {deptList.map((d) => <option key={d.value} value={d.value}>{`${d.label} (${d.count})`}</option>)}
                </Combo>
              </Field>
            )}
            {showAll && (
              <Field label="Section" count={secList.length} htmlFor="invf-sec">
                <Combo id="invf-sec" title="Only the chosen department's sections" value={filters.section} onChange={(e) => setF('section', e.target.value)}>
                  <option value="All">All sections</option>
                  {secList.map((s) => <option key={s.value} value={s.value}>{`${s.label} (${s.count})`}</option>)}
                </Combo>
              </Field>
            )}
            {showAll && (
              <Field label="Role" count={roleList.length} htmlFor="invf-role">
                <Combo id="invf-role" title="The chosen department's seats — pick one to narrow the Employee list" value={filters.role} onChange={(e) => setF('role', e.target.value)}>
                  <option value="All">All roles</option>
                  {roleList.map((o) => <option key={o.value} value={o.value}>{`${o.label} (${o.count})`}</option>)}
                </Combo>
              </Field>
            )}
            <Field label="Recruiter name" count={recOpts.filter((o) => o.value !== NONE && o.count > 0).length} as="div">
              <MultiPick id="invf-recs" value={filters.recs} onChange={(v) => setOne('recs', v)} options={recOpts} allLabel="All recruiters" noun="recruiter" searchHint="Code or name — MED-3, Renuka…" />
              {filters.recs.length > 0 && (
                <span className="invf-note" title="How the money tiles count a recruiter's invoices">
                  {(data.rows || []).some((r) => r.candidates > 1)
                    ? 'Totals count the whole invoice when any of its candidates matches.'
                    : 'Each invoice bills one candidate, so a matching invoice counts in full.'}
                </span>
              )}
            </Field>
            {showAll && (
              <Field label="Employee name" count={empList.length} htmlFor="invf-emp">
                <Combo
                  id="invf-emp"
                  title={empInfo ? empInfo.text : 'The TL and recruiters of the chosen section — current and former'}
                  value={filters.rec}
                  onChange={(e) => setF('rec', e.target.value)}
                >
                  <option value="All">Everyone</option>
                  {empList.map((o) => <option key={o.value} value={o.value}>{`${o.label} (${o.count})`}</option>)}
                  {empList.length === 0 && <option value="__none" disabled>No employees found for these choices.</option>}
                </Combo>
                {empInfo && <span className="invf-note" title={empInfo.text}>{empInfo.text}</span>}
              </Field>
            )}
            {showAll && (
              <Field label="GST applicable" htmlFor="invf-gst">
                <Combo
                  id="invf-gst"
                  title="Yes / No read the invoice in front of you. Never, Always and Both ways read the client's whole history."
                  value={filters.gstin}
                  onChange={(e) => setOne('gstin', e.target.value || ALL)}
                >
                  {GST_OPTS.map((o) => <option key={o.value} value={o.value}>{o.value === ALL ? 'All' : `${o.label} (${fc.gstin.get(o.value) || 0})`}</option>)}
                  <optgroup label="By the client's whole history">
                    {GST_HISTORY.map((o) => <option key={o.value} value={o.value}>{`${o.label} · ${stanceCount(o.kind)} client(s)`}</option>)}
                  </optgroup>
                </Combo>
              </Field>
            )}
            {showAll && (
              <Field label="GST type" count={gstTypeList.length} htmlFor="invf-gsttype">
                <Combo id="invf-gsttype" value={filters.gstType} onChange={(e) => setOne('gstType', e.target.value || ALL)}>
                  <option value="All">All</option>
                  {gstTypeList.map((o) => <option key={o.value} value={o.value}>{`${o.label} (${o.count})`}</option>)}
                </Combo>
              </Field>
            )}
            {showAll && (
              <Field label="GST rate" count={gstRateList.length} htmlFor="invf-gstrate">
                <Combo id="invf-gstrate" value={filters.gstRate} onChange={(e) => setOne('gstRate', e.target.value || ALL)}>
                  <option value="All">All</option>
                  {gstRateList.map((o) => <option key={o.value} value={o.value}>{`${rateLabel(o.value, 'No GST')} (${o.count})`}</option>)}
                </Combo>
              </Field>
            )}
            {showAll && (
              <Field label="TDS applicable" htmlFor="invf-tds">
                <Combo id="invf-tds" value={filters.tds} onChange={(e) => setOne('tds', e.target.value || ALL)}>
                  <option value="All">All</option>
                  {['Yes', 'No'].filter((v) => keep(fc.tds.get(v) || 0, filters.tds === v)).map((v) => <option key={v} value={v}>{`${v === 'Yes' ? 'Yes — TDS cut' : 'No — no TDS'} (${fc.tds.get(v) || 0})`}</option>)}
                </Combo>
              </Field>
            )}
            {showAll && (
              <Field label="TDS rate" count={tdsRateList.length} htmlFor="invf-tdsrate">
                <Combo id="invf-tdsrate" value={filters.tdsRate} onChange={(e) => setOne('tdsRate', e.target.value || ALL)}>
                  <option value="All">All</option>
                  {tdsRateList.map((o) => <option key={o.value} value={o.value}>{`${rateLabel(o.value, 'No TDS')} (${o.count})`}</option>)}
                </Combo>
              </Field>
            )}
            {showAll && (
              <Field label="TDS status" count={tdsStatusList.length} htmlFor="invf-tdsst">
                <Combo id="invf-tdsst" value={filters.tdsStatus} onChange={(e) => setOne('tdsStatus', e.target.value || ALL)}>
                  <option value="All">All</option>
                  {tdsStatusList.map((o) => <option key={o.value} value={o.value}>{`${o.value} (${o.count})`}</option>)}
                </Combo>
              </Field>
            )}
            {showAll && (
              <Field label="Due date" count={dueList.length} htmlFor="invf-due">
                <Combo id="invf-due" value={filters.due} onChange={(e) => setOne('due', e.target.value || ALL)}>
                  <option value="All">All</option>
                  {dueList.map((o) => <option key={o.value} value={o.value}>{`${o.label} (${o.count})`}</option>)}
                </Combo>
              </Field>
            )}
            <Field label="Status" htmlFor="invf-status">
              <Combo id="invf-status" title="Settled = paid in full and the TDS certificate is in hand (or there is no TDS)" value={filters.status} onChange={(e) => setOne('status', e.target.value || ALL)}>
                {STATUS_OPTS.map((o) => <option key={o.value} value={o.value}>{o.value === ALL ? 'All' : `${o.label} (${fc.status.get(o.value) || 0})`}</option>)}
              </Combo>
            </Field>
            <Field label="Search anything" className="invf-search" htmlFor="invf-q">
              <input
                id="invf-q"
                type="search"
                className="invf-ctl"
                value={filters.q}
                placeholder="Candidate, client, phone, invoice no, position, recruiter code…"
                autoComplete="off"
                onChange={(e) => setOne('q', e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape' && filters.q) { e.preventDefault(); setOne('q', ''); } }}
              />
            </Field>
          </div>
          <div className="inv-fside">
            {/* P4 — the totals of the invoices shown, in the order an invoice
                adds up: Before GST → GST → After GST → TDS → Net → Received → Balance. */}
            <div className="inv-badges" aria-live="polite">
              {badge('before', 'Before GST', totals.before)}
              {badge('gst', 'GST charged', totals.gst)}
              {badge('after', 'After GST', totals.after)}
              {badge('receivable', 'Net receivable', totals.receivable)}
              {badge('received', 'Received', totals.received)}
              {badge('pending', 'Balance', totals.pending)}
              <div className="inv-badge inv-badge-wide" title={`TDS on the ${rows.length} invoice(s) the filters leave`}>
                <span>TDS deducted</span>
                <strong>{money2(totals.tds)}</strong>
                <em className="inv-tdssplit">
                  Pending {money2(totals.tdsPending)} · Deducted {money2(totals.tdsDeducted)} · Certificate in hand {money2(totals.tdsCertified)}
                </em>
              </div>
            </div>
          </div>
        </div>
        <FilterChips filters={chipList} onClearAll={activeBits.length ? resetAll : undefined} />
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
        <div className="card section invf-empty" role="status">
          <h3>No invoices match these filters</h3>
          <div className="qa-row" style={{ margin: '0 0 10px' }}>
            <button type="button" className="btn btn-gold" onClick={resetAll}>Clear all filters</button>
          </div>
          <div className="small-muted" style={{ marginBottom: 10 }}>
            {data.rows.length} invoice(s) are in the register — none of them get past these{filters.rec !== ALL ? ' (no invoice is attributed to this employee)' : ''}
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
        </div>
      )}

      <section className="inv-stats" aria-label="Headline figures">
        <div className="inv-stat" title="Each person counted once, however many invoices name them"><div className="inv-stat-l">Total candidates</div><div className="inv-stat-v">{st.candidates}</div><div className="small-muted">placed on {st.invoices} invoice{st.invoices === 1 ? '' : 's'}</div></div>
        <div className="inv-stat" title="Clients that have an invoice here (each client counted once, by its own id)"><div className="inv-stat-l">Total clients</div><div className="inv-stat-v">{st.clients}</div><div className="small-muted">{st.invoices} invoice{st.invoices === 1 ? '' : 's'}{ni.waiting ? ` · ${ni.waiting} not invoiced yet` : ''}</div></div>
        <div className="inv-stat"><div className="inv-stat-l">Total amount</div><div className="inv-stat-v">{money(st.total)}</div><div className="small-muted">after GST</div></div>
        <div className="inv-stat good"><div className="inv-stat-l">Amount received</div><div className="inv-stat-v">{money(st.received)}</div><div className="small-muted">{st.receivable ? Math.round((st.received / st.receivable) * 100) : 0}% of what&apos;s receivable</div></div>
        <div className="inv-stat" title="What is receivable (after TDS, credit notes and adjustments) minus what has been received"><div className="inv-stat-l">Pending amount</div><div className="inv-stat-v">{money(st.pending)}</div><div className="small-muted">{st.overpaidCount ? `after TDS · ${money(Math.abs(st.overpaid))} received in excess on ${st.overpaidCount} invoice${st.overpaidCount === 1 ? '' : 's'} is set off` : 'after TDS is withheld'}</div></div>
        <div className={`inv-stat${st.overdueCount ? ' bad' : ''}`} title="Invoices that still owe money and whose due date is before today"><div className="inv-stat-l">Overdue invoices</div><div className="inv-stat-v">{st.overdueCount}</div><div className="small-muted">{st.overdueCount ? `${money(st.overdueAmount)} past due` : 'nothing past due'}</div></div>
      </section>

      <section className="inv-panel" aria-label="Aging">
        <div className="inv-aging-head">
          <h3>Aging of what&apos;s still owed</h3>
          <p className={`inv-tdsline invf-tdspill${certDue.length ? ' due' : ''}`} title="Over the same invoices as the cards and the table">
            <span className="invf-tdspill-k">TDS to collect</span>
            <b className="inv-mono">{money(sumOf(certDue, (r) => r.tds))}</b>
            <span>{certDue.length ? `Form 16A not received on ${certDue.length} invoice${certDue.length === 1 ? '' : 's'}` : 'no Form 16A outstanding'}</span>
            <span aria-hidden="true">·</span>
            <span><b className="inv-mono">{money(openTds)}</b> more will be withheld on open invoices</span>
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
              <span className="c-a">{money(c.amt)}{c.note && <small className="c-note"> {c.note}</small>}</span>
              <span className="inv-chip-bar" aria-hidden="true"><i style={{ width: `${c.k === 'All' || c.k === 'Settled' ? 100 : Math.round((c.amt / maxAmt) * 100)}%` }} /></span>
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
          <h3>
            Invoices · {invGroups.length.toLocaleString('en-IN')}
            <span className="count">
              {invGroups.length !== allGroups.length ? `of ${allGroups.length} · ` : ''}
              {shownCands} candidate{shownCands === 1 ? '' : 's'} · {dropped ? `${dropped} dropped` : 'none dropped'}
            </span>
          </h3>
          <div className="inv-tbar-r">
            <label className="inv-inline">Sort
              <Combo value={sort} onChange={(e) => setSort(e.target.value)}>
                {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Combo>
            </label>
            <label className="inv-inline">Group by
              <Combo value={group} onChange={(e) => setGroup(e.target.value)}>
                {GROUP_BY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Combo>
            </label>
          </div>
        </div>
        {/* The shared ScrollSync box: synced top + bottom scrollbars, the
            header row kept under the app top bar and the TOTAL row above the
            bottom bar; Invoice No (+ Client on wide screens) pinned left,
            Actions pinned right (invoices/invTable.css). */}
        {payCampaign && <AppCampaignModal app="Accounts" audience="clients" ids={payCampaign.ids} onClose={() => setPayCampaign(null)} />}
        {waOn && <WaResume entityType="invoice" refreshKey={waTick} />}
        {waOn && waSel.size > 0 && (
          <div className="wa-banner" role="region" aria-label="Selected invoices">
            <b>{waSel.size} selected</b>
            <button type="button" className="btn btn-sm wa-go" onClick={() => setWaBulk({ ids: [...waSel] })}>🟢 Send WhatsApp</button>
            <button type="button" className="btn btn-sm" title="A payment follow-up campaign to the billing contacts of the clients behind these invoices" onClick={async () => { setPayErr(''); try { const r = await omniShared.post('/sources/invoice-clients', { invoiceIds: [...waSel] }); setPayCampaign({ ids: r.ids }); } catch (e) { setPayErr((e.response && e.response.data && e.response.data.error) || 'Could not prepare the list.'); } }}>Payment follow-up campaign</button>
            {payErr && <span className="small-muted" role="alert">{payErr}</span>}
            <button type="button" className="btn btn-sm" onClick={() => setWaSel(new Set())}>Cancel</button>
          </div>
        )}
        {group === 'client' ? (
          <div className="inv-tablebox" aria-label="Invoices by client">
            <ClientGroups
              groups={cpage.slice}
              allRows={rows}
              rowProps={{
                open: openInv, toggle: toggleInv, hot, handlers, shown: invGroups,
              }}
            />
          </div>
        ) : (
          <div ref={tableRef} className="inv-tablebox" aria-label="Invoice list — one row per client invoice">
            <ScrollSync fit className="inv-grid-wrap" deps={[invGroups.length, page.page, page.size, group, openInv.size]}>
              <table className="inv-grid ci-grid">
                <thead>
                  <tr className="inv-heads">
                    {CI_HEADS.map(([key, label]) => (
                      <th key={key} scope="col" className={ciHeadClass(key)}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {body}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={CI_HEADS.length} className="small-muted" style={{ textAlign: 'center', padding: 28 }}>
                        <div className="inv-grp-in" style={{ justifyContent: 'center' }}>
                          No invoices match these filters
                          {' '}<button type="button" className="link-btn" onClick={resetAll}>Clear all filters</button>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
                {rows.length > 0 && (
                  <tfoot>
                    <tr>
                      <td className="stk-l1"><span className="tf-k">TOTAL</span> <span className="tf-n">{invGroups.length} invoice{invGroups.length === 1 ? '' : 's'}</span></td>
                      {CI_HEADS.slice(1, -1).map(([key]) => {
                        const v = { before: totals.before, gst: totals.after - totals.before, after: totals.after, tds: totals.tds, receivable: totals.receivable, received: totals.received, pending: totals.pending }[key];
                        return v === undefined
                          ? <td key={key} className="tf-blank" aria-hidden="true" />
                          : <td key={key} className="num">{money2(v)}</td>;
                      })}
                      <td className="tf-blank stk-r" aria-hidden="true" />
                    </tr>
                  </tfoot>
                )}
              </table>
            </ScrollSync>
          </div>
        )}
        {group === 'client' && clientGroups.length > 10 && <Pager page={cpage} noun="clients" />}
        {group !== 'client' && !grouped && invGroups.length > 25 && <Pager page={page} noun="invoices" />}
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
      {waBulk && <WaBulkModal entityType="invoice" ids={waBulk.ids} onClose={() => { setWaBulk(null); setWaTick((n) => n + 1); }} onDone={() => { setWaSel(new Set()); setWaTick((n) => n + 1); }} />}
      {viewFor && <ClientInvoiceView g={viewFor} docHtml={invoiceDocumentHtml} onClose={() => setViewFor(null)} />}
      {payFor && (
        <PaymentModal
          rows={allGroups}
          initialId={payFor.id ? (leadOf.get(payFor.id) || payFor.id) : null}
          onClose={() => setPayFor(null)}
          onSaved={(id, msg) => { setPayFor(null); setFlash(msg); load(); focusRow(id); }}
        />
      )}
      {newInvoice && (
        <NewInvoiceModal
          onClose={() => setNewInvoice(false)}
          onSaved={(id, msg) => { setNewInvoice(false); setFlash(msg); load(); focusRow(id); }}
        />
      )}
      {addClient && (
        <AddClientModal
          onClose={() => setAddClient(false)}
          onSaved={(c, msg) => { setAddClient(false); setFlash(msg); }}
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
