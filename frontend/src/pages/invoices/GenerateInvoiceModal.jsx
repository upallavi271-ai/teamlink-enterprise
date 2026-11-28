// "Generate invoices" (founder 2026-11-28): pick a client and a month, and the candidates who joined that month come in by
// themselves. Each line can be changed before anything is made - take it out, change the CTC or the amount before GST, switch
// GST and TDS on or off. Beside it: what of that month is already invoiced for the client, and whether it was sent.
// Each ticked line is raised through the same joining -> invoice path as "+ New join"
// (POST /invoices/joinings/:applicationId/raise); an amount typed over the fee is then saved with the invoice edit
// (PATCH /invoices/:id), so the server recalculates every figure.
import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import Combo from '../../components/Combo.jsx';
import { money2, fmtD } from './invFormat';

const monthOf = (d) => String(d || '').slice(0, 7);

export default function GenerateInvoiceModal({ rows = [], onClose, onDone }) {
  const [joins, setJoins] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [clientId, setClientId] = useState('');
  const [month, setMonth] = useState('');
  const [edit, setEdit] = useState({}); // applicationId -> changes typed by the person
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState([]);

  const load = () => api.get('/invoices/joinings')
    .then((r) => setJoins(r.data.rows || []))
    .catch((e) => setLoadErr(e.response?.data?.error || 'The joinings could not be loaded.'));
  useEffect(() => { load(); }, []);

  const clients = useMemo(() => {
    const m = new Map();
    (joins || []).forEach((r) => { if (r.clientId) m.set(r.clientId, { name: r.client, waiting: (m.get(r.clientId)?.waiting || 0) + 1 }); });
    rows.forEach((r) => { if (r.clientId && !m.has(r.clientId)) m.set(r.clientId, { name: r.client, waiting: 0 }); });
    return [...m.entries()].sort((a, b) => b[1].waiting - a[1].waiting || String(a[1].name).localeCompare(String(b[1].name)));
  }, [joins, rows]);

  const months = useMemo(() => {
    const s = new Set();
    (joins || []).filter((r) => r.clientId === clientId).forEach((r) => { if (r.joiningDate) s.add(monthOf(r.joiningDate)); });
    rows.filter((r) => r.clientId === clientId).forEach((r) => { if (r.joiningDate) s.add(monthOf(r.joiningDate)); });
    return [...s].sort().reverse();
  }, [joins, rows, clientId]);
  useEffect(() => {
    if (!clientId) { setMonth(''); return; }
    const waiting = (joins || []).filter((r) => r.clientId === clientId && r.joiningDate).map((r) => monthOf(r.joiningDate)).sort();
    setMonth(waiting.pop() || months[0] || '');
    setReport([]);
  }, [clientId]); // eslint-disable-line react-hooks/exhaustive-deps

  const waiting = (joins || []).filter((r) => r.clientId === clientId && monthOf(r.joiningDate) === month);
  const raised = rows.filter((r) => r.clientId === clientId && monthOf(r.joiningDate) === month && r.status !== 'Cancelled');

  const lineOf = (r) => {
    const e = edit[r.applicationId] || {};
    const ctc = e.ctc !== undefined ? e.ctc : (r.offeredCtc != null ? String(r.offeredCtc) : '');
    const fee = Number(r.feePercent);
    const fromCtc = Number(ctc) > 0 && fee > 0 ? Math.round((Number(ctc) * fee) / 100) : (r.billing != null ? r.billing : null);
    const amount = e.amount !== undefined ? e.amount : (fromCtc != null ? String(fromCtc) : '');
    const gst = e.gst !== undefined ? e.gst : Number(r.taxDefaults?.gstPercent ?? r.gstPercent) > 0;
    const tds = e.tds !== undefined ? e.tds : Number(r.taxDefaults?.tdsPercent ?? r.tdsPercent) > 0;
    const on = e.on !== undefined ? e.on : !r.leftAfterJoining && r.joiningStatus !== 'Dropped';
    const gstPct = Number(r.taxDefaults?.gstPercent ?? r.gstPercent) || 18;
    const tdsPct = Number(r.taxDefaults?.tdsPercent ?? r.tdsPercent) || 10;
    const a = Number(amount) || 0;
    const gstAmt = gst ? Math.round(a * gstPct) / 100 : 0;
    const tdsAmt = tds ? Math.round(a * tdsPct) / 100 : 0;
    return { ctc, amount, gst, tds, on, gstPct, tdsPct, gstAmt, tdsAmt, receive: a + gstAmt - tdsAmt };
  };
  const set = (id, patch) => setEdit((s) => ({ ...s, [id]: { ...(s[id] || {}), ...patch } }));
  const picked = waiting.filter((r) => lineOf(r).on);
  const total = picked.reduce((s, r) => { const l = lineOf(r); return s + (Number(l.amount) || 0) + l.gstAmt; }, 0);
  const sentCount = raised.filter((r) => r.sentDate || r.sentVia).length;

  const generate = async () => {
    const bad = picked.find((r) => { const l = lineOf(r); return !(Number(l.ctc) > 0) || !(Number(l.amount) > 0); });
    if (bad) { window.alert(`${bad.name}: enter the annual CTC and the amount before GST.`); return; }
    if (!window.confirm(`Generate ${picked.length} invoice(s), ${money2(total)} including GST?`)) return;
    setBusy(true);
    const out = [];
    for (const r of picked) {
      const l = lineOf(r);
      try {
        const res = await api.post(`/invoices/joinings/${r.applicationId}/raise`, {
          offeredCtc: Number(l.ctc), joiningDate: r.joiningDate, gstApplicable: l.gst, tdsApplicable: l.tds,
        });
        if (Math.abs(Number(res.data.amount) - Number(l.amount)) > 0.5) {
          await api.patch(`/invoices/${res.data.id}`, { amount: Number(l.amount), gstApplicable: l.gst, tdsApplicable: l.tds });
        }
        out.push({ ok: true, text: `${r.name}: ${res.data.invoiceNumber} generated.` });
      } catch (e) { out.push({ ok: false, text: `${r.name}: ${e.response?.data?.error || 'could not be generated.'}` }); }
    }
    setReport(out);
    setEdit({});
    await load();
    setBusy(false);
    onDone();
  };

  return (
    <Modal
      title="Generate invoices"
      size="xwide"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Close</button>
          <button type="button" className="btn btn-gold" disabled={busy || !picked.length} onClick={generate}>{busy ? 'Generating…' : `Generate ${picked.length || ''} invoice${picked.length === 1 ? '' : 's'}`}</button>
        </>
      )}
    >
      {loadErr && <div className="notice red"><span>{loadErr}</span></div>}
      {!joins && !loadErr && <div className="small-muted">Loading the joinings…</div>}
      {joins && (
        <>
          <div className="inv-pickrow">
            <label className="field" style={{ flex: 2 }}>
              <span>Client</span>
              <Combo value={clientId} onChange={(e) => setClientId(e.target.value)}>
                <option value="">Choose a client…</option>
                {clients.map(([id, c]) => <option key={id} value={id}>{`${c.name}${c.waiting ? ` · ${c.waiting} waiting for an invoice` : ''}`}</option>)}
              </Combo>
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>Period (joining month)</span>
              <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} disabled={!clientId} />
            </label>
          </div>
          {report.length > 0 && (
            <div className="notice green" style={{ marginBottom: 10 }}>
              <span>{report.map((x) => <div key={x.text} style={x.ok ? undefined : { color: 'var(--red)' }}>{x.text}</div>)}</span>
            </div>
          )}
          {clientId && month && (
            <>
              <div className="notice" style={{ marginBottom: 10 }}>
                <span>
                  This month: <b>{raised.length}</b> already invoiced (<b>{sentCount}</b> sent, <b>{raised.length - sentCount}</b> not sent)
                  {' '}· <b>{waiting.length}</b> joined and not invoiced yet.
                </span>
              </div>
              <h4 style={{ fontSize: 12, color: 'var(--ink-soft)', margin: '0 0 8px' }}>TO BE INVOICED</h4>
              {!waiting.length ? <p className="small-muted">Nobody of this client who joined in this month is waiting for an invoice.</p> : (
                <div className="tbl-wrap">
                  <table>
                    <thead>
                      <tr><th>Include</th><th>Candidate</th><th>Joined</th><th>Annual CTC (₹)</th><th>Fee</th><th>Amount before GST (₹)</th><th>GST applicable</th><th>TDS applicable</th><th className="num">To receive</th></tr>
                    </thead>
                    <tbody>
                      {waiting.map((r) => {
                        const l = lineOf(r);
                        return (
                          <tr key={r.applicationId} style={l.on ? undefined : { opacity: 0.55 }}>
                            <td><input type="checkbox" aria-label={`Include ${r.name}`} checked={l.on} onChange={(e) => set(r.applicationId, { on: e.target.checked })} /></td>
                            <td><b>{r.name}</b>{(r.leftAfterJoining || r.joiningStatus === 'Dropped') && <div><span className="status priority-high">Dropped in the ATS</span></div>}</td>
                            <td style={{ whiteSpace: 'nowrap' }}>{fmtD(r.joiningDate)}</td>
                            <td><input type="number" min="0" style={{ width: 120 }} value={l.ctc} onChange={(e) => set(r.applicationId, { ctc: e.target.value, amount: undefined })} /></td>
                            <td>{r.feePercent != null ? `${r.feePercent}%` : '—'}</td>
                            <td><input type="number" min="0" step="0.01" style={{ width: 120 }} value={l.amount} onChange={(e) => set(r.applicationId, { amount: e.target.value })} /></td>
                            <td><label><input type="checkbox" checked={l.gst} onChange={(e) => set(r.applicationId, { gst: e.target.checked })} /> {l.gst ? `${l.gstPct}% · ${money2(l.gstAmt)}` : 'No'}</label></td>
                            <td><label><input type="checkbox" checked={l.tds} onChange={(e) => set(r.applicationId, { tds: e.target.checked })} /> {l.tds ? `${l.tdsPct}% · ${money2(l.tdsAmt)}` : 'No'}</label></td>
                            <td className="num">{money2(l.receive)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {raised.length > 0 && (
                <>
                  <h4 style={{ fontSize: 12, color: 'var(--ink-soft)', margin: '16px 0 8px' }}>ALREADY INVOICED THIS MONTH</h4>
                  <div className="tbl-wrap">
                    <table>
                      <thead><tr><th>Invoice</th><th>Candidate</th><th className="num">Amount</th><th>GST</th><th>TDS</th><th>Sent to client?</th></tr></thead>
                      <tbody>
                        {raised.map((r) => (
                          <tr key={r.id}>
                            <td className="inv-mono"><a href={`/invoices/${r.id}`} target="_blank" rel="noreferrer">{r.invoiceNumber || '—'}</a></td>
                            <td>{r.candidateName || '—'}</td>
                            <td className="num">{money2(r.invoiceValue)}</td>
                            <td>{r.gstApplicable ? `${r.gstPercent}%` : 'No'}</td>
                            <td>{r.tdsApplicable ? `${r.tdsPercent}%` : 'No'}</td>
                            <td>{r.sentDate || r.sentVia ? <span className="status priority-low">Sent{r.sentVia ? ` · ${r.sentVia}` : ''}{r.sentDate ? ` · ${fmtD(r.sentDate)}` : ''}</span> : <span className="status priority-high">Not sent</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}
    </Modal>
  );
}
