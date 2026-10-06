import { useState } from 'react';
import api from '../../../api';
import DataTable from './DataTable.jsx';
import AttachProofModal from './AttachProofModal.jsx';
import ExpenseDrawer from '../../office/ExpenseDrawer.jsx';
import QuickExpenseModal from '../../office/QuickExpenseModal.jsx';
import BillPreview from '../../office/BillPreview.jsx';
import { useOfficeAccess, detailCache } from '../../office/approval.jsx';
import { money, fmtD } from '../../invoices/invFormat';

// 4. OFFICE SPENDS (Accounts spec S8.5) — the Office page's own bills
// (routes/office.js decorate(): hand loans and rejected bills left out).
// The four headline amounts (total / paid / to be paid / late) are on the
// Office expenses card just above, so they are not repeated here.
const sumOf = (k) => (l) => money(l.reduce((a, r) => a + (Number(r[k]) || 0), 0));
const payTone = (s) => (/^(Paid|Reimbursed)/.test(s) ? 'green' : 'amber');
const proofTone = (s) => (s === 'Proof attached' ? 'green' : s === 'Not paid yet' ? 'grey' : /^Reference/.test(s) ? 'amber' : 'red');

export default function OfficeSpends({
  office, canManage, onChanged, flash,
}) {
  const [openId, setOpenId] = useState(null);
  const [attach, setAttach] = useState(null);
  const [edit, setEdit] = useState(null);
  const [bill, setBill] = useState(null);
  const [busy, setBusy] = useState('');
  const access = useOfficeAccess();
  const changed = () => { detailCache.clear(); onChanged(); };

  const openEdit = async (id) => {
    setBusy(`e:${id}`);
    try {
      const [d, o] = await Promise.all([api.get(`/office-expenses/${id}`), api.get('/office-expenses/ledger', { params: { page: 1, pageSize: 1 } })]);
      setEdit({ row: d.data, options: o.data.options });
    } catch (e) { flash(e.response?.data?.error || 'This bill could not be opened for editing.', 'red'); }
    setBusy('');
  };
  const markPaid = async (r) => {
    setBusy(`p:${r.id}`);
    try {
      await api.patch(`/office-expenses/${r.id}/status`, { action: 'mark_paid' });
      flash(`${r.code || 'The bill'} is marked paid.`);
      changed();
    } catch (e) { flash(e.response?.data?.error || 'It could not be marked paid.', 'red'); }
    setBusy('');
  };
  const attachRec = (r) => ({
    key: `expense:${r.id}`, kind: 'expense', id: r.id, party: r.vendor || r.category, ref: r.billNumber || r.code, amount: r.paid || r.net, paidOn: r.paidOn, proofType: r.proofType || 'Expense bill / vendor invoice',
  });

  const actions = (r) => (
    <div className="acd-acts">
      <button type="button" className="btn btn-sm" onClick={() => setOpenId(r.id)} title="Details and history">View &amp; history</button>
      {canManage && <button type="button" className="btn btn-sm" disabled={busy === `e:${r.id}`} onClick={() => openEdit(r.id)}>Edit</button>}
      {canManage && r.proofStatus !== 'Proof attached' && <button type="button" className="btn btn-sm" onClick={() => setAttach(attachRec(r))}>Attach proof</button>}
      {canManage && r.pending > 0 && (
        <button type="button" className="btn btn-sm btn-primary" disabled={busy === `p:${r.id}`} onClick={() => markPaid(r)} title="Record the payment — the bill is paid in full">
          {busy === `p:${r.id}` ? 'Saving…' : 'Mark paid'}
        </button>
      )}
    </div>
  );

  const toPayCols = [
    { key: 'vendor', label: 'Vendor', get: (r) => r.vendor || r.category, render: (r) => <b>{r.vendor || r.category}</b> },
    { key: 'billNumber', label: 'Invoice no', render: (r) => r.billNumber || r.code || '—' },
    { key: 'date', label: 'Inv date', render: (r) => fmtD(r.date) },
    { key: 'dueDate', label: 'Due', render: (r) => fmtD(r.dueDate) },
    { key: 'net', label: 'Amount due', num: true, render: (r) => money(r.net), foot: sumOf('net') },
    { key: 'paid', label: 'Paid', num: true, render: (r) => money(r.paid), foot: sumOf('paid') },
    { key: 'pending', label: 'Balance', num: true, render: (r) => <b>{money(r.pending)}</b>, foot: sumOf('pending') },
    { key: 'daysOverdue', label: 'Days late', num: true, render: (r) => (r.daysOverdue ? <span className="acd-pill red">{r.daysOverdue} days</span> : <span className="acd-pill amber">not late</span>) },
    { key: 'employee', label: 'Employee', render: (r) => r.employee || '—' },
    { key: 'payStatus', label: 'Payment status', render: (r) => <span className={`acd-pill ${payTone(r.payStatus)}`}>{r.payStatus}</span> },
    { key: 'proofStatus', label: 'Proof status', render: (r) => <span className={`acd-pill ${proofTone(r.proofStatus)}`}>{r.proofStatus}</span> },
  ];
  const cols = [
    { key: 'category', label: 'Category', render: (r) => <b>{r.category}</b> },
    { key: 'vendor', label: 'Vendor', render: (r) => r.vendor || '—' },
    { key: 'billNumber', label: 'Invoice no', render: (r) => r.billNumber || <span className="small-muted">{r.code || '—'}</span> },
    { key: 'date', label: 'Invoice date', render: (r) => fmtD(r.date) },
    { key: 'dueDate', label: 'Due date', render: (r) => fmtD(r.dueDate) },
    { key: 'department', label: 'Department', render: () => <span className="small-muted" title="An office bill is a company cost — it has no department">Company</span>, nosort: true },
    { key: 'employee', label: 'Employee', render: (r) => r.employee || '—' },
    { key: 'base', label: 'Before GST', num: true, render: (r) => money(r.base), foot: sumOf('base') },
    { key: 'gst', label: 'GST', num: true, render: (r) => money(r.gst), foot: sumOf('gst') },
    { key: 'tds', label: 'TDS', num: true, render: (r) => money(r.tds), foot: sumOf('tds') },
    { key: 'afterGst', label: 'After GST', num: true, render: (r) => money(r.afterGst), foot: sumOf('afterGst') },
    { key: 'paid', label: 'Paid', num: true, render: (r) => (r.paid ? money(r.paid) : '—'), foot: sumOf('paid') },
    { key: 'pending', label: 'Pending', num: true, render: (r) => (r.pending ? money(r.pending) : '—'), foot: sumOf('pending') },
    { key: 'overdue', label: 'Late', num: true, get: (r) => (r.overdue ? r.pending : 0), render: (r) => (r.overdue ? <b style={{ color: 'var(--red)' }}>{money(r.pending)}</b> : '—'), foot: (l) => money(l.filter((r) => r.overdue).reduce((a, r) => a + r.pending, 0)) },
    { key: 'payStatus', label: 'Payment status', render: (r) => <span className={`acd-pill ${payTone(r.payStatus)}`}>{r.payStatus}</span> },
    { key: 'proofStatus', label: 'Proof status', render: (r) => <span className={`acd-pill ${proofTone(r.proofStatus)}`}>{r.proofStatus}</span> },
    { key: 'gstin', label: 'GSTIN', render: (r) => (r.gstin ? <code>{r.gstin}</code> : (r.gst > 0.5 ? <span className="acd-pill red">missing</span> : '—')) },
    { key: 'act', label: 'Actions', nosort: true, render: actions },
  ];
  const c = office.counts;

  return (
    <section className="acd-sec" id="office">
      <h2><span className="acd-n">4</span> Office spends</h2>
      <p className="acd-q">Where does the office money go, and whom do we still have to pay?</p>
      <div className="acd-cards four">
        <div className="acd-card"><div className="acd-cl">Before GST</div><div className="acd-cv">{money(office.before)}</div><div className="acd-cs">the cost itself</div></div>
        <div className="acd-card"><div className="acd-cl">GST on bills</div><div className="acd-cv">{money(office.gst)}</div><div className="acd-cs">paid to vendors — see GST position</div></div>
        <div className="acd-card"><div className="acd-cl">After GST</div><div className="acd-cv">{money(office.after)}</div><div className="acd-cs">bill value</div></div>
        <div className="acd-card"><div className="acd-cl">TDS we cut</div><div className="acd-cv">{money(office.tds)}</div><div className="acd-cs">paid to Government, not the vendor</div></div>
      </div>
      <div className="acd-strip">
        <span className="acd-pill blue">Records · {c.records}</span>
        <span className="acd-pill green">Paid · {c.paid}</span>
        <span className="acd-pill amber">To be paid · {c.pending}</span>
        <span className={`acd-pill ${c.overdue ? 'red' : 'grey'}`}>Late · {c.overdue}</span>
        <span className={`acd-pill ${c.missingProof ? 'red' : 'green'}`}>Paid, proof missing · {c.missingProof}</span>
      </div>

      <h3 style={{ fontSize: 13.5, margin: '12px 0 4px' }}>Who has to be paid</h3>
      {office.toPay.length ? (
        <DataTable columns={toPayCols} rows={office.toPay} noun="bills to pay" foot initialSort={{ key: 'daysOverdue', dir: 'desc' }} />
      ) : <div className="notice"><span>Every bill in view is paid.</span></div>}

      <h3 style={{ fontSize: 13.5, margin: '14px 0 4px' }}>Every bill</h3>
      <DataTable
        columns={cols}
        rows={office.rows}
        search={(r) => [r.category, r.vendor, r.billNumber, r.code, r.employee, r.gstin, r.payStatus, r.proofStatus].join(' ')}
        placeholder="Search vendor, bill no, category, GSTIN…"
        noun="bills"
        empty="No office bills in this period."
        foot
        initialSort={{ key: 'date', dir: 'desc' }}
      />

      {openId && (
        <ExpenseDrawer
          id={openId}
          summary={null}
          canManage={canManage}
          onClose={() => setOpenId(null)}
          onChanged={changed}
          onEdit={(d) => { setOpenId(null); openEdit(d.id); }}
          onEditFull={(d) => { setOpenId(null); openEdit(d.id); }}
          onDelete={() => flash('Delete a bill from the Office & Accounts page.', 'red')}
          onViewBill={(r) => setBill(r)}
        />
      )}
      {bill && <BillPreview expense={bill} onClose={() => setBill(null)} />}
      {edit && (
        <QuickExpenseModal
          row={edit.row}
          access={access}
          options={edit.options}
          onClose={() => setEdit(null)}
          onSaved={() => { setEdit(null); flash('Saved.'); changed(); }}
          onOpenFull={() => flash('The full form is on the Office & Accounts page.')}
        />
      )}
      {attach && (
        <AttachProofModal rec={attach} onClose={() => setAttach(null)} onDone={(msg) => { setAttach(null); flash(msg); changed(); }} />
      )}
    </section>
  );
}
