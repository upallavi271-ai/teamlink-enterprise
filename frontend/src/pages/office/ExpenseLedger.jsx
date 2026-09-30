// EXPENSES & BILLS — the main table of the one-page Office & Accounts (v2 §3,
// with the v1 details: EXP-#### IDs, Paid / Pending / Reimbursed badges, the
// right-side details drawer, the filtered totals, the bill preview and the
// delete confirmation). Read from GET /office-expenses/ledger; the filters
// live in the page so the header's Excel button exports exactly them.
//
// INFINITE SCROLL (no Previous / Next): the same GET /ledger, 10 rows a
// request; the next page is asked for when the end of the table scrolls into
// view and appended. A new filter or sort starts again from page 1. The
// filtered totals are the API's, over the WHOLE filtered set — never a sum of
// the rows loaded so far.
import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import Combo from '../../components/Combo.jsx';
import FilterChips from '../../components/FilterChips.jsx';
import '../../components/ui/ui.css';
import ExpenseDrawer from './ExpenseDrawer.jsx';
import BillPreview from './BillPreview.jsx';
import AddVendorModal from './AddVendorModal.jsx';
import { ApprovalBadge, detailCache } from './approval.jsx';
import {
  money, money2, fmtD, saveBlob, isoOf, todayIso,
} from './officeUtil';

export const LEDGER_BLANK = {
  q: '', range: 'all', from: '', to: '', category: 'All', vendor: 'All', mode: 'All', status: 'All', gst: 'All', tds: 'All',
};
export const ledgerFiltersOn = (f) => !!f.q.trim() || f.range !== 'all' || f.category !== 'All' || f.vendor !== 'All'
  || f.mode !== 'All' || f.status !== 'All' || f.gst !== 'All' || f.tds !== 'All';

const RANGES = [['all', 'All dates'], ['today', 'Today'], ['week', 'This Week'], ['month', 'This Month'], ['custom', 'Custom Range']];
const PAGE_SIZE = 10;

// Today / This Week (Monday to Sunday) / This Month / a custom range, as dates.
export function rangeDates(f) {
  const now = new Date();
  if (f.range === 'today') { const t = todayIso(); return { from: t, to: t }; }
  if (f.range === 'week') {
    const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
    const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
    return { from: isoOf(mon), to: isoOf(sun) };
  }
  if (f.range === 'month') {
    return { from: isoOf(new Date(now.getFullYear(), now.getMonth(), 1)), to: isoOf(new Date(now.getFullYear(), now.getMonth() + 1, 0)) };
  }
  if (f.range === 'custom') return { from: f.from || undefined, to: f.to || undefined };
  return {};
}
export function ledgerParams(f) {
  const d = rangeDates(f);
  return {
    q: f.q.trim() || undefined,
    from: d.from,
    to: d.to,
    category: f.category !== 'All' ? f.category : undefined,
    vendor: f.vendor !== 'All' ? f.vendor : undefined,
    mode: f.mode !== 'All' ? f.mode : undefined,
    status: f.status !== 'All' ? f.status : undefined,
    gst: f.gst !== 'All' ? f.gst : undefined,
    tds: f.tds !== 'All' ? f.tds : undefined,
  };
}
// Excel (spec 18): the filtered expenses, the spec's columns.
export async function exportLedger(f) {
  const res = await api.get('/office-expenses/ledger/export.xlsx', { params: ledgerParams(f), responseType: 'blob' });
  saveBlob(res, 'expenses.xlsx');
}

// A column the table can be sorted by (click again to flip the order).
function Sortable({
  k, num, order, setOrder, title, children,
}) {
  const on = order.sort === k;
  return (
    <th className={`${num ? 'num ' : ''}oe-sortable`} title={title} aria-sort={on ? (order.dir === 'asc' ? 'ascending' : 'descending') : undefined}
      onClick={() => setOrder({ sort: k, dir: on && order.dir === 'desc' ? 'asc' : 'desc' })}>
      {children}{on && <span className="oe-arrow">{order.dir === 'asc' ? ' ▲' : ' ▼'}</span>}
    </th>
  );
}

