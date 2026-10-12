import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { Modal } from '../proto.jsx';
import StatusChip from '../ui/StatusChip.jsx';
import './autoMsg.css';

// ---------------------------------------------------------------------------
// SCHEDULED MESSAGES - the messages the app sends by itself when someone moves
// to the next step: what is waiting, what went, what did not and why.
//
//   <ScheduledMessages />                      all, with filters (Message templates -> Automatic messages)
//   <ScheduledMessages candidateId={id} compact />   one person (candidate page, drawer)
//
// Buttons are always visible (no menus): Approve & send, Send now, Change the words,
// Cancel, Pause this person. The server decides who may press what (row.can) and which
// rows a login may see; nobody here is ever shown a phone number or an email address.
// ---------------------------------------------------------------------------

const TONE = { SCHEDULED: 'blue', WAITING_APPROVAL: 'yellow', SENDING: 'blue', SENT: 'green', FAILED: 'red', CANCELLED: 'grey', SKIPPED: 'yellow' };
const DELIVERY_WORD = {
  QUEUED: ['Sending', 'blue'], RETRY: ['Trying again', 'yellow'], SENT: ['Sent', 'green'], DELIVERED: ['Delivered', 'green'], READ: ['Read', 'green'], FAILED: ['Could not send', 'red'],
  NOT_SENT_NO_PROVIDER: ['Not sent: not connected', 'yellow'], NOT_SENT_SWITCHED_OFF: ['Not sent: candidate emails are off', 'yellow'], NOT_SENT_BLOCKED: ['Not sent: blocked', 'yellow'],
};
export const clock = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', {
  day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
}) : '');

function timeLine(r) {
  if (r.status === 'SCHEDULED') return `Goes ${clock(r.sendAt)}`;
  if (r.status === 'WAITING_APPROVAL') return 'Waits for an OK before it goes';
  if (r.status === 'SENT') return `Handed over ${clock(r.sentAt || r.createdAt)}`;
  return clock(r.createdAt);
}

