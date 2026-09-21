import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import api from '../api';
import Combo from '../components/Combo.jsx';

const money = (n) => `₹${Math.round(Number(n || 0)).toLocaleString('en-IN')}`;
const money2 = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const today = () => new Date().toISOString().slice(0, 10);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtD = (iso) => {
  if (!iso) return '—';
  const s = String(iso).slice(0, 10);
  const [y, m, d] = s.split('-');
  return m ? `${d} ${MON[Number(m) - 1]} ${y}` : s;
};
const signed = (v) => `${v < 0 ? '−' : ''}${money(Math.abs(v))}`;

// Office & Accounts is one module with six tabs, in the order the accounting
// application arranges them: the bills themselves, the month day by day, what
// is on file behind each payment, the GST position, the profit & loss, and the
// category / month summary.
const OFF_TABS = [
  ['bills', 'Bills & expenses', 'Every office bill, grouped whichever way you need'],
  ['calendar', '🗓 Calendar', 'The month day by day — what went out, what came in, what is still due, and the dates that do not move'],
  ['proofs', '📎 Proofs & bill files', 'What is on file behind every office payment — open it, swap it, or fix the expense'],
  ['gst', 'GST position', 'What we charged clients against what we paid vendors — month by month, the way GSTR-3B reads it'],
  ['pnl', 'Profit & Loss', 'Income against office spend, on bills raised and on cash actually moved'],
  ['summary', 'Category & month summary', 'Where the money goes, by category and by month'],
];

const CURRENT_FY = (() => {
  const now = new Date();
  return now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
})();

const PERIODS = (() => {
  const now = new Date();
  const fy = CURRENT_FY;
  const yr = (y) => `${y}–${String(y + 1).slice(2)}`;
  const out = [['all', 'Every month on record']];
  [fy, fy - 1].forEach((y) => {
    out.push([`FY:${y}`, y === fy ? `Current Financial Year · FY ${yr(y)}` : `FY ${yr(y)}`]);
    out.push([`H1:${y}`, `Apr–Sep ${yr(y)}`]);
    out.push([`H2:${y}`, `Oct–Mar ${yr(y)}`]);
    ['Q1 Apr–Jun', 'Q2 Jul–Sep', 'Q3 Oct–Dec', 'Q4 Jan–Mar'].forEach((w, i) => {
      out.push([`Q${i + 1}:${y}`, `${w} ${yr(y)}`]);
    });
  });
  for (let i = 0; i < 12; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    out.push([`M:${mk}`, `${MON[d.getMonth()]} ${d.getFullYear()}`]);
  }
  return out;
})();

const BLANK_FILTERS = {
  category: 'All', vendor: 'All', month: 'All', status: 'All', mode: 'All', gst: 'All', q: '', noGstin: false,
};

const BLANK = {
  entryKind: 'expense',
  expenseDate: today(),
  dueDate: '',
  category: '',
  frequency: 'Monthly',
  monthsCovered: '',
  description: '',
  baseAmount: '',
  gstApplicable: 'No',
  gstRatePct: '18',
  tdsApplicable: 'No',
  tdsRatePct: '10',
  vendor: '',
  vendorGstin: '',
  supplyType: 'Service',
  gstTreatment: 'Registered Business - Regular',
  sourceState: '',
  billNumber: '',
  location: '',
  paidStatus: 'Paid',
  paymentMode: 'Bank Transfer',
  approvedBy: '',
  remarks: '',
};

