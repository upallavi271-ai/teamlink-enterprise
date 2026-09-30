// Sections 2 and 3 — the summary cards and the expenses table.
import {
  Fragment, useEffect, useRef, useState,
} from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import ExpenseDetail from './ExpenseDetail.jsx';
import { ApprovalBadge } from './approval.jsx';
import {
  money, money2, fmtD, saveBlob,
} from './officeUtil';

// The proof upload goes through utils/attachments.js on the server, which
// takes these four types up to 5 MB and checks the file's first bytes.
const PROOF_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
const PROOF_MAX = 5 * 1024 * 1024;

// The approval status (pending yellow / approved blue / paid green / rejected
// red), and for a bill not yet paid how it stands against its due date.
const PAGE = 20;
function StatusPill({ r }) {
  const d = r.daysPending;
  let due = null;
  if (r.pending && r.dueOn && d != null) {
    if (d > 0) due = <div className="oe-due bad" title={`${d} day${d === 1 ? '' : 's'} past the due date, ${fmtD(r.dueOn)}`}>{d}d overdue</div>;
    else if (d === 0) due = <div className="oe-due">due today</div>;
    else due = <div className="oe-due" title={`Due ${fmtD(r.dueOn)}`}>due in {-d}d</div>;
  }
  return <><ApprovalBadge s={r.approvalStatus} />{due}</>;
}

function Card({
  label, n, s, tone, title,
}) {
  return (
    <div className={`statitem oe-card${tone ? ` acct-${tone}` : ''}`} title={title}>
      <div className="n">{n}</div>
      <div className="l">{label}</div>
      {s && <div className="s">{s}</div>}
    </div>
  );
}

const namesLine = (list, none) => {
  if (!list || !list.length) return none;
  const top = list.slice(0, 2).map((v) => v.name).join(', ');
  return list.length > 2 ? `${top} +${list.length - 2} more` : top;
};

export function SummaryCards({ data }) {
  const t = data.totals;
  const g = data.gst;
  return (
    <>
      <div className="oe-cards">
        <Card label="Entries" n={t.n.toLocaleString('en-IN')} s={`${t.categories} categor${t.categories === 1 ? 'y' : 'ies'}`} />
        <Card
          label="Total amount"
          n={money(t.afterGst)}
          s={`before GST ${money(t.base)} · GST ${money(t.gst)} · after GST ${money(t.afterGst)}`}
          title="Sum of After GST (Before GST + GST). What is actually paid after TDS is the Total chip above."
        />
        <Card label="Paid" n={money(t.paid)} s={namesLine(t.paidVendors, 'nothing paid')} tone="good" title="Total (after TDS) on the bills marked Paid" />
        <Card
          label="Pending to pay"
          n={money(t.pending)}
          s={t.pendingVendors.length ? t.pendingVendors.map((v) => v.name).slice(0, 3).join(', ') + (t.pendingVendors.length > 3 ? ` +${t.pendingVendors.length - 3} more` : '') : 'nobody — everything is paid'}
          tone={t.pending > 0.5 ? 'bad' : 'good'}
          title="Total (after TDS) on the bills still Pending"
        />
      </div>
      <div className="oe-cards">
        <Card label="GST received from clients" n={money(g.received)} s={`On ${g.invoices} invoice(s) raised in this period · from Invoices`} title="GST charged on outward invoices (the invoicing module), cancelled invoices left out" />
        <Card label="GST paid to vendors" n={money(g.paid)} s={data.filtered ? 'On the bills matching these filters' : 'On every bill in this period'} />
        <Card
          label="GST payable to Government"
          n={money(g.payable)}
          s={`received ${money(g.received)} − paid ${money(g.paid)}`}
          tone={g.payable > 0.5 ? 'bad' : 'good'}
          title="GST received from clients − GST paid to vendors. A negative figure is credit carried forward."
        />
        <Card label="TDS we cut" n={money(g.tds)} s="Held back from vendors, deposited for them" />
      </div>
    </>
  );
}

