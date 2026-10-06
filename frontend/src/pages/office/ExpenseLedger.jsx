// EXPENSES & BILLS — the main table of the one-page Office & Accounts, with
// the EXP-#### IDs, the right-side details drawer, the bill preview and the
// delete confirmation. Read from GET /office-expenses/ledger.
//
// The filters are the PAGE's (OfficeFilters.jsx — period, search, category,
// vendor, GST on the bill, status, payment mode); `params` is what they send.
//
// Accounts spec S1 (2026-10-05):
//   * columns Before GST · GST % · GST amount · After GST · TDS · Total ·
//     Paid · Pending (Total = after GST − TDS; Paid + Pending = Total);
//   * a TOTAL row (tfoot) over the WHOLE filtered set — the API's totals, the
//     same sums as the KPI chips, never a sum of the rows loaded so far;
//   * synced top + bottom scrollbars, the navy header and the TOTAL row kept
//     on screen (components/accounts/ScrollSync.jsx);
//   * status: Paid / Pending; an old Approved / Rejected / Reimbursed row shows
//     as "Other (old status)".
//
// INFINITE SCROLL (no Previous / Next): 10 rows a request; the next page is
// asked for when the end of the table scrolls into view and appended. A new
// filter or sort starts again from page 1.
import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import ScrollSync from '../../components/accounts/ScrollSync.jsx';
import '../../components/ui/ui.css';
import ExpenseDrawer from './ExpenseDrawer.jsx';
import BillPreview from './BillPreview.jsx';
import AddVendorModal from './AddVendorModal.jsx';
import { ApprovalBadge, detailCache } from './approval.jsx';
import { money, money2, fmtD, saveBlob } from './officeUtil';
import './officefilters.css';

const PAGE_SIZE = 10;

