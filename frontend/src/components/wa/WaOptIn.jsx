import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import api from '../../api';
import Modal from '../Modal.jsx';
import { useWaConfig, waMayUse, errText, WA_ICON } from './waKit.js';
import '../reach/reach.css';
import './wa.css';

// ---------------------------------------------------------------------------
// WHATSAPP OPT-IN (candidates and vendors). Nobody is opted in until a person says so here, or the candidate's consent record already says
// "Messages: Given". Bulk WhatsApp skips everybody who is not opted in; a single chat only warns.
//   <WaOptInModal entityType ids onClose onDone />     "Mark opted in" (needs a few words: where the permission came from) / "Remove opt-in"
//   <WaOptInToggle entityType id />                     one line on a profile: "WhatsApp: Opted in" + Change
// ---------------------------------------------------------------------------
export function WaOptInModal({ entityType, ids, onClose, onDone }) {
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  async function go(optedIn) {
    setBusy(true); setMsg(null);
    try {
      const r = await api.post('/wa/optin', { entityType, ids, optedIn, source });
      setMsg({ text: r.data.message + (r.data.skipped ? ` ${r.data.skipped} could not be changed (not in your list).` : '') });
      if (onDone) onDone(r.data);
    } catch (e) { setMsg({ bad: true, text: errText(e, 'Could not save.') }); } finally { setBusy(false); }
  }
  const word = entityType === 'vendor' ? 'vendor' : 'candidate';
  return (
    <Modal
      title={`${WA_ICON} WhatsApp permission for ${ids.length} ${ids.length === 1 ? word : `${word}s`}`}
      onClose={onClose}
      footer={(
        <div className="wa-foot">
          <button type="button" className="btn" onClick={onClose}>Close</button>
          <button type="button" className="btn" disabled={busy} onClick={() => go(false)}>Remove opt-in</button>
          <button type="button" className="btn wa-go" disabled={busy || !source.trim()} onClick={() => go(true)}>Mark opted in</button>
        </div>
      )}
    >
      <div className="wa-note info">Only mark people who agreed to get WhatsApp messages from us (for example on a call, on a form or by message). Sending to people who did not ask can get our number restricted.</div>
      <div className="wa-field">
        <label htmlFor="wa-src">Where did the permission come from?</label>
        <input id="wa-src" value={source} maxLength={120} onChange={(e) => setSource(e.target.value)} placeholder="e.g. Said yes on the phone, filled our form" />
      </div>
      {msg && <div className={`wa-note ${msg.bad ? 'bad' : 'ok'}`} role="status">{msg.text}</div>}
    </Modal>
  );
}

export function WaOptInToggle({ entityType, id }) {
  const cfg = useWaConfig();
  const [p, setP] = useState(null);
  const [open, setOpen] = useState(false);
  const may = waMayUse(cfg, entityType);
  const load = useCallback(() => {
    api.post('/wa/recipients', { entityType, ids: [id] }).then((r) => setP((r.data.recipients || [])[0] || null)).catch(() => setP(null));
  }, [entityType, id]);
  useEffect(() => { if (may && id) load(); }, [may, id, load]);
  if (!may || !p) return null;
  return (
    <span className="wa-optline">
      <span aria-hidden="true">{WA_ICON}</span> WhatsApp: <b>{p.dnc ? 'Do not contact' : p.optedIn ? 'Opted in' : 'Not opted in'}</b>
      {p.optedIn && p.optInSource ? <span className="small-muted"> ({p.optInSource})</span> : null}{' '}
      {!p.dnc && <button type="button" className="link-btn" onClick={() => setOpen(true)}>Change</button>}
      {open && createPortal(
        <div className="rch-boost"><WaOptInModal entityType={entityType} ids={[id]} onClose={() => setOpen(false)} onDone={load} /></div>,
        document.body,
      )}
    </span>
  );
}
