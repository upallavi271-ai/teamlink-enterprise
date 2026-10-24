import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../../api';
import DataTable from './DataTable.jsx';
import AttachProofModal from './AttachProofModal.jsx';
import ProofReminderAuto from './ProofReminderAuto.jsx';
import { money, fmtD } from '../../invoices/invFormat';

// 3. PROOF REMINDER (Accounts spec S8.3). Every PAID / RECEIVED record whose
// proof document is missing, with a reminder to the record's accountant:
//   automatic   the daily summary (WhatsApp + email + bell, 9:30 AM and 5:00 PM India time) goes by itself; the manual 'Remind accountant'
//               buttons were removed from this screen (2026-10-21), the API stays for emergencies (utils/accountsControl.js)
//   WhatsApp    a wa.me link with the message ready — the person sends it
//               from their own WhatsApp; the click is logged
//   SMS         needs an SMS account (none connected)
//   Email       the daily WhatsApp + email reminders (card at the bottom; ON by default)
const STATUS_TONE = {
  'Proof Missing': 'red', 'Reminder Pending': 'amber', 'Reminder Sent': 'amber', Resolved: 'green',
};
const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

export default function ProofReminder({
  proof, onChanged, flash,
}) {
  const [show, setShow] = useState(''); // '' | 'missing' | 'all'
  const [attach, setAttach] = useState(null);
  const c = proof.counts;
  const link = (r) => (r.kind === 'invoice' ? `/invoices/${r.id}` : '/office');
  const fullText = (r) => `${r.message}\nLink: ${window.location.origin}${r.kind === 'invoice' ? `/invoices/${r.id}` : '/accounts/dashboard#proof'}`;

  const whatsapp = (r) => {
    const url = `https://wa.me/${r.whatsappTo || ''}?text=${encodeURIComponent(fullText(r))}`;
    window.open(url, '_blank', 'noopener');
    api.post('/dashboard/accounts/control/whatsapp', { key: r.key }).then(onChanged).catch(() => {});
  };

  const cols = [
    { key: 'party', label: 'Client / vendor', get: (r) => r.party, render: (r) => <b>{r.party || '—'}</b> },
    { key: 'kind', label: 'Type', get: (r) => r.kind, render: (r) => (r.kind === 'invoice' ? 'Money received' : 'Bill paid') },
    { key: 'ref', label: 'Invoice / bill no', render: (r) => <Link to={link(r)}>{r.ref || 'open'}</Link> },
    { key: 'amount', label: 'Amount', num: true, render: (r) => money(r.amount) },
    { key: 'paidOn', label: 'Payment date', render: (r) => fmtD(r.paidOn) },
    {
      key: 'proofType',
      label: 'Missing proof',
      render: (r) => (
        <>
          {r.proofType}
          {r.refOnly && <div><span className="acd-pill amber">Reference only — document missing</span></div>}
        </>
      ),
    },
    { key: 'accountant', label: 'Accountant', render: (r) => r.accountant || '—' },
    { key: 'status', label: 'Status', render: (r) => <span className={`acd-pill ${STATUS_TONE[r.status] || 'grey'}`}>{r.status}</span> },
    { key: 'lastReminder', label: 'Last reminder', get: (r) => r.lastReminder || r.whatsappAt, render: (r) => (r.lastReminder ? when(r.lastReminder) : (r.whatsappAt ? `WhatsApp ${when(r.whatsappAt)}` : '—')) },
    {
      key: 'act',
      label: 'Actions',
      nosort: true,
      render: (r) => (
        <div className="acd-acts">
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setAttach(r)}>Attach proof</button>
          <button type="button" className="btn btn-sm" onClick={() => whatsapp(r)} title="Opens WhatsApp with the message ready — you press send">Open WhatsApp</button>
          <span className="acd-pill grey" title="No SMS account is connected yet">SMS: needs SMS account</span>
        </div>
      ),
    },
  ];
  const resolvedCols = [
    { key: 'kind', label: 'Record', render: (r) => <Link to={r.kind === 'invoice' ? `/invoices/${r.id}` : '/office'}>{r.what || (r.kind === 'invoice' ? 'Invoice' : 'Bill')}</Link> },
    { key: 'status', label: 'Status', render: () => <><span className="acd-pill green">Proof Attached</span> <span className="acd-pill green">Resolved</span></> },
    { key: 'by', label: 'Who', render: (r) => r.by || '—' },
    { key: 'at', label: 'When', get: (r) => String(r.at || ''), render: (r) => (r.at ? (String(r.at).length > 10 ? when(r.at) : fmtD(r.at)) : '—') },
  ];

  return (
    <section className="acd-sec" id="proof">
      <h2><span className="acd-n">2</span> Proof reminder</h2>
      <p className="acd-q">Which payments are marked paid or received, but have no proof document behind them?</p>
      {c.missing === 0 ? (
        <div className="notice"><span>Every paid and received record in view has its proof on file.</span></div>
      ) : (
        <div className="acd-cards four">
          <div className="acd-card red"><div className="acd-cl">Proof missing</div><div className="acd-cv">{c.missing}</div><div className="acd-cs">paid / received records</div></div>
          <div className="acd-card red"><div className="acd-cl">Amount affected</div><div className="acd-cv">{money(c.amount)}</div><div className="acd-cs">money with no document behind it</div></div>
          <div className="acd-card amber"><div className="acd-cl">Reminders sent</div><div className="acd-cv">{c.remindersSent}</div><div className="acd-cs">{c.lastReminder ? `last ${when(c.lastReminder)}` : 'none sent yet'}</div></div>
          <div className="acd-card"><div className="acd-cl">Assigned accountant</div><div className="acd-cv" style={{ fontSize: 15 }}>{proof.accountants.length ? proof.accountants[0] : 'Not set'}</div><div className="acd-cs">{proof.accountants.length > 1 ? `+${proof.accountants.length - 1} more on the Accounts desk` : 'from the record, else the Accounts desk'}</div></div>
        </div>
      )}
      <div className="acd-strip">
        <span className="acd-pill red">Proof Missing · {c.byStatus['Proof Missing'] || 0}</span>
        <span className="acd-pill amber">Reminder Pending · {c.byStatus['Reminder Pending'] || 0}</span>
        <span className="acd-pill amber">Reminder Sent · {c.byStatus['Reminder Sent'] || 0}</span>
        <span className="acd-pill green">Proof Attached / Resolved · {c.resolved}</span>
      </div>
      <div className="small-muted" style={{ margin: '6px 0' }}>The reminders go out by themselves, every day. Nobody has to press a button. See the times and the last message sent in the card at the bottom.</div>
      <div className="acd-btns">
        <button type="button" className="btn" disabled={!c.missing} onClick={() => setShow(show === 'missing' ? '' : 'missing')}>{show === 'missing' ? 'Hide missing proofs' : 'View missing proofs'}</button>
        <button type="button" className="btn" disabled={!c.missing} onClick={() => setShow('missing')} title="Pick the record in the list, then Attach proof">Attach proof</button>
        <button type="button" className="btn" onClick={() => setShow(show === 'all' ? '' : 'all')}>{show === 'all' ? 'Hide all' : 'View all'}</button>
      </div>
      {(show === 'missing' || show === 'all') && (
        <DataTable
          columns={cols}
          rows={proof.records}
          rowKey={(r) => r.key}
          search={(r) => [r.party, r.ref, r.proofType, r.accountant, r.status, ...(r.refs || [])].join(' ')}
          placeholder="Search client, vendor, invoice or bill no…"
          noun="missing proofs"
          empty="No missing proofs for these filters."
          initialSort={{ key: 'amount', dir: 'desc' }}
        />
      )}
      {show === 'all' && (
        <>
          <h3 style={{ fontSize: 13.5, margin: '14px 0 4px' }}>Attached and resolved (last 90 days)</h3>
          <DataTable columns={resolvedCols} rows={proof.resolved} rowKey={(r) => r.key} noun="resolved" empty="No proof has been attached in the last 90 days." />
        </>
      )}
      <ProofReminderAuto flash={flash} />
      {attach && (
        <AttachProofModal
          rec={attach}
          onClose={() => setAttach(null)}
          onDone={(msg) => { setAttach(null); flash(msg); onChanged(); }}
        />
      )}
    </section>
  );
}
