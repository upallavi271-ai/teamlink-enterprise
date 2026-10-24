// ---------------------------------------------------------------------------
// GOOGLE MEET LINK, INTERVIEW E-MAIL STATUS, START INTERVIEW (2026-10-14).
// Server side: backend/src/utils/interviewMeet.js, routes/interviewMeet.js. Setup notes: docs/INTERVIEW-MEET.md
//
//   <MeetLinkField>        Book dialog: "Create a Meet link" (opens meet.google.com/new), a paste box, and one click on
//                          the company's standing link. Checks the link as you type.
//   <StartInterviewButton> the one blue button on an interview: opens the Meet link in a new tab and marks it started
//   <InterviewMailStatus>  who was e-mailed and what happened, a Resend button per person
//   <MeetSettings>         Admin: the e-mail switches, the standing link, the Start window
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../../api';
import { Modal } from '../proto.jsx';
import './meetStart.css';

const MEET_RE = /^https:\/\/meet\.google\.com\/(?:[a-z]{3}-[a-z]{4}-[a-z]{3}|lookup\/[A-Za-z0-9_-]{4,40})(?:\?\S*)?$/i;
export function linkCheck(raw) {
  const v = String(raw || '').trim();
  if (!v) return { state: 'empty' };
  if (MEET_RE.test(v)) return { state: 'ok', text: 'Google Meet link looks good.' };
  if (!/^https:\/\//i.test(v)) return { state: 'bad', text: 'The link should start with https://' };
  if (/meet\.google\.com/i.test(v)) return { state: 'bad', text: 'This Meet link looks incomplete. It looks like https://meet.google.com/abc-defg-hij' };
  if (/\s/.test(v)) return { state: 'bad', text: 'Paste only the link, without spaces.' };
  return { state: 'warn', text: 'This is not a Google Meet link. It will be used as it is. Check that it opens.' };
}
const openNew = (url) => window.open(url, '_blank', 'noopener,noreferrer');

// ---- the booking dialog's link field ---------------------------------------------------------------------------------------
export function MeetLinkField({ value, onChange }) {
  const [standing, setStanding] = useState('');
  useEffect(() => {
    api.get('/ats/interview-meet/settings').then((r) => setStanding((r.data.settings && r.data.settings.defaultMeetLink) || '')).catch(() => setStanding(''));
  }, []);
  const chk = linkCheck(value);
  return (
    <div className="ims-field">
      <div className="ims-row">
        <button type="button" className="btn btn-sm" onClick={() => openNew('https://meet.google.com/new')}>Create a Meet link</button>
        {standing && <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange(standing)}>Use our standing Meet link</button>}
      </div>
      <input type="url" aria-label="Google Meet link" placeholder="Paste the link here (https://meet.google.com/abc-defg-hij)" value={value} onChange={(e) => onChange(e.target.value)} />
      {chk.state !== 'empty' && <div className={`ims-chk is-${chk.state}`} role="status">{chk.text}</div>}
      <div className="ims-hint">Press "Create a Meet link": Google Meet opens in a new tab. Copy its link and paste it here. You can also add it later.</div>
    </div>
  );
}

// ---- Start interview ---------------------------------------------------------------------------------------------------------
function LinkDialog({ row, onClose, onSaved }) {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const chk = linkCheck(v);
  async function save() {
    setBusy(true); setErr('');
    try {
      const r = await api.put(`/ats/interviews/${row.id}/meet-link`, { meetingLink: v.trim() });
      onSaved(r.data);
    } catch (e) { setErr(e.response?.data?.error || 'Could not save the link. Please try again.'); } finally { setBusy(false); }
  }
  return (
    <Modal title="Add the Meet link" onClose={onClose} footer={<button type="button" className="btn btn-primary" disabled={busy || !v.trim() || chk.state === 'bad'} onClick={save}>{busy ? 'Saving…' : 'Save link'}</button>}>
      <MeetLinkField value={v} onChange={setV} />
      <div className="ims-hint">Everyone on this interview gets the updated invite by e-mail.</div>
      {err && <div className="error-text" style={{ marginTop: 8 }}>{err}</div>}
    </Modal>
  );
}

export function StartInterviewButton({ row, onChanged, onMessage }) {
  const s = row && row.start;
  const [dlg, setDlg] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  if (!s || !s.show) return null;
  const say = (m, bad = false) => { setNote(m); if (onMessage) onMessage(m, bad); };

  async function run(link) {
    setBusy(true); setNote('');
    try {
      // the new tab is opened inside the click itself, so the browser does not block it
      if (link) openNew(link);
      const r = await api.post(`/ats/interviews/${row.id}/start`);
      say(r.data.message);
      if (onChanged) onChanged();
    } catch (e) {
      const d = e.response?.data || {};
      if (d.needsLink) setDlg(true); else say(d.error || 'Could not start the interview. Please try again.', true);
    } finally { setBusy(false); }
  }
  function click() {
    if (!s.can) return;
    if (s.needsLink) { setDlg(true); return; }
    run(s.online ? row.meetingLink : null);
  }
  const disabled = !s.can || busy;
  return (
    <span className="ims-start">
      <button type="button" className="btn btn-sm btn-primary" disabled={disabled} title={s.reason || ''} onClick={click}>
        {busy ? 'Starting…' : s.label}
      </button>
      {s.reason && <span className="ims-why">{s.reason}</span>}
      {note && <span className="ims-why">{note}</span>}
      {dlg && (
        <LinkDialog
          row={row}
          onClose={() => setDlg(false)}
          onSaved={(d) => { setDlg(false); if (onChanged) onChanged(); say(d.message || 'Meet link saved.'); }}
        />
      )}
    </span>
  );
}