const COLS = [
  ['bill', 'Bill', 'asc'],
  ['bills', 'Bills', null],
  ['date', 'Date', 'desc'],
  ['vendor', 'Paid to', 'asc'],
  ['category', 'Category', 'asc'],
  ['billNo', 'Bill no', 'asc'],
  ['base', 'Before GST', 'desc'],
  ['gst', 'GST', 'desc'],
  ['tds', 'TDS', 'desc'],
  ['afterGst', 'After GST', 'desc'],
  ['net', 'Total', 'desc'],
  ['paid', 'Paid', null],
  ['balance', 'Balance', null],
  ['status', 'Status', null],
  ['proof', 'Proof', null],
  ['action', 'Action', null],
];
const PAIDBAL = ['paid', 'balance'];
// Paid / balance of a list of bills: Total (after TDS) of the Paid ones, and
// of the ones still Pending.
const paidOf = (rows) => rows.reduce((s, r) => s + (r.pending ? 0 : r.net), 0);
const balOf = (rows) => rows.reduce((s, r) => s + (r.pending ? r.net : 0), 0);
const MONEY = ['base', 'gst', 'tds', 'afterGst', 'net'];

const Missing = ({ what }) => <span className="status priority-high oe-miss" title={`${what} is not on this bill`}>missing</span>;

