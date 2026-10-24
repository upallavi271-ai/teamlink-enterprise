import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import Combo from '../Combo.jsx';
import { PURPOSES, purposeLabel, errorOf, statusWord } from './aiCallingShared.js';

// The confirm window for AI calls. NOTHING is called until the person presses the big button here.
//
//   applicationIds   one candidate (shows the exact script) or several (a campaign)
//   purpose          Screening | Shortlist Notification | Interview Notification | Interview Reminder
//   offerId          when it comes from an "Offer" (after a Shortlisted move or an interview booking)
//
// The lines shown are the lines the assistant says: verified facts from the database only. The person may change the few
// permitted parts (leave out salary / duties, add a short note) - never the facts.
export default function AiCallDialog({
  applicationIds, purpose: purposeIn, offerId, onClose, onDone,
}) {
  const ids = applicationIds || [];
  const many = ids.length > 1;
  const [purpose, setPurpose] = useState(purposeIn || 'Screening');
  const [language, setLanguage] = useState('');
  const [fields, setFields] = useState({
    includeSalary: true, includeResponsibilities: true, instructions: '', extraNote: '',
  });
  const [pv, setPv] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(null);
  const [campaign, setCampaign] = useState('');
  const fieldKey = JSON.stringify(fields);

  useEffect(() => {
    let live = true;
    setErr('');
    const t = setTimeout(() => {
      api.post('/ai-calling/preview', { applicationId: ids[0], purpose, language: language || undefined, fields })
        .then((r) => { if (live) { setPv(r.data); if (!language) setLanguage(r.data.language); } })
        .catch((e) => { if (live) { setPv(null); setErr(errorOf(e, 'The preview could not be made.')); } });
    }, 250);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids[0], purpose, language, fieldKey]);

  async function confirm() {
    setBusy(true); setErr('');
    try {
      let res;
      if (offerId) {
        res = await api.post(`/ai-calling/offers/${offerId}/accept`, { confirm: true, language, fields });
        setSent({ one: true, status: res.data.callStatus, note: null });
      } else {
        res = await api.post('/ai-calling/calls', {
          applicationIds: ids, purpose, language, fields, confirm: true, campaignName: many ? campaign : undefined,
        });
        const r = res.data.results || [];
        setSent({ many, results: r, status: r[0] && r[0].status, note: r[0] && r[0].note });
      }
      if (onDone) onDone();
    } catch (e) {
      setErr(errorOf(e, 'The call could not be placed.'));
    } finally { setBusy(false); }
  }

  const allowed = pv && pv.allowed && !pv.fieldError;
  const title = many ? `Call ${ids.length} candidates with the AI assistant` : 'Call with the AI assistant';
  return (
    <Modal
      title={title}
      size="wide"
      onClose={onClose}
      foot={sent ? <button className="btn btn-primary" onClick={onClose}>Close</button> : (
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || (!many && !allowed)} onClick={confirm}>
            {busy ? 'Please wait…' : many ? `Yes, call ${ids.length} candidates` : 'Yes, call now'}
          </button>
        </>
      )}
    >
      {sent ? (
        <div>
          <div className="notice" style={{ marginBottom: 10 }}>
            {sent.many
              ? `${sent.results.filter((r) => r.ok).length} call(s) started or waiting. ${sent.results.filter((r) => !r.ok).length ? `${sent.results.filter((r) => !r.ok).length} could not be placed.` : ''}`
              : `The call is ${sent.status === 'calling' ? 'being placed now' : 'waiting for its turn'}${sent.note ? ` (${sent.note})` : ''}.`}
          </div>
          {sent.many && sent.results.filter((r) => !r.ok).map((r) => <div key={r.applicationId} className="small-muted">Not placed: {r.error}</div>)}
          <div className="small-muted">The result will appear on the candidate&apos;s history and on the AI Calling page. It says <b>Done</b> only after Exotel confirms the call ended.</div>
        </div>
      ) : (
        <div>
          {pv && pv.mode === 'Test' && <div className="notice amber">Test mode is on: only the test phone numbers saved by the Admin can be called.</div>}
          {pv && pv.mode === 'Off' && <div className="notice red">AI calling is switched off. An Admin turns it on in Administration &gt; Integrations &gt; AI Calling.</div>}
          {err && <div className="error-text" style={{ marginBottom: 8 }}>{err}</div>}
          {pv && pv.candidate && !many && (
            <div style={{ marginBottom: 10 }}>
              <b>{pv.candidate.name}</b>
              <span className="small-muted">{` · ${pv.candidate.job} · ${pv.candidate.phoneMask || 'no phone'}`}</span>
            </div>
          )}
          {many && <div className="small-muted" style={{ marginBottom: 8 }}>The first candidate&apos;s script is shown. Each candidate gets the same words with their own name and details.</div>}
          <div className="grid-2">
            <div className="field">
              <label>What is the call for</label>
              <Combo value={purpose} onChange={(e) => setPurpose(e.target.value)} disabled={!!offerId}>
                {PURPOSES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </Combo>
            </div>
            <div className="field">
              <label>Language</label>
              <Combo value={language || (pv && pv.language) || 'English'} onChange={(e) => setLanguage(e.target.value)}>
                {((pv && pv.languages) || ['English']).map((l) => <option key={l}>{l}</option>)}
              </Combo>
            </div>
          </div>
          {pv && !pv.verdict.ok && <div className="notice red">{pv.verdict.reason}</div>}
          {pv && pv.notReady && <div className="notice red">AI calling is not ready: {pv.notReady[0]}</div>}
          {pv && pv.duplicate && <div className="notice amber">This candidate already has a {statusWord(pv.duplicate.status).toLowerCase()} call for this requirement and purpose.</div>}
          {pv && pv.window && !pv.window.open && <div className="notice amber">{pv.window.refuse ? 'It is outside the calling hours, so the call will be refused.' : 'It is outside the calling hours. The call will wait and be placed at the next opening.'}</div>}
          {pv && pv.fieldError && <div className="notice red">{pv.fieldError}</div>}
          <div className="section-label" style={{ margin: '12px 0 6px' }}>What the assistant will say ({purposeLabel(purpose)})</div>
          <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '8px 12px', background: 'var(--paper)', maxHeight: 220, overflow: 'auto' }}>
            {pv ? pv.lines.map((l, i) => <p key={`${l.key}-${i}`} style={{ margin: '4px 0', fontSize: 13, lineHeight: 1.5 }}>{l.text}</p>) : <span className="small-muted">Loading…</span>}
          </div>
          <div className="small-muted" style={{ marginTop: 6 }}>These are facts from our records. The assistant says it is an AI, never says selected, hired or offered, and never promises anything.</div>
          <div className="section-label" style={{ margin: '12px 0 6px' }}>You may change</div>
          {purpose === 'Screening' && (
            <>
              <label className="small-muted" style={{ display: 'block', marginBottom: 4 }}>
                <input type="checkbox" checked={fields.includeSalary} onChange={(e) => setFields({ ...fields, includeSalary: e.target.checked })} /> Tell the salary range (only if it is saved on the requirement)
              </label>
              <label className="small-muted" style={{ display: 'block', marginBottom: 6 }}>
                <input type="checkbox" checked={fields.includeResponsibilities} onChange={(e) => setFields({ ...fields, includeResponsibilities: e.target.checked })} /> Tell the main duties
              </label>
            </>
          )}
          {purpose.startsWith('Interview') && (
            <div className="field">
              <label>Instructions for the candidate (short, optional)</label>
              <input value={fields.instructions} maxLength={200} onChange={(e) => setFields({ ...fields, instructions: e.target.value })} placeholder="Example: bring a photo ID" />
            </div>
          )}
          <div className="field">
            <label>A short note the assistant adds (optional)</label>
            <input value={fields.extraNote} maxLength={200} onChange={(e) => setFields({ ...fields, extraNote: e.target.value })} placeholder="No web links or phone numbers" />
          </div>
          {many && (
            <div className="field">
              <label>Name of this campaign</label>
              <input value={campaign} maxLength={80} onChange={(e) => setCampaign(e.target.value)} placeholder="Example: Staff nurse screening, October" />
            </div>
          )}
          <div className="small-muted">Press the button only if you want the AI assistant to phone {many ? 'these candidates' : 'this candidate'} now. A call is never placed without it.</div>
        </div>
      )}
    </Modal>
  );
}
