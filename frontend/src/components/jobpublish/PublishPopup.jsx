import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import JpModal from './JpModal.jsx';
import JobPortalRows, { useJobPublish } from './JobPortalRows.jsx';
import { PortalChip, portalState } from './PublishChips.jsx';
import {
  PORTALS, jp, jpError, NOT_ON_WORDS, portalName, when,
} from './jpKit.js';
import './jobpublish.css';

// ---------------------------------------------------------------------------
// "POST THIS JOB" popup (one job) and "Post selected jobs" (many jobs, same popup).
//   <PublishPopup jobIds={['...']} titles={{id: 'Title'}} onClose onDone />
// Pick the sites (each shows its live status), optionally tick "Dry run" (nothing is posted), Post now / Post at <time>.
// After sending, one job shows live rows with Retry / Republish / Take down; many jobs show a result per job.
// Server: POST /api/job-publish/jobs/:id/publish and /publish-bulk  (queues work; the worker posts).
// ---------------------------------------------------------------------------
const MODE_WORDS = {
  queued: 'Queued: waiting to be posted', by_hand: 'Post by hand: we made a task', refused: 'Not sent', already: 'Already live with the same words', nothing: 'Nothing to take down',
};
const toneOf = { queued: 'blue', by_hand: 'yellow', refused: 'red', already: 'green', nothing: 'grey' };
const ICON = { green: '✔', blue: '⟳', yellow: '!', red: '✖', grey: '○' };

function ResultLine({ r, dry }) {
  const tone = (r.mode === 'queued' && r.entry && r.entry.status === 'SUCCEEDED') ? 'green' : toneOf[r.mode] || (r.ok ? 'green' : 'red');
  const done = r.mode === 'queued' && r.entry && r.entry.status === 'SUCCEEDED';
  const label = done ? (dry ? 'Checked (nothing was posted)' : 'Done') : r.mode === 'queued' && dry ? 'Queued (check only, nothing is posted)' : (MODE_WORDS[r.mode] || (r.ok ? 'Done' : 'Not sent'));
  return (
    <div className="jp-row" style={{ alignItems: 'flex-start' }}>
      <b style={{ minWidth: 110 }}>{portalName(r.portal)}</b>
      <PortalChip state={{ label, tone, icon: ICON[tone] }} />
      {r.reason && <span className="jp-note" style={{ flexBasis: '100%' }}>{r.reason}</span>}
    </div>
  );
}