export default function ExpensesTab({
  data, view, setView, f, setF, canManage, canOverride, onEdit, onChanged, onError, onExport, busy, tableRef,
  onNew, emptyLabel, resetKey,
}) {
  // One row open at a time (spec A §D).
  const [openId, setOpenId] = useState(null);
  // Infinite scroll (no Previous / Next): PAGE more bills appear each time the
  // end of the table scrolls into view.
  const [shown, setShown] = useState(PAGE);
  const sentinel = useRef(null);
  const [exporting, setExporting] = useState(false);
  const [attachFor, setAttachFor] = useState(null);
  const [uploading, setUploading] = useState(null);
  const [note, setNote] = useState('');
  const [line, setLine] = useState(null); // null | { loading } | the bank-line payload
  const fileRef = useRef(null);
  const v = data.view;
  const grouped = v.grouped;
  const cols = COLS.filter(([k]) => k !== 'bills' || grouped);

  const sortBy = (k, def) => {
    if (!def) return;
    setView({ ...view, sort: k, dir: view.sort === k ? (view.dir === 'asc' ? 'desc' : 'asc') : def });
  };
  // A new filter, sort or period starts again at the top with nothing open.
  useEffect(() => { setShown(PAGE); setOpenId(null); }, [resetKey]);
  const doExport = async () => {
    setExporting(true);
    try { await onExport(); } catch { onError('The Excel file could not be made.'); }
    setExporting(false);
  };

  const moneyCells = (s, bold) => MONEY.map((k) => (
    <td key={k} className="num">{k === 'net' || bold ? <b>{money(s[k])}</b> : money(s[k])}</td>
  ));
  const paidBalCells = (rows, bold) => {
    const p = paidOf(rows);
    const b = balOf(rows);
    return [
      <td key="paid" className="num">{bold ? <b>{money(p)}</b> : money(p)}</td>,
      <td key="balance" className={`num${b > 0.5 ? ' oe-bal-due' : ''}`}>{bold ? <b>{money(b)}</b> : money(b)}</td>,
    ];
  };
  // Income, profit / loss and GST payable for a month (grouped by month only).
  const monthMetrics = (m) => (m ? (
    <span className="oe-month-metrics">
      <span className="oe-metric"><small>Income</small><b>{money(m.income)}</b></span>
      <span className="oe-metric"><small>{m.pl >= 0 ? 'Profit' : 'Loss'}</small><b className={m.pl >= 0 ? 'oe-ok' : 'oe-bad'}>{m.pl < 0 ? '− ' : ''}{money(Math.abs(m.pl))}</b></span>
      <span className="oe-metric"><small>GST payable</small><b>{m.gstPayable < 0 ? '− ' : ''}{money(Math.abs(m.gstPayable))}</b></span>
    </span>
  ) : null);

  // ---- proof: attach a file (the vendor's bill / tax invoice) ----
  const startAttach = (r) => {
    setAttachFor(r);
    if (fileRef.current) { fileRef.current.value = ''; fileRef.current.click(); }
  };
  const onFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    const r = attachFor;
    setAttachFor(null);
    if (!file || !r) return;
    if (!PROOF_TYPES.includes(file.type)) { onError(`${file.name} is not a PDF, PNG, JPEG or WebP file.`); return; }
    if (file.size > PROOF_MAX) { onError(`${file.name} is larger than 5 MB — attach a smaller scan.`); return; }
    const fd = new FormData();
    fd.append('file', file);
    setUploading(r.id);
    try {
      await api.post(`/office-expenses/${r.id}/proof`, fd);
      setNote(`Attached ${file.name} to ${r.vendor || r.billName}${r.taxInvoiceNeeded ? ` — GST ${money(r.gst)} is now backed by the vendor's tax invoice.` : '.'}`);
      onChanged();
    } catch (err) {
      onError(err.response?.data?.error || 'The file could not be attached.');
    }
    setUploading(null);
  };
  const openProof = async (r) => {
    try {
      const res = await api.get(`/office-expenses/${r.id}/proof/file`, { responseType: 'blob' });
      saveBlob(res, r.proofName || 'proof');
    } catch { onError('That file could not be opened.'); }
  };
  const viewLine = async (r) => {
    setLine({ loading: true, name: r.vendor || r.billName });
    try {
      const res = await api.get(`/office-expenses/${r.id}/bank-line`);
      setLine(res.data);
    } catch (err) {
      setLine(null);
      onError(err.response?.data?.error || 'The bank line could not be loaded.');
    }
  };

  const proofCell = (r) => {
    const file = r.proofName && (
      r.proofOnServer
        ? <button type="button" className="link-btn oe-proof-file" title={r.proofName} onClick={() => openProof(r)}>{r.proofName}</button>
        : <span className="oe-proof-file" title="Only the file name is on record">{r.proofName}</span>
    );
    if (r.bankTxnId) {
      return (
        <div className="oe-proof">
          <span className="status priority-low">Bank statement</span>
          {r.bankLine
            ? <button type="button" className="btn btn-sm" onClick={() => viewLine(r)}>▤ View line</button>
            : <span className="small-muted">line no longer on file</span>}
          {file && <div className="small-muted oe-proof-sub">Tax invoice: {file}</div>}
        </div>
      );
    }
    if (r.proofName) {
      return <div className="oe-proof"><span className="status priority-low">Bill</span>{file}</div>;
    }
    return (
      <div className="oe-proof">
        <span className="status priority-high">No bill</span>
        {canManage && (
          <button type="button" className="btn btn-sm oe-gold" disabled={uploading === r.id} onClick={() => startAttach(r)}>
            {uploading === r.id ? 'Attaching…' : 'Attach'}
          </button>
        )}
      </div>
    );
  };

  // A click anywhere on the row opens it — except on the row's own buttons
  // and links (Edit, Attach, View line, the proof file).
  const rowClick = (e, r) => {
    if (e.target.closest('button, a, input, select, label')) return;
    setOpenId(openId === r.id ? null : r.id);
  };
  const editable = (r) => canManage && (r.approvalStatus === 'PENDING' || canOverride);
  const row = (r) => {
    const isOpen = openId === r.id;
    return (
      <Fragment key={r.id}>
        <tr className={`oe-row-click${isOpen ? ' oe-row-open' : ''}`} onClick={(e) => rowClick(e, r)}>
          <td className="oe-bill">
            <button type="button" className="link-btn" onClick={() => setOpenId(isOpen ? null : r.id)} aria-expanded={isOpen}>
              {isOpen ? '▾' : '▸'} {String(r.billName).slice(0, 44)}
            </button>
            <span className="oe-tags">
              {r.atRisk && <span className="status priority-high" title="GST charged, no valid vendor GSTIN — the input credit cannot be claimed">GSTIN missing</span>}
            </span>
          </td>
          {grouped && <td />}
          <td className="oe-nowrap">{fmtD(r.expenseDate)}</td>
          <td>{r.vendor || <Missing what="The vendor" />}</td>
          <td>{r.category || '—'}</td>
          <td className="oe-nowrap">{r.billNumber || <Missing what="The bill number" />}</td>
          {moneyCells(r)}
          {paidBalCells([r])}
          <td className="oe-nowrap">
            <StatusPill r={r} />
          </td>
          <td>{proofCell(r)}</td>
          <td>
            {editable(r)
              ? <button type="button" className="btn btn-sm" title={r.approvalStatus === 'PENDING' ? 'Edit this expense' : 'Admin correction after approval — audited'} onClick={() => onEdit(r)}>✎ Edit</button>
              : <span className="cell-muted" title={canManage ? 'Only a Pending expense can be edited' : undefined}>—</span>}
          </td>
        </tr>
        {r.taxInvoiceNeeded && (
          <tr className="oe-warn-row">
            <td colSpan={cols.length}>
              <span className="oe-warn-line">
                <span className="oe-warn-ico" aria-hidden="true">!</span>
                GST {money(r.gst)} — vendor tax invoice still needed
                {canManage && <>{' · '}<button type="button" className="link-btn" onClick={() => startAttach(r)}>attach it</button></>}
              </span>
            </td>
          </tr>
        )}
        {isOpen && (
          <ExpenseDetail
            row={r}
            colSpan={cols.length}
            canManage={canManage}
            onClose={() => setOpenId(null)}
            onChanged={onChanged}
            onEdit={onEdit}
            onNote={setNote}
          />
        )}
      </Fragment>
    );
  };

  // In the table's own order, PAGE (20) more at a time. A group's subtotal (for
  // the WHOLE group) sits under its last bill once that bill is showing; the
  // TOTAL row is always the whole filtered set.
  const flat = v.total.n > 0 ? v.groups.flatMap((g) => g.rows.map((r, i) => ({ r, g, last: i === g.rows.length - 1 }))) : [];
  const pageItems = flat.slice(0, shown);
  const hasMore = shown < flat.length;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((en) => en.isIntersecting)) setShown((n) => n + PAGE);
    }, { root: el.parentElement, rootMargin: '0px 0px 120px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, shown]);

  return (
    <div className="card oe-table-card" ref={tableRef}>
      <div className="oe-tbar">
        <div className="oe-tbar-t">
          <h3>{v.total.n} bill{v.total.n === 1 ? '' : 's'} · {money(v.total.net)}</h3>
          <div className="small-muted">{data.period.label}{data.filtered ? ' · filtered' : ''} — click a column to sort, a row to open it · scroll for more</div>
        </div>
        {f.only === 'atrisk' && (
          <span className="chip">Only bills with GST at risk
            <button type="button" className="link-btn" style={{ marginLeft: 6 }} onClick={() => setF({ ...f, only: '' })} aria-label="Show every bill">✕</button>
          </span>
        )}
        {note && (
          <span className="chip" role="status">{note}
            <button type="button" className="link-btn" style={{ marginLeft: 6 }} onClick={() => setNote('')} aria-label="Dismiss">✕</button>
          </span>
        )}
        <label className="oe-f oe-inline"><span>Group by</span>
          <select className="oe-sel" value={view.groupBy} onChange={(e) => setView({ ...view, groupBy: e.target.value })}>
            <option value="month">Month</option>
            <option value="cat">Category</option>
            <option value="vendor">Paid to</option>
            <option value="none">No grouping</option>
          </select>
        </label>
        <button type="button" className="btn btn-sm" onClick={doExport} disabled={exporting} title="Download exactly this view — filters, sort, grouping, subtotals and TOTAL">
          {exporting ? 'Preparing…' : '⬇ Excel'}
        </button>
      </div>
      <div className={`tbl-wrap oe-tbl${busy ? ' busy' : ''}`}>
        <table>
          <thead>
            <tr>
              {cols.map(([k, l, def]) => (
                <th key={k} className={`${MONEY.includes(k) || PAIDBAL.includes(k) || k === 'bills' ? 'num' : ''}${def ? ' oe-sortable' : ''}`}
                  onClick={() => sortBy(k, def)} aria-sort={view.sort === k ? (view.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  title={k === 'net' ? 'Total = After GST − TDS (what is paid to the vendor)' : undefined}>
                  {l}{view.sort === k && <span className="oe-arrow">{view.dir === 'asc' ? ' ▲' : ' ▼'}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {v.total.n === 0 && (
              <tr>
                <td colSpan={cols.length} className="oe-empty">
                  {data.filtered
                    ? <>No expenses match these filters for {emptyLabel}.</>
                    : <>No expenses recorded for {emptyLabel}</>}
                  {canManage && onNew && !data.filtered && (
                    <div><button type="button" className="btn btn-sm btn-gold" onClick={onNew}>+ Add Expense</button></div>
                  )}
                </td>
              </tr>
            )}
            {pageItems.map(({ r, g, last }) => (
              <Fragment key={r.id}>
                {row(r)}
                {grouped && last && (
                  <tr className="oe-sub">
                    <td>{g.label} · subtotal</td>
                    <td className="num">{g.sub.n}</td>
                    <td /><td /><td /><td />
                    {moneyCells(g.sub, true)}
                    {paidBalCells(g.rows, true)}
                    <td colSpan={2}>{monthMetrics(g.month)}</td>
                    <td />
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
          <tfoot>
            <tr className="oe-total">
              <td>TOTAL</td>
              {grouped && <td className="num">{v.total.n}</td>}
              <td /><td /><td /><td />
              {moneyCells(v.total, true)}
              {paidBalCells(v.groups.flatMap((g) => g.rows), true)}
              <td colSpan={2}>{monthMetrics(v.monthTotals)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
        {/* The table box scrolls on its own (.oe-tbl max-height), so the sentinel lives inside it. */}
        <div ref={sentinel} className="oe-sentinel" aria-hidden="true" />
      </div>
      {flat.length > 0 && (
        <div className="oe-lg-more" aria-live="polite">
          <span className="small-muted">Showing {pageItems.length} of {flat.length}</span>
          {hasMore
            ? <span className="oe-lg-more-s"><span className="oe-spin oe-spin-sm" aria-hidden="true" /> Loading more…</span>
            : <span className="oe-lg-end">End of list · all {flat.length} shown</span>}
        </div>
      )}
      <div className="small-muted oe-foot-note">
        After GST = Before GST + GST · Total = After GST − TDS, which is what is actually paid to the vendor.
        {data.outsidePeriod > 0 && ` ${data.outsidePeriod} bill(s) on record fall outside this period.`}
      </div>
      <div className="small-muted oe-foot-note">
        Income and Profit / Loss show when the table is grouped by month — income is the fee earned that month before GST, profit is that income minus what the office actually paid out, and GST payable is what we charged clients less what we paid vendors.
      </div>

      <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp" hidden onChange={onFile} />

      {line && (
        <Modal
          title="Bank statement line"
          note={line.expense ? `${line.expense.vendor || line.expense.billName}` : line.name}
          size="wide"
          onClose={() => setLine(null)}
          footer={(
            <>
              <Link className="btn" to="/bank">Open Bank &amp; Reconciliation</Link>
              <button type="button" className="btn btn-primary" onClick={() => setLine(null)}>Close</button>
            </>
          )}
        >
          {line.loading ? <div className="small-muted">Loading the statement…</div> : (
            <>
              {line.account && (
                <div className="oe-stmt-acct">
                  <span><b>{line.account.bank}</b>{line.account.accNo ? ` · ${line.account.accNo}` : ''}{line.account.name ? ` · ${line.account.name}` : ''}</span>
                  {line.account.branch && <span>{line.account.branch}</span>}
                </div>
              )}
              <div className="tbl-wrap">
                <table className="oe-stmt">
                  <thead>
                    <tr>
                      <th>Date</th><th>Narration</th><th>Ref / UTR</th>
                      <th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {line.around.map((t) => (
                      <tr key={t.id} className={t.match ? 'oe-stmt-match' : 'oe-stmt-dim'}>
                        <td className="oe-nowrap">{fmtD(t.date)}</td>
                        <td>{t.description}</td>
                        <td className="oe-nowrap">{t.reference || '—'}</td>
                        <td className="num">{t.type === 'Debit' ? money2(t.amount) : ''}</td>
                        <td className="num">{t.type === 'Credit' ? money2(t.amount) : ''}</td>
                        <td className="num">{t.balance != null ? money2(t.balance) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="oe-stmt-kv">
                <div><span>Matched to</span><b>{line.expense.vendor || line.expense.billName} — bill of {fmtD(line.expense.expenseDate)}</b></div>
                <div><span>Bill total (after TDS)</span><b>{money2(line.expense.net)}{line.expense.gst > 0.5 ? ` · incl. GST ${money2(line.expense.gst)}` : ''}</b></div>
                <div><span>Bank {line.line.type === 'Credit' ? 'credit' : 'debit'}</span><b>{money2(line.line.amount)}</b></div>
                <div>
                  <span>Difference</span>
                  {Math.abs(line.difference) < 0.5
                    ? <span className="status priority-low">Exact match</span>
                    : <span className="status priority-medium">{money2(line.difference)}</span>}
                </div>
                <div>
                  <span>Vendor tax invoice</span>
                  {line.expense.proofName
                    ? <span className="status priority-low">On file · {line.expense.proofName}</span>
                    : (line.expense.gst > 0.5 ? <span className="status priority-medium">Still needed</span> : <span className="status">Not needed — no GST</span>)}
                </div>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
