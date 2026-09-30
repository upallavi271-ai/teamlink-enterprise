import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { can } from '../permissions';
import AccountsImport from '../components/AccountsImport.jsx';
import ExpenseModal from './office/ExpenseModal.jsx';
import QuickExpenseModal from './office/QuickExpenseModal.jsx';
import BusinessPortals from './office/BusinessPortals.jsx';
import PeriodPicker from './office/PeriodPicker.jsx';
import Section from './office/Section.jsx';
import FinancialOverview, { MonthPick } from './office/FinancialOverview.jsx';
import ExpenseLedger, { LEDGER_BLANK, exportLedger } from './office/ExpenseLedger.jsx';
import GstRecon from './office/GstRecon.jsx';
import TaxPortals from './office/TaxPortals.jsx';
import {
  saveBlob, currentMonthSel, selOfMonthKey,
} from './office/officeUtil';
import { useOfficeAccess, detailCache, canViewOffice } from './office/approval.jsx';
import { stateName as gstStateName } from '../utils/gstin';
import './office/office.css';
import './office/onepage.css';

// ONE SCROLLABLE PAGE (Office & Accounts one-page spec v2, trimmed by the
// Accounts spec of 2026-09-28). No tabs: the five sections below, in this
// order. Client billing & receivables, Analysis, Documents & proofs and
// Upcoming due dates were taken off this page — the due dates now sit on the
// main Dashboard as the Reminders card. The old tab names still work as links
// (?tab=…): each scrolls to, and opens, the nearest section that remains.
//   Expenses              -> 3 Expenses & Bills
//   GST reconciliation    -> 5 GST Reconciliation
//   Business & portals    -> 1 Business & Tax Details (portals inside it)
//   GST / TDS logins      -> 4 GST & TDS Portals
//   Calendar, due dates   -> 3 Expenses & Bills (the bills and their due dates)
//   Proofs & bill files   -> 3 Expenses & Bills (each bill carries its file)
//   GST by month          -> 5 GST Reconciliation
//   Profit & Loss         -> 2 Financial Overview
//   Category & month      -> 3 Expenses & Bills
//   Client billing        -> 2 Financial Overview (billing and outstanding)
const OLD_TABS = {
  expenses: 'expenses',
  recon: 'gst',
  business: 'business',
  portals: 'business',
  taxportals: 'taxportals',
  calendar: 'expenses',
  proofs: 'expenses',
  gst: 'gst',
  pnl: 'overview',
  summary: 'expenses',
  overview: 'overview',
  billing: 'overview',
  receivables: 'overview',
  analysis: 'overview',
  dues: 'expenses',
  docs: 'expenses',
};

