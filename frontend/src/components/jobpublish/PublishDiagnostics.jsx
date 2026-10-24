import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import JpModal from './JpModal.jsx';
import NeedsHelp from './NeedsHelp.jsx';
import { ScreenshotButton } from './PostingLogs.jsx';
import { PortalChip, QueueChip } from './PublishChips.jsx';
import {
  fileSize, jp, jpError, isNotMigrated, NOT_ON_WORDS, useVisiblePoll, when, dur,
} from './jpKit.js';
import './jobpublish.css';

// ---------------------------------------------------------------------------
// PUBLISH HEALTH (diagnostics). One card per site:
//   health + the plain list of what is wrong  ·  login test result, switch, session age, page settings (verified or not)
//   why jobs failed, in groups (sign-in, OTP, CAPTCHA, page changed, site refused the job, site down, held back)
//   selector status per step (works / drift / broken / not tried)  ·  the last attempts with their pictures and a Retry button
// Backend: GET /api/job-publish/diagnostics, /diagnostics/attempts/:id. Nothing here posts by itself.
// props: canPost (may press Retry / type an OTP)
// ---------------------------------------------------------------------------
const HEALTH_TONE = { OK: ['Looks fine', 'green', '✔'], ATTENTION: ['Needs attention', 'yellow', '!'], BROKEN: ['Broken', 'red', '✖'] };
const ICON = { green: '✔', blue: '⟳', yellow: '!', red: '✖', grey: '○' };
const ACTION_WORDS = { PUBLISH: 'Post', REPUBLISH: 'Post again', UNPUBLISH: 'Take down', UPDATE: 'Update', VERIFY: 'Login check' };

