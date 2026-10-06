// Accounts → Journal & Ledger → Fixed Assets (spec S2, 2026-10-05).
// HRMS owns the assets and repairs: there is no Add asset / Add repair here,
// only "View in HRMS". Accounts posts and reports:
//   Pending from HRMS  purchases / repairs / sales waiting for the journal → Post (one or many)
//   Run depreciation   a preview per asset, then book it
//   Assets             cost, depreciation, book value; click one for its timeline
//   Asset summary      per category: opening, additions, depreciation, disposals, closing, repairs
//   Repair cost        per asset, with "Consider replacing" above the threshold
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { Panel, PanelHead, EmptyMini, Modal } from '../proto.jsx';
import { money, errText, downloadFile } from '../payroll/payrollUi';
import PeriodPicker, { ALL_TIME, isAllTime, presetRange } from './PeriodPicker.jsx';
import Pager, { usePaged } from '../Pager.jsx';
import { FacetSelect } from '../ui/ListPageHeader.jsx';
import './ledgerBooks.css';

const HRMS_LINK = '/employee-services?tab=assets';
const STATE_CLS = { 'Not posted': 'orange', 'Changed in HRMS': 'orange', Posted: 'green', 'Covered by warranty': 'grey', Blocked: 'red' };
const KIND = { purchase: 'Purchase', repair: 'Repair', disposal: 'Sale / write-off' };
const qsOf = (o) => Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const periodParams = (v) => (isAllTime(v) ? {} : { from: v.from, to: v.to });

function Filters({ facets, values, set, extra = [] }) {
  return (
    <>
      <FacetSelect label="Category" value={values.category} onChange={(v) => set('category', v)} options={(facets || {}).category} allLabel="All categories" />
      <FacetSelect label="Status" value={values.status} onChange={(v) => set('status', v)} options={(facets || {}).status} allLabel="All statuses" />
      <FacetSelect label="Employee" value={values.employee} onChange={(v) => set('employee', v)} options={(facets || {}).employee} allLabel="Everyone" />
      {extra.map((k) => <FacetSelect key={k} label={k[0].toUpperCase() + k.slice(1)} value={values[k]} onChange={(v) => set(k, v)} options={(facets || {})[k]} allLabel="All" />)}
    </>
  );
}

