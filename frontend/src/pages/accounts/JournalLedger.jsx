// Accounts -> Journal & Ledger (SPEC B §7/§8).
//
//   Journal         every journal entry, filtered by month / account / text
//   Ledger          per-account totals for the filter, and one account's lines
//   Payroll Recon   HRMS payroll run totals vs what the ledger booked, flagged
//   Sync Log        HRMS -> Accounts deliveries, Retry
//
// Accounts roles and Super Admin / Admin only: the page is behind
// accounts / Journal & Ledger / view, which the API enforces as well.
import { Fragment, useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import TabsPage from '../../components/TabsPage.jsx';
import { Panel, PanelHead, EmptyMini, ScopeNote } from '../../components/proto.jsx';
import { can } from '../../permissions';
import { SyncLogPanel } from '../../components/payroll/PayrollRunBoard.jsx';
import { money, monthLabel, errText, downloadFile, STATUS_LABEL } from '../../components/payroll/payrollUi';
import '../../components/payroll/payrollRun.css';
import FilterChips from '../../components/FilterChips.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import ListFilterBar, { useListFilters, ListEmpty } from '../../components/ui/ListFilters.jsx';
import '../../components/ui/ui.css';

const thisMonth = () => new Date().toISOString().slice(0, 7);

function useAccounts() {
  const [accounts, setAccounts] = useState([]);
  useEffect(() => { api.get('/accounts/chart-of-accounts').then((r) => setAccounts(r.data)).catch(() => setAccounts([])); }, []);
  return accounts;
}

const SOURCES = [['PAYROLL_RUN', 'Payroll — salary journal'], ['PAYROLL_PAYMENT', 'Payroll — bank payment']];

function JournalTab() {
  const accounts = useAccounts();
  const BLANK = { month: thisMonth(), account: '', search: '', referenceType: '' };
  const [f, setF] = useState(BLANK);
  const [data, setData] = useState(null);
  const [open, setOpen] = useState({});
  const [error, setError] = useState('');
  // The search box is sent a moment after typing stops (no Enter needed).
  const [searchDeb, setSearchDeb] = useState('');
  useEffect(() => { const t = setTimeout(() => setSearchDeb(f.search.trim()), 300); return () => clearTimeout(t); }, [f.search]);
  const qs = () => {
    const q = new URLSearchParams();
    Object.entries({ ...f, search: searchDeb }).forEach(([k, v]) => { if (v) q.set(k, v); });
    return q.toString();
  };
  function load() {
    setError('');
    api.get(`/accounts/journal-entries?${qs()}`).then((r) => setData(r.data)).catch((err) => setError(errText(err, 'Could not load the journal.')));
  }
  useEffect(load, [f.month, f.account, f.referenceType, searchDeb]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const page = usePaged(data?.entries || []);
  const acctName = (code) => { const a = accounts.find((x) => x.code === code); return a ? `${a.code} · ${a.name}` : code; };
  const chips = [
    f.search.trim() && { key: 'search', label: 'Search', value: f.search.trim(), onRemove: () => set('search', '') },
    f.month !== thisMonth() && { key: 'month', label: 'Month', value: f.month ? monthLabel(f.month) : 'All months', onRemove: () => set('month', thisMonth()) },
    f.account && { key: 'account', label: 'Account', value: acctName(f.account), onRemove: () => set('account', '') },
    f.referenceType && { key: 'src', label: 'Source', value: (SOURCES.find(([k]) => k === f.referenceType) || [])[1] || f.referenceType, onRemove: () => set('referenceType', '') },
  ].filter(Boolean);
  const clearAll = () => setF(BLANK);
  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title="Journal">
        <button className="btn btn-sm" onClick={() => downloadFile(`/accounts/journal-entries?${qs()}&format=xlsx`, `journal-${f.month || 'all'}.xlsx`).catch((e) => setError(errText(e, 'Export failed')))}>Export Excel</button>
        <button className="btn btn-sm" onClick={() => downloadFile(`/accounts/journal-entries?${qs()}&format=csv`, `journal-${f.month || 'all'}.csv`).catch((e) => setError(errText(e, 'Export failed')))}>CSV</button>
      </PanelHead>
      <div className="jl-filters">
        <input type="search" placeholder="Search narration / employee / key…" value={f.search} onChange={(e) => set('search', e.target.value)} aria-label="Search" />
        <input type="month" value={f.month} onChange={(e) => set('month', e.target.value)} title="Month" aria-label="Month" />
        <button className="btn btn-sm" disabled={!f.month} onClick={() => set('month', '')}>All months</button>
        <select value={f.account} onChange={(e) => set('account', e.target.value)} title="Account" aria-label="Account">
          <option value="">All accounts</option>
          {accounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
        </select>
        <select value={f.referenceType} onChange={(e) => set('referenceType', e.target.value)} title="Source" aria-label="Source">
          <option value="">All sources</option>
          {SOURCES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        {chips.length > 0 && <button type="button" className="mf-clear" onClick={clearAll}>Clear All</button>}
        {data && <span className="prb-note" style={{ marginLeft: 'auto' }}>{data.count} entr{data.count === 1 ? 'y' : 'ies'} · Dr {money(data.totals.debit)} · Cr {money(data.totals.credit)}</span>}
      </div>
      <div style={{ padding: '0 18px' }}><FilterChips filters={chips} onClearAll={chips.length ? clearAll : undefined} /></div>
      {error && <div className="error-text" style={{ padding: '0 18px' }}>{error}</div>}
      {!data ? <EmptyMini>Loading…</EmptyMini> : data.entries.length === 0 ? (
        <EmptyMini>
          {chips.length ? <>No journal entries match these filters. <button type="button" className="link-btn" onClick={clearAll}>Clear filters</button></> : 'No journal entries yet.'}
        </EmptyMini>
      ) : (
        <>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Date</th><th>Narration</th><th>Source</th><th className="jl-num">Debit</th><th className="jl-num">Credit</th><th>Key</th><th /></tr></thead>
            <tbody>
              {page.slice.map((e) => (
                <Fragment key={e.id}>
                  <tr>
                    <td>{e.date}</td>
                    <td>{e.narration || '—'}</td>
                    <td className="cell-muted">{e.referenceType === 'PAYROLL_RUN' ? 'Payroll salary' : e.referenceType === 'PAYROLL_PAYMENT' ? 'Payroll payment' : e.source}</td>
                    <td className="jl-num">{money(e.totalDebit)}</td>
                    <td className="jl-num">{money(e.totalCredit)}</td>
                    <td className="cell-muted"><code>{e.idempotencyKey}</code></td>
                    <td><button className="btn btn-sm" onClick={() => setOpen((o) => ({ ...o, [e.id]: !o[e.id] }))}>{open[e.id] ? 'Hide' : 'Lines'}</button></td>
                  </tr>
                  {open[e.id] && (
                    <tr>
                      <td colSpan="7" style={{ padding: 0 }}>
                        <table className="jl-lines">
                          <tbody>
                            {e.lines.map((l) => (
                              <tr key={l.id}>
                                <td style={{ paddingLeft: l.credit ? 36 : 10 }}>{l.credit ? 'Cr' : 'Dr'} {l.accountCode} · {l.accountName}</td>
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

// Search / Type over the per-account totals, and Search / Date range over
// one account's lines (the list filter standard, client-side).
const SUM_FIELDS = [
  { key: 'q', type: 'search', placeholder: 'Search account code or name…', minWidth: 200, get: (r) => `${r.code} ${r.name}` },
  { key: 'type', label: 'Type', allLabel: 'All types', get: (r) => r.type, primary: true },
  { key: 'posted', label: 'Postings', allLabel: 'All accounts', options: ['With postings', 'No postings'], get: (r) => (r.lines > 0 ? 'With postings' : 'No postings'), primary: true },
];
const LINE_FIELDS = [
  { key: 'q', type: 'search', placeholder: 'Search narration…', minWidth: 200, get: (l) => l.narration },
  { key: 'date', type: 'daterange', label: 'Date range', get: (l) => l.date, primary: true },
  { key: 'side', label: 'Side', allLabel: 'Debit and credit', options: ['Debit', 'Credit'], get: (l) => (l.debit ? 'Debit' : 'Credit'), primary: true },
];

function LedgerTab() {
  const accounts = useAccounts();
  const [month, setMonth] = useState(thisMonth());
  const [account, setAccount] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setError('');
    const q = new URLSearchParams();
    if (month) q.set('month', month);
    if (account) q.set('account', account);
    api.get(`/accounts/ledger?${q}`).then((r) => setData(r.data)).catch((err) => setError(errText(err, 'Could not load the ledger.')));
  }, [month, account]);
  const q = `${month ? `month=${month}&` : ''}${account ? `account=${account}&` : ''}`;
  const sumLf = useListFilters(data?.summary || [], SUM_FIELDS);
  const lineLf = useListFilters(data?.lines || [], LINE_FIELDS);
  const linePage = usePaged(lineLf.rows);
  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title="Ledger">
        <button className="btn btn-sm" onClick={() => downloadFile(`/accounts/ledger?${q}format=xlsx`, `ledger-${month || 'all'}.xlsx`).catch((e) => setError(errText(e, 'Export failed')))}>Export Excel</button>
      </PanelHead>
      <div className="jl-filters">
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} title="Month" aria-label="Month" />
        <button className="btn btn-sm" disabled={!month} onClick={() => setMonth('')}>All months</button>
        <select value={account} onChange={(e) => setAccount(e.target.value)} title="Account" aria-label="Account">
          <option value="">All accounts</option>
          {accounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
        </select>
      </div>
      {error && <div className="error-text" style={{ padding: '0 18px' }}>{error}</div>}
      {!data ? <EmptyMini>Loading…</EmptyMini> : (
        <>
          {!account && <div style={{ padding: '0 18px' }}><ListFilterBar lf={sumLf} storageKey="ledger-summary" noun="accounts" /></div>}
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Code</th><th>Account</th><th>Type</th><th className="jl-num">Debit</th><th className="jl-num">Credit</th><th className="jl-num">Balance</th><th /></tr></thead>
              <tbody>
                {(account ? data.summary : sumLf.rows).map((r) => (
                  <tr key={r.code}>
                    <td><b>{r.code}</b></td><td>{r.name}</td><td className="cell-muted">{r.type}</td>
                    <td className="jl-num">{money(r.debit)}</td><td className="jl-num">{money(r.credit)}</td><td className="jl-num"><b>{money(r.balance)}</b></td>
                    <td>{!account && r.lines > 0 && <button className="btn btn-sm" onClick={() => setAccount(r.code)}>Lines</button>}</td>
                  </tr>
                ))}
                {!account && sumLf.rows.length === 0 && <tr><td colSpan="7"><ListEmpty lf={sumLf} noun="accounts" /></td></tr>}
              </tbody>
            </table>
          </div>
          {account && <div style={{ padding: '10px 18px 0' }}><ListFilterBar lf={lineLf} storageKey="ledger-lines" noun="postings" /></div>}
          {account && (
            <div className="tbl-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>Date</th><th>Month</th><th>Narration</th><th className="jl-num">Debit</th><th className="jl-num">Credit</th></tr></thead>
                <tbody>
                  {linePage.slice.map((l) => (
                    <tr key={l.id}><td>{l.date}</td><td className="cell-muted">{monthLabel(l.month)}</td><td>{l.narration}</td><td className="jl-num">{l.debit ? money(l.debit) : ''}</td><td className="jl-num">{l.credit ? money(l.credit) : ''}</td></tr>
                  ))}
                  {lineLf.rows.length === 0 && (
                    <tr><td colSpan="5">{lineLf.activeCount ? <ListEmpty lf={lineLf} noun="postings" /> : <span className="small-muted" style={{ display: 'block', padding: 14 }}>No postings to this account for the filter.</span>}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          {account && lineLf.rows.length > 25 && <Pager page={linePage} noun="postings" />}
        </>
      )}
    </Panel>
  );
}

const FLAG_TEXT = {
  NOT_BOOKED: 'Not booked', MISMATCH: 'Amount mismatch', UNBALANCED: 'Unbalanced entry', PAYMENT_MISSING: 'Payment not booked', ORPHAN: 'No approved run',
};

const RECON_FIELDS = [
  { key: 'q', type: 'search', placeholder: 'Search employee name or code…', minWidth: 200, get: (r) => `${r.employeeCode || ''} ${r.name || ''}` },
  { key: 'result', label: 'Result', allLabel: 'All results', options: ['Matched', 'Mismatch'], get: (r) => (r.ok ? 'Matched' : 'Mismatch'), primary: true },
  { key: 'status', label: 'Payroll status', allLabel: 'All payroll statuses', get: (r) => (r.status ? (STATUS_LABEL[r.status] || r.status) : ''), primary: true },
  { key: 'flag', label: 'Flag', allLabel: 'All flags', get: (r) => (r.flags || []).map((fl) => FLAG_TEXT[fl] || fl) },
];

export function ReconciliationPanel({ initialMonth }) {
  const [month, setMonth] = useState(initialMonth || thisMonth());
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const lf = useListFilters(data?.rows || [], RECON_FIELDS);
  const page = usePaged(lf.rows);
  function load() {
    setError(''); setData(null);
    api.get(`/accounts/reports/payroll-reconciliation?month=${month}`).then((r) => setData(r.data)).catch((err) => setError(errText(err, 'Could not load the reconciliation.')));
  }
  useEffect(load, [month]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = page.slice;
  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title="Payroll reconciliation — HRMS vs ledger">
        <button className="btn btn-sm" onClick={() => downloadFile(`/accounts/reports/payroll-reconciliation?month=${month}&format=xlsx`, `payroll-reconciliation-${month}.xlsx`).catch((e) => setError(errText(e, 'Export failed')))}>Export Excel</button>
        <button className="btn btn-sm" onClick={() => downloadFile(`/accounts/reports/payroll-reconciliation?month=${month}&format=csv`, `payroll-reconciliation-${month}.csv`).catch((e) => setError(errText(e, 'Export failed')))}>CSV</button>
      </PanelHead>
      <div className="jl-filters">
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        <button className="btn btn-sm" onClick={load}>Refresh</button>
      </div>
      {error && <div className="error-text" style={{ padding: '0 18px' }}>{error}</div>}
      {!data ? <EmptyMini>{error ? '' : 'Loading…'}</EmptyMini> : (
        <>
          {data.note && <div className="prb-msg">{data.note}</div>}
          <div className="jl-cards">
            <div className="jl-card"><div className="v">{money(data.hrms.totalCost)}</div><div className="l">HRMS — approved payroll cost ({data.hrms.employees} employee(s))</div></div>
            <div className="jl-card"><div className="v">{money(data.ledger.salaryExpense)}</div><div className="l">Ledger — Salary Expense booked</div></div>
            <div className={`jl-card ${data.difference ? 'bad' : 'good'}`}><div className="v">{data.difference == null ? '—' : money(data.difference)}</div><div className="l">Difference</div></div>
            <div className={`jl-card ${data.mismatches ? 'bad' : 'good'}`}><div className="v">{data.mismatches}</div><div className="l">Flagged record(s)</div></div>
            <div className="jl-card"><div className="v">{money(data.hrms.paid)}</div><div className="l">Net paid (HRMS) · {money(data.ledger.paidFromPayable)} cleared in ledger</div></div>
          </div>
          {(data.rows || []).length > 0 && <div style={{ padding: '0 18px' }}><ListFilterBar lf={lf} storageKey="payroll-recon" noun="records" /></div>}
          {lf.rows.length === 0 ? ((data.rows || []).length ? <ListEmpty lf={lf} noun="records" /> : <EmptyMini>No approved payroll for this month yet.</EmptyMini>) : (
            <>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Code</th><th>Employee</th><th>Payroll status</th><th className="jl-num">Expected Dr</th><th className="jl-num">Booked Dr</th><th className="jl-num">Difference</th><th>Result</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.entryId}-${r.journals.join()}`}>
                      <td><b>{r.employeeCode || '—'}</b></td>
                      <td>{r.name}</td>
                      <td className="cell-muted">{r.status ? STATUS_LABEL[r.status] : '—'}</td>
                      <td className="jl-num">{money(r.expectedDebit)}</td>
                      <td className="jl-num">{money(r.bookedDebit)}</td>
                      <td className="jl-num">{money(r.difference)}</td>
                      <td>
                        {r.ok ? <span className="jl-ok">✓ Matched</span> : r.flags.map((fl) => <span key={fl} className="jl-flag">{FLAG_TEXT[fl] || fl}</span>)}
                        {r.diffs.length > 0 && <div className="prb-note">{r.diffs.map((d) => `${d.accountName}: expected ${d.expectedDebit ? `Dr ${money(d.expectedDebit)}` : `Cr ${money(d.expectedCredit)}`}, booked ${d.expectedDebit ? `Dr ${money(d.bookedDebit)}` : `Cr ${money(d.bookedCredit)}`}`).join(' · ')}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {lf.rows.length > 25 && <Pager page={page} noun="records" />}
            </>
          )}
          {data.byAccount.length > 0 && (
            <div className="tbl-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>Account</th><th className="jl-num">Expected Dr</th><th className="jl-num">Booked Dr</th><th className="jl-num">Expected Cr</th><th className="jl-num">Booked Cr</th><th /></tr></thead>
                <tbody>
                  {data.byAccount.map((a) => (
                    <tr key={a.accountCode}>
                      <td>{a.accountCode} · {a.accountName}</td>
                      <td className="jl-num">{money(a.expectedDebit)}</td><td className="jl-num">{money(a.bookedDebit)}</td>
                      <td className="jl-num">{money(a.expectedCredit)}</td><td className="jl-num">{money(a.bookedCredit)}</td>
                      <td>{a.ok ? <span className="jl-ok">✓</span> : <span className="jl-flag">Mismatch</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

export default function JournalLedger() {
  const { user } = useAuth();
  const [tab, setTab] = useState('journal');
  if (!can(user, 'accounts', 'accounts', 'Journal & Ledger', 'view')) {
    return <div className="small-muted" style={{ padding: 20 }}>The journal and ledger aren&apos;t included in your role&apos;s permissions.</div>;
  }
  const canPost = can(user, 'accounts', 'accounts', 'Journal & Ledger', 'create');
  return (
    <TabsPage
      title="Journal & Ledger"
      subtitle="Double-entry books. Payroll is booked here by HRMS through the Accounts journal API, once per payroll record."
      banner={<ScopeNote>Accounts roles and Super Admin / Admin only.</ScopeNote>}
      value={tab}
      onChange={setTab}
      tabs={[
        { key: 'journal', label: 'Journal', element: <JournalTab /> },
        { key: 'ledger', label: 'Ledger', element: <LedgerTab /> },
        { key: 'recon', label: 'Payroll Reconciliation', element: <ReconciliationPanel /> },
        { key: 'sync', label: 'Sync Log', element: <SyncLogPanel canRetry={canPost} /> },
      ]}
    />
  );
}
