import { useEffect, useRef, useState } from 'react';
import api from '../../api';
import { Modal } from '../proto.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import './followups.css';

// ---------------------------------------------------------------------------
// CALL · MAIL · WHATSAPP · SMS on the candidate profile — the FREE versions
// (ATS change list §15) — and every click is a follow-up, logged by itself
// (spec 2026-10-03, C1 "Auto log"):
//
//   Call       opens the phone dialler (tel:), logs the call AT ONCE with
//              "Answered", then one tap changes the outcome (Not picked …)
//   Mail       REAL: pick a template → Send → the company mail account sends
//              it → "Sent" / "Failed" (fake transport in the test sandbox)
//   WhatsApp   opens WhatsApp (wa.me) with the message ready, logs it "Sent"
//   SMS        disabled — needs an SMS account (MSG91 / Twilio, paid)
//
// Backend: POST /api/followups/quick-log (+ PATCH to change the outcome) for
// Call / WhatsApp, POST /api/candidates/:id/contact for Mail — the same
// CandidateMessage rows the Contact panel writes, so the Last contact column,
// the badges and the timeline all move. No second store.
//
//   <QuickContact candidate={{ id, name, phone, email }} applicationId role client onLogged />
// ---------------------------------------------------------------------------

function intlDigits(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return `91${d}`;
  if (d.length === 11 && d.startsWith('0')) return `91${d.slice(1)}`;
  return d;
}
const telHref = (phone) => `tel:+${intlDigits(phone)}`;
const waHref = (phone, text) => `https://wa.me/${intlDigits(phone)}?text=${encodeURIComponent(text || '')}`;

const FALLBACK_OUTCOMES = {
  Call: ['Answered', 'Interested', 'Not interested', 'Not picked', 'Busy', 'Switched off', 'Wrong number', 'Call back later'],
  WhatsApp: ['Sent', 'Replied', 'Interested', 'Not interested', 'No response'],
};
const FALLBACK_DEFAULT = { Call: 'Answered', WhatsApp: 'Sent' };

function draft(template, { name, role, client, me }) {
  const who = name ? name.split(' ')[0] : 'there';
  const what = role ? ` for the ${role} job` : '';
  const at = client ? ` at ${client}` : '';
  const sign = me ? `\n\nRegards,\n${me}\nTeamLink` : '\n\nRegards,\nTeamLink';
  switch (template) {
    case 'Interview Reminder': return `Hi ${who},\n\nA reminder about your interview${what}${at}. Please confirm you can attend.${sign}`;
    case 'Interview Confirmation': return `Hi ${who},\n\nYour interview${what}${at} is confirmed.${sign}`;
    case 'Interview Reschedule': return `Hi ${who},\n\nWe need to move your interview${what}${at}. Which time suits you?${sign}`;
    case 'Document Request': return `Hi ${who},\n\nPlease send your documents${what} so we can go ahead.${sign}`;
    case 'Joining Confirmation': return `Hi ${who},\n\nConfirming your joining${what}${at}. Please reply to confirm the date still works.${sign}`;
    case 'Offer Follow-up': return `Hi ${who},\n\nFollowing up on the offer${what}${at}. Please let us know your decision.${sign}`;
    default: return `Hi ${who},\n\nThis is about the ${role || 'job'} opening${at}. Please let me know a good time to talk.${sign}`;
  }
}

