import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';

// ---------------------------------------------------------------------------
// WHO RECEIVES THE RESPONSES (founder 2026-11-20): the department TL ticks the recruiters of their team who get the people who
// apply by themselves (Job Portal, careers page, job boards, WhatsApp / AI apply links). Kept apart from the assigned recruiters
// (they work and source the job). Server: GET / PUT /requirements/:id/response-recipients (utils/responseRecipients.js).
//   RecipientsChecklist   the tick list with the "All assigned recruiters" quick pick
//   PostRecipientsStep    the first screen of the Post window: (assigned recruiters) + who receives the responses -> Next
//   ResponsesGoToCard     the Team tab: "Responses go to: ... Change" with a reason, and the changes
// ---------------------------------------------------------------------------

export function useResponseRecipients(jobId, { options = false } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    if (!jobId) return Promise.resolve(null);
    return api.get(`/requirements/${jobId}/response-recipients`, { params: options ? { options: 1 } : {} })
      .then((r) => { setData(r.data); setError(''); return r.data; })
      .catch((e) => { setError(e.response?.data?.error || 'Could not load who receives the responses.'); setData(null); return null; });
  }, [jobId, options]);
  useEffect(() => { load(); }, [load]);
  return { data, error, reload: load };
}

const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
export const namesLine = (people) => (people || []).map((p) => `${p.name}${p.left ? ' (left)' : ''}`).join(', ');

export function RecipientsChecklist({ groups, value, onChange, assignedIds = [], disabled = false, quickPick = true, label = 'Responses to' }) {
  const all = useMemo(() => (groups || []).flatMap((g) => g.people), [groups]);
  const assignedHere = all.filter((p) => assignedIds.includes(p.id)).map((p) => p.id);
  const toggle = (id) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div className="field rr-list">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
        {quickPick && <button type="button" className="btn btn-sm" disabled={disabled || !assignedHere.length} onClick={() => onChange([...new Set(assignedHere)])} title={assignedHere.length ? 'Tick exactly the recruiters assigned to this job' : 'No recruiter is assigned to this job yet'}>
          All assigned recruiters
        </button>}
        {quickPick && value.length > 0 && <button type="button" className="btn btn-sm btn-ghost" disabled={disabled} onClick={() => onChange([])}>Clear</button>}
        <span className="small-muted">{`${value.length} ticked`}</span>
      </div>
      <div style={{ maxHeight: 240, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 8, padding: 8 }}>
        {!groups && <div className="small-muted">Loading…</div>}
        {groups && !all.length && <div className="small-muted">No recruiter in your team.</div>}
        {(groups || []).map((g) => (
          <div key={g.key} style={{ marginBottom: 6 }}>
            {(groups.length > 1 || g.key !== 'mine') && <div className="small-muted" style={{ fontWeight: 600, margin: '2px 0' }}>{g.label}</div>}
            {g.people.map((p) => (
              <label key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400, padding: '3px 0' }}>
                <input type="checkbox" checked={value.includes(p.id)} disabled={disabled} onChange={() => toggle(p.id)} style={{ width: 'auto' }} aria-label={`${label} ${p.name}`} />
                <span>{p.name}</span>
                {p.seat && <span className="small-muted">{p.seat}</span>}
                {p.assigned && <span className="chip" style={{ fontSize: 11 }}>assigned</span>}
              </label>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// The first screen of the Post window. job: { id, recruiterId, recruiterIds }. canAssign: also show "Assigned recruiters" (POST /assign).
// onDone({ people, names }) once the recipients are saved (or already right); the caller then shows where to post.
export function PostRecipientsStep({ job, canAssign = false, onDone, nextLabel = 'Next — choose where to post' }) {
  const { data, error } = useResponseRecipients(job.id, { options: true });
  const [assigned, setAssigned] = useState(null);
  const [ticks, setTicks] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!data || ticks !== null) return;
    const optIds = (data.options || []).flatMap((g) => g.people.map((p) => p.id));
    setAssigned(data.assignedIds || []);
    // the recipients already chosen, else the assigned recruiters (ticked by default)
    setTicks(data.set ? data.ids : (data.assignedIds || []).filter((id) => optIds.includes(id)));
  }, [data, ticks]);
  // someone chosen earlier who is not in this login's list (an Admin picked them) still shows, ticked
  const groups = useMemo(() => {
    if (!data) return null;
    const opts = data.options || [];
    const seen = new Set(opts.flatMap((g) => g.people.map((p) => p.id)));
    const earlier = (data.people || []).filter((p) => !seen.has(p.id)).map((p) => ({ id: p.id, name: `${p.name}${p.left ? ' (left)' : ''}`, seat: null, assigned: (data.assignedIds || []).includes(p.id) }));
    return earlier.length ? [...opts, { key: 'earlier', label: 'Chosen earlier', people: earlier }] : opts;
  }, [data]);

  if (error) return <div className="notice amber" style={{ margin: 16 }}>{error}</div>;
  if (!data || ticks === null) return <div className="small-muted" style={{ padding: 16 }}>Loading…</div>;
  const changedList = data.set && !same(ticks, data.ids);
  const assignChanged = canAssign && assigned && !same(assigned, data.assignedIds || []);

  async function next() {
    setErr('');
    if (!data.canChange) { onDone({ people: data.people, names: namesLine(data.people) }); return; }
    if (!ticks.length) { setErr('Tick at least one recruiter who receives the responses.'); return; }
    if (changedList && reason.trim().length < 3) { setErr('Say why the responses go to other people (a short reason).'); return; }
    setBusy(true);
    try {
      if (assignChanged) {
        // the main recruiter stays first when still ticked
        const keepMain = assigned.includes(job.recruiterId) ? [job.recruiterId, ...assigned.filter((x) => x !== job.recruiterId)] : assigned;
        await api.post(`/requirements/${job.id}/assign`, { recruiterId: keepMain[0] || null, recruiterIds: keepMain.slice(1) });
      }
      let out = data;
      if (!data.set || changedList) out = (await api.put(`/requirements/${job.id}/response-recipients`, { userIds: ticks, reason: reason.trim() || undefined })).data;
      onDone({ people: out.people, names: namesLine(out.people) });
    } catch (e) {
      setErr(e.response?.data?.error || 'Could not save who receives the responses. Please try again.');
    } finally { setBusy(false); }
  }

  if (!data.canChange) {
    return (
      <div style={{ padding: 16, maxWidth: 560 }}>
        <h4 style={{ margin: '0 0 6px' }}>Who receives the responses</h4>
        {data.set
          ? <div>{`Responses go to: ${namesLine(data.people)}.`}</div>
          : <div className="notice amber">{data.required ? 'The job\'s team lead (or an Admin) chooses who receives the responses. It can be posted once they have.' : 'Not chosen: the responses go to the job\'s recruiter, as before.'}</div>}
        <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} disabled={!data.set && data.required} onClick={next}>{nextLabel}</button>
      </div>
    );
  }

  return (
    <div style={{ padding: 16, maxWidth: 620 }} data-testid="post-recipients">
      {canAssign && (
        <div style={{ marginBottom: 14 }}>
          <h4 style={{ margin: '0 0 2px' }}>Assigned recruiters</h4>
          <div className="small-muted" style={{ marginBottom: 6 }}>They work this job and source for it, as before.</div>
          <RecipientsChecklist groups={data.options || []} value={assigned || []} onChange={setAssigned} assignedIds={data.assignedIds || []} quickPick={false} label="Assign" />
        </div>
      )}
      <h4 style={{ margin: '0 0 2px' }}>Who receives the responses</h4>
      <div className="small-muted" style={{ marginBottom: 6 }}>
        The people who apply by themselves (on the Job Portal, our careers page, Naukri, Indeed, LinkedIn and the other job boards, or a WhatsApp / AI apply link) go to these recruiters, one by one in turn. Needed before posting.
      </div>
      <RecipientsChecklist groups={groups} value={ticks} onChange={(v) => { setTicks(v); setErr(''); }} assignedIds={canAssign && assigned ? assigned : (data.assignedIds || [])} />
      {changedList && (
        <label className="field" style={{ marginTop: 8 }}>
          <span>Why the change</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Kavya is on leave this week" />
        </label>
      )}
      {err && <div className="error-text" role="alert" style={{ marginTop: 6 }}>{err}</div>}
      <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} disabled={busy} onClick={next}>{busy ? 'Saving…' : nextLabel}</button>
    </div>
  );
}

