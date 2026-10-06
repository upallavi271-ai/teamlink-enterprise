// Accounts → Journal & Ledger tabs (spec S2 / S3, 2026-10-05):
//   JournalTab        every entry · Source column + filter (Manual / HRMS
//                     Payroll / HRMS Assets) · Payroll badge · read-only,
//                     reversal only · voucher no. · "View in HRMS"
//   LedgerTab         per-account opening / Dr / Cr / closing, and one
//                     account's lines with the running balance
//   BooksReportsTab   Trial Balance · Profit & Loss · Balance Sheet
//   PayrollMappingTab the payroll component → ledger mapping, the payroll
//                     months (Posted / Not posted / Paid) and "Books closed up to"
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../../api';
import { Panel, PanelHead, EmptyMini } from '../proto.jsx';
import { money, monthLabel, errText, downloadFile } from '../payroll/payrollUi';
import PeriodPicker, { ALL_TIME, isAllTime, periodText } from './PeriodPicker.jsx';
import PayrollAccountsStrip from '../payroll/PayrollAccountsStrip.jsx';
import Pager, { usePaged } from '../Pager.jsx';
import { FacetSelect } from '../ui/ListPageHeader.jsx';
import './ledgerBooks.css';

export const periodQs = (v) => (isAllTime(v) ? '' : `from=${v.from}&to=${v.to}`);
const join = (...parts) => parts.filter(Boolean).join('&');
const SOURCES = [['MANUAL', 'Manual'], ['HRMS_PAYROLL', 'HRMS Payroll'], ['HRMS_ASSETS', 'HRMS Assets']];

export function useChart() {
  const [accounts, setAccounts] = useState([]);
  useEffect(() => { api.get('/accounts/chart-of-accounts').then((r) => setAccounts(r.data)).catch(() => setAccounts([])); }, []);
  return accounts;
}

function SourceBadge({ e }) {
  if (e.source === 'HRMS_PAYROLL') return <span className="lb-badge blue">Payroll</span>;
  if (e.source === 'HRMS_ASSETS') return <span className="lb-badge blue">Assets</span>;
  return <span className="lb-badge grey">Manual</span>;
}

