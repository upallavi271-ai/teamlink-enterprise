import { useEffect, useState } from 'react';
import api from '../api';
import { Modal } from './proto.jsx';
import Combo from './Combo.jsx';

// ---------------------------------------------------------------------------
// THE CONTACT PANEL (§3-§7, §16).
//
// One button, four methods. Four buttons on every screen is clutter; this asks
// the two questions that actually matter first — WHY are you contacting them,
// and HOW — and only then shows the one form that method needs.
//
//   Call      the dialling happens on a phone, so this records the RESULT
//   WhatsApp  } a message, pre-filled from a template, editable before it goes
//   SMS       }
//   Email     }
//
// HONEST ABOUT DELIVERY. Only Email really goes out, and only when SMTP is
// configured. SMS and WhatsApp have no provider wired in, so the panel says
// "Demo / Simulated" on the button itself rather than claiming a send it did
// not make.
//
// Closing the panel hands the caller what happened, so the screen behind it
// can go straight on to "What happened? / What next?" (§8, §9) without the
// user having to find that step themselves.
// ---------------------------------------------------------------------------

const METHODS = [
  { id: 'Call', icon: '📞', label: 'Call' },
  { id: 'WhatsApp', icon: '💬', label: 'WhatsApp' },
  { id: 'SMS', icon: '💬', label: 'SMS' },
  { id: 'Email', icon: '✉️', label: 'Email' },
];

// §17 — what a message says before anybody edits it. The token is filled from
// whatever the caller knows; anything it does not know is simply left out.
function draftFor(template, { name, role, client }) {
  const who = name || 'there';
  const what = role ? ` for ${role}` : '';
  const at = client ? ` at ${client}` : '';
  switch (template) {
    case 'Interview Reminder':
      return `Hi ${who}, a reminder about your interview${what}${at}. Please confirm you are able to attend.`;
    case 'Interview Confirmation':
      return `Hi ${who}, your interview${what}${at} is confirmed. We will send the joining details shortly.`;
    case 'Interview Reschedule':
      return `Hi ${who}, we need to move your interview${what}${at}. Could you share a time that suits you?`;
    case 'Document Request':
      return `Hi ${who}, could you send across your documents${what} so we can proceed?`;
    case 'Joining Confirmation':
      return `Hi ${who}, confirming your joining${what}${at}. Please reply to confirm the date still works.`;
    case 'Offer Follow-up':
      return `Hi ${who}, following up on the offer${what}${at}. Do let us know your decision.`;
    default:
      return `Hi ${who}, `;
  }
}

export default function ContactPanel({
  candidateId, name, phone, email, role, client, applicationId, onClose, onContacted,
}) {
  const [vocab, setVocab] = useState(null);
  const [purpose, setPurpose] = useState('');
  const [method, setMethod] = useState('');
  const [callResult, setCallResult] = useState('');
  const [notes, setNotes] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [template, setTemplate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);

  useEffect(() => {
    api.get('/followups/statuses').then((r) => setVocab(r.data)).catch(() => setVocab(null));
  }, []);

  const templates = vocab ? vocab.templates.candidate : [];
  const simulated = method === 'WhatsApp' || method === 'SMS';
  const reach = method === 'Email' ? email : phone;

  function pickTemplate(t) {
    setTemplate(t);
    if (!purpose) setPurpose(t);
    setSubject(t);
    setBody(draftFor(t, { name, role, client }));
  }

  async function send() {
    setError(''); setBusy(true);
    try {
      const res = await api.post(`/candidates/${candidateId}/contact`, {
        method, purpose, applicationId, callResult, notes, subject, body,
      });
      setDone(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'That could not be recorded.');
    } finally { setBusy(false); }
  }

  // --- after it is done: say plainly what happened, then hand over ----------
  if (done) {
    return (
      <Modal
        title={`Contacted ${name}`}
        onClose={() => onClose()}
        footer={<>
          <button className="btn" onClick={() => onClose()}>Close</button>
          <button className="btn btn-primary" onClick={() => onContacted && onContacted({ method, purpose, ...done })}>
            Record what happened →
          </button>
        </>}
      >
        <div className="notice">
          {done.delivery === 'logged' && <>Call recorded — <b>{callResult}</b>.</>}
          {done.delivery === 'queued' && <><b>{method} queued</b> to {reach}. It will show as Sent once the provider accepts it.</>}
          {done.delivery === 'simulated' && (
            <>
              <b>{method} recorded — Demo / Simulated.</b> No {method} provider is connected, so nothing was
              transmitted. The message is on this candidate&apos;s Communications history exactly as written.
            </>
          )}
        </div>
        <div className="small-muted" style={{ marginTop: 8 }}>
          Next: say what happened and when the next touch is due, so this does not stop here.
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={`Contact ${name}`}
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        {method && (
          <button className="btn btn-primary" disabled={busy || !purpose} onClick={send}>
            {busy ? 'Recording…' : (method === 'Call' ? 'Save call' : `Send ${method}${simulated ? ' (Demo)' : ''}`)}
          </button>
        )}
      </>}
    >
      {/* 1. WHY — asked first, because it is what everything else follows from. */}
      <div className="field">
        <label>Why are you contacting them?</label>
        <Combo creatable value={purpose} onChange={(e) => setPurpose(e.target.value)}>
          <option value="">Choose a purpose…</option>
          {templates.map((t) => <option key={t} value={t}>{t}</option>)}
        </Combo>
      </div>

      {/* 2. HOW */}
      <div className="field">
        <label>Choose method</label>
        <div className="contact-methods">
          {METHODS.map((m) => {
            const has = m.id === 'Email' ? !!email : !!phone;
            return (
              <button
                key={m.id}
                type="button"
                className={`contact-method${method === m.id ? ' is-on' : ''}`}
                disabled={!has}
                title={has ? '' : `No ${m.id === 'Email' ? 'email address' : 'phone number'} on this record`}
                onClick={() => { setMethod(m.id); setError(''); if (m.id !== 'Call' && !body) pickTemplate(purpose || templates[0] || ''); }}
              >
                <span aria-hidden="true">{m.icon}</span> {m.label}
              </button>
            );
          })}
        </div>
        {method && <div className="small-muted" style={{ marginTop: 6 }}>{method === 'Email' ? email : phone}</div>}
      </div>

      {/* 3a. CALL — the result is the record (§4). */}
      {method === 'Call' && (
        <>
          <div className="field">
            <label>How did the call go?</label>
            <Combo value={callResult} onChange={(e) => setCallResult(e.target.value)}>
              <option value="">Choose…</option>
              {(vocab ? vocab.callResults : []).map((r) => <option key={r} value={r}>{r}</option>)}
            </Combo>
          </div>
          <div className="field">
            <label>Notes</label>
            <textarea rows="3" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </>
      )}

      {/* 3b. MESSAGE — pre-filled, editable, honest about sending (§5-§7). */}
      {method && method !== 'Call' && (
        <>
          <div className="field">
            <label>Template</label>
            <Combo value={template} onChange={(e) => pickTemplate(e.target.value)}>
              <option value="">Write it myself</option>
              {templates.map((t) => <option key={t} value={t}>{t}</option>)}
            </Combo>
          </div>
          {method === 'Email' && (
            <div className="field">
              <label>Subject</label>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
          )}
          <div className="field">
            <label>Message</label>
            <textarea rows="5" value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
          {simulated && (
            <div className="notice">
              <b>Demo / Simulated.</b> No {method} provider is connected to this app, so this will be recorded on
              the candidate&apos;s history but not transmitted.
            </div>
          )}
        </>
      )}

      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}
