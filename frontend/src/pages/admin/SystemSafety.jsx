import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import './SystemSafety.css';

// Administration -> System (Super Admin only). Backups of the database and the
// uploaded files, the restore test, and the uptime alert switch. Backend:
// routes/system.js, utils/backup.js, utils/uptimeAlert.js.

const mb = (b) => {
  const n = Number(b || 0);
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`;
  return `${Math.max(0.1, n / 1048576).toFixed(1)} MB`;
};
const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '');
function ago(d) {
  if (!d) return '';
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.round(h / 24)} days ago`;
}
const errText = (err, fallback) => err?.response?.data?.error || fallback;

function Chip({ tone, children }) {
  return <span className={`sys-chip sys-${tone}`}>{children}</span>;
}

export default function SystemSafety() {
  const { user } = useAuth();
  const allowed = !!(user && user.role === 'SUPER_ADMIN' && !user.viewAs);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const poll = useRef(null);

  const load = useCallback(() => api.get('/system/status')
    .then((res) => { setData(res.data); setError(''); return res.data; })
    .catch((err) => { setError(errText(err, 'Could not load System settings. Check that the server is running.')); return null; }), []);

  useEffect(() => { if (allowed) load(); }, [allowed, load]);

  // While a backup / restore test runs, look again every 3 seconds.
  useEffect(() => {
    const running = !!(data && data.backup && data.backup.running);
    if (running && !poll.current) {
      poll.current = setInterval(load, 3000);
    } else if (!running && poll.current) {
      clearInterval(poll.current);
      poll.current = null;
      const v = data && data.backup.lastVerify;
      const b = data && data.backup.lastBackup;
      if (b && !b.ok) setNote(`Backup failed: ${b.error}`);
      else if (v) setNote(v.ok ? 'Done. Backup saved and the restore test passed.' : `Restore test failed: ${(v.problems || []).join('; ')}`);
    }
    return undefined;
  }, [data, load]);
  useEffect(() => () => { if (poll.current) clearInterval(poll.current); }, []);

  const run = (url, startText) => {
    setBusy(true);
    setNote('');
    api.post(url)
      .then(() => { setNote(startText); return load(); })
      .catch((err) => setNote(errText(err, 'Could not start. Try again in a minute.')))
      .finally(() => setBusy(false));
  };

  const setAlert = (enabled) => {
    setBusy(true);
    api.put('/system/uptime-alert', { enabled })
      .then((res) => { setNote(res.data.message); return load(); })
      .catch((err) => setNote(errText(err, 'Could not save the uptime alert setting.')))
      .finally(() => setBusy(false));
  };

  if (!allowed) {
    return (
      <div className="card">
        <h1>System</h1>
        <div className="page-sub">Only a Super Admin can open System settings.</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="card sys-page">
        <h1>Backups and safety</h1>
        <div className="page-sub">{error || 'Loading…'}</div>
      </div>
    );
  }

  const b = data.backup;
  const latest = b.latest;
  const last = b.lastBackup;
  const v = b.lastVerify;
  const running = !!b.running;
  const ageH = latest ? (Date.now() - new Date(latest.at).getTime()) / 3600000 : null;

  let tone = 'green';
  let headline;
  if (running) { tone = 'blue'; headline = b.running.what === 'backup' ? 'Backing up now…' : 'Running the restore test…'; }
  else if (last && !last.ok) { tone = 'red'; headline = `The last backup failed: ${last.error}`; }
  else if (!latest) { tone = 'orange'; headline = 'No backup yet. Press "Back up now".'; }
  else if (v && v.name === latest.name && !v.ok) { tone = 'red'; headline = 'The last backup did not pass its restore test.'; }
  else if (ageH > 36) { tone = 'orange'; headline = `Last backup was ${ago(latest.at)}. A new one is late.`; }
  else headline = `Safe. Last backup ${ago(latest.at)}.`;

  const u = data.uptime;
  const check = u.check;
  const checkFresh = check && check.lastCheckAt && (Date.now() - new Date(check.lastCheckAt).getTime()) < 20 * 60000;
  const installLine = `schtasks /Create /TN "TeamLink uptime check" /SC MINUTE /MO 5 /F /TR "wscript.exe \\"${u.scriptPath}\\""`;
  const copy = () => {
    try { navigator.clipboard.writeText(installLine); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* no clipboard */ }
  };

  return (
    <div className="sys-page">
      <div className="card">
        <div className="sys-head">
          <div>
            <h1>Backups and safety</h1>
            <div className="page-sub">A copy of all TeamLink data and uploaded files, made every day.</div>
          </div>
          <button type="button" className="btn btn-primary sys-main" disabled={busy || running} onClick={() => run('/system/backup', 'Backup started. This takes about a minute.')}>
            {running ? 'Working…' : 'Back up now'}
          </button>
        </div>

        <div className={`sys-banner sys-${tone}`}>{headline}</div>
        {note && <div className="sys-note" role="status">{note}</div>}
        {data.sandbox && <div className="sys-note">This is the TEST SANDBOX. Backups here are of the test copy only, and the daily schedule is off.</div>}

        <div className="sys-facts">
          <div><span>Last backup</span><b>{latest ? when(latest.at) : 'None yet'}</b></div>
          <div><span>Size</span><b>{latest ? mb(latest.sizeBytes) : '—'}</b></div>
          <div>
            <span>Restore test</span>
            <b>
              {!v ? 'Not run yet' : (
                <Chip tone={v.ok ? 'green' : 'red'}>{v.ok ? 'Passed' : 'Failed'}</Chip>
              )}
              {v && <small> {ago(v.checkedAt)}</small>}
            </b>
          </div>
          <div><span>Daily backup</span><b>{b.schedule.enabled ? `On, after ${String(b.schedule.hour).padStart(2, '0')}:00` : (b.schedule.why || 'Off')}</b></div>
        </div>

        {v && !v.ok && (v.problems || []).length > 0 && (
          <ul className="sys-problems">{v.problems.map((p) => <li key={p}>{p}</li>)}</ul>
        )}
        {v && v.ok && v.counts && (
          <div className="sys-counts">
            The restore test opened the copy and found{' '}
            {b.keyTables.filter((t) => v.counts[t.table] != null).map((t) => `${Number(v.counts[t.table]).toLocaleString('en-IN')} ${t.label.toLowerCase()}`).join(', ')}.
          </div>
        )}

        <div className="sys-actions">
          <button type="button" className="btn" disabled={busy || running || !latest} onClick={() => run('/system/backup/verify', 'Restore test started.')}>Run restore test again</button>
        </div>
      </div>

      <div className="card">
        <h2>Saved backups</h2>
        <div className="page-sub">
          Kept: one a day for {b.keep.daily} days, then one a week for {b.keep.weekly} more weeks. Folder: <code>{b.folder}</code>
        </div>
        {b.sets.length === 0 ? (
          <div className="sys-empty">No backups saved yet.</div>
        ) : (
          <div className="sys-list">
            {b.sets.slice(0, 25).map((s) => (
              <div className="sys-row" key={s.name}>
                <div className="sys-row-main">
                  <b>{when(s.at)}</b>
                  <small>{s.reason === 'daily' ? 'Daily' : 'By hand'} · {mb(s.sizeBytes)} · {s.fileCount ? `${s.fileCount.toLocaleString('en-IN')} files` : 'no files yet'}</small>
                </div>
                {s.verify ? <Chip tone={s.verify.ok ? 'green' : 'red'}>{s.verify.ok ? 'Test passed' : 'Test failed'}</Chip> : <Chip tone="orange">Not tested</Chip>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="sys-head">
          <div>
            <h2>Alert me if the server stops</h2>
            <div className="page-sub">
              {u.settings.enabled
                ? `On. Alerts go to your bell${u.settings.email ? ` and to ${u.settings.email}` : ''}.`
                : 'Off. Nothing is sent until you turn it on.'}
            </div>
          </div>
          <button type="button" className={`btn ${u.settings.enabled ? '' : 'btn-primary'}`} disabled={busy} onClick={() => setAlert(!u.settings.enabled)}>
            {u.settings.enabled ? 'Turn off alert' : 'Turn on alert'}
          </button>
        </div>
        {!u.settings.enabled && u.myEmail && /\.(test|example|invalid|localhost)$/i.test(u.myEmail) && (
          <div className="sys-note">Your login email ({u.myEmail}) is a test address, so alerts would reach your bell only.</div>
        )}

        <div className={`sys-banner sys-${!check ? 'orange' : (check.down ? 'red' : (checkFresh ? 'green' : 'orange'))}`}>
          {!check && 'The outside check is not set up yet (see the steps below).'}
          {check && check.down && `The server stopped answering at ${when(check.down.since)}.`}
          {check && !check.down && checkFresh && `Outside check ran ${ago(check.lastCheckAt)}: the server answered.`}
          {check && !check.down && !checkFresh && `The outside check last ran ${ago(check.lastCheckAt)}. Is the scheduled task still on?`}
        </div>
        {check && check.history && check.history.length > 0 && (
          <div className="sys-counts">
            Last stops: {check.history.map((h) => `${when(h.since)} to ${when(h.upAt)}`).join(' · ')}
          </div>
        )}

        <details className="sys-howto">
          <summary>How to set up the outside check (once)</summary>
          <ol>
            <li>On the computer that runs TeamLink, open the Start menu, type <b>PowerShell</b> and open it.</li>
            <li>Paste this line and press Enter. It checks the server every 5 minutes, with no window popping up.
              <pre>{installLine}</pre>
              <button type="button" className="btn btn-sm" onClick={copy}>{copied ? 'Copied' : 'Copy the line'}</button>
            </li>
            <li>Come back here after 5 minutes. The box above should say the server answered.</li>
            <li>To remove it later: <code>schtasks /Delete /TN "TeamLink uptime check" /F</code></li>
          </ol>
          <div className="page-sub">The check runs outside TeamLink, so it still works when the server has stopped. If the server does not answer twice in a row (about 10 minutes), you get one alert, and one more when it is back.</div>
        </details>
      </div>
    </div>
  );
}