function Attempt({ id, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { jp.get(`/diagnostics/attempts/${id}`).then(setD).catch((e) => setErr(jpError(e, 'Could not open this attempt.'))); }, [id]);
  return (
    <JpModal title="One attempt, step by step" size="is-wide" onClose={onClose} foot={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      {err && <div className="jp-err" role="alert">{err}</div>}
      {!d && !err && <div className="jp-note" role="status">Loading...</div>}
      {d && (
        <div className="jp-wrap">
          <div className="jp-row">
            <b>{ACTION_WORDS[d.entry.action] || d.entry.action}{d.entry.dryRun ? ' (check only)' : ''}</b>
            <QueueChip status={d.entry.status} dryRun={d.entry.dryRun} />
            {d.job && <Link to={`/requirements/${d.job.id}`}>{d.job.reqCode ? `${d.job.reqCode} ` : ''}{d.job.title}</Link>}
            <span className="jp-note">tries {d.entry.attempts}/{d.entry.maxAttempts}</span>
          </div>
          {d.entry.errorMessage && <div className="jp-note">{d.entry.errorMessage}</div>}
          {d.selectorEvents.length > 0 && (
            <div className="jp-help"><b>Selector drift</b>{d.selectorEvents.map((l) => <div className="jp-note" key={l.id}>{l.message}</div>)}</div>
          )}
          {d.files.length > 0 && (
            <div className="jp-row" aria-label="Pictures and page snapshots">
              {d.files.map((f) => <span key={f.logId} className="jp-row"><ScreenshotButton logId={f.logId} kind={f.kind} label={f.step.replace(/^structure-/, '')} /></span>)}
            </div>
          )}
          {d.files.length === 0 && <div className="jp-note">No picture is kept for this attempt (it may be older than the retention time).</div>}
          <div className="tbl-wrap">
            <table className="jp-table">
              <thead><tr><th>When</th><th>Step</th><th>Message</th><th>Took</th></tr></thead>
              <tbody>
                {d.logs.map((l) => (
                  <tr key={l.id}>
                    <td data-l="When">{when(l.at)}</td><td data-l="Step">{l.step}</td>
                    <td data-l="Message"><span className={`jp-lvl-${l.level}`}>{l.message}</span></td><td data-l="Took">{dur(l.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </JpModal>
  );
}

function Selectors({ sel }) {
  const [open, setOpen] = useState(false);
  const c = sel.counts;
  return (
    <div>
      <div className="jp-row">
        <PortalChip state={{ label: sel.verified ? 'Page settings: verified' : 'Page settings: UNVERIFIED', tone: sel.verified ? 'green' : 'yellow', icon: sel.verified ? ICON.green : ICON.yellow }} />
        <span className="jp-note">version {sel.version || '?'} · {c.ok} work · {c.drift} drift · {c.broken} broken · {c.unknown} not tried yet</span>
        <button type="button" className="btn btn-sm btn-ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide the steps' : `Show the ${c.total} steps`}</button>
      </div>
      {!sel.verified && <div className="jp-note">{sel.label}. A real post is refused until a person calibrates these settings (docs/job-publishing/CALIBRATION.md).</div>}
      {open && (
        <div className="tbl-wrap">
          <table className="jp-table">
            <thead><tr><th>Step</th><th>State</th><th>Main way</th><th>Worked through</th><th>Ways</th></tr></thead>
            <tbody>
              {sel.steps.map((s) => (
                <tr key={s.key}>
                  <td data-l="Step">{s.label}</td>
                  <td data-l="State"><span className={`jp-st-${s.state}`}>{s.state === 'ok' ? 'Works' : s.state === 'drift' ? 'Drift' : s.state === 'broken' ? 'Broken' : 'Not tried'}</span></td>
                  <td data-l="Main way"><span className="jp-note">{s.main}</span></td>
                  <td data-l="Worked through"><span className="jp-note">{s.used && s.usedIndex > 0 ? `fallback ${s.usedIndex + 1}: ${s.used}` : s.used ? 'the main way' : '-'}</span></td>
                  <td data-l="Ways"><span className="jp-note">{s.ways}{s.thin ? ' (thin)' : ''}{s.onlyCss ? ' (CSS only)' : ''}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PortalDiag({ p, cats, canPost, onChanged, openAttempt }) {
  const h = HEALTH_TONE[p.health.state] || HEALTH_TONE.OK;
  const f = p.failures;
  const max = Math.max(1, ...Object.values(f.byCategory));
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  async function retry(r) {
    setBusy(r.id); setErr('');
    try { await jp.post(`/queue/${r.id}/retry`); onChanged(); } catch (e) { setErr(jpError(e)); } finally { setBusy(''); }
  }
  const c = p.credential;
  return (
    <section className={`jp-diag-portal is-${p.health.state}`} aria-label={`${p.name} health`}>
      <div className="jp-row">
        <h3 style={{ margin: 0 }}>{p.name}</h3>
        <span className="jp-spacer" />
        <PortalChip state={{ label: p.health.words || h[0], tone: h[1], icon: h[2] }} />
      </div>
      {p.health.issues.length > 0 && <ul className="jp-issues">{p.health.issues.map((t) => <li key={t}>{t}</li>)}</ul>}
      {p.kind === 'browser' && c && (
        <div className="jp-mini">
          <div><span className="jp-note">Login</span><b>{c.hasLogin ? c.statusWords : 'None saved'}</b></div>
          <div><span className="jp-note">Last Test connection</span><b>{c.lastTest ? c.lastTest.words : 'Not tested yet'}</b>{c.lastTest && c.lastTest.reason && <span className="jp-note">{c.lastTest.reason}</span>}</div>
          <div><span className="jp-note">Automatic posting</span><b>{c.enabled ? 'ON' : 'OFF'}</b></div>
          <div><span className="jp-note">Browser session</span><b>{p.session.ageWords}</b>{p.session.stale && <span className="jp-note">May have expired</span>}</div>
          <div><span className="jp-note">Success rate</span><b>{f.rate == null ? 'No attempts yet' : `${Math.round(f.rate * 100)}% (${f.succeeded} of ${f.total})`}</b></div>
        </div>
      )}
      {f.total > 0 && (
        <div className="jp-bars" aria-label="Why attempts failed">
          <b style={{ fontSize: 13 }}>Why attempts failed</b>
          {Object.keys(cats).map((k) => (
            <div className={`jp-bar${f.byCategory[k] ? '' : ' is-zero'}`} key={k}>
              <span>{cats[k]}</span><i style={{ width: `${Math.max(2, (f.byCategory[k] / max) * 100)}%` }} /><span>{f.byCategory[k]}</span>
            </div>
          ))}
          {f.driftRuns > 0 && <div className="jp-note">{f.driftRuns} attempt(s) worked only through a fallback selector (drift).</div>}
        </div>
      )}
      {p.selectors && <Selectors sel={p.selectors} />}
      <div>
        <b style={{ fontSize: 13 }}>Last attempts</b>
        {p.lastAttempts.length === 0 && <div className="jp-note">Nothing was sent to this site yet.</div>}
        {p.lastAttempts.length > 0 && (
          <div className="tbl-wrap">
            <table className="jp-table">
              <thead><tr><th>When</th><th>What</th><th>Result</th><th>Why</th><th>Pictures</th><th>Do</th></tr></thead>
              <tbody>
                {p.lastAttempts.map((r) => (
                  <tr key={r.id}>
                    <td data-l="When">{when(r.at)}</td>
                    <td data-l="What">{ACTION_WORDS[r.action] || r.action}{r.dryRun ? ' (check only)' : ''}{r.job ? <><br /><span className="jp-note">{r.job.title}</span></> : null}</td>
                    <td data-l="Result"><QueueChip status={r.waiting ? 'NEEDS_HUMAN' : r.status} dryRun={r.dryRun} />{r.selectorDrift > 0 && <span className="jp-note"> drift</span>}</td>
                    <td data-l="Why">{r.categoryWords ? <b className="jp-note">{r.categoryWords}: </b> : null}{r.reason || ''}
                      {(r.waiting || (r.status === 'NEEDS_HUMAN' && r.help)) && <NeedsHelp item={{ id: r.id, status: r.status, waiting: r.waiting, help: r.help }} name={p.name} canPost={canPost} onChanged={onChanged} />}
                    </td>
                    <td data-l="Pictures">{r.pictures ? `${r.pictures}` : '0'}</td>
                    <td data-l="Do" className="jp-acts-cell"><span className="jp-row">
                      <button type="button" className="btn btn-sm" onClick={() => openAttempt(r.id)}>See steps</button>
                      {canPost && r.canRetry && <button type="button" className="btn btn-sm btn-primary" disabled={busy === r.id} onClick={() => retry(r)}>Retry</button>}
                    </span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {err && <div className="jp-err" role="alert">{err}</div>}
      </div>
    </section>
  );
}

export default function PublishDiagnostics({ canPost = false }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [notOn, setNotOn] = useState(false);
  const [open, setOpen] = useState('');
  const [days, setDays] = useState('');
  const [msg, setMsg] = useState('');
  const load = useCallback(() => jp.get('/diagnostics').then((x) => { setD(x); setErr(''); setNotOn(false); setDays((v) => (v === '' ? String(x.retention.days) : v)); }).catch((e) => {
    if (isNotMigrated(e)) setNotOn(true); else setErr(jpError(e, 'Could not read the health screen.'));
  }), []);
  useEffect(() => { load(); }, [load]);
  const waiting = !!(d && d.portals.some((p) => p.lastAttempts.some((r) => r.waiting)));
  useVisiblePoll(load, waiting, 5000);

  async function saveDays(e) {
    e.preventDefault(); setErr(''); setMsg('');
    try { await jp.put('/diagnostics/retention', { days: Number(days) }); setMsg('Saved.'); load(); } catch (x) { setErr(jpError(x)); }
  }
  async function clean() {
    setErr(''); setMsg('');
    try { const r = await jp.post('/diagnostics/sweep'); setMsg(`${r.removed} old picture(s) removed.`); load(); } catch (x) { setErr(jpError(x)); }
  }
  if (notOn) return <div className="jp-off" role="status"><b>Job publishing is not switched on yet</b><span>{NOT_ON_WORDS}</span></div>;
  return (
    <div className="jp-wrap">
      <div className="jp-card jp-wrap">
        <div className="jp-row">
          <h3 style={{ margin: 0 }}>Health of job posting</h3>
          <span className="jp-spacer" />
          <button type="button" className="btn btn-sm" onClick={load}>Refresh</button>
        </div>
        {d && (
          <div className="jp-row">
            <PortalChip state={d.worker && d.worker.running ? { label: 'Posting helper is running', tone: 'green', icon: ICON.green } : { label: 'Posting helper is not running', tone: 'yellow', icon: ICON.yellow }} />
            <PortalChip state={d.realPostingAllowed ? { label: 'Real posting allowed on this computer', tone: 'green', icon: ICON.green } : { label: 'Real posting is OFF on this computer (a Dry run still works)', tone: 'grey', icon: ICON.grey }} />
            {d.killAll && <PortalChip state={{ label: 'Everything is stopped', tone: 'red', icon: ICON.red }} />}
            <span className="jp-note">Last {d.days} days: {d.totals.attempts} finished attempts, {d.totals.failed} did not go through, {d.totals.drift} with selector drift.</span>
          </div>
        )}
        {d && (
          <div className="jp-note">
            Pictures of every attempt are kept {d.retention.days} days, then deleted. Now stored: {d.retention.files} file(s), {fileSize(d.retention.bytes)}. Passwords and one-time codes are hidden in every picture.
          </div>
        )}
        {d && d.canAdmin && (
          <form className="jp-row" style={{ alignItems: 'flex-end' }} onSubmit={saveDays}>
            <label className="jp-field">Keep pictures for (days)<input type="number" min="1" max="365" value={days} onChange={(e) => setDays(e.target.value)} style={{ maxWidth: 110 }} /></label>
            <button type="submit" className="btn btn-sm">Save</button>
            <button type="button" className="btn btn-sm" onClick={clean}>Delete old pictures now</button>
          </form>
        )}
        <div role="status" aria-live="polite">{msg && <div className="jp-ok">{msg}</div>}</div>
        {err && <div className="jp-err" role="alert">{err}</div>}
      </div>
      {!d && !err && <div className="jp-note" role="status">Loading...</div>}
      {d && d.portals.filter((p) => p.kind === 'browser').map((p) => (
        <PortalDiag key={p.portal} p={p} cats={d.categories} canPost={canPost} onChanged={load} openAttempt={setOpen} />
      ))}
      {d && d.portals.filter((p) => p.kind !== 'browser').map((p) => (
        <section key={p.portal} className="jp-card jp-row" aria-label={p.name}>
          <b>{p.name}</b><PortalChip state={{ label: p.health.words, tone: 'green', icon: ICON.green }} />
          <span className="jp-note">{p.kind === 'manual' ? 'Posted by hand only: TeamLink keeps the task.' : 'TeamLink\'s own page: goes live at once, no sign-in.'}</span>
        </section>
      ))}
      {open && <Attempt id={open} onClose={() => setOpen('')} />}
    </div>
  );
}
