import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../../api';
import DataTable from './DataTable.jsx';
import AttachProofModal from './AttachProofModal.jsx';
import PaymentModal from '../../invoices/PaymentModal.jsx';
import { money, fmtD } from '../../invoices/invFormat';

// 6. PENDING & RECEIVED — CLIENT BY CLIENT (Accounts spec S8.7). "Who owes
// TeamLink money?" Click a client: all its invoices open in place.
const STATUSES = ['Paid', 'Partially Paid', 'Pending', 'Overdue', 'Settled'];
const TONE = {
  Paid: 'green', Settled: 'green', 'Partially Paid': 'amber', Pending: 'amber', Overdue: 'red',
};
const invTone = (s) => (s === 'Paid' ? 'green' : s === 'Overdue' ? 'red' : 'amber');
const proofTone = (p) => (!p ? 'grey' : p === 'Proof attached' ? 'green' : /^Reference/.test(p) ? 'amber' : 'red');
const sumOf = (k) => (l) => money(l.reduce((a, r) => a + (Number(r[k]) || 0), 0));

export default function ClientTable({
  clients, canPay, canAttach, onChanged, flash,
}) {
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState(() => new Set());
  const [pay, setPay] = useState(null);
  const [attach, setAttach] = useState(null);
  const rows = useMemo(() => (status ? clients.filter((c) => c.status === status) : clients), [clients, status]);
  const toggle = (c) => setOpen((s) => { const n = new Set(s); if (n.has(c.client)) n.delete(c.client); else n.add(c.client); return n; });

  const invCols = [
    { key: 'invoiceNumber', label: 'Invoice no', render: (r) => <Link to={`/invoices/${r.id}`}>{r.invoiceNumber}</Link> },
    { key: 'invoiceDate', label: 'Date', render: (r) => fmtD(r.invoiceDate) },
    { key: 'dueDate', label: 'Due', render: (r) => fmtD(r.dueDate) },
    { key: 'candidateName', label: 'Candidate / role', render: (r) => <span className="acd-wrap" style={{ display: 'block' }}>{r.candidateName || '—'}{r.role ? <div className="small-muted">{r.role}</div> : null}</span> },
    { key: 'billing', label: 'Before GST', num: true, render: (r) => money(r.billing), foot: sumOf('billing') },
    { key: 'gst', label: 'GST', num: true, render: (r) => money(r.gst), foot: sumOf('gst') },
    { key: 'invoiceValue', label: 'After GST', num: true, render: (r) => money(r.invoiceValue), foot: sumOf('invoiceValue') },
    { key: 'tds', label: 'TDS', num: true, render: (r) => (<>{money(r.tds)}{r.tdsCert ? <div className="small-muted">cert {r.tdsCert}</div> : null}</>), foot: sumOf('tds') },
    { key: 'receivable', label: 'Receivable', num: true, render: (r) => money(r.receivable), foot: sumOf('receivable') },
    { key: 'received', label: 'Received', num: true, render: (r) => money(r.received), foot: sumOf('received') },
    { key: 'pending', label: 'Pending', num: true, render: (r) => <b>{r.pending > 0.5 ? money(r.pending) : 'settled'}</b>, foot: sumOf('pending') },
    { key: 'daysOverdue', label: 'Late', num: true, render: (r) => (r.overdue ? <span className="acd-pill red">{r.daysOverdue} days · {money(r.pending)}</span> : '—') },
    {
      key: 'history',
      label: 'Payments',
      nosort: true,
      render: (r) => (r.receipts.length
        ? r.receipts.map((x, i) => <div key={i} className="small-muted">{fmtD(x.date)} · {money(x.amount)}{x.from === 'invoice' ? ' (on the invoice)' : ''}</div>)
        : <span className="small-muted">none yet</span>),
    },
    { key: 'lastPayment', label: 'Last payment', render: (r) => (r.lastPayment ? fmtD(r.lastPayment) : 'never') },
    {
      key: 'proof',
      label: 'Proof',
      render: (r) => (r.proof
        ? (
          <>
            <span className={`acd-pill ${proofTone(r.proof)}`}>{r.proof}</span>
            {r.proofDoc?.file && <div><a href={`/api/dashboard/accounts/control/proof/invoice/${r.id}/file?inline=1`} target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); openFile(r.id); }}>View file</a></div>}
          </>
        )
        : <span className="small-muted">nothing received</span>),
    },
    { key: 'employee', label: 'Employee', render: (r) => r.employee || '—' },
    { key: 'status', label: 'Status', render: (r) => <span className={`acd-pill ${invTone(r.status)}`}>{r.status}</span> },
    {
      key: 'act',
      label: 'Actions',
      nosort: true,
      render: (r) => (
        <div className="acd-acts">
          <Link className="btn btn-sm" to={`/invoices/${r.id}`}>View</Link>
          {canPay && r.pending > 0.5 && <button type="button" className="btn btn-sm btn-primary" onClick={() => setPay({ rows: [r], id: r.id })}>+ Payment</button>}
          {canAttach && r.proof && r.proof !== 'Proof attached' && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setAttach({
                key: `invoice:${r.id}`, kind: 'invoice', id: r.id, party: r.client, ref: r.invoiceNumber, amount: r.received, paidOn: r.lastPayment, proofType: 'Payment receipt / bank proof',
              })}
            >
              Attach proof
            </button>
          )}
        </div>
      ),
    },
  ];

  const cols = [
    { key: 'client', label: 'Client', render: (c) => <b>{open.has(c.client) ? '▾' : '▸'} {c.client}</b> },
    { key: 'department', label: 'Department' },
    { key: 'manager', label: 'Employee / account manager', render: (c) => c.manager || '—' },
    { key: 'invoiceCount', label: 'Invoices', num: true, render: (c) => c.invoiceCount, foot: (l) => l.reduce((a, c) => a + c.invoiceCount, 0) },
    { key: 'billing', label: 'Before GST', num: true, render: (c) => money(c.billing), foot: sumOf('billing') },
    { key: 'invoiceValue', label: 'After GST', num: true, render: (c) => money(c.invoiceValue), foot: sumOf('invoiceValue') },
    { key: 'receivable', label: 'Receivable', num: true, render: (c) => money(c.receivable), foot: sumOf('receivable') },
    { key: 'received', label: 'Received', num: true, render: (c) => <span style={{ color: 'var(--green)' }}>{money(c.received)}</span>, foot: sumOf('received') },
    { key: 'pending', label: 'Pending', num: true, render: (c) => <b style={{ color: c.pending > 0.5 ? 'var(--amber)' : undefined }}>{c.pending > 0.5 ? money(c.pending) : '—'}</b>, foot: sumOf('pending') },
    { key: 'overdue', label: 'Late', num: true, render: (c) => (c.overdue > 0.5 ? <b style={{ color: 'var(--red)' }}>{money(c.overdue)}</b> : '—'), foot: sumOf('overdue') },
    {
      key: 'collectedPct',
      label: 'Collected',
      num: true,
      render: (c) => `${c.collectedPct}%`,
      foot: (l) => { const r = l.reduce((a, c) => a + c.receivable, 0); return `${r > 0 ? Math.round((l.reduce((a, c) => a + c.received, 0) / r) * 100) : 0}%`; },
    },
    { key: 'lastPayment', label: 'Last payment', render: (c) => (c.lastPayment ? fmtD(c.lastPayment) : 'never') },
    { key: 'nextDue', label: 'Next due date', render: (c) => (c.nextDue ? fmtD(c.nextDue) : '—') },
    { key: 'daysOverdue', label: 'Days late', num: true, render: (c) => (c.daysOverdue ? <span className="acd-pill red">{c.daysOverdue} days</span> : '—') },
    { key: 'proofStatus', label: 'Proof status', get: (c) => c.proofMissing, render: (c) => <span className={`acd-pill ${c.proofMissing ? 'red' : (c.proofStatus === 'All attached' ? 'green' : 'grey')}`}>{c.proofStatus}</span> },
    { key: 'status', label: 'Status', render: (c) => <span className={`acd-pill ${TONE[c.status] || 'grey'}`}>{c.status}</span> },
    {
      key: 'act',
      label: 'Actions',
      nosort: true,
      render: (c) => (
        <div className="acd-acts">
          <button type="button" className="btn btn-sm" onClick={() => toggle(c)}>{open.has(c.client) ? 'Hide invoices' : 'Show invoices'}</button>
          {canPay && c.pending > 0.5 && <button type="button" className="btn btn-sm btn-primary" onClick={() => setPay({ rows: c.invoices, id: (c.invoices.find((r) => r.pending > 0.5) || {}).id })}>+ Payment</button>}
        </div>
      ),
    },
  ];

  return (
    <section className="acd-sec" id="clients">
      <h2><span className="acd-n">6</span> Pending &amp; received — client by client</h2>
      <p className="acd-q">Who owes TeamLink money? Click a client to see every invoice.</p>
      <div className="acd-strip">
        <button type="button" className={`acd-pill ${status ? 'grey' : 'blue'}`} onClick={() => setStatus('')}>All · {clients.length}</button>
        {STATUSES.map((s) => {
          const n = clients.filter((c) => c.status === s).length;
          if (!n && status !== s) return null;
          return <button type="button" key={s} className={`acd-pill ${status === s ? TONE[s] : 'grey'}`} onClick={() => setStatus(status === s ? '' : s)}>{s} · {n}</button>;
        })}
      </div>
      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(c) => c.client}
        search={(c) => [c.client, c.department, c.manager, c.status, ...c.invoices.map((r) => `${r.invoiceNumber} ${r.candidateName || ''}`)].join(' ')}
        placeholder="Search client, invoice no, candidate…"
        noun="clients"
        empty="No client invoices for these filters."
        foot
        initialSort={{ key: 'pending', dir: 'desc' }}
        expand={{
          isOpen: (c) => open.has(c.client),
          toggle,
          render: (c) => (
            <>
              <h4>{c.client} — {c.invoiceCount} invoice{c.invoiceCount === 1 ? '' : 's'} · pending {money(c.pending)}</h4>
              <DataTable columns={invCols} rows={c.invoices} noun="invoices" foot pageSize={50} initialSort={{ key: 'invoiceDate', dir: 'desc' }} />
            </>
          ),
        }}
      />
      {pay && (
        <PaymentModal
          rows={pay.rows}
          initialId={pay.id}
          onClose={() => setPay(null)}
          onSaved={(id, msg) => { setPay(null); flash(msg || 'Payment recorded.'); onChanged(true); }}
        />
      )}
      {attach && <AttachProofModal rec={attach} onClose={() => setAttach(null)} onDone={(msg) => { setAttach(null); flash(msg); onChanged(); }} />}
    </section>
  );
}

// The proof file goes through the API with the login token (a plain link
// would carry no Authorization header).
async function openFile(id) {
  try {
    const r = await api.get(`/dashboard/accounts/control/proof/invoice/${id}/file`, { params: { inline: 1 }, responseType: 'blob' });
    const url = URL.createObjectURL(r.data);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch { /* the cell stays as it is */ }
}
