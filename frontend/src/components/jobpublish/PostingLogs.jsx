import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import JpModal from './JpModal.jsx';
import { JobPickerCombo, useJobRows, jobLabel } from '../JobPicker.jsx';
import { QueueChip } from './PublishChips.jsx';
import {
  PORTALS, jp, jpError, when, dur, downloadCsv, portalName,
} from './jpKit.js';
import './jobpublish.css';
import Combo from '../Combo.jsx';

// ---------------------------------------------------------------------------
// LOGS and HISTORY.
//   <PostingLogs jobId? />     step-by-step log: filters portal / job / level / dates, screenshot link (opens a viewer), CSV of the rows on screen
//   <PostingHistory jobId />   every time this job was sent (queue rows) + its log underneath
//   <ScreenshotButton logId /> loads GET /logs/:id/screenshot with the login token and shows it in a viewer
// The log never holds a secret (the server scrubs it). No Excel/PDF API exists for logs: CSV of the visible rows is built here.
// ---------------------------------------------------------------------------
export function ScreenshotButton({ logId, label = 'Photo', kind = 'image' }) {
  const text = kind === 'structure'; // a page-structure snapshot (plain text, no personal data) instead of a picture
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [body, setBody] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!open) return undefined;
    let live = true; let made = '';
    setErr(''); setUrl(''); setBody('');
    api.get(`/job-publish/logs/${logId}/screenshot`, { responseType: text ? 'text' : 'blob', transformResponse: text ? [(d) => d] : undefined })
      .then((r) => { if (text) { if (live) setBody(String(r.data || '')); return; } made = URL.createObjectURL(r.data); if (live) setUrl(made); })
      .catch((e) => { if (live) setErr(e.response && e.response.status === 404 ? 'The picture is gone.' : 'You cannot open this picture.'); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [open, logId, text]);
  return (
    <>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)} aria-label={text ? 'Open the page structure of this step' : 'Open the screenshot of this step'}><span aria-hidden="true">{text ? '▤ ' : '▣ '}</span>{text && label === 'Photo' ? 'Page shape' : label}</button>
      {open && (
        <JpModal title={text ? 'Page structure (no personal data)' : 'Screenshot of this step'} top size="is-wide" onClose={() => setOpen(false)} foot={<button type="button" className="btn" onClick={() => setOpen(false)}>Close</button>}>
          {!url && !body && !err && <div className="jp-note" role="status">Loading...</div>}
          {err && <div className="jp-err" role="alert">{err}</div>}
          {url && <img className="jp-thumb" src={url} alt="What the portal page looked like at this step. Passwords are hidden." />}
          {text && body && <pre className="jp-pre" tabIndex={0} aria-label="The shape of the page: tags, ids, names and button words only">{body}</pre>}
          <p className="jp-note">{text ? 'This shows the shape of the page (boxes, buttons, ids) to help fix a changed page. It holds no typed values and no personal text.' : 'Passwords and one-time codes are hidden in these pictures.'}</p>
        </JpModal>
      )}
    </>
  );
}

const startOf = (d) => (d ? new Date(`${d}T00:00:00`).getTime() : undefined);
const endOf = (d) => (d ? new Date(`${d}T23:59:59`).getTime() : undefined);

