import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { can, isHR as hasHrmsAdmin } from '../../permissions';
import Combo from '../../components/Combo.jsx';
import ExportMenu from '../../components/ExportMenu.jsx';
import MoreFilters from '../../components/ui/MoreFilters.jsx';
import FilterChips from '../../components/FilterChips.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import { ListEmpty } from '../../components/ui/ListFilters.jsx';
import '../../components/ui/ListFilters.css';
import './AssetReport.css';

// ---------------------------------------------------------------------------
// ASSET REPORT FILTERS (hrms-24 §6).
//
// Every filter is sent to GET /api/asset-inventory and applied ON THE SERVER,
// over the register this login may see (routes/assetInventory.js assetWhere —
// the same scope as the rest of the Assets screens). They combine: Department
// = R&D + Asset Status = Assigned + a date range is one query. Export sends the
// same filters to /asset-inventory/export.xlsx|csv, so the file is exactly the
// rows on screen, and the export permission is checked there too.
//
// THE FILTER STANDARD (user notes #1 / #11): Search · Department · Category ·
// Asset status · Date range stay on screen; the rest sit under "More Filters
// ▾"; every active filter is a removable chip; the list applies as you type
// (debounced), is sortable and paged 25 / 50 / 100. The employee filters are
// only offered to a login that sees other people's assets.
// ---------------------------------------------------------------------------
export const EMPTY_ASSET_REPORT = {
  q: '', employeeCode: '', employeeName: '', department: '', category: '', assetType: '',
  assetCode: '', assetName: '', allocation: '', status: '', assignedDate: '', returnDate: '',
  from: '', to: '', dateField: 'assigned', location: '', assignedBy: '',
};

const LABELS = {
  q: 'Search', employeeCode: 'Employee ID', employeeName: 'Employee', department: 'Department',
  category: 'Category', assetType: 'Asset type', assetCode: 'Asset ID', assetName: 'Asset name',
  allocation: 'Allocation', status: 'Status', assignedDate: 'Assigned on', returnDate: 'Returned on',
  location: 'Location', assignedBy: 'Assigned by',
};
const MORE_KEYS = ['employeeCode', 'employeeName', 'assetType', 'assetCode', 'assetName', 'allocation', 'assignedDate', 'returnDate', 'location', 'assignedBy'];
const DATE_FIELDS = { assigned: 'Assigned', returned: 'Returned', any: 'Assigned or returned', purchased: 'Purchased' };

const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const dmy = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '');

const SORTS = [
  ['new', 'Newest first', null],
  ['code', 'Asset ID', (a, b) => String(a.assetCode || '').localeCompare(String(b.assetCode || ''), undefined, { numeric: true })],
  ['name', 'Asset name A–Z', (a, b) => String(a.name || '').localeCompare(String(b.name || ''))],
  ['assigned', 'Recently assigned', (a, b) => String(b.assignedAt || '').localeCompare(String(a.assignedAt || ''))],
];

function paramsOf(f) {
  const p = {};
  Object.entries(f).forEach(([k, v]) => { if (v && String(v).trim()) p[k] = String(v).trim(); });
  // A date field on its own means nothing without a range.
  if (!p.from && !p.to) delete p.dateField;
  return p;
}

