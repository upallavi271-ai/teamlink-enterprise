import { useEffect, useState } from 'react';
import api from '../../api';
import StatusChip from '../../components/ui/StatusChip.jsx';

// ---------------------------------------------------------------------------
// Administration -> Step timing -> "Client updates, interview pop-ups and auto-screening" (Super Admin / Admin).
//   per client event type   pop-up ON/OFF and mail ON/OFF - both ON by default (the founder asked for them)
//   digest                  several updates within N minutes go as ONE mail (15 by default; 0 = every update its own mail)
//   interviews              "Your interviews today" pop-up, the 15-minute pop-up, the morning mail (time) and the mail 60 minutes before
//   auto-screening          the default for jobs that have no setting of their own (OFF by default; each job's TL decides on the job)
// Each person can mute their own mails in Profile. Server: routes/atsUpdates.js /settings and /screen/settings.
// ---------------------------------------------------------------------------
const errOf = (e) => (e && e.response && e.response.data && e.response.data.error) || 'Could not save. Try again.';

export default function ClientUpdateSettings() {
  const [d, setD] = useState(null);
  const [form, setForm] = useState(null);
  const [scr, setScr] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get('/ats-updates/settings').then((r) => { setD(r.data); setForm(JSON.parse(JSON.stringify(r.data.settings))); }).catch(() => setD(null));
    api.get('/ats-updates/screen/settings').then((r) => setScr(r.data)).catch(() => setScr(null));
  }, []);
  if (!d || !form) return null;
  const flip = (k, w) => setForm((f) => ({ ...f, types: { ...f.types, [k]: { ...f.types[k], [w]: !f.types[k][w] } } }));
  const iv = (patch) => setForm((f) => ({ ...f, interviews: { ...f.interviews, ...patch } }));
  async function save() {
    setBusy(true); setMsg(''); setErr('');
    try {
      const r = await api.put('/ats-updates/settings', form);
      setForm(JSON.parse(JSON.stringify(r.data.settings)));
      if (scr && scr.canEdit) setScr({ ...scr, ...(await api.put('/ats-updates/screen/settings', { defaultOn: !!scr.defaultOn })).data });
      setMsg('Saved.');
    } catch (e) { setErr(errOf(e)); } finally { setBusy(false); }
  }
  const allOn = Object.values(form.types).every((t) => t.popup && t.mail);
  return (
    <div className="panel" data-testid="client-update-settings">
      <div className="panel-head">
        <h3>Client updates, interview pop-ups and auto-screening</h3>
        {allOn ? <StatusChip status="Pop-ups and mails are on" tone="green" /> : <StatusChip status="Some are off" tone="yellow" />}
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
      <div style={{ padding: '8px 18px 14px' }}>
        <div className="small-muted" style={{ marginBottom: 8 }}>
          When a client does something, everyone concerned is told: the client&apos;s BDE and the BDE TL, the job&apos;s TL and recruiters,
          the candidate&apos;s recruiter, and the Admins. Each person only hears about what they may open; candidate phone, e-mail and salary are never in it.
        </div>
        <div className="tbl-wrap" style={{ border: 0 }}>
          <table className="ah-tbl" style={{ width: '100%' }}>
            <thead><tr><th style={{ textAlign: 'left' }}>What the client did</th><th>Pop-up</th><th>Mail</th></tr></thead>
            <tbody>
              {Object.entries(d.types).map(([k, t]) => (
                <tr key={k}>
                  <td style={{ padding: '6px 8px 6px 0' }}><b>{t.label}</b><div className="small-muted">{t.hint}</div></td>
                  <td style={{ textAlign: 'center' }}><input type="checkbox" aria-label={`${t.label}: pop-up`} checked={!!form.types[k].popup} onChange={() => flip(k, 'popup')} /></td>
                  <td style={{ textAlign: 'center' }}><input type="checkbox" aria-label={`${t.label}: mail`} checked={!!form.types[k].mail} onChange={() => flip(k, 'mail')} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ margin: '10px 0' }}>
          Updates that come within{' '}
          <input type="number" min={0} max={240} style={{ width: 64 }} aria-label="Digest minutes" value={form.digestMinutes} onChange={(e) => setForm({ ...form, digestMinutes: Number(e.target.value) })} />
          {' '}minutes of a mail go together in one mail (0 = every update its own mail).
        </p>
        <h4 style={{ margin: '14px 0 6px' }}>Interviews</h4>
        <label className="mkt-switch" style={{ display: 'block' }}><input type="checkbox" checked={!!form.interviews.todayPopup} onChange={(e) => iv({ todayPopup: e.target.checked })} /> &quot;Your interviews today&quot; pops up once a day after sign-in</label>
        <label className="mkt-switch" style={{ display: 'block' }}><input type="checkbox" checked={form.interviews.min15Popup !== false} onChange={(e) => iv({ min15Popup: e.target.checked })} /> A pop-up 15 minutes before (the 60-minute one is in Interview reminders above)</label>
        <label className="mkt-switch" style={{ display: 'block' }}>
          <input type="checkbox" checked={!!form.interviews.morningMail} onChange={(e) => iv({ morningMail: e.target.checked })} /> A morning mail with the day&apos;s interviews at{' '}
          <input type="time" aria-label="Morning mail time" value={form.interviews.morningAt} onChange={(e) => iv({ morningAt: e.target.value })} /> (India time)
        </label>
        <label className="mkt-switch" style={{ display: 'block' }}><input type="checkbox" checked={!!form.interviews.hourMail} onChange={(e) => iv({ hourMail: e.target.checked })} /> A mail 60 minutes before each interview</label>
        <div className="small-muted">These two mails go to the recruiter, TL, BDE and panel while the interview reminder plan does not mail the team itself (never twice).</div>
        {scr && (
          <>
            <h4 style={{ margin: '14px 0 6px' }}>Automatic screening</h4>
            <label className="mkt-switch" style={{ display: 'block' }}>
              <input type="checkbox" disabled={!scr.canEdit} checked={!!scr.defaultOn} onChange={(e) => setScr({ ...scr, defaultOn: e.target.checked })} /> Auto-screen new applications on jobs that have no setting of their own
            </label>
            <div className="small-muted">Off by default. Each job&apos;s TL can switch it on in the job&apos;s Kits &amp; tests tab. It only suggests Pass / Review / Not suitable; it moves or holds a person only when the TL ticks &quot;Act on the result&quot; for that job, and never rejects unless the auto-reject rule (AI governance) is on.</div>
          </>
        )}
        {msg && <div className="notice">{msg}</div>}
        {err && <div className="notice red">{err}</div>}
      </div>
    </div>
  );
}
