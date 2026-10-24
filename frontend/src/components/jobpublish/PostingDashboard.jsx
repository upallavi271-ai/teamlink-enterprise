import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { JobPickerCombo, useJobRows, jobLabel } from '../JobPicker.jsx';
import { PostingLogs } from './PostingLogs.jsx';
import PublishDiagnostics from './PublishDiagnostics.jsx';
import { QueueChip, QUEUE_WORDS } from './PublishChips.jsx';
import {
  PORTALS, jp, jpError, isNotMigrated, NOT_ON_WORDS, portalName, useVisiblePoll, when, downloadCsv,
} from './jpKit.js';
import './jobpublish.css';
import Combo from '../Combo.jsx';

// ---------------------------------------------------------------------------
// POSTING dashboard (a tab inside Clients & Requirements > Jobs).
//   Overview: tiles + site counts + 7-day trend (chart AND table)  ·  Queue: filters, per-row and bulk buttons
//   Problems: dead letters (gave up after the tries)               ·  Logs: step by step with pictures
// canPost = may Retry / Cancel / Discard (TL, BDE, BDE TL, Admin, Super Admin). Others only look (server enforces).
// Polls every 8 s only while something is queued or running and the tab is visible.
// ---------------------------------------------------------------------------
const SITE_NAMES = Object.fromEntries(PORTALS.map((p) => [p.key, p.name]));
const dayWord = (iso) => { try { return new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); } catch { return iso; } };

function Tile({ n, label, tone, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} className={`jp-tile is-${tone || 'plain'}`} onClick={onClick}>
      <b>{n == null ? '…' : n}</b><span>{label}</span>
    </Tag>
  );
}

