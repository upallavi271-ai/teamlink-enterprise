// Accounts -> Journal & Ledger (SPEC B §7/§8).
//
//   Journal         every journal entry, filtered by month / account / text
//   Ledger          per-account totals for the filter, and one account's lines
//   Payroll Recon   HRMS payroll run totals vs what the ledger booked, flagged
//   Sync Log        HRMS -> Accounts deliveries, Retry
//   + (S2/S3, 2026-10-05) Reports (Trial Balance, P&L, Balance Sheet),
//     Fixed Assets (from HRMS) and Payroll Mapping — components/accounts/.
//
// Accounts roles and Super Admin / Admin only: the page is behind
// accounts / Journal & Ledger / view, which the API enforces as well.
import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import TabsPage from '../../components/TabsPage.jsx';
import { Panel, PanelHead, EmptyMini, ScopeNote } from '../../components/proto.jsx';
import { can } from '../../permissions';
import { SyncLogPanel } from '../../components/payroll/PayrollRunBoard.jsx';
import { money, monthLabel, errText, downloadFile, STATUS_LABEL } from '../../components/payroll/payrollUi';
import '../../components/payroll/payrollRun.css';
import Pager, { usePaged } from '../../components/Pager.jsx';
import ListFilterBar, { useListFilters, ListEmpty } from '../../components/ui/ListFilters.jsx';
import { JournalTab, LedgerTab, BooksReportsTab, PayrollMappingTab } from '../../components/accounts/JournalTabs.jsx';
import FixedAssetsTab from '../../components/accounts/FixedAssetsTab.jsx';
import '../../components/ui/ui.css';

const thisMonth = () => new Date().toISOString().slice(0, 7);

// Journal and Ledger tabs: components/accounts/JournalTabs.jsx (S2 / S3).

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
  const canEdit = can(user, 'accounts', 'accounts', 'Journal & Ledger', 'edit');
  return (
    <TabsPage
      title="Journal & Ledger"
      subtitle="Double-entry books. HRMS payroll posts one journal a month; HRMS assets and repairs post their own entries. Entries from HRMS are read-only here."
      banner={<ScopeNote>Accounts roles and Super Admin / Admin only.</ScopeNote>}
      value={tab}
      onChange={setTab}
      tabs={[
        { key: 'journal', label: 'Journal', element: <JournalTab canPost={canPost} /> },
        { key: 'ledger', label: 'Ledger', element: <LedgerTab /> },
        { key: 'reports', label: 'Reports', element: <BooksReportsTab /> },
        { key: 'assets', label: 'Fixed Assets', element: <FixedAssetsTab canPost={canPost} canEdit={canEdit} /> },
        { key: 'mapping', label: 'Payroll Mapping', element: <PayrollMappingTab /> },
        { key: 'recon', label: 'Payroll Reconciliation', element: <ReconciliationPanel /> },
        { key: 'sync', label: 'Sync Log', element: <SyncLogPanel canRetry={canPost} /> },
      ]}
    />
  );
}
