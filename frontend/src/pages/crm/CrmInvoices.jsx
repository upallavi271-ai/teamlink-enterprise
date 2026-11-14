// CRM > DEALS > INVOICES (founder 2026-11-13, the 5-module blueprint: "Won -> Customer + invoice -> Payment"). The CRM's OWN invoices,
// raised when a deal is Won: what is owed, what is overdue and what is paid. Self-contained - never the ATS Accounts invoices
// ("crm mottham separate application"). A salesperson sees their own, a manager / Admin everyone's. It is a view of the Deals page
// (`embedded`), not a module of its own: the CRM stays at five (founder 2026-11-14).
import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { useCrm, errOf, money, dateOf, Pill, invoicePill, InvoiceStatusSelect, openInvoicePdf, INVOICE_STATUSES } from './crmShared.jsx';

export default function CrmInvoices({ embedded = false }) {
  const { me, toast, openRecord, version } = useCrm();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [missing, setMissing] = useState(0); // Won deals with no invoice yet (won before invoices existed)
  const [busy, setBusy] = useState(false);
  const load = () => api.get('/crm/invoices').then((r) => { setRows(r.data.invoices); setMissing(r.data.missing || 0); setErr(''); }).catch((e) => setErr(errOf(e, 'The invoices could not be read.')));
  async function backfill() {
    setBusy(true);
    try { const r = await api.post('/crm/invoices/backfill'); toast(`${r.data.created} invoice${r.data.created === 1 ? '' : 's'} made, each dated the day its deal was won.`); await load(); } catch (e) { toast(errOf(e, 'The invoices could not be made.')); } finally { setBusy(false); }
  }
  useEffect(() => { load(); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = (rows || []).filter((x) => x.status !== 'Cancelled');
  const sum = (list, f) => list.reduce((a, x) => a + (f(x) || 0), 0);
  const owed = sum(live.filter((x) => x.status !== 'Paid'), (x) => x.total - x.paidAmount);
  const overdue = live.filter((x) => x.overdue);
  const received = sum(live, (x) => x.paidAmount);
  const shown = useMemo(() => (rows || []).filter((x) => (!status || (status === 'Overdue' ? x.overdue : x.status === status))
    && (!q || `${x.code} ${x.accountName} ${x.title}`.toLowerCase().includes(q.toLowerCase()))), [rows, q, status]);
  const replace = (inv) => setRows((list) => (list || []).map((x) => (x.id === inv.id ? inv : x)));

  return (
    <div className={embedded ? undefined : 'page'}>
      {embedded
        ? <div className="small-muted" style={{ margin: '0 0 10px' }}>{rows ? `${rows.length} invoice${rows.length === 1 ? '' : 's'} · each is raised automatically when a deal is Won` : 'Raised when a deal is Won'}</div>
        : (
          <div className="page-head">
            <div>
              <h1>Invoices</h1>
              <div className="page-sub">{rows ? `${rows.length} invoice${rows.length === 1 ? '' : 's'} · raised automatically when a deal is Won` : 'Raised when a deal is Won'}</div>
            </div>
          </div>
        )}
      {missing > 0 && me.canEdit && (
        <div className="notice" role="status" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span><b>{missing} Won deal{missing === 1 ? ' has' : 's have'} no invoice</b> (won before invoices existed). They are not in the totals below.</span>
          <button type="button" className="btn btn-sm btn-primary" style={{ marginLeft: 'auto' }} disabled={busy} onClick={backfill}>{busy ? 'Making…' : 'Create missing invoices'}</button>
        </div>
      )}
      {rows && (
        <div className="crm-kpis" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 12 }}>
          <div className="card" style={{ padding: 12 }}><div className="small-muted">Yet to be received</div><div style={{ fontSize: 20, fontWeight: 700 }}>{money(owed)}</div></div>
          <div className="card" style={{ padding: 12 }}><div className="small-muted">Overdue</div><div style={{ fontSize: 20, fontWeight: 700, color: overdue.length ? 'var(--red)' : undefined }}>{overdue.length} · {money(sum(overdue, (x) => x.total - x.paidAmount))}</div></div>
          <div className="card" style={{ padding: 12 }}><div className="small-muted">Received</div><div style={{ fontSize: 20, fontWeight: 700 }}>{money(received)}</div></div>
        </div>
      )}
      <div className="filter-row">
        <input type="text" placeholder="Search invoice, customer or deal" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 240 }} aria-label="Search invoices" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          <option value="Overdue">Overdue</option>
          {INVOICE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      {err && <div className="notice" role="alert">{err}</div>}
      {rows == null && !err && <div className="small-muted">Loading…</div>}
      {rows && (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Invoice</th><th>Customer</th><th>Deal</th><th>Issued</th><th>Due</th><th style={{ textAlign: 'right' }}>Total</th><th style={{ textAlign: 'right' }}>Received</th><th>Status</th>{me.seesAll && <th>Owner</th>}<th /></tr></thead>
            <tbody>
              {!shown.length && <tr><td colSpan={me.seesAll ? 10 : 9}><div className="empty"><h3>{rows.length ? 'No invoice matches' : 'No invoices yet'}</h3>{rows.length ? 'Try another search or status.' : 'When a deal is moved to Won, its invoice appears here.'}</div></td></tr>}
              {shown.map((x) => (
                <tr key={x.id} className="row-link" onClick={() => x.dealId && openRecord('deal', x.dealId)}>
                  <td><b>{x.code}</b></td>
                  <td>{x.accountName || '—'}{x.missing && x.missing.length > 0 && <div className="small-muted" style={{ fontSize: 11.5, color: 'var(--amber, #b45309)' }} title="Add it on the customer's account; invoices made later will carry it">⚠ no {x.missing.join(' / ')}</div>}</td>
                  <td>{x.title || '—'}</td>
                  <td>{dateOf(x.issueDate)}</td>
                  <td style={{ color: x.overdue ? 'var(--red)' : undefined }}>{x.dueDate ? dateOf(x.dueDate) : '—'}</td>
                  <td style={{ textAlign: 'right' }}>{money(x.total)}</td>
                  <td style={{ textAlign: 'right' }}>{money(x.paidAmount)}</td>
                  <td>{me.canEdit ? <><InvoiceStatusSelect inv={x} onSaved={replace} />{x.overdue && <> <Pill v="Overdue" /></>}</> : <Pill v={invoicePill(x)} />}</td>
                  {me.seesAll && <td>{x.ownerName || '—'}</td>}
                  <td><button type="button" className="btn btn-sm" onClick={(e) => { e.stopPropagation(); openInvoicePdf(x, toast); }}>PDF</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
