// B2 — Invoices → "Credit & debit notes" tab. Every note against a client
// invoice: drafts waiting for an approver, issued notes, refunds still owed,
// and the placements that left inside the guarantee with no note yet (each
// with "Raise credit note", pre-filled from its invoice).
// Backend: routes/creditNotes.js (GET /invoices/credit-notes …).
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { FacetSelect, useLocalFacets } from '../../components/ui/ListPageHeader.jsx';
import { saveBlob } from '../office/officeUtil';
import NoteModal, { openNotePdf } from './NoteModal.jsx';
import { money2, fmtD, todayIso } from './invFormat';
import './creditNotes.css';

const FIELDS = [
  { key: 'kind', get: (r) => r.kind, label: (v) => (v === 'debit' ? 'Debit notes' : 'Credit notes') },
  { key: 'status', get: (r) => r.status },
  { key: 'client', get: (r) => r.client },
];

export default function CreditNotesPanel({
  invoiceRows = [], raiseFor = '', onRaiseUsed, canCreate, canExport, onChanged,
}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [said, setSaid] = useState('');
  const [f, setF] = useState({ kind: '', status: '', client: '' });
  const [q, setQ] = useState('');
  const [card, setCard] = useState('');
  const [modal, setModal] = useState(raiseFor ? { kind: 'credit', applicationId: raiseFor } : null);
  const [cancelFor, setCancelFor] = useState(null);
  const [refundFor, setRefundFor] = useState(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    api.get('/invoices/credit-notes')
      .then((res) => setData(res.data))
      .catch((e) => setError(e.response?.data?.error || 'The notes could not be loaded.'));
  }, []);
  useEffect(load, [load]);
  // The ?raise= link opens the form once; a reload must not open it again.
  useEffect(() => { if (raiseFor) onRaiseUsed?.(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!said) return undefined; const t = setTimeout(() => setSaid(''), 6000); return () => clearTimeout(t); }, [said]);

  const all = data?.rows || [];
  const facets = useLocalFacets(all, FIELDS, f);
  const needle = q.trim().toLowerCase();
  const CARD_TEST = {
    drafts: (r) => r.status === 'Draft',
    credits: (r) => r.status === 'Issued' && r.kind === 'credit',
    debits: (r) => r.status === 'Issued' && r.kind === 'debit',
    refunds: (r) => r.refundOpen > 0.005,
  };
  const rows = all.filter((r) => (!f.kind || r.kind === f.kind) && (!f.status || r.status === f.status) && (!f.client || r.client === f.client)
    && (!card || !CARD_TEST[card] || CARD_TEST[card](r))
    && (!needle || [r.displayNumber, r.invoiceNumber, r.client, r.candidate, r.reasonLabel, r.reasonText].filter(Boolean).join(' ').toLowerCase().includes(needle)));

  const act = async (key, fn, ok) => {
    setBusy(key); setError('');
    try {
      const res = await fn();
      setSaid(res?.data?.said || ok);
      load(); onChanged?.();
      return true;
    } catch (e) {
      setError(e.response?.data?.error || 'That did not work.');
      return false;
    } finally { setBusy(''); }
  };
  const exportXlsx = async () => {
    try {
      const res = await api.post('/invoices/credit-notes/export.xlsx', {
        ids: rows.map((r) => r.id),
        filters: [f.kind && `Type: ${f.kind}`, f.status && `Status: ${f.status}`, f.client && `Client: ${f.client}`, needle && `Search: ${q.trim()}`].filter(Boolean).join(' · '),
      }, { responseType: 'blob' });
      saveBlob(res, 'credit-notes.xlsx');
      setSaid(`Downloaded ${rows.length} note(s).`);
    } catch { setError('The Excel file could not be made. Please try again.'); }
  };

  if (!data) return error ? <div className="notice red"><span>{error}</span></div> : <div className="small-muted">Loading notes…</div>;
  const c = data.counts;
  const t = data.totals;
  const me = data.me;
  const waiting = data.waiting || [];

  const cards = [
    { k: 'drafts', n: c.Draft, l: c.Draft ? 'Drafts waiting to be issued' : 'No drafts waiting', tone: c.Draft ? 'orange' : 'green', count: true },
    { k: 'credits', n: money2(t.creditNet), l: `Credit notes issued · ${all.filter(CARD_TEST.credits).length}`, tone: 'blue' },
    { k: 'debits', n: money2(t.debitNet), l: `Debit notes issued · ${all.filter(CARD_TEST.debits).length}`, tone: 'blue' },
    { k: 'refunds', n: money2(t.refundOpen), l: c.refundOpen ? `Refunds still to pay back · ${c.refundOpen}` : 'No refund owed to a client', tone: c.refundOpen ? 'red' : 'green' },
  ];

  return (
    <div className="cn-page">
      {error && <div className="notice red" style={{ margin: 0 }}><span>{error} <button type="button" className="link-btn" onClick={() => setError('')}>Dismiss</button></span></div>}
      {said && <div className="notice" role="status" style={{ margin: 0 }}><span>{said}</span></div>}

      <div className="cn-cards">
        {cards.map((x) => (
          <button key={x.k} type="button" className={`cn-card ${x.tone}${card === x.k ? ' is-on' : ''}`} onClick={() => setCard(card === x.k ? '' : x.k)} title="Show these notes in the table">
            <b>{x.n}</b>
            <span>{x.l}</span>
          </button>
        ))}
      </div>

      {canCreate && waiting.length > 0 && (
        <section className="cn-wait" aria-label="Left within the guarantee">
          <h3>{waiting.length} placement{waiting.length === 1 ? '' : 's'} left within the guarantee — no credit note yet</h3>
          <div className="small-muted" style={{ marginBottom: 6 }}>If the client gets no replacement, raise a credit note. It starts from the invoice&apos;s fee; change the amount if the client agreed less.</div>
          {waiting.map((w) => (
            <div key={w.applicationId} className="cn-wait-row">
              <span>
                <b>{w.candidate}</b> · {w.client} · {w.job}
                <span className="small-muted"> · invoice {w.invoiceNumber} · fee {money2(w.fee)}{w.left ? ` · ${w.left}` : ''}</span>
              </span>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setModal({ kind: 'credit', applicationId: w.applicationId })}>Raise credit note</button>
            </div>
          ))}
        </section>
      )}

      <div className="cn-bar">
        <FacetSelect label="Type" value={f.kind} allLabel="Credit & debit" options={facets.kind} onChange={(v) => setF({ ...f, kind: v })} />
        <FacetSelect label="Status" value={f.status} allLabel="Any status" options={facets.status} onChange={(v) => setF({ ...f, status: v })} />
        <FacetSelect label="Client" value={f.client} allLabel="All clients" options={facets.client} onChange={(v) => setF({ ...f, client: v })} />
        <input type="search" value={q} placeholder="Search note no, invoice no, client, candidate…" onChange={(e) => setQ(e.target.value)} />
        {(f.kind || f.status || f.client || q || card) && <button type="button" className="btn btn-sm" onClick={() => { setF({ kind: '', status: '', client: '' }); setQ(''); setCard(''); }}>Clear</button>}
        <span className="grow" />
        {canExport && <button type="button" className="btn btn-sm" disabled={!rows.length} onClick={exportXlsx}>Excel</button>}
        {canCreate && <button type="button" className="btn btn-sm" onClick={() => setModal({ kind: 'debit' })}>+ Debit note</button>}
        {canCreate && <button type="button" className="btn btn-primary" onClick={() => setModal({ kind: 'credit' })}>+ Credit note</button>}
      </div>

      <div className="tbl-wrap">
        <table className="cn-table">
          <thead>
            <tr>
              <th>Note no</th><th>Type</th><th>Status</th><th>Date</th><th>Invoice</th><th>Client</th><th>Reason</th>
              <th className="n">Before GST</th><th className="n">GST</th><th className="n">TDS</th><th className="n">Net</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const mine = r.createdById === me;
              return (
                <tr key={r.id}>
                  <td className="inv-mono">{r.displayNumber}</td>
                  <td>{r.kindLabel}</td>
                  <td>
                    <span className={`cn-chip ${r.status}`}>{r.status === 'Draft' ? 'Draft — to issue' : r.status}</span>
                    {r.refundOpen > 0.005 && <div><span className="cn-chip refund">Refund due {money2(r.refundOpen)}</span></div>}
                    {r.refundPaidOn && <div className="small-muted">Refund paid {fmtD(r.refundPaidOn)}</div>}
                  </td>
                  <td>{fmtD(r.noteDate)}</td>
                  <td><Link to={`/invoices/${r.invoiceId}`}>{r.invoiceNumber}</Link>{r.candidate ? <div className="small-muted">{r.candidate}</div> : null}</td>
                  <td>{r.client}</td>
                  <td>{r.reasonLabel}{r.reasonText ? <div className="small-muted" style={{ maxWidth: 260 }}>{r.reasonText}</div> : null}</td>
                  <td className="n">{money2(r.amount)}</td>
                  <td className="n">{money2(r.gst)}</td>
                  <td className="n">{money2(r.tds)}</td>
                  <td className="n"><b>{r.kind === 'debit' ? '+' : '−'} {money2(r.net)}</b></td>
                  <td>
                    <div className="cn-acts">
                      <button type="button" className="btn btn-sm" onClick={() => openNotePdf(r.id, setError)}>PDF</button>
                      {r.status === 'Draft' && data.canApprove && !mine && (
                        <button type="button" className="btn btn-sm btn-primary" disabled={busy === r.id} onClick={() => act(r.id, () => api.post(`/invoices/credit-notes/${r.id}/issue`), 'Issued.')}>Issue</button>
                      )}
                      {r.status === 'Draft' && mine && <span className="small-muted" title="Maker-checker">Another approver issues it</span>}
                      {r.status === 'Draft' && (mine || data.canApprove) && (
                        <>
                          <button type="button" className="btn btn-sm" onClick={() => setModal({ draft: r })}>Change</button>
                          <button type="button" className="btn btn-sm" disabled={busy === r.id} onClick={() => act(r.id, () => api.delete(`/invoices/credit-notes/${r.id}`), 'Draft removed.')}>Remove</button>
                        </>
                      )}
                      {r.refundOpen > 0.005 && <button type="button" className="btn btn-sm" onClick={() => setRefundFor(r)}>Refund paid</button>}
                      {r.status === 'Issued' && data.canApprove && !r.refundPaidOn && <button type="button" className="btn btn-sm" onClick={() => setCancelFor(r)}>Cancel note</button>}
                    </div>
                  </td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr><td colSpan="12" className="small-muted">{all.length ? 'No note matches these filters.' : 'No credit or debit note yet. Use “+ Credit note” when a client is owed money back on an invoice.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {modal && (
        <NoteModal
          kind={modal.kind}
          applicationId={modal.applicationId || ''}
          invoiceId={modal.invoiceId || ''}
          draft={modal.draft || null}
          rows={invoiceRows}
          onClose={() => setModal(null)}
          onSaved={(note, msg) => { setModal(null); setSaid(msg); load(); onChanged?.(); }}
        />
      )}
      {cancelFor && <CancelNote note={cancelFor} onClose={() => setCancelFor(null)} onDone={(msg) => { setCancelFor(null); setSaid(msg); load(); onChanged?.(); }} />}
      {refundFor && <RefundPaid note={refundFor} onClose={() => setRefundFor(null)} onDone={(msg) => { setRefundFor(null); setSaid(msg); load(); onChanged?.(); }} />}
    </div>
  );
}