// ---- Pending from HRMS ----------------------------------------------------------------------
function PendingView({ canPost }) {
  const [data, setData] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [kind, setKind] = useState('');
  const [sel, setSel] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [closedAsk, setClosedAsk] = useState(null);
  function load() { setError(''); api.get(`/accounts/fixed-assets/pending${showAll ? '?all=1' : ''}`).then((r) => { setData(r.data); setSel({}); }).catch((err) => setError(errText(err, 'Could not load the list.'))); }
  useEffect(load, [showAll]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = (data?.rows || []).filter((r) => !kind || r.kind === kind);
  const postable = rows.filter((r) => ['Not posted', 'Changed in HRMS'].includes(r.state));
  const page = usePaged(rows);
  const chosen = postable.filter((r) => sel[`${r.kind}:${r.id}`]);
  async function post(items, confirmClosed = false) {
    setBusy(true); setMsg(''); setError('');
    try {
      const r = await api.post('/accounts/fixed-assets/post', { items: items.map((x) => ({ kind: x.kind, id: x.id })), confirmClosed });
      const failed = r.data.results.filter((x) => !x.ok);
      setMsg(`Saved — ${r.data.ok} posted to the journal${failed.length ? `; ${failed.length} not posted: ${failed.slice(0, 2).map((f) => f.error).join('; ')}` : ''}.`);
      load();
    } catch (err) {
      const d = err.response?.data;
      if (d?.closedWarning) setClosedAsk({ items, text: d.closedWarning });
      else setError(d?.results ? d.results.filter((x) => !x.ok).slice(0, 3).map((x) => x.error).join(' · ') : errText(err, 'Could not post.'));
    } finally { setBusy(false); }
  }
  const kindOpts = useMemo(() => {
    const m = new Map();
    (data?.rows || []).forEach((r) => m.set(r.kind, (m.get(r.kind) || 0) + 1));
    return [...m.entries()].map(([value, count]) => ({ value, label: KIND[value], count }));
  }, [data]);
  return (
    <>
      <div className="lb-filters">
        <FacetSelect label="What" value={kind} onChange={setKind} options={kindOpts} allLabel="Everything" />
        <label className="prb-check"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> show posted ones too</label>
        <Link className="btn btn-sm" to={HRMS_LINK}>View in HRMS</Link>
        {canPost && postable.length > 0 && (
          <button type="button" className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => post(chosen.length ? chosen : postable)}>
            {busy ? 'Posting…' : chosen.length ? `Post ${chosen.length} selected to Journal` : `Post all ${postable.length} to Journal`}
          </button>
        )}
      </div>
      {data && <div className="lb-note" style={{ padding: '0 18px' }}>{Object.entries(data.counts).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(' · ') || 'Nothing from HRMS yet.'}</div>}
      {error && <div className="lb-err">{error}</div>}
      {msg && <div className="lb-ok">{msg}</div>}
      {!data ? <EmptyMini>Loading…</EmptyMini> : rows.length === 0 ? <EmptyMini>Everything from HRMS is in the journal.</EmptyMini> : (
        <>
          <div className="tbl-wrap">
            <table className="lb-tbl">
              <thead><tr>{canPost && <th />}<th>What</th><th>Asset ID</th><th>Asset</th><th>Category</th><th>Assigned to</th><th>Date</th><th className="lb-num">Amount</th><th>Paid via</th><th>Journal</th><th /></tr></thead>
              <tbody>
                {page.slice.map((r) => {
                  const k = `${r.kind}:${r.id}`;
                  const can = ['Not posted', 'Changed in HRMS'].includes(r.state);
                  return (
                    <tr key={k}>
                      {canPost && <td>{can && <input type="checkbox" checked={!!sel[k]} onChange={(e) => setSel((s) => ({ ...s, [k]: e.target.checked }))} />}</td>}
                      <td>{KIND[r.kind]}{r.capitalise ? <div className="lb-note">capitalised</div> : null}<div className="lb-note">{r.ref}</div></td>
                      <td><b>{r.assetCode}</b></td>
                      <td>{r.assetName}</td>
                      <td className="cell-muted">{r.category}</td>
                      <td className="cell-muted">{r.holder || '—'}</td>
                      <td>{r.date || '—'}</td>
                      <td className="lb-num">{money(r.amount)}{r.gst ? <div className="lb-note">GST {money(r.gst)}</div> : null}</td>
                      <td className="cell-muted">{r.paid || '—'}{r.assumedPay ? <div className="lb-note">not set in HRMS</div> : null}</td>
                      <td><span className={`lb-badge ${STATE_CLS[r.state] || 'grey'}`}>{r.state}</span>{r.reason && <div className="lb-note">{r.reason}</div>}<div className="lb-note">Synced from HRMS</div></td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {canPost && can && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => post([r])}>{r.state === 'Changed in HRMS' ? 'Update entry' : 'Post'}</button>}
                        {r.journalEntryId && <> <Link className="btn btn-sm" to={`/accounts/journal?je=${r.journalEntryId}`}>Entry</Link></>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length > 25 && <Pager page={page} noun="items" />}
        </>
      )}
      {closedAsk && (
        <Modal title="This touches a closed month" onClose={() => setClosedAsk(null)} footer={<><button type="button" className="btn btn-sm" onClick={() => setClosedAsk(null)}>Cancel</button><button type="button" className="btn btn-primary btn-sm" onClick={() => { const it = closedAsk.items; setClosedAsk(null); post(it, true); }}>Yes, post it</button></>}>
          <div className="lb-note">{closedAsk.text}</div>
        </Modal>
      )}
    </>
  );
}

// ---- Run depreciation -----------------------------------------------------------------------
function DepreciationView({ canPost }) {
  const [period, setPeriod] = useState(() => ({ ...presetRange('lastMonth'), preset: 'lastMonth' }));
  const [pv, setPv] = useState(null);
  const [runs, setRuns] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  function load() {
    setPv(null); setError('');
    if (isAllTime(period)) return;
    api.get(`/accounts/fixed-assets/depreciation/preview?from=${period.from}&to=${period.to}`).then((r) => setPv(r.data)).catch((err) => setError(errText(err, 'Could not work out the depreciation.')));
    api.get('/accounts/fixed-assets/depreciation/runs').then((r) => setRuns(r.data)).catch(() => setRuns([]));
  }
  useEffect(load, [period]); // eslint-disable-line react-hooks/exhaustive-deps
  const page = usePaged(pv?.rows || []);
  async function run(confirmClosed = false) {
    setBusy(true); setMsg(''); setError('');
    try {
      const r = await api.post('/accounts/fixed-assets/depreciation/run', { from: period.from, to: period.to, confirmClosed });
      setMsg(`Saved — depreciation of ${money(r.data.total)} on ${r.data.assets} asset(s) is booked.`);
      load();
    } catch (err) {
      const t = errText(err, 'Could not book it.');
      if (/closed/.test(t) && window.confirm(`${t}\n\nBook it anyway?`)) { setBusy(false); run(true); return; }
      setError(t);
    } finally { setBusy(false); }
  }
  return (
    <>
      <div className="lb-filters">
        <PeriodPicker value={period} onChange={setPeriod} presets={['thisMonth', 'lastMonth', 'thisQuarter', 'lastQuarter', 'cfy', 'pfy', 'custom']} label="Depreciate for" />
        {canPost && pv && pv.rows.length > 0 && !pv.overlap && <button type="button" className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => run()}>{busy ? 'Booking…' : `Book depreciation · ${money(pv.total)}`}</button>}
      </div>
      {isAllTime(period) && <EmptyMini>Pick the month, quarter or year to depreciate.</EmptyMini>}
      {error && <div className="lb-err">{error}</div>}
      {msg && <div className="lb-ok">{msg}</div>}
      {pv && pv.overlap && <div className="lb-err">Depreciation for {pv.overlap.from} to {pv.overlap.to} is already booked. Pick a period after it, or reverse that run in the Journal first.</div>}
      {pv && pv.gap && <div className="lb-err" style={{ background: '#fdf0dc', color: '#a35f00' }}>The last run ended on {pv.gap.after}. The days in between are not depreciated yet.</div>}
      {pv && pv.notInBooks > 0 && <div className="lb-note" style={{ padding: '0 18px' }}>{pv.notInBooks} asset(s) with a cost are not in the books yet — post their purchase in “Pending from HRMS” first.</div>}
      {pv && pv.defaultsUsed > 0 && <div className="lb-note" style={{ padding: '4px 18px 0' }}>{pv.defaultsUsed} asset(s) have no method / useful life in HRMS — the default is used: straight line, 3 years for IT items, 10 for furniture, 8 for vehicles, 5 for the rest, salvage 0.</div>}
      {pv && (pv.rows.length === 0 ? <EmptyMini>Nothing to depreciate for this period.</EmptyMini> : (
        <>
          <div className="tbl-wrap">
            <table className="lb-tbl">
              <thead><tr><th>Asset ID</th><th>Asset</th><th>Category</th><th>Method</th><th className="lb-num">Cost</th><th className="lb-num">Book value before</th><th className="lb-num">Days</th><th className="lb-num">Depreciation</th><th className="lb-num">Book value after</th></tr></thead>
              <tbody>
                {page.slice.map((r) => (
                  <tr key={r.assetId}>
                    <td><b>{r.assetCode}</b></td><td>{r.name}<div className="lb-note">{r.holder || ''}</div></td><td className="cell-muted">{r.category}</td>
                    <td>{r.method} · {r.life} yr{r.method === 'WDV' ? ` · ${r.rate}%` : ''}{(r.defaulted.method || r.defaulted.life) ? <div className="lb-note">default</div> : null}</td>
                    <td className="lb-num">{money(r.cost)}</td><td className="lb-num">{money(r.bookValueBefore)}</td><td className="lb-num">{r.days}</td>
                    <td className="lb-num"><b>{money(r.depreciation)}</b></td><td className="lb-num">{money(r.bookValueAfter)}</td>
                  </tr>
                ))}
                <tr className="lb-tot"><td colSpan="7">TOTAL · {pv.rows.length} asset(s)</td><td className="lb-num">{money(pv.total)}</td><td /></tr>
              </tbody>
            </table>
          </div>
          {pv.rows.length > 25 && <Pager page={page} noun="assets" />}
        </>
      ))}
      {runs.length > 0 && <div className="lb-note" style={{ padding: '10px 18px' }}>Booked runs: {runs.map((r) => `${r.from} to ${r.to} (${money(r.total)})`).join(' · ')}</div>}
    </>
  );
}

// ---- One asset's timeline ---------------------------------------------------------------------
function Timeline({ id, onClose }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get(`/accounts/fixed-assets/${id}/timeline`).then((r) => setD(r.data)).catch((err) => setError(errText(err, 'Could not load.'))); }, [id]);
  return (
    <Modal title={d ? `${d.asset.assetCode} · ${d.asset.name}` : 'Asset'} onClose={onClose} wide footer={<><Link className="btn btn-sm" to={HRMS_LINK}>View in HRMS</Link><button type="button" className="btn btn-primary btn-sm" onClick={onClose}>Close</button></>}>
      {error && <div className="lb-err">{error}</div>}
      {!d ? <div className="lb-note">Loading…</div> : (
        <>
          <div className="lb-cards" style={{ padding: 0, marginBottom: 12 }}>
            <div className="lb-card"><div className="v">{money(d.book.gross)}</div><div className="l">Cost in the books</div></div>
            <div className="lb-card"><div className="v">{money(d.book.accDep)}</div><div className="l">Depreciation so far</div></div>
            <div className="lb-card"><div className="v">{money(d.book.bookValue)}</div><div className="l">Book value</div></div>
            <div className="lb-card"><div className="v">{d.asset.method} · {d.asset.life} yr</div><div className="l">{d.asset.category} · {d.asset.holder || 'not assigned'} · {d.asset.status}</div></div>
          </div>
          {d.events.length === 0 ? <div className="lb-note">Nothing booked for this asset yet.</div> : (
            <ul className="lb-timeline">
              {d.events.map((e, i) => (
                <li key={e.journalEntryId || i} className={e.kind}>
                  <b>{e.date || '—'}</b> · {e.narration} · {money(e.amount)}
                  {e.reversal && <span className="lb-badge orange" style={{ marginLeft: 6 }}>Reversal</span>}
                  {e.hrmsOnly && <span className="lb-badge grey" style={{ marginLeft: 6 }}>Not in the journal</span>}
                  {e.journalEntryId && <> · <Link to={`/accounts/journal?je=${e.journalEntryId}`} onClick={onClose}>Entry</Link></>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Modal>
  );
}

// ---- Assets (register) -------------------------------------------------------------------------
function RegisterView() {
  const [values, setValues] = useState({ category: '', status: '', employee: '' });
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [error, setError] = useState('');
  const set = (k, v) => setValues((x) => ({ ...x, [k]: v }));
  useEffect(() => { api.get(`/accounts/fixed-assets/register?${qsOf(values)}`).then((r) => setData(r.data)).catch((err) => setError(errText(err, 'Could not load the assets.'))); }, [values]);
  const rows = (data?.rows || []).filter((r) => !q.trim() || `${r.assetCode} ${r.name} ${r.holder || ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  const page = usePaged(rows);
  return (
    <>
      <div className="lb-filters">
        <Filters facets={data?.facets} values={values} set={set} />
        <label className="lb-f"><span>Search</span><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Asset ID, name, employee" /></label>
        {(values.category || values.status || values.employee || q) && <button type="button" className="btn btn-sm" onClick={() => { setValues({ category: '', status: '', employee: '' }); setQ(''); }}>Clear filters</button>}
        <Link className="btn btn-sm" to={HRMS_LINK}>View in HRMS</Link>
      </div>
      {error && <div className="lb-err">{error}</div>}
      {!data ? <EmptyMini>Loading…</EmptyMini> : rows.length === 0 ? <EmptyMini>No assets match these filters.</EmptyMini> : (
        <>
          <div className="tbl-wrap">
            <table className="lb-tbl">
              <thead><tr><th>Asset ID</th><th>Asset</th><th>Category</th><th>Assigned to</th><th>Status</th><th>Bought</th><th className="lb-num">Purchase cost</th><th className="lb-num">Depreciation</th><th className="lb-num">Book value</th><th>Books</th></tr></thead>
              <tbody>
                {page.slice.map((r) => (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(r.id)} title="Open the timeline">
                    <td><b>{r.assetCode}</b></td><td>{r.name}</td><td className="cell-muted">{r.category}</td><td className="cell-muted">{r.holder || '—'}</td><td>{r.status}</td>
                    <td>{r.purchaseDate || '—'}</td><td className="lb-num">{r.purchaseCost ? money(r.purchaseCost) : '—'}</td>
                    <td className="lb-num">{money(r.accumulatedDepreciation)}</td><td className="lb-num"><b>{money(r.bookValue)}</b></td>
                    <td>{r.inBooks ? <span className="lb-badge green">In the books</span> : <span className="lb-badge grey">Not posted</span>}</td>
                  </tr>
                ))}
                <tr className="lb-tot"><td colSpan="6">TOTAL · {data.totals.count} asset(s)</td><td className="lb-num">{money(data.totals.purchaseCost)}</td><td className="lb-num">{money(data.totals.accumulatedDepreciation)}</td><td className="lb-num">{money(data.totals.bookValue)}</td><td /></tr>
              </tbody>
            </table>
          </div>
          {rows.length > 25 && <Pager page={page} noun="assets" />}
        </>
      )}
      {open && <Timeline id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

// ---- Asset summary ------------------------------------------------------------------------------
function SummaryView() {
  const [period, setPeriod] = useState(ALL_TIME);
  const [values, setValues] = useState({ category: '', status: '', employee: '' });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const set = (k, v) => setValues((x) => ({ ...x, [k]: v }));
  const qs = qsOf({ ...periodParams(period), ...values });
  useEffect(() => { setError(''); api.get(`/accounts/fixed-assets/summary?${qs}`).then((r) => setData(r.data)).catch((err) => setError(errText(err, 'Could not load the summary.'))); }, [qs]);
  return (
    <>
      <div className="lb-filters">
        <PeriodPicker value={period} onChange={setPeriod} />
        <Filters facets={data?.facets} values={values} set={set} />
        <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => downloadFile(`/accounts/fixed-assets/summary?${qs}&format=xlsx`, 'asset-summary.xlsx').catch((e) => setError(errText(e, 'Export failed')))}>Export Excel</button>
      </div>
      {error && <div className="lb-err">{error}</div>}
      {!data ? <EmptyMini>Loading…</EmptyMini> : data.rows.length === 0 ? <EmptyMini>No assets match these filters.</EmptyMini> : (
        <div className="tbl-wrap">
          <table className="lb-tbl">
            <thead><tr><th>Category</th><th className="lb-num">Assets</th><th className="lb-num">Opening</th><th className="lb-num">Additions</th><th className="lb-num">Depreciation</th><th className="lb-num">Disposals</th><th className="lb-num">Closing book value</th><th className="lb-num">Total repair cost</th><th>Not in the books</th></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.category}>
                  <td><b>{r.category}</b></td><td className="lb-num">{r.assets}</td><td className="lb-num">{money(r.opening)}</td><td className="lb-num">{money(r.additions)}</td>
                  <td className="lb-num">{money(r.depreciation)}</td><td className="lb-num">{money(r.disposals)}</td><td className="lb-num"><b>{money(r.closing)}</b></td><td className="lb-num">{money(r.repairCost)}</td>
                  <td>{r.notInBooks ? <span className="lb-badge orange">{r.notInBooks} not posted</span> : <span className="lb-badge green">All posted</span>}</td>
                </tr>
              ))}
              <tr className="lb-tot"><td>TOTAL</td><td className="lb-num">{data.totals.assets}</td><td className="lb-num">{money(data.totals.opening)}</td><td className="lb-num">{money(data.totals.additions)}</td><td className="lb-num">{money(data.totals.depreciation)}</td><td className="lb-num">{money(data.totals.disposals)}</td><td className="lb-num">{money(data.totals.closing)}</td><td className="lb-num">{money(data.totals.repairCost)}</td><td>{data.totals.notInBooks || ''}</td></tr>
            </tbody>
          </table>
        </div>
      )}
      <div className="lb-note" style={{ padding: '8px 18px 14px' }}>From the journal: only what is posted counts. Opening = book value before the period.</div>
    </>
  );
}

// ---- Repair cost ---------------------------------------------------------------------------------
function RepairCostView({ canEdit }) {
  const [period, setPeriod] = useState(ALL_TIME);
  const [values, setValues] = useState({ category: '', status: '', employee: '', vendor: '' });
  const [threshold, setThreshold] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const set = (k, v) => setValues((x) => ({ ...x, [k]: v }));
  const qs = qsOf({ ...periodParams(period), ...values });
  function load() { setError(''); api.get(`/accounts/fixed-assets/repair-cost?${qs}`).then((r) => { setData(r.data); setThreshold(String(r.data.threshold)); }).catch((err) => setError(errText(err, 'Could not load the report.'))); }
  useEffect(load, [qs]); // eslint-disable-line react-hooks/exhaustive-deps
  async function saveThreshold() {
    setMsg(''); setError('');
    try { await api.put('/accounts/fixed-assets/settings', { replaceThreshold: Number(threshold) }); setMsg(`Saved — "Consider replacing" shows at ${threshold}% of the purchase cost.`); load(); } catch (err) { setError(errText(err, 'Could not save.')); }
  }
  const page = usePaged(data?.rows || []);
  return (
    <>
      <div className="lb-filters">
        <PeriodPicker value={period} onChange={setPeriod} />
        <Filters facets={data?.facets} values={values} set={set} extra={['vendor']} />
        <label className="lb-f"><span>Consider replacing at</span><span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input style={{ minWidth: 70, width: 70 }} inputMode="numeric" value={threshold} disabled={!canEdit} onChange={(e) => setThreshold(e.target.value)} />%{canEdit && <button type="button" className="btn btn-sm" onClick={saveThreshold}>Save</button>}</span></label>
        <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => downloadFile(`/accounts/fixed-assets/repair-cost?${qs}&format=xlsx`, 'asset-repair-cost.xlsx').catch((e) => setError(errText(e, 'Export failed')))}>Export Excel</button>
      </div>
      {error && <div className="lb-err">{error}</div>}
      {msg && <div className="lb-ok">{msg}</div>}
      {!data ? <EmptyMini>Loading…</EmptyMini> : data.rows.length === 0 ? <EmptyMini>No repairs match these filters.</EmptyMini> : (
        <>
          <div className="tbl-wrap">
            <table className="lb-tbl">
              <thead><tr><th>Asset ID</th><th>Name</th><th>Category</th><th>Assigned to</th><th className="lb-num">Repairs</th><th className="lb-num">Total repair cost</th><th className="lb-num">Purchase cost</th><th className="lb-num">Repair %</th><th>Last repair</th><th /></tr></thead>
              <tbody>
                {page.slice.map((r) => (
                  <tr key={r.assetId}>
                    <td><b>{r.assetCode}</b></td><td>{r.name}</td><td className="cell-muted">{r.category}</td><td className="cell-muted">{r.holder || '—'}</td>
                    <td className="lb-num">{r.repairs}</td><td className="lb-num">{money(r.totalRepairCost)}</td><td className="lb-num">{r.purchaseCost ? money(r.purchaseCost) : '—'}</td>
                    <td className="lb-num">{r.repairPct == null ? '—' : `${r.repairPct}%`}</td><td>{r.lastRepairDate || '—'}</td>
                    <td>{r.considerReplacing && <span className="lb-badge red">Consider replacing</span>}</td>
                  </tr>
                ))}
                {data.byCategory.map((c) => (
                  <tr key={`c-${c.category}`} className="lb-grp"><td colSpan="4">Total — {c.category}</td><td className="lb-num">{c.repairs}</td><td className="lb-num">{money(c.totalRepairCost)}</td><td className="lb-num">{money(c.purchaseCost)}</td><td className="lb-num">{c.repairPct == null ? '—' : `${c.repairPct}%`}</td><td colSpan="2" /></tr>
                ))}
                <tr className="lb-tot"><td colSpan="4">TOTAL · {data.totals.assets} asset(s)</td><td className="lb-num">{data.totals.repairs}</td><td className="lb-num">{money(data.totals.totalRepairCost)}</td><td className="lb-num">{money(data.totals.purchaseCost)}</td><td className="lb-num">{data.totals.repairPct == null ? '—' : `${data.totals.repairPct}%`}</td><td colSpan="2">{data.totals.considerReplacing ? `${data.totals.considerReplacing} to consider replacing` : ''}</td></tr>
              </tbody>
            </table>
          </div>
          {data.rows.length > 25 && <Pager page={page} noun="assets" />}
        </>
      )}
      <div className="lb-note" style={{ padding: '8px 18px 14px' }}>From the HRMS repair log (posted or not). Cost is before GST.</div>
    </>
  );
}

export default function FixedAssetsTab({ canPost = false, canEdit = false }) {
  const [view, setView] = useState('pending');
  const VIEWS = [['pending', 'Pending from HRMS'], ['dep', 'Run depreciation'], ['register', 'Assets'], ['summary', 'Asset summary'], ['repairs', 'Repair cost']];
  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title="Fixed assets — from HRMS" />
      <div className="lb-sub">
        {VIEWS.map(([k, l]) => <button key={k} type="button" className={`btn btn-sm ${view === k ? 'on' : ''}`} onClick={() => setView(k)}>{l}</button>)}
      </div>
      {view === 'pending' && <PendingView canPost={canPost} />}
      {view === 'dep' && <DepreciationView canPost={canPost} />}
      {view === 'register' && <RegisterView />}
      {view === 'summary' && <SummaryView />}
      {view === 'repairs' && <RepairCostView canEdit={canEdit} />}
    </Panel>
  );
}
