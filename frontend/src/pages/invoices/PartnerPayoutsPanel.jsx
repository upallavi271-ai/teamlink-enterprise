// B7 — Invoices → "Partner payouts" tab. One row per joining an agency /
// freelancer sent: fee + GST − TDS = net, on hold until the guarantee ends,
// Draft → Approved (second person) → Paid; cancel / clawback; the partner's
// own invoice file; Excel; a per-partner statement.
// Backend: routes/partnerPayouts.js (GET /partner-payouts …).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { FacetSelect } from '../../components/ui/ListPageHeader.jsx';
import { saveBlob } from '../office/officeUtil';
import { money2, fmtD, todayIso } from './invFormat';
import './creditNotes.css';

const CHIP = { Draft: 'Draft', Approved: 'Issued', Paid: 'Issued', Cancelled: 'Cancelled' };
const errText = (e, f) => (e?.response ? e.response.data?.error || f : 'Cannot reach the server. Try again.');

export default function PartnerPayoutsPanel({ canExport }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [said, setSaid] = useState('');
  const [f, setF] = useState({ partnerId: '', status: '', client: '', month: '' });
  const [q, setQ] = useState('');
  const [card, setCard] = useState('');
  const [modal, setModal] = useState(null); // { kind: 'pay'|'cancel'|'edit'|'invoice'|'clawback'|'statement', row }
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    api.get('/partner-payouts', { params: { ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), q: q || undefined } })
      .then((res) => { setData(res.data); setError(''); })
      .catch((e) => setError(errText(e, 'The payouts could not be loaded.')));
  }, [f, q]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => { if (!said) return undefined; const t = setTimeout(() => setSaid(''), 6000); return () => clearTimeout(t); }, [said]);

  const rows = useMemo(() => {
    const all = data?.rows || [];
    const T = {
      drafts: (r) => r.status === 'Draft', hold: (r) => r.onHold, topay: (r) => r.status === 'Approved' && !r.onHold, paid: (r) => r.status === 'Paid',
    };
    return card && T[card] ? all.filter(T[card]) : all;
  }, [data, card]);

  const act = async (key, fn, ok) => {
    setBusy(key); setError('');
    try { const res = await fn(); setSaid(res?.data?.message || ok); load(); return true; } catch (e) { setError(errText(e, 'That did not work.')); return false; } finally { setBusy(''); }
  };
  const exportXlsx = async () => {
    try {
      const res = await api.post('/partner-payouts/export.xlsx', { ids: rows.map((r) => r.id), filters: [f.partnerId && 'Partner', f.status && `Status: ${f.status}`, f.client && `Client: ${f.client}`, f.month && `Month: ${f.month}`, q && `Search: ${q}`].filter(Boolean).join(' · ') }, { responseType: 'blob' });
      saveBlob(res, 'partner-payouts.xlsx');
      setSaid(`Downloaded ${rows.length} payout(s).`);
    } catch { setError('The Excel file could not be made. Please try again.'); }
  };

  if (!data) return error ? <div className="notice red"><span>{error}</span></div> : <div className="small-muted">Loading payouts…</div>;
  const t = data.totals;
  const acc = data.access || {};
  const missing = data.missing || [];
  const cards = [
    { k: 'drafts', n: t.drafts, l: t.drafts ? 'Drafts waiting for approval' : 'No draft waiting', tone: t.drafts ? 'orange' : 'green' },
    { k: 'hold', n: t.onHold, l: t.onHold ? 'On hold (guarantee running)' : 'None on hold', tone: 'blue' },
    { k: 'topay', n: money2(t.toPay), l: 'Approved, to be paid', tone: t.toPay > 0.005 ? 'orange' : 'green' },
    { k: 'paid', n: money2(t.paid), l: 'Paid to partners', tone: 'green' },
  ];

  return (
    <div className="cn-page">
      {error && <div className="notice red" style={{ margin: 0 }}><span>{error} <button type="button" className="link-btn" onClick={() => setError('')}>Dismiss</button></span></div>}
      {said && <div className="notice" role="status" style={{ margin: 0 }}><span>{said}</span></div>}

      <div className="cn-cards">
        {cards.map((x) => (
          <button key={x.k} type="button" className={`cn-card ${x.tone}${card === x.k ? ' is-on' : ''}`} onClick={() => setCard(card === x.k ? '' : x.k)} title="Show these payouts in the table">
            <b>{x.n}</b><span>{x.l}</span>
          </button>
        ))}
      </div>

      {missing.length > 0 && (
        <section className="cn-wait" aria-label="Joined partner candidates without a payout">
          <h3>{missing.length} partner joining{missing.length === 1 ? '' : 's'} without a payout yet</h3>
          <div className="small-muted" style={{ marginBottom: 6 }}>A payout is drafted by itself when the client invoice exists. Raise the invoice first (Invoices tab → Joined, not invoiced), then press “Make payout”.</div>
          {missing.map((m) => (
            <div key={m.applicationId} className="cn-wait-row">
              <span><b>{m.candidateName}</b> · {m.clientName} · {m.requirementTitle} <span className="small-muted">· {m.partner} · joined {fmtD(m.joinedOn)}{m.hasInvoice ? '' : ' · no client invoice yet'}</span></span>
              {acc.canCreate && <button type="button" className="btn btn-sm btn-primary" disabled={!m.hasInvoice || busy === m.applicationId} onClick={() => act(m.applicationId, () => api.post(`/partner-payouts/create-for/${m.applicationId}`), 'Drafted.')}>{m.hasInvoice ? 'Make payout' : 'Needs the invoice'}</button>}
            </div>
          ))}
        </section>
      )}

      <div className="cn-bar">
        <FacetSelect label="Partner" value={f.partnerId} allLabel="All partners" options={data.facets.partnerId} onChange={(v) => setF({ ...f, partnerId: v })} />
        <FacetSelect label="Status" value={f.status} allLabel="Any status" options={data.facets.status} onChange={(v) => setF({ ...f, status: v })} />
        <FacetSelect label="Client" value={f.client} allLabel="All clients" options={data.facets.client} onChange={(v) => setF({ ...f, client: v })} />
        <FacetSelect label="Month joined" value={f.month} allLabel="Any month" options={data.facets.month} onChange={(v) => setF({ ...f, month: v })} />
        <input type="search" value={q} placeholder="Search payout no, candidate, partner, client, reference…" onChange={(e) => setQ(e.target.value)} />
        {(f.partnerId || f.status || f.client || f.month || q || card) && <button type="button" className="btn btn-sm" onClick={() => { setF({ partnerId: '', status: '', client: '', month: '' }); setQ(''); setCard(''); }}>Clear</button>}
        <span className="grow" />
        {f.partnerId && <button type="button" className="btn btn-sm" onClick={() => setModal({ kind: 'statement', partnerId: f.partnerId, name: (data.facets.partnerId.find((o) => o.value === f.partnerId) || {}).label })}>Partner statement</button>}
        {canExport && <button type="button" className="btn btn-sm" disabled={!rows.length} onClick={exportXlsx}>Excel</button>}
      </div>

      <div className="tbl-wrap">
        <table className="cn-table">
          <thead>
            <tr><th>Payout</th><th>Partner</th><th>Candidate · job · client</th><th>Joined</th><th>Client invoice</th><th className="n">Fee</th><th className="n">GST</th><th className="n">TDS</th><th className="n">Net</th><th>Status</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {!rows.length && <tr><td colSpan={11} className="small-muted">No payout matches. {data.rows.length ? 'Try removing a filter.' : 'A payout appears here when a partner-sent candidate joins and the client invoice is raised.'}</td></tr>}
            {rows.map((r) => (
              <tr key={r.id}>
                <td><b>{r.number}</b>{r.kind === 'CLAWBACK' && <div className="cn-tag">Clawback (recovery)</div>}{r.partnerInvoice && <div className="small-muted"><button type="button" className="link-btn" onClick={() => api.get(`/partner-payouts/${r.id}/partner-invoice/file`, { responseType: 'blob' }).then((res) => saveBlob(res, r.partnerInvoice.name)).catch(() => setError('Could not download.'))}>Partner invoice {r.partnerInvoice.number || ''}</button></div>}</td>
                <td>{r.partner}<div className="small-muted">{r.partnerType}</div></td>
                <td><b>{r.candidateName}</b><div className="small-muted">{r.requirementTitle} · {r.clientName}</div></td>
                <td>{fmtD(r.joinedOn)}</td>
                <td>{r.invoiceId ? <Link to={`/invoices/${r.invoiceId}`}>{r.invoiceNumber || 'Invoice'}</Link> : '—'}{r.expenseCode && <div className="small-muted">Booked {r.expenseCode}</div>}</td>
                <td className="n">{money2(r.fee)}<div className="small-muted">{r.feeType === 'FIXED' ? 'fixed' : `${r.feePercent}% of ${r.ctc ? money2(r.ctc) : 'CTC'}`}</div></td>
                <td className="n">{r.gst ? money2(r.gst) : '—'}</td>
                <td className="n">{r.tds ? <>{money2(r.tds)}<div className="small-muted">{r.tdsSection} {r.tdsPercent}%</div></> : '—'}</td>
                <td className="n"><b>{money2(r.net)}</b></td>
                <td><span className={`cn-chip ${CHIP[r.status] || 'Draft'}`}>{r.status}</span><div className="small-muted">{r.onHold ? `On hold until ${fmtD(r.holdUntil)}` : r.status === 'Paid' ? `${fmtD(r.paidOn)} · ${r.paidMode} · ${r.paidRef}` : r.status === 'Approved' ? `by ${r.approvedByName}` : r.status === 'Cancelled' ? r.cancelReason : (r.preparedByName ? `prepared by ${r.preparedByName}` : 'drafted by TeamLink')}</div></td>
                <td>
                  <div className="cn-acts">
                    {r.status === 'Draft' && acc.canEdit && <button type="button" className="btn btn-sm" onClick={() => setModal({ kind: 'edit', row: r })}>Edit</button>}
                    {r.status === 'Draft' && acc.canApprove && <button type="button" className="btn btn-sm btn-primary" disabled={busy === r.id} onClick={() => act(r.id, () => api.post(`/partner-payouts/${r.id}/approve`), 'Approved.')}>Approve</button>}
                    {r.status === 'Approved' && acc.canApprove && <button type="button" className="btn btn-sm btn-primary" onClick={() => setModal({ kind: 'pay', row: r })}>{r.kind === 'CLAWBACK' ? 'Mark recovered' : 'Mark paid'}</button>}
                    {['Draft', 'Approved'].includes(r.status) && acc.canApprove && <button type="button" className="btn btn-sm btn-danger" onClick={() => setModal({ kind: 'cancel', row: r })}>Cancel</button>}
                    {r.status === 'Paid' && r.kind === 'PAYOUT' && acc.canApprove && <button type="button" className="btn btn-sm" onClick={() => setModal({ kind: 'clawback', row: r })}>Clawback</button>}
                    {['Draft', 'Approved'].includes(r.status) && acc.canEdit && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setModal({ kind: 'invoice', row: r })}>{r.partnerInvoice ? 'Replace invoice' : 'Attach partner invoice'}</button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          {rows.length > 0 && (
            <tfoot><tr><td colSpan={5}><b>Total · {rows.length} payout(s)</b></td><td className="n"><b>{money2(rows.reduce((a, r) => a + (r.status !== 'Cancelled' ? r.fee : 0), 0))}</b></td><td className="n"><b>{money2(rows.reduce((a, r) => a + (r.status !== 'Cancelled' ? r.gst : 0), 0))}</b></td><td className="n"><b>{money2(rows.reduce((a, r) => a + (r.status !== 'Cancelled' ? r.tds : 0), 0))}</b></td><td className="n"><b>{money2(rows.reduce((a, r) => a + (r.status !== 'Cancelled' ? r.net : 0), 0))}</b></td><td colSpan={2} className="small-muted">cancelled rows not counted</td></tr></tfoot>
          )}
        </table>
      </div>
      <div className="small-muted" style={{ fontSize: 12 }}>{data.rule}</div>

      {modal?.kind === 'pay' && <PayModal row={modal.row} modes={data.payModes} isAdmin={acc.isAdmin} onClose={() => setModal(null)} onDone={(m) => { setModal(null); setSaid(m); load(); }} />}
      {modal?.kind === 'cancel' && <ReasonModal title={`Cancel ${modal.row.number}`} label="Why is it cancelled? (the partner sees this)" button="Cancel the payout" url={`/partner-payouts/${modal.row.id}/cancel`} onClose={() => setModal(null)} onDone={(m) => { setModal(null); setSaid(m); load(); }} />}
      {modal?.kind === 'clawback' && <ReasonModal title={`Clawback on ${modal.row.number}`} label="Why is the money being recovered? (left inside the guarantee…)" button="Draft the clawback" url={`/partner-payouts/${modal.row.id}/clawback`} onClose={() => setModal(null)} onDone={(m) => { setModal(null); setSaid(m); load(); }} />}
      {modal?.kind === 'edit' && <EditModal row={modal.row} isAdmin={acc.isAdmin} onClose={() => setModal(null)} onDone={(m) => { setModal(null); setSaid(m); load(); }} />}
      {modal?.kind === 'invoice' && <InvoiceModal row={modal.row} onClose={() => setModal(null)} onDone={(m) => { setModal(null); setSaid(m); load(); }} />}
      {modal?.kind === 'statement' && <StatementModal partnerId={modal.partnerId} name={modal.name} canExport={canExport} onClose={() => setModal(null)} />}
    </div>
  );
}

function PayModal({ row, modes, isAdmin, onClose, onDone }) {
  const [v, setV] = useState({ paidOn: todayIso(), paidRef: '', paidMode: 'Bank Transfer', bankTxnId: '', overrideHold: false, overrideReason: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true); setError('');
    try { const r = await api.post(`/partner-payouts/${row.id}/pay`, v); onDone(r.data.message); } catch (e) { setError(errText(e, 'Could not mark it paid.')); } finally { setBusy(false); }
  }
  return (
    <Modal title={`${row.kind === 'CLAWBACK' ? 'Mark recovered' : 'Mark paid'} · ${row.number}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Back</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : (row.kind === 'CLAWBACK' ? 'Mark recovered' : 'Mark paid')}</button></>}>
      <div className="cn-form">
        <div className="cn-inv">{row.partner} · {row.candidateName} · <b>{money2(row.net)}</b>{row.onHold ? <div style={{ color: 'var(--amber)' }}>On hold until {fmtD(row.holdUntil)} (guarantee).</div> : null}</div>
        <div className="cn-grid">
          <label>Paid on<input type="date" value={v.paidOn} max={todayIso()} onChange={(e) => setV({ ...v, paidOn: e.target.value })} /></label>
          <label>Mode<select value={v.paidMode} onChange={(e) => setV({ ...v, paidMode: e.target.value })}>{(modes || []).map((m) => <option key={m}>{m}</option>)}</select></label>
          <label>Reference (UTR / cheque no.)<input value={v.paidRef} onChange={(e) => setV({ ...v, paidRef: e.target.value })} /></label>
          <label className="cn-span">Bank line id (optional — or match it later on the Bank page against the booked expense)<input value={v.bankTxnId} onChange={(e) => setV({ ...v, bankTxnId: e.target.value })} /></label>
        </div>
        {row.onHold && isAdmin && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontWeight: 400 }}>
            <input type="checkbox" style={{ width: 'auto', marginTop: 3 }} checked={v.overrideHold} onChange={(e) => setV({ ...v, overrideHold: e.target.checked })} />
            <span>Pay now, before the guarantee ends (Admin override — recorded with the reason).{v.overrideHold && <input placeholder="Why now?" value={v.overrideReason} onChange={(e) => setV({ ...v, overrideReason: e.target.value })} style={{ marginTop: 6 }} />}</span>
          </label>
        )}
        {error && <div className="error-text">{error}</div>}
      </div>
    </Modal>
  );
}

function ReasonModal({ title, label, button, url, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true); setError('');
    try { const r = await api.post(url, { reason }); onDone(r.data.message); } catch (e) { setError(errText(e, 'That did not work.')); } finally { setBusy(false); }
  }
  return (
    <Modal title={title} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Back</button><button type="button" className="btn btn-primary" disabled={busy || reason.trim().length < 3} onClick={save}>{busy ? 'Saving…' : button}</button></>}>
      <label>{label}<textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

function EditModal({ row, isAdmin, onClose, onDone }) {
  const [v, setV] = useState({ fee: Math.abs(row.fee), notes: row.notes || '', holdUntil: row.holdUntil || '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true); setError('');
    try { const r = await api.patch(`/partner-payouts/${row.id}`, { fee: v.fee, notes: v.notes, ...(isAdmin ? { holdUntil: v.holdUntil } : {}) }); onDone(r.data.message); } catch (e) { setError(errText(e, 'Could not save.')); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Edit draft · ${row.number}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Back</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <div className="cn-form">
        <div className="cn-inv">{row.partner} · {row.candidateName} · CTC {row.ctc ? money2(row.ctc) : '—'} · terms: {row.feeType === 'FIXED' ? 'fixed fee' : `${row.feePercent}% of CTC`}, GST {row.gstPercent}%, TDS {row.tdsSection || 'none'} {row.tdsPercent}%</div>
        <div className="cn-grid">
          <label>Fee before GST (₹)<input type="number" min="0" value={v.fee} onChange={(e) => setV({ ...v, fee: e.target.value })} /></label>
          {isAdmin && <label>On hold until (guarantee end)<input type="date" value={v.holdUntil} onChange={(e) => setV({ ...v, holdUntil: e.target.value })} /></label>}
          <label className="cn-span">Notes<textarea rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></label>
        </div>
        <div className="small-muted">GST and TDS are recomputed from the fee. Editing makes you the maker — a different approver must then approve.</div>
        {error && <div className="error-text">{error}</div>}
      </div>
    </Modal>
  );
}

function InvoiceModal({ row, onClose, onDone }) {
  const [v, setV] = useState({ invoiceNumber: row.partnerInvoice?.number || '', invoiceDate: row.partnerInvoice?.date || '' });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    if (!file) { setError('Choose the file (PDF or photo).'); return; }
    setBusy(true); setError('');
    const fd = new FormData();
    fd.append('invoiceNumber', v.invoiceNumber); fd.append('invoiceDate', v.invoiceDate); fd.append('file', file);
    try { const r = await api.post(`/partner-payouts/${row.id}/partner-invoice`, fd); onDone(r.data.message); } catch (e) { setError(errText(e, 'Could not upload.')); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Partner invoice · ${row.number}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Back</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Uploading…' : 'Attach'}</button></>}>
      <div className="cn-form">
        <div className="cn-grid">
          <label>Their invoice number<input value={v.invoiceNumber} onChange={(e) => setV({ ...v, invoiceNumber: e.target.value })} /></label>
          <label>Invoice date<input type="date" value={v.invoiceDate} onChange={(e) => setV({ ...v, invoiceDate: e.target.value })} /></label>
          <label className="cn-span">File<input type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] || null)} /></label>
        </div>
        {error && <div className="error-text">{error}</div>}
      </div>
    </Modal>
  );
}

function StatementModal({ partnerId, name, canExport, onClose }) {
  const [s, setS] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get(`/partner-payouts/statement/${partnerId}`).then((r) => setS(r.data)).catch((e) => setError(errText(e, 'Could not load the statement.'))); }, [partnerId]);
  const dl = () => api.post(`/partner-payouts/statement/${partnerId}/export.xlsx`, {}, { responseType: 'blob' }).then((res) => saveBlob(res, 'partner-statement.xlsx')).catch(() => setError('Could not make the Excel file.'));
  return (
    <Modal title={`Statement · ${name || ''}`} size="wide" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Close</button>{canExport && <button type="button" className="btn btn-primary" onClick={dl}>Excel</button>}</>}>
      {error && <div className="error-text">{error}</div>}
      {!s ? <div className="small-muted">Loading…</div> : (
        <>
          <div className="cn-inv">{s.partner.name} ({s.partner.code}) · {s.partner.type} · PAN {s.partner.pan || '—'} · GSTIN {s.partner.gstin || '—'} · TDS {s.partner.tdsSection || 'none'} {s.partner.tdsPercent}% · pay within {s.partner.paymentTermsDays} days</div>
          <table className="cn-calc" style={{ marginTop: 10 }}>
            <thead><tr><td>Payout</td><td>Candidate · joined</td><td>Status</td><td>Net</td></tr></thead>
            <tbody>
              {s.rows.map((r) => <tr key={r.id}><td>{r.number}{r.kind === 'CLAWBACK' ? ' (clawback)' : ''}</td><td>{r.candidateName} · {fmtD(r.joinedOn)}</td><td>{r.status}{r.paidOn ? ` · ${fmtD(r.paidOn)} ${r.paidRef}` : r.onHold ? ` · hold ${fmtD(r.holdUntil)}` : ''}</td><td>{money2(r.net)}</td></tr>)}
              <tr className="tot"><td colSpan={3}>To be paid (approved) · paid so far</td><td>{money2(s.totals.toPay)} · {money2(s.totals.paid)}</td></tr>
            </tbody>
          </table>
        </>
      )}
    </Modal>
  );
}
