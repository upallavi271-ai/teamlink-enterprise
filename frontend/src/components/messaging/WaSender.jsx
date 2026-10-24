import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import Combo from '../Combo.jsx';
import '../comm/comm.css';
import { senderState, numberToSend, fmtNumber } from './waSender.js';

// ---------------------------------------------------------------------------
// "Sending from" - the WhatsApp number a message leaves from (Administration > Integrations > WhatsApp & SMS > WhatsApp numbers).
//   const wa = useWaSender(ch === 'WhatsApp', planned);
//   wa.node        the line to show (nothing while only the old single number exists)
//   wa.numberId    send this as waNumberId (only when the person picked one of several)
//   wa.canSend     false = no number for this person: the Send button must be disabled (the server refuses it too)
//   wa.state       { mode, show, canSend, message, selected, usable }
// ---------------------------------------------------------------------------
let cache = null; // { at, promise }
export function clearMyWaNumbers() { cache = null; }
export function loadMyWaNumbers() {
  if (cache && Date.now() - cache.at < 30000) return cache.promise;
  const promise = api.get('/wa-numbers/my-numbers').then((r) => r.data).catch(() => { cache = null; return null; });
  cache = { at: Date.now(), promise };
  return promise;
}

export function useMyWaNumbers(enabled = true) {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let on = true;
    loadMyWaNumbers().then((d) => { if (on) setInfo(d || { legacy: true }); });
    return () => { on = false; };
  }, [enabled]);
  return info;
}

export function WaSenderView({ state, chosen, onChange, planned }) {
  if (!state || !state.show) return null;
  if (!state.canSend) {
    return <div className="cm-line cm-orange" role="alert" data-wa-sender="blocked"><b>{state.message}</b></div>;
  }
  if (state.mode === 'one') {
    const n = planned && planned.label ? planned : state.usable[0];
    return <div className="cm-line cm-green" data-wa-sender="one">Sending from <b>{n.label}</b> ({fmtNumber(n.displayNumber)})</div>;
  }
  return (
    <div className="cm-line cm-green wa-sender-pick" data-wa-sender="many">
      <label htmlFor="wa-sender-pick" style={{ fontSize: 12.5, fontWeight: 600, display: 'block', marginBottom: 3 }}>Sending from</label>
      <Combo id="wa-sender-pick" value={chosen || state.selected} onChange={(e) => onChange(e.target.value)} emptyText="No such number">
        {state.usable.map((n) => <option key={n.id} value={n.id}>{n.label} ({fmtNumber(n.displayNumber)})</option>)}
      </Combo>
      {planned && planned.label && !chosen && <div className="cm-sub">Picked for this chat: {planned.label} ({fmtNumber(planned.displayNumber)}). Choose another number from your list if you want.</div>}
      <div className="cm-sub">You can use only the numbers the Admin gave you.</div>
    </div>
  );
}

export function useWaSender(enabled = true, planned = null) {
  const info = useMyWaNumbers(enabled);
  const [chosen, setChosen] = useState('');
  const state = useMemo(() => (enabled ? senderState(info, chosen) : senderState({ legacy: true }, chosen)), [info, chosen, enabled]);
  const node = enabled ? <WaSenderView state={state} chosen={chosen} onChange={setChosen} planned={planned} /> : null;
  return {
    state, node, chosen, setChosen,
    numberId: numberToSend(state, chosen),
    canSend: state.canSend,
    blockedMessage: state.canSend ? '' : state.message,
    active: state.show,
  };
}