export function PostingLogs({ jobId: fixedJob = '', queueId = '' }) {
  const [f, setF] = useState({ portal: '', job: fixedJob, level: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const jobs = useJobRows((data ? data.rows : []).map((r) => r.requirementId).filter(Boolean));

  const load = useCallback(() => {
    setLoading(true);
    jp.get('/logs', {
      portal: f.portal || undefined, job: f.job || undefined, level: f.level || undefined, queue: queueId || undefined,
      from: startOf(f.from), to: endOf(f.to), page, pageSize: 25,
    }).then((d) => { setData(d); setErr(''); }).catch((e) => setErr(jpError(e, 'Could not read the logs.'))).finally(() => setLoading(false));
  }, [f, page, queueId]);
  useEffect(() => { load(); }, [load]);
  const set = (k, v) => { setPage(1); setF((x) => ({ ...x, [k]: v })); };
  const rows = (data && data.rows) || [];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="jp-wrap">
      <div className="jp-filters" role="search" aria-label="Filter the logs">
        <Combo aria-label="Site" value={f.portal} onChange={(e) => set('portal', e.target.value)}>
          <option value="">All sites</option>
          {PORTALS.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
        </Combo>
        {!fixedJob && (
          <div style={{ minWidth: 220 }}>
            <JobPickerCombo value={f.job} onChange={(e) => set('job', e.target.value)} blank="All requirements" aria-label="Requirement" />
          </div>
        )}
        <Combo aria-label="How serious" value={f.level} onChange={(e) => set('level', e.target.value)}>
          <option value="">All lines</option>
          <option value="INFO">Normal</option>
          <option value="WARN">Careful</option>
          <option value="ERROR">Problem</option>
        </Combo>
        <label className="jp-note">From <input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} /></label>
        <label className="jp-note">To <input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} /></label>
        <button type="button" className="btn btn-sm" disabled={!rows.length} onClick={() => downloadCsv('posting-log.csv', ['When', 'Site', 'Requirement', 'Step', 'Level', 'Message', 'Took'], rows.map((r) => [new Date(r.at).toISOString(), portalName(r.portal), (jobs.get(r.requirementId) || {}).reqCode || r.requirementId || '', r.step, r.level, r.message, dur(r.durationMs)]))}>Download these rows (CSV)</button>
      </div>
      {err && <div className="jp-err" role="alert">{err}</div>}
      {loading && !data && <div className="jp-note" role="status">Loading the log...</div>}
      {data && rows.length === 0 && <div className="jp-off"><b>No log lines yet</b><span>Lines appear here when a requirement is sent to a site.</span></div>}
      {rows.length > 0 && (
        <div className="tbl-wrap">
          <table className="jp-table">
            <thead><tr><th>When</th><th>Site</th><th>Requirement</th><th>Step</th><th>Message</th><th>Took</th><th>Picture</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const j = jobs.get(r.requirementId);
                return (
                  <tr key={r.id}>
                    <td data-l="When">{when(r.at)}</td>
                    <td data-l="Site">{portalName(r.portal)}</td>
                    <td data-l="Requirement">{j ? jobLabel(j) : (r.requirementId ? '…' : '-')}</td>
                    <td data-l="Step">{r.step}</td>
                    <td data-l="Message"><span className={`jp-lvl-${r.level}`}>{r.level !== 'INFO' ? `${r.level === 'ERROR' ? 'Problem: ' : 'Careful: '}` : ''}{r.message}</span></td>
                    <td data-l="Took">{dur(r.durationMs)}</td>
                    <td data-l="Picture">{r.hasScreenshot ? <ScreenshotButton logId={r.id} kind={r.fileKind || 'image'} /> : '-'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > data.pageSize && (
        <div className="jp-row" role="navigation" aria-label="Pages">
          <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Back</button>
          <span className="jp-note">{`Page ${page} of ${pages} (${data.total} lines)`}</span>
          <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}

// every time one job was sent, then its log
export function PostingHistory({ jobId }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    jp.get('/queue', { job: jobId, pageSize: 50 }).then((d) => { if (live) setRows(d.rows || []); }).catch((e) => { if (live) setErr(jpError(e, 'Could not read the history.')); });
    return () => { live = false; };
  }, [jobId]);
  return (
    <div className="jp-wrap">
      <h4 style={{ margin: 0 }}>Every time it was sent</h4>
      {err && <div className="jp-err" role="alert">{err}</div>}
      {rows && rows.length === 0 && <div className="jp-off"><b>Not sent to any site yet</b><span>Press Post this requirement to start.</span></div>}
      {rows && rows.length > 0 && (
        <div className="tbl-wrap">
          <table className="jp-table">
            <thead><tr><th>When</th><th>Site</th><th>What</th><th>Result</th><th>Note</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td data-l="When">{when(r.finishedAt || r.startedAt || r.scheduledFor || r.nextRunAt)}</td>
                  <td data-l="Site">{portalName(r.portal)}</td>
                  <td data-l="What">{{ PUBLISH: 'Post', REPUBLISH: 'Post again', UNPUBLISH: 'Take down', UPDATE: 'Update', VERIFY: 'Login check' }[r.action] || r.action}{r.dryRun ? ' (check only)' : ''}</td>
                  <td data-l="Result"><QueueChip status={r.status} dryRun={r.dryRun} /></td>
                  <td data-l="Note">{r.errorMessage || (r.result && r.result.portalUrl ? 'Link saved' : '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h4 style={{ margin: '6px 0 0' }}>Step by step</h4>
      <PostingLogs jobId={jobId} />
    </div>
  );
}
