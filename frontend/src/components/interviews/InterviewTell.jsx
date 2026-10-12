import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import { Modal } from '../proto.jsx';
import ContactDialog from '../messaging/ContactDialog.jsx';
import MeetingLinkButton from './MeetingLinkButton.jsx';
import './InterviewTell.css';

// ---------------------------------------------------------------------------
// "BOOKED - NOW TELL THEM" (user, 2026-10-10: after an interview is booked the window must offer
// Call, WhatsApp, SMS and Mail to the candidate - and tell the recruiter, the TL and the BDE).
//
//   Tell {candidate}     four big buttons in a row: Call · WhatsApp · SMS · Mail.
//                        Each opens the ONE contact window (messaging/ContactDialog.jsx) for that way,
//                        with the interview wording filled in (Message templates: "Interview booked" ...).
//                        Connected -> it sends from here. Not connected -> it opens your own WhatsApp /
//                        mail app, or lets you copy the words. Consent withdrawn / STOP / switch off ->
//                        the button says why. A BDE never sees the number: TeamLink sends it for them.
//   MAIN BUTTON          "Send on all available channels": Mail + WhatsApp + SMS wherever connected;
//                        what could not go is listed with what to do instead.
//   Tell the team        Recruiter, Team lead, Client manager (BDE), Interviewer: who is already told,
//                        "Notify" per person or "Notify all" (bell + mail).
//
// Used after BOOKING (kind 'scheduled'), after RESCHEDULE ('rescheduled') and after CANCEL ('cancelled').
// The server (routes/interviewTell.js) decides what each login may do; nothing here is security.
// ---------------------------------------------------------------------------
const TITLE = {
  scheduled: 'Booked — now tell them',
  rescheduled: 'Rescheduled — now tell them',
  cancelled: 'Cancelled — now tell them',
};
const BUTTONS = [
  ['Call', 'Call', '📞'],
  ['WhatsApp', 'WhatsApp', '🟢'],
  ['SMS', 'SMS', '💬'],
  ['Email', 'Mail', '✉️'],
];
const firstName = (n) => String(n || '').replace(/^ZZTEST\S*\s*/i, '').split(/\s+/)[0] || 'them';
const hhmm = (d) => (d ? new Date(d).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }) : '');
const TONE = (t) => (t.failed ? 'red' : (t.told ? 'green' : 'orange'));

// A short, plain line under a button: what pressing it will do.
function sub(ch, st, cand) {
  if (!st) return '';
  if (st.state === 'none') return ch === 'Email' ? 'No email on file' : 'No number on file';
  if (st.state === 'blocked') return 'Cannot send';
  if (ch === 'Call') {
    if (cand.masked) return st.state === 'send' ? 'Through TeamLink' : 'Ask the recruiter';
    return 'Shows the number';
  }
  if (st.state === 'send') return 'Sends from here';
  if (cand.masked) return 'Ask the recruiter';
  if (ch === 'WhatsApp') return 'Opens your phone';
  if (ch === 'Email') return 'Opens your mail';
  return 'Copy the words';
}