export function EditWords({ row, onClose, onSaved }) {
  const [subject, setSubject] = useState(row.subject || '');
  const [body, setBody] = useState(row.body || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const hasEmail = row.channels.includes('Email');
  async function save() {
    setBusy(true); setErr('');
    try {
      const r = await api.post(`/auto-messages/scheduled/${row.id}/edit`, { subject, body });
      onSaved(r.data.row);
    } catch (e) { setErr(e.response?.data?.error || 'Could not save.'); } finally { setBusy(false); }
  }
  return (
    <Modal
      title={`Change the words for ${row.candidateName}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
          <button type="button" className="btn btn-primary" disabled={busy || !body.trim()} onClick={save}>{busy ? 'Saving…' : 'Save the words'}</button>
        </>
      )}
    >
      <div className="am-help" style={{ marginBottom: 8 }}>
        These words go in the email. A WhatsApp or SMS message that needs a registered template keeps the approved template words.
        You can use details like {'{{firstName}}'}, {'{{role}}'} and {'{{recruiterName}}'}: they are filled in when it goes.
      </div>
      {hasEmail && (
        <div className="am-field" style={{ marginBottom: 8 }}>
          <label htmlFor="am-subj">Email subject</label>
          <input id="am-subj" type="text" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
        </div>
      )}
      <div className="am-field">
        <label htmlFor="am-body">Message</label>
        <textarea id="am-body" rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="am-help">{body.length} of 3000 letters</div>
      </div>
      {err && <div className="msg-box red">{err}</div>}
    </Modal>
  );
}

export default function ScheduledMessages({
  candidateId, applicationId, compact = false, onChanged, title,
}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [f, setF] = useState({});
  const [range, setRange] = useState('all');
  const [busy, setBusy] = useState('');
  const [flash, setFlash] = useState('');
  const [edit, setEdit] = useState(null);
  const [page, setPage] = useState(1);

  const params = useMemo(() => {
    const p = { pageSize: compact ? 20 : 25, page };
    if (candidateId) p.candidateId = candidateId;
    if (applicationId) p.applicationId = applicationId;
    Object.entries(f).forEach(([k, v]) => { if (v) p[k] = v; });
    const day = (d) => new Date(Date.now() + 330 * 60000 + d * 86400000).toISOString().slice(0, 10);
    if (range === 'today') { p.from = day(0); p.to = day(0); }
    if (range === 'week') { p.from = day(-6); p.to = day(7); }
    return p;
  }, [candidateId, applicationId, f, range, compact, page]);

  const load = useCallback(() => api.get('/auto-messages/scheduled', { params })
    .then((r) => { setData(r.data); setError(''); })
    .catch((e) => { setData(null); setError(e.response?.status === 503 ? 'Automatic messages are being set up on this server.' : (e.response?.data?.error || 'Could not load the messages.')); }), [params]);
  useEffect(() => { load(); }, [load]);

  async function act(row, what, body) {
    setBusy(`${row.id}:${what}`); setFlash('');
    try {
      const r = await api.post(`/auto-messages/scheduled/${row.id}/${what}`, body || {});
      const o = r.data.row;
      const sentOk = o && o.status === 'SENT';
      const notSent = o && o.status !== 'SENT' ? `Not sent: ${o.statusReason || 'see the reason on the card'}` : '';
      const words = { 'send-now': sentOk ? 'Handed over for sending.' : notSent, approve: sentOk ? 'Approved and handed over for sending.' : notSent, cancel: 'Cancelled. Nothing will go.' };
      setFlash(words[what] || 'Done.');
      await load();
      if (onChanged) onChanged();
    } catch (e) { setFlash(e.response?.data?.error || 'That did not work.'); } finally { setBusy(''); }
  }
  async function pause(row, paused) {
    setBusy(`${row.id}:pause`); setFlash('');
    try {
      const r = await api.post(`/auto-messages/people/${row.candidateId}/pause`, { paused });
      setFlash(paused ? `Paused. ${row.candidateName} gets no more automatic messages${r.data.cancelled ? ` (${r.data.cancelled} waiting message${r.data.cancelled === 1 ? '' : 's'} cancelled)` : ''}.` : `Resumed. ${row.candidateName} gets automatic messages again.`);
      await load();
      if (onChanged) onChanged();
    } catch (e) { setFlash(e.response?.data?.error || 'That did not work.'); } finally { setBusy(''); }
  }

  if (error) return <div className="msg-box orange">{error}</div>;
  if (!data) return <div className="small-muted">Loading…</div>;
  const set = (k, v) => { setPage(1); setF((x) => ({ ...x, [k]: x[k] === v ? '' : v })); };
  const Facet = ({ k, label, items }) => (items && items.length > 0 ? (
    <div className="am-frow">
      <span className="am-flabel">{label}</span>
      {items.map((it) => (
        <button key={it.value} type="button" className={`am-fchip${f[k] === it.value ? ' on' : ''}`} onClick={() => set(k, it.value)}>{it.label}<small>{it.count}</small></button>
      ))}
    </div>
  ) : null);
  const c = data.counts;

  return (
    <div className="am-sched">
      {title && <div className="section-label">{title}</div>}
      {!compact && (
        <>
          <div className="am-counts">
            <span><b>{c.waitingApproval}</b>need an OK</span>
            <span><b>{c.scheduled}</b>waiting to go</span>
            <span><b>{c.sent}</b>sent</span>
            <span><b>{c.notSent}</b>not sent</span>
            {c.problems > 0 && <span style={{ color: '#8a1c14' }}><b>{c.problems}</b>with a problem</span>}
          </div>
          <div className="am-filters">
            <div className="am-frow">
              <span className="am-flabel">When</span>
              {[['all', 'Any time'], ['today', 'Today'], ['week', 'This week']].map(([k, label]) => (
                <button key={k} type="button" className={`am-fchip${range === k ? ' on' : ''}`} onClick={() => { setRange(k); setPage(1); }}>{label}</button>
              ))}
            </div>
            <Facet k="status" label="Status" items={data.facets.statuses} />
            <Facet k="stage" label="Step" items={data.facets.stages} />
            <Facet k="channel" label="Sent by" items={data.facets.channels} />
            <Facet k="department" label="Department" items={data.facets.departments} />
          </div>
        </>
      )}
      {flash && <div className="msg-box blue" role="status">{flash}</div>}
      <div className="am-list">
        {data.rows.map((r) => (
          <div key={r.id} className={`am-row s-${r.status}`}>
            <div className="am-rtop">
              <span className="am-who">{r.candidateName}</span>
              <span className="small-muted">{r.jobTitle ? `${r.jobTitle} · ` : ''}{r.stageFromLabel ? `${r.stageFromLabel} → ` : ''}{r.stageLabel}</span>
              <StatusChip tone={TONE[r.status] || 'grey'}>{r.statusWord}</StatusChip>
              {r.aiWritten && <span className="am-chip ai" title="The AI wrote these words and the safety check passed">AI-written</span>}
              {r.edited && <span className="am-chip">Reworded</span>}
              {r.paused && <span className="am-chip warn">Paused</span>}
            </div>
            <div className="am-rmeta">{timeLine(r)} · by {r.channels.join(r.strategy === 'all' ? ' + ' : ' then ')}{r.wording === 'AI' ? ' · AI writes it' : ''}</div>
            {r.reason && <div className={`am-reason${r.status === 'FAILED' ? ' bad' : ''}`}>{r.reason}</div>}
            {r.aiNote && r.status !== 'SENT' && <div className="am-help">{r.aiNote}</div>}
            {(r.body || r.previewNote) && (
              <div className="am-body">
                {r.subject && <div className="am-sub">{r.subject}</div>}
                {r.body || r.previewNote}
              </div>
            )}
            {r.delivery.length > 0 && (
              <div className="am-deliv">
                {r.delivery.map((d, i) => { const w = DELIVERY_WORD[d.status] || [d.status, 'grey']; return <span key={i} title={d.detail || ''}><b>{d.channel}</b> <StatusChip tone={w[1]}>{w[0]}</StatusChip></span>; })}
              </div>
            )}
            <div className="am-btns">
              {r.can.approve && <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => act(r, 'approve')}>{busy === `${r.id}:approve` ? 'Sending…' : 'Approve & send'}</button>}
              {r.can.sendNow && r.status !== 'WAITING_APPROVAL' && <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => act(r, 'send-now')}>{busy === `${r.id}:send-now` ? 'Sending…' : 'Send now'}</button>}
              {r.can.edit && <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => setEdit(r)}>Change the words</button>}
              {r.can.cancel && <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => act(r, 'cancel')}>Cancel</button>}
              {r.can.pause && <button type="button" className="btn btn-sm btn-ghost" disabled={!!busy} onClick={() => pause(r, true)}>Pause this person</button>}
              {r.can.resume && <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => pause(r, false)}>Resume this person</button>}
            </div>
          </div>
        ))}
        {!data.rows.length && (
          <div className="small-muted" style={{ padding: 10 }}>
            {candidateId ? 'No automatic messages for this person yet. When they move to the next step, the message shows here first.' : 'Nothing here yet. When a candidate moves to the next step, the message is planned here, and you can see it before it goes.'}
          </div>
        )}
      </div>
      {data.total > data.pageSize && (
        <div className="am-btns">
          <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Newer</button>
          <span className="small-muted" style={{ alignSelf: 'center' }}>Page {page} of {Math.ceil(data.total / data.pageSize)}</span>
          <button type="button" className="btn btn-sm" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>Older</button>
        </div>
      )}
      {edit && <EditWords row={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); setFlash('Saved. These words will go.'); load(); }} />}
    </div>
  );
}
