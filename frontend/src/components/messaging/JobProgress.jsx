import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api';
import { STATUS_WORD, STATUS_CLASS } from './msgKit.js';
import './messaging.css';

// Live progress and the result of one send (one person or many): a bar, a line
// per channel, every person with Sent / Failed / Skipped / Blocked and the
// reason in plain words, Stop, Retry failed, and the result as Excel.

const RUNNING = ['queued', 'running', 'cancelling'];

export default function JobProgress({ jobId, initial, noun = 'person', onJob }) {
  const [job, setJob] = useState(initial || null);
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  const timer = useRef(null);
  const onJobRef = useRef(onJob); // keeps polling steady even when the parent passes a new function each time
  onJobRef.current = onJob;

  const poll = useCallback(() => {
    clearTimeout(timer.current);
    api.get(`/messaging/bulk/${jobId}`)
      .then((r) => {
        setJob(r.data);
        if (onJobRef.current) onJobRef.current(r.data);
        if (RUNNING.includes(r.data.status)) timer.current = setTimeout(poll, 1200);
      })
      .catch(() => { timer.current = setTimeout(poll, 2500); });
  }, [jobId]);
  useEffect(() => { poll(); return () => clearTimeout(timer.current); }, [poll]);

  async function action(path) {
    setError('');
    try {
      const r = await api.post(`/messaging/bulk/${jobId}/${path}`, {});
      setJob((j) => ({ ...(j || {}), ...r.data }));
      poll();
    } catch (err) { setError(err.response?.data?.error || 'That did not work.'); }
  }
  async function download(ext) {
    try {
      const r = await api.get(`/messaging/bulk/${jobId}/report.${ext}`, { responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url; a.download = `message-result-${jobId}.${ext}`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch { setError('The result file could not be downloaded.'); }
  }

  if (!job) return <div className="small-muted">Loading…</div>;
  const c = job.counts || { total: 0, done: 0, byChannel: {} };
  const running = RUNNING.includes(job.status);
  const pct = c.total ? Math.round((c.done / c.total) * 100) : 100;
  const rows = (job.recipients || []).filter((r) => filter === 'all' || r.status === filter || (filter === 'waiting' && ['queued', 'sending'].includes(r.status)));
  const tabs = [['all', `Everyone (${c.total})`], ['sent', `Sent (${c.sent})`], ['failed', `Failed (${c.failed})`], ['blocked', `Blocked (${c.blocked || 0})`], ['skipped', `Skipped (${c.skipped})`]];
  if (running) tabs.push(['waiting', `Waiting (${(c.queued || 0) + (c.sending || 0)})`]);
  const sandboxSent = (job.recipients || []).some((r) => r.status === 'sent' && r.sandbox);

  return (
    <div className="msg-job">
      <div className="msg-headline">
        {running ? `Sending… ${c.done} of ${c.total} done` : `Finished: ${c.sent} sent${c.failed ? `, ${c.failed} failed` : ''}${c.blocked ? `, ${c.blocked} blocked` : ''}${c.skipped ? `, ${c.skipped} skipped` : ''}`}
      </div>
      <div className="msg-bar" aria-label={`${pct}% done`}><span style={{ width: `${pct}%` }} /></div>
      {sandboxSent && <div className="notice amber" style={{ marginTop: 8 }}>This is the test copy of TeamLink: &ldquo;Sent&rdquo; here means the test server accepted it. Nothing was really sent to anyone.</div>}
      {job.outOfScope > 0 && <div className="small-muted" style={{ marginTop: 6 }}>{job.outOfScope} chosen {noun}(s) are outside your access and were not messaged.</div>}
      <div className="msg-chan-grid">
        {job.channels.map((ch) => {
          const b = c.byChannel[ch] || {};
          return (
            <div key={ch} className="msg-chan-cell">
              <b>{ch}</b>
              <span>{b.sent || 0} sent</span>
              {(b.failed || 0) > 0 && <span className="msg-red">{b.failed} failed</span>}
              {(b.blocked || 0) > 0 && <span className="msg-red">{b.blocked} blocked</span>}
              {(b.skipped || 0) > 0 && <span className="msg-orange">{b.skipped} skipped</span>}
              {((b.queued || 0) + (b.sending || 0)) > 0 && <span className="msg-blue">{(b.queued || 0) + (b.sending || 0)} waiting</span>}
            </div>
          );
        })}
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="msg-btnrow">
        {running && <button type="button" className="btn" onClick={() => action('cancel')}>Stop sending</button>}
        {!running && c.failed > 0 && <button type="button" className="btn btn-primary" onClick={() => action('retry-failed')}>Try again for the {c.failed} that failed</button>}
        <button type="button" className="btn" onClick={() => download('xlsx')}>Download result (Excel)</button>
        <button type="button" className="btn" onClick={() => download('csv')}>Download (CSV)</button>
      </div>
      <div className="msg-filter" role="tablist">
        {tabs.map(([k, label]) => (
          <button key={k} type="button" className={`msg-chip${filter === k ? ' on' : ''}`} onClick={() => setFilter(k)}>{label}</button>
        ))}
      </div>
      <div className="tbl-wrap msg-rows">
        <table>
          <thead><tr><th>Name</th><th>Channel</th><th>To</th><th>Result</th><th>Why</th></tr></thead>
          <tbody>
            {rows.slice(0, 300).map((r) => (
              <tr key={r.n} onClick={() => setOpen(open === r.n ? null : r.n)} style={{ cursor: r.text ? 'pointer' : 'default' }}>
                <td>{r.name}{open === r.n && r.text && <div className="msg-sent-text">{r.subject ? <b>{r.subject}<br /></b> : null}{r.text}</div>}</td>
                <td className="cell-muted">{r.channel}</td>
                <td className="cell-muted">{r.address || '—'}</td>
                <td><span className={`status ${STATUS_CLASS[r.status] || ''}`}>{STATUS_WORD[r.status] || r.status}</span></td>
                <td className="cell-muted" style={{ fontSize: 12 }}>{r.reason || (r.status === 'sent' && r.attempts > 1 ? `Sent on try ${r.attempts}` : '')}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={5} className="small-muted" style={{ padding: 12 }}>Nobody in this list.</td></tr>}
          </tbody>
        </table>
      </div>
      {rows.length > 300 && <div className="small-muted">Showing the first 300. The Excel file has everyone.</div>}
    </div>
  );
}