// --- one-tap outcome prompt (Call / WhatsApp) -------------------------------
function OutcomePrompt({ log, onClose }) {
  const [outcome, setOutcome] = useState(log.outcome);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(`Saved — ${log.channel === 'Call' ? 'call' : 'WhatsApp'} logged as "${log.outcome}".`);
  const [err, setErr] = useState('');
  async function pick(o) {
    if (o === outcome || busy) return;
    setBusy(true);
    setErr('');
    try {
      await api.patch(`/followups/quick-log/${log.id}`, { outcome: o });
      setOutcome(o);
      setMsg(`Saved — changed to "${o}".`);
    } catch (e) {
      setErr(e.response?.data?.error || 'Could not change it. Please try again.');
    } finally { setBusy(false); }
  }
  return (
    <Modal
      title={log.channel === 'Call' ? `How did the call with ${log.name} go?` : `WhatsApp to ${log.name}`}
      onClose={() => onClose(outcome)}
      footer={<button type="button" className="btn btn-primary" onClick={() => onClose(outcome)}>Done</button>}
    >
      {log.channel === 'Call' && log.phone && (
        <div className="small-muted">Calling <a href={telHref(log.phone)}>{log.phone}</a> — not ringing? <a href={telHref(log.phone)}>Dial again</a></div>
      )}
      {log.channel === 'WhatsApp' && <div className="small-muted">WhatsApp opened with the message ready — press send there.</div>}
      <div className="fux-outcomes" role="group" aria-label="Outcome">
        {log.outcomes.map((o) => (
          <button key={o} type="button" className={`fux-outcome${o === outcome ? ' is-on' : ''}`} disabled={busy} onClick={() => pick(o)}>{o}</button>
        ))}
      </div>
      <div className="fux-saved">{msg}</div>
      {err && <div className="fux-err">{err}</div>}
    </Modal>
  );
}

