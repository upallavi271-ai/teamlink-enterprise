import {
  useCallback, useEffect, useRef, useState,
} from 'react';
import api from '../api';
import AccountsImport from '../components/AccountsImport.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { can, productRole } from '../permissions';
import { isAllTime } from '../components/accounts/PeriodPicker.jsx';
import Filters, { BLANK } from './accounts/dash/Filters.jsx';
import ProofReminder from './accounts/dash/ProofReminder.jsx';
import Summary from './accounts/dash/Summary.jsx';
import OfficeSpends from './accounts/dash/OfficeSpends.jsx';
import GstPosition from './accounts/dash/GstPosition.jsx';
import ClientTable from './accounts/dash/ClientTable.jsx';
import MoreTools from './accounts/dash/MoreTools.jsx';
import './accounts/dash/accDash.css';

// ---------------------------------------------------------------------------
// THE ACCOUNTS DASHBOARD (Accounts spec S8) — one scrollable page, a
// financial control centre, in this order:
//   header → 1 filters → 2 proof reminder → 3 money summary → 4 office spends
//   → 5 GST position → 6 pending & received client by client → end
// (the earlier dashboard's desk, monthly summary, outflow and bank lines are
// kept in the closed "More" panel at the very end).
//
// ONE payload: GET /api/dashboard/accounts/control (utils/accountsControl.js),
// built from the Invoices page's register and the Office page's bills, so the
// numbers here are those pages' numbers. Money is for Super Admin, Admin and
// Accountant only — the API refuses everyone else (403).
// ---------------------------------------------------------------------------
const MONEY_ROLES = ['SUPER_ADMIN', 'ADMIN', 'ACCOUNTANT'];

export default function AccountsDashboard() {
  const { user } = useAuth();
  const allowed = MONEY_ROLES.includes(productRole(user, 'accounts'));
  const canImport = [['Bank & Reconciliation', 'edit'], ['Office & Expenses', 'edit'], ['Invoices', 'create']]
    .some(([feature, action]) => can(user, 'accounts', 'accounts', feature, action));
  const canPay = can(user, 'accounts', 'accounts', 'Payments', 'create');
  const canAttach = can(user, 'accounts', 'accounts', 'Invoices', 'edit');
  const canOffice = can(user, 'accounts', 'accounts', 'Office & Expenses', 'edit');

  const [f, setF] = useState(BLANK);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [msg, setMsg] = useState(null);
  const seq = useRef(0);
  const msgTimer = useRef(null);

  const load = useCallback((fresh) => {
    if (!allowed) return;
    const my = ++seq.current; // eslint-disable-line no-plusplus
    setLoading(true);
    const p = f.period;
    api.get('/dashboard/accounts/control', {
      params: {
        ...(isAllTime(p) ? {} : { from: p.from, to: p.to }),
        client: f.client || undefined,
        dept: f.dept || undefined,
        section: f.section || undefined,
        role: f.role || undefined,
        emp: f.emp || undefined,
        q: f.q || undefined,
        fresh: fresh ? 1 : undefined,
      },
    })
      .then((r) => { if (my === seq.current) { setData(r.data); setError(''); } })
      .catch((e) => { if (my === seq.current) setError(e.response?.data?.error || 'The dashboard could not be loaded. Please try again.'); })
      .finally(() => { if (my === seq.current) setLoading(false); });
  }, [f, allowed]);
  useEffect(() => { load(false); }, [load]);

  const flash = useCallback((text, tone) => {
    setMsg({ text, tone });
    clearTimeout(msgTimer.current);
    msgTimer.current = setTimeout(() => setMsg(null), 5000);
  }, []);
  useEffect(() => () => clearTimeout(msgTimer.current), []);
  const changed = useCallback((fresh) => load(fresh !== false), [load]);

  // The filters as the server reads them (Remind accountant follows them too).
  const serverFilters = {
    ...(isAllTime(f.period) ? {} : { from: f.period.from, to: f.period.to }),
    client: f.client, dept: f.dept, section: f.section, role: f.role, emp: f.emp, q: f.q,
  };

  return (
    <div className="acd">
      <div className="acd-head">
        <div>
          <h1>Accounts Dashboard</h1>
          <div className="acd-sub">Track invoices, collections, expenses, GST, TDS, pending payments and profit in one place.</div>
        </div>
        {canImport && <button type="button" className="btn btn-sm" onClick={() => setImporting(true)}>⬆ Import</button>}
      </div>
      {importing && <AccountsImport onClose={() => setImporting(false)} onDone={() => load(true)} />}

      {!allowed && (
        <div className="notice amber"><span>Money figures are open to Accounts, Admin and Super Admin only. Ask an admin if you need them.</span></div>
      )}
      {allowed && (
        <>
          <Filters value={f} onChange={setF} facets={data?.facets} counts={data?.counts} loading={loading} />
          {error && <div className="notice red"><span>{error} <button type="button" className="link-btn" onClick={() => load(true)}>Try again</button></span></div>}
          {!data && !error && <div className="acd-sec small-muted">Loading the numbers…</div>}
          {data && (
            <div style={{ opacity: loading ? 0.6 : 1, transition: 'opacity .15s' }}>
              <ProofReminder proof={data.proof} filters={serverFilters} onChanged={() => changed(false)} flash={flash} />
              <Summary s={data.summary} peopleFilter={data.peopleFilter} />
              <OfficeSpends office={data.office} canManage={canOffice} onChanged={() => changed(false)} flash={flash} />
              <GstPosition g={data.gst} peopleFilter={data.peopleFilter} />
              <ClientTable clients={data.clients} canPay={canPay} canAttach={canAttach} onChanged={changed} flash={flash} />
              {data.checks && data.checks.some((c) => !c.ok) && (
                <div className="notice red">
                  <span>Some numbers do not tie out: {data.checks.filter((c) => !c.ok).map((c) => `${c.what} (${c.detail})`).join(' · ')}</span>
                </div>
              )}
            </div>
          )}
          <MoreTools />
        </>
      )}
      {msg && <div className={`acd-flash${msg.tone === 'red' ? ' red' : ''}`} role="status">{msg.text}</div>}
    </div>
  );
}
