import { Link } from 'react-router-dom';
import DataTable from './DataTable.jsx';
import { money, fmtD } from '../../invoices/invFormat';

// ---------------------------------------------------------------------------
// EVERY NUMBER OPENS ITS LIST (reconciliation 2026-10-06). A figure on the
// Accounts Dashboard opens, right under it, the invoices or bills it adds up —
// from the SAME rows the page was built from (data.clients[].invoices and
// data.office.rows), so the list's total line is the card's number.
//
//   <SeeList onClick>   the small "See the 138 invoices" button under a number
//   <DrillPanel drill onClose>  the list itself, with a total line and Close
//   drill = { title, kind: 'inv' | 'bill', rows, note? }
// ---------------------------------------------------------------------------
const sumOf = (k) => (l) => money(l.reduce((a, r) => a + (Number(r[k]) || 0), 0));
const invTone = (s) => (s === 'Paid' ? 'green' : s === 'Overdue' ? 'red' : 'amber');
const payTone = (s) => (/^(Paid|Reimbursed)/.test(s) ? 'green' : 'amber');
const proofTone = (s) => (s === 'Proof attached' ? 'green' : s === 'Not paid yet' ? 'grey' : /^Reference/.test(s) ? 'amber' : 'red');

// Every invoice of the page, flat (each client row carries its own invoices).
export const flatInvoices = (clients) => (clients || []).flatMap((c) => c.invoices || []);

export function SeeList({ onClick, children, open }) {
  return (
    <button type="button" className="link-btn acd-see" onClick={onClick} aria-expanded={!!open}>
      {children}{open ? ' ▴' : ' ▾'}
    </button>
  );
}

const invCols = [
  { key: 'client', label: 'Client', render: (r) => <b>{r.client}</b> },
  { key: 'invoiceNumber', label: 'Invoice no', render: (r) => <Link to={`/invoices/${r.id}`}>{r.invoiceNumber}</Link> },
  { key: 'invoiceDate', label: 'Date', render: (r) => fmtD(r.invoiceDate) },
  { key: 'dueDate', label: 'Due', render: (r) => fmtD(r.dueDate) },
  { key: 'billing', label: 'Before GST', num: true, render: (r) => money(r.billing), foot: sumOf('billing') },
  { key: 'gst', label: 'GST', num: true, render: (r) => money(r.gst), foot: sumOf('gst') },
  { key: 'invoiceValue', label: 'After GST', num: true, render: (r) => money(r.invoiceValue), foot: sumOf('invoiceValue') },
  { key: 'tds', label: 'TDS', num: true, render: (r) => money(r.tds), foot: sumOf('tds') },
  { key: 'receivable', label: 'To receive', num: true, render: (r) => money(r.receivable), foot: sumOf('receivable') },
  { key: 'received', label: 'Received', num: true, render: (r) => money(r.received), foot: sumOf('received') },
  { key: 'pending', label: 'Pending', num: true, render: (r) => (r.pending > 0.5 ? <b>{money(r.pending)}</b> : r.pending < -0.5 ? <span style={{ color: 'var(--red)' }} title="Received for more than billed">{money(r.pending)} over-received</span> : '—'), foot: sumOf('pending') },
  { key: 'status', label: 'Status', render: (r) => <span className={`acd-pill ${invTone(r.status)}`}>{r.status}</span> },
];
const billCols = [
  { key: 'category', label: 'Category', render: (r) => <b>{r.category}</b> },
  { key: 'vendor', label: 'Vendor', render: (r) => r.vendor || '—' },
  { key: 'billNumber', label: 'Bill no', exportValue: (r) => r.billNumber || r.code || '', render: (r) => r.billNumber || <span className="small-muted">{r.code || '—'}</span> },
  { key: 'date', label: 'Bill date', render: (r) => fmtD(r.date) },
  { key: 'base', label: 'Before GST', num: true, render: (r) => money(r.base), foot: sumOf('base') },
  { key: 'gst', label: 'GST', num: true, render: (r) => money(r.gst), foot: sumOf('gst') },
  { key: 'tds', label: 'TDS', num: true, render: (r) => money(r.tds), foot: sumOf('tds') },
  { key: 'afterGst', label: 'After GST', num: true, render: (r) => money(r.afterGst), foot: sumOf('afterGst') },
  { key: 'net', label: 'Paid to vendor', num: true, render: (r) => money(r.net), foot: sumOf('net') },
  { key: 'pending', label: 'To be paid', num: true, render: (r) => (r.pending ? money(r.pending) : '—'), foot: sumOf('pending') },
  { key: 'payStatus', label: 'Payment', render: (r) => <span className={`acd-pill ${payTone(r.payStatus)}`}>{r.payStatus}</span> },
  { key: 'proofStatus', label: 'Proof', render: (r) => (r.proofStatus ? <span className={`acd-pill ${proofTone(r.proofStatus)}`}>{r.proofStatus}</span> : '—') },
  { key: 'gstin', label: 'Vendor GSTIN', render: (r) => (r.gstin ? <code>{r.gstin}</code> : (r.gst > 0.5 ? <span className="acd-pill red">missing</span> : '—')) },
];

const bankCols = [
  { key: 'date', label: 'Date', render: (r) => fmtD(r.date) },
  { key: 'description', label: 'Statement line', render: (r) => <span className="acd-wrap" style={{ display: 'block' }}>{r.description}</span> },
  { key: 'type', label: 'Credit / Debit' },
  { key: 'amount', label: 'Amount', num: true, render: (r) => money(r.amount), foot: sumOf('amount') },
  { key: 'state', label: 'State', render: (r) => <span className={`acd-pill ${r.state === 'Reconciled' ? 'green' : r.state === 'Unmatched' ? 'red' : 'amber'}`}>{r.state}</span> },
];

// canExport: the page may pass its own answer (the Reports page uses its Reports export right); else the Accounts Dashboard export right.
export function DrillPanel({ drill, onClose, extraCols = [], canExport }) {
  if (!drill) return null;
  const inv = drill.kind === 'inv';
  const bank = drill.kind === 'bank';
  return (
    <div className="acd-drillpanel" role="region" aria-label={drill.title}>
      <div className="acd-drillhead">
        <h3 style={{ fontSize: 13.5, margin: 0 }}>{drill.title}</h3>
        <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
      </div>
      {drill.note && <div className="small-muted" style={{ margin: '2px 0 6px' }}>{drill.note}</div>}
      <DataTable
        columns={[...(bank ? bankCols : inv ? invCols : billCols), ...extraCols]}
        rows={drill.rows}
        search={bank ? (r) => `${r.description} ${r.state}` : inv ? (r) => `${r.client} ${r.invoiceNumber}` : (r) => [r.category, r.vendor, r.billNumber, r.code, r.gstin].join(' ')}
        placeholder={bank ? 'Search the statement lines…' : inv ? 'Search client or invoice no…' : 'Search vendor, bill no, category…'}
        noun={bank ? 'statement lines' : inv ? 'invoices' : 'bills'}
        empty="Nothing here for these filters."
        foot
        exportName={drill.title}
        canExport={canExport}
        initialSort={inv ? { key: 'invoiceDate', dir: 'desc' } : { key: 'date', dir: 'desc' }}
      />
    </div>
  );
}