// --- Mail: template → send → Sent / Failed ----------------------------------
function MailDialog({ candidate, applicationId, role, client, onClose, onLogged }) {
  const { user } = useAuth();
  const me = user && user.name;
  const [templates, setTemplates] = useState([]);
  const [template, setTemplate] = useState('');
  const [subject, setSubject] = useState(role ? `About the ${role} job` : 'Job opening');
  const [body, setBody] = useState(() => draft('', { name: candidate.name, role, client, me }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null); // { id, status, detail }
  const timer = useRef(null);

  useEffect(() => {
    api.get('/followups/statuses').then((r) => setTemplates((r.data.templates && r.data.templates.candidate) || [])).catch(() => setTemplates([]));
    return () => clearTimeout(timer.current);
  }, []);

  function pickTemplate(t) {
    setTemplate(t);
    if (t) setSubject(t);
    setBody(draft(t, { name: candidate.name, role, client, me }));
  }

  function poll(id, tries = 0) {
    api.get(`/candidates/${candidate.id}/communications`).then((r) => {
      const row = (r.data.rows || []).find((x) => x.id === id);
      if (!row) return;
      setResult({ id, status: row.status, detail: row.statusDetail || row.lastError || '' });
      if (['QUEUED', 'RETRY'].includes(row.status) && tries < 15) timer.current = setTimeout(() => poll(id, tries + 1), 2000);
    }).catch(() => {});
  }

  async function send() {
    setErr('');
    if (!subject.trim() || !body.trim()) { setErr('Write a subject and a message first.'); return; }
    setBusy(true);
    try {
      const r = await api.post(`/candidates/${candidate.id}/contact`, {
        method: 'Email', purpose: template || 'Follow-up', subject, body, applicationId: applicationId || null,
      });
      const row = r.data.row || {};
      setResult({ id: row.id, status: row.status, detail: row.statusDetail || '' });
      if (onLogged) onLogged({ channel: 'Email' });
      if (['QUEUED', 'RETRY'].includes(row.status)) timer.current = setTimeout(() => poll(row.id), 1500);
    } catch (e) {
      setErr(e.response?.data?.error || 'Could not send the mail. Please try again.');
    } finally { setBusy(false); }
  }

  const st = result ? result.status : null;
  let statusLine = null;
  if (st === 'SENT') statusLine = <div className="fux-mail-status is-sent">✓ Sent to {candidate.email}</div>;
  else if (st === 'FAILED') statusLine = <div className="fux-mail-status is-failed">✗ Failed — {result.detail || 'the mail server refused it'}</div>;
  else if (st === 'QUEUED' || st === 'RETRY') statusLine = <div className="fux-mail-status is-wait">Sending…</div>;
  else if (st) statusLine = <div className="fux-mail-status is-failed">Not sent — company mail is not set up yet. Saved on the profile.</div>;

  return (
    <Modal
      title={`Mail ${candidate.name}`}
      onClose={onClose}
      footer={result ? (
        <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
      ) : (
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={send}>{busy ? 'Sending…' : 'Send mail'}</button>
        </>
      )}
    >
      {!result && (
        <>
          <div className="small-muted" style={{ marginBottom: 8 }}>To: {candidate.email}</div>
          <div className="field">
            <label htmlFor="fux-mail-tpl">Template</label>
            <select id="fux-mail-tpl" value={template} onChange={(e) => pickTemplate(e.target.value)}>
              <option value="">General follow-up</option>
              {templates.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="fux-mail-sub">Subject</label>
            <input id="fux-mail-sub" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="fux-mail-body">Message</label>
            <textarea id="fux-mail-body" rows="7" value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
        </>
      )}
      {statusLine}
      {result && <div className="small-muted" style={{ marginTop: 6 }}>Logged as a follow-up on this profile.</div>}
      {err && <div className="fux-err">{err}</div>}
    </Modal>
  );
}

export default function QuickContact({
  candidate, applicationId = null, role = '', client = '', onLogged, compact = false,
}) {
  const { user } = useAuth();
  const [opts, setOpts] = useState({ outcomes: FALLBACK_OUTCOMES, defaults: FALLBACK_DEFAULT });
  const [prompt, setPrompt] = useState(null);
  const [mail, setMail] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.get('/followups/quick-log/options').then((r) => setOpts({ outcomes: r.data.outcomes, defaults: r.data.defaults })).catch(() => {});
  }, []);
  if (!candidate || !candidate.id) return null;
  const { phone, email, name } = candidate;

  async function log(channel) {
    setErr('');
    try {
      const r = await api.post('/followups/quick-log', { candidateId: candidate.id, applicationId, channel });
      setPrompt({
        id: r.data.id, channel: r.data.channel, outcome: r.data.outcome, outcomes: r.data.outcomes || opts.outcomes[channel] || [], name, phone,
      });
      if (onLogged) onLogged({ channel });
    } catch (e) {
      setErr(e.response?.data?.error || 'Could not save the contact. Please try again.');
    }
  }

  // The dialler / WhatsApp must open INSIDE the click (a popup opened after an
  // await is blocked), so it opens first and the log follows.
  function call() {
    window.location.href = telHref(phone);
    log('Call');
  }
  function whatsapp() {
    const who = name ? name.split(' ')[0] : 'there';
    const text = `Hi ${who}, this is ${(user && user.name) || 'TeamLink'} from TeamLink${role ? ` about the ${role} job` : ''}${client ? ` at ${client}` : ''}. Is this a good time to talk?`;
    window.open(waHref(phone, text), '_blank', 'noopener');
    log('WhatsApp');
  }

  return (
    <div className="fux-quick-wrap">
      <div className="fux-quick">
        <button type="button" className="btn btn-sm" disabled={!phone} title={phone ? `Call ${phone}` : 'No phone number on this profile'} onClick={call}>
          <span aria-hidden="true">📞</span> Call
        </button>
        <button type="button" className="btn btn-sm" disabled={!email} title={email ? `Mail ${email}` : 'No email on this profile'} onClick={() => setMail(true)}>
          <span aria-hidden="true">✉️</span> Mail
        </button>
        <button type="button" className="btn btn-sm" disabled={!phone} title={phone ? 'Open WhatsApp with the message ready' : 'No phone number on this profile'} onClick={whatsapp}>
          <span aria-hidden="true">💬</span> WhatsApp
        </button>
        <button type="button" className="btn btn-sm fux-sms-off" disabled title="SMS needs an SMS account (MSG91 / Twilio, paid)">
          <span aria-hidden="true">✉</span> SMS
        </button>
        {!compact && <span className="fux-quick-note">SMS needs an SMS account. Every Call, Mail and WhatsApp is logged by itself.</span>}
      </div>
      {err && <div className="fux-err">{err}</div>}
      {prompt && <OutcomePrompt log={prompt} onClose={() => { setPrompt(null); if (onLogged) onLogged({ channel: prompt.channel, changed: true }); }} />}
      {mail && (
        <MailDialog
          candidate={candidate}
          applicationId={applicationId}
          role={role}
          client={client}
          onClose={() => setMail(false)}
          onLogged={onLogged}
        />
      )}
    </div>
  );
}
