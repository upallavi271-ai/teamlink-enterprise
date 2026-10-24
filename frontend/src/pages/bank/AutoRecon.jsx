// AUTO-RECONCILE - a view inside Bank & Reconciliation (no new sidebar entry).
// Tabs: Overview | To check | Reconcile existing | Rules.
// Plain words (Job-style UX rule): "Suggested - needs your OK", "Needs a look", "Not matched".
// Every button is a visible button (no dropdown menus of actions); every dropdown is type-to-search (Combo).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Combo from '../../components/Combo.jsx';
import Modal from '../../components/Modal.jsx';
import { money2, fmtD } from '../invoices/invFormat';
import './autoRecon.css';

const STATUS_OPTIONS = [
  ['', 'Everything'], ['open', 'Not done yet'], ['suggested', 'Suggested - needs your OK'], ['review', 'Needs a look'], ['unmatched', 'Not matched'],
  ['reconciled', 'Done (matched)'], ['auto', 'Matched automatically'], ['duplicate', 'Possible duplicate'], ['mismatch', 'Amount does not agree'], ['existing', 'Old match to double-check'], ['ignored', 'Ignored'],
];
const BAND_LABEL = { high: 'Sure', medium: 'Probably', low: 'Not sure' };
const KIND_OPTIONS = [['', 'Any record'], ['invoice', 'Customer invoice'], ['receipt-proof', 'Receipt already recorded'], ['expense', 'Expense / bill'], ['transfer', 'Own-account transfer'], ['charge', 'Bank charge / interest'], ['reversal', 'Returned payment'], ['flag', 'Old match to check']];
const STATE_TONE = {
  'Reconciled automatically': 'green', Reconciled: 'green', 'Partly reconciled': 'blue', 'Suggested - needs your OK': 'blue', 'Needs review': 'orange', 'Possible duplicate': 'red', 'Existing match to review': 'orange', Unmatched: 'orange', Reversed: 'red', Ignored: '',
};
const FLAG_TEXT = {
  'potential-duplicate': 'Possible duplicate', 'amount-mismatch': 'Amount does not agree', 'bill-not-approved': 'Bill still Pending', 'closed-period': 'Closed month', 'bank-fee': 'Bank fee?', rounding: 'Rounding', tds: 'TDS?',
  'over-allocated': 'Too much allocated', 'invoice-cancelled': 'Cancelled invoice', 'wrong-direction': 'Wrong direction', 'reconciled-without-record': 'Nothing behind it',
};

const errText = (e, d = 'That did not work. Nothing was changed.') => e?.response?.data?.error || d;
const qs = (o) => { const p = new URLSearchParams(); Object.entries(o).forEach(([k, v]) => { if (v !== '' && v != null) p.set(k, v); }); return p.toString(); };