export default function ExpenseLedger({
  f, setF, reloadKey, canManage, onNew, onImport, onEdit, onEditFull, onChanged, onError, onExportRegister, onOptions,
}) {
  const [data, setData] = useState(null); // the last response: totals, options, access, total
  const [rows, setRows] = useState([]); // every row loaded so far, in order
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false); // the next page is on its way
  const [moreErr, setMoreErr] = useState(false);
  const [addVendor, setAddVendor] = useState(false);
  const rowsRef = useRef([]);
  rowsRef.current = rows;
  const lastKey = useRef(null);
  const sentinel = useRef(null);
  const [qDeb, setQDeb] = useState(f.q);
  const [openId, setOpenId] = useState(null);
  const [bill, setBill] = useState(null);
  const [del, setDel] = useState(null);
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState('');
  const [exporting, setExporting] = useState(false);
  const [expMenu, setExpMenu] = useState(false);
  const reqId = useRef(0);
  const expRef = useRef(null);

  useEffect(() => { const t = setTimeout(() => setQDeb(f.q), 250); return () => clearTimeout(t); }, [f.q]);
  const [order, setOrder] = useState({ sort: 'date', dir: 'desc' });
  const key = JSON.stringify({ ...f, q: qDeb, ...order });

  // One request: page `page` of `size` rows. `append` adds them under the rows
  // already shown (skipping any already there); otherwise they replace them.
  const fetchRows = useCallback((page, size, append) => {
    const id = reqId.current + 1;
    reqId.current = id;
    if (append) { setMore(true); setMoreErr(false); } else setBusy(true);
    api.get('/office-expenses/ledger', { params: { ...ledgerParams({ ...f, q: qDeb }), ...order, page, pageSize: size } })
      .then((r) => {
        if (id !== reqId.current) return;
        setData(r.data);
        setRows((cur) => {
          if (!append) return r.data.rows;
          const seen = new Set(cur.map((x) => x.id));
          return [...cur, ...r.data.rows.filter((x) => !seen.has(x.id))];
        });
        setBusy(false); setMore(false);
      })
      .catch((e) => {
        if (id !== reqId.current) return;
        setBusy(false); setMore(false);
        if (append) setMoreErr(true);
        else onError(e.response?.data?.error || 'The expenses could not be loaded.');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // A new filter / sort starts again at the top. A reload after a save or a
  // delete (reloadKey) keeps as many rows as were showing, in one request.
  useEffect(() => {
    const fresh = lastKey.current !== key;
    lastKey.current = key;
    const pagesShown = fresh ? 1 : Math.max(1, Math.ceil(rowsRef.current.length / PAGE_SIZE));
    fetchRows(1, Math.min(100, pagesShown * PAGE_SIZE), false);
  }, [key, reloadKey, fetchRows]);

  const hasMore = !!data && rows.length < data.total;
  const loadMore = useCallback(() => {
    if (busy || more || moreErr || !hasMore) return;
    fetchRows(Math.floor(rowsRef.current.length / PAGE_SIZE) + 1, PAGE_SIZE, true);
  }, [busy, more, moreErr, hasMore, fetchRows]);

  // The sentinel under the table: when it scrolls into view (or is already in
  // view because the rows are few), the next page is asked for.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((en) => en.isIntersecting)) loadMore();
    }, { rootMargin: '0px 0px 240px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore, rows.length]);
  // The page's New Expense modal offers the same categories / vendors / modes.
  useEffect(() => { if (data?.options && onOptions) onOptions(data.options); }, [data, onOptions]);

  useEffect(() => {
    if (!expMenu) return undefined;
    const onDown = (e) => { if (expRef.current && !expRef.current.contains(e.target)) setExpMenu(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [expMenu]);

  const set = (patch) => setF({ ...f, ...patch });
  const on = ledgerFiltersOn(f);
  const o = data?.options;
  const acc = data?.access || {};

  // THE LIST FILTER STANDARD (user notes #1 / #11): Search, Date range,
  // Category, Vendor and Status always on screen; Payment mode, GST and TDS
  // under "More Filters ▾"; every active filter as a removable chip.
  const [moreOpen, setMoreOpen] = useState(() => {
    try { return window.localStorage.getItem('tl.morefilters.office-ledger') === '1'; } catch { return false; }
  });
  const toggleMore = () => {
    const next = !moreOpen;
    setMoreOpen(next);
    try { window.localStorage.setItem('tl.morefilters.office-ledger', next ? '1' : '0'); } catch { /* private window */ }
  };
  const moreActive = [f.mode !== 'All', f.gst !== 'All', f.tds !== 'All'].filter(Boolean).length;
  const rangeText = f.range === 'custom'
    ? (f.from && f.to ? `${fmtD(f.from)} → ${fmtD(f.to)}` : f.from ? `from ${fmtD(f.from)}` : f.to ? `to ${fmtD(f.to)}` : 'Custom range')
    : (RANGES.find(([k]) => k === f.range) || [])[1];
  const chips = [
    f.q.trim() && { key: 'q', label: 'Search', value: f.q.trim(), onRemove: () => set({ q: '' }) },
    f.range !== 'all' && { key: 'range', label: 'Date range', value: rangeText, onRemove: () => set({ range: 'all', from: '', to: '' }) },
    f.category !== 'All' && { key: 'category', label: 'Category', value: f.category, onRemove: () => set({ category: 'All' }) },
    f.vendor !== 'All' && { key: 'vendor', label: 'Vendor', value: f.vendor, onRemove: () => set({ vendor: 'All' }) },
    f.status !== 'All' && { key: 'status', label: 'Status', value: ((o?.statuses || []).find((s) => s.value === f.status) || {}).label || f.status, onRemove: () => set({ status: 'All' }) },
    f.mode !== 'All' && { key: 'mode', label: 'Payment mode', value: f.mode, onRemove: () => set({ mode: 'All' }) },
    f.gst !== 'All' && { key: 'gst', label: 'GST applicable', value: f.gst, onRemove: () => set({ gst: 'All' }) },
    f.tds !== 'All' && { key: 'tds', label: 'TDS applicable', value: f.tds, onRemove: () => set({ tds: 'All' }) },
  ].filter(Boolean);

  const doExport = async () => {
    setExpMenu(false);
    setExporting(true);
    try { await exportLedger(f); } catch { onError('The Excel file could not be made.'); }
    setExporting(false);
  };
  // The page bumps reloadKey, which reloads this table (and every section).
  const changed = () => { detailCache.clear(); onChanged(); };

  const askDelete = (row) => { setDelErr(''); setDel(row); };
  const doDelete = async () => {
    setDelBusy(true); setDelErr('');
    try {
      await api.delete(`/office-expenses/${del.id}`);
      if (openId === del.id) setOpenId(null);
      setDel(null);
      changed();
    } catch (e) {
      setDelErr(e.response?.data?.error || 'The expense could not be deleted.');
    }
    setDelBusy(false);
  };
  // Row buttons open the edit forms with the full record (GET /:id).
  const withDetail = async (id, fn) => {
    try {
      const hit = detailCache.get(id);
      const d = hit || (await api.get(`/office-expenses/${id}`)).data;
      detailCache.set(id, d);
      fn(d);
    } catch (e) { onError(e.response?.data?.error || 'That expense could not be opened.'); }
  };
  const canEditRow = (r) => canManage && (r.status === 'PENDING' || acc.override);
  const canDeleteRow = (r) => canManage && (['PENDING', 'REJECTED'].includes(r.status) || acc.approver);

  const rowClick = (e, r) => {
    if (e.target.closest('button, a, input, select, label')) return;
    setOpenId(r.id);
  };
  const cols = 14;
  const summary = rows.find((r) => r.id === openId);

  return (
    <div className="oe-lg">
      <div className="oe-lg-bar">
        <label className="oe-f oe-lg-q"><span>Search</span>
          <input type="search" value={f.q} placeholder="Expense ID, description, vendor, category" onChange={(e) => set({ q: e.target.value })} />
        </label>
        <label className="oe-f"><span>Date range</span>
          <select className={`oe-sel${f.range !== 'all' ? ' set' : ''}`} value={f.range} onChange={(e) => set({ range: e.target.value })}>
            {RANGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        {f.range === 'custom' && (
          <>
            <label className="oe-f"><span>From</span><input type="date" value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.target.value })} /></label>
            <label className="oe-f"><span>To</span><input type="date" value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.target.value })} /></label>
          </>
        )}
        <div className="oe-f oe-lg-combo"><span>Category</span>
          <Combo value={f.category} onChange={(e) => set({ category: e.target.value || 'All' })} aria-label="Category">
            <option value="All">All categories</option>
            {(o?.categories || []).map((c) => <option key={c} value={c}>{c}</option>)}
          </Combo>
        </div>
        <div className="oe-f oe-lg-combo"><span>Vendor / Paid to</span>
          <Combo value={f.vendor} onChange={(e) => set({ vendor: e.target.value || 'All' })} aria-label="Vendor / Paid to">
            <option value="All">All vendors</option>
            {(o?.vendors || []).map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
          </Combo>
        </div>
        <label className="oe-f"><span>Status</span>
          <select className={`oe-sel${f.status !== 'All' ? ' set' : ''}`} value={f.status} onChange={(e) => set({ status: e.target.value })} title="Payment status">
            <option value="All">All statuses</option>
            {(o?.statuses || []).map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
        <button type="button" className={`mf-toggle${moreOpen ? ' on' : ''}`} onClick={toggleMore} aria-expanded={moreOpen}>
          More Filters{moreActive ? ` (${moreActive})` : ''} {moreOpen ? '▴' : '▾'}
        </button>
        {moreOpen && (
          <>
            <label className="oe-f"><span>Payment mode</span>
              <select className={`oe-sel${f.mode !== 'All' ? ' set' : ''}`} value={f.mode} onChange={(e) => set({ mode: e.target.value })}>
                <option value="All">All payment modes</option>
                {(o?.modes || []).map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label className="oe-f"><span>GST applicable</span>
              <select className={`oe-sel oe-sel-sm${f.gst !== 'All' ? ' set' : ''}`} value={f.gst} onChange={(e) => set({ gst: e.target.value })}>
                <option value="All">All</option><option value="Yes">Yes</option><option value="No">No</option>
              </select>
            </label>
            <label className="oe-f"><span>TDS applicable</span>
              <select className={`oe-sel oe-sel-sm${f.tds !== 'All' ? ' set' : ''}`} value={f.tds} onChange={(e) => set({ tds: e.target.value })}>
                <option value="All">All</option><option value="Yes">Yes</option><option value="No">No</option>
              </select>
            </label>
          </>
        )}
        {on && <button type="button" className="mf-clear oe-lg-clear" onClick={() => setF(LEDGER_BLANK)}>Clear All</button>}
        <div className="oe-lg-acts">
          {canManage && onImport && <button type="button" className="btn btn-sm" onClick={onImport}>⬆ Import</button>}
          <span className="oe-lg-exp" ref={expRef}>
            <button type="button" className="btn btn-sm" disabled={exporting || acc.export === false} onClick={() => setExpMenu(!expMenu)} aria-haspopup="menu" aria-expanded={expMenu}>
              {exporting ? 'Preparing…' : '⬇ Export'}
            </button>
            {expMenu && (
              <div className="oe-lg-menu" role="menu">
                <button type="button" role="menuitem" onClick={doExport}>Excel — the filtered expenses</button>
                {onExportRegister && (
                  <button type="button" role="menuitem" onClick={() => { setExpMenu(false); onExportRegister(); }}>
                    Excel — grouped register (period, subtotals, TDS)
                  </button>
                )}
              </div>
            )}
          </span>
          {canManage && <button type="button" className="btn btn-sm" onClick={() => setAddVendor(true)}>+ Add Vendor</button>}
          {canManage && <button type="button" className="btn btn-sm btn-primary" onClick={onNew}>+ Add Expense</button>}
        </div>
      </div>
      <FilterChips filters={chips} onClearAll={on ? () => setF(LEDGER_BLANK) : undefined} />

      <div className={`tbl-wrap oe-lg-tbl${busy ? ' busy' : ''}`}>
        <table>
          <thead>
            <tr>
              <Sortable k="date" order={order} setOrder={setOrder}>Date</Sortable>
              <Sortable k="code" order={order} setOrder={setOrder}>Bill / Expense No.</Sortable>
              <th>Vendor</th>
              <th>Category</th>
              <th>Description</th>
              <Sortable k="amount" num order={order} setOrder={setOrder}>Taxable Amount</Sortable>
              <th className="num">GST %</th>
              <th className="num">GST Amount</th>
              <th className="num">TDS</th>
              <Sortable k="total" num order={order} setOrder={setOrder} title="Total = Taxable Amount + GST. TDS, where there is any, is held back from what is paid to the vendor.">Total Amount</Sortable>
              <th>Payment Status</th>
              <th>Payment Date</th>
              <th>Bill / Proof</th>
              <th className="oe-lg-actions-h">Actions</th>
            </tr>
          </thead>
          <tbody>
            {!data && <tr><td colSpan={cols} className="oe-empty"><span className="oe-spin oe-spin-sm" aria-hidden="true" /> Loading…</td></tr>}
            {data && rows.length === 0 && (
              <tr>
                <td colSpan={cols} className="oe-empty">
                  {data.filtered ? 'No expenses match these filters.' : 'No expenses recorded yet.'}
                  {data.filtered && <div><button type="button" className="btn btn-sm" onClick={() => setF(LEDGER_BLANK)}>Clear filters</button></div>}
                </td>
              </tr>
            )}
            {data && rows.map((r) => (
              <tr key={r.id} className={`oe-row-click${openId === r.id ? ' oe-row-open' : ''}`} onClick={(e) => rowClick(e, r)}>
                <td className="oe-nowrap">{fmtD(r.expenseDate)}</td>
                <td className="oe-nowrap">
                  <b className="oe-lg-code">{r.expenseCode || '—'}</b>
                  {r.atRisk && <span className="status priority-high oe-miss" title="GST on this bill, and no valid vendor GSTIN — the credit cannot be claimed yet">GSTIN</span>}
                  {r.billNumber && <div className="oe-lg-sub" title="Bill / invoice number">{r.billNumber}</div>}
                </td>
                <td className="oe-lg-vendor" title={r.vendor || ''}>{r.vendor || '—'}</td>
                <td className="oe-lg-cat">{r.category || '—'}</td>
                <td className="oe-lg-desc" title={r.description || ''}>{r.description || <span className="cell-muted">—</span>}</td>
                <td className="num" title={money2(r.amount)}>{money(r.amount)}</td>
                <td className="num">{r.gstRate ? `${r.gstRate}%` : '0%'}</td>
                <td className="num" title={money2(r.gst)}>{money(r.gst)}</td>
                <td className="num">{r.tds > 0 ? <span title={money2(r.tds)}>{money(r.tds)}</span> : <span className="cell-muted">—</span>}</td>
                <td className="num" title={money2(r.total)}><b>{money(r.total)}</b></td>
                <td className="oe-nowrap"><ApprovalBadge s={r.status} title={r.statusText} /></td>
                <td className="oe-nowrap">
                  {r.paymentDate ? fmtD(r.paymentDate)
                    : <span className="cell-muted" title={['PAID', 'REIMBURSED'].includes(r.status) ? 'Paid before payment dates were recorded' : 'Not paid yet'}>—</span>}
                </td>
                <td className="oe-nowrap">
                  {r.bill && r.bill.onServer && <button type="button" className="link-btn" onClick={() => setBill(r)}>View</button>}
                  {r.bill && !r.bill.onServer && <span className="cell-muted" title={`Only the file name is on record: ${r.bill.name}`}>name only</span>}
                  {!r.bill && r.bankLine && <span className="cell-muted" title="Paid off an imported bank statement line">bank line</span>}
                  {!r.bill && !r.bankLine && <span className="cell-muted">—</span>}
                </td>
                <td className="oe-lg-actions">
                  <button type="button" className="link-btn" onClick={() => setOpenId(r.id)}>View</button>
                  {canManage && (
                    <button type="button" className="link-btn" disabled={!canEditRow(r)}
                      title={canEditRow(r) ? (r.status === 'PENDING' ? 'Edit' : 'Admin correction — a reason is asked for') : 'Only a Pending expense can be edited'}
                      onClick={() => withDetail(r.id, onEdit)}>Edit</button>
                  )}
                  {canManage && (
                    <button type="button" className="link-btn oe-lg-del" disabled={!canDeleteRow(r)}
                      title={canDeleteRow(r) ? 'Delete' : 'Only the Accounts Admin / Approver can delete an approved or paid expense'}
                      onClick={() => askDelete(r)}>Delete</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data && data.total > 0 && (
        <div className="oe-lg-more" ref={sentinel} aria-live="polite">
          <span className="small-muted">Showing {rows.length} of {data.total} expense{data.total === 1 ? '' : 's'}</span>
          {more && <span className="oe-lg-more-s"><span className="oe-spin oe-spin-sm" aria-hidden="true" /> Loading more…</span>}
          {moreErr && (
            <span className="oe-lg-more-s oe-bad">
              The next expenses could not be loaded.
              {' '}<button type="button" className="btn btn-sm" onClick={() => { setMoreErr(false); fetchRows(Math.floor(rows.length / PAGE_SIZE) + 1, PAGE_SIZE, true); }}>Retry</button>
            </span>
          )}
          {!hasMore && !busy && <span className="oe-lg-end">End of list · all {data.total} shown</span>}
        </div>
      )}

      {/* v2 §3: the filtered totals — only while a filter is on, so they never
          repeat the Financial Overview. */}
      {data && data.filtered && (
        <div className="oe-lg-totals" aria-live="polite">
          <span className="oe-lg-totals-l">Filtered totals · {data.totals.count} of {data.all.count} expense{data.all.count === 1 ? '' : 's'}</span>
          <span><em>Total Expenses</em><b>{money2(data.totals.total)}</b></span>
          <span><em>Total GST</em><b>{money2(data.totals.gst)}</b></span>
          <span><em>Total Paid</em><b>{money2(data.totals.paid)}</b></span>
          <span><em>Total Pending</em><b>{money2(data.totals.pending)}</b></span>
          <span className="oe-lg-totals-n">Total = Taxable + GST · Paid = Paid + Reimbursed · Pending = Pending + Approved</span>
        </div>
      )}
      {data && !data.filtered && (
        <div className="small-muted oe-lg-note">
          Every expense, newest first. Rejected expenses are out of the books — pick Payment status: Rejected to list them. Totals appear here when a filter is on.
        </div>
      )}

      {openId && (
        <ExpenseDrawer
          id={openId}
          summary={summary}
          canManage={canManage}
          onClose={() => setOpenId(null)}
          onChanged={changed}
          onEdit={(d) => onEdit(d)}
          onEditFull={(d) => onEditFull(d)}
          onDelete={(d) => askDelete({ id: d.id, expenseCode: d.expenseCode, status: d.approvalStatus })}
          onViewBill={(r) => setBill(r)}
        />
      )}
      {bill && <BillPreview expense={bill} onClose={() => setBill(null)} />}
      {addVendor && (
        <AddVendorModal
          existingNames={(o?.vendors || []).map((v) => v.name)}
          onClose={() => setAddVendor(false)}
          onSaved={() => setAddVendor(false)}
        />
      )}
      {del && (
        <Modal
          title="Delete this expense?"
          note={del.expenseCode || null}
          onClose={() => !delBusy && setDel(null)}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setDel(null)} disabled={delBusy} autoFocus>Cancel</button>
              <button type="button" className="btn oe-del" onClick={doDelete} disabled={delBusy}>{delBusy ? 'Deleting…' : 'Delete'}</button>
            </>
          )}
        >
          <p className="oe-lg-delp">Delete this expense? This action will remove the expense record.</p>
          {delErr && <div className="notice red" role="alert"><span>{delErr}</span></div>}
        </Modal>
      )}
    </div>
  );
}
