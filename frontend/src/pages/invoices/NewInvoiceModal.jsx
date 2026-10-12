// "+ New invoice" - a manual invoice for a client from the central client list.
// The client picker loads the REAL clients (GET /invoice-clients); picking one
// fills the saved details. "+ Add client" sits beside it. The money is the same
// as every other invoice: amount before GST, GST and TDS from TaxFields
// (invTax.js) - the server recalculates and refuses a mismatch (POST /invoices).
import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import Combo from '../../components/Combo.jsx';
import { todayIso } from './invFormat';
import TaxFields, { taxFormFrom, taxPayload, taxFormErrors } from './TaxFields.jsx';
import AddClientModal from './AddClientModal.jsx';
import './addClient.css';

export default function NewInvoiceModal({ onClose, onSaved }) {
  const [clients, setClients] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [clientId, setClientId] = useState('');
  const [date, setDate] = useState(todayIso());
  const [base, setBase] = useState('');
  const [notes, setNotes] = useState('');
  const [tax, setTax] = useState(() => taxFormFrom({}));
  const [errs, setErrs] = useState({});
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState('');
  const [adding, setAdding] = useState(false);
  const [flash, setFlash] = useState('');

  const load = () => api.get('/invoice-clients')
    .then((r) => { setClients(r.data.rows); return r.data.rows; })
    .catch((e) => { setLoadErr(e.response?.data?.error || 'The clients could not be loaded.'); return []; });
  useEffect(() => { load(); }, []);
  const client = useMemo(() => (clients || []).find((c) => c.id === clientId) || null, [clients, clientId]);
  useEffect(() => { if (client) setTax(taxFormFrom({ gstPercent: client.gstPercent, tdsPercent: client.tdsPercent })); }, [client]);
  const amount = Number(base);

  async function raise() {
    const e = {};
    if (!client) e.client = 'Choose the client.';
    if (!(amount > 0)) e.base = 'Enter the amount before GST, like 50000.';
    if (!date) e.date = 'Pick the invoice date.';
    Object.assign(e, taxFormErrors(tax));
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true); setFail('');
    try {
      const res = await api.post('/invoices', {
        clientId: client.id, invoiceDate: date, notes: notes.trim() || undefined, paymentTerms: client.paymentTerms || undefined, ...taxPayload(tax, amount),
      });
      onSaved(res.data.id, `Raised ${res.data.invoiceNumber} for ${client.name}.`);
    } catch (err) {
      setFail(err.response?.data?.error || 'The invoice could not be raised.');
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New invoice"
      size="wide"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-gold" disabled={busy || !client} onClick={raise}>{busy ? 'Raising…' : 'Raise invoice'}</button>
        </>
      )}
    >
      {loadErr && <div className="notice red"><span>{loadErr}</span></div>}
      {flash && <div className="notice green" style={{ marginBottom: 8 }}><span>{flash}</span></div>}
      {!clients && !loadErr && <div className="small-muted">Loading the clients…</div>}
      {clients && (
        <>
          <div className="inv-pickrow">
            <label className="field" style={{ flex: 1 }}>
              <span>{`Client · ${clients.length} in your list`}</span>
              <Combo value={clientId} onChange={(e) => setClientId(e.target.value)}>
                <option value="">Choose a client…</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{`${c.name}${c.clientCode ? ` · ${c.clientCode}` : ''}${c.isDraft ? ' · draft' : ''}`}</option>)}
              </Combo>
              {errs.client && <div className="inv-err">{errs.client}</div>}
            </label>
            <button type="button" className="btn" onClick={() => setAdding(true)}>+ Add client</button>
          </div>
          {client && (
            <div className="inv-callout">
              <b>{client.company}</b>{client.clientCode ? ` · ${client.clientCode}` : ''}
              <div className="small-muted">
                {[client.contactName, client.email, client.phone].filter(Boolean).join(' · ') || 'No contact saved'}
                {client.billingAddress ? <><br />{client.billingAddress}</> : null}
                <br />
                {client.gstin ? `GSTIN ${client.gstin}` : <span style={{ color: '#B3261E' }}>GSTIN not saved yet</span>}
              </div>
            </div>
          )}
          <div className="inv-form">
            <label className="field">
              <span>Invoice date</span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              {errs.date && <div className="inv-err">{errs.date}</div>}
            </label>
            <label className="field">
              <span>Amount before GST (₹)</span>
              <input type="number" min="0" step="0.01" inputMode="decimal" value={base} onChange={(e) => setBase(e.target.value)} />
              {errs.base && <div className="inv-err">{errs.base}</div>}
            </label>
            <label className="field" style={{ gridColumn: '1 / -1' }}>
              <span>Note (optional)</span>
              <input value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} />
            </label>
          </div>
          {amount > 0 && client && <TaxFields value={tax} onChange={setTax} base={amount} errs={errs} details={false} />}
          {fail && <div className="notice red"><span>{fail}</span></div>}
        </>
      )}
      {adding && (
        <AddClientModal
          onClose={() => setAdding(false)}
          onSaved={(c, msg) => { setAdding(false); setFlash(msg); load().then(() => setClientId(c.id)); }}
        />
      )}
    </Modal>
  );
}
