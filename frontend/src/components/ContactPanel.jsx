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

// THE NUMBER, IN THE FORM A DIALLER WANTS IT. Records hold "9981520714",
// "+91 99815 20714" and "09981520714" for the same phone. tel:, wa.me and
// sms: all want the country code and nothing else: 919981520714. A number
// that is none of those shapes is passed through as its digits rather than
// guessed at.
function intlDigits(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return `91${d}`;
  if (d.length === 11 && d.startsWith('0')) return `91${d.slice(1)}`;
  return d;
}
const telHref = (phone) => `tel:+${intlDigits(phone)}`;
const whatsappHref = (phone, text) => `https://wa.me/${intlDigits(phone)}?text=${encodeURIComponent(text || '')}`;
// iOS reads "&body=", everything else "?body=". "?" is the more widely honoured.
const smsHref = (phone, text) => `sms:+${intlDigits(phone)}?body=${encodeURIComponent(text || '')}`;

// §17 — what a message says before anybody edits it. The token is filled from
// whatever the caller knows; anything it does not know is simply left out.
function draftFor(template, { name, role, client }, custom) {
  const who = name || 'there';
  const what = role ? ` for ${role}` : '';
  const at = client ? ` at ${client}` : '';
  // A purpose somebody added carries its own text; {name} {role} {client} filled in.
  if (custom && custom.template) {
    return custom.template.replace(/\{name\}/gi, who).replace(/\{role\}/gi, role || '').replace(/\{client\}/gi, client || '');
  }
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
  // "+ Add purpose": saved for everyone (ContactPurpose), with an optional message.
  const [adding, setAdding] = useState(null); // { label, template }
  const [addError, setAddError] = useState('');

  function loadVocab() {
    return api.get('/followups/statuses').then((r) => setVocab(r.data)).catch(() => setVocab(null));
  }
  useEffect(() => { loadVocab(); }, []);

  const templates = vocab ? vocab.templates.candidate : [];
  const customOf = (label) => (vocab?.customPurposes || []).find((c) => c.audience === 'candidate' && c.label === label) || null;

  async function savePurpose() {
    setAddError('');
    try {
      const r = await api.post('/followups/purposes', { audience: 'candidate', label: adding.label, template: adding.template });
      await loadVocab();
      setPurpose(r.data.label);
      setAdding(null);
    } catch (err) {
      setAddError(err.response?.data?.error || 'Could not add that purpose.');
    }
  }

  async function removePurpose(c) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Remove the purpose "${c.label}" for everyone? Contacts already logged keep it.`)) return;
    try {
      await api.delete(`/followups/purposes/${c.id}`);
      if (purpose === c.label) setPurpose('');
      await loadVocab();
    } catch (err) {
      setAddError(err.response?.data?.error || 'Could not remove that purpose.');
    }
  }
  // WhatsApp and SMS go out from the recruiter's OWN phone: the panel opens
  // the app with the message typed, the recruiter presses send there.
  const onDevice = method === 'WhatsApp' || method === 'SMS';
  const reach = method === 'Email' ? email : phone;

  function pickTemplate(t) {
    setTemplate(t);
    if (!purpose) setPurpose(t);
    setSubject(t);
    setBody(draftFor(t, { name, role, client }, customOf(t)));
  }

  // CLICKING CALL DIALS. The browser hands tel: to whatever calls on this
  // device — the phone itself on a mobile, Phone Link / Teams / Skype on a
  // desktop — and the form stays open underneath to record how it went.
  function chooseMethod(id) {
    setMethod(id);
    setError('');
    if (id === 'Call' && phone) window.location.href = telHref(phone);
    if (id !== 'Call' && !body) pickTemplate(purpose || templates[0] || '');
  }

  async function send() {
    setError('');
    // The app must be opened INSIDE the click, before anything is awaited:
    // a window opened after an await is no longer a user gesture, and popup
    // blockers stop it.
    if (method === 'WhatsApp') window.open(whatsappHref(phone, body), '_blank', 'noopener');
    if (method === 'SMS') window.location.href = smsHref(phone, body);
    setBusy(true);
    try {
      const res = await api.post(`/candidates/${candidateId}/contact`, {
        method, purpose, applicationId, callResult, notes, subject, body,
        sentVia: onDevice ? 'device' : undefined,
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
          {done.delivery === 'by-hand' && (
            <>
              <b>{method} opened on your device</b> with the message typed, and logged. Press send there if you
              haven&apos;t — the app can see that you opened it, not whether it went.
            </>
          )}
          {done.delivery === 'simulated' && (
            <>
              <b>{method} recorded — Demo / Simulated.</b> No {method} provider is connected, so nothing was
              transmitted. The message is on this candidate&apos;s Communications history exactly as written.
            </>
          )}
        </div>
        {/* Said so the recruiter knows the follow-up screen has moved, not
            just the communications history. */}
        {done.followUpsTouched > 0 && (
          <div className="small-muted" style={{ marginTop: 8 }}>
            Added to the follow-up log, and the open follow-up now shows this {method.toLowerCase()} as the last contact.
          </div>
        )}
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
            {busy ? 'Recording…' : (method === 'Call' ? 'Save call' : (onDevice ? `Open ${method} & log` : `Send ${method}`))}
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
        {!adding && (
          <button type="button" className="link-btn" style={{ marginTop: 4 }} onClick={() => { setAdding({ label: '', template: '' }); setAddError(''); }}>
            + Add a purpose to the list
          </button>
        )}
        {customOf(purpose)?.canDelete && !adding && (
          <button type="button" className="link-btn" style={{ marginTop: 4, marginLeft: 10 }} onClick={() => removePurpose(customOf(purpose))}>
            Remove “{purpose}” from the list
          </button>
        )}
        {adding && (
          <div className="card" style={{ marginTop: 6, padding: 10 }}>
            <div className="field">
              <label>New purpose</label>
              <input autoFocus value={adding.label} maxLength={80} placeholder="e.g. Salary discussion"
                onChange={(e) => setAdding({ ...adding, label: e.target.value })} />
            </div>
            <div className="field">
              <label>Message for it <span className="small-muted">(optional — {'{name}'}, {'{role}'}, {'{client}'} are filled in)</span></label>
              <textarea rows="2" value={adding.template} placeholder="Hi {name}, …"
                onChange={(e) => setAdding({ ...adding, template: e.target.value })} />
            </div>
            {addError && <div className="error-text">{addError}</div>}
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" className="btn btn-sm btn-primary" disabled={adding.label.trim().length < 2} onClick={savePurpose}>Save purpose</button>
              <button type="button" className="btn btn-sm" onClick={() => { setAdding(null); setAddError(''); }}>Cancel</button>
            </div>
            <div className="small-muted" style={{ fontSize: 11, marginTop: 4 }}>Saved for everyone who uses the Contact button.</div>
          </div>
        )}
        {!adding && addError && <div className="error-text">{addError}</div>}
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
                onClick={() => chooseMethod(m.id)}
              >
                <span aria-hidden="true">{m.icon}</span> {m.label}
              </button>
            );
          })}
        </div>
        {method && method !== 'Call' && <div className="small-muted" style={{ marginTop: 6 }}>{method === 'Email' ? email : phone}</div>}
        {/* A real link as well as the button: if the dialler did not open, or
            the call dropped, this is one tap to try again. */}
        {method === 'Call' && (
          <div className="small-muted" style={{ marginTop: 6 }}>
            Calling <a href={telHref(phone)}>{phone}</a> — not ringing? <a href={telHref(phone)}>Dial again</a>
          </div>
        )}
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
          {onDevice && (
            <div className="notice">
              This opens <b>your own {method === 'WhatsApp' ? 'WhatsApp' : 'messaging app'}</b> with the message
              typed — press send there. It is logged on the follow-up history either way; the app can see that you
              opened it, not whether it went.
            </div>
          )}
        </>
      )}

      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}
