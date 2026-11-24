import { useCallback, useEffect, useState } from 'react';
import api from '../../api';

// ---------------------------------------------------------------------------
// INTERVIEW AI (ATS wave 2 Y, 07.11) inside Interview tools > Recordings & notes:
//   KitMapY     the notes' lines per kit question of the round, and "Copy to my scorecard" (my notes; a suggested rating only if I tick it)
//   NotetakerY  send the notetaker bot to the interview's meeting link (needs the provider key and the Admin switch), its state, stop
// ---------------------------------------------------------------------------
const errOf = (e) => (e && e.response && e.response.data && e.response.data.error) || 'That did not work. Please try again.';
const when = (v) => (v ? new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-');

export function KitMapY({ r }) {
  const [msg, setMsg] = useState(''); const [err, setErr] = useState(''); const [ratings, setRatings] = useState(false); const [busy, setBusy] = useState(false);
  const rows = (r.notes && r.notes.byQuestion) || [];
  if (!rows.length) return null;
  const copy = async () => {
    setBusy(true); setErr(''); setMsg('');
    try { await api.post(`/ats/mkt/recordings/${r.id}/notes/apply`, { ratings }); setMsg('Copied onto your scorecard for this round. Check it on the Scorecard tab.'); } catch (e) { setErr(errOf(e)); }
    setBusy(false);
  };
  return (
    <div className="ivt-notes" data-testid="atsy-kitmap">
      <div className="small-muted">Scorecard questions · {r.notes.byQuestionSource}</div>
      <ul>
        {rows.map((q) => (
          <li key={q.i}><b>{q.q}</b>{q.suggestedRating ? <span className="small-muted"> (suggested {q.suggestedRating})</span> : null}
            <div className={q.covered ? '' : 'small-muted'}>{q.evidence || 'Not covered in the recording.'}</div></li>
        ))}
      </ul>
      <div className="ivt-row">
        {rows.some((q) => q.suggestedRating) && <label className="small-muted"><input type="checkbox" checked={ratings} onChange={(e) => setRatings(e.target.checked)} /> also use the suggested ratings where I have none</label>}
        <button type="button" className="btn btn-sm" disabled={busy} onClick={copy}>Copy to my scorecard</button>
      </div>
      {msg && <div className="notice">{msg}</div>}{err && <div className="error-text">{err}</div>}
    </div>
  );
}

export function NotetakerY({ applicationId, round, onDone }) {
  const [d, setD] = useState(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [link, setLink] = useState(''); const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get(`/ats/y/interviews/${applicationId}/notetaker`).then((r) => { setD(r.data); setLink((l) => l || r.data.meetingLink || ''); }).catch((e) => setErr(errOf(e))), [applicationId]);
  useEffect(() => { load(); }, [load]);
  if (!d) return err ? <div className="small-muted">{err}</div> : null;
  const run = async (fn, ok) => { setBusy(true); setErr(''); setMsg(''); try { const r = await fn(); if (ok) setMsg(typeof ok === 'function' ? ok(r) : ok); await load(); if (onDone) onDone(); } catch (e) { setErr(errOf(e)); } setBusy(false); };
  const open = d.bots.find((b) => ['scheduled', 'joining', 'in call'].includes(b.status) && b.round === (round || 1));
  return (
    <div className="ivt-recrow" data-testid="atsy-notetaker">
      <div className="ivt-row"><b>AI notetaker (joins the meeting)</b>
        <span className="small-muted">{!d.switchOn ? 'Switched off (an Admin turns it on in AI governance > Sourcing & AI connectors).' : (!d.ready ? (d.hint || 'Needs the meeting-bot provider key (Administration > Integrations).') : `Provider: ${d.provider || 'set up'}`)}</span>
      </div>
      {d.canSend && !open && (
        <div className="ivt-row">
          <input type="url" placeholder="Meeting link (Meet / Zoom / Teams)" value={link} onChange={(e) => setLink(e.target.value)} aria-label="Meeting link" />
          <button type="button" className="btn btn-sm" disabled={busy || !link || !d.switchOn || !d.ready} onClick={() => run(() => api.post(`/ats/y/interviews/${applicationId}/notetaker`, { meetingUrl: link, round }), (r) => (r.data.bot.status === 'scheduled' ? 'The notetaker will join a minute before the interview.' : 'The notetaker is on its way to the meeting.'))}>Send the notetaker</button>
        </div>
      )}
      <div className="small-muted">Tell the candidate the interview is recorded: the bot shows in the meeting by its name. When the call ends its transcript becomes a recording of this round with notes.</div>
      {d.bots.map((b) => (
        <div key={b.id} className="ivt-row small-muted">
          <span>Round {b.round} · <b>{b.status}</b> · {b.statusText || ''} · {when(b.updatedAt)}</span>
          {['scheduled', 'joining', 'in call'].includes(b.status) && <>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => run(() => api.post(`/ats/y/notetaker/${b.id}/refresh`), 'Checked.')}>Check now</button>
            {d.canSend && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => run(() => api.post(`/ats/y/notetaker/${b.id}/stop`), 'Stopped.')}>Stop</button>}
          </>}
        </div>
      ))}
      {msg && <div className="notice">{msg}</div>}{err && <div className="error-text">{err}</div>}
    </div>
  );
}
