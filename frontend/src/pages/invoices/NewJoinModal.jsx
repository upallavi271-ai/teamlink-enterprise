// "+ New join" — raise the invoice for a candidate the ATS shows as JOINED.
// It lists the joinings still waiting for an invoice (GET /invoices/joinings)
// and raises through the ATS's own joining -> invoice path
// (POST /invoices/joinings/:applicationId/raise -> utils/joining.js
// raiseJoiningInvoice), which then takes the next number in the series.
// A joining itself is recorded in the ATS (Interviews & Joining), not here.
import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import Combo from '../../components/Combo.jsx';
import { money, fmtD, todayIso } from './invFormat';

const ROUND = (n) => Math.round((Number(n) || 0) * 100) / 100;

export default function NewJoinModal({ initialId, onClose, onSaved }) {
  const [list, setList] = useState(null);
  const [next, setNext] = useState('');
  const [loadErr, setLoadErr] = useState('');
  const [id, setId] = useState(initialId || '');
  const [ctc, setCtc] = useState('');
  const [fee, setFee] = useState('');
  const [joined, setJoined] = useState('');
  const [errs, setErrs] = useState({});
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState('');

  useEffect(() => {
    api.get('/invoices/joinings')
      .then((r) => { setList(r.data.rows); setNext(r.data.nextNumber); })
      .catch((e) => setLoadErr(e.response?.data?.error || 'The joinings could not be loaded.'));
  }, []);

  const row = useMemo(() => (list || []).find((r) => r.applicationId === id) || null, [list, id]);
  useEffect(() => {
    if (!row) return;
    setCtc(row.offeredCtc != null ? String(row.offeredCtc) : '');
    setFee(row.feePercent != null ? String(row.feePercent) : '');
    setJoined(row.joiningDate && /^\d{4}-\d{2}-\d{2}$/.test(row.joiningDate) ? row.joiningDate : todayIso());
    setErrs({}); setFail('');
  }, [row]);

  const c = Number(ctc);
  const p = Number(fee);
  const billing = c > 0 && p > 0 ? Math.round((c * p) / 100) : null;
  const gst = billing != null && row ? Math.round(billing * (Number(row.gstPercent || 0) / 100)) : null;
  const tds = billing != null && row ? Math.round(billing * (Number(row.tdsPercent || 0) / 100)) : null;

  const raise = async () => {
    const e = {};
    if (!row) e.row = 'Choose the candidate who joined.';
    if (!(c > 0)) e.ctc = "Enter the candidate's annual CTC — the fee is a percentage of it.";
    if (!(p > 0 && p <= 100)) e.fee = 'The fee % should be more than 0 and at most 100.';
    if (!joined) e.joined = 'Enter the joining date.';
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true); setFail('');
    try {
      const res = await api.post(`/invoices/joinings/${row.applicationId}/raise`, {
        offeredCtc: c, feePercent: p, joiningDate: joined,
      });
      onSaved(res.data.id, `Raised ${res.data.invoiceNumber} for ${row.name} at ${row.client}.`);
    } catch (err) {
      setFail(err.response?.data?.error || 'The invoice could not be raised.');
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New join — raise its invoice"
      size="wide"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-gold" disabled={!row || busy} onClick={raise}>
            {busy ? 'Raising…' : `Raise invoice${next ? ` ${next}` : ''}`}
          </button>
        </>
      )}
    >
      <div className="small-muted" style={{ marginBottom: 12 }}>
        A candidate the ATS has marked <b>Joined</b> waits here until the invoice is raised. The fee is the client&apos;s agreed
        percentage of the annual CTC; GST and TDS follow the client&apos;s own rates. Recording a new joining itself happens in
        the ATS under Interviews &amp; Joining.
      </div>
      {loadErr && <div className="notice red"><span>{loadErr}</span></div>}
      {!list && !loadErr && <div className="small-muted">Loading the joinings…</div>}
      {list && list.length === 0 && (
        <div className="notice"><span>No joined candidate is waiting for an invoice — every joining the ATS knows about is billed.</span></div>
      )}
      {list && list.length > 0 && (
        <>
          <label className="field"><span>Candidate who joined · {list.length} waiting</span>
            <Combo value={id} onChange={(e) => setId(e.target.value)}>
              <option value="">Choose a candidate…</option>
              {list.map((r) => (
                <option key={r.applicationId} value={r.applicationId}>
                  {`${r.name} · ${r.client}${r.joiningDate ? ` · joined ${fmtD(r.joiningDate)}` : ''}`}
                </option>
              ))}
            </Combo>
            {errs.row && <div className="inv-err">{errs.row}</div>}
          </label>
          {row && (
            <>
              <div className="inv-callout">
                <b>{row.name}</b> joined <b>{row.client}</b>{row.role ? ` as ${row.role}` : ''}
                {row.requirement && row.requirement !== row.role ? ` (${row.requirement})` : ''}
                {row.recruiter ? ` · recruiter ${row.recruiter}` : ''}
              </div>
              <div className="inv-form">
                <label className="field"><span>Joining date</span>
                  <input type="date" value={joined} onChange={(e) => setJoined(e.target.value)} />
                  {errs.joined && <div className="inv-err">{errs.joined}</div>}
                </label>
                <label className="field"><span>Annual CTC (₹)</span>
                  <input type="number" min="0" step="1000" inputMode="numeric" value={ctc} onChange={(e) => setCtc(e.target.value)} />
                  {errs.ctc && <div className="inv-err">{errs.ctc}</div>}
                </label>
                <label className="field"><span>Fee % of CTC{row.feePercent != null ? ` · client agreement ${row.feePercent}%` : ''}</span>
                  <input type="number" min="0" step="0.01" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} />
                  {errs.fee && <div className="inv-err">{errs.fee}</div>}
                </label>
                <div className="field"><span>What it would invoice for</span>
                  <div className="inv-callout" style={{ margin: 0 }}>
                    {billing != null
                      ? <>Fee <b>{money(billing)}</b> + GST {row.gstPercent || 0}% <b>{money(gst)}</b> = <b>{money(ROUND(billing + gst))}</b>{tds ? <> · TDS {row.tdsPercent}% {money(tds)}</> : null}</>
                      : 'Enter the CTC and the fee %'}
                  </div>
                </div>
              </div>
            </>
          )}
          {fail && <div className="notice red"><span>{fail}</span></div>}
        </>
      )}
    </Modal>
  );
}
