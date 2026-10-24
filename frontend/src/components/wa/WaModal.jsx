import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import Combo from '../Combo.jsx';
import { buildWaLink, cleanNumber, fillPlaceholders, leftoverPlaceholders } from '../../utils/waLink';
import { loadWaTemplates, openWa, errText, useWaConfig, WA_ICON } from './waKit.js';
import './wa.css';

// ---------------------------------------------------------------------------
// ONE-PERSON WHATSAPP (free click-to-chat). Name, number (editable), template (type to search), the message (editable) and ONE green
// button "Open WhatsApp": it opens https://wa.me/<number>?text=... in a NEW tab and writes one line in the WhatsApp Log.
// {words} that could not be filled are highlighted; the button stays off until they are filled in or removed (no literal braces are ever sent).
//   entityType  candidate | employee | vendor | client | invoice      id  the record id      requirementId / applicationId  optional
// ---------------------------------------------------------------------------
export function Marked({ text }) {
  const parts = String(text || '').split(/(\{[A-Za-z_][A-Za-z0-9_]*\})/g);
  return <>{parts.map((p, i) => (/^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(p) ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}</>;
}

export default function WaModal({ entityType, id, requirementId, applicationId, name: nameHint, onClose, onLogged }) {
  const [state, setState] = useState({ loading: true, error: '', person: null, cc: '91' });
  const [templates, setTemplates] = useState([]);
  const [tplId, setTplId] = useState('');
  const [number, setNumber] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [logErr, setLogErr] = useState('');
  const cfg = useWaConfig();

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [r, t] = await Promise.all([
          api.post('/wa/recipients', { entityType, ids: [id], requirementId, applicationId }),
          loadWaTemplates().catch(() => []),
        ]);
        if (!live) return;
        const person = (r.data.recipients || [])[0];
        if (!person) { setState({ loading: false, error: 'This person is not in your list, or has no record here.', person: null, cc: '91' }); return; }
        setTemplates(t);
        setNumber(person.number || '');
        setState({ loading: false, error: '', person, cc: r.data.settings.defaultCountryCode || '91' });
      } catch (e) { if (live) setState({ loading: false, error: errText(e, 'Could not open WhatsApp for this person.'), person: null, cc: '91' }); }
    })();
    return () => { live = false; };
  }, [entityType, id, requirementId, applicationId]);

  const person = state.person;
  const tpl = templates.find((t) => t.id === tplId) || null;
  const mod = { candidate: 'ATS', client: 'ATS', employee: 'HRMS', vendor: 'Accounts', invoice: 'Accounts' }[entityType];
  const options = templates.filter((t) => t.module === mod || t.module === 'General');

  // choosing a template fills the message with this person's values; typing in the box after that is the user's own
  const pick = (v) => {
    setTplId(v);
    const t = templates.find((x) => x.id === v);
    setMessage(t && person ? fillPlaceholders(t.body, person.vars).text : '');
  };
  const left = useMemo(() => leftoverPlaceholders(message), [message]);
  const num = useMemo(() => cleanNumber(number, state.cc), [number, state.cc]);
  const blocked = !!(person && person.dnc);
  const canOpen = !!person && !blocked && num.valid && message.trim().length > 0 && left.length === 0 && !busy && !done;
  let why = '';
  if (person) {
    if (blocked) why = 'This person asked not to be contacted.';
    else if (!num.valid) why = 'Write a valid number (with country code, 11 to 15 digits).';
    else if (!message.trim()) why = 'Write or pick a message.';
    else if (left.length) why = `Fill in or remove: ${left.map((k) => `{${k}}`).join(' ')}`;
  }

  async function open() {
    if (!canOpen) return;
    const link = buildWaLink(number, message, state.cc);
    if (!link) return;
    openWa(link); // straight from the click, so the browser lets the tab open
    setBusy(true);
    try {
      await api.post('/wa/log', { entityType, entityId: id, number, templateId: tplId || null, messageLength: message.length, requirementId });
      setDone(`Opened WhatsApp for ${person.name}. Saved in the WhatsApp log.`);
      if (onLogged) onLogged();
    } catch (e) {
      setDone(`Opened WhatsApp for ${person.name}.`);
      setLogErr(errText(e, 'It could not be written to the WhatsApp log.'));
    } finally { setBusy(false); }
  }

  return (
    <Modal
      title={`${WA_ICON} WhatsApp ${person ? person.name : (nameHint || '')}`}
      size="wide"
      onClose={onClose}
      footer={(
        <div className="wa-foot">
          <button type="button" className="btn" onClick={onClose}>{done ? 'Close' : 'Cancel'}</button>
          <button type="button" className="btn wa-go" disabled={!canOpen} title={why || 'Opens WhatsApp in a new tab'} onClick={open}>Open WhatsApp</button>
        </div>
      )}
    >
      {state.loading && <div className="small-muted">Getting the details...</div>}
      {state.error && <div className="wa-note bad">{state.error}</div>}
      {person && (
        <>
          {blocked && <div className="wa-note bad">Do not contact. This person asked not to be messaged, so WhatsApp is switched off for them.</div>}
          {!blocked && person.optInRequired && !person.optedIn && <div className="wa-note warn">Not opted in. Send only if they asked to hear from you.</div>}
          <div className="wa-two">
            <div className="wa-field"><label htmlFor="wa-to">To</label><input id="wa-to" value={person.name} readOnly aria-readonly="true" /></div>
            <div className="wa-field">
              <label htmlFor="wa-num">WhatsApp number</label>
              <input id="wa-num" inputMode="tel" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="e.g. 98765 43210" aria-invalid={!num.valid} />
              {!num.valid && <div className="error-text">{num.reason === 'No number' ? 'There is no number on file. Type one here.' : `${num.reason}. Use 11 to 15 digits with the country code.`}</div>}
            </div>
          </div>
          <div className="wa-field">
            <label>Template {cfg.mayEditTemplates && <a className="link-btn" href="/admin/message-templates?tab=whatsapp" target="_blank" rel="noopener">Edit templates</a>}</label>
            <Combo value={tplId} onChange={(e) => pick(e.target.value)}>
              <option value="">Write my own message</option>
              {options.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Combo>
          </div>
          <div className="wa-field">
            <label htmlFor="wa-text">Message (you can change it)</label>
            <textarea id="wa-text" className="wa-msg" value={message} onChange={(e) => setMessage(e.target.value)} placeholder={tpl ? '' : 'Type your message, or pick a template above.'} />
          </div>
          {message.trim() && (
            <div className="wa-field">
              <label>Preview</label>
              <div className="wa-preview"><Marked text={message} /></div>
              {left.length > 0 && (
                <div className="wa-note warn" style={{ marginTop: 8 }}>
                  These could not be filled: {left.map((k) => <span key={k} className="wa-miss">{`{${k}}`}</span>)} Type the real value in the message above, or delete the word.
                </div>
              )}
            </div>
          )}
          {done && <div className="wa-note ok" role="status">{done}</div>}
          {logErr && <div className="wa-note warn">{logErr}</div>}
          <div className="small-muted">TeamLink does not send anything. WhatsApp opens in a new tab and you press Send there.</div>
        </>
      )}
    </Modal>
  );
}
