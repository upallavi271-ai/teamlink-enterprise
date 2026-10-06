import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { can } from '../permissions';
import AccountsImport from '../components/AccountsImport.jsx';
import ExpenseModal from './office/ExpenseModal.jsx';
import QuickExpenseModal from './office/QuickExpenseModal.jsx';
import BusinessDetails, { DueStrip, GovPortals } from './office/BusinessPortals.jsx';
import { ALL_TIME, isAllTime } from '../components/accounts/PeriodPicker.jsx';
import Section from './office/Section.jsx';
import ExpenseLedger from './office/ExpenseLedger.jsx';
import GstPosition from './office/GstPosition.jsx';
import VendorBillsReview from './office/VendorBillsReview.jsx'; // P3 vendor portal bills
import {
  OfficeFilterBar, OfficeCards, OFFICE_BLANK, officeParams,
} from './office/OfficeFilters.jsx';
import { saveBlob, selOfMonthKey } from './office/officeUtil';
import { useOfficeAccess, detailCache, canViewOffice } from './office/approval.jsx';
import { stateName as gstStateName } from '../utils/gstin';
import './office/office.css';
import './office/onepage.css';
import './office/officep2.css';

// ONE SCROLLABLE PAGE — Office & Accounts (Accounts spec S1, 2026-10-05):
//   1 Business & Tax Details   (the Business details card)
//   the filters bar             (period + every list filter, for the whole page)
//   2 Money position            (the KPI chips — the table's TOTAL row)
//   3 Expenses & Bills          (the table)
//   4 GST position              (under our GSTIN: outward, inward, the position)
// The GST & TDS portal logins, the Government portals launcher and the
// invoice- / purchase-level reconciliation lists were removed (S1.4, S1.5).
// The old tab names still work as links (?tab=…): each scrolls to, and opens,
// the nearest section that remains.
const OLD_TABS = {
  expenses: 'expenses',
  recon: 'gst',
  business: 'business',
  portals: 'business',
  taxportals: 'business',
  calendar: 'expenses',
  proofs: 'expenses',
  gst: 'gst',
  pnl: 'overview',
  summary: 'expenses',
  overview: 'overview',
  billing: 'gst',
  receivables: 'gst',
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

  // The page period ({ from, to, preset } — the shared Accounts period picker).
  // All time by default; ?month=YYYY-MM (the Accounts dashboard's outflow card)
  // opens on that month. The API reads it as the selection string `period`.
  const [pv, setPv] = useState(() => {
    const m = /^C:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(selOfMonthKey(search.get('month')) || '');
    return m ? { from: m[1], to: m[2], preset: 'custom' } : ALL_TIME;
  });
  const period = isAllTime(pv) ? 'all' : `C:${pv.from}:${pv.to}`;
  const [lf, setLf] = useState(OFFICE_BLANK);
  const params = officeParams(lf, pv);
  const [qDeb, setQDeb] = useState('');
  useEffect(() => { const t = setTimeout(() => setQDeb(lf.q), 250); return () => clearTimeout(t); }, [lf.q]);

  const [facts, setFacts] = useState(null);
  const [ledgerOptions, setLedgerOptions] = useState(null);
  const [error, setError] = useState('');
  const [quick, setQuick] = useState(null); // null | { row: null | the expense }
  const [full, setFull] = useState(null); // null | { row, options, ourState }
  const [importing, setImporting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [openSig, setOpenSig] = useState({});

  // The KPI chips and the GST position: the same filters as the table.
  const factsKey = JSON.stringify({
    period, q: qDeb.trim() || undefined, category: params.category, vendor: params.vendor, gst: params.gst, status: params.status, mode: params.mode,
  });
  useEffect(() => {
    if (!allowed) return undefined;
    let live = true;
    api.get('/office-expenses/overview', { params: JSON.parse(factsKey) })
      .then((r) => { if (live) setFacts(r.data); })
      .catch((e) => { if (live) setError(e.response?.data?.error || 'The figures could not be loaded.'); });
    return () => { live = false; };
  }, [factsKey, reloadKey, allowed]);

  // The Government portals row and the two balances typed in by hand for the
  // period ("In the GST portal" / "In TRACES" cards) — GET /portals.
  const [portals, setPortals] = useState(null);
  useEffect(() => {
    if (!allowed) return undefined;
    let live = true;
    api.get('/office-expenses/portals', { params: { period } })
      .then((r) => { if (live) setPortals(r.data); })
      .catch(() => { if (live) setError('The portals could not be loaded.'); });
    return () => { live = false; };
  }, [period, reloadKey, allowed]);
  const saveBalance = useCallback(async (patch) => {
    const r = await api.put('/office-expenses/portal-balances', { period, ...patch });
    setPortals((cur) => (cur ? { ...cur, balances: r.data } : cur));
  }, [period]);

  const jump = useCallback((sec) => {
    setOpenSig((s) => ({ ...s, [sec]: (s[sec] || 0) + 1 }));
    setTimeout(() => document.getElementById(`oe-sec-${sec}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  }, []);

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
  const clearAll = useCallback(() => { setLf(OFFICE_BLANK); setPv(ALL_TIME); }, []);

  // The older full expense form needs the register's pick-lists.
  const openFull = async (row) => {
    try {
      const r = await api.get('/office-expenses/register', { params: { period: 'all' } });
      setQuick(null);
      setFull({ row, options: r.data.options, ourState: r.data.ourGstin ? gstStateName(r.data.ourGstin.slice(0, 2)) : null });
    } catch (e) { setError(e.response?.data?.error || 'The full expense form could not be opened.'); }
  };
  // The older grouped register (month groups, subtotals, TDS, proof), for the page period and filters.
  const exportRegister = async () => {
    const res = await api.get('/office-expenses/register/export.xlsx', {
      params: {
        period,
        groupBy: 'month',
        sort: 'date',
        dir: 'desc',
        q: params.q,
        cats: params.category,
        vens: params.vendor,
        mode: params.mode,
        status: { PAID: 'Paid', PENDING: 'Pending' }[params.status],
        gst: { with: 'Yes', without: 'No' }[params.gst],
        only: params.gst === 'missing' ? 'atrisk' : undefined,
      },
      responseType: 'blob',
    });
    saveBlob(res, 'office-expenses.xlsx');
  };

  if (!allowed) {
    return (
      <div>
        <div className="page-head"><div><h1>Office &amp; Accounts</h1></div></div>
        <div className="notice amber"><span>Office &amp; Accounts is open to Super Admin, Admin and Accounts only.</span></div>
      </div>
    );
  }

  const plabel = facts?.period?.label || '';
  const rc = facts?.recon;
  return (
    <div className="oe-page oe-one ofp-page">
      {/* Office spec P1.3: the page header scrolls away with the page (no
          sticky header — the tables' top scrollbar and header row stick
          right under the app's top bar). */}
      <div className="page-head">
        <div>
          <h1>Office &amp; Accounts</h1>
          <div className="page-sub">Every expense and bill, the money figures and the GST position — on one page.</div>
        </div>
        <div className="qa-row">
          {canManage && <button type="button" className="btn btn-sm btn-primary" onClick={() => setQuick({ row: null })}>+ New Expense</button>}
        </div>
      </div>
      {importing && <AccountsImport kind="expenses" onClose={() => setImporting(false)} onDone={changed} />}

      {error && (
        <div className="notice red" style={{ marginBottom: 12 }}>
          <span>{error} <button type="button" className="link-btn" onClick={() => { setError(''); changed(); }}>Retry</button></span>
        </div>
      )}

      <OfficeFilterBar f={lf} setF={setLf} pv={pv} setPv={setPv} facets={ledgerOptions?.facets} />

      <Section id="overview" title="Money summary" sub={plabel ? `${plabel}${facts?.filtered ? ' · these filters' : ''}` : null} openSignal={openSig.overview}
        info="Every card follows the filters above and equals the table's TOTAL row. GST received from clients comes from Invoices and follows the period only. The two portal balances are typed in by hand — nothing is fetched from the portals.">
        <OfficeCards kpi={facts?.kpi} recon={rc} balances={portals?.balances} canManage={canManage} onSaveBalance={saveBalance} f={lf} setF={setLf} onJump={() => jump('expenses')} />
      </Section>

      <VendorBillsReview onChanged={changed} />
      <Section id="expenses" title="Expenses & Bills" sub="Click a row for its details, bill and payment" openSignal={openSig.expenses}
        info="After GST = Before GST + GST. Total = After GST − TDS (what the vendor is paid). Paid + Pending = Total.">
        <ExpenseLedger
          params={params}
          reloadKey={reloadKey}
          canManage={canManage}
          onImport={() => setImporting(true)}
          onEdit={(row) => setQuick({ row })}
          onEditFull={openFull}
          onChanged={changed}
          onError={onError}
          onExportRegister={exportRegister}
          onOptions={setLedgerOptions}
          onClear={clearAll}
        />
      </Section>

      {/* Office spec P2: under the table — due dates, the portals, Business details. */}
      <DueStrip />
      <GovPortals portals={portals?.portals} canEdit={!!portals?.canEditLinks}
        onUpdated={(np) => setPortals((cur) => ({ ...cur, portals: cur.portals.map((x) => (x.key === np.key ? np : x)) }))} />
      <BusinessDetails canManage={canManage} onError={onError} reloadKey={reloadKey} openSignal={openSig.business} onSaved={changed} />

      <Section id="gst" title="GST position" sub={plabel || null} openSignal={openSig.gst}
        info="Worked out from the invoices and bills themselves, for the period and the filters above (the invoice side follows the period only).">
        <GstPosition
          facts={facts}
          canManage={canManage}
          onChanged={changed}
          onShowAtRisk={() => { setLf({ ...lf, gst: 'missing' }); jump('expenses'); }}
          onCompany={() => jump('business')}
        />
      </Section>

      <div className="ofp-audit">Every change on this page is written to the Audit Log — who and when; for the business details also the old and the new value.</div>

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
