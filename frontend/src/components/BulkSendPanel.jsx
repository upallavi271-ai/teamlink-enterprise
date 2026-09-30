import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../api';
import { Modal } from './proto.jsx';
import Combo from './Combo.jsx';
import './agreements/agreements.css';

// ---------------------------------------------------------------------------
// BULK SEND — one message to many candidates, clients or employees, by Email,
// SMS and/or WhatsApp, through the server's QUEUE (POST /api/messaging/bulk):
//
//   before sending   each channel's real status (configured, or why not)
//   after sending    live progress per channel, a status per recipient
//                    (queued / sent / failed / skipped + the reason), Cancel,
//                    Retry failed, and a downloadable CSV report
//
// The server decides who may be messaged (scope), drops invalid / missing /
// duplicate addresses with a reason, rate-limits each provider and retries
// temporary failures. Closing this window does not stop a send — it keeps
// going on the server, and the report stays available.
//
// {name} and {firstName} in the text are replaced per recipient.
// ---------------------------------------------------------------------------

export const BULK_LIMIT = 500;

const CHANNEL_SETS = {
  Email: ['Email'],
  WhatsApp: ['WhatsApp'],
  SMS: ['SMS'],
  Omnichannel: ['Email', 'SMS', 'WhatsApp'],
};
const NOUN = { candidates: 'candidate', clients: 'client', employees: 'employee' };

function draft(purpose) {
  switch (purpose) {
    case 'New opening':
      return 'Hi {firstName}, we have a new opening that matches your profile. Reply if you would like the details.';
    case 'Interview Reminder':
      return 'Hi {firstName}, a reminder about your interview. Please confirm you are able to attend.';
    case 'Document Request':
      return 'Hi {firstName}, could you send across your documents so we can proceed?';
    case 'Profile update':
      return 'Hi {firstName}, please reply with your current CTC, expected CTC and notice period so we can keep your profile current.';
    default:
      return 'Hi {firstName}, ';
  }
}

const STATUS_CLASS = { sent: 'active', failed: 'rejected', skipped: 'pending', queued: 'review', sending: 'review' };

