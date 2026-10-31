import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import './agreementFlow.css';

// ---------------------------------------------------------------------------
// THE AGREEMENT STEPS (user, 2026-10-13)
//   Draft  >  With Purna Sir  >  With BDE TL  >  Sent to client  >  Signed  >  Active
// One plain stepper + the ONE next button for whoever holds it (server: utils/agreementWorkflow.js).
//   BDE            Send to Purna Sir          (needs the commercial part filled; says what is missing)
//   Purna Sir      Send to BDE TL             (needs Tax & billing; or Send back to BDE with a reason)
//   BDE TL         Send to client             (after ticking what was checked; or Send back, with a reason)
//   Admin          all of those
// Only "Send to client" makes the client link. A login with no part in it sees nothing (403 -> renders null).
// ---------------------------------------------------------------------------
const CHECKS = [
  ['commercial', 'The commercial terms (fee, guarantee, payment)'],
  ['tax', 'Tax & billing'],
  ['payment', 'Payment details'],
  ['documents', 'The documents'],
];

export function StageChip({ label, colour }) {
  if (!label) return null;
  return <span className={`af-chip af-${colour || 'orange'}`}>{label}</span>;
}

export default function AgreementFlow({ clientId, onChanged, onLoaded, compact = false, refreshKey = '' }) {
  const [d, setD] = useState(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [ask, setAsk] = useState(null); // { action, title, label }
  const [reason, setReason] = useState('');
  const [ticks, setTicks] = useState({});

  const load = useCallback(() => {
    if (!clientId) return;
    api.get(`/agreement-flow/${clientId}`)
      .then((r) => { setD(r.data); setHidden(false); onLoaded?.(r.data); })
      .catch(() => { setHidden(true); onLoaded?.(null); });
  }, [clientId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [load, refreshKey]);

  if (hidden || !d) return null;
  const hr = d.hrLabel || 'HR';
  const r = d.rights || {};

  async function act(action, body = {}) {
    setBusy(action); setErr(''); setMsg('');
    try {
      const res = await api.post(`/agreement-flow/${clientId}/action`, { action, ...body });
      setMsg(`Done. It is now: ${res.data.stageLabel}.`);
      setAsk(null); setReason('');
      load(); onChanged?.();
    } catch (e) {
      setErr(e.response?.data?.error || 'That did not work. Please try again.');
    }
    setBusy('');
  }
  async function sendToClient() {
    setBusy('client'); setErr(''); setMsg('');
    try {
      await api.post(`/clients/${clientId}/agreement/send`, { verified: CHECKS.map(([k]) => k).filter((k) => ticks[k]) });
      setMsg('Sent. The client has the link now.');
      load(); onChanged?.();
    } catch (e) {
      setErr(e.response?.data?.error || 'That did not work. Please try again.');
    }
    setBusy('');
  }

  const missCommercial = d.missing?.commercial || [];
  const allTicked = CHECKS.every(([k]) => ticks[k]);
  const isTlStep = d.stage === 'WITH_TL';
  const showSendClient = r.sendToClient || r.adminOverrideSend;
  const needTicks = r.roles?.bdeTl && !r.roles?.admin;
  const mine = r.sendToHr || r.sendToTl || r.sendToClient;

  return (
    <div className={`af${compact ? ' af-compact' : ''}`} data-stage={d.stage}>
      <ol className="af-steps" aria-label="Agreement steps">
        {d.steps.map((s, i) => (
          <li key={s.key} className={`af-step af-${s.state}${s.state === 'current' ? (mine ? ' af-mine' : ' af-wait') : ''}`}>
            <span className="af-dot" aria-hidden="true">{s.state === 'done' ? '✓' : i + 1}</span>
            <span className="af-lbl">{s.label}</span>
          </li>
        ))}
      </ol>
      <div className="af-line">
        {d.stage === 'ACTIVE' && 'The agreement is active. Requirements can go live.'}
        {d.stage === 'SIGNED' && "The client signed. Upload TeamLink's Aadhaar eSigned copy (DigiLocker) in View agreement; with both copies it turns Active."}
        {d.stage === 'SENT' && 'Now both sides eSign it with Aadhaar in DigiLocker and the two copies are uploaded in View agreement.'}
        {['DRAFT', 'WITH_HR', 'WITH_TL'].includes(d.stage) && (mine ? <b>It is your turn.</b> : <>It is with <b>{d.waitingOn}</b>.</>)}
        {d.stage === 'REJECTED' && 'The client said no. Change the terms and make a new draft.'}
        {d.stage === 'EXPIRED' && 'This agreement ended. Make a new draft.'}
      </div>
      {d.lastBackReason && ['DRAFT', 'WITH_HR'].includes(d.stage) && (
        <div className="af-back" role="status"><b>Sent back:</b> {d.lastBackReason}</div>
      )}

      {r.sendToHr && (
        <div className="af-actions">
          {missCommercial.length > 0 && <div className="af-miss">Still to fill: {missCommercial.join(', ')}. Press Edit client.</div>}
          <button type="button" className="btn btn-primary" disabled={!!busy || missCommercial.length > 0} onClick={() => act('send_to_hr')}>
            {busy === 'send_to_hr' ? 'Sending…' : `Send to ${hr}`}
          </button>
        </div>
      )}

      {r.sendToTl && (
        <div className="af-actions">
          {(d.missing?.tax || []).length > 0 && <div className="af-miss">Still to fill in Tax &amp; billing: {d.missing.tax.join(', ')}.</div>}
          <button type="button" className="btn btn-primary" disabled={!!busy || (d.missing?.tax || []).length > 0} onClick={() => act('send_to_tl')}>
            {busy === 'send_to_tl' ? 'Sending…' : 'Send to BDE TL'}
          </button>
          {r.backToBdeFromHr && <button type="button" className="btn" disabled={!!busy} onClick={() => { setAsk({ action: 'back_to_bde', title: 'Send back to the BDE', label: 'Send back to BDE' }); setErr(''); }}>Send back to BDE</button>}
        </div>
      )}

      {isTlStep && showSendClient && (
        <div className="af-actions">
          {needTicks && (
            <fieldset className="af-checks">
              <legend>I checked:</legend>
              {CHECKS.map(([k, l]) => (
                <label key={k}><input type="checkbox" checked={!!ticks[k]} onChange={(e) => setTicks({ ...ticks, [k]: e.target.checked })} /> {l}</label>
              ))}
            </fieldset>
          )}
          <button type="button" className="btn btn-primary" disabled={!!busy || (needTicks && !allTicked)} onClick={sendToClient}>
            {busy === 'client' ? 'Sending…' : 'Send to client'}
          </button>
          {r.backToHr && <button type="button" className="btn" disabled={!!busy} onClick={() => { setAsk({ action: 'back_to_hr', title: `Send back to ${hr}`, label: `Send back to ${hr}` }); setErr(''); }}>Send back to {hr}</button>}
          {r.backToBdeFromTl && <button type="button" className="btn" disabled={!!busy} onClick={() => { setAsk({ action: 'back_to_bde', title: 'Send back to the BDE', label: 'Send back to BDE' }); setErr(''); }}>Send back to BDE</button>}
        </div>
      )}
      {!isTlStep && r.adminOverrideSend && (
        <div className="af-actions">
          <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => { if (window.confirm('Send the agreement to the client now, without waiting for the steps? This is written in the history.')) sendToClient(); }}>
            Admin: send to client now
          </button>
        </div>
      )}

      {msg && <div className="af-ok" role="status">{msg}</div>}
      {err && <div className="error-text" role="alert">{err}</div>}

      {!compact && d.history?.length > 0 && (
        <details className="af-hist">
          <summary>Who did what</summary>
          <ul>
            {d.history.map((h, i) => (
              <li key={`${h.at}-${i}`}>
                <b>{h.who || 'Someone'}</b> {h.action === 'send_to_client' ? 'sent it to the client' : `moved it: ${h.from} → ${h.to}`}
                <span className="small-muted"> · {new Date(h.at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                {h.reason && <div className="af-reason">“{h.reason}”</div>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {ask && (
        <Modal
          title={ask.title}
          onClose={() => setAsk(null)}
          footer={(
            <>
              <button className="btn" type="button" onClick={() => setAsk(null)}>Cancel</button>
              <button className="btn btn-primary" type="button" disabled={!!busy || !reason.trim()} onClick={() => act(ask.action, { reason })}>{busy ? 'Sending…' : ask.label}</button>
            </>
          )}
        >
          <label className="field">
            <span>Why are you sending it back? (they will read this)</span>
            <textarea rows="3" value={reason} autoFocus onChange={(e) => setReason(e.target.value)} placeholder="e.g. The GSTIN is missing" />
          </label>
          {err && <div className="error-text" role="alert">{err}</div>}
        </Modal>
      )}
    </div>
  );
}
