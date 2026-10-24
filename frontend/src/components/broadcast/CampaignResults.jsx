import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Modal from '../Modal.jsx';
import StatusChip from '../ui/StatusChip.jsx';
import './broadcast.css';

// ---------------------------------------------------------------------------
// CAMPAIGN RESULTS — the responses, clearly: big tiles (Sent / Delivered / Read / Replied / Interested / Not interested /
// Opted out / Failed with counts and %), a live progress bar, the Replies (newest first) with what each one means,
// one-click Reply and Add as candidate, "Add all interested", filters with counts, a timeline, Excel / PDF.
// Server: GET /job-broadcast/campaigns/:id (+ ?status= &intent= &from= &to=), POST .../add-candidates, .../replies/:rid/reply.
// ---------------------------------------------------------------------------
const TILES = [['sent', 'Sent', 'blue'], ['delivered', 'Delivered', 'blue'], ['read', 'Read', 'blue'], ['replied', 'Replied', 'green'], ['interested', 'Interested', 'green'], ['not_interested', 'Not interested', 'orange'], ['optout', 'Opted out', 'red'], ['failed', 'Failed', 'red']];
const INTENT_TONE = { interested: 'green', not_interested: 'yellow', question: 'blue', optout: 'red' };
const ROW_WORDS = { queued: 'Waiting', sending: 'With WhatsApp', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed', skipped: 'Skipped' };
const ROW_TONE = { queued: 'yellow', sending: 'blue', sent: 'blue', delivered: 'blue', read: 'green', failed: 'red', skipped: 'grey' };
const STATUS_TONE = { DRAFT: 'grey', SCHEDULED: 'blue', RUNNING: 'blue', PAUSED: 'yellow', DONE: 'green', CANCELLED: 'grey' };
const STATUS_WORDS = { DRAFT: 'Not started', SCHEDULED: 'Scheduled', RUNNING: 'Sending', PAUSED: 'Paused', DONE: 'Finished', CANCELLED: 'Cancelled' };
const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

async function withConfirm(fn) {
  try { return await fn({}); } catch (e) {
    if (e.response?.status === 409 && e.response.data?.code === 'ACT_CONFIRM_SEND' && window.confirm(e.response.data.error)) return fn({ 'X-Act-Confirm': 'send' });
    throw e;
  }
}

export default function CampaignResults({ id, canRun, onClose, onChanged }) {
  const [d, setD] = useState(null);
  const [intent, setIntent] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [view, setView] = useState('replies');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [reply, setReply] = useState(null);
  const [showAdd, setShowAdd] = useState(false); // the old "Add as candidate" buttons: hidden unless an Admin switched them on (bc.settings.showAddAsCandidate)
  const [replyText, setReplyText] = useState('');
  const timer = useRef(null);

  const load = () => api.get(`/job-broadcast/campaigns/${id}`, { params: { intent: intent || undefined, status: status || undefined, from: from || undefined, to: to || undefined } })
    .then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(e.response?.data?.error || 'Could not load the results.'));
  useEffect(() => { load(); }, [id, intent, status, from, to]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.get('/job-broadcast/settings').then((r) => setShowAdd(!!(r.data.settings && r.data.settings.showAddAsCandidate))).catch(() => setShowAdd(false)); }, []);
  useEffect(() => {
    if (!d || !['RUNNING', 'SCHEDULED'].includes(d.campaign.status)) return undefined;
    timer.current = setTimeout(load, 5000);
    return () => clearTimeout(timer.current);
  }, [d]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(key, fn, okMsg) {
    setBusy(key); setErr(''); setMsg('');
    try { const r = await fn(); setMsg(okMsg ? okMsg(r) : 'Done.'); await load(); if (onChanged) onChanged(); } catch (e) { setErr(e.response?.data?.error || 'That did not work. Please try again.'); } finally { setBusy(''); }
  }
  const command = (name, word) => act(name, () => withConfirm((h) => api.post(`/job-broadcast/campaigns/${id}/${name}`, {}, { headers: h })), () => word);
  const add = (ids) => act('add', () => api.post(`/job-broadcast/campaigns/${id}/add-candidates`, ids === 'all' ? { all: true } : { replyIds: ids }),
    (r) => `Added ${r.data.added} ${r.data.added === 1 ? 'person' : 'people'} as candidates (Source: WhatsApp campaign). They are asked for their salary at the first step.`);
  const sendReply = () => act('reply', () => withConfirm((h) => api.post(`/job-broadcast/campaigns/${id}/replies/${reply.id}/reply`, { text: replyText }, { headers: h })), () => { setReply(null); setReplyText(''); return 'Reply sent.'; });
  const download = async (format) => {
    try {
      const r = await api.get(`/job-broadcast/campaigns/${id}/download`, { params: { format }, responseType: 'blob' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(r.data); a.download = `campaign-results.${format === 'pdf' ? 'pdf' : 'xlsx'}`; a.click();
    } catch { setErr('The file could not be made.'); }
  };

  if (!d) return <Modal title="Campaign results" size="xwide" onClose={onClose}><div className="bc-note">{err || 'Loading…'}</div></Modal>;
  const c = d.campaign;
  const interestedOpen = d.replies.filter((x) => x.intent === 'interested' && !x.added).length;
  const statusChips = [['', 'All'], ['queued', 'Waiting'], ['sending', 'With WhatsApp'], ['sent', 'Sent'], ['delivered', 'Delivered'], ['read', 'Read'], ['replied', 'Replied'], ['failed', 'Failed'], ['skipped', 'Skipped']];
  const countOf = (k) => (k === '' ? d.rows.length : k === 'replied' ? d.tiles.replied.n : (d.by[k] || 0));

  return (
    <Modal title={`${c.jobTitle} → ${c.listName}`} size="xwide" onClose={onClose} foot={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      <div className="bc-row" style={{ marginTop: 0 }}>
        <StatusChip tone={STATUS_TONE[c.status]}>{STATUS_WORDS[c.status]}</StatusChip>
        <span className="bc-note">{`${d.done} of ${d.planned} people done${d.skipped.length ? ` · ${d.skipped.reduce((a, b) => a + b.n, 0)} skipped` : ''}`}</span>
        <span style={{ flex: 1 }} />
        {canRun && ['RUNNING', 'SCHEDULED'].includes(c.status) && <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => command('pause', 'Paused.')}>Pause</button>}
        {canRun && c.status === 'PAUSED' && <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => command('resume', 'Sending again.')}>Resume</button>}
        {canRun && ['RUNNING', 'SCHEDULED', 'PAUSED', 'DRAFT'].includes(c.status) && <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => { if (window.confirm('Cancel this send? People who were not messaged yet will not get it.')) command('cancel', 'Cancelled.'); }}>Cancel</button>}
        <button type="button" className="btn btn-sm" onClick={() => download('xlsx')}>Download Excel</button>
        <button type="button" className="btn btn-sm" onClick={() => download('pdf')}>Download PDF</button>
      </div>
      <div className="bc-bar" role="progressbar" aria-valuenow={d.progress} aria-valuemin="0" aria-valuemax="100"><i style={{ width: `${d.progress}%` }} /></div>
      <div className="bc-note" style={{ marginTop: 4 }}>{d.progress}% sent{['RUNNING', 'SCHEDULED'].includes(c.status) ? ' · this page updates by itself' : ''}{c.note ? ` · ${c.note}` : ''}</div>
      {msg && <div className="bc-ok" role="status">{msg}</div>}
      {err && <div className="bc-err" role="alert">{err}</div>}

      <div className="bc-tiles">
        {TILES.map(([k, l, tone]) => (
          <div key={k} className={`bc-tile ${tone}`}><div className="n">{d.tiles[k].n.toLocaleString('en-IN')}</div><div className="l">{l}</div><div className="p">{k === 'sent' ? 'messages went out' : `${d.tiles[k].pct}% of sent`}</div></div>
        ))}
      </div>

      <div className="bc-tabs">
        {[['replies', `Replies (${d.tiles.replied.n})`], ['people', 'Everyone'], ['story', 'What happened']].map(([k, l]) => <button type="button" key={k} className={`bc-tab${view === k ? ' on' : ''}`} onClick={() => setView(k)}>{l}</button>)}
      </div>

      {view === 'replies' && (
        <>
          <div className="bc-row" style={{ marginTop: 0 }}>
            {[['', 'All'], ['interested', 'Interested'], ['not_interested', 'Not interested'], ['question', 'Questions'], ['optout', 'Opted out']].map(([k, l]) => (
              <button type="button" key={k} className={`bc-tab${intent === k ? ' on' : ''}`} onClick={() => setIntent(k)}>{l}<span className="bc-n">{k ? (d.intentCounts[k] || 0) : d.tiles.replied.n}</span></button>
            ))}
            <label className="bc-note">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="bc-note">to <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            {canRun && showAdd && interestedOpen > 0 && <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => add('all')}>{busy === 'add' ? 'Adding…' : `Add all interested as candidates (${interestedOpen})`}</button>}
          </div>
          {d.replies.length === 0 && <div className="bc-box bc-note">{c.status === 'DRAFT' ? 'Nothing sent yet.' : 'No replies yet. They show here the moment someone writes back, newest first.'}</div>}
          {d.replies.map((x) => (
            <div className="bc-reply" key={x.id}>
              <div className="t">
                <b>{x.name || 'Unknown'}</b> <span className="bc-note">{x.phone} · {when(x.at)}</span>
                <div>{x.text}</div>
              </div>
              <StatusChip tone={INTENT_TONE[x.intent]}>{x.intentWords}</StatusChip>
              {x.autoReplied && <span className="bc-note">Auto-replied</span>}
              {x.added && <Link className="btn btn-sm" to={`/candidates/${x.candidateId}`}>{x.added === 'created' ? 'Added: open profile' : 'Already a candidate: open'}</Link>}
              {canRun && x.intent !== 'optout' && <button type="button" className="btn btn-sm" onClick={() => { setReply(x); setReplyText(''); }}>Reply</button>}
              {canRun && showAdd && !x.added && x.intent !== 'optout' && <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => add([x.id])}>Add as candidate</button>}
            </div>
          ))}
        </>
      )}

      {view === 'people' && (
        <>
          <div className="bc-tabs">{statusChips.map(([k, l]) => <button type="button" key={k} className={`bc-tab${status === k ? ' on' : ''}`} onClick={() => setStatus(k)}>{l}<span className="bc-n">{countOf(k)}</span></button>)}</div>
          <div className="bc-scroll">
            <table className="bc-table">
              <thead><tr><th>Name</th><th>Phone</th><th>Status</th><th>Replied</th><th>Note</th></tr></thead>
              <tbody>{d.rows.map((x) => (
                <tr key={x.i}><td>{x.name}</td><td>{x.phone}</td><td><StatusChip tone={ROW_TONE[x.st]}>{ROW_WORDS[x.st]}</StatusChip></td><td>{x.replied ? 'Yes' : ''}</td><td className="bc-note">{x.why}</td></tr>
              ))}</tbody>
            </table>
          </div>
          {d.skipped.length > 0 && <div className="bc-note" style={{ marginTop: 6 }}>{`Skipped: ${d.skipped.map((s) => `${s.why} ${s.n}`).join(', ')}`}</div>}
        </>
      )}

      {view === 'story' && (
        <ul style={{ margin: 0, paddingLeft: 18 }}>{d.timeline.map((e, i) => <li key={i}><b>{when(e.at)}</b> · {e.text}</li>)}</ul>
      )}

      {reply && (
        <Modal title={`Reply to ${reply.name || 'this person'}`} onClose={() => setReply(null)} foot={(
          <><button type="button" className="btn" onClick={() => setReply(null)}>Cancel</button><button type="button" className="btn btn-primary" disabled={!replyText.trim() || !!busy} onClick={sendReply}>{busy === 'reply' ? 'Sending…' : 'Send reply'}</button></>
        )}
        >
          <div className="bc-reply"><div className="t"><div>{reply.text}</div></div></div>
          <textarea className="bc-text short" value={replyText} onChange={(e) => setReplyText(e.target.value)} placeholder="Write your reply" aria-label="Your reply" />
          <div className="bc-note">WhatsApp lets you write freely for 24 hours after they wrote to you. If it is later, the send is refused and we say so. A "Reply STOP to stop" line is added.</div>
        </Modal>
      )}
    </Modal>
  );
}