function Trend({ rows }) {
  const [table, setTable] = useState(false);
  const max = Math.max(1, ...rows.map((r) => (r.queued || 0) + (r.succeeded || 0) + (r.failed || 0) + (r.needsHuman || 0)));
  const W = 560; const H = 180; const bw = W / Math.max(1, rows.length);
  const parts = [['succeeded', '#2e8b57', 'Posted'], ['queued', '#2f7fd1', 'Waiting'], ['needsHuman', '#d9921a', 'Needs your help'], ['failed', '#c0392b', 'Failed']];
  const summary = rows.map((r) => `${dayWord(r.date)}: ${r.succeeded || 0} posted, ${r.failed || 0} failed, ${r.needsHuman || 0} need help, ${r.queued || 0} waiting`).join('. ');
  return (
    <div className="jp-trend">
      <div className="jp-row">
        <h4 style={{ margin: 0 }}>Last 7 days</h4>
        <span className="jp-spacer" />
        <button type="button" className="btn btn-sm" aria-pressed={table} onClick={() => setTable(!table)}>{table ? 'Show the chart' : 'Show as a table'}</button>
      </div>
      {!table ? (
        <>
          <svg viewBox={`0 0 ${W} ${H + 24}`} role="img" aria-label={`Requirements sent per day, last 7 days. ${summary}`}>
            <line x1="0" y1={H} x2={W} y2={H} stroke="#c9d3e3" />
            {rows.map((r, i) => {
              let y = H;
              return (
                <g key={r.date} transform={`translate(${i * bw + bw * 0.15},0)`}>
                  {parts.map(([k, c]) => {
                    const h = ((r[k] || 0) / max) * (H - 10);
                    y -= h;
                    return h > 0 ? <rect key={k} x="0" y={y} width={bw * 0.7} height={h} fill={c} rx="2" /> : null;
                  })}
                  <text x={bw * 0.35} y={H + 16} textAnchor="middle" fontSize="11" fill="#4a5566">{dayWord(r.date)}</text>
                </g>
              );
            })}
          </svg>
          <div className="jp-legend">{parts.map(([k, c, l]) => <span key={k}><i style={{ background: c }} />{l}</span>)}</div>
        </>
      ) : (
        <div className="tbl-wrap">
          <table className="jp-table">
            <thead><tr><th>Day</th><th>Posted</th><th>Waiting</th><th>Needs your help</th><th>Failed</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.date}><td data-l="Day">{dayWord(r.date)}</td><td data-l="Posted">{r.succeeded || 0}</td><td data-l="Waiting">{r.queued || 0}</td><td data-l="Needs your help">{r.needsHuman || 0}</td><td data-l="Failed">{r.failed || 0}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// queue rows with the buttons that fit each state; used for the Queue and the Problems (dead letters) tabs
function QueueTable({ rows, canPost, picked, setPicked, onAct, busyId }) {
  const jobs = useJobRows(rows.map((r) => r.requirementId).filter(Boolean));
  const can = (r) => ({
    retry: ['FAILED', 'DEAD', 'NEEDS_HUMAN', 'CANCELLED'].includes(r.status),
    cancel: ['QUEUED', 'NEEDS_HUMAN'].includes(r.status),
    discard: ['DEAD', 'FAILED'].includes(r.status),
  });
  const all = rows.length > 0 && rows.every((r) => picked.includes(r.id));
  return (
    <div className="tbl-wrap">
      <table className="jp-table">
        <thead>
          <tr>
            {canPost && <th><input type="checkbox" aria-label="Pick every row" checked={all} onChange={() => setPicked(all ? [] : rows.map((r) => r.id))} /></th>}
            <th>Requirement</th><th>Site</th><th>What</th><th>Result</th><th>Tries</th><th>When</th><th>Why</th>{canPost && <th>Do</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const j = jobs.get(r.requirementId);
            const c = can(r);
            const b = busyId === r.id;
            return (
              <tr key={r.id}>
                {canPost && <td data-l="Pick"><input type="checkbox" aria-label={`Pick this row (${portalName(r.portal)})`} checked={picked.includes(r.id)} onChange={() => setPicked(picked.includes(r.id) ? picked.filter((x) => x !== r.id) : [...picked, r.id])} /></td>}
                <td data-l="Requirement">{r.requirementId ? <Link to={`/requirements/${r.requirementId}`}>{j ? jobLabel(j) : 'Open the requirement'}</Link> : 'Login check'}</td>
                <td data-l="Site">{SITE_NAMES[r.portal] || r.portal}</td>
                <td data-l="What">{{ PUBLISH: 'Post', REPUBLISH: 'Post again', UNPUBLISH: 'Take down', UPDATE: 'Update', VERIFY: 'Login check' }[r.action] || r.action}{r.dryRun ? ' (check only)' : ''}</td>
                <td data-l="Result"><QueueChip status={r.status} dryRun={r.dryRun} /></td>
                <td data-l="Tries">{r.attempts}/{r.maxAttempts}</td>
                <td data-l="When">{when(r.finishedAt || r.startedAt || r.scheduledFor || r.nextRunAt)}{r.scheduledFor && r.status === 'QUEUED' ? ' (planned)' : ''}</td>
                <td data-l="Why">{r.status === 'NEEDS_HUMAN' ? (r.errorMessage || 'Needs checking: we pressed Submit but could not confirm it. Open the portal and check.') : (r.errorMessage || '')}</td>
                {canPost && (
                  <td data-l="Do" className="jp-acts-cell">
                    <span className="jp-row">
                      {c.retry && <button type="button" className="btn btn-sm btn-primary" disabled={b} onClick={() => onAct(r, 'retry')}>Retry</button>}
                      {c.cancel && <button type="button" className="btn btn-sm" disabled={b} onClick={() => onAct(r, 'cancel')}>Cancel</button>}
                      {c.discard && <button type="button" className="btn btn-sm btn-danger" disabled={b} onClick={() => onAct(r, 'discard')}>Discard</button>}
                    </span>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BulkBar({ picked, rows, onBulk, busy, clear }) {
  if (!picked.length) return null;
  const sel = rows.filter((r) => picked.includes(r.id));
  const n = (fn) => sel.filter(fn).length;
  return (
    <div className="jp-row jp-card" role="region" aria-label="Actions for the picked rows">
      <b>{picked.length} picked</b>
      <button type="button" className="btn btn-sm btn-primary" disabled={busy || !n((r) => ['FAILED', 'DEAD', 'NEEDS_HUMAN', 'CANCELLED'].includes(r.status))} onClick={() => onBulk('retry')}>Retry picked</button>
      <button type="button" className="btn btn-sm" disabled={busy || !n((r) => ['QUEUED', 'NEEDS_HUMAN'].includes(r.status))} onClick={() => onBulk('cancel')}>Cancel picked</button>
      <button type="button" className="btn btn-sm btn-danger" disabled={busy || !n((r) => ['DEAD', 'FAILED'].includes(r.status))} onClick={() => onBulk('discard')}>Discard picked</button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={clear}>Clear</button>
    </div>
  );
}

export default function PostingDashboard({ canPost }) {
  const [tab, setTab] = useState('overview');
  const [dash, setDash] = useState(null);
  const [notOn, setNotOn] = useState(false);
  const [err, setErr] = useState('');
  const [health, setHealth] = useState(null);
  const [f, setF] = useState({ status: '', portal: '', job: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const [queue, setQueue] = useState(null);
  const [dead, setDead] = useState(null);
  const [picked, setPicked] = useState([]);
  const [busyId, setBusyId] = useState('');
  const [msg, setMsg] = useState('');
  const [actErr, setActErr] = useState('');

  const loadDash = useCallback(() => jp.get('/dashboard').then((d) => { setDash(d); setErr(''); setNotOn(false); }).catch((e) => {
    if (isNotMigrated(e)) setNotOn(true); else setErr(jpError(e, 'Could not read the posting numbers.'));
  }), []);
  const loadQueue = useCallback(() => jp.get('/queue', {
    status: f.status || undefined, portal: f.portal || undefined, job: f.job || undefined,
    from: f.from ? new Date(`${f.from}T00:00:00`).getTime() : undefined, to: f.to ? new Date(`${f.to}T23:59:59`).getTime() : undefined, page, pageSize: 25,
  }).then(setQueue).catch((e) => { if (!isNotMigrated(e)) setErr(jpError(e, 'Could not read the queue.')); }), [f, page]);
  const loadDead = useCallback(() => jp.get('/dead-letters', { pageSize: 50 }).then(setDead).catch(() => {}), []);
  const reloadAll = useCallback(() => { loadDash(); loadQueue(); loadDead(); }, [loadDash, loadQueue, loadDead]);

  useEffect(() => { jp.get('/health').then(setHealth).catch(() => {}); loadDash(); }, [loadDash]);
  useEffect(() => { if (!notOn) { loadQueue(); } }, [loadQueue, notOn]);
  useEffect(() => { if (!notOn) loadDead(); }, [loadDead, notOn]);
  useEffect(() => { setPicked([]); }, [tab, f, page]);

  const qn = (dash && dash.queue) || {};
  const active = (qn.QUEUED || 0) + (qn.RUNNING || 0) > 0;
  useVisiblePoll(reloadAll, active && !notOn, 8000);

  async function act(r, kind) {
    if (kind === 'discard' && !window.confirm('Discard this? It stays in the history but will not be tried again.')) return;
    setBusyId(r.id); setActErr(''); setMsg('');
    try { await jp.post(`/queue/${r.id}/${kind}`); setMsg(`${{ retry: 'Sent again', cancel: 'Cancelled', discard: 'Discarded' }[kind]}.`); reloadAll(); } catch (e) { setActErr(jpError(e)); } finally { setBusyId(''); }
  }
  async function bulk(kind, rows) {
    const list = rows.filter((r) => picked.includes(r.id));
    if (kind === 'discard' && !window.confirm(`Discard ${list.length} rows? They stay in the history but will not be tried again.`)) return;
    setBusyId('bulk'); setActErr(''); setMsg('');
    let ok = 0; let bad = 0;
    for (const r of list) { try { await jp.post(`/queue/${r.id}/${kind}`); ok += 1; } catch { bad += 1; } }
    setMsg(`${ok} done${bad ? `, ${bad} could not be changed (their state did not allow it)` : ''}.`);
    setPicked([]); setBusyId(''); reloadAll();
  }

  const totals = (dash && dash.totals) || {};
  const queueRows = (queue && queue.rows) || [];
  const deadRows = (dead && dead.rows) || [];
  const pages = queue ? Math.max(1, Math.ceil(queue.total / queue.pageSize)) : 1;
  const set = (k, v) => { setPage(1); setF((x) => ({ ...x, [k]: v })); };
  const portalRows = useMemo(() => PORTALS.map((p) => ({ ...((dash && dash.portals) || []).find((x) => x.portal === p.key), ...p })), [dash]);
  const TABS = [['overview', 'Overview'], ['queue', 'Queue'], ['problems', `Problems${deadRows.length ? ` (${deadRows.length})` : ''}`], ['logs', 'Logs'], ['health', 'Health']];

  if (notOn) {
    return <div className="jp-off" role="status"><b>Job publishing is not switched on yet</b><span>{NOT_ON_WORDS}</span></div>;
  }
  return (
    <div className="jp-wrap">
      <div className="jp-tabsub" role="tablist" aria-label="Posting views">
        {TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-on' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {err && <div className="jp-err" role="alert">{err}</div>}
      {health && health.migrated && health.worker && !health.worker.running && (qn.QUEUED || 0) > 0 && (
        <div className="jp-ok" style={{ background: '#fdf1d9', color: '#7a5200', borderColor: '#f0d9a0' }} role="status">Requirements are waiting, but the posting helper is not running. {canPost ? 'Ask the team that looks after TeamLink to start it.' : ''}</div>
      )}
      <div role="status" aria-live="polite">{msg && <div className="jp-ok">{msg}</div>}{actErr && <div className="jp-err" role="alert">{actErr}</div>}</div>

      {tab === 'overview' && (
        <>
          <div className="jp-tiles" aria-label="Posting numbers">
            <Tile n={totals.totalJobs} label="Total requirements" />
            <Tile n={totals.published} label="Posted" tone="green" />
            <Tile n={totals.pendingQueued} label="Waiting" tone="blue" onClick={() => { set('status', 'QUEUED'); setTab('queue'); }} />
            <Tile n={totals.failed} label="Failed" tone="red" onClick={() => { set('status', 'FAILED'); setTab('queue'); }} />
            <Tile n={totals.needsHuman} label="Needs your help" tone="yellow" onClick={() => { set('status', 'NEEDS_HUMAN'); setTab('queue'); }} />
            <Tile n={totals.draft} label="Not posted" />
          </div>
          <div className="jp-card">
            <h4>Site by site</h4>
            <div className="tbl-wrap">
              <table className="jp-table">
                <thead><tr><th>Site</th><th>Posted</th><th>Waiting</th><th>Failed</th><th>Needs checking</th><th>Taken down</th></tr></thead>
                <tbody>
                  {portalRows.map((p) => (
                    <tr key={p.key}>
                      <td data-l="Site"><b>{p.name}</b></td>
                      <td data-l="Posted">{p.PUBLISHED || 0}</td><td data-l="Waiting">{p.QUEUED || 0}</td><td data-l="Failed">{p.FAILED || 0}</td>
                      <td data-l="Needs checking">{p.NEEDS_CHECK || 0}</td><td data-l="Taken down">{(p.UNPUBLISHED || 0) + (p.EXPIRED || 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="jp-note">LinkedIn is posted by hand: its numbers count the tasks you finished.</p>
          </div>
          <div className="jp-card">{dash ? <Trend rows={dash.trend || []} /> : <div className="jp-note" role="status">Loading...</div>}</div>
          {!dash && !err && <div className="jp-note" role="status">Loading the numbers...</div>}
        </>
      )}

      {tab === 'queue' && (
        <>
          <div className="jp-filters" role="search" aria-label="Filter the queue">
            <Combo aria-label="Result" value={f.status} onChange={(e) => set('status', e.target.value)}>
              <option value="">All results</option>
              {Object.keys(QUEUE_WORDS).map((k) => <option key={k} value={k}>{`${QUEUE_WORDS[k]} (${qn[k] || 0})`}</option>)}
            </Combo>
            <Combo aria-label="Site" value={f.portal} onChange={(e) => set('portal', e.target.value)}>
              <option value="">All sites</option>
              {PORTALS.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
            </Combo>
            <div style={{ minWidth: 220 }}><JobPickerCombo value={f.job} onChange={(e) => set('job', e.target.value)} blank="All requirements" aria-label="Requirement" /></div>
            <label className="jp-note">From <input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} /></label>
            <label className="jp-note">To <input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} /></label>
            <button type="button" className="btn btn-sm" disabled={!queueRows.length} onClick={() => downloadCsv('posting-queue.csv', ['Site', 'What', 'Result', 'Tries', 'When', 'Why'], queueRows.map((r) => [portalName(r.portal), r.action, r.status, `${r.attempts}/${r.maxAttempts}`, when(r.finishedAt || r.startedAt || r.nextRunAt), r.errorMessage || '']))}>Download these rows (CSV)</button>
          </div>
          {canPost && <BulkBar picked={picked} rows={queueRows} busy={busyId === 'bulk'} onBulk={(k) => bulk(k, queueRows)} clear={() => setPicked([])} />}
          {!queue && <div className="jp-note" role="status">Loading the queue...</div>}
          {queue && queueRows.length === 0 && <div className="jp-off"><b>Nothing here</b><span>{f.status || f.portal || f.job || f.from || f.to ? 'No rows match these filters.' : 'Requirements you send to a site show up here.'}</span></div>}
          {queueRows.length > 0 && <QueueTable rows={queueRows} canPost={canPost} picked={picked} setPicked={setPicked} onAct={act} busyId={busyId} />}
          {queue && queue.total > queue.pageSize && (
            <div className="jp-row" role="navigation" aria-label="Pages">
              <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Back</button>
              <span className="jp-note">{`Page ${page} of ${pages} (${queue.total} rows)`}</span>
              <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          )}
        </>
      )}

      {tab === 'problems' && (
        <>
          <p className="jp-note" style={{ margin: 0 }}>These requirements were tried again and again and still did not post. Retry sends them with fresh tries. Discard keeps them in the history only.</p>
          {canPost && <BulkBar picked={picked} rows={deadRows} busy={busyId === 'bulk'} onBulk={(k) => bulk(k, deadRows)} clear={() => setPicked([])} />}
          {!dead && <div className="jp-note" role="status">Loading...</div>}
          {dead && deadRows.length === 0 && <div className="jp-off"><b>No problems</b><span>Nothing gave up. Good.</span></div>}
          {deadRows.length > 0 && <QueueTable rows={deadRows} canPost={canPost} picked={picked} setPicked={setPicked} onAct={act} busyId={busyId} />}
        </>
      )}

      {tab === 'logs' && <PostingLogs />}
      {tab === 'health' && <PublishDiagnostics canPost={canPost} />}
    </div>
  );
}