export default function BulkSendPanel({
  mode, candidateIds, ids, audience = 'candidates', note, onClose, onSent,
}) {
  const targets = ids || candidateIds || [];
  const noun = NOUN[audience] || 'recipient';
  const [channels, setChannels] = useState(CHANNEL_SETS[mode] || ['Email']);
  const [status, setStatus] = useState(null);
  const [vocab, setVocab] = useState(null);
  const [purpose, setPurpose] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [job, setJob] = useState(null);
  const [filter, setFilter] = useState('all');
  const timer = useRef(null);

  useEffect(() => {
    api.get('/messaging/channels').then((r) => setStatus(r.data)).catch(() => setStatus(null));
    if (audience === 'candidates') api.get('/followups/statuses').then((r) => setVocab(r.data)).catch(() => setVocab(null));
  }, [audience]);
  const purposes = ['New opening', 'Profile update', ...((vocab && vocab.templates && vocab.templates.candidate) || [])];

  const poll = useCallback((id) => {
    clearTimeout(timer.current);
    api.get(`/messaging/bulk/${id}`)
      .then((r) => {
        setJob(r.data);
        if (['queued', 'running', 'cancelling'].includes(r.data.status)) timer.current = setTimeout(() => poll(id), 1200);
      })
      .catch(() => { timer.current = setTimeout(() => poll(id), 2500); });
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  function pick(p) {
    setPurpose(p);
    setSubject(p);
    setBody(draft(p));
  }
  const toggle = (c) => setChannels((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));
  const tooMany = targets.length > BULK_LIMIT;
  const off = channels.filter((c) => status && status.channels[c] && !status.channels[c].configured);

  async function send() {
    setError(''); setBusy(true);
    try {
      const res = await api.post('/messaging/bulk', {
        audience, ids: targets, channels, purpose, subject, body,
      });
      setJob(res.data);
      poll(res.data.id);
      if (onSent) onSent(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'The send could not be started.');
    } finally { setBusy(false); }
  }

  async function action(path, okText) {
    setError('');
    try {
      const r = await api.post(`/messaging/bulk/${job.id}/${path}`, {});
      setJob((j) => ({ ...j, ...r.data }));
      poll(job.id);
      if (okText) setError('');
    } catch (err) { setError(err.response?.data?.error || 'That did not work.'); }
  }

  async function downloadReport() {
    try {
      const r = await api.get(`/messaging/bulk/${job.id}/report.csv`, { responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bulk-send-${job.id}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch { setError('The report could not be downloaded.'); }
  }

  if (job) {
    const c = job.counts || { total: 0, done: 0, byChannel: {} };
    const pct = c.total ? Math.round((c.done / c.total) * 100) : 100;
    const running = ['queued', 'running', 'cancelling'].includes(job.status);
    const rows = (job.recipients || []).filter((r) => filter === 'all' || r.status === filter);
    return (
      <Modal
        wide
        title={`Bulk ${job.channels.join(' + ')} — ${job.entities} ${noun}${job.entities === 1 ? '' : 's'}`}
        onClose={onClose}
        footer={<>
          <button className="btn" onClick={downloadReport}>Download report (CSV)</button>
          {running && <button className="btn btn-ghost" onClick={() => action('cancel')}>Stop sending</button>}
          {!running && c.failed > 0 && <button className="btn" onClick={() => action('retry-failed')}>Retry {c.failed} failed</button>}
          <button className="btn btn-primary" onClick={onClose}>{running ? 'Close (keeps sending)' : 'Done'}</button>
        </>}
      >
        <div className="small-muted">
          {running ? `Sending… ${c.done} of ${c.total} done` : `Finished — ${c.sent} sent, ${c.failed} failed, ${c.skipped} skipped`}
          {job.outOfScope > 0 && ` · ${job.outOfScope} selected ${noun}(s) are outside your access and were not messaged`}
        </div>
        <div className="bulk-bar" aria-label={`${pct}% done`}><span style={{ width: `${pct}%` }} /></div>
        <div className="bulk-grid">
          {job.channels.map((ch) => {
            const b = c.byChannel[ch] || {};
            return (
              <div key={ch} className="bulk-cell">
                <b>{ch}</b>
                {b.sent || 0} sent · {b.failed || 0} failed · {b.skipped || 0} skipped{(b.queued || 0) + (b.sending || 0) ? ` · ${(b.queued || 0) + (b.sending || 0)} waiting` : ''}
              </div>
            );
          })}
        </div>
        {error && <div className="error-text">{error}</div>}
        <div className="filter-row" style={{ marginBottom: 6 }}>
          <Combo value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All recipients ({c.total})</option>
            <option value="sent">Sent ({c.sent})</option>
            <option value="failed">Failed ({c.failed})</option>
            <option value="skipped">Skipped ({c.skipped})</option>
            <option value="queued">Waiting ({c.queued || 0})</option>
          </Combo>
        </div>
        <div className="tbl-wrap bulk-rows">
          <table>
            <thead><tr><th>Name</th><th>Channel</th><th>To</th><th>Status</th><th>Reason</th></tr></thead>
            <tbody>
              {rows.slice(0, 300).map((r) => (
                <tr key={`${r.n}`}>
                  <td>{r.name}</td>
                  <td className="cell-muted">{r.channel}</td>
                  <td className="cell-muted">{r.address || '—'}</td>
                  <td><span className={`status ${STATUS_CLASS[r.status] || ''}`}>{r.status}</span></td>
                  <td className="cell-muted" style={{ fontSize: 12 }}>{r.reason || (r.status === 'sent' && r.attempts > 1 ? `Sent on attempt ${r.attempts}` : '')}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={5} className="small-muted" style={{ padding: 12 }}>Nothing in this view.</td></tr>}
            </tbody>
          </table>
        </div>
        {rows.length > 300 && <div className="small-muted">Showing the first 300 — the CSV report has every row.</div>}
      </Modal>
    );
  }

  return (
    <Modal
      title={`Send to ${targets.length} ${noun}${targets.length === 1 ? '' : 's'}`}
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-primary"
          disabled={busy || tooMany || !purpose || !body.trim() || !targets.length || !channels.length || (channels.includes('Email') && !subject.trim())}
          onClick={send}
        >
          {busy ? 'Starting…' : `Send to ${targets.length}`}
        </button>
      </>}
    >
      {note && <div className="notice" style={{ marginBottom: 10 }}>{note}</div>}
      {tooMany && (
        <div className="notice red" style={{ marginBottom: 10 }}>
          {targets.length} selected — at most {BULK_LIMIT} per send. Narrow the filters or tick the ones you want, and send in batches.
        </div>
      )}
      <div className="field">
        <label>Send by</label>
        <div className="bulk-ch">
          {['Email', 'SMS', 'WhatsApp'].map((ch) => {
            const st = status && status.channels[ch];
            return (
              <label key={ch} title={st && !st.configured ? st.reason : (st && st.detail) || ''}>
                <input type="checkbox" checked={channels.includes(ch)} onChange={() => toggle(ch)} />
                {ch}
                <span className={`small-muted`} style={{ color: st && !st.configured ? 'var(--amber)' : undefined }}>
                  {st ? (st.configured ? '(connected)' : '(not configured)') : ''}
                </span>
              </label>
            );
          })}
        </div>
      </div>
      <div className="field">
        <label>What is this for?</label>
        <Combo creatable value={purpose} onChange={(e) => pick(e.target.value)}>
          <option value="">Choose…</option>
          {purposes.map((p) => <option key={p} value={p}>{p}</option>)}
        </Combo>
      </div>
      {channels.includes('Email') && (
        <div className="field">
          <label>Email subject</label>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
      )}
      <div className="field">
        <label>Message</label>
        <textarea rows="6" value={body} onChange={(e) => setBody(e.target.value)} />
        <span className="small-muted">
          <code>{'{firstName}'}</code> and <code>{'{name}'}</code> are replaced with each {noun}&apos;s own name.
          {channels.some((c) => c !== 'Email') ? ' SMS / WhatsApp use the approved bulk template set in Integrations (the message fills its one variable).' : ''}
        </span>
      </div>
      {off.length > 0 && (
        <div className="notice amber">
          {off.join(' and ')} {off.length > 1 ? 'are' : 'is'} not configured — those rows will be reported as
          &quot;Not configured&quot; and nothing is sent on {off.length > 1 ? 'them' : 'it'}. An administrator sets
          {off.length > 1 ? ' them' : ' it'} up in Administration → Integrations.
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}