export default function PublishPopup({ jobIds, titles = {}, onClose, onDone }) {
  const many = jobIds.length > 1;
  const one = jobIds[0];
  const data = useJobPublish(many ? null : one); // many jobs: only the sites list is read
  const [picked, setPicked] = useState(null);
  const [dry, setDry] = useState(false);
  const [later, setLater] = useState(false);
  const [at, setAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sent, setSent] = useState(null); // { many, results | jobs }
  const infos = data.infos;
  const postings = (data.status && data.status.portals) || [];

  const states = useMemo(() => Object.fromEntries(PORTALS.map((p) => [p.key, portalState({
    posting: many ? null : postings.find((x) => x.portal === p.key), info: infos.find((x) => x.portal === p.key),
  })])), [many, postings, infos]);

  // first time the statuses are known: tick the sites that are ready and not already live
  useEffect(() => {
    if (picked !== null || data.loading || data.notOn) return;
    // Telegram / Facebook post in public: they are never ticked for you
    setPicked(PORTALS.filter((p) => p.kind !== 'api' && states[p.key].key === 'READY').map((p) => p.key));
  }, [data.loading, data.notOn, states]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (k) => setPicked((l) => ((l || []).includes(k) ? l.filter((x) => x !== k) : [...(l || []), k]));
  const when_ = later && at ? new Date(at) : null;
  const badTime = later && (!when_ || Number.isNaN(when_.getTime()) || when_.getTime() < Date.now() - 60000);
  const canSend = !busy && (picked || []).length > 0 && !badTime;

  async function send(portals, retryJob) {
    setBusy(true); setErr('');
    const body = { portals, dryRun: dry, ...(when_ ? { scheduledFor: when_.toISOString() } : {}), idempotencyKey: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
    try {
      if (many && !retryJob) {
        const out = await jp.post('/publish-bulk', { jobIds, ...body, action: 'PUBLISH' });
        setSent({ many: true, jobs: out.jobs || [], summary: out.summary });
      } else {
        const id = retryJob || one;
        const out = await jp.post(`/jobs/${id}/publish`, body);
        if (many) setSent((s) => ({ ...s, jobs: s.jobs.map((j) => (j.requirementId === id ? { ...j, ...out, ok: true } : j)) }));
        else setSent({ many: false, results: out.results || [] });
        if (!many) data.reload();
      }
      if (onDone) onDone();
    } catch (e) { setErr(jpError(e)); } finally { setBusy(false); }
  }

  const title = many ? `Post ${jobIds.length} selected requirements` : `Post this requirement${titles[one] ? `: ${titles[one]}` : ''}`;
  const foot = sent ? <button type="button" className="btn btn-primary" onClick={onClose}>Done</button> : (
    <>
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-primary" disabled={!canSend || data.notOn} onClick={() => send(picked)}>
        {busy ? 'Sending...' : dry ? 'Check only (dry run)' : later && when_ && !badTime ? `Post at ${when(when_)}` : 'Post now'}
      </button>
    </>
  );

  return (
    <JpModal title={title} onClose={onClose} foot={foot}>
      {data.notOn && <div className="jp-off" role="status"><b>Job publishing is not switched on yet</b><span>{NOT_ON_WORDS}</span></div>}
      {!data.notOn && data.loading && <div className="jp-note" role="status">Loading the sites...</div>}
      {!data.notOn && data.error && <div className="jp-err" role="alert">{data.error}</div>}
      {!data.notOn && !data.loading && !sent && picked !== null && (
        <>
          {data.killAll && <div className="jp-err">Posting is stopped for now (the big stop switch is on). Ask an Admin.</div>}
          {data.paused && <div className="jp-ok" style={{ background: '#fdf1d9', color: '#7a5200', borderColor: '#f0d9a0' }}>Posting is paused. Requirements will wait in the queue.</div>}
          <p className="jp-note" style={{ margin: '0 0 8px' }}>Tick the sites. Nothing is called Posted until the site really shows the requirement.</p>
          <div className="jp-portals">
            {PORTALS.map((p) => {
              const s = states[p.key];
              const on = (picked || []).includes(p.key);
              const id = `jp-pick-${p.key}`;
              return (
                <div key={p.key} className={`jp-portal${on ? ' is-on' : ''}`}>
                  <label htmlFor={id}>
                    <input id={id} type="checkbox" checked={on} onChange={() => toggle(p.key)} />
                    <span>{p.name}</span>
                    <span className="jp-spacer" />
                    <PortalChip state={s} />
                  </label>
                  {s.detail && <div className="jp-hint">{s.key === 'BY_HAND' ? 'Post by hand: we made a task.' : s.detail}</div>}
                </div>
              );
            })}
          </div>
          <div className="jp-opts">
            <label><input type="checkbox" checked={dry} onChange={(e) => setDry(e.target.checked)} /> <span>Dry run (check only, nothing is posted)</span></label>
            <div role="radiogroup" aria-label="When">
              <label><input type="radio" name="jp-when" checked={!later} onChange={() => setLater(false)} /> <span>Post now</span></label>
              <label style={{ marginTop: 6 }}><input type="radio" name="jp-when" checked={later} onChange={() => setLater(true)} /> <span>Post later</span></label>
            </div>
            {later && (
              <label className="jp-field">Post at
                <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} aria-invalid={badTime} />
                {badTime && <span className="jp-note" style={{ color: '#a1281c' }}>Pick a time that has not passed.</span>}
              </label>
            )}
          </div>
          {err && <div className="jp-err" role="alert">{err}</div>}
        </>
      )}
      {sent && !sent.many && (
        <>
          <h4 style={{ margin: '0 0 6px', fontSize: 14 }}>What happened</h4>
          <div aria-live="polite" className="jp-wrap" style={{ marginBottom: 12 }}>
            {sent.results.map((r) => <ResultLine key={r.portal} r={r} dry={dry} />)}
          </div>
          <h4 style={{ margin: '0 0 6px', fontSize: 14 }}>Live status</h4>
          <JobPortalRows jobId={one} data={data} canPost onChanged={onDone} only={sent.results.map((r) => r.portal)} />
        </>
      )}
      {sent && sent.many && (
        <div aria-live="polite" className="jp-wrap">
          <div className="jp-ok">{sent.summary ? `${sent.summary.jobs} requirements, ${sent.summary.queued} sent to the queue${sent.summary.refused ? `, ${sent.summary.refused} not sent` : ''}.` : 'Sent.'}</div>
          {sent.jobs.map((j) => (
            <div className="jp-card" key={j.requirementId}>
              <div className="jp-row">
                <b><Link to={`/requirements/${j.requirementId}`} onClick={onClose}>{titles[j.requirementId] || 'Open the requirement'}</Link></b>
                {j.ok === false && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => send(picked, j.requirementId)}>Try again</button>}
              </div>
              {j.ok === false ? <div className="jp-err" role="alert">{j.reason}</div> : (j.results || []).map((r) => <ResultLine key={r.portal} r={r} dry={dry} />)}
            </div>
          ))}
        </div>
      )}
      {err && sent && <div className="jp-err" role="alert">{err}</div>}
    </JpModal>
  );
}