export default function InterviewTell({
  applicationId, kind = 'scheduled', saved = '', note = '', canMakeLink = false, extra = null, onClose,
}) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [dlg, setDlg] = useState(null); // 'Call' | 'WhatsApp' | 'SMS' | 'Email'
  const [all, setAll] = useState(null); // result of "send on all channels"
  const [busy, setBusy] = useState('');
  const [team, setTeam] = useState({}); // party key -> result
  const [teamErr, setTeamErr] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => api.get(`/ats/interviews/${applicationId}/tell`, { params: { kind } })
    .then((r) => { setData(r.data); setErr(''); })
    .catch((e) => setErr(e.response?.data?.error || 'Could not open this window. Please try again.')), [applicationId, kind]);
  useEffect(() => { load(); }, [load]);

  async function sendAll(again = false) {
    setBusy('all'); setAll(null);
    try {
      const r = await api.post(`/ats/interviews/${applicationId}/tell/send-all`, { kind, again });
      setAll(r.data);
    } catch (e) { setAll({ error: e.response?.data?.error || 'Nothing could be sent. Please try again.' }); } finally { setBusy(''); load(); }
  }
  async function notify(who) {
    setBusy(Array.isArray(who) ? who[0] : 'team'); setTeamErr('');
    try {
      const r = await api.post(`/ats/interviews/${applicationId}/tell/notify`, { kind, who });
      const m = {};
      r.data.results.forEach((x) => { m[x.key] = x; });
      setTeam((t) => ({ ...t, ...m }));
    } catch (e) { setTeamErr(e.response?.data?.error || 'Could not tell them. Please try again.'); } finally { setBusy(''); load(); }
  }
  async function copyText() {
    const t = data && data.candidate && data.candidate.preview ? data.candidate.preview.text : '';
    try { await navigator.clipboard.writeText(t); setCopied(true); } catch { setCopied(false); }
    try { await api.post(`/ats/interviews/${applicationId}/tell/copied`, { kind, channel: 'WhatsApp' }); load(); } catch { /* the copy still worked */ }
  }
  async function finish() {
    try { await api.post(`/ats/interviews/${applicationId}/tell/done`, { kind }); } catch { /* closing must never fail */ }
    onClose();
  }

  const footer = <button type="button" className="btn" onClick={finish}>Done</button>;
  if (err && !data) {
    return <Modal title={TITLE[kind]} onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}><div className="msg-box red">{err}</div></Modal>;
  }
  if (!data) {
    return <Modal title={TITLE[kind]} onClose={onClose} footer={footer}><div className="ivt-load">Getting everything ready…</div></Modal>;
  }

  const c = data.candidate;
  const name = firstName(c.name);
  const iv = data.interview;
  const sendable = Object.entries(c.channels).filter(([ch, s]) => ch !== 'Call' && s.state === 'send');
  const toldBy = (ch) => (c.told || []).find((t) => t.channel === ch);
  const blocked = Object.entries(c.channels).filter(([, s]) => s.state === 'blocked' && s.reason);
  const allBlocked = blocked.length === 4 || c.doNotContact;
  const openOne = (ch) => setDlg(ch);
  const verb = { scheduled: 'is booked', rescheduled: 'has a new time', cancelled: 'is cancelled' }[kind];

  return (
    <>
      <Modal title={TITLE[kind]} onClose={finish} footer={footer}>
        <div className="ivt">
          {saved && <div className="ivt-ok" role="status">{saved}</div>}
          {note && <div className="ivt-note">{note}</div>}
          <div className="ivt-when">
            <b>{iv.candidateName}</b> · Round {iv.round} · {iv.when}
            <span>{iv.mode === 'In Person' ? ` · ${iv.location || 'In person'}` : ' · Online'}</span>
          </div>
          {kind === 'scheduled' && canMakeLink && iv.mode === 'Online' && !iv.meetingLink && <MeetingLinkButton applicationId={applicationId} onMade={load} />}
          {extra}

          <h4 className="ivt-h">Tell {name} <small>(the interview {verb})</small></h4>
          {!c.allowed ? (
            <div className="msg-box orange"><b>You cannot contact {name} from here.</b> {c.reason}</div>
          ) : (
            <>
              {c.masked && <div className="msg-box blue ivt-mask">{name}&apos;s number and email stay hidden from you{c.phoneHint ? ` (${c.phoneHint})` : ''}. TeamLink sends the message for you.</div>}
              <div className="ivt-btns" role="group" aria-label={`Tell ${name}`}>
                {BUTTONS.map(([ch, label, icon]) => {
                  const st = c.channels[ch] || { state: 'none' };
                  const t = toldBy(ch);
                  const dead = st.state === 'none' || (st.state === 'blocked' && allBlocked) || c.doNotContact;
                  return (
                    <button key={ch} type="button" className={`ivt-btn${t && t.told ? ' is-done' : ''}${dead ? ' is-off' : ''}`} disabled={dead} onClick={() => openOne(ch)}>
                      <span className="ivt-ic" aria-hidden="true">{icon}</span>
                      <b>{label}</b>
                      <small>{sub(ch, st, c)}</small>
                      {t && <em className={`ivt-chip ${TONE(t)}`}>{t.word}{t.at ? ` ${hhmm(t.at)}` : ''}</em>}
                    </button>
                  );
                })}
              </div>
              {c.doNotContact && <div className="msg-box red"><b>{name} asked not to be contacted.</b> Nothing can be sent. If they say yes again, record it on the Consent card first.</div>}
              {!c.doNotContact && blocked.map(([ch, s]) => <div key={ch} className="msg-box orange ivt-why"><b>{ch === 'Email' ? 'Mail' : ch}:</b> {s.reason}</div>)}
              {!c.doNotContact && !c.switchOn && !blocked.some(([, s]) => /Candidate emails/.test(s.reason || '')) && <div className="small-muted ivt-sw">Company candidate emails are switched off, so automatic reminders are held.</div>}

              {c.alreadyTold && <div className="msg-box green ivt-told"><b>{name} has already been told</b> ({(c.told || []).filter((t) => t.told).map((t) => `${t.channel === 'Email' ? 'Mail' : t.channel}: ${t.word}`).join(' · ')}). You can still send again from a button.</div>}

              <div className="ivt-main">
                <button type="button" className="btn btn-primary" disabled={busy === 'all' || (!sendable.length && !all)} onClick={() => sendAll(false)}>
                  {busy === 'all' ? 'Sending…' : 'Send on all available channels'}
                </button>
                <span className="small-muted">{sendable.length ? `${sendable.map(([ch]) => (ch === 'Email' ? 'Mail' : ch)).join(' + ')} go from here.` : 'Nothing is connected to send from here: use a button above (it opens your own app).'}</span>
              </div>
              {all && all.error && <div className="msg-box red">{all.error}</div>}
              {all && all.attempts && (
                <div className="ivt-all" role="status">
                  {all.attempts.map((a) => (
                    <div key={a.channel} className={`ivt-row ${a.status === 'sent' || a.status === 'sending' ? 'green' : (a.status === 'already' ? 'blue' : 'orange')}`}>
                      <b>{a.channel === 'Email' ? 'Mail' : a.channel}</b>
                      <span>{a.status === 'sent' ? `Sent${a.sandbox ? ' (test copy: nothing really left)' : ''}` : a.status === 'sending' ? 'On its way' : a.status === 'already' ? a.reason : `Not sent: ${a.reason || a.status}`}</span>
                    </div>
                  ))}
                  {all.fallbacks && all.fallbacks.map((f) => <div key={f.channel} className="small-muted ivt-fb">{f.channel === 'Email' ? 'Mail' : f.channel}: {f.how}</div>)}
                  {all.nothingSent && !c.masked && <button type="button" className="btn btn-sm" onClick={copyText}>{copied ? 'Copied' : 'Copy the message'}</button>}
                </div>
              )}
              {c.preview && (
                <div className="ivt-pv">
                  <div className="small-muted">What {name} gets (to change the words, press a button above):</div>
                  <div className="msg-preview">{c.preview.text}</div>
                </div>
              )}
            </>
          )}

          <h4 className="ivt-h">Tell the team</h4>
          <div className="ivt-team">
            {data.parties.map((p) => {
              const r = team[p.key];
              return (
                <div key={p.key} className="ivt-party">
                  <span className="ivt-who">
                    <b>{p.name.replace(/^ZZTEST\S*\s*/i, '')}</b>
                    <small>{p.roleLine}{p.you ? ' · you' : ''}</small>
                  </span>
                  <span className="ivt-st">
                    {r ? (
                      <em className={`ivt-chip ${r.skipped ? 'blue' : 'green'}`}>{r.skipped || `Told${r.bell ? ' (app)' : ''}${r.email && r.email.ok ? ' + mail' : ''}`}</em>
                    ) : p.notified ? <em className="ivt-chip green">{p.notified.how}</em> : <em className="ivt-chip orange">Not told yet</em>}
                    {r && r.email && !r.email.ok && r.email.reason && <small className="ivt-small">Mail: {r.email.reason}</small>}
                  </span>
                  {data.canNotify && !p.you && <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => notify([p.key])}>{busy === p.key ? 'Telling…' : 'Notify'}</button>}
                </div>
              );
            })}
            {data.parties.length === 0 && <div className="small-muted">Nobody else is named on this job yet.</div>}
          </div>
          {teamErr && <div className="msg-box red">{teamErr}</div>}
          {data.canNotify && data.parties.filter((p) => !p.you).length > 1 && (
            <button type="button" className="btn ivt-all-btn" disabled={!!busy} onClick={() => notify('all')}>{busy === 'team' ? 'Telling…' : 'Notify all'}</button>
          )}
          {!data.canNotify && <div className="small-muted">Your role can look, but it cannot send the team notice.</div>}
        </div>
      </Modal>
      {dlg && (
        <ContactDialog
          channel={dlg}
          audience="candidates"
          personId={c.id}
          name={iv.candidateName}
          email={c.masked ? undefined : c.email}
          phone={c.masked ? undefined : c.phone}
          applicationId={applicationId}
          purposeLabel={data.purposeLabel}
          onClose={() => { setDlg(null); load(); }}
          onLogged={() => load()}
        />
      )}
    </>
  );
}