export function CancelNote({ note, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [fail, setFail] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true); setFail('');
    try {
      const res = await api.post(`/invoices/credit-notes/${note.id}/cancel`, { reason: reason.trim() });
      onDone(res.data.said);
    } catch (e) { setFail(e.response?.data?.error || 'It could not be cancelled.'); setBusy(false); }
  };
  return (
    <Modal title={`Cancel ${note.displayNumber}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Keep it</button><button type="button" className="btn btn-primary" disabled={busy || !reason.trim()} onClick={go}>Cancel the note</button></>}>
      <div className="cn-form">
        <div className="small-muted">The invoice balance goes back to what it was before this note. The note stays on file as Cancelled.</div>
        <label className="field"><span>Why? *</span><input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Raised on the wrong invoice" /></label>
        {fail && <div className="notice red"><span>{fail}</span></div>}
      </div>
    </Modal>
  );
}

export function RefundPaid({ note, onClose, onDone }) {
  const [date, setDate] = useState(todayIso());
  const [ref, setRef] = useState('');
  const [fail, setFail] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true); setFail('');
    try {
      const res = await api.post(`/invoices/credit-notes/${note.id}/refund-paid`, { date, reference: ref.trim() });
      onDone(res.data.said);
    } catch (e) { setFail(e.response?.data?.error || 'It could not be saved.'); setBusy(false); }
  };
  return (
    <Modal title={`Refund paid — ${note.displayNumber}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={go}>Save — refund paid</button></>}>
      <div className="cn-form">
        <div>{money2(note.refundOpen)} paid back to {note.client}.</div>
        <div className="cn-grid">
          <label className="field"><span>Paid on</span><input type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} /></label>
          <label className="field cn-span"><span>Reference (UTR / cheque)</span><input value={ref} maxLength={120} onChange={(e) => setRef(e.target.value)} /></label>
        </div>
        {fail && <div className="notice red"><span>{fail}</span></div>}
      </div>
    </Modal>
  );
}