const when = (iso) => { try { return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return iso; } };
const KIND = { set: 'Set', change: 'Changed', left: 'Recipient left', removed: 'Removed' };

// The Team tab card: "Assigned recruiters" next to "Responses go to", Change (with a reason), and the last changes.
export function ResponsesGoToCard({ job, onChanged }) {
  const { data, error, reload } = useResponseRecipients(job.id);
  const [open, setOpen] = useState(false);
  if (error) return null;
  return (
    <div className="card section" data-testid="responses-go-to">
      <h3 style={{ fontSize: 13, marginBottom: 8 }}>Responses</h3>
      {!data && <div className="small-muted">Loading…</div>}
      {data && (
        <>
          <div className="kv"><span className="k">Assigned recruiters</span><span>{data.assigned.length ? namesLine(data.assigned) : '—'}</span></div>
          <div className="kv">
            <span className="k">Responses go to</span>
            <span>
              {data.set ? namesLine(data.people) : <span className="small-muted">{data.required ? 'Not chosen yet - choose them before posting' : 'Not chosen: the job\'s recruiter, as before'}</span>}
              {data.canChange && <button type="button" className="link-btn" style={{ marginLeft: 8 }} onClick={() => setOpen(true)}>Change</button>}
            </span>
          </div>
          {data.set && data.setBy && <div className="small-muted" style={{ marginTop: 4 }}>{`Last set by ${data.setBy}${data.setAt ? ` on ${when(data.setAt)}` : ''}${data.reason ? ` - ${data.reason}` : ''}`}</div>}
          {data.history.length > 0 && (
            <details style={{ marginTop: 6 }}>
              <summary className="small-muted">{`Changes (${data.history.length})`}</summary>
              <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                {data.history.slice(0, 10).map((h) => (
                  <li key={`${h.at}-${h.kind}`} className="small-muted" style={{ marginBottom: 2 }}>
                    {`${when(h.at)} · ${KIND[h.kind] || h.kind} by ${h.by}: ${h.fromNames || 'not set'} → ${h.toNames || 'not set'}${h.reason ? ` (${h.reason})` : ''}`}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {open && (
        <Modal title={`Who receives the responses — ${job.reqCode || job.title}`} size="wide" onClose={() => setOpen(false)}>
          <PostRecipientsStep job={job} nextLabel="Save" onDone={() => { setOpen(false); reload(); if (onChanged) onChanged(); }} />
        </Modal>
      )}
    </div>
  );
}
