// CRM > DEALS > INVOICES (founder 2026-11-13, the 5-module blueprint: "Won -> Customer + invoice -> Payment"). The CRM's OWN invoices,
// raised when a deal is Won: what is owed, what is overdue and what is paid. Self-contained - never the ATS Accounts invoices
// ("crm mottham separate application"). A salesperson sees their own, a manager / Admin everyone's. It is a view of the Deals page
// (`embedded`), not a module of its own: the CRM stays at five (founder 2026-11-14).
import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { ListFilterStrip, useListXf } from '../../components/ats/ListFilters.jsx';
import { useCrm, errOf, money, dateOf, Pill, invoicePill, InvoiceStatusSelect, openInvoicePdf, shareInvoiceWhatsApp, InvoiceEmailDialog, InvoiceEditDialog, INVOICE_STATUSES, balanceOf, download } from './crmShared.jsx';
import MultiSelect, { csvToList } from '../../components/ats/MultiSelect.jsx'; // checkboxes: several values per filter (founder 2026-11-20)

export default function CrmInvoices({ embedded = false }) {
  const { me, toast, openRecord, version } = useCrm();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [missing, setMissing] = useState(0); // Won deals with no invoice yet (won before invoices existed)
  const [busy, setBusy] = useState(false);
  const [mailInv, setMailInv] = useState(null); // the invoice whose email window is open
  const [editInv, setEditInv] = useState(null); // the Draft being edited
  const xf = useListXf('crminvoices'); // total, issued-on, due-on (components/ats/ListFilters.jsx)
  const load = () => api.get('/crm/invoices', { params: { ...xf.params, q: q || undefined } }).then((r) => { setRows(r.data.invoices); setMissing(r.data.missing || 0); setErr(''); }).catch((e) => setErr(errOf(e, 'The invoices could not be read.')));
  async function backfill() {
    setBusy(true);
    try { const r = await api.post('/crm/invoices/backfill'); toast(`${r.data.created} invoice${r.data.created === 1 ? '' : 's'} made, each dated the day its deal was won.`); await load(); } catch (e) { toast(errOf(e, 'The invoices could not be made.')); } finally { setBusy(false); }
  }
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [version, xf.key, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = (rows || []).filter((x) => x.status !== 'Cancelled');
  const sum = (list, f) => list.reduce((a, x) => a + (f(x) || 0), 0);
  const owed = sum(live.filter((x) => x.status !== 'Paid'), balanceOf);
  const overdue = live.filter((x) => x.overdue);
  const received = sum(live, (x) => x.paidAmount);
  const tds = sum(live, (x) => x.tdsAmount);
  const shown = useMemo(() => (rows || []).filter((x) => (!status || csvToList(status).some((s) => (s === 'Overdue' ? x.overdue : x.status === s)))
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
          <div className="card" style={{ padding: 12 }}><div className="small-muted">Overdue</div><div style={{ fontSize: 20, fontWeight: 700, color: overdue.length ? 'var(--red)' : undefined }}>{overdue.length} · {money(sum(overdue, balanceOf))}</div></div>
          <div className="card" style={{ padding: 12 }}><div className="small-muted">Received (cash)</div><div style={{ fontSize: 20, fontWeight: 700 }}>{money(received)}</div>{tds > 0 && <div className="small-muted" style={{ fontSize: 12 }}>+ {money(tds)} TDS deducted by customers</div>}</div>
        </div>
      )}
      <ListFilterStrip list="crminvoices" xf={xf} total={rows ? rows.length : null} noun="invoices" allTime={Object.keys(xf.values).length > 0 || !!q} />
      <div className="filter-row">
        <input type="text" placeholder="Search invoice, customer or deal" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 240 }} aria-label="Search invoices" />
        <MultiSelect label="Status" allLabel="All statuses" value={status} onChange={setStatus} options={['Overdue', ...INVOICE_STATUSES].map((s) => ({ value: s, label: s, count: (rows || []).filter((x) => (s === 'Overdue' ? x.overdue : x.status === s)).length }))} hideZero={false} />
        {/* wave D: the sent invoices as a file for the books (Tally XML / Zoho Books CSV) - a download only, nothing is posted to Accounts */}
        {me.rights && me.rights.export && (
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
            <button type="button" className="btn btn-sm" title="Sales vouchers (party, sales and GST ledgers) to import into Tally" onClick={() => download('/crm/plus/invoices/export?format=tally', 'crm-invoices-tally.xml').catch(() => toast('The download did not work.'))}>Tally XML</button>
            <button type="button" className="btn btn-sm" title="Zoho Books invoice import file" onClick={() => download('/crm/plus/invoices/export?format=zoho', 'crm-invoices-zoho-books.csv').catch(() => toast('The download did not work.'))}>Zoho Books CSV</button>
          </span>
        )}
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
                <tr key={x.id} className="row-link" onClick={() => x.dealId && openRecord('deal', x.dealId)} style={x.overdue ? { boxShadow: 'inset 3px 0 0 var(--red)', background: 'rgba(220, 38, 38, 0.05)' } : undefined}>
                  <td><b style={{ color: x.overdue ? 'var(--red)' : undefined }}>{x.code}</b>{x.gst && x.gst.flag && <div className="small-muted" style={{ fontSize: 11, color: 'var(--amber, #b45309)' }} title={x.gst.flag}>⚠ IGST: state not known</div>}</td>
                  <td>{x.accountName || '—'}{x.missing && x.missing.length > 0 && <div className="small-muted" style={{ fontSize: 11.5, color: 'var(--amber, #b45309)' }} title="Add it on the customer's account; invoices made later will carry it">⚠ no {x.missing.join(' / ')}</div>}</td>
                  <td>{x.title || '—'}</td>
                  <td>{dateOf(x.issueDate)}</td>
                  <td style={{ color: x.overdue ? 'var(--red)' : undefined }}>{x.dueDate ? dateOf(x.dueDate) : '—'}</td>
                  <td style={{ textAlign: 'right' }}>{money(x.total)}</td>
                  <td style={{ textAlign: 'right' }}>{money(x.paidAmount)}{x.tdsAmount > 0 && <div className="small-muted" style={{ fontSize: 11 }}>+ TDS {money(x.tdsAmount)}</div>}</td>
                  <td>{me.canEdit ? <><InvoiceStatusSelect inv={x} onSaved={replace} />{x.overdue && <> <Pill v="Overdue" /></>}</> : <Pill v={invoicePill(x)} />}</td>
                  {me.seesAll && <td>{x.ownerName || '—'}</td>}
                  <td style={{ whiteSpace: 'nowrap' }}><button type="button" className="btn btn-sm" onClick={(e) => { e.stopPropagation(); openInvoicePdf(x, toast); }}>PDF</button>{me.canEdit && x.status === 'Draft' && <> <button type="button" className="btn btn-sm" title="Edit the Draft: lines, notes, due date" aria-label={`Edit ${x.code}`} onClick={(e) => { e.stopPropagation(); setEditInv(x); }}>✏️</button></>}{me.canEdit && x.status !== 'Cancelled' && <> <button type="button" className="btn btn-sm" title="Send by email, with the PDF attached" aria-label={`Send ${x.code} by email`} onClick={(e) => { e.stopPropagation(); setMailInv(x); }}>✉️ Send</button> <button type="button" className="btn btn-sm" title="Opens WhatsApp with the message and a link to the invoice; you press Send" aria-label={`Send ${x.code} on WhatsApp`} onClick={(e) => { e.stopPropagation(); shareInvoiceWhatsApp(x, toast, () => load()); }}>💬</button></>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {mailInv && <InvoiceEmailDialog inv={mailInv} onClose={() => setMailInv(null)} onSent={() => load()} />}
      {editInv && <InvoiceEditDialog inv={editInv} onClose={() => setEditInv(null)} onSaved={(inv) => { setEditInv(null); replace(inv); }} />}
    </div>
  );
}