// ---- e-mail status per person -------------------------------------------------------------------------------------------------
export function InterviewMailStatus({ applicationId, reloadKey = 0 }) {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api.get(`/ats/interviews/${applicationId}/mail`).then((r) => setD(r.data)).catch(() => setD({ rows: [], err: true }));
  useEffect(() => { setD(null); load(); }, [applicationId, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  async function resend(key) {
    setBusy(key || 'all'); setMsg('');
    try {
      const r = await api.post(`/ats/interviews/${applicationId}/mail/resend`, key ? { key } : {});
      setMsg(r.data.message || 'Done.');
      await load();
    } catch (e) { setMsg(e.response?.data?.error || 'Could not send. Please try again.'); } finally { setBusy(''); }
  }
  if (!d) return <div className="ims-hint">Loading e-mail status…</div>;
  if (d.err) return null;
  if (!d.rows.length) return <div className="ims-hint">No interview e-mail has been sent yet.</div>;
  const anyBad = d.rows.some((x) => x.status === 'not_sent');
  return (
    <div className="ims-mail">
      <div className="small-muted" style={{ marginBottom: 4 }}>E-mail with calendar invite</div>
      <ul>
        {d.rows.map((x) => (
          <li key={x.key} className={`is-${x.status}`}>
            <span className="ims-who"><b>{x.name || x.role}</b> <span className="ims-role">{x.role}</span></span>
            <span className="ims-res">
              {x.status === 'sent' ? 'Email sent' : x.status === 'off' ? `Email not sent: ${x.detail}` : `Email not sent: ${x.detail}`}
              {x.toMasked ? ` (${x.toMasked})` : ''}
            </span>
            {d.canResend && x.status !== 'off' && (
              <button type="button" className="btn btn-sm btn-ghost" disabled={!!busy} onClick={() => resend(x.key)}>{busy === x.key ? 'Sending…' : 'Resend'}</button>
            )}
          </li>
        ))}
      </ul>
      {d.canResend && anyBad && <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => resend(null)}>{busy === 'all' ? 'Sending…' : 'Resend to everyone not reached'}</button>}
      {msg && <div className="ims-hint" role="status">{msg}</div>}
    </div>
  );
}

// ---- Admin settings ------------------------------------------------------------------------------------------------------------
export function MeetSettings({ onMessage }) {
  const [d, setD] = useState(null);
  const [link, setLink] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    api.get('/ats/interview-meet/settings').then((r) => { setD(r.data); setLink(r.data.settings.defaultMeetLink || ''); }).catch(() => setD(null));
  }, []);
  if (!d || !d.canEdit) return null;
  async function put(patch) {
    try {
      const r = await api.put('/ats/interview-meet/settings', patch);
      setD({ ...d, settings: r.data.settings });
      if (onMessage) onMessage('Saved.');
    } catch (e) { if (onMessage) onMessage(e.response?.data?.error || 'Could not save. Please try again.', true); }
  }
  const s = d.settings;
  const Sw = ({ k, label, hint }) => (
    <label className="ims-sw" title={hint}>
      <input type="checkbox" checked={!!s[k]} onChange={(e) => put({ [k]: e.target.checked })} />
      <span>{label}</span>
    </label>
  );
  return (
    <div className="ivx-admin ims-settings">
      <span>
        {'Interview e-mails and Meet: '}
        <b>{d.mailReady ? 'mail is set up' : 'mail is not set up'}</b>
        {!d.mailReady && ' (Administration > Integrations > Email)'}
      </span>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Change'}</button>
      {open && (
        <div className="ims-panel">
          <Sw k="emailCandidate" label="Email the candidate when an interview is booked" />
          <Sw k="emailInterviewer" label="Email the interviewer" />
          <Sw k="emailChanges" label="Email on reschedule or cancel" />
          <Sw k="copyTeam" label="Send a copy to the person who booked, the team lead and the client manager (BDE)" />
          <Sw k="calendarAutoLink" label={`Make the Meet link automatically (Google Calendar${d.calendarReady ? '' : ' is not connected yet: Integrations > Calendar Sync'})`} hint="Only works when Google Calendar is connected. Nothing is called without it." />
          <div className="ims-row">
            <input type="url" aria-label="Standing Meet link" placeholder="Our standing Meet link (optional)" value={link} onChange={(e) => setLink(e.target.value)} />
            <button type="button" className="btn btn-sm" onClick={() => put({ defaultMeetLink: link.trim() })}>Save link</button>
          </div>
          <div className="ims-row">
            <label>Start opens (minutes before) <input type="number" min="0" max="240" defaultValue={s.startBeforeMin} onBlur={(e) => put({ startBeforeMin: e.target.value })} /></label>
            <label>and stays open (minutes after) <input type="number" min="15" max="720" defaultValue={s.startAfterMin} onBlur={(e) => put({ startAfterMin: e.target.value })} /></label>
          </div>
        </div>
      )}
    </div>
  );
}