export default function AssetReport() {
  const { user } = useAuth();
  const mayExport = can(user, 'hrms', 'hrms', 'Employee Services', 'export');
  // Employee ID / name / department / assigned-by are for a login that sees
  // other people's assets; an employee's register is their own + company stock.
  const seesOthers = hasHrmsAdmin(user);
  const [f, setF] = useState(EMPTY_ASSET_REPORT);
  const [applied, setApplied] = useState(EMPTY_ASSET_REPORT);
  const [rows, setRows] = useState([]);
  const [opts, setOpts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sort, setSort] = useState('new');

  // The choices, re-read when the applied filters change so the Department
  // counts follow every OTHER filter (cascade). Every active department is
  // listed, a 0 included (user, 2026-10-05).
  const optsKey = JSON.stringify({ ...paramsOf(applied), department: '' });
  useEffect(() => {
    api.get('/asset-inventory/options', { params: { ...paramsOf(applied), department: undefined } })
      .then((r) => setOpts(r.data)).catch(() => setOpts(null));
  }, [optsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Typing must not fire a request per keystroke: apply 300 ms after the last change.
  useEffect(() => {
    const t = setTimeout(() => setApplied(f), 300);
    return () => clearTimeout(t);
  }, [f]);

  const appliedKey = JSON.stringify(paramsOf(applied));
  useEffect(() => {
    setLoading(true); setError('');
    api.get('/asset-inventory', { params: paramsOf(applied) })
      .then((r) => setRows(r.data))
      .catch((e) => { setRows([]); setError(e.response?.data?.error || 'Could not load the asset report.'); })
      .finally(() => setLoading(false));
  }, [appliedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const clear = () => { setF(EMPTY_ASSET_REPORT); setApplied(EMPTY_ASSET_REPORT); };
  const submit = (e) => { e.preventDefault(); setApplied({ ...f }); };

  const list = (xs) => (xs || []).map((x) => <option key={x} value={x}>{x}</option>);
  const params = paramsOf(f);
  const activeCount = Object.keys(params).filter((k) => !['dateField', 'from', 'to'].includes(k)).length + (params.from || params.to ? 1 : 0);
  const moreActive = MORE_KEYS.filter((k) => params[k]).length;

  const chips = Object.entries(params)
    .filter(([k]) => !['from', 'to', 'dateField'].includes(k))
    .map(([k, v]) => ({ key: k, label: LABELS[k] || k, value: /Date$/.test(k) ? dmy(v) : v, onRemove: () => setF((x) => ({ ...x, [k]: '' })) }));
  if (params.from || params.to) {
    chips.push({
      key: 'range',
      label: `${DATE_FIELDS[f.dateField] || 'Assigned'} date`,
      value: params.from && params.to ? `${dmy(params.from)} → ${dmy(params.to)}` : params.from ? `from ${dmy(params.from)}` : `to ${dmy(params.to)}`,
      onRemove: () => setF((x) => ({ ...x, from: '', to: '' })),
    });
  }

  const sorted = useMemo(() => {
    const s = SORTS.find(([k]) => k === sort);
    return s && s[2] ? [...rows].sort(s[2]) : rows;
  }, [rows, sort]);
  // The whole register on one page (250 a page; 124 assets today).
  const page = usePaged(sorted, 250);
  const lfLike = { activeCount, clear };

  return (
    <div className="asr">
      <form className="asr-panel lf" onSubmit={submit}>
        <MoreFilters
          storageKey="asset-report"
          activeMore={moreActive}
          onClearAll={activeCount ? clear : undefined}
          primary={(
            <>
              <input type="search" value={f.q} onChange={set('q')} placeholder={seesOthers ? 'Search asset ID, name, type, location or employee…' : 'Search asset ID, name, type or location…'} aria-label="Search" style={{ minWidth: 240 }} />
              {seesOthers && (
                <Combo value={f.department} title="Department" onChange={set('department')}>
                  <option value="">All departments</option>
                  {opts?.departmentCounts
                    ? opts.departmentCounts.map((d) => <option key={d.name} value={d.name}>{`${d.name} (${d.count})`}</option>)
                    : list(opts?.departments)}
                </Combo>
              )}
              <Combo value={f.category} title="Category" onChange={set('category')}><option value="">All categories</option>{list(opts?.categories)}</Combo>
              <Combo value={f.status} title="Status" onChange={set('status')}><option value="">All statuses</option>{list(opts?.statuses || ['Available', 'Assigned', 'In Repair', 'Retired'])}</Combo>
              <span className="lf-dates" title="Date range">
                <select value={f.dateField} onChange={set('dateField')} aria-label="Date range applies to" title="Date range applies to">
                  {Object.entries(DATE_FIELDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
                <input type="date" value={f.from} max={f.to || undefined} onChange={set('from')} aria-label="From" />
                <span aria-hidden="true">→</span>
                <input type="date" value={f.to} min={f.from || undefined} onChange={set('to')} aria-label="To" />
              </span>
            </>
          )}
          extra={(
            <>
              <label className="lf-sort">
                Sort
                <select value={sort} onChange={(e) => setSort(e.target.value)}>
                  {SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </label>
              {/* hrms-24 §3 — the shared Export menu; the same scoped, filtered
                  server export as before, now also as PDF. */}
              {mayExport && (
                <ExportMenu
                  url={(x) => `/asset-inventory/export.${x}`}
                  params={paramsOf(applied)}
                  disabled={loading}
                  align="left"
                  note="Exactly the assets as filtered"
                />
              )}
              <span className="small-muted lf-count">
                {loading ? 'Loading…' : `${rows.length} asset(s)${opts ? ` of ${opts.total} in your scope` : ''}`}
              </span>
            </>
          )}
        >
          {seesOthers && <input value={f.employeeCode} onChange={set('employeeCode')} placeholder="Employee ID" aria-label="Employee ID" />}
          {seesOthers && <input value={f.employeeName} onChange={set('employeeName')} placeholder="Employee name" aria-label="Employee name" />}
          <Combo creatable value={f.assetType} title="Asset type" onChange={set('assetType')}><option value="">All asset types</option>{list(opts?.assetTypes)}</Combo>
          <input value={f.assetCode} onChange={set('assetCode')} placeholder="Asset ID (AST-0001)" aria-label="Asset ID" />
          <input value={f.assetName} onChange={set('assetName')} placeholder="Asset name" aria-label="Asset name" />
          <Combo value={f.allocation} title="Allocation" onChange={set('allocation')}><option value="">All allocations</option>{list(opts?.allocations || ['Allocated', 'Unallocated'])}</Combo>
          <label className="lf-sort">Assigned on<input type="date" value={f.assignedDate} onChange={set('assignedDate')} aria-label="Assigned on" /></label>
          <label className="lf-sort">Returned on<input type="date" value={f.returnDate} onChange={set('returnDate')} aria-label="Returned on" /></label>
          <Combo creatable value={f.location} title="Location" onChange={set('location')}><option value="">All locations</option>{list(opts?.locations)}</Combo>
          {seesOthers && (
            <Combo creatable value={f.assignedBy} title="Assigned by" onChange={set('assignedBy')}><option value="">Assigned by anyone</option>{list(opts?.assignedBy)}</Combo>
          )}
        </MoreFilters>
        <FilterChips filters={chips} onClearAll={activeCount ? clear : undefined} />
      </form>

      {error && <div className="error-text" style={{ margin: '8px 0' }}>{error}</div>}

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Asset ID</th><th>Asset</th><th>Category / Type</th><th>Status</th><th>Allocation</th>
                <th>Employee</th><th>Department</th><th>Location</th><th>Assigned</th><th>Assigned By</th><th>Returned</th>
              </tr>
            </thead>
            <tbody>
              {page.slice.map((a) => (
                <tr key={a.id}>
                  <td><b>{a.assetCode}</b></td>
                  <td>{a.name}</td>
                  <td className="cell-muted">{a.category || '—'}{a.assetType ? ` · ${a.assetType}` : ''}</td>
                  <td><span className={`status ${a.status === 'Available' ? 'active' : a.status === 'Retired' ? 'rejected' : 'pending'}`}>{a.status}</span></td>
                  <td className="cell-muted">{a.allocation}</td>
                  <td>{a.assignedTo ? <>{a.assignedTo.name}<div className="small-muted">{a.assignedTo.employeeCode}</div></> : <span className="cell-muted">—</span>}</td>
                  <td className="cell-muted">{a.department || '—'}</td>
                  <td className="cell-muted">{a.location || '—'}</td>
                  <td className="cell-muted">{fmt(a.assignedAt)}</td>
                  <td className="cell-muted">{a.assignedByName || '—'}</td>
                  <td className="cell-muted">{fmt(a.returnedAt)}</td>
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan="11" className="small-muted" style={{ padding: 16 }}>
                  {loading ? 'Loading…' : <ListEmpty lf={lfLike} noun="assets" title="No assets on file." />}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {rows.length > 0 && <Pager page={page} noun="assets" />}
    </div>
  );
}