// Excel: the filtered expenses with every money column and a TOTAL row.
export async function exportLedger(params) {
  const res = await api.get('/office-expenses/ledger/export.xlsx', { params, responseType: 'blob' });
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
const Money = ({ v, cls = '' }) => (
  <td className={`num${cls ? ` ${cls}` : ''}`} title={money2(v)}>{v > 0.004 ? money(v) : <span className="cell-muted">₹0</span>}</td>
);

export default function ExpenseLedger({
  params, reloadKey, canManage, onImport, onEdit, onEditFull, onChanged, onError, onExportRegister, onOptions, onClear,
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
  const [openId, setOpenId] = useState(null);
  const [bill, setBill] = useState(null);
  const [del, setDel] = useState(null);
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState('');
  const [exporting, setExporting] = useState('');
  const reqId = useRef(0);

  // Search is typed: wait a moment before asking.
  const [qDeb, setQDeb] = useState(params.q);
  useEffect(() => { const t = setTimeout(() => setQDeb(params.q), 250); return () => clearTimeout(t); }, [params.q]);
  const [order, setOrder] = useState({ sort: 'date', dir: 'desc' });
  const sent = { ...params, q: qDeb };
  const key = JSON.stringify({ ...sent, ...order });

  // One request: page `page` of `size` rows. `append` adds them under the rows
  // already shown (skipping any already there); otherwise they replace them.
  const fetchRows = useCallback((page, size, append) => {
    const id = reqId.current + 1;
    reqId.current = id;
    if (append) { setMore(true); setMoreErr(false); } else setBusy(true);
    api.get('/office-expenses/ledger', { params: { ...JSON.parse(key), page, pageSize: size } })
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
  // The page's filters and its New Expense modal read the options.
  useEffect(() => { if (data?.options && onOptions) onOptions(data.options); }, [data, onOptions]);

  const o = data?.options;
  const acc = data?.access || {};
  const t = data?.totals;

  const doExport = async (which) => {
    setExporting(which);
    try {
      if (which === 'xlsx') await exportLedger(sent);
      else await onExportRegister();
    } catch { onError('The Excel file could not be made.'); }
    setExporting('');
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
  const cols = 17;
  const summary = rows.find((r) => r.id === openId);

  return (
    <div className="oe-lg">
      <div className="oe-lg-bar oe-lg-bar2">
        <span className="small-muted oe-lg-count">
          {data ? `${data.total} expense${data.total === 1 ? '' : 's'}${data.filtered ? ` match the filters (of ${data.all.count})` : ''}` : 'Loading…'}
        </span>
        <div className="oe-lg-acts">
          {canManage && onImport && <button type="button" className="btn btn-sm" onClick={onImport}>⬆ Import</button>}
          <button type="button" className="btn btn-sm" disabled={!!exporting || acc.export === false} onClick={() => doExport('xlsx')} title="The expenses these filters show, with every money column and the TOTAL row">
            {exporting === 'xlsx' ? 'Preparing…' : '⬇ Excel'}
          </button>
          {onExportRegister && (
            <button type="button" className="btn btn-sm" disabled={!!exporting || acc.export === false} onClick={() => doExport('register')} title="Month by month, with subtotals, for the period">
              {exporting === 'register' ? 'Preparing…' : '⬇ Month register'}
            </button>
          )}
          {canManage && <button type="button" className="btn btn-sm" onClick={() => setAddVendor(true)}>+ Add Vendor</button>}
        </div>
      </div>

      <ScrollSync className={`tbl-wrap oe-lg-tbl oe-lg2${busy ? ' busy' : ''}`} deps={[rows.length, !!data]}>
        <table>
          <thead>
            <tr>
              <Sortable k="date" order={order} setOrder={setOrder}>Date</Sortable>
              <Sortable k="code" order={order} setOrder={setOrder}>Bill / Expense No.</Sortable>
              <th>Vendor</th>
              <th>Category</th>
              <th>Description</th>
              <Sortable k="amount" num order={order} setOrder={setOrder}>Before GST</Sortable>
              <th className="num">GST %</th>
              <Sortable k="gst" num order={order} setOrder={setOrder}>GST amount</Sortable>
              <Sortable k="after" num order={order} setOrder={setOrder} title="After GST = Before GST + GST">After GST</Sortable>
              <Sortable k="tds" num order={order} setOrder={setOrder} title="TDS we cut from the vendor and pay to Government">TDS</Sortable>
              <Sortable k="total" num order={order} setOrder={setOrder} title="Total = After GST − TDS: what the vendor is paid">Total</Sortable>
              <Sortable k="paid" num order={order} setOrder={setOrder}>Paid</Sortable>
              <Sortable k="pending" num order={order} setOrder={setOrder}>Pending</Sortable>
              <th>Status</th>
              <th>Payment date</th>
              <th>Proof</th>
              <th className="oe-lg-actions-h">Action</th>
            </tr>
          </thead>
          <tbody>
            {!data && <tr><td colSpan={cols} className="oe-empty"><span className="oe-spin oe-spin-sm" aria-hidden="true" /> Loading…</td></tr>}
            {data && rows.length === 0 && (
              <tr>
                <td colSpan={cols} className="oe-empty">
                  {data.filtered ? 'No expenses match these filters.' : 'No expenses recorded yet.'}
                  {data.filtered && onClear && <div><button type="button" className="btn btn-sm" onClick={onClear}>Clear filters</button></div>}
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
                <Money v={r.amount} />
                <td className="num">{r.gstRate ? `${r.gstRate}%` : '0%'}</td>
                <Money v={r.gst} />
                <Money v={r.after} />
                <Money v={r.tds} />
                <td className="num" title={money2(r.total)}><b>{money(r.total)}</b></td>
                <Money v={r.paid} cls="oe-paid" />
                <Money v={r.pending} cls="oe-pend" />
                <td className="oe-nowrap"><ApprovalBadge s={r.status} /></td>
                <td className="oe-nowrap">
                  {r.paymentDate ? fmtD(r.paymentDate)
                    : <span className="cell-muted" title={r.status === 'PAID' ? 'Paid before payment dates were recorded' : 'Not paid yet'}>—</span>}
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
                      title={canDeleteRow(r) ? 'Delete' : 'Only the Accounts Admin / Approver can delete a paid expense'}
                      onClick={() => askDelete(r)}>Delete</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          {t && t.count > 0 && (
            <tfoot>
              <tr>
                <td className="oe-tot-l" colSpan={5}>Total · {t.count} expense{t.count === 1 ? '' : 's'}{data.filtered ? ' (these filters)' : ''}</td>
                <td className="num" title={money2(t.before)}>{money(t.before)}</td>
                <td />
                <td className="num" title={money2(t.gst)}>{money(t.gst)}</td>
                <td className="num" title={money2(t.after)}>{money(t.after)}</td>
                <td className="num" title={money2(t.tds)}>{money(t.tds)}</td>
                <td className="num" title={money2(t.total)}>{money(t.total)}</td>
                <td className="num" title={money2(t.paid)}>{money(t.paid)}</td>
                <td className="num" title={money2(t.pending)}>{money(t.pending)}</td>
                <td colSpan={4} />
              </tr>
            </tfoot>
          )}
        </table>
      </ScrollSync>

      {data && data.total > 0 && (
        <div className="oe-lg-more" ref={sentinel} aria-live="polite">
          <span className="small-muted">Showing {rows.length} of {data.total} expense{data.total === 1 ? '' : 's'} · the TOTAL row counts all {data.total}</span>
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
      {/* The "After GST = …" note is the "i" tooltip on the Expenses & Bills title (Office spec P2.4). */}

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