export default function Office() {
  // The same matrix answer the API enforces on every write in backend/src/routes/office.js
  // (accounts · accounts · Office & Expenses · edit). A view-only login never sees the
  // write controls at all.
  const { user } = useAuth();
  const allowed = canViewOffice(user);
  const canManage = allowed && can(user, 'accounts', 'accounts', 'Office & Expenses', 'edit');

  const access = useOfficeAccess();
  const [search] = useSearchParams();

  // The page period — the Financial Overview and the GST reconciliation read
  // it. It opens on the current month (or
  // ?month=YYYY-MM, which the Accounts dashboard's outflow card links to).
  const [period, setPeriod] = useState(() => selOfMonthKey(search.get('month')) || currentMonthSel());
  const [facts, setFacts] = useState(null);
  const [lf, setLf] = useState(LEDGER_BLANK);
  const [ledgerOptions, setLedgerOptions] = useState(null);
  const [error, setError] = useState('');
  const [quick, setQuick] = useState(null); // null | { row: null | the expense }
  const [full, setFull] = useState(null); // null | { row, options, ourState }
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [openSig, setOpenSig] = useState({});

  useEffect(() => {
    if (!allowed) return undefined;
    let live = true;
    api.get('/office-expenses/overview', { params: { period } })
      .then((r) => { if (live) setFacts(r.data); })
      .catch((e) => { if (live) setError(e.response?.data?.error || 'The overview could not be loaded.'); });
    return () => { live = false; };
  }, [period, reloadKey, allowed]);

  // An old tab link (?tab=recon …) scrolls to the section that holds it now.
  // The sections above it fill in as their data arrives, so the jump is made
  // again once the page has settled.
  useEffect(() => {
    const t = search.get('tab');
    const sec = allowed && t && OLD_TABS[t];
    if (!sec) return undefined;
    setOpenSig((s) => ({ ...s, [sec]: (s[sec] || 0) + 1 }));
    const go = (behavior) => document.getElementById(`oe-sec-${sec}`)?.scrollIntoView({ behavior, block: 'start' });
    const timers = [setTimeout(() => go('smooth'), 350), setTimeout(() => go('auto'), 1600)];
    return () => timers.forEach(clearTimeout);
  }, [search, allowed]);

  const changed = useCallback(() => { detailCache.clear(); setReloadKey((k) => k + 1); }, []);
  const onError = useCallback((m) => setError(m), []);

  // The older full expense form needs the register's pick-lists.
  const openFull = async (row) => {
    try {
      const r = await api.get('/office-expenses/register', { params: { period: 'all' } });
      setQuick(null);
      setFull({ row, options: r.data.options, ourState: r.data.ourGstin ? gstStateName(r.data.ourGstin.slice(0, 2)) : null });
    } catch (e) { setError(e.response?.data?.error || 'The full expense form could not be opened.'); }
  };
  const exportHeader = async () => {
    setExporting(true);
    try { await exportLedger(lf); } catch { setError('The Excel file could not be made.'); }
    setExporting(false);
  };
  // The older grouped register (month groups, subtotals, TDS, proof), for the page period.
  const exportRegister = async () => {
    try {
      const res = await api.get('/office-expenses/register/export.xlsx', {
        params: {
          period, groupBy: 'month', sort: 'date', dir: 'desc',
        },
        responseType: 'blob',
      });
      saveBlob(res, 'office-expenses.xlsx');
    } catch { setError('The register could not be exported.'); }
  };

  if (!allowed) {
    return (
      <div>
        <div className="page-head"><div><h1>Office &amp; Expenses</h1></div></div>
        <div className="notice amber"><span>Office &amp; Expenses is open to Super Admin, Admin and Accounts only.</span></div>
      </div>
    );
  }

  const plabel = facts?.period?.label || '';
  return (
    <div className="oe-page oe-one">
      <div className="page-head">
        <div>
          <h1>Office &amp; Expenses</h1>
          <div className="page-sub">
            Business details, the money position, every expense and bill, the GST &amp; TDS portal logins and GST — on one page.
          </div>
        </div>
        <div className="qa-row">
          <button type="button" className="btn btn-sm" onClick={exportHeader} disabled={exporting} title="The expenses the table's filters show, as Excel">
            {exporting ? 'Preparing…' : '⬇ Excel'}
          </button>
          {canManage && <button type="button" className="btn btn-sm btn-primary" onClick={() => setQuick({ row: null })}>+ New Expense</button>}
        </div>
      </div>
      {importing && <AccountsImport kind="expenses" onClose={() => setImporting(false)} onDone={changed} />}

      {error && (
        <div className="notice red" style={{ marginBottom: 12 }}>
          <span>{error} <button type="button" className="link-btn" onClick={() => { setError(''); changed(); }}>Retry</button></span>
        </div>
      )}

      <Section id="business" n={1} title="Business & Tax Details" sub="GSTIN, PAN, the bank account and the government portals · Admin and Accounts only" openSignal={openSig.business}>
        <BusinessPortals period={period} canManage={canManage} onError={onError} onBalancesSaved={changed} reloadKey={reloadKey} />
      </Section>

      <Section
        id="overview"
        n={2}
        title="Financial Overview"
        sub={plabel ? `${plabel} — the period applies to the overview and the GST reconciliation` : null}
        right={(
          <span className="oe-period">
            <span>Period</span>
            <MonthPick period={period} setPeriod={setPeriod} />
            <PeriodPicker value={period} onChange={setPeriod} />
          </span>
        )}
        openSignal={openSig.overview}
      >
        <FinancialOverview facts={facts} />
      </Section>

      <Section id="expenses" n={3} title="Expenses & Bills" sub="Every office expense — click a row for its details, bill and approval" openSignal={openSig.expenses}>
        <ExpenseLedger
          f={lf}
          setF={setLf}
          reloadKey={reloadKey}
          canManage={canManage}
          onNew={() => setQuick({ row: null })}
          onImport={() => setImporting(true)}
          onEdit={(row) => setQuick({ row })}
          onEditFull={openFull}
          onChanged={changed}
          onError={onError}
          onExportRegister={exportRegister}
          onOptions={setLedgerOptions}
        />
      </Section>

      {/* GST & TDS Portals (Accounts spec 1): directly below the Expenses & Bills
          table and directly above GST Reconciliation. The portal logins are for
          the logins that may edit Office & Expenses only — the API refuses the
          rest with 403 — so a view-only login is not shown the card at all. */}
      {canManage && (
        <Section id="taxportals" n={4} title="GST & TDS Portals" sub="The GST portal and TRACES logins — kept encrypted on the server, masked until you press Show" openSignal={openSig.taxportals}>
          <TaxPortals onProfileSaved={changed} />
        </Section>
      )}

      <Section id="gst" n={canManage ? 5 : 4} title="GST Reconciliation" sub={plabel ? `${plabel} — computed from the invoices and bills themselves` : null} openSignal={openSig.gst}>
        <GstRecon facts={facts} canManage={canManage} onChanged={changed} />
      </Section>

      {quick && (
        <QuickExpenseModal
          row={quick.row}
          access={access}
          options={ledgerOptions}
          onClose={() => setQuick(null)}
          onSaved={() => { setQuick(null); changed(); }}
          onOpenFull={() => openFull(quick.row)}
        />
      )}
      {full && (
        <ExpenseModal
          row={full.row}
          options={full.options}
          access={access}
          ourState={full.ourState}
          onClose={() => setFull(null)}
          onSaved={() => { setFull(null); changed(); }}
        />
      )}
    </div>
  );
}
