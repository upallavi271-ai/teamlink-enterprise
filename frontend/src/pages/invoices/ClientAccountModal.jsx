// "Account" on the invoice register — the client's account with us, as a
// ledger: every invoice raised (receivable after TDS) and every receipt
// against it, oldest first, with the running balance still owed.
// GET /invoices/client-account/:clientId, scoped exactly like the register.
// It never opens the Clients module, so an Accounts login that cannot see
// Clients still gets the money side of the client.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { money2, fmtD } from './invFormat';

const STATUS_WORD = { Paid: 'Settled', 'Partially Paid': 'Partially paid' };

export default function ClientAccountModal({ clientId, clientName, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setData(null); setError('');
    api.get(`/invoices/client-account/${clientId}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e.response?.data?.error || 'The client account could not be loaded.'));
  }, [clientId]);

  const t = data?.totals;
  return (
    <Modal
      title={`Account · ${data?.client?.name || clientName || 'Client'}`}
      note={data?.client?.gst ? `GSTIN ${data.client.gst}` : undefined}
      size="xwide"
      onClose={onClose}
      footer={<button type="button" className="btn btn-primary" onClick={onClose}>Close</button>}
    >
      {error && <div className="notice red"><span>{error}</span></div>}
      {!data && !error && <div className="small-muted">Loading…</div>}
      {data && (
        <>
          <div className="inv-badges" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', marginBottom: 14 }}>
            <div className="inv-badge"><span>Invoices</span><strong>{t.invoices}</strong></div>
            <div className="inv-badge"><span>Receivable</span><strong>{money2(t.billed)}</strong></div>
            <div className="inv-badge"><span>Received</span><strong>{money2(t.received)}</strong></div>
            <div className="inv-badge"><span>Pending</span><strong style={{ color: t.pending > 0.5 ? 'var(--red)' : 'var(--teal)' }}>{money2(t.pending)}</strong></div>
          </div>

          <h4 style={{ fontSize: 12, color: 'var(--ink-soft)', margin: '0 0 8px' }}>LEDGER</h4>
          <div className="tbl-wrap" style={{ maxHeight: '42vh' }}>
            <table>
              <thead>
                <tr>
                  <th>Date</th><th>Particulars</th><th className="num">Debit (invoice)</th>
                  <th className="num">Credit (received)</th><th className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l, i) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <tr key={i}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtD(l.date)}</td>
                    <td>
                      {l.kind === 'invoice'
                        ? <Link to={`/invoices/${l.invoiceId}`} onClick={onClose}>{l.particulars}</Link>
                        : l.particulars}
                      {l.fromBank && <span className="status priority-low" style={{ marginLeft: 6 }}>bank proof</span>}
                    </td>
                    <td className="num">{l.debit ? money2(l.debit) : ''}</td>
                    <td className="num" style={{ color: 'var(--teal)' }}>{l.credit ? money2(l.credit) : ''}</td>
                    <td className="num" style={{ fontWeight: 600 }}>{money2(l.balance)}</td>
                  </tr>
                ))}
                {!data.lines.length && <tr><td colSpan="5" className="small-muted">No invoice has been raised to this client.</td></tr>}
              </tbody>
              {data.lines.length > 0 && (
                <tfoot>
                  <tr>
                    <td colSpan="2"><b>Closing balance</b></td>
                    <td className="num"><b>{money2(t.billed)}</b></td>
                    <td className="num"><b>{money2(t.received)}</b></td>
                    <td className="num"><b>{money2(t.pending)}</b></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          <h4 style={{ fontSize: 12, color: 'var(--ink-soft)', margin: '16px 0 8px' }}>INVOICES</h4>
          <div className="tbl-wrap" style={{ maxHeight: '30vh' }}>
            <table>
              <thead>
                <tr>
                  <th>Invoice No</th><th>Invoice Date</th><th>Due Date</th><th className="num">Receivable</th>
                  <th className="num">Received</th><th className="num">Pending</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.invoices.map((i) => (
                  <tr key={i.id}>
                    <td><Link className="inv-mono" to={`/invoices/${i.id}`} onClick={onClose}>{i.invoiceNumber}</Link></td>
                    <td>{fmtD(i.invoiceDate)}</td>
                    <td>{fmtD(i.dueDate)}</td>
                    <td className="num">{money2(i.receivable)}</td>
                    <td className="num">{money2(i.received)}</td>
                    <td className="num" style={{ fontWeight: 600 }}>{money2(i.pending)}</td>
                    <td><span className={`status ${i.status === 'Paid' ? 'priority-low' : i.status === 'Overdue' ? 'priority-high' : i.status === 'Partially Paid' ? 'priority-medium' : ''}`}>{STATUS_WORD[i.status] || i.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