// The generic printable copy the accounting application opens for any table.
function printRows(title, rows) {
  const cols = Object.keys(rows[0] || {});
  const w = window.open('', '_blank');
  if (!w) return;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[c]));
  w.document.write(`<html><head><title>${esc(title)}</title><style>
    body{font:11px "Public Sans",Arial;color:#16202B;padding:22px}h1{font:600 17px Georgia,serif;margin:0 0 4px}
    p{color:#53637A;margin:0 0 14px;font-size:11px}table{width:100%;border-collapse:collapse;font-size:9.5px}
    th,td{border:1px solid #DDE3EC;padding:4px 6px;text-align:left}th{background:#1F3864;color:#fff}
    td.n{text-align:right}</style></head><body><h1>Teamlink Consultants — ${esc(title)}</h1>
    <p>Generated ${fmtD(today())} · ${rows.length} row(s)</p>
    <table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>
    ${rows.map((r) => `<tr>${cols.map((c) => `<td${typeof r[c] === 'number' ? ' class="n"' : ''}>${esc(typeof r[c] === 'number' ? Math.round(r[c]).toLocaleString('en-IN') : r[c])}</td>`).join('')}</tr>`).join('')}
    </tbody></table></body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 350);
}

export default function Office() {
  const [tab, setTab] = useState('bills');
  const [period, setPeriod] = useState(`FY:${CURRENT_FY}`);
  const [error, setError] = useState('');
  // Clicking "4 missing" on a month, a vendor or a category lands on exactly
  // those four bills, not on the whole register.
  const [proofScope, setProofScope] = useState(null);
  const [proofPre, setProofPre] = useState('all');

  const openProofs = (mode, key, filter) => {
    setProofScope({ mode, key });
    setProofPre(filter || 'all');
    setTab('proofs');
    window.scrollTo({ top: 0 });
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Office &amp; Accounts</h1>
          <div className="page-sub">
            Office spend, the category and month summary, profit &amp; loss, and the GST position —
            charged to clients against paid to vendors.
          </div>
        </div>
      </div>

      <div className="tabbar">
        {OFF_TABS.map(([k, label]) => (
          <button key={k} className={`tab-btn ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      <div className="small-muted" style={{ marginTop: -8, marginBottom: 14 }}>
        {(OFF_TABS.find(([k]) => k === tab) || [])[2]}
      </div>

      <div className="filter-row">
        <label className="field" style={{ minWidth: 240 }}><span>Period</span>
          <Combo value={period} onChange={(e) => setPeriod(e.target.value)}>
            {PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Combo>
        </label>
      </div>

      {error && <div className="card section error-text" style={{ marginBottom: 12 }}>{error}</div>}

      {tab === 'bills' && <Bills period={period} onError={setError} onProofs={openProofs} onTab={setTab} />}
      {tab === 'calendar' && <Calendar />}
      {tab === 'proofs' && (
        <Proofs
          scope={proofScope}
          preset={proofPre}
          onError={setError}
          onClearScope={() => { setProofScope(null); setProofPre('all'); }}
        />
      )}
      {tab === 'gst' && <Gst period={period} />}
      {tab === 'pnl' && <Pnl period={period} />}
      {tab === 'summary' && <Summary period={period} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bills & expenses
// ---------------------------------------------------------------------------
function Bills({
  period, onError, onProofs, onTab,
}) {
  const [data, setData] = useState(null);
  const [f, setF] = useState(BLANK_FILTERS);
  const [groupBy, setGroupBy] = useState('month');
  const [open, setOpen] = useState({});
  const [form, setForm] = useState(BLANK);
  const [editing, setEditing] = useState(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(() => {
    api.get('/office-expenses/bills', { params: { period, ...f, groupBy } })
      .then((res) => setData(res.data))
      .catch(() => onError('Office bills could not be loaded.'));
  }, [period, f, groupBy, onError]);
  useEffect(load, [load]);

  async function run(fn) {
    onError('');
    try { await fn(); load(); } catch (e) { onError(e.response?.data?.error || 'That did not work.'); }
  }

  const save = (e) => {
    e.preventDefault();
    const body = {
      ...form,
      gstRatePct: form.gstApplicable === 'Yes' ? form.gstRatePct : 0,
      tdsRatePct: form.tdsApplicable === 'Yes' ? form.tdsRatePct : 0,
      gstAmount: undefined,
      tdsAmount: undefined,
    };
    run(async () => {
      if (editing) await api.patch(`/office-expenses/${editing}`, body);
      else await api.post('/office-expenses', body);
      setForm(BLANK); setEditing(null); setShowForm(false);
    });
  };

  const edit = (r) => {
    setEditing(r.id);
    setShowForm(true);
    setForm({
      ...BLANK,
      entryKind: r.entryKind || 'expense',
      expenseDate: r.expenseDate || today(),
      dueDate: r.dueDate || '',
      category: r.category || '',
      frequency: r.frequency || 'Monthly',
      monthsCovered: r.monthsCovered || '',
      description: r.description || '',
      baseAmount: r.base,
      gstApplicable: r.gst > 0 ? 'Yes' : 'No',
      gstRatePct: r.gstRate || '18',
      tdsApplicable: r.tds > 0 ? 'Yes' : 'No',
      tdsRatePct: r.tdsRate || '10',
      vendor: r.vendor || '',
      vendorGstin: r.vendorGstin || '',
      supplyType: r.supplyType || 'Service',
      gstTreatment: r.gstTreatment || 'Registered Business - Regular',
      sourceState: r.sourceState || '',
      billNumber: r.billNumber || '',
      location: r.location || '',
      paidStatus: r.statusLabel || 'Paid',
      paymentMode: r.paymentMode || 'Bank Transfer',
      approvedBy: r.approvedBy || '',
      remarks: r.remarks || '',
    });
    window.scrollTo({ top: document.body.scrollHeight });
  };

  if (!data) return <div className="small-muted">Loading…</div>;
  const t = data.totals;
  const g = data.gst;
  const o = data.options;
  const whole = data.filtered ? ' · whole period, not this filter' : '';
  const isM = data.groupBy === 'month';
  const payees = data.payees.slice(0, 2).map((p) => p.name);
  const pendingWho = [...new Set(data.rows.filter((r) => r.pending).map((r) => r.vendor || r.category || '—'))];


  const bits = [];
  if (f.category !== 'All') bits.push(`category ${f.category}`);
  if (f.vendor !== 'All') bits.push(`vendor ${f.vendor}`);
  if (f.status !== 'All') bits.push(`status ${f.status}`);
  if (f.mode !== 'All') bits.push(`mode ${f.mode}`);
  if (f.gst !== 'All') bits.push(`GST ${f.gst}`);
  if (f.q.trim()) bits.push(`search ${f.q}`);

  const billRow = (r, kid) => (
    <tr key={r.id} className={kid ? 'kidrow' : undefined}>
      <td>{kid ? '└ ' : ''}{String(r.description || r.category || '—').slice(0, 42)}</td>
      <td className="num small-muted">1</td>
      <td>{fmtD(r.expenseDate)}</td>
      <td>{r.vendor || '—'}</td>
      <td>{r.category || '—'}</td>
      <td className="small-muted">{r.billNumber || '—'}</td>
      <td className="small-muted">{r.vendorGstin || (r.gst > 0.5 ? <span className="status priority-high">missing</span> : '—')}</td>
      <td className="num">{money(r.base)}</td>
      <td className="num">{money(r.gst)}</td>
      <td className="num">{money(r.tds)}</td>
      <td className="num"><b>{money(r.net)}</b></td>
      <td className="num">{money(r.paidValue)}</td>
      <td className="num">{money(r.pendingValue)}</td>
      {isM && <><td /><td /><td /></>}
      <td>
        <span className={`status ${r.pending ? (r.overdue ? 'priority-high' : 'priority-medium') : 'priority-low'}`}>
          {r.statusLabel}{r.overdue ? ` · ${r.daysPending}d` : ''}
        </span>
      </td>
      <td>{PROOF_LABEL[r.proofKind]}</td>
      <td>
        <div className="qa-row">
          <button className="btn btn-sm" onClick={() => edit(r)}>✎ Edit</button>
          {r.pending && <button className="btn btn-sm" onClick={() => run(() => api.patch(`/office-expenses/${r.id}`, { paidStatus: 'Paid' }))}>Mark paid</button>}
          <button className="btn btn-sm" onClick={() => run(() => api.delete(`/office-expenses/${r.id}`))}>Remove</button>
        </div>
      </td>
    </tr>
  );

  const cols = isM ? 19 : 16;

  return (
    <>
      {/* the same screen is reachable from the tab bar; this is the one on the
          page itself, because a tab is easy to walk past */}
      <div className="card section" style={{ marginBottom: 14, borderLeft: '4px solid var(--amber)' }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <b style={{ fontSize: 14.5 }}>📎 Proofs &amp; bill files</b>
            <div className="small-muted" style={{ marginTop: 3 }}>
              <span className="status priority-low">{data.proofs.file + data.proofs.bank + data.proofs.gstdue} payment(s) proved</span>{' '}
              {data.proofs.gstdue > 0 && <span className="status priority-medium">{data.proofs.gstdue} still need the vendor tax invoice</span>}{' '}
              {data.proofs.none > 0 && <span className="status priority-high">{data.proofs.none} nothing on file</span>}
              {' '}— open what is behind any payment, swap the file, or fix the expense.
            </div>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => onTab('proofs')}>Open proofs &amp; bill files →</button>
        </div>
      </div>

      {/* everything in one box — category, vendor and every money figure */}
      <BillFilters
        f={f}
        setF={setF}
        o={o}
        totals={t}
        onNew={() => { setEditing(null); setForm(BLANK); setShowForm(true); }}
      />

      {/* nothing matches — say what the pick is worth on its own rather than
          simply showing ₹0 */}
      {data.rows.length === 0 && bits.length > 0 && (
        <div className="notice amber" style={{ marginBottom: 14 }}>
          <span>
            <b>Nothing matches all of these at once</b> — {bits.join(' and ')} — so every figure below reads ₹0.
            {data.solo && (
              <> <br />On its own, <b>{data.solo.name}</b> is <b>{data.solo.n} bill(s) · {money(data.solo.net)}</b> in this period
                {data.solo.gst > 0.5 ? ` (GST ${money(data.solo.gst)})` : ' — these bills carry no GST at all, which is why a GST filter empties them'}.</>
            )}
            <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-sm" onClick={() => setF(BLANK_FILTERS)}>Clear every filter</button>
            </div>
          </span>
        </div>
      )}

      {/* "TDS" is both a category of bill and a column on every bill, and the
          two mean opposite things. */}
      {data.taxCatNote && (
        <div className="notice" style={{ marginBottom: 14 }}>
          <span>
            <b>The {data.taxCatNote} column reads ₹0 here, and that is right.</b>{' '}
            The <b>{data.taxCatNote} category</b> above holds {t.n} bill(s) worth <b>{money(t.net)}</b> — that is money we paid <b>to Government</b>.
            The <b>{data.taxCatNote === 'TDS' ? 'TDS we cut' : data.taxCatNote} column</b> means something else: what we held back <b>from a vendor</b> on their own bill.
            Nobody deducts {data.taxCatNote} on a {data.taxCatNote} challan, so that column is nil on these lines.
          </span>
        </div>
      )}

      <div className="statbar">
        <Stat n={t.n} l="Entries" s={`${t.categories} categor${t.categories === 1 ? 'y' : 'ies'}`} />
        <Stat n={money(t.net)} l="Total amount" s={`before GST ${money(t.base)} · GST ${money(t.gst)} · after GST ${money(t.afterGst)}`} />
        <Stat n={money(t.paid)} l="Paid" s={payees.length ? `${payees.join(', ')}${data.payees.length > 2 ? ` +${data.payees.length - 2} more` : ''}` : 'nothing paid yet'} tone="good" />
        <Stat n={money(t.pendingValue)} l="Pending to pay" s={pendingWho.length ? `${pendingWho.slice(0, 2).join(', ')}${pendingWho.length > 2 ? ` +${pendingWho.length - 2} more` : ''}` : 'nobody — everything is paid'} tone={t.pendingValue > 0.5 ? 'bad' : 'good'} />
        <Stat n={money(g.out)} l="GST received from clients" s={`${money(g.outReceived)} actually collected · ${money(g.pending)} still to come${whole}`} />
        <Stat n={money(g.input)} l="GST paid to vendors" s={`Input credit you can claim${whole}`} />
        <Stat
          n={money(Math.abs(g.net))}
          l={g.net >= 0 ? 'GST payable to Government' : 'GST credit carried'}
          s={`charged ${money(g.out)} − paid ${money(g.input)}${whole}`}
          tone={g.net >= 0 ? 'bad' : 'good'}
        />
        <Stat n={money(t.tds)} l="TDS we cut" s={`Held back from vendors and paid on their behalf${data.filtered ? ' · in this filter' : ''}`} />
        <Stat
          n={signed(data.profit.pl)}
          l={data.profit.pl >= 0 ? 'Profit' : 'Loss'}
          s={`income ${money(data.profit.income)} − spend ${money(data.profit.spend)}${whole}`}
          tone={data.profit.pl >= 0 ? 'good' : 'bad'}
        />
        <Stat
          n={signed(data.cashProfit.pl)}
          l={data.cashProfit.pl >= 0 ? 'Profit on cash' : 'Loss on cash'}
          s={`${money(data.cashProfit.cashIn)} in − ${money(data.cashProfit.paid)} out${whole}`}
          tone={data.cashProfit.pl >= 0 ? 'good' : 'bad'}
        />
      </div>

      {data.outsidePeriod > 0 && (
        <div className="notice amber">
          <span>{data.outsidePeriod} bill(s) on record fall outside the period you picked, so they are not in the figures above.</span>
        </div>
      )}

      {/* ONE TABLE for the office. Group it by month, who we paid, category or
          paid/pending — or switch grouping off for a flat list. */}
      <div className="card section">
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <h3>
              {data.groupTotals.n} bill(s) · {money(data.groupTotals.net)}
              {isM && ` · ${data.groupTotals.pl >= 0 ? 'profit' : 'loss'} ${money(Math.abs(data.groupTotals.pl))}`}
            </h3>
            <div className="small-muted">One table — group it whichever way you need, then open a row for the bills inside</div>
          </div>
          <label className="field"><span>Group by</span>
            <Combo value={data.groupBy} onChange={(e) => { setGroupBy(e.target.value); setOpen({}); }}>
              {o.groupBy.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Combo>
          </label>
          <button className="btn btn-sm" onClick={() => printRows('Office Expenditure', data.rows.map((r) => ({
            Date: r.expenseDate, 'Paid to': r.vendor || '', Category: r.category, 'Bill no': r.billNumber || '',
            'Vendor GSTIN': r.vendorGstin || '', 'Before GST': r.base, GST: r.gst, TDS: r.tds, Total: r.net, Status: r.statusLabel,
          })))}>🖨 Print</button>
        </div>

        <div className="tbl-wrap" style={{ maxHeight: '70vh', marginTop: 10 }}>
          <table>
            <thead>
              <tr>
                <th>{isM ? 'Month' : data.groupBy === 'vendor' ? 'Paid to' : data.groupBy === 'cat' ? 'Category' : data.groupBy === 'status' ? 'Paid / pending' : 'Bill'}</th>
                <th className="num">Bills</th><th>Date</th><th>Paid to</th><th>Category</th><th>Bill no</th><th>Vendor GSTIN</th>
                <th className="num">Before GST</th><th className="num">GST</th><th className="num">TDS</th><th className="num">Total</th>
                <th className="num">Paid</th><th className="num">Pending</th>
                {isM && <><th className="num">Income</th><th className="num">Profit / Loss</th><th className="num">GST payable</th></>}
                <th>Status</th><th>Bill / proof</th><th>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.groupBy === 'none' && data.rows.map((r) => billRow(r, false))}
              {data.groupBy !== 'none' && data.groups.map((gr) => (
                <Fragment key={gr.key}>
                  <tr>
                    <td>
                      <button className="link-btn" onClick={() => setOpen({ ...open, [gr.key]: !open[gr.key] })} title="The bills inside">
                        {open[gr.key] ? '▾' : '▸'}
                      </button>{' '}
                      <b>{gr.label}</b>
                    </td>
                    <td className="num"><b>{gr.n}</b></td>
                    <td /><td /><td /><td />
                    <td>
                      {gr.noGstin
                        ? <button className="link-btn" onClick={() => onProofs(data.groupBy, gr.key, 'all')} title={`Vendor GSTIN missing on ${gr.noGstin} bill(s) — open them`}><span className="status priority-high">{gr.noGstin} missing</span></button>
                        : <span className="small-muted">—</span>}
                    </td>
                    <td className="num">{money(gr.base)}</td>
                    <td className="num">{money(gr.gst)}</td>
                    <td className="num">{money(gr.tds)}</td>
                    <td className="num"><b>{money(gr.net)}</b></td>
                    <td className="num">{money(gr.paid)}</td>
                    <td className="num">{money(gr.pending)}</td>
                    {isM && (
                      <>
                        <td className="num">{money(gr.income)}</td>
                        <td className="num"><b style={{ color: gr.pl >= 0 ? 'var(--teal)' : 'var(--red)' }}>{signed(gr.pl)}</b></td>
                        <td className="num">{signed(gr.gstPayable)}</td>
                      </>
                    )}
                    <td>{gr.pending > 0.5
                      ? <span className="status priority-medium">{money(gr.pending)} pending</span>
                      : <span className="status priority-low">all paid</span>}
                    </td>
                    <td>
                      <button className="link-btn" title="Open these on the proofs screen" onClick={() => onProofs(data.groupBy, gr.key, gr.noBill ? 'none' : 'all')}>
                        <span className={`status ${gr.noBill ? 'priority-high' : 'priority-low'}`}>{gr.noBill ? `${gr.noBill} missing` : 'all filed'}</span>
                      </button>
                    </td>
                    <td />
                  </tr>
                  {open[gr.key] && gr.rows.map((r) => billRow(r, true))}
                </Fragment>
              ))}
              {data.groupTotals.n === 0 && (
                <tr>
                  <td colSpan={cols} className="empty-mini">
                    No office bill in this period{bits.length ? ` with ${bits.join(' and ')}` : ''}.
                    <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => setF(BLANK_FILTERS)}>Reset the filters</button>
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <td>TOTAL</td><td className="num">{data.groupTotals.n}</td><td /><td /><td /><td /><td />
                <td className="num">{money(data.groupTotals.base)}</td>
                <td className="num">{money(data.groupTotals.gst)}</td>
                <td className="num">{money(data.groupTotals.tds)}</td>
                <td className="num"><b>{money(data.groupTotals.net)}</b></td>
                <td className="num">{money(data.groupTotals.paid)}</td>
                <td className="num">{money(data.groupTotals.pending)}</td>
                {isM && (
                  <>
                    <td className="num">{money(data.groupTotals.income)}</td>
                    <td className="num"><b style={{ color: data.groupTotals.pl >= 0 ? 'var(--teal)' : 'var(--red)' }}>{signed(data.groupTotals.pl)}</b></td>
                    <td className="num">{signed(data.groupTotals.gstPayable)}</td>
                  </>
                )}
                <td /><td /><td />
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="small-muted" style={{ marginTop: 8 }}>
          Income and Profit / Loss show when the table is grouped by month — income is the fee earned that month before GST,
          profit is that income minus what the office actually paid out, and GST payable is what we charged clients less what we paid vendors.
        </div>
      </div>

      {showForm && (
        <ExpenseForm
          form={form}
          setForm={setForm}
          options={o}
          editing={editing}
          onSubmit={save}
          onCancel={() => { setShowForm(false); setEditing(null); setForm(BLANK); }}
        />
      )}
    </>
  );
}

const PROOF_LABEL = {
  file: <span className="status priority-low">Bill attached</span>,
  bank: <span className="status priority-low">Bank statement</span>,
  gstdue: <span className="status priority-medium">Tax invoice needed</span>,
  none: <span className="status priority-high">Nothing on file</span>,
};

function Chip({ label, v, title }) {
  return (
    <span className="chip" title={title}><span className="small-muted">{label}</span> <b>{money(v)}</b></span>
  );
}

// The one filter box the bills register and the category / month summary both
// carry: category, vendor, search, GST on the bill, status and payment mode,
// with every money figure beside them.
function BillFilters({
  f, setF, o, totals, onNew,
}) {
  const restCats = o.categories.filter((c) => !o.fitCategories.includes(c));
  const restVendors = o.vendors.filter((v) => !o.fitVendors.includes(v));
  const on = f.category !== 'All' || f.vendor !== 'All' || f.status !== 'All' || f.mode !== 'All'
    || f.gst !== 'All' || f.month !== 'All' || !!f.noGstin || !!f.q.trim();
  const optionList = (fit, rest, label, restLabel) => (
    <>
      <option value="All">{label}</option>
      {fit.map((c) => <option key={c} value={c}>{c}</option>)}
      {rest.length > 0 && (
        <optgroup label={restLabel}>
          {rest.map((c) => <option key={c} value={c}>{c}</option>)}
        </optgroup>
      )}
    </>
  );
  return (
    <>
      <div className="filter-row">
        <label className="field"><span>Category · {o.categories.length}{restCats.length ? ` · ${o.fitCategories.length} fit` : ''}</span>
          <Combo value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {optionList(o.fitCategories, restCats, `All · ${o.categories.length}`,
              `Other categories · ${restCats.length} — picking one lets go of the vendor`)}
          </Combo>
        </label>
        <label className="field" style={{ maxWidth: 230 }}><span>Vendor · {o.vendors.length}{restVendors.length ? ` · ${o.fitVendors.length} fit` : ''}</span>
          <Combo value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })}>
            {optionList(o.fitVendors, restVendors, `All · ${o.vendors.length}`,
              `Other vendors · ${restVendors.length} — picking one lets go of the category`)}
          </Combo>
        </label>
        <label className="field" style={{ minWidth: 170, flex: 1 }}><span>Search</span>
          <input value={f.q} placeholder="Description, bill no, remarks…" onChange={(e) => setF({ ...f, q: e.target.value })} />
        </label>
        <label className="field"><span>GST on the bill</span>
          <Combo value={f.gst} onChange={(e) => setF({ ...f, gst: e.target.value })}>
            <option>All</option>{o.gst.map((x) => <option key={x}>{x}</option>)}
          </Combo>
        </label>
        <label className="field"><span>Status</span>
          <Combo value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            <option>All</option>{o.statuses.map((x) => <option key={x}>{x}</option>)}
          </Combo>
        </label>
        <label className="field"><span>Payment mode</span>
          <Combo value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>
            <option>All</option>{o.modes.map((x) => <option key={x}>{x}</option>)}
          </Combo>
        </label>
      </div>
      <div className="filter-row" style={{ marginTop: -6 }}>
        <Chip label="Before GST" v={totals.base} title="Bill amount before GST" />
        <Chip label="GST paid" v={totals.gst} title="Input credit — GST we paid our vendors" />
        <Chip label="After GST" v={totals.afterGst} title="Bill amount including GST" />
        <Chip label="TDS we cut" v={totals.tds} title="TDS we held back from the vendor and paid to Government on their behalf. This is not the TDS category — a challan paid to Government is an ordinary bill under that category." />
        <Chip label="Total amount" v={totals.net} title="What we actually pay after TDS" />
        <Chip label="Pending" v={totals.pendingValue} title="Bills still to be paid" />
        {f.noGstin && (
          <span className="chip">Only bills with no vendor GSTIN
            <button className="link-btn" style={{ marginLeft: 6 }} onClick={() => setF({ ...f, noGstin: false })}>✕</button>
          </span>
        )}
        {on && <button className="btn btn-sm" onClick={() => setF(BLANK_FILTERS)}>Reset all</button>}
        {onNew && <button className="btn btn-primary btn-sm" onClick={onNew}>＋ New expense</button>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Add / edit an expense — the accounting application's own form, field for
// field. GST and TDS are entered as a rate on this bill and the money follows;
// nothing is ever assumed.
// ---------------------------------------------------------------------------
function ExpenseForm({
  form, setForm, options, editing, onSubmit, onCancel,
}) {
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const base = Number(form.baseAmount) || 0;
  const gst = form.gstApplicable === 'Yes' ? Math.round(base * (Number(form.gstRatePct) || 0)) / 100 : 0;
  const tds = form.tdsApplicable === 'Yes' ? Math.round(base * (Number(form.tdsRatePct) || 0)) / 100 : 0;
  const net = Math.round((base + gst - tds) * 100) / 100;
  const months = Number(form.monthsCovered) || { Monthly: 1, Quarterly: 3, '3 Times a Year': 4, 'Half-Yearly': 6, Yearly: 12, 'One-Time': 12 }[form.frequency] || 1;

  return (
    <form className="card section" onSubmit={onSubmit} style={{ marginTop: 16 }}>
      <h3>{editing ? 'Expense' : 'New expense'}</h3>
      <div className="small-muted" style={{ marginBottom: 10 }}>
        Yellow fields are yours to fill — GST, TDS and the monthly split calculate
      </div>
      <div className="grid-3">
        <label className="field"><span>Category *</span>
          <Combo value={form.entryKind} onChange={set('entryKind')}>
            <option value="expense">Expense — money the office spent</option>
            <option value="hand">Hand loan or owner&apos;s money — not an expense</option>
          </Combo>
          <div className="small-muted">A loan is not a cost — it stays out of profit and GST.</div>
        </label>
        <label className="field"><span>Expense date *</span><input type="date" required value={form.expenseDate} onChange={set('expenseDate')} /></label>
        <label className="field"><span>Due date</span><input type="date" value={form.dueDate} onChange={set('dueDate')} />
          <div className="small-muted">Where a pending bill shows on the calendar.</div>
        </label>
        <label className="field"><span>Expense account *</span>
          <input required list="off-cats" value={form.category} onChange={set('category')} />
          <datalist id="off-cats">{options.categories.map((c) => <option key={c} value={c} />)}</datalist>
          <div className="small-muted">Not on the list? Type it and it is kept for next time.</div>
        </label>
        <label className="field"><span>Payment frequency</span>
          <Combo value={form.frequency} onChange={set('frequency')}>{options.frequencies.map((x) => <option key={x}>{x}</option>)}</Combo>
        </label>
        <label className="field"><span>Custom months covered</span>
          <input type="number" min="1" placeholder="leave blank = by frequency" value={form.monthsCovered} onChange={set('monthsCovered')} />
        </label>
        <label className="field" style={{ gridColumn: '1 / -1' }}><span>Reason / description</span>
          <input value={form.description} onChange={set('description')} />
        </label>
        <label className="field"><span>Bill amount — base (₹) *</span>
          <input required type="number" step="0.01" value={form.baseAmount} onChange={set('baseAmount')} />
        </label>
        <label className="field"><span>GST applicable</span>
          <Combo value={form.gstApplicable} onChange={set('gstApplicable')}><option>No</option><option>Yes</option></Combo>
        </label>
        <label className="field"><span>GST rate</span>
          <Combo value={form.gstRatePct} onChange={set('gstRatePct')} disabled={form.gstApplicable !== 'Yes'}>
            {options.gstRates.map((r) => <option key={r} value={r}>{r}%</option>)}
          </Combo>
        </label>
        <label className="field"><span>TDS applicable</span>
          <Combo value={form.tdsApplicable} onChange={set('tdsApplicable')}><option>No</option><option>Yes</option></Combo>
        </label>
        <label className="field"><span>TDS rate</span>
          <Combo value={form.tdsRatePct} onChange={set('tdsRatePct')} disabled={form.tdsApplicable !== 'Yes'}>
            {options.tdsRates.map((r) => <option key={r} value={r}>{r}%</option>)}
          </Combo>
        </label>
        <label className="field"><span>Paid to / vendor</span><input value={form.vendor} onChange={set('vendor')} /></label>
        <label className="field"><span>Vendor GSTIN</span><input value={form.vendorGstin} onChange={set('vendorGstin')} placeholder="15 characters" /></label>
        <label className="field"><span>Type of supply</span>
          <Combo value={form.supplyType} onChange={set('supplyType')}>{options.supplyTypes.map((x) => <option key={x}>{x}</option>)}</Combo>
        </label>
        <label className="field"><span>GST treatment</span>
          <Combo value={form.gstTreatment} onChange={set('gstTreatment')}>{options.gstTreatments.map((x) => <option key={x}>{x}</option>)}</Combo>
        </label>
        <label className="field"><span>Bill / invoice no</span><input value={form.billNumber} onChange={set('billNumber')} /></label>
        <label className="field"><span>Location</span><input value={form.location} onChange={set('location')} /></label>
        <label className="field"><span>Payment status</span>
          <Combo value={form.paidStatus} onChange={set('paidStatus')}><option>Paid</option><option>Pending</option></Combo>
        </label>
        <label className="field"><span>Payment mode</span>
          <Combo value={form.paymentMode} onChange={set('paymentMode')}>{options.modes.map((x) => <option key={x}>{x}</option>)}</Combo>
        </label>
        <label className="field"><span>Approved by</span><input value={form.approvedBy} onChange={set('approvedBy')} /></label>
        <label className="field" style={{ gridColumn: '1 / -1' }}><span>Remarks</span><input value={form.remarks} onChange={set('remarks')} /></label>
      </div>
      <div className="notice" style={{ marginTop: 10 }}>
        <span>
          Before GST <b>{money2(base)}</b> · GST <b>{money2(gst)}</b> · after GST <b>{money2(base + gst)}</b> ·
          TDS <b>{money2(tds)}</b> · net paid <b>{money2(net)}</b> · spread over <b>{months}</b> month(s) at <b>{money2(net / months)}</b> each.
        </span>
      </div>
      <div className="qa-row" style={{ marginTop: 10 }}>
        <button className="btn btn-primary btn-sm" type="submit">{editing ? 'Save expense' : 'Add expense'}</button>
        <button className="btn btn-sm" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// 🗓 Calendar
// ---------------------------------------------------------------------------
function Calendar() {
  const now = new Date();
  const [mk, setMk] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
  const [show, setShow] = useState('all');
  const [sel, setSel] = useState(null);
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get('/office-expenses/calendar', { params: { month: mk } }).then((r) => setData(r.data));
  }, [mk]);

  const step = (n) => {
    const [y, m] = mk.split('-').map(Number);
    const d = new Date(y, m - 1 + n, 1);
    setMk(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    setSel(null);
  };

  const byDay = useMemo(() => {
    const m = new Map();
    (data?.days || []).forEach((d) => m.set(d.date, d));
    return m;
  }, [data]);

  if (!data) return <div className="small-muted">Loading…</div>;
  const [y, m] = mk.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const lead = (first.getDay() + 6) % 7; // weeks start on Monday
  const nDays = new Date(y, m, 0).getDate();
  const iso = (d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dueOn = new Map();
  data.statutory.forEach((c) => { dueOn.set(c.d, [...(dueOn.get(c.d) || []), c]); });
  const t = data.totals;
  const selData = sel ? byDay.get(sel) : null;
  const selStat = sel ? (dueOn.get(Number(sel.slice(8, 10))) || []) : [];

  const cells = [];
  for (let i = 0; i < lead; i += 1) cells.push(<div key={`x${i}`} className="cal-cell cal-empty" />);
  for (let d = 1; d <= nDays; d += 1) {
    const k = iso(d);
    const o = byDay.get(k) || {
      out: 0, in: 0, due: 0, paidN: 0, dueN: 0, inN: 0, items: [],
    };
    const dow = new Date(y, m - 1, d).getDay();
    const st = dueOn.get(d) || [];
    cells.push(
      <div
        key={k}
        className={`cal-cell${k === data.today ? ' cal-today' : ''}${k === sel ? ' cal-sel' : ''}${(dow === 0 || dow === 6) ? ' cal-wknd' : ''}`}
        onClick={() => setSel(sel === k ? null : k)}
        title={o.items.length ? `${o.items.length} entr${o.items.length === 1 ? 'y' : 'ies'}` : 'Nothing on this day'}
      >
        <div className="cal-d">{d}{k === data.today && <span className="cal-now">today</span>}</div>
        {(show === 'all' || show === 'out') && o.out > 0.5 && <div className="cal-amt cal-out">− {money(o.out)}<span>{o.paidN}</span></div>}
        {(show === 'all' || show === 'due') && o.due > 0.5 && <div className="cal-amt cal-due">due {money(o.due)}<span>{o.dueN}</span></div>}
        {(show === 'all' || show === 'in') && o.in > 0.5 && <div className="cal-amt cal-in">+ {money(o.in)}<span>{o.inN}</span></div>}
        {st.length > 0 && <div className="cal-stat">{st.map((c) => c.t).join(' · ')}</div>}
      </div>,
    );
  }
  while (cells.length % 7) cells.push(<div key={`z${cells.length}`} className="cal-cell cal-empty" />);

  return (
    <>
      <div className="statbar">
        <Stat n={money(t.out)} l="Paid out this month" s={`${t.paidN} bill(s) actually paid`} />
        <Stat n={money(t.due)} l="Still to pay" s={t.dueN ? `${t.dueN} bill(s) on their due date` : 'nothing outstanding'} tone={t.due > 0.5 ? 'bad' : 'good'} />
        <Stat n={money(t.in)} l="Came in this month" s={`${t.inN} client receipt(s)`} tone="good" />
        <Stat n={signed(t.net)} l="Net movement" s="Receipts less what went out" tone={t.net >= 0 ? 'good' : 'bad'} />
      </div>

      <div className="filter-row" style={{ alignItems: 'center' }}>
        <button className="btn btn-sm" onClick={() => step(-1)}>‹ Previous</button>
        <b style={{ fontSize: 15, minWidth: 150, textAlign: 'center' }}>{MON[m - 1]} {y}</b>
        <button className="btn btn-sm" onClick={() => step(1)}>Next ›</button>
        <button className="btn btn-sm" onClick={() => { setMk(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`); setSel(today()); }}>Today</button>
        <span style={{ flex: 1 }} />
        {[['all', 'Everything'], ['out', 'Money out'], ['due', 'Still to pay'], ['in', 'Money in']].map(([k, l]) => (
          <button key={k} className={`btn btn-sm${show === k ? ' btn-primary' : ''}`} onClick={() => setShow(k)}>{l}</button>
        ))}
      </div>

      <div className="card section">
        <div className="cal-head">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d}>{d}</div>)}</div>
        <div className="cal-grid">{cells}</div>
        <div className="small-muted" style={{ marginTop: 10, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <span><b style={{ color: 'var(--red)' }}>− red</b> money that left the account</span>
          <span><b style={{ color: 'var(--amber)' }}>due</b> a bill still to be paid, shown on its due date</span>
          <span><b style={{ color: 'var(--teal)' }}>+ green</b> a client receipt</span>
          <span><b>grey line</b> a statutory date</span>
        </div>
      </div>

      {sel ? (
        <div className="card section">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <h3 style={{ flex: 1 }}>{fmtD(sel)}</h3>
            <span className="small-muted" style={{ flex: 2 }}>
              {selData?.items?.length ? `${selData.items.length} entr${selData.items.length === 1 ? 'y' : 'ies'} on this day` : 'Nothing recorded on this day'}
            </span>
            <button className="btn btn-sm" onClick={() => setSel(null)}>Close</button>
          </div>
          {selStat.map((c) => (
            <div key={c.t} className="notice amber" style={{ marginTop: 8 }}>
              <span><b>{c.t}</b> — {c.s}. Due dates move when the day is a holiday, and quarterly filers run to a different calendar — check the portal before you rely on this.</span>
            </div>
          ))}
          {selData?.items?.length > 0 && (
            <div className="tbl-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>What</th><th>Details</th><th>Kind</th><th className="num">GST on it</th><th className="num">Amount</th></tr></thead>
                <tbody>
                  {selData.items.map((i, ix) => (
                    <tr key={`${i.id}-${ix}`}>
                      <td><b>{i.t}</b></td>
                      <td className="small-muted">{String(i.sub || '—').slice(0, 60)}</td>
                      <td>
                        {i.kind === 'in' ? <span className="status priority-low">Money in</span>
                          : i.kind === 'due' ? <span className={`status ${i.overdue ? 'priority-high' : 'priority-medium'}`}>{i.overdue ? 'Overdue' : 'Still to pay'}</span>
                            : <span className="status">Money out</span>}
                      </td>
                      <td className="num">{(i.gst || 0) > 0.5 ? money(i.gst) : '—'}</td>
                      <td className="num"><b style={{ color: i.kind === 'in' ? 'var(--teal)' : 'var(--red)' }}>{i.kind === 'in' ? '+' : '−'} {money(i.amount)}</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="notice"><span>Click any day to see what happened on it.</span></div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// 📎 Proofs & bill files
// ---------------------------------------------------------------------------
function Proofs({
  scope, preset, onError, onClearScope,
}) {
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState(preset || 'all');
  const [q, setQ] = useState('');
  const [fixOpen, setFixOpen] = useState(null);

  useEffect(() => { setFilter(preset || 'all'); }, [preset]);

  const load = useCallback(() => {
    api.get('/office-expenses/proofs', {
      params: {
        filter, q, scopeMode: scope?.mode || undefined, scopeKey: scope?.key || undefined,
      },
    }).then((r) => setData(r.data));
  }, [filter, q, scope]);
  useEffect(load, [load]);

  async function run(fn) {
    onError('');
    try { await fn(); load(); } catch (e) { onError(e.response?.data?.error || 'That did not work.'); }
  }

  // The file itself is not uploaded anywhere yet — see the note under the
  // table. What is recorded is the file the payment is proved by.
  const attach = (r) => {
    const name = window.prompt(`Name of the bill file on ${r.category} — ${r.vendor || 'no vendor'} (${money(r.net)})`, r.proofName || '');
    if (!name) return;
    run(() => api.post(`/office-expenses/${r.id}/proof`, { proofName: name }));
  };

  if (!data) return <div className="small-muted">Loading…</div>;
  const c = data.counts;
  const fix = data.fixes.find((x) => x.key === fixOpen);

  return (
    <>
      <div className="statbar">
        <Stat n={c.all} l="Office payments" s="Every bill and payment on file" />
        <Stat n={c.proved} l="Payment proved" s="A bill attached, or the statement line it came off" tone={c.proved ? 'good' : undefined} />
        <Stat
          n={c.gstdue}
          l="Vendor tax invoice still needed"
          s={c.gstdue ? `${money(data.gstWaiting)} of input GST waiting on it` : 'Nothing outstanding'}
          tone={c.gstdue ? 'bad' : 'good'}
        />
        <Stat
          n={c.none}
          l="Nothing on file"
          s={data.gstAtRisk > 0.5 ? `${money(data.gstAtRisk)} of input GST rides on these` : 'No GST at stake'}
          tone={c.none ? 'bad' : 'good'}
        />
      </div>

      <div className="filter-row">
        <label className="field" style={{ minWidth: 240, flex: 1 }}><span>Search the bills</span>
          <input value={q} placeholder="Category, vendor, bill no, description…" onChange={(e) => setQ(e.target.value)} />
        </label>
        <span style={{ flex: 1 }} />
        {data.filters.map((x) => (
          <button key={x.key} className={`btn btn-sm${filter === x.key ? ' btn-primary' : ''}`} onClick={() => setFilter(x.key)}>{x.label} {x.n}</button>
        ))}
      </div>

      {data.scope && (
        <div className="notice">
          <span>
            Showing <b>{data.scope.label}</b> only — {c.all} payment(s).
            <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={onClearScope}>Show every office payment</button>
          </span>
        </div>
      )}

      {/* the same payment filed twice — usually because the tracker already had
          it and the bank line was filed on top */}
      {data.dupeTotals.groups === 0 ? (
        <div className="notice" style={{ margin: '12px 0' }}>
          <span>
            <b>No payment appears twice.</b> No two office bills share a category, an amount and a date within {data.dupeTotals.days} days of each other.
          </span>
        </div>
      ) : (
        <div className="card section" style={{ borderLeft: '4px solid var(--red)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <h3 style={{ flex: 1 }}>{data.dupeTotals.groups} payment(s) look filed more than once</h3>
            <span className="small-muted">
              {data.dupeTotals.copies} extra cop{data.dupeTotals.copies === 1 ? 'y' : 'ies'} · {money(data.dupeTotals.money)} of spend and {money(data.dupeTotals.gst)} of input GST counted twice
            </span>
          </div>
          <div className="tbl-wrap" style={{ maxHeight: '52vh', marginTop: 10 }}>
            <table>
              <thead><tr><th>Bill</th><th>Date</th><th>Paid to</th><th>Bill no</th><th className="num">Amount</th><th>What is on file</th><th>Keep or remove</th></tr></thead>
              <tbody>
                {data.dupes.map((c) => (
                  <Fragment key={c.key}>
                    <tr style={{ background: 'var(--line-soft)' }}>
                      <td colSpan="4"><b>{c.key}</b> — filed {c.rows.length} times</td>
                      <td className="num"><b style={{ color: 'var(--red)' }}>+{money(c.extra)}</b></td>
                      <td className="small-muted">{c.extraGst > 0.5 ? `${money(c.extraGst)} of GST doubled` : 'no GST on it'}</td>
                      <td />
                    </tr>
                    {c.rows.map((r) => (
                      <tr key={r.id}>
                        <td style={{ paddingLeft: 22 }}>
                          <span className={`status ${r.id === c.keep ? 'priority-low' : 'priority-high'}`}>{r.id === c.keep ? 'keep' : 'extra'}</span>{' '}
                          {String(r.description || r.category || '—').slice(0, 44)}
                        </td>
                        <td className="small-muted">{fmtD(r.expenseDate)}</td>
                        <td>{r.vendor || '—'}</td>
                        <td className="small-muted">{r.billNumber || '—'}</td>
                        <td className="num">{money(r.net)}</td>
                        <td>{PROOF_LABEL[r.proofKind]}</td>
                        <td>
                          <button className="btn btn-sm btn-danger" onClick={() => run(() => api.delete(`/office-expenses/${r.id}`))}>Remove this one</button>
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <div className="notice" style={{ marginTop: 10 }}>
            <span>
              Two bills with the <b>same category, the same amount and dates within {data.dupeTotals.days} days</b> are almost always the
              same payment entered twice — usually because the tracker already had it and the bank line was filed on top.
              {' '}<b>Keep</b> is suggested on the copy with the strongest evidence: a bill file first, then a bank statement line.
              Nothing is removed until you press it, and every removal is written to the audit log.
            </span>
          </div>
        </div>
      )}

      {/* every fixable gap on these bills, counted, with one press to each list */}
      {data.fixes.length === 0 ? (
        <div className="notice" style={{ margin: '12px 0' }}>
          <span><b>Nothing to fix.</b> Every payment here has something behind it, and every GST claim has a vendor, a GSTIN and a bill number.</span>
        </div>
      ) : (
        <div className="card section" style={{ borderLeft: '4px solid var(--red)' }}>
          <h3>{data.fixes.length} thing(s) to fix on these bills</h3>
          <div className="small-muted" style={{ marginBottom: 8 }}>Each one is a real gap in the GST record — press a line to see the bills behind it</div>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>What is wrong</th><th className="num">Bills</th><th className="num">GST at stake</th><th>Why it matters</th><th /></tr></thead>
              <tbody>
                {data.fixes.map((i) => (
                  <tr key={i.key}>
                    <td><span className={`status ${i.sev === 'bad' ? 'priority-high' : 'priority-medium'}`}>{i.t}</span></td>
                    <td className="num"><b>{i.n}</b></td>
                    <td className="num">{i.gst > 0.5 ? money(i.gst) : '—'}</td>
                    <td className="small-muted">{i.why}</td>
                    <td>
                      <button className="btn btn-sm" onClick={() => (i.filter ? setFilter(i.filter) : setFixOpen(i.key))}>Show these {i.n}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {fix && (
        <div className="card section">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <h3 style={{ flex: 1 }}>{fix.t}</h3>
            <span className="small-muted">{fix.n} bill(s) · {money(fix.gst)} of GST on them</span>
            <button className="btn btn-sm" onClick={() => setFixOpen(null)}>Close</button>
          </div>
          <div className="notice amber" style={{ margin: '8px 0' }}><span>{fix.hint}</span></div>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Date</th><th>Category</th><th>Paid to</th><th>Bill no</th><th>Vendor GSTIN</th><th className="num">Amount</th><th className="num">GST</th></tr></thead>
              <tbody>
                {(fix.rows || []).map((r) => (
                  <tr key={r.id}>
                    <td className="small-muted">{fmtD(r.expenseDate)}</td>
                    <td><b>{r.category || '—'}</b></td>
                    <td>{r.vendor || <span className="status priority-high">missing</span>}</td>
                    <td className="small-muted">{r.billNumber || <span className="status priority-high">missing</span>}</td>
                    <td className="small-muted">{String(r.vendorGstin || '').trim() || <span className="status priority-high">missing</span>}</td>
                    <td className="num">{money(r.net)}</td>
                    <td className="num">{money(r.gst)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {c.none > 0 && (
        <div className="notice amber" style={{ margin: '12px 0' }}>
          <span>
            <b>{c.none} payment(s) have nothing behind them at all.</b> No bill, no statement line —
            if the GST officer asks, there is nothing to show{data.gstAtRisk > 0.5 ? `, and ${money(data.gstAtRisk)} of input credit sits on them` : ''}.
            {' '}Press <b>Attach</b> on a line to put the bill on it.
          </span>
        </div>
      )}

      <div className="card section">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <h3 style={{ flex: 1 }}>{data.rows.length} of {c.all} office payment(s)</h3>
          <span className="small-muted" style={{ flex: 2 }}>
            Newest first — click <b>View</b> to open what is on file, <b>Edit</b> to open the expense itself
          </span>
          <button className="btn btn-sm" onClick={() => printRows('Bill Proofs', data.rows.map((r) => ({
            Date: r.expenseDate, Category: r.category, 'Paid to': r.vendor || '', 'Bill no': r.billNumber || '',
            Amount: r.net, GST: r.gst, 'What is on file': r.proofKind,
          })))}>🖨 Print</button>
        </div>
        <div className="tbl-wrap" style={{ maxHeight: '66vh', marginTop: 10 }}>
          <table>
            <thead>
              <tr>
                <th>Date</th><th>Category</th><th>Paid to</th><th>Bill no</th>
                <th className="num">Amount</th><th className="num">GST on it</th><th>What is on file</th><th>Open it</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td className="small-muted">{fmtD(r.expenseDate)}</td>
                  <td><b>{r.category || '—'}</b>{r.description && <div className="small-muted">{String(r.description).slice(0, 54)}</div>}</td>
                  <td>{r.vendor || '—'}</td>
                  <td className="small-muted">{r.billNumber || '—'}</td>
                  <td className="num"><b>{money(r.net)}</b></td>
                  <td className="num">{r.gst > 0.5 ? money(r.gst) : '—'}</td>
                  <td>
                    {r.proofKind === 'file' && <span className="status priority-low">Bill attached</span>}
                    {r.proofKind === 'bank' && <span className="status priority-low">Bank statement</span>}
                    {r.proofKind === 'gstdue' && (
                      <>
                        <span className="status priority-low">Bank statement</span>
                        <div className="small-muted">tax invoice still needed for the GST</div>
                      </>
                    )}
                    {r.proofKind === 'none' && <span className="status priority-high">Nothing on file</span>}
                    {r.proofKind === 'file' && r.proofName && <div className="small-muted">{String(r.proofName).slice(0, 40)}</div>}
                  </td>
                  <td>
                    <div className="qa-row">
                      <button className="btn btn-sm" onClick={() => attach(r)}>{r.proofKind === 'file' ? 'Replace' : '📎 Attach'}</button>
                      {r.proofKind === 'file' && (
                        <button className="btn btn-sm btn-danger" onClick={() => run(() => api.delete(`/office-expenses/${r.id}/proof`))}>Remove</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {data.rows.length === 0 && <tr><td colSpan="8" className="empty-mini">No bill matches that.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="notice" style={{ marginTop: 10 }}>
          <span>
            <b>Bill attached</b> — a file you or the desk uploaded, opens in the viewer.
            {' '}<b>Bank statement</b> — the payment came off an imported statement line; that line is the proof of payment and opens the same way.
            {' '}A statement-line payment that <i>also carries GST</i> is still proved — but the input credit on it can only be claimed
            against the vendor&apos;s own tax invoice, so that one line says <b>tax invoice still needed</b> underneath. It is not counted as missing.
            {' '}<b>Nothing on file</b> — neither a file nor a statement line.
          </span>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// GST position
// ---------------------------------------------------------------------------
function Gst({ period }) {
  const [data, setData] = useState(null);
  const [sel, setSel] = useState('All');
  useEffect(() => { api.get('/office-expenses/gst', { params: { period } }).then((r) => setData(r.data)); }, [period]);
  useEffect(() => { setSel('All'); }, [period]);
  if (!data) return <div className="small-muted">Loading…</div>;
  const t = data.totals;
  const one = sel !== 'All' ? data.rows.find((r) => r.month === sel) : null;
  const view = one || t;
  const pay = view.net >= 0;
  const outBase = one ? one.outBase : t.outBase;
  const inBase = one ? one.inBase : t.inBase;
  const ratePct = outBase > 0 ? Math.round((view.output / outBase) * 1000) / 10 : 0;

  return (
    <>
      <div className="filter-row">
        <label className="field" style={{ minWidth: 240 }}><span>Focus one month</span>
          <Combo value={sel} onChange={(e) => setSel(e.target.value)}>
            <option value="All">All months in this period ({data.rows.length})</option>
            {data.rows.slice().reverse().map((r) => <option key={r.month} value={r.month}>{r.label}</option>)}
          </Combo>
        </label>
        <span style={{ flex: 1 }} />
        <button className="btn btn-sm" onClick={() => printRows('GST by vendor', data.vendors.map((v) => ({
          Vendor: v.key, Entries: v.n, 'Bill amount': v.base, 'GST paid': v.gst, 'Bill no. on file': `${v.bills}/${v.n}`,
        })))}>🖨 Vendor</button>
        <button className="btn btn-sm" onClick={() => printRows('GST by month', data.rows.map((r) => ({
          Month: r.label, Invoices: r.nOut, 'GST charged': r.output, 'Purchase entries with GST': r.nIn, 'GST paid': r.input, 'Net to Government': r.net,
        })))}>🖨 Month</button>
      </div>

      <div className="card section" style={{ borderTop: `4px solid ${pay ? 'var(--red)' : 'var(--teal)'}` }}>
        <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ minWidth: 280 }}>
            <div className="eyebrow">{pay ? 'GST payable to Government' : 'Credit carried forward'} · {one ? one.label : `${data.rows.length} month(s)`}</div>
            <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: '-.02em', color: pay ? 'var(--red)' : 'var(--teal)', marginTop: 4 }}>
              {money(Math.abs(view.net))}
            </div>
            <div className="small-muted" style={{ marginTop: 4 }}>
              {money(view.output)} charged to clients − {money(view.input)} paid to vendors
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 300 }}>
            <div className="kv"><span className="k">GST charged on invoices <span className="small-muted">(output tax)</span></span><span>{money2(view.output)}</span></div>
            <div className="kv"><span className="k">GST paid to vendors <span className="small-muted">(input credit)</span></span><span style={{ color: 'var(--teal)' }}>({money2(view.input)})</span></div>
            <div className="kv" style={{ fontWeight: 700 }}><span className="k">{pay ? 'Net payable to Government' : 'Net credit'}</span><span>{money2(Math.abs(view.net))}</span></div>
            {one && <div className="kv"><span className="k">All {data.rows.length} months together</span><span>{money2(Math.abs(t.net))} {t.net >= 0 ? 'payable' : 'credit'}</span></div>}
          </div>
        </div>
        <div className="notice" style={{ marginTop: 12 }}>
          <span>Input credit works only when the vendor has actually filed — the amount below must match your GSTR-2B before you claim it.</span>
        </div>
      </div>

      {data.missing.cats.length > 0 && (
        <div className="notice amber">
          <span>
            <b>{data.missing.n} expense entr{data.missing.n === 1 ? 'y' : 'ies'} worth {money(data.missing.base)} have no GST recorded.</b>
            {' '}Salary, PF, ESI, PT and TDS carry no GST — those are excluded. The rest below probably do have GST on the bill,
            and every rupee not entered is input credit you are paying for and not claiming.
            <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {data.missing.cats.map((c) => <span key={c.key} className="chip">{c.key} · {c.n} · {money(c.base)}</span>)}
            </div>
          </span>
        </div>
      )}

      <div className="grid-2">
        <div className="card section">
          <h3>Month by month</h3>
          <div className="small-muted" style={{ marginBottom: 8 }}>GST charged against GST paid</div>
          <Bars
            rows={data.rows.map((r) => ({ label: r.label, a: r.output, b: r.input }))}
            aName="GST charged to clients"
            bName="GST paid to vendors"
          />
        </div>
        <div className="card section">
          <h3>Filing position</h3>
          <div className="small-muted" style={{ marginBottom: 8 }}>{one ? one.label : 'All months'}</div>
          <div className="kv"><span className="k">Taxable value billed to clients</span><span>{money2(outBase)}</span></div>
          {/* The effective rate is what the invoices actually carry — it is
              computed from them, never assumed to be 18%. */}
          <div className="kv"><span className="k">Output tax @ {ratePct}% effective</span><span>{money2(view.output)}</span></div>
          <div className="kv"><span className="k">Purchases with GST (taxable value)</span><span>{money2(inBase)}</span></div>
          <div className="kv"><span className="k">Input tax credit</span><span>{money2(view.input)}</span></div>
          <div className="kv" style={{ fontWeight: 700 }}><span className="k">Cash to pay</span><span>{money2(Math.max(0, view.net))}</span></div>
          <div className="kv"><span className="k">Vendor bill numbers on file</span><span>{data.filing.billNumbersOnFile} of {data.filing.billsWithGst}</span></div>
          <div className="kv"><span className="k">Vendor names on file</span><span>{data.filing.vendorNamesOnFile} of {data.filing.billsWithGst}</span></div>
        </div>
      </div>

      <div className="card section">
        <h3>GST paid to vendors</h3>
        <div className="small-muted" style={{ marginBottom: 8 }}>
          Input credit by vendor — {data.vendors.filter((v) => v.gst > 0).length} vendor(s) with GST · greyed rows carry no GST
        </div>
        <div className="tbl-wrap" style={{ maxHeight: '60vh' }}>
          <table>
            <thead>
              <tr>
                <th>Vendor</th><th>What for</th><th className="num">Entries</th><th className="num">Bill amount</th>
                <th className="num">Rate</th><th className="num">GST paid</th><th className="num">Bill no. on file</th><th className="num">Share</th>
              </tr>
            </thead>
            <tbody>
              {data.vendors.map((v) => (
                <tr key={v.key} style={v.gst ? undefined : { color: 'var(--ink-soft)' }}>
                  <td><b>{v.key}</b>{!v.named && v.gst > 0 && <> <span className="status priority-medium">not entered</span></>}</td>
                  <td className="small-muted">{v.cats.slice(0, 4).join(', ')}{v.cats.length > 4 ? ` +${v.cats.length - 4}` : ''}</td>
                  <td className="num">{v.n}</td>
                  <td className="num">{money(v.base)}</td>
                  <td className="num">{v.rates.length ? v.rates.map((r) => `${r}%`).join(', ') : '—'}</td>
                  <td className="num"><b>{v.gst ? money(v.gst) : '—'}</b></td>
                  <td className="num">{v.bills}/{v.n}</td>
                  <td className="num">{t.input ? Math.round((v.gst / t.input) * 100) : 0}%</td>
                </tr>
              ))}
              {data.vendors.length === 0 && <tr><td colSpan="8" className="empty-mini">No expenses yet.</td></tr>}
            </tbody>
            <tfoot>
              <tr>
                <td>TOTAL</td><td /><td className="num">{data.vendors.reduce((s, v) => s + v.n, 0)}</td>
                <td className="num">{money(data.vendors.reduce((s, v) => s + v.base, 0))}</td><td />
                <td className="num">{money(t.input)}</td>
                <td className="num">{data.vendors.reduce((s, v) => s + v.bills, 0)}/{data.vendors.reduce((s, v) => s + v.n, 0)}</td><td />
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="small-muted" style={{ marginTop: 8 }}>
          A vendor with no name or no bill number cannot be matched in GSTR-2B. Open the entry on Office Expenses and fill &quot;Paid to / vendor&quot; and &quot;Bill / invoice no&quot;.
        </div>
      </div>

      <div className="card section">
        <h3>Month-wise GST statement</h3>
        <div className="small-muted" style={{ marginBottom: 8 }}>Click a month to focus the top</div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Month</th><th className="num">Invoices</th><th className="num">GST charged</th>
                <th className="num">Purchase entries with GST</th><th className="num">GST paid</th>
                <th className="num">Net to Government</th><th>Position</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.month} className="row-link" onClick={() => setSel(sel === r.month ? 'All' : r.month)}>
                  <td><b>{r.label}</b></td>
                  <td className="num">{r.nOut || '—'}</td>
                  <td className="num">{r.output ? money(r.output) : '—'}</td>
                  <td className="num">{r.nIn || '—'}</td>
                  <td className="num">{r.input ? money(r.input) : '—'}</td>
                  <td className="num" style={{ color: r.net >= 0 ? 'var(--red)' : 'var(--teal)' }}><b>{money(Math.abs(r.net))}</b></td>
                  <td><span className={`status ${r.net >= 0 ? 'priority-high' : 'priority-low'}`}>{r.net >= 0 ? 'Pay' : 'Credit'}</span></td>
                </tr>
              ))}
              {data.rows.length === 0 && <tr><td colSpan="7" className="empty-mini">No data.</td></tr>}
            </tbody>
            <tfoot>
              <tr>
                <td>TOTAL</td><td className="num">{data.rows.reduce((s, r) => s + r.nOut, 0)}</td>
                <td className="num">{money(t.output)}</td>
                <td className="num">{data.rows.reduce((s, r) => s + r.nIn, 0)}</td>
                <td className="num">{money(t.input)}</td>
                <td className="num">{money(Math.abs(t.net))}</td>
                <td><span className={`status ${t.net >= 0 ? 'priority-high' : 'priority-low'}`}>{t.net >= 0 ? 'Pay' : 'Credit'}</span></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="card section">
        <h3>Every purchase with GST</h3>
        <div className="small-muted" style={{ marginBottom: 8 }}>
          {data.purchases.length} entr{data.purchases.length === 1 ? 'y' : 'ies'}{one ? ` · ${one.label}` : ''}
        </div>
        <div className="tbl-wrap" style={{ maxHeight: '55vh' }}>
          <table>
            <thead>
              <tr>
                <th>Date</th><th>Vendor</th><th>Category</th><th>Bill no.</th><th className="num">Taxable value</th>
                <th className="num">Rate</th><th className="num">GST paid</th><th className="num">Total</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.purchases.filter((r) => !one || r.month === sel).map((r) => (
                <tr key={r.id}>
                  <td>{fmtD(r.date)}</td>
                  <td>{r.vendor || <span className="status priority-medium">not entered</span>}</td>
                  <td>{r.category}</td>
                  <td>{r.bill || <span className="status priority-medium">—</span>}</td>
                  <td className="num">{money(r.base)}</td>
                  <td className="num">{r.rate}%</td>
                  <td className="num"><b>{money(r.gst)}</b></td>
                  <td className="num">{money(r.total)}</td>
                  <td><span className={`status ${r.paid ? 'priority-low' : 'priority-medium'}`}>{r.paid ? 'Paid' : 'Pending'}</span></td>
                </tr>
              ))}
              {data.purchases.filter((r) => !one || r.month === sel).length === 0
                && <tr><td colSpan="9" className="empty-mini">No purchases with GST in this period.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="notice">
        <span>
          GST is never income and never a cost. You collect it from clients, you pay it on purchases,
          and you hand over the difference. That is why the Profit &amp; Loss page ignores GST completely on both sides.
        </span>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Profit & Loss
// ---------------------------------------------------------------------------
function Pnl({ period }) {
  const [basis, setBasis] = useState('accrual');
  const [sel, setSel] = useState('All');
  const [data, setData] = useState(null);
  useEffect(() => { api.get('/office-expenses/pnl', { params: { period, basis } }).then((r) => setData(r.data)); }, [period, basis]);
  useEffect(() => { setSel('All'); }, [period]);
  if (!data) return <div className="small-muted">Loading…</div>;
  const t = data.totals;
  const mt = data.matchedTotals;
  const one = sel !== 'All' ? data.rows.find((r) => r.month === sel) : null;
  const view = one || t;
  const isProfit = view.pl >= 0;
  const profit = t.pl >= 0;
  const h = data.held;
  const topCli = data.topClients;
  const topCat = data.topCategories;

  return (
    <>
      <div className="filter-row">
        <label className="field"><span>Month</span>
          <Combo value={sel} onChange={(e) => setSel(e.target.value)}>
            <option value="All">All months ({data.rows.length})</option>
            {data.rows.slice().reverse().map((r) => <option key={r.month} value={r.month}>{r.label}</option>)}
          </Combo>
        </label>
        <label className="field" style={{ minWidth: 260 }}><span>Basis</span>
          <Combo value={basis} onChange={(e) => setBasis(e.target.value)}>
            <option value="accrual">Accrual — work done &amp; bills raised</option>
            <option value="cash">Cash — money in &amp; out of the bank</option>
          </Combo>
        </label>
        <label className="field" style={{ minWidth: 300, flex: 1 }}><span>What this means</span>
          <input
            disabled
            value={basis === 'accrual'
              ? 'Fee billed (GST excluded) minus office cost (GST excluded)'
              : 'Money received from clients minus money actually paid out'}
          />
        </label>
        <button className="btn btn-sm" onClick={() => printRows('Profit and Loss', data.rows.map((r) => ({
          Month: r.label, Joins: r.joins, Income: r.income, Entries: r.entries, Spend: r.spend, 'Profit / loss': r.pl, 'Running total': r.cum,
        })))}>🖨 Print</button>
      </div>

      <div className="card section" style={{ borderTop: `4px solid ${isProfit ? 'var(--teal)' : 'var(--red)'}` }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 26, alignItems: 'center' }}>
          <div>
            <div className="eyebrow">{basis === 'accrual' ? 'Business result' : 'Cash result'} · {one ? one.label : `${data.rows.length} month(s)`}</div>
            <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: '-.02em', color: isProfit ? 'var(--teal)' : 'var(--red)', marginTop: 4 }}>
              {isProfit ? 'PROFIT' : 'LOSS'} {money(Math.abs(view.pl))}
            </div>
            <div className="small-muted" style={{ marginTop: 4 }}>
              {money(view.income)} {basis === 'accrual' ? 'billed' : 'received'} − {money(view.spend)} {basis === 'accrual' ? 'office cost' : 'paid out'}
              {one ? ` · ${view.joins} join(s), ${view.entries} expense entr${view.entries === 1 ? 'y' : 'ies'}` : ` · all ${data.rows.length} month(s)`}
            </div>
            {one && one.noExp && (
              <div className="notice amber" style={{ marginTop: 10 }}>
                <span><b>No office expenses recorded for {one.label}</b> — this month shows billing only, so the figure is not a real result yet.</span>
              </div>
            )}
            {!one && mt.months > 0 && mt.months < data.rows.length && (
              <div className="notice amber" style={{ marginTop: 10 }}>
                <span>
                  <b>Compare like with like:</b> office expenses are only recorded from {monthName(mt.from)}. For {monthName(mt.from)}–{monthName(mt.to)},
                  where both sides have data, the result is{' '}
                  <b style={{ color: mt.pl >= 0 ? 'var(--teal)' : 'var(--red)' }}>{mt.pl >= 0 ? 'a profit of ' : 'a loss of '}{money(Math.abs(mt.pl))}</b>
                  {' '}({money(mt.income)} {basis === 'accrual' ? 'billed' : 'received'} − {money(mt.spend)}).
                </span>
              </div>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div className="kv"><span className="k">{basis === 'accrual' ? 'Fee billed (excl GST)' : 'Received from clients'}</span><span>{money(view.income)}</span></div>
            <div className="kv"><span className="k">{basis === 'accrual' ? 'Office expenses (excl GST)' : 'Paid out of the bank'}</span><span>({money(view.spend)})</span></div>
            <div className="kv" style={{ fontWeight: 700, color: isProfit ? 'var(--teal)' : 'var(--red)' }}><span className="k">{isProfit ? 'Profit' : 'Loss'}</span><span>{money(Math.abs(view.pl))}</span></div>
            <div className="kv"><span className="k">Margin on income</span><span>{view.income ? Math.round((view.pl / view.income) * 100) : 0}%</span></div>
            {one && <div className="kv"><span className="k">All {data.rows.length} months together</span><span style={{ color: profit ? 'var(--teal)' : 'var(--red)' }}>{profit ? 'profit ' : 'loss '}{money(Math.abs(t.pl))}</span></div>}
          </div>
          <div style={{ flex: 1, minWidth: 250 }}>
            <div className="notice">
              <span>
                {basis === 'accrual'
                  ? `On paper you have ${data.accrual.pl >= 0 ? 'made' : 'lost'} ${money(Math.abs(data.accrual.pl))}. On cash the position is ${data.cash.pl >= 0 ? 'a surplus of ' : 'a shortfall of '}${money(Math.abs(data.cash.pl))} — the gap is money billed but not yet collected (${money(data.receivable)} still pending).`
                  : `In the bank you are ${data.cash.pl >= 0 ? 'up' : 'down'} ${money(Math.abs(data.cash.pl))}. On work done the result is ${data.accrual.pl >= 0 ? 'a profit of ' : 'a loss of '}${money(Math.abs(data.accrual.pl))} — ${money(data.receivable)} billed is still to be collected.`}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="card section">
        <h3>Profit / loss by month</h3>
        <div className="small-muted" style={{ marginBottom: 8 }}>Above the line = profit, below = loss</div>
        <PlBars rows={data.rows} />
      </div>

      <div className="card section">
        <h3>Month by month</h3>
        <div className="small-muted" style={{ marginBottom: 8 }}>{basis === 'accrual' ? 'Billing against office cost' : 'Collections against payments'}</div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Month</th><th className="num">Joins</th><th className="num">{basis === 'accrual' ? 'Fee billed' : 'Received'}</th>
                <th className="num">Expense entries</th><th className="num">{basis === 'accrual' ? 'Office cost' : 'Paid out'}</th>
                <th className="num">Profit / loss</th><th>Result</th><th className="num">Running total</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.month} className="row-link" onClick={() => setSel(sel === r.month ? 'All' : r.month)}>
                  <td>
                    <b>{r.label}</b>
                    {r.noExp && <div className="small-muted">no expenses recorded</div>}
                    {r.noInc && <div className="small-muted">no billing recorded</div>}
                  </td>
                  <td className="num">{r.joins || '—'}</td>
                  <td className="num">{money(r.income)}</td>
                  <td className="num">{r.entries || '—'}</td>
                  <td className="num">{money(r.spend)}</td>
                  <td className="num" style={{ fontWeight: 700, color: r.pl >= 0 ? 'var(--teal)' : 'var(--red)' }}>{signed(r.pl)}</td>
                  <td><span className={`status ${r.pl >= 0 ? 'priority-low' : 'priority-high'}`}>{r.pl >= 0 ? 'Profit' : 'Loss'}</span></td>
                  <td className="num" style={{ color: r.cum >= 0 ? 'var(--teal)' : 'var(--red)' }}>{signed(r.cum)}</td>
                </tr>
              ))}
              {data.rows.length === 0 && <tr><td colSpan="8" className="empty-mini">No data yet.</td></tr>}
            </tbody>
            <tfoot>
              <tr>
                <td>TOTAL</td><td className="num">{t.joins}</td><td className="num">{money(t.income)}</td>
                <td className="num">{t.entries}</td><td className="num">{money(t.spend)}</td>
                <td className="num" style={{ color: profit ? 'var(--teal)' : 'var(--red)' }}>{signed(t.pl)}</td>
                <td><span className={`status ${profit ? 'priority-low' : 'priority-high'}`}>{profit ? 'Profit' : 'Loss'}</span></td><td />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="grid-2">
        <div className="card section">
          <h3>Where the money came from</h3>
          <div className="small-muted" style={{ marginBottom: 8 }}>Top clients by fee billed</div>
          <RankBars rows={topCli} />
        </div>
        <div className="card section">
          <h3>Where the money went</h3>
          <div className="small-muted" style={{ marginBottom: 8 }}>Top expense heads (excl GST)</div>
          <RankBars rows={topCat} down />
        </div>
      </div>

      <div className="card section">
        <h3>Not profit or loss — money held for someone else</h3>
        <div className="small-muted" style={{ marginBottom: 8 }}>Keep these out of your profit thinking</div>
        <div className="grid-3">
          <div>
            <div className="kv"><span className="k">GST collected on invoices</span><span>{money(h.gstOut)}</span></div>
            <div className="kv"><span className="k">GST paid to vendors (credit)</span><span>{money(h.gstIn)}</span></div>
            <div className="kv" style={{ fontWeight: 700 }}><span className="k">Net GST to Government</span><span>{money(h.gstNet)}</span></div>
          </div>
          <div>
            <div className="kv"><span className="k">TDS deducted by clients</span><span>{money(h.tdsByClients)}</span></div>
            <div className="kv"><span className="k">TDS deducted by us on vendors</span><span>{money(h.tdsByUs)}</span></div>
            <div className="kv"><span className="k">Nature</span><span>Advance tax, adjustable</span></div>
          </div>
          <div>
            <div className="kv"><span className="k">Still to collect from clients</span><span>{money(h.receivable)}</span></div>
            <div className="kv"><span className="k">Still to pay vendors</span><span>{money(h.payable)}</span></div>
            <div className="kv" style={{ fontWeight: 700 }}><span className="k">Net expected inflow</span><span>{money(h.netInflow)}</span></div>
          </div>
        </div>
        <div className="notice" style={{ marginTop: 10 }}>
          <span>
            GST is never profit — you collect it and hand it over. TDS is not a cost either — it is tax paid in advance on your behalf,
            adjusted when you file. That is why both sit outside the profit calculation above.
          </span>
        </div>
      </div>
    </>
  );
}

const monthName = (mk) => (mk ? `${MON[Number(String(mk).slice(5, 7)) - 1]} ${String(mk).slice(0, 4)}` : '—');

// ---------------------------------------------------------------------------
// Category & month summary
// ---------------------------------------------------------------------------
function Summary({ period }) {
  const [data, setData] = useState(null);
  const [f, setF] = useState(BLANK_FILTERS);
  useEffect(() => {
    api.get('/office-expenses/summary-tabs', { params: { period, ...f } }).then((r) => setData(r.data));
  }, [period, f]);
  if (!data) return <div className="small-muted">Loading…</div>;
  const t = data.totals;

  return (
    <>
      {/* the summary carries the same one filter box as the bills register */}
      <BillFilters f={f} setF={setF} o={data.options} totals={t} />

      <div className="statbar">
        <Stat n={money(t.net)} l="Total spend (net)" s={`${t.n} entries`} />
        <Stat n={money(t.paid)} l="Cash paid" s="Settled" tone="good" />
        <Stat n={money(t.gst)} l="GST input credit" s={`${data.gstEntries} entries with GST`} />
        <Stat n={money(t.tds)} l="TDS deducted" s={`${data.tdsEntries} entries with TDS`} />
      </div>

      <div className="grid-2">
        <div className="card section">
          <h3>Monthly expenditure</h3>
          <div className="small-muted" style={{ marginBottom: 8 }}>Cash paid vs amortised run-rate</div>
          <Bars
            rows={data.byMonth.map((r) => ({ label: r.label, a: r.cash, b: r.amortised }))}
            aName="Cash paid"
            bName="Amortised"
          />
        </div>
        <div className="card section">
          <h3>GST &amp; TDS compliance</h3>
          <div className="small-muted" style={{ marginBottom: 8 }}>For your returns</div>
          <div className="kv"><span className="k">Entries with GST applicable</span><span>{data.gstEntries}</span></div>
          <div className="kv"><span className="k">Total GST paid (input credit)</span><span>{money2(t.gst)}</span></div>
          <div className="kv"><span className="k">Entries with TDS applicable</span><span>{data.tdsEntries}</span></div>
          <div className="kv"><span className="k">Total TDS deducted</span><span>{money2(t.tds)}</span></div>
          <div className="kv"><span className="k">Bill amount (base)</span><span>{money2(t.base)}</span></div>
          <div className="kv" style={{ fontWeight: 700 }}><span className="k">Net amount paid</span><span>{money2(t.net)}</span></div>
          <div className="notice" style={{ marginTop: 12 }}>
            <span>
              GST here is what you <b>paid</b> vendors — input credit against the GST you collect on
              invoices. TDS here is what you <b>deducted</b> from vendors and must deposit.
            </span>
          </div>
        </div>
      </div>

      <div className="card section">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <h3 style={{ flex: 1 }}>Category-wise summary</h3>
          <span className="small-muted">{data.byCategory.length} categories</span>
          <button className="btn btn-sm" onClick={() => printRows('Expenditure by category', data.byCategory.map((c) => ({
            Category: c.key, Entries: c.n, 'Bill amount': c.base, GST: c.gst, TDS: c.tds, 'Net paid': c.net,
          })))}>🖨 Print</button>
        </div>
        <div className="tbl-wrap" style={{ marginTop: 10 }}>
          <table>
            <thead>
              <tr><th>Category</th><th className="num">Entries</th><th className="num">Bill amount</th><th className="num">GST</th><th className="num">TDS</th><th className="num">Net paid</th><th className="num">Share</th></tr>
            </thead>
            <tbody>
              {data.byCategory.map((c) => (
                <tr key={c.key}>
                  <td><b>{c.key}</b></td>
                  <td className="num">{c.n}</td>
                  <td className="num">{money(c.base)}</td>
                  <td className="num">{c.gst ? money(c.gst) : '—'}</td>
                  <td className="num">{c.tds ? money(c.tds) : '—'}</td>
                  <td className="num"><b>{money(c.net)}</b></td>
                  <td className="num">{t.net ? Math.round((c.net / t.net) * 100) : 0}%</td>
                </tr>
              ))}
              {data.byCategory.length === 0 && <tr><td colSpan="7" className="empty-mini">No data.</td></tr>}
            </tbody>
            <tfoot>
              <tr><td>TOTAL</td><td className="num">{t.n}</td><td className="num">{money(t.base)}</td><td className="num">{money(t.gst)}</td><td className="num">{money(t.tds)}</td><td className="num">{money(t.net)}</td><td /></tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="card section">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <h3 style={{ flex: 1 }}>Monthly summary</h3>
          <span className="small-muted">Cash basis vs amortised</span>
          <button className="btn btn-sm" onClick={() => printRows('Expenditure by month', data.byMonth.map((r) => ({
            Month: r.label, 'Actual paid': r.cash, Amortised: r.amortised, GST: r.gst, TDS: r.tds, Pending: r.pending, Entries: r.n,
          })))}>🖨 Print</button>
        </div>
        <div className="tbl-wrap" style={{ marginTop: 10 }}>
          <table>
            <thead>
              <tr><th>Month</th><th className="num">Actual paid</th><th className="num">Amortised</th><th className="num">GST</th><th className="num">TDS</th><th className="num">Pending</th><th className="num">Entries</th></tr>
            </thead>
            <tbody>
              {data.byMonth.map((r) => (
                <tr key={r.month}>
                  <td><b>{r.label}</b></td>
                  <td className="num">{money(r.cash)}</td>
                  <td className="num">{money(r.amortised)}</td>
                  <td className="num">{r.gst ? money(r.gst) : '—'}</td>
                  <td className="num">{r.tds ? money(r.tds) : '—'}</td>
                  <td className="num">{r.pending ? money(r.pending) : '—'}</td>
                  <td className="num">{r.n}</td>
                </tr>
              ))}
              {data.byMonth.length === 0 && <tr><td colSpan="7" className="empty-mini">No data.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="small-muted" style={{ marginTop: 8 }}>
          &quot;Actual paid&quot; is what left the bank that month. &quot;Amortised&quot; spreads a yearly or
          one-time payment across the months it covers — same as the workbook.
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Small charts
// ---------------------------------------------------------------------------
const shortR = (v) => (Math.abs(v) >= 10000000 ? `₹${(v / 10000000).toFixed(1)}Cr`
  : Math.abs(v) >= 100000 ? `₹${(v / 100000).toFixed(1)}L`
    : Math.abs(v) >= 1000 ? `₹${Math.round(v / 1000)}k` : `₹${Math.round(v)}`);

function Bars({ rows, aName, bName }) {
  if (!rows.length) return <div className="empty-mini">No data.</div>;
  const W = 860; const H = 210; const PL = 58; const PR = 10; const PT = 14; const PB = 26;
  const iw = W - PL - PR; const ih = H - PT - PB;
  const max = Math.max(1, ...rows.map((r) => Math.max(r.a, r.b)));
  const step = iw / rows.length;
  const bw = Math.min(16, (step - 10) / 2);
  return (
    <>
      <div className="small-muted" style={{ display: 'flex', gap: 14, marginBottom: 6 }}>
        <span><i style={{ display: 'inline-block', width: 9, height: 9, background: 'var(--navy)', borderRadius: 2 }} /> {aName}</span>
        <span><i style={{ display: 'inline-block', width: 9, height: 9, background: 'var(--teal)', borderRadius: 2 }} /> {bName}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{ width: '100%', height: 'auto' }} role="img" aria-label={`${aName} against ${bName}`}>
        <text x={PL - 8} y={PT + 4} textAnchor="end" fontSize="10" fill="#7A879A">{shortR(max)}</text>
        <line x1={PL} x2={W - PR} y1={PT + ih} y2={PT + ih} stroke="#C9D2E0" />
        {rows.map((r, i) => {
          const x0 = PL + i * step + (step - bw * 2 - 4) / 2;
          const ha = Math.max(1, (r.a / max) * ih);
          const hb = Math.max(1, (r.b / max) * ih);
          return (
            <g key={r.label}>
              <rect x={x0} y={PT + ih - ha} width={bw} height={ha} rx="3" fill="#1F3864"><title>{`${r.label} · ${aName}: ${money(r.a)}`}</title></rect>
              <rect x={x0 + bw + 4} y={PT + ih - hb} width={bw} height={hb} rx="3" fill="#2F8F83"><title>{`${r.label} · ${bName}: ${money(r.b)}`}</title></rect>
              <text x={PL + i * step + step / 2} y={H - 7} textAnchor="middle" fontSize="10" fill="#7A879A">{r.label.slice(0, 3)}</text>
            </g>
          );
        })}
      </svg>
    </>
  );
}

function PlBars({ rows }) {
  if (!rows.length) return <div className="empty-mini">No data.</div>;
  const W = 860; const H = 210; const PL = 62; const PR = 10; const PT = 14; const PB = 28;
  const iw = W - PL - PR; const ih = H - PT - PB;
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.pl)));
  const zero = PT + ih / 2; const half = ih / 2;
  const step = iw / rows.length;
  const bw = Math.min(34, step - 14);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{ width: '100%', height: 'auto' }} role="img" aria-label="Profit or loss by month">
      <text x={PL - 8} y={PT + 4} textAnchor="end" fontSize="10" fill="#7A879A">{shortR(max)}</text>
      <text x={PL - 8} y={zero + 4} textAnchor="end" fontSize="10" fill="#7A879A">0</text>
      <text x={PL - 8} y={PT + ih + 4} textAnchor="end" fontSize="10" fill="#7A879A">-{shortR(max)}</text>
      <line x1={PL} x2={W - PR} y1={zero} y2={zero} stroke="#98A4B6" />
      {rows.map((r, i) => {
        const h = Math.max(2, (half * Math.abs(r.pl)) / max);
        const up = r.pl >= 0;
        const x = PL + i * step + (step - bw) / 2;
        const y = up ? zero - h : zero;
        return (
          <g key={r.month}>
            <rect x={x} y={y} width={bw} height={h} rx="4" fill={up ? '#2F8F83' : '#B4483C'}>
              <title>{`${r.label}: ${up ? 'profit ' : 'loss '}${money(Math.abs(r.pl))}`}</title>
            </rect>
            <text x={x + bw / 2} y={up ? y - 4 : y + h + 11} textAnchor="middle" fontSize="10" fill={up ? '#2F8F83' : '#B4483C'}>{shortR(Math.abs(r.pl))}</text>
            <text x={PL + i * step + step / 2} y={H - 6} textAnchor="middle" fontSize="10" fill="#7A879A">{r.label.slice(0, 3)}</text>
          </g>
        );
      })}
    </svg>
  );
}

function RankBars({ rows, down }) {
  if (!rows.length) return <div className="empty-mini">No data.</div>;
  const top = rows[0].value || 1;
  return (
    <div className="tbl-wrap">
      <table>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td><b>{r.key}</b></td>
              <td className="num">{money(r.value)}</td>
              <td style={{ width: '34%' }}>
                <div style={{ height: 8, borderRadius: 4, background: 'var(--line)' }}>
                  <span style={{
                    display: 'block', height: '100%', borderRadius: 4, width: `${Math.round((r.value / top) * 100)}%`, background: down ? '#B4483C' : '#1F3864',
                  }}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({
  n, l, s, tone,
}) {
  return (
    <div className={`statitem${tone ? ` acct-${tone}` : ''}`}>
      <div className="n">{n}</div>
      <div className="l">{l}</div>
      {s && <div className="s">{s}</div>}
    </div>
  );
}