export default function AutoRecon({ accounts = [], canManage, onBack, onChanged }) {
  const [tab, setTab] = useState('dash');
  const [filters, setFilters] = useState({});
  const [msg, setMsg] = useState({ text: '', bad: false });
  const [opts, setOpts] = useState({ accounts: [], parties: [], categories: [], statements: [] });
  const [settings, setSettings] = useState(null);
  const [canEditRules, setCanEditRules] = useState(false);
  const [notReady, setNotReady] = useState(false);

  const say = (text, bad = false) => setMsg({ text, bad });
  const loadSettings = useCallback(() => api.get('/bank/auto/settings').then((r) => { setSettings(r.data.settings); setCanEditRules(r.data.canEdit); setNotReady(false); })
    .catch((e) => { if (e.response?.data?.notReady) setNotReady(true); }), []);
  useEffect(() => { loadSettings(); api.get('/bank/auto/options').then((r) => setOpts(r.data)).catch(() => {}); }, [loadSettings]);

  const openList = (patch) => { setFilters({ ...patch }); setTab('queue'); };

  if (notReady) {
    return (
      <div className="ar-wrap">
        <button type="button" className="btn btn-sm" onClick={onBack}>← Bank overview</button>
        <div className="notice orange" style={{ marginTop: 10 }}>
          Auto-Reconcile is not switched on for this database yet: the one-time setup (migration 20261014120000_bank_auto_recon) has not been run. Ask the person who looks after the system to run it.
        </div>
      </div>
    );
  }

  return (
    <div className="ar-wrap">
      <div className="ar-top">
        <button type="button" className="btn btn-sm" onClick={onBack}>← Bank overview</button>
        <h2 className="ar-title">Auto-Reconcile</h2>
        {settings && (
          <span className={`ar-pill ${settings.autoReconcile ? 'green' : 'orange'}`} title={settings.autoReconcile ? 'Sure matches are done for you' : 'Nothing changes until an Admin turns this on (Rules tab)'}>
            {settings.autoReconcile ? 'Sure matches are done for you' : 'Suggestions only - nothing changes by itself'}
          </span>
        )}
      </div>
      <div className="ar-tabs" role="tablist">
        {[['dash', 'Overview'], ['queue', 'To check'], ['run', 'Reconcile existing'], ['rules', 'Rules']].map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab-btn ${tab === k ? 'active' : ''}`} onClick={() => { setTab(k); if (k === 'queue' && tab !== 'queue') setFilters({}); }}>{l}</button>
        ))}
      </div>
      {msg.text && <div className={`notice ${msg.bad ? 'red' : ''}`} style={{ margin: '8px 0' }}><span>{msg.text}</span> <button type="button" className="link-btn" onClick={() => say('')}>OK</button></div>}

      {tab === 'dash' && <Dashboard accounts={opts.accounts} openList={openList} setTab={setTab} />}
      {tab === 'queue' && <Queue opts={opts} accounts={opts.accounts} filters={filters} setFilters={setFilters} canManage={canManage} say={say} onChanged={() => { if (onChanged) onChanged(); }} />}
      {tab === 'run' && <RunTab accounts={opts.accounts} canManage={canManage} settings={settings} say={say} openList={openList} onChanged={onChanged} />}
      {tab === 'rules' && <Rules settings={settings} canEdit={canEditRules} say={say} reload={loadSettings} />}
    </div>
  );
}

// ---------------------------------------------------------------------------- Overview
function Dashboard({ accounts, openList }) {
  const [acc, setAcc] = useState('');
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    setD(null);
    api.get(`/bank/auto/dashboard?${qs({ bankAccountId: acc })}`).then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(errText(e, 'The overview could not be loaded.')));
  }, [acc]);
  const c = d?.counts;
  const cards = c ? [
    ['Lines on file', c.imported, {}, ''],
    ['Matched automatically', c.autoReconciled, { status: 'auto' }, 'green'],
    ['Matched by a person', c.manuallyReconciled, { status: 'reconciled' }, 'green'],
    ['Partly matched', c.partiallyReconciled, { status: 'reconciled' }, 'blue'],
    ['Waiting for your OK', c.suggested, { status: 'suggested' }, 'blue'],
    ['Need a look', c.needsReview, { status: 'review' }, 'orange'],
    ['Not matched', c.unmatched, { status: 'unmatched' }, 'orange'],
    ['Possible duplicates', c.potentialDuplicates, { status: 'duplicate' }, 'red'],
    ['Amount does not agree', c.amountMismatches, { status: 'mismatch' }, 'red'],
    ['Old matches to double-check', c.existingToReview, { status: 'existing' }, 'orange'],
  ] : [];
  return (
    <div>
      <div className="ar-filters">
        <label className="ar-f">Bank account
          <Combo value={acc} onChange={(e) => setAcc(e.target.value)}><option value="">All accounts</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</Combo>
        </label>
      </div>
      {err && <div className="notice red">{err}</div>}
      {!d && !err && <div className="small-muted">Loading…</div>}
      {c && (
        <>
          <div className="ar-cards">
            {cards.map(([label, n, patch, tone]) => (
              <button key={label} type="button" className={`ar-card ${tone}`} onClick={() => openList({ ...patch, bankAccountId: acc })}>
                <b>{Number(n || 0).toLocaleString('en-IN')}</b><span>{label}</span>
              </button>
            ))}
          </div>
          <div className="ar-sums">
            <div><i>Matched - money out</i><b>{money2(d.totals.reconciledDebit)}</b></div>
            <div><i>Matched - money in</i><b>{money2(d.totals.reconciledCredit)}</b></div>
            <div><i>Still to match - money out</i><b>{money2(d.totals.unreconciledDebit)}</b></div>
            <div><i>Still to match - money in</i><b>{money2(d.totals.unreconciledCredit)}</b></div>
          </div>
          {d.lastRun && (
            <div className="ar-last">
              Last check: <b>{d.lastRun.dryRun ? 'Try-out (nothing changed)' : 'Real run'}</b> on {fmtD(String(d.lastRun.createdAt).slice(0, 10))} by {d.lastRun.startedByName || '-'} - {d.lastRun.status}
              {d.lastRun.counts && d.lastRun.counts.checked != null ? `, ${d.lastRun.counts.checked} lines looked at` : ''}.
            </div>
          )}
          <h3 className="ar-h3">Statements</h3>
          {d.statements.length === 0 ? <div className="card section">No statement has been imported yet. Import one on the Bank overview, then it shows up here.</div> : (
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>File</th><th>Period</th><th className="num">Lines</th><th className="num">Opening</th><th className="num">Closing</th><th>How far</th><th /></tr></thead>
                <tbody>
                  {d.statements.map((s) => (
                    <tr key={s.id}>
                      <td>{s.file || '-'}</td>
                      <td>{s.fromDate ? `${fmtD(s.fromDate)} - ${fmtD(s.toDate)}` : fmtD(s.date)}</td>
                      <td className="num">{s.inFile}</td>
                      <td className="num">{s.openingBalance == null ? '-' : money2(s.openingBalance)}</td>
                      <td className="num">{s.closingBalance == null ? '-' : money2(s.closingBalance)}</td>
                      <td><span className={`ar-pill ${s.complete ? 'green' : 'orange'}`}>{s.completion}</span>{s.openLines ? <span className="small-muted"> {s.openLines} left</span> : null}</td>
                      <td><button type="button" className="btn btn-sm" onClick={() => openList({ importId: s.id, bankAccountId: acc })}>See lines</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------- To check (the table)
function Queue({ opts, accounts, filters, setFilters, canManage, say, onChanged }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState({ key: 'date', dir: 'desc' });
  const [busy, setBusy] = useState('');
  const [detail, setDetail] = useState(null);
  const [text, setText] = useState(filters.search || '');
  const set = (k, v) => { setPage(0); setFilters((f) => ({ ...f, [k]: v })); };
  const key = JSON.stringify([filters, page, sort]);

  const load = useCallback(() => {
    api.get(`/bank/auto/queue?${qs({ ...filters, page, per: 50, sort: sort.key, dir: sort.dir })}`).then((r) => { setData(r.data); setErr(''); })
      .catch((e) => setErr(errText(e, 'The list could not be loaded.')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => { const t = setTimeout(load, 120); return () => clearTimeout(t); }, [load]);
  useEffect(() => { const t = setTimeout(() => { if ((filters.search || '') !== text) set('search', text); }, 300); return () => clearTimeout(t); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [text]);

  const sortBy = (k) => setSort((s) => (s.key === k ? { key: k, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: k === 'date' || k === 'amount' ? 'desc' : 'asc' }));
  const arrow = (k) => (sort.key === k ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');

  async function approve(row) {
    setBusy(row.id);
    try {
      const r = await api.post(`/bank/auto/proposals/${row.proposalId}/approve`, {});
      say(`Done: ${r.data.record || 'matched'}${r.data.unallocated > 0.004 ? `. ${money2(r.data.unallocated)} of the money is not against an invoice yet.` : '.'}`);
      load(); onChanged();
    } catch (e) { say(errText(e), true); } finally { setBusy(''); }
  }
  async function reject(row) {
    setBusy(row.id);
    try { await api.post(`/bank/auto/proposals/${row.proposalId}/reject`, { reason: 'Not right' }); say('Suggestion set aside. It will not be offered again for this line.'); load(); } catch (e) { say(errText(e), true); } finally { setBusy(''); }
  }

  const clear = () => { setText(''); setPage(0); setFilters({}); };
  const pages = data ? Math.max(1, Math.ceil(data.total / data.per)) : 1;
  return (
    <div>
      <div className="ar-filters">
        <label className="ar-f">Bank account<Combo value={filters.bankAccountId || ''} onChange={(e) => set('bankAccountId', e.target.value)}><option value="">All accounts</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</Combo></label>
        <label className="ar-f">Showing<Combo value={filters.status || ''} onChange={(e) => set('status', e.target.value)}>{STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Combo></label>
        <label className="ar-f">How sure<Combo value={filters.band || ''} onChange={(e) => set('band', e.target.value)}><option value="">Any</option><option value="high">Sure</option><option value="medium">Probably</option><option value="low">Not sure</option></Combo></label>
        <label className="ar-f">Money<Combo value={filters.type || ''} onChange={(e) => set('type', e.target.value)}><option value="">In and out</option><option value="Credit">Money in</option><option value="Debit">Money out</option></Combo></label>
        <label className="ar-f">Matched to<Combo value={filters.kind || ''} onChange={(e) => set('kind', e.target.value)}>{KIND_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Combo></label>
        <label className="ar-f">Vendor / customer<Combo value={filters.party || ''} onChange={(e) => set('party', e.target.value)}><option value="">Anyone</option>{opts.parties.map((p) => <option key={p.value} value={p.value}>{p.value} ({p.n})</option>)}</Combo></label>
        <label className="ar-f">Category<Combo value={filters.category || ''} onChange={(e) => set('category', e.target.value)}><option value="">Any</option>{opts.categories.map((c) => <option key={c} value={c}>{c}</option>)}</Combo></label>
        <label className="ar-f">Statement<Combo value={filters.importId || ''} onChange={(e) => set('importId', e.target.value)}><option value="">Any</option>{opts.statements.map((s) => <option key={s.id} value={s.id}>{s.file || s.date}</option>)}</Combo></label>
        <label className="ar-f">Proof<Combo value={filters.proof || ''} onChange={(e) => set('proof', e.target.value)}><option value="">Any</option><option value="yes">Has a record behind it</option><option value="no">Nothing behind it yet</option></Combo></label>
        <label className="ar-f">From<input type="date" value={filters.from || ''} onChange={(e) => set('from', e.target.value)} /></label>
        <label className="ar-f">To<input type="date" value={filters.to || ''} onChange={(e) => set('to', e.target.value)} /></label>
        <label className="ar-f">Amount from<input type="number" min="0" value={filters.min || ''} onChange={(e) => set('min', e.target.value)} /></label>
        <label className="ar-f">Amount to<input type="number" min="0" value={filters.max || ''} onChange={(e) => set('max', e.target.value)} /></label>
        <label className="ar-f">Invoice / bill no.<input value={filters.number || ''} onChange={(e) => set('number', e.target.value)} /></label>
        <label className="ar-f">Reference / UTR<input value={filters.reference || ''} onChange={(e) => set('reference', e.target.value)} /></label>
        <label className="ar-f ar-wide">Search<input placeholder="Narration, vendor, customer, reference…" value={text} onChange={(e) => setText(e.target.value)} /></label>
        <button type="button" className="btn btn-sm" onClick={clear}>Clear filters</button>
      </div>
      {err && <div className="notice red">{err}</div>}
      <div className="small-muted" style={{ margin: '4px 0' }}>{data ? `${data.total.toLocaleString('en-IN')} line(s)` : 'Loading…'}</div>
      <div className="ar-scroll">
        <table className="ar-table">
          <thead>
            <tr>
              <th onClick={() => sortBy('date')} className="sortable">Date{arrow('date')}</th><th>Value date</th><th onClick={() => sortBy('description')} className="sortable">Bank narration{arrow('description')}</th><th>Reference / UTR</th>
              <th className="num sortable" onClick={() => sortBy('amount')}>Money out{arrow('amount')}</th><th className="num">Money in</th><th className="num">Balance</th>
              <th>Suggested category</th><th>Matched to</th><th>Invoice / bill no.</th><th>Vendor / customer</th>
              <th className="num">Book amount</th><th className="num">Matched amount</th><th className="num">Difference</th><th className="sortable" onClick={() => sortBy('band')}>How sure{arrow('band')}</th><th>Status</th><th>Proof</th><th>What to do</th>
            </tr>
          </thead>
          <tbody>
            {(data?.rows || []).map((r) => (
              <tr key={r.id} className={r.flags.length ? 'flagged' : ''}>
                <td>{fmtD(r.date)}</td>
                <td>{r.valueDate ? fmtD(r.valueDate) : '-'}</td>
                <td className="ar-narr" title={r.description}>{r.description}</td>
                <td>{r.reference || '-'}</td>
                <td className="num">{r.debit != null ? money2(r.debit) : ''}</td>
                <td className="num">{r.credit != null ? money2(r.credit) : ''}</td>
                <td className="num">{r.balance != null ? money2(r.balance) : '-'}</td>
                <td>{r.suggestedCategory || '-'}</td>
                <td>{r.matchedType || '-'}</td>
                <td>{r.number || '-'}</td>
                <td>{r.party || r.vendor || '-'}</td>
                <td className="num">{r.bookAmount != null ? money2(r.bookAmount) : '-'}</td>
                <td className="num">{r.allocated != null ? money2(r.allocated) : '-'}</td>
                <td className={`num ${r.difference ? 'ar-bad' : ''}`}>{r.difference != null ? money2(r.difference) : '-'}</td>
                <td>{r.band ? <span className={`ar-pill ${r.band === 'high' ? 'green' : (r.band === 'medium' ? 'blue' : 'orange')}`}>{BAND_LABEL[r.band]}</span> : '-'}</td>
                <td>
                  <span className={`ar-pill ${STATE_TONE[r.state] || ''}`}>{r.state}</span>
                  {r.flags.map((f) => <span key={f} className="ar-flag">{FLAG_TEXT[f] || f}</span>)}
                  {r.autoReason && <div className="ar-because">Matched automatically because: {r.autoReason}</div>}
                </td>
                <td>{r.proof ? 'Yes' : 'No'}</td>
                <td className="ar-actions">
                  {canManage && r.actionable && <button type="button" className="btn btn-primary btn-sm" disabled={busy === r.id} onClick={() => approve(r)}>Approve</button>}
                  {canManage && r.actionable && <button type="button" className="btn btn-sm" disabled={busy === r.id} onClick={() => reject(r)}>Not right</button>}
                  {canManage && r.proof && !['Ignored', 'Reversed'].includes(r.state) && <button type="button" className="btn btn-sm" onClick={() => setDetail(r.id)}>Undo</button>}
                  <button type="button" className="btn btn-sm" onClick={() => setDetail(r.id)}>Open</button>
                </td>
              </tr>
            ))}
            {data && data.rows.length === 0 && <tr><td colSpan={18} className="ar-empty">Nothing here. Try clearing the filters.</td></tr>}
          </tbody>
        </table>
      </div>
      {data && data.total > data.per && (
        <div className="ar-pager">
          <button type="button" className="btn btn-sm" disabled={page <= 0} onClick={() => setPage(page - 1)}>← Earlier</button>
          <span>Page {page + 1} of {pages}</span>
          <button type="button" className="btn btn-sm" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Later →</button>
        </div>
      )}
      {detail && <TxnModal id={detail} canManage={canManage} say={say} onClose={() => setDetail(null)} onChanged={() => { load(); onChanged(); }} />}
    </div>
  );
}

// ---------------------------------------------------------------------------- one line
function TxnModal({ id, canManage, say, onClose, onChanged }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [parts, setParts] = useState({});
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [needle, setNeedle] = useState('');
  const [invList, setInvList] = useState([]);
  const [billList, setBillList] = useState([]);
  const [pick, setPick] = useState({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.get(`/bank/auto/txn/${id}`).then((r) => {
    setD(r.data);
    const a = r.data.proposal && r.data.proposal.action;
    if (a && a.type === 'settle') setParts(Object.fromEntries(a.parts.map((p) => [p.invoiceId, String(p.amount)])));
  }).catch((e) => setErr(errText(e, 'This line could not be opened.'))), [id]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!d || !canManage) return undefined;
    const t = setTimeout(() => {
      if (d.txn.type === 'Credit') api.get(`/bank/open-invoices?${qs({ q: needle })}`).then((r) => setInvList(r.data.rows.slice(0, 30))).catch(() => {});
      else api.get(`/bank/auto/open-bills?${qs({ q: needle })}`).then((r) => setBillList(r.data.rows.slice(0, 30))).catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [d, needle, canManage]);

  async function run(fn, done) {
    setBusy(true); setErr('');
    try { const r = await fn(); say(done(r.data)); onChanged(); await load(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  if (!d) return <Modal title="Bank line" onClose={onClose}>{err ? <div className="notice red">{err}</div> : 'Loading…'}</Modal>;
  const t = d.txn; const p = d.proposal;
  const isOpen = ['Unmatched'].includes(t.state) && !d.isDone;
  const settleParts = p && p.action && p.action.type === 'settle' ? p.action.parts : null;
  const partsTotal = Object.values(parts).reduce((s, v) => s + Math.round((Number(v) || 0) * 100), 0) / 100;
  const pickTotal = Object.values(pick).reduce((s, v) => s + Math.round((Number(v) || 0) * 100), 0) / 100;

  return (
    <Modal title={`${t.type === 'Credit' ? 'Money in' : 'Money out'} ${money2(t.amount)} - ${fmtD(t.date)}`} size="wide" onClose={onClose}>
      {err && <div className="notice red" style={{ marginBottom: 8 }}>{err}</div>}
      <div className="ar-kv">
        <div><i>Bank narration</i><b>{t.description}</b></div>
        <div><i>Reference / UTR</i><b>{t.reference || t.externalId || '-'}</b></div>
        <div><i>Value date</i><b>{t.valueDate ? fmtD(t.valueDate) : '-'}</b></div>
        <div><i>Balance after</i><b>{t.balance != null ? money2(t.balance) : '-'}</b></div>
        <div><i>Status</i><b>{t.state}</b></div>
        {t.reviewReason && <div className="ar-wide"><i>Note</i><b>{t.reviewReason}</b></div>}
      </div>

      {p && (
        <div className={`ar-box ${p.band}`}>
          <div className="ar-box-h"><b>{p.action ? 'Suggestion' : 'What we found'}</b> <span className={`ar-pill ${p.band === 'high' ? 'green' : (p.band === 'medium' ? 'blue' : 'orange')}`}>{BAND_LABEL[p.band]}</span> {p.flags.map((f) => <span key={f} className="ar-flag">{FLAG_TEXT[f] || f}</span>)}</div>
          {p.targetLabel && <div>Matches <b>{p.targetLabel}</b>{p.party ? <> - {p.party}</> : null}</div>}
          <div className="ar-nums">
            <span>Bank amount <b>{money2(t.amount)}</b></span>
            {p.bookAmount != null && <span>Book amount <b>{money2(p.bookAmount)}</b></span>}
            {p.allocated != null && <span>Would be matched <b>{money2(p.allocated)}</b></span>}
            {p.difference != null && <span className={p.difference ? 'ar-bad' : ''}>Difference <b>{money2(p.difference)}</b></span>}
          </div>
          <ul className="ar-why">{p.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
          {canManage && p.action && settleParts && (
            <div>
              <div className="small-muted">Amounts to put against each invoice (you can change them):</div>
              {settleParts.map((x) => (
                <div key={x.invoiceId} className="ar-part">
                  <span>{(d.candidates.invoices.find((i) => i.id === x.invoiceId) || {}).invoiceNumber || p.targetLabel}</span>
                  <input type="number" step="0.01" min="0" value={parts[x.invoiceId] ?? ''} onChange={(e) => setParts({ ...parts, [x.invoiceId]: e.target.value })} />
                </div>
              ))}
              <div className="small-muted">Total {money2(partsTotal)}</div>
            </div>
          )}
          {canManage && p.action && (
            <div className="ar-btnrow">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run(() => api.post(`/bank/auto/proposals/${p.id}/approve`, settleParts ? { parts: settleParts.map((x) => ({ invoiceId: x.invoiceId, amount: Number(parts[x.invoiceId] || 0) })).filter((x) => x.amount > 0) } : {}), (r) => `Done: ${r.record || 'matched'}.`)}>Approve this match</button>
              <button type="button" className="btn" disabled={busy} onClick={() => run(() => api.post(`/bank/auto/proposals/${p.id}/reject`, { reason: 'Not right' }), () => 'Suggestion set aside.')}>This is not right</button>
            </div>
          )}
        </div>
      )}

      {d.candidates.invoices.length > 0 && (
        <div><h4 className="ar-h4">Other invoices it could be</h4>
          <div className="tbl-wrap"><table><thead><tr><th>Invoice</th><th>Customer</th><th>Due</th><th className="num">Still owed</th><th>Use</th></tr></thead><tbody>
            {d.candidates.invoices.map((i) => (
              <tr key={i.id}><td>{i.invoiceNumber}</td><td>{i.client}</td><td>{i.dueDate ? fmtD(i.dueDate) : '-'}</td><td className="num">{money2(i.outstanding)}</td>
                <td>{canManage && t.type === 'Credit' && isOpen && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`/bank/auto/txn/${t.id}/manual`, { parts: [{ invoiceId: i.id, amount: Math.min(t.amount, i.outstanding) }] }), (r) => `Done: ${r.record}.`)}>Match this one</button>}
                  {' '}<Link className="link-btn" to={`/invoices/${i.id}`}>View invoice</Link></td></tr>
            ))}</tbody></table></div></div>
      )}
      {d.candidates.bills.length > 0 && (
        <div><h4 className="ar-h4">Other bills it could be</h4>
          <div className="tbl-wrap"><table><thead><tr><th>Bill</th><th>Vendor</th><th>Date</th><th className="num">Amount</th><th>Approval</th><th>Use</th></tr></thead><tbody>
            {d.candidates.bills.map((b) => (
              <tr key={b.id}><td>{b.code || '-'}</td><td>{b.vendor || b.category}</td><td>{b.date ? fmtD(b.date) : '-'}</td><td className="num">{money2(b.net)}</td><td>{b.approval}</td>
                <td>{canManage && t.type === 'Debit' && isOpen && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`/bank/auto/txn/${t.id}/manual`, { billId: b.id }), (r) => `Done: ${r.record}.`)}>Match this one</button>}</td></tr>
            ))}</tbody></table></div></div>
      )}

      {canManage && isOpen && (
        <div className="ar-box">
          <h4 className="ar-h4">Match it yourself</h4>
          <input className="ar-search" placeholder={t.type === 'Credit' ? 'Search open invoices by number, customer or candidate…' : 'Search bills by code, vendor or category…'} value={needle} onChange={(e) => setNeedle(e.target.value)} />
          {t.type === 'Credit' ? (
            <div className="tbl-wrap"><table><thead><tr><th /><th>Invoice</th><th>Customer</th><th className="num">Still owed</th><th className="num">Put against it</th></tr></thead><tbody>
              {invList.map((i) => (
                <tr key={i.id}><td><input type="checkbox" checked={pick[i.id] !== undefined} onChange={(e) => setPick((cur) => { const n = { ...cur }; if (e.target.checked) n[i.id] = String(Math.max(0, Math.min(i.outstanding, t.amount - pickTotal)) || i.outstanding); else delete n[i.id]; return n; })} aria-label={`Use ${i.invoiceNumber}`} /></td>
                  <td>{i.invoiceNumber}</td><td>{i.client}</td><td className="num">{money2(i.outstanding)}</td>
                  <td className="num">{pick[i.id] !== undefined ? <input type="number" step="0.01" min="0" max={i.outstanding} value={pick[i.id]} onChange={(e) => setPick({ ...pick, [i.id]: e.target.value })} className="ar-amt" /> : '-'}</td></tr>
              ))}</tbody></table></div>
          ) : (
            <div className="tbl-wrap"><table><thead><tr><th>Bill</th><th>Vendor</th><th className="num">Amount</th><th>Approval</th><th /></tr></thead><tbody>
              {billList.map((b) => (
                <tr key={b.id}><td>{b.code || '-'}</td><td>{b.vendor || b.category}</td><td className="num">{money2(b.net)}</td><td>{b.approval}</td>
                  <td>{b.canLink ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`/bank/auto/txn/${t.id}/manual`, { billId: b.id }), (r) => `Done: ${r.record}.`)}>Match</button> : <span className="small-muted">Rejected bill</span>}</td></tr>
              ))}</tbody></table></div>
          )}
          {t.type === 'Credit' && (
            <div className="ar-btnrow">
              <span className={pickTotal > t.amount + 0.004 ? 'ar-bad' : 'small-muted'}>{money2(pickTotal)} of {money2(t.amount)} put against invoices{pickTotal > t.amount + 0.004 ? ' - too much' : ''}</span>
              <button type="button" className="btn btn-primary" disabled={busy || pickTotal <= 0 || pickTotal > t.amount + 0.004} onClick={() => run(() => api.post(`/bank/auto/txn/${t.id}/manual`, { parts: Object.entries(pick).map(([invoiceId, amount]) => ({ invoiceId, amount: Number(amount) })).filter((x) => x.amount > 0) }), (r) => `Done: ${r.record}.`)}>Match the ticked invoices</button>
            </div>
          )}
          <div className="ar-btnrow">
            <button type="button" className="btn" disabled={busy} onClick={() => run(() => api.post(`/bank/auto/txn/${t.id}/manual`, { transfer: true }), () => 'Marked as a transfer between your own accounts. It is not income or an expense.')}>This is a transfer between our own accounts</button>
            <input placeholder="Why look into it? (a few words)" value={note} onChange={(e) => setNote(e.target.value)} />
            <button type="button" className="btn" disabled={busy || note.trim().length < 3} onClick={() => run(() => api.post(`/bank/auto/txn/${t.id}/flag`, { note }), () => 'Flagged for a closer look.')}>Flag for a closer look</button>
          </div>
        </div>
      )}

      {d.autoReason && <div className="ar-box high"><b>Matched automatically because:</b> {d.autoReason}</div>}
      {canManage && d.isDone && t.state !== 'Reversed' && (
        <div className="ar-box">
          <h4 className="ar-h4">Undo this match</h4>
          <div className="small-muted">The invoice or bill goes back to how it was before. The reason is kept in the history.</div>
          <div className="ar-btnrow">
            <input placeholder="Why are you undoing it?" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button type="button" className="btn" disabled={busy || reason.trim().length < 3} onClick={() => run(() => api.post(`/bank/auto/txn/${t.id}/unreconcile`, { reason }), () => 'Match undone. Everything is back as it was.')}>Undo match</button>
          </div>
        </div>
      )}

      {d.detail && (d.detail.allocations || []).length > 0 && (
        <div><h4 className="ar-h4">What it is matched to now</h4>
          <div className="tbl-wrap"><table><thead><tr><th>Invoice</th><th>Customer</th><th>Date</th><th className="num">Amount</th><th /></tr></thead><tbody>
            {d.detail.allocations.map((a) => <tr key={a.paymentId}><td>{a.invoiceNumber}</td><td>{a.client}</td><td>{fmtD(a.date)}</td><td className="num">{money2(a.amount)}</td><td>{a.invoiceId && <Link className="link-btn" to={`/invoices/${a.invoiceId}`}>View invoice</Link>}</td></tr>)}
          </tbody></table></div></div>
      )}

      <h4 className="ar-h4">History</h4>
      {d.events.length === 0 ? <div className="small-muted">Nothing recorded yet.</div> : (
        <ul className="ar-hist">
          {d.events.map((e) => (
            <li key={e.id}><b>{e.action}</b> <span className="small-muted">{String(e.at).slice(0, 16).replace('T', ' ')} - {e.auto ? 'automatic' : e.actorName}</span>
              {e.reason && <div className="small-muted">{e.reason}</div>}</li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------- Reconcile existing
function RunTab({ accounts, canManage, settings, say, openList, onChanged }) {
  const [acc, setAcc] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [pv, setPv] = useState(null);
  const [runs, setRuns] = useState([]);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);

  const loadRuns = useCallback(() => api.get('/bank/auto/runs').then((r) => { setRuns(r.data.runs); return r.data.runs; }).catch(() => []), []);
  useEffect(() => {
    api.get(`/bank/auto/preview?${qs({ bankAccountId: acc, from, to })}`).then((r) => setPv(r.data.preview)).catch(() => setPv(null));
  }, [acc, from, to, runs.length]);
  useEffect(() => {
    loadRuns();
    const tick = async () => {
      const list = await loadRuns();
      const live = list.some((r) => ['Running', 'Queued'].includes(r.status) && !r.interrupted);
      timer.current = setTimeout(tick, live ? 1500 : 6000);
    };
    timer.current = setTimeout(tick, 1500);
    return () => clearTimeout(timer.current);
  }, [loadRuns]);

  async function start(dryRun) {
    setBusy(true);
    try { await api.post('/bank/auto/runs', { dryRun, bankAccountId: acc || undefined, from: from || undefined, to: to || undefined }); say(dryRun ? 'Try-out started. Nothing will be changed.' : 'Started. You can leave this page; it keeps going.'); loadRuns(); } catch (e) { say(errText(e), true); } finally { setBusy(false); }
  }
  const act = async (id, verb) => { try { await api.post(`/bank/auto/runs/${id}/${verb}`); loadRuns(); } catch (e) { say(errText(e), true); } };
  const live = runs.some((r) => ['Running', 'Queued'].includes(r.status) && !r.interrupted);

  return (
    <div>
      <div className="ar-intro">
        Look at the bank lines that are <b>already in the system</b> and match them with your invoices, bills and expenses - no need to upload anything again.
        Start with <b>Try it first</b>: it only writes suggestions and changes nothing. {settings && !settings.autoReconcile && <>Right now <b>Auto-reconcile is off</b>, so even <b>Reconcile now</b> only makes suggestions.</>}
      </div>
      <div className="ar-filters">
        <label className="ar-f">Bank account<Combo value={acc} onChange={(e) => setAcc(e.target.value)}><option value="">All accounts</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</Combo></label>
        <label className="ar-f">From (optional)<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="ar-f">To (optional)<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      {pv && (
        <div className="ar-cards small">
          <div className="ar-card"><b>{pv.bankAccounts}</b><span>Bank accounts</span></div>
          <div className="ar-card"><b>{pv.statements}</b><span>Statements imported</span></div>
          <div className="ar-card blue"><b>{pv.toScan.toLocaleString('en-IN')}</b><span>Lines to look at</span></div>
          <div className="ar-card"><b>{pv.toCheck.toLocaleString('en-IN')}</b><span>Matched lines to double-check</span></div>
          <div className="ar-card"><b>{pv.openInvoices}</b><span>Invoices still owed</span></div>
          <div className="ar-card"><b>{pv.unlinkedBills}</b><span>Bills / expenses not tied to a bank line</span></div>
          <div className="ar-card"><b>{pv.unlinkedReceipts}</b><span>Receipts not tied to a bank line</span></div>
          <div className="ar-card wide"><b>{pv.dateFrom ? `${fmtD(pv.dateFrom)} - ${fmtD(pv.dateTo)}` : '-'}</b><span>Dates covered</span></div>
          <div className="ar-card wide"><b>{money2(pv.debitTotal)} out / {money2(pv.creditTotal)} in</b><span>Value of lines to look at</span></div>
        </div>
      )}
      {canManage ? (
        <div className="ar-btnrow">
          <button type="button" className="btn btn-primary" disabled={busy || live || !pv || !pv.toScan} onClick={() => start(true)}>Try it first (nothing changes)</button>
          <button type="button" className="btn" disabled={busy || live || !pv || !pv.toScan} onClick={() => start(false)}>{settings && settings.autoReconcile ? 'Reconcile now (sure matches are applied)' : 'Reconcile now (suggestions only)'}</button>
          {live && <span className="small-muted">A run is going. Wait for it to finish.</span>}
        </div>
      ) : <div className="small-muted">You can look at results, but starting a run needs permission to edit Bank &amp; Reconciliation.</div>}

      <h3 className="ar-h3">Runs</h3>
      {runs.length === 0 ? <div className="card section">No run yet.</div> : runs.map((r) => {
        const c = r.counts || {};
        const paused = r.interrupted || ['Paused', 'Cancelled', 'Failed'].includes(r.status);
        return (
          <div className="ar-run" key={r.id}>
            <div className="ar-run-h">
              <b>{r.dryRun ? 'Try-out' : 'Real run'}</b> <span className={`ar-pill ${r.status === 'Done' ? 'green' : (paused ? 'orange' : 'blue')}`}>{r.interrupted ? 'Stopped - can continue' : r.status}</span>
              <span className="small-muted"> {String(r.createdAt).slice(0, 16).replace('T', ' ')} by {r.startedByName || '-'}{r.bankAccountId ? '' : ' - all accounts'}{r.fromDate ? ` - ${fmtD(r.fromDate)}` : ''}{r.toDate ? ` to ${fmtD(r.toDate)}` : ''}</span>
            </div>
            {r.status !== 'Done' && <div className="ar-bar"><div style={{ width: `${r.percent}%` }} /></div>}
            <div className="small-muted">{r.processed.toLocaleString('en-IN')} of {r.total.toLocaleString('en-IN')} looked at ({r.percent}%){r.error ? ` - ${r.error}` : ''}</div>
            <div className="ar-res">
              <span>Matched automatically <b>{c.autoMatched || 0}</b></span><span>Sure, waiting for you <b>{c.wouldAutoMatch || 0}</b></span><span>Probably <b>{c.suggested || 0}</b></span>
              <span>Partly matched <b>{c.partial || 0}</b></span><span>Need a look <b>{c.needsReview || 0}</b></span><span>Not matched <b>{c.unmatched || 0}</b></span>
              <span>Possible duplicates <b>{c.duplicates || 0}</b></span><span>Amount does not agree <b>{c.mismatches || 0}</b></span><span>Old matches to double-check <b>{c.flaggedExisting || 0}</b></span>
              <span>Money out looked at <b>{money2((c.debitPaise || 0) / 100)}</b></span><span>Money in looked at <b>{money2((c.creditPaise || 0) / 100)}</b></span>
            </div>
            <div className="ar-btnrow">
              {canManage && paused && r.status !== 'Done' && <button type="button" className="btn btn-primary btn-sm" onClick={() => act(r.id, 'resume')}>Continue from where it stopped</button>}
              {canManage && !paused && r.status !== 'Done' && <button type="button" className="btn btn-sm" onClick={() => act(r.id, 'cancel')}>Stop</button>}
              {r.status === 'Done' && <button type="button" className="btn btn-sm" onClick={() => { openList({ status: 'suggested', bankAccountId: r.bankAccountId || '' }); }}>See what it found</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------- Rules
function Rules({ settings, canEdit, say, reload }) {
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (settings) setF({ ...settings, tdsText: (settings.tdsRates || []).join(', ') }); }, [settings]);
  if (!f) return <div className="small-muted">Loading…</div>;
  const dirty = JSON.stringify({ ...f, tdsText: undefined, tdsRates: undefined }) !== JSON.stringify({ ...settings, tdsText: undefined, tdsRates: undefined }) || f.tdsText !== (settings.tdsRates || []).join(', ');
  async function save() {
    setBusy(true);
    try {
      const body = {
        autoReconcile: f.autoReconcile, dateToleranceDays: Number(f.dateToleranceDays), roundingRupees: Number(f.roundingRupees), bankFeeMaxRupees: Number(f.bankFeeMaxRupees),
        tdsRates: String(f.tdsText || '').split(/[ ,]+/).map(Number).filter((n) => n > 0), batchSize: Number(f.batchSize),
      };
      await api.put('/bank/auto/settings', body);
      say('Saved. The change is written to the history.'); reload();
    } catch (e) { say(errText(e), true); } finally { setBusy(false); }
  }
  const num = (k, label, hint, props = {}) => (
    <label className="ar-rule"><span><b>{label}</b><i>{hint}</i></span>
      <input type="number" disabled={!canEdit} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...props} /></label>
  );
  return (
    <div>
      {!canEdit && <div className="notice">Only an Admin can change these rules. You can read them here.</div>}
      <div className={`ar-box ${f.autoReconcile ? 'high' : ''}`}>
        <label className="ar-switch">
          <input type="checkbox" disabled={!canEdit} checked={!!f.autoReconcile} onChange={(e) => setF({ ...f, autoReconcile: e.target.checked })} />
          <span><b>Do sure matches for me (Auto-reconcile)</b>
            <i>{f.autoReconcile ? 'ON: when a bank line matches one invoice or bill for certain, it is matched for you. You can always undo it, with a reason.' : 'OFF: nothing changes by itself. Every match is a suggestion you approve.'}</i></span>
        </label>
        <div className="small-muted">Even when this is ON, these are never done automatically: matching on the amount alone, two or more possible matches, a bill that is not approved yet, a line marked as a possible duplicate, a closed month, or an amount that does not agree.</div>
      </div>
      <div className="ar-rules">
        {num('dateToleranceDays', 'Days apart allowed', 'Bill date versus bank date (0 to 15 days)', { min: 0, max: 15 })}
        {num('roundingRupees', 'Rounding allowed (rupees)', 'A difference this small is treated as rounding', { min: 0, max: 100, step: '0.5' })}
        {num('bankFeeMaxRupees', 'Bank fee allowed (rupees)', 'A payment short by up to this is suggested as "bank fee deducted"', { min: 0, max: 5000 })}
        <label className="ar-rule"><span><b>TDS rates to look for (%)</b><i>A payment short by exactly this % of the invoice is suggested as "TDS deducted"</i></span>
          <input disabled={!canEdit} value={f.tdsText} onChange={(e) => setF({ ...f, tdsText: e.target.value })} /></label>
        {num('batchSize', 'Lines per step in a big run', 'Bigger is faster, smaller is gentler (20 to 1000)', { min: 20, max: 1000 })}
      </div>
      {canEdit && <div className="ar-btnrow"><button type="button" className="btn btn-primary" disabled={busy || !dirty} onClick={save}>Save rules</button></div>}
      <h3 className="ar-h3">How a match is decided</h3>
      <ol className="ar-ladder">
        <li><b>Sure:</b> the bank reference (UTR) is on a recorded receipt or bill, with the exact amount.</li>
        <li><b>Sure:</b> the invoice number is in the bank narration, the customer agrees, and the amount fits.</li>
        <li><b>Sure:</b> the customer or vendor is named, exactly one record has exactly this amount, and the date is close.</li>
        <li><b>Probably:</b> one record fits but a small thing is off (date, rounding, bank fee, TDS). You approve it.</li>
        <li><b>Not sure:</b> only the amount or a similar name matches, or several records fit. You choose.</li>
      </ol>
    </div>
  );
}