// ---- Journal -------------------------------------------------------------------------
export function JournalTab({ canPost = false }) {
  const accounts = useChart();
  const [params, setParams] = useSearchParams();
  const jeParam = params.get('je');
  const [period, setPeriod] = useState(ALL_TIME);
  const [source, setSource] = useState('');
  const [account, setAccount] = useState('');
  const [search, setSearch] = useState('');
  const [searchDeb, setSearchDeb] = useState('');
  const [data, setData] = useState(null);
  const [open, setOpen] = useState({});
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => { const t = setTimeout(() => setSearchDeb(search.trim()), 300); return () => clearTimeout(t); }, [search]);
  const qs = () => join(periodQs(period), source && `source=${source}`, account && `account=${account}`, searchDeb && `search=${encodeURIComponent(searchDeb)}`, jeParam && `id=${jeParam}`);
  function load() {
    setError('');
    api.get(`/accounts/journal-entries?${qs()}`).then((r) => {
      setData(r.data);
      if (jeParam && r.data.entries[0]) setOpen({ [r.data.entries[0].id]: true });
    }).catch((err) => setError(errText(err, 'Could not load the journal.')));
  }
  useEffect(load, [period, source, account, searchDeb, jeParam]); // eslint-disable-line react-hooks/exhaustive-deps
  const page = usePaged(data?.entries || []);
  const filtered = !isAllTime(period) || source || account || search.trim() || jeParam;
  const clearAll = () => { setPeriod(ALL_TIME); setSource(''); setAccount(''); setSearch(''); if (jeParam) setParams({}); };
  async function reverse(e) {
    const reason = window.prompt(e.source === 'HRMS_PAYROLL'
      ? `Reverse "${e.narration}"? A reversal entry is booked and HRMS shows the month as "Not posted" again. Why?`
      : `Reverse "${e.narration}"? A mirror entry is booked; the original stays. Why?`);
    if (!reason) return;
    setMsg(''); setError('');
    try {
      const r = await api.post(`/accounts/journal-entries/${e.id}/reverse`, { reason });
      setMsg(`Reversed — ${r.data.voucherNo || 'the reversal'} is booked.`);
      load();
    } catch (err) { setError(errText(err, 'Could not reverse it.')); }
  }
  const sourceOptions = SOURCES.map(([value, label]) => ({ value, label, count: data?.bySource?.[value] || 0 }));
  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title="Journal">
        <button type="button" className="btn btn-sm" onClick={() => downloadFile(`/accounts/journal-entries?${join(qs(), 'format=xlsx')}`, 'journal.xlsx').catch((e) => setError(errText(e, 'Export failed')))}>Export Excel</button>
      </PanelHead>
      <div className="lb-filters">
        <PeriodPicker value={period} onChange={setPeriod} presets />
        <FacetSelect label="Source" value={source} onChange={setSource} options={sourceOptions} allLabel="All sources" />
        <label className="lb-f"><span>Account</span>
          <select value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="">All accounts</option>
            {accounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
          </select>
        </label>
        <label className="lb-f"><span>Search</span><input type="search" placeholder="Narration, voucher, asset…" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        {filtered && <button type="button" className="btn btn-sm" onClick={clearAll}>Clear filters</button>}
        {data && <span className="lb-note" style={{ marginLeft: 'auto' }}>{data.count} entr{data.count === 1 ? 'y' : 'ies'} · Dr {money(data.totals.debit)} · Cr {money(data.totals.credit)}</span>}
      </div>
      {jeParam && <div className="lb-ok">Showing one entry. <button type="button" className="link-btn" onClick={() => setParams({})}>Show all</button></div>}
      {error && <div className="lb-err">{error}</div>}
      {msg && <div className="lb-ok">{msg}</div>}
      {!data ? <EmptyMini>Loading…</EmptyMini> : data.entries.length === 0 ? (
        <EmptyMini>{filtered ? <>No journal entries match these filters. <button type="button" className="link-btn" onClick={clearAll}>Clear filters</button></> : 'No journal entries yet.'}</EmptyMini>
      ) : (
        <>
          <div className="tbl-wrap">
            <table className="lb-tbl">
              <thead><tr><th>Voucher</th><th>Date</th><th>Narration</th><th>Source</th><th className="lb-num">Debit</th><th className="lb-num">Credit</th><th /></tr></thead>
              <tbody>
                {page.slice.map((e) => (
                  <Fragment key={e.id}>
                    <tr>
                      <td><b>{e.voucherNo}</b><div className="lb-note">{e.voucherType}</div></td>
                      <td>{e.date}</td>
                      <td style={{ whiteSpace: 'normal', minWidth: 220 }}>
                        {e.narration || '—'}
                        <div>
                          {e.isReversal && <span className="lb-badge orange">Reversal of {e.reversesVoucherNo}</span>}
                          {e.reversedById && <span className="lb-badge orange">Reversed by {e.reversedByVoucherNo}</span>}
                          {e.readOnly && <span className="lb-badge grey">Read-only</span>}
                        </div>
                      </td>
                      <td><SourceBadge e={e} /></td>
                      <td className="lb-num">{money(e.totalDebit)}</td>
                      <td className="lb-num">{money(e.totalCredit)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button type="button" className="btn btn-sm" onClick={() => setOpen((o) => ({ ...o, [e.id]: !o[e.id] }))}>{open[e.id] ? 'Hide' : 'Lines'}</button>
                        {e.canReverse && canPost && <> <button type="button" className="btn btn-sm" onClick={() => reverse(e)}>Reverse</button></>}
                        {e.payrollMonth && <> <Link className="btn btn-sm" to="/payroll">View in HRMS</Link></>}
                        {e.source === 'HRMS_ASSETS' && e.referenceType !== 'ASSET_DEPRECIATION' && <> <Link className="btn btn-sm" to="/employee-services?tab=assets">View in HRMS</Link></>}
                      </td>
                    </tr>
                    {open[e.id] && (
                      <tr>
                        <td colSpan="7" style={{ padding: 0 }}>
                          <table className="jl-lines">
                            <tbody>
                              {e.lines.map((l) => (
                                <tr key={l.id}>
                                  <td style={{ paddingLeft: l.credit ? 36 : 10 }}>{l.credit ? 'Cr' : 'Dr'} {l.accountCode} · {l.accountName}{l.memo ? <span className="lb-note"> — {l.memo}</span> : null}</td>
                                  <td className="num">{l.debit ? money(l.debit) : ''}</td>
                                  <td className="num">{l.credit ? money(l.credit) : ''}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {data.entries.length > 25 && <Pager page={page} noun="entries" />}
        </>
      )}
    </Panel>
  );
}

// ---- Ledger --------------------------------------------------------------------------
export function LedgerTab() {
  const accounts = useChart();
  const [period, setPeriod] = useState(ALL_TIME);
  const [account, setAccount] = useState('');
  const [group, setGroup] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const q = join(periodQs(period), account && `account=${account}`);
  useEffect(() => {
    setError('');
    api.get(`/accounts/ledger?${q}`).then((r) => setData(r.data)).catch((err) => setError(errText(err, 'Could not load the ledger.')));
  }, [q]);
  const all = data?.summary || [];
  const groupOptions = useMemo(() => {
    const m = new Map();
    all.forEach((r) => m.set(r.group, (m.get(r.group) || 0) + 1));
    return [...m.entries()].map(([value, count]) => ({ value, label: value, count }));
  }, [all]);
  const shown = all.filter((r) => (!group || r.group === group) && (account || r.lines > 0 || r.opening));
  const linePage = usePaged(data?.lines || []);
  const acct = account ? all[0] : null;
  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title="Ledger">
        <button type="button" className="btn btn-sm" onClick={() => downloadFile(`/accounts/ledger?${join(q, 'format=xlsx')}`, 'ledger.xlsx').catch((e) => setError(errText(e, 'Export failed')))}>Export Excel</button>
      </PanelHead>
      <div className="lb-filters">
        <PeriodPicker value={period} onChange={setPeriod} presets />
        {!account && <FacetSelect label="Group" value={group} onChange={setGroup} options={groupOptions} allLabel="All groups" />}
        <label className="lb-f"><span>Account</span>
          <select value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="">All accounts</option>
            {accounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
          </select>
        </label>
        {(account || group || !isAllTime(period)) && <button type="button" className="btn btn-sm" onClick={() => { setAccount(''); setGroup(''); setPeriod(ALL_TIME); }}>Clear filters</button>}
      </div>
      {error && <div className="lb-err">{error}</div>}
      {!data ? <EmptyMini>Loading…</EmptyMini> : !account ? (
        shown.length === 0 ? <EmptyMini>No postings for {isAllTime(period) ? 'any period' : periodText(period)} yet.</EmptyMini> : (
          <div className="tbl-wrap">
            <table className="lb-tbl">
              <thead><tr><th>Code</th><th>Account</th><th>Group</th><th className="lb-num">Opening</th><th className="lb-num">Debit</th><th className="lb-num">Credit</th><th className="lb-num">Closing</th><th /></tr></thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.code}>
                    <td><b>{r.code}</b></td><td>{r.name}</td><td className="cell-muted">{r.group}</td>
                    <td className="lb-num">{money(r.opening)}</td><td className="lb-num">{money(r.debit)}</td><td className="lb-num">{money(r.credit)}</td><td className="lb-num"><b>{money(r.balance)}</b></td>
                    <td><button type="button" className="btn btn-sm" onClick={() => setAccount(r.code)}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <>
          {acct && (
            <div className="lb-cards">
              <div className="lb-card"><div className="v">{money(acct.opening)}</div><div className="l">Opening balance</div></div>
              <div className="lb-card"><div className="v">{money(acct.debit)}</div><div className="l">Debits in the period</div></div>
              <div className="lb-card"><div className="v">{money(acct.credit)}</div><div className="l">Credits in the period</div></div>
              <div className="lb-card"><div className="v">{money(acct.balance)}</div><div className="l">Closing balance · {acct.group}</div></div>
            </div>
          )}
          {(data.lines || []).length === 0 ? <EmptyMini>No postings to this account in the period.</EmptyMini> : (
            <div className="tbl-wrap">
              <table className="lb-tbl">
                <thead><tr><th>Date</th><th>Voucher</th><th>Particulars</th><th>Asset</th><th className="lb-num">Debit</th><th className="lb-num">Credit</th><th className="lb-num">Balance</th></tr></thead>
                <tbody>
                  {linePage.slice.map((l) => (
                    <tr key={l.id}>
                      <td>{l.date}</td>
                      <td><Link to={`/accounts/journal?je=${l.journalEntryId}`}>{l.voucherNo}</Link></td>
                      <td style={{ whiteSpace: 'normal', minWidth: 220 }}>{l.narration}{l.memo ? <div className="lb-note">{l.memo}</div> : null}</td>
                      <td>{l.asset ? <><b>{l.asset.code}</b> · {l.asset.name}{l.asset.holder ? <div className="lb-note">{l.asset.holder}</div> : null}</> : <span className="cell-muted">—</span>}</td>
                      <td className="lb-num">{l.debit ? money(l.debit) : ''}</td>
                      <td className="lb-num">{l.credit ? money(l.credit) : ''}</td>
                      <td className="lb-num"><b>{money(l.balance)}</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(data.lines || []).length > 25 && <Pager page={linePage} noun="postings" />}
        </>
      )}
    </Panel>
  );
}

// ---- Reports: Trial Balance · Profit & Loss · Balance Sheet ---------------------------------
export function BooksReportsTab() {
  const [which, setWhich] = useState('tb');
  const [period, setPeriod] = useState(ALL_TIME);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const url = which === 'tb' ? `/accounts/reports/trial-balance?${periodQs(period)}`
    : which === 'pl' ? `/accounts/reports/profit-loss?${periodQs(period)}`
      : `/accounts/reports/balance-sheet?${isAllTime(period) ? '' : `asOf=${period.to}`}`;
  useEffect(() => {
    setData(null); setError('');
    api.get(url).then((r) => setData(r.data)).catch((err) => setError(errText(err, 'Could not load the report.')));
  }, [url]);
  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title="Reports from the journal">
        {which !== 'bs' && <button type="button" className="btn btn-sm" onClick={() => downloadFile(`${url}&format=xlsx`, `${which === 'tb' ? 'trial-balance' : 'profit-loss'}.xlsx`).catch((e) => setError(errText(e, 'Export failed')))}>Export Excel</button>}
      </PanelHead>
      <div className="lb-sub">
        {[['tb', 'Trial Balance'], ['pl', 'Profit & Loss'], ['bs', 'Balance Sheet']].map(([k, l]) => (
          <button key={k} type="button" className={`btn btn-sm ${which === k ? 'on' : ''}`} onClick={() => setWhich(k)}>{l}</button>
        ))}
      </div>
      <div className="lb-filters">
        <PeriodPicker value={period} onChange={setPeriod} presets label={which === 'bs' ? 'As on (end of)' : 'Period'} />
      </div>
      {error && <div className="lb-err">{error}</div>}
      {!data ? <EmptyMini>{error ? '' : 'Loading…'}</EmptyMini> : which === 'tb' ? (
        data.rows.length === 0 ? <EmptyMini>Nothing booked in this period yet.</EmptyMini> : (
          <div className="tbl-wrap">
            <table className="lb-tbl">
              <thead><tr><th>Code</th><th>Account</th><th>Group</th><th className="lb-num">Opening Dr</th><th className="lb-num">Opening Cr</th><th className="lb-num">Debit</th><th className="lb-num">Credit</th><th className="lb-num">Closing Dr</th><th className="lb-num">Closing Cr</th></tr></thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.code}><td><b>{r.code}</b></td><td>{r.name}</td><td className="cell-muted">{r.group}</td>
                    <td className="lb-num">{r.openingDr ? money(r.openingDr) : ''}</td><td className="lb-num">{r.openingCr ? money(r.openingCr) : ''}</td>
                    <td className="lb-num">{r.debit ? money(r.debit) : ''}</td><td className="lb-num">{r.credit ? money(r.credit) : ''}</td>
                    <td className="lb-num">{r.closingDr ? money(r.closingDr) : ''}</td><td className="lb-num">{r.closingCr ? money(r.closingCr) : ''}</td></tr>
                ))}
                <tr className="lb-tot"><td colSpan="3">TOTAL {data.totals.balanced ? <span className="lb-badge green">Balanced</span> : <span className="lb-badge red">Does not balance</span>}</td>
                  <td className="lb-num">{money(data.totals.openingDr)}</td><td className="lb-num">{money(data.totals.openingCr)}</td>
                  <td className="lb-num">{money(data.totals.debit)}</td><td className="lb-num">{money(data.totals.credit)}</td>
                  <td className="lb-num">{money(data.totals.closingDr)}</td><td className="lb-num">{money(data.totals.closingCr)}</td></tr>
              </tbody>
            </table>
          </div>
        )
      ) : which === 'pl' ? (
        <>
          <div className="lb-cards">
            <div className="lb-card"><div className="v">{money(data.totalIncome)}</div><div className="l">Income</div></div>
            <div className="lb-card"><div className="v">{money(data.totalExpenses)}</div><div className="l">Expenses (payroll {money(data.payrollCost)})</div></div>
            <div className="lb-card"><div className="v">{money(data.netProfit)}</div><div className="l">{data.netProfit >= 0 ? 'Profit' : 'Loss'}</div></div>
          </div>
          <div className="tbl-wrap">
            <table className="lb-tbl">
              <tbody>
                <tr className="lb-grp"><td colSpan="2">Income</td><td /></tr>
                {data.income.length === 0 && <tr><td colSpan="3" className="cell-muted">No income booked in the journal for this period.</td></tr>}
                {data.income.map((r) => <tr key={r.code}><td>{r.code}</td><td>{r.name}</td><td className="lb-num">{money(r.amount)}</td></tr>)}
                <tr className="lb-tot"><td colSpan="2">Total income</td><td className="lb-num">{money(data.totalIncome)}</td></tr>
                <tr className="lb-grp"><td colSpan="2">Expenses</td><td /></tr>
                {data.expenses.length === 0 && <tr><td colSpan="3" className="cell-muted">No expenses booked in the journal for this period.</td></tr>}
                {data.expenses.map((r) => <tr key={r.code}><td>{r.code}</td><td>{r.name}{r.payroll ? <span className="lb-badge blue" style={{ marginLeft: 6 }}>Payroll</span> : null}</td><td className="lb-num">{money(r.amount)}</td></tr>)}
                <tr className="lb-tot"><td colSpan="2">Total expenses</td><td className="lb-num">{money(data.totalExpenses)}</td></tr>
                <tr className="lb-tot"><td colSpan="2">{data.netProfit >= 0 ? 'Net profit' : 'Net loss'}</td><td className="lb-num">{money(data.netProfit)}</td></tr>
              </tbody>
            </table>
          </div>
          <div className="lb-note" style={{ padding: '8px 18px 14px' }}>{data.note}</div>
        </>
      ) : (
        <>
          <div className="lb-cards">
            <div className="lb-card"><div className="v">{money(data.totalAssets)}</div><div className="l">Assets</div></div>
            <div className="lb-card"><div className="v">{money(data.totalLiabilities)}</div><div className="l">Liabilities</div></div>
            <div className="lb-card"><div className="v">{money(data.totalEquity)}</div><div className="l">Capital + profit to date</div></div>
            <div className="lb-card"><div className="v">{data.balanced ? 'Yes' : 'No'}</div><div className="l">Balanced</div></div>
          </div>
          <div className="tbl-wrap">
            <table className="lb-tbl">
              <tbody>
                <tr className="lb-grp"><td>Fixed assets (net of depreciation)</td><td className="lb-num">Cost</td><td className="lb-num">Acc. depreciation</td><td className="lb-num">Net</td></tr>
                {data.fixedAssets.length === 0 && <tr><td colSpan="4" className="cell-muted">No fixed assets in the books yet.</td></tr>}
                {data.fixedAssets.map((r) => <tr key={r.code}><td>{r.name}</td><td className="lb-num">{money(r.gross)}</td><td className="lb-num">{money(r.accumulatedDepreciation)}</td><td className="lb-num">{money(r.net)}</td></tr>)}
                <tr className="lb-tot"><td colSpan="3">Fixed assets, net</td><td className="lb-num">{money(data.fixedAssetsNet)}</td></tr>
                <tr className="lb-grp"><td colSpan="3">Current assets</td><td /></tr>
                {data.currentAssets.map((r) => <tr key={r.code}><td colSpan="3">{r.name} <span className="lb-note">{r.group}</span></td><td className="lb-num">{money(r.amount)}</td></tr>)}
                <tr className="lb-tot"><td colSpan="3">Total assets</td><td className="lb-num">{money(data.totalAssets)}</td></tr>
                <tr className="lb-grp"><td colSpan="3">Current liabilities</td><td /></tr>
                {data.liabilities.map((r) => <tr key={r.code}><td colSpan="3">{r.name}</td><td className="lb-num">{money(r.amount)}</td></tr>)}
                <tr className="lb-tot"><td colSpan="3">Total liabilities</td><td className="lb-num">{money(data.totalLiabilities)}</td></tr>
                <tr className="lb-grp"><td colSpan="3">Capital</td><td /></tr>
                {data.equity.map((r) => <tr key={r.code}><td colSpan="3">{r.name}</td><td className="lb-num">{money(r.amount)}</td></tr>)}
                <tr><td colSpan="3">Profit / (loss) to date</td><td className="lb-num">{money(data.profitToDate)}</td></tr>
                <tr className="lb-tot"><td colSpan="3">Total capital + liabilities</td><td className="lb-num">{money(data.totalEquity + data.totalLiabilities)}</td></tr>
              </tbody>
            </table>
          </div>
          <div className="lb-note" style={{ padding: '8px 18px 14px' }}>{data.note}</div>
        </>
      )}
    </Panel>
  );
}

// ---- Payroll Mapping (+ payroll months, books closed) ------------------------------------------
export function PayrollMappingTab() {
  const [m, setM] = useState(null);
  const [draft, setDraft] = useState({});
  const [months, setMonths] = useState(null);
  const [pick, setPick] = useState('');
  const [closed, setClosed] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  function load() {
    api.get('/accounts/payroll-mapping').then((r) => { setM(r.data); setDraft(r.data.map); }).catch((err) => setError(errText(err, 'Could not load the mapping.')));
    api.get('/accounts/payroll-months').then((r) => { setMonths(r.data.months); if (!pick && r.data.months[0]) setPick(r.data.months[0].month); }).catch(() => setMonths([]));
    api.get('/accounts/settings/books-closed').then((r) => setClosed(r.data.closedUpTo || '')).catch(() => {});
  }
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = m && Object.keys(draft).some((k) => draft[k] !== m.map[k]);
  async function save() {
    setBusy(true); setMsg(''); setError('');
    try { const r = await api.put('/accounts/payroll-mapping', { map: draft }); setM((x) => ({ ...x, ...r.data, problem: null })); setDraft(r.data.map); setMsg('Saved — payroll will post to these ledgers.'); } catch (err) { setError(errText(err, 'Could not save the mapping.')); } finally { setBusy(false); }
  }
  async function saveClosed(v) {
    setMsg(''); setError('');
    try { const r = await api.put('/accounts/settings/books-closed', { closedUpTo: v || null }); setClosed(r.data.closedUpTo || ''); setMsg(v ? `Saved — books closed up to ${monthLabel(v)}.` : 'Saved — no month is closed.'); } catch (err) { setError(errText(err, 'Could not save.')); }
  }
  if (!m) return <Panel style={{ marginTop: 16 }}>{error ? <div className="lb-err">{error}</div> : <EmptyMini>Loading…</EmptyMini>}</Panel>;
  const accountsFor = (c) => m.accounts.filter((a) => a.isActive && (!c.expects || a.type === c.expects));
  return (
    <>
      <Panel style={{ marginTop: 16 }}>
        <PanelHead title="Payroll months in Accounts" />
        {!months ? <EmptyMini>Loading…</EmptyMini> : months.length === 0 ? <EmptyMini>No payroll has been run with per-employee records yet.</EmptyMini> : (
          <>
            <div className="tbl-wrap">
              <table className="lb-tbl">
                <thead><tr><th>Month</th><th>Records</th><th className="lb-num">Net pay</th><th>Accounts</th><th /></tr></thead>
                <tbody>
                  {months.map((x) => (
                    <tr key={x.month}>
                      <td><b>{x.period}</b></td>
                      <td className="cell-muted">{x.records}{x.notFinal ? ` · ${x.notFinal} not approved` : ''}</td>
                      <td className="lb-num">{money(x.net)}</td>
                      <td>{x.paid ? <span className="lb-badge green">Paid</span> : x.posted ? <span className="lb-badge green">Posted to Accounts</span> : x.lastError ? <span className="lb-badge red">Not posted — problem</span> : <span className="lb-badge grey">Not posted</span>}</td>
                      <td><button type="button" className="btn btn-sm" onClick={() => setPick(x.month)}>{pick === x.month ? 'Open ✓' : 'Open'}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pick && <PayrollAccountsStrip month={pick} onChanged={load} />}
          </>
        )}
      </Panel>
      <Panel style={{ marginTop: 16 }}>
        <PanelHead title="Payroll Mapping — which ledger each part goes to">
          {m.canEdit && <button type="button" className="btn btn-primary btn-sm" disabled={!changed || busy} onClick={save}>{busy ? 'Saving…' : 'Save mapping'}</button>}
        </PanelHead>
        <div className="lb-note" style={{ padding: '10px 18px 0' }}>
          One journal is booked per payroll month. Expenses go under <b>Expenses</b>, payables under <b>Current Liabilities</b>. {m.updatedByName ? `Last changed by ${m.updatedByName}.` : 'These are the default ledgers.'}
        </div>
        {m.problem && <div className="lb-err">{m.problem}</div>}
        {error && <div className="lb-err">{error}</div>}
        {msg && <div className="lb-ok">{msg}</div>}
        {m.components.map((c) => (
          <div className="lb-map" key={c.key}>
            <div><b>{c.label}</b><div className="lb-side">{c.key === 'bank' ? 'Credit when salary is paid' : c.side === 'debit' ? 'Debit' : 'Credit'} · {c.group}</div></div>
            <select value={draft[c.key] || ''} disabled={!m.canEdit} onChange={(e) => setDraft((d) => ({ ...d, [c.key]: e.target.value }))}>
              {!accountsFor(c).some((a) => a.code === draft[c.key]) && <option value={draft[c.key] || ''}>{draft[c.key] ? `${draft[c.key]} (missing — pick one)` : 'Pick a ledger'}</option>}
              {accountsFor(c).map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
            </select>
            <span className="lb-note">{draft[c.key] === c.defaultCode ? 'Default' : 'Changed'}</span>
          </div>
        ))}
        <div style={{ height: 12 }} />
      </Panel>
      <Panel style={{ marginTop: 16 }}>
        <PanelHead title="Books closed up to" />
        <div className="lb-filters">
          <label className="lb-f"><span>Month</span><input type="month" value={closed} disabled={!m.canEdit} onChange={(e) => setClosed(e.target.value)} /></label>
          {m.canEdit && <button type="button" className="btn btn-sm" onClick={() => saveClosed(closed)}>Save</button>}
          {m.canEdit && closed && <button type="button" className="btn btn-sm" onClick={() => saveClosed('')}>Open all months</button>}
          <span className="lb-note">A change from HRMS (an asset edit, a repair) that would touch a closed month is not booked silently — it waits in Fixed Assets with a warning.</span>
        </div>
      </Panel>
    </>
  );
}
