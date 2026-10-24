import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import './jobdup.css';
import Combo from '../Combo.jsx';

// ---------------------------------------------------------------------------
// DUPLICATE JOBS — a tab inside Clients & Requirements > Jobs (no sidebar entry).  (user, 2026-10-13)
//   JobDupTabs   the strip  [ Jobs ] [ Duplicate jobs (3) ]  — only for logins that may open it; the red number = what needs a look
//   JobDupWorklist  Must sort out · Likely · Maybe · Done; filters that narrow each other (with counts); grouped by client;
//                   each pair side by side; separate buttons: Merge into the kept job · Not a duplicate · Close the extra only;
//                   "Merge all the obvious ones" (a list to approve); Recent merges with Undo (7 days).
//   JobDupNote   a small note on a job for a TL / Recruiter / Manager: "Possible duplicate" + "Ask the client manager to merge"
// Plain words: Job, Step, People. Nothing is deleted: the extra job is joined into the kept one and closed.
// ---------------------------------------------------------------------------
const err = (e, fallback) => e?.response?.data?.error || fallback;
const day = (v) => { try { return new Date(v).toISOString().slice(0, 10); } catch { return ''; } };
const TAB_WORDS = { must: 'Must sort out', likely: 'Likely', maybe: 'Maybe', done: 'Done' };

// --- the strip on Jobs -----------------------------------------------------------------------------------------------
export function useJobDupStatus() {
  const [st, setSt] = useState(null);
  const load = useCallback(() => api.get('/job-duplicates/status').then((r) => setSt(r.data)).catch(() => setSt({ visible: false })), []);
  useEffect(() => { load(); }, [load]);
  return [st, load];
}
// postTab (optional, job publishing): { show, active, onPick } adds a third tab "Posting" to the same strip.
export function JobDupTabs({ status, active, onPick, postTab }) {
  const dup = !!(status && status.visible);
  if (!dup && !(postTab && postTab.show)) return null;
  const post = !!(postTab && postTab.active);
  return (
    <div className="jdup-tabs" role="tablist" aria-label="Requirements views">
      <button type="button" role="tab" aria-selected={!active && !post} className={!active && !post ? 'is-on' : ''} onClick={() => onPick(false)}>Requirements</button>
      {dup && (
        <button type="button" role="tab" aria-selected={!!active} className={active ? 'is-on' : ''} onClick={() => onPick(true)}>
          Duplicate requirements{status.badge > 0 && <span className="jdup-badge" aria-label={`${status.badge} to look at`}>{status.badge}</span>}
        </button>
      )}
      {postTab && postTab.show && <button type="button" role="tab" aria-selected={post} className={post ? 'is-on' : ''} onClick={() => postTab.onPick(true)}>Posting</button>}
    </div>
  );
}

function Facet({ label, value, onChange, options, allLabel }) {
  if (!options || options.length === 0) return null;
  return (
    <Combo aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{allLabel}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{`${o.label} (${o.count})`}</option>)}
    </Combo>
  );
}

// --- one job, side by side ------------------------------------------------------------------------------------------------
function JobColumn({ job, keep, onKeep, name, canPick }) {
  const sites = (job.postings || []).map((p) => p.source).join(', ');
  return (
    <div className={`jdup-col${keep ? ' is-keep' : ''}`}>
      {canPick ? (
        <label className="jdup-keeplabel">
          <input type="radio" name={name} checked={keep} onChange={onKeep} />
          <span>{keep ? <span className="jdup-keeptag">Keep this one</span> : 'Keep this one instead'}</span>
        </label>
      ) : keep && <div className="jdup-keeptag">Suggested to keep</div>}
      <div className="jdup-name"><Link to={`/requirements/${job.id}`} target="_blank" rel="noreferrer">{job.title}</Link></div>
      <dl className="jdup-rows">
        <dt>Code</dt><dd>{job.reqCode || '-'}</dd>
        <dt>Status</dt><dd>{job.statusLabel}</dd>
        <dt>Openings</dt><dd>{job.openings}</dd>
        <dt>City</dt><dd>{job.location || 'Not given'}</dd>
        {job.specialisation && (<><dt>Subject</dt><dd>{job.specialisation}</dd></>)}
        {job.salary && (<><dt>Pay</dt><dd>{job.salary}</dd></>)}
        <dt>Opened</dt><dd>{day(job.createdAt)}</dd>
        <dt>Client manager</dt><dd>{job.bde || 'Not named'}</dd>
        <dt>Team lead</dt><dd>{job.tl || 'Not named'}</dd>
        <dt>Recruiter</dt><dd>{job.recruiter || 'Not named'}</dd>
        <dt>People</dt><dd>{job.candidates}</dd>
        {job.interviews > 0 && (<><dt>Interviews</dt><dd>{job.interviews}</dd></>)}
        {job.offers > 0 && (<><dt>Offers / joined</dt><dd>{job.offers} / {job.joined}</dd></>)}
        {job.invoices > 0 && (<><dt>Invoices</dt><dd>{job.invoices}</dd></>)}
        <dt>On sites</dt><dd>{sites || 'Not posted'}</dd>
      </dl>
      {job.steps.length > 0 && (
        <div className="jdup-steps">{job.steps.map((s) => <div key={s.step}><span>{s.label}</span><b>{s.count}</b></div>)}</div>
      )}
    </div>
  );
}

function Cluster({ c, tab, canResolve, canAsk, onDone }) {
  const [keep, setKeep] = useState(c.keptId);
  const [sum, setSum] = useState(false);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [bad, setBad] = useState('');
  const [askOpen, setAskOpen] = useState(false);
  const [ndOpen, setNdOpen] = useState(false);
  const [reason, setReason] = useState('');
  const kept = c.jobs.find((j) => j.id === keep) || c.jobs[0];
  const extras = c.jobs.filter((j) => j.id !== keep);
  const keepBlocked = extras.filter((j) => j.invoices > 0);

  async function run(kind, fn) {
    setBusy(kind); setBad(''); setMsg('');
    try { const r = await fn(); setMsg(r.data.message || 'Done.'); onDone(); } catch (e) { setBad(err(e, 'This did not work. Please try again.')); } finally { setBusy(''); }
  }
  const merge = () => run('merge', () => api.post('/job-duplicates/merge', { keptId: keep, extraIds: extras.map((j) => j.id), openings: sum ? 'sum' : 'max' }));
  const notDup = () => run('nd', () => api.post('/job-duplicates/not-duplicate', { jobIds: c.jobs.map((j) => j.id), reason }));
  const closeExtra = (j) => run(`close-${j.id}`, () => api.post('/job-duplicates/close-extra', { extraId: j.id, keptId: keep }));
  const ask = () => run('ask', () => api.post('/job-duplicates/ask-merge', { jobId: c.jobs[0].id, note: reason }));

  return (
    <div className={`jdup-set${tab === 'likely' ? ' is-likely' : tab === 'maybe' ? ' is-maybe' : ''}`}>
      <div className="jdup-why">{c.reasons.map((r) => <span key={r}>{r}</span>)}</div>
      <div className="jdup-cols">
        {c.jobs.map((j) => <JobColumn key={j.id} job={j} keep={j.id === keep} name={`keep-${c.id}`} canPick={canResolve} onKeep={() => setKeep(j.id)} />)}
      </div>
      {canResolve && (
        <>
          {keepBlocked.length > 0 && <div className="jdup-warn">{keepBlocked[0].reqCode} has an invoice, so it cannot be merged away. Tick &quot;Keep this one&quot; on that requirement.</div>}
          {c.blocked.length > 0 && keepBlocked.length === 0 && <div className="jdup-warn">{c.blocked[0]}</div>}
          <div className="jdup-actions">
            <button type="button" className="btn btn-primary" disabled={!!busy || keepBlocked.length > 0} onClick={merge}>
              {busy === 'merge' ? 'Joining…' : `Merge into the kept requirement (${kept.reqCode || kept.title})`}
            </button>
            <button type="button" className="btn" disabled={!!busy} onClick={() => { setNdOpen((v) => !v); setReason(''); }}>Not a duplicate</button>
            {extras.filter((j) => j.candidates === 0 && j.invoices === 0).map((j) => (
              <button key={j.id} type="button" className="btn" disabled={!!busy} onClick={() => closeExtra(j)}>{busy === `close-${j.id}` ? 'Closing…' : `Close ${j.reqCode || 'the extra'} only`}</button>
            ))}
            <label className="jdup-opt"><input type="checkbox" checked={sum} onChange={(e) => setSum(e.target.checked)} />Add the openings together (otherwise the larger number)</label>
          </div>
          {ndOpen && (
            <div className="jdup-ask">
              <input maxLength={300} placeholder="Why are these different requirements? e.g. two campuses" value={reason} onChange={(e) => setReason(e.target.value)} />
              <div className="jdup-actions" style={{ marginTop: 0 }}>
                <button type="button" className="btn btn-primary" disabled={!!busy || reason.trim().length < 3} onClick={notDup}>{busy === 'nd' ? 'Saving…' : 'Save: not a duplicate'}</button>
                <button type="button" className="btn btn-ghost" onClick={() => setNdOpen(false)}>Cancel</button>
              </div>
            </div>
          )}
        </>
      )}
      {!canResolve && canAsk && (
        <>
          <div className="jdup-actions">
            <button type="button" className="btn btn-primary" onClick={() => setAskOpen((v) => !v)}>Ask the client manager to merge</button>
          </div>
          {askOpen && (
            <div className="jdup-ask">
              <input maxLength={300} placeholder="A few words for the client manager (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
              <div className="jdup-actions" style={{ marginTop: 0 }}>
                <button type="button" className="btn btn-primary" disabled={!!busy} onClick={ask}>{busy === 'ask' ? 'Sending…' : 'Send'}</button>
                <button type="button" className="btn btn-ghost" onClick={() => setAskOpen(false)}>Cancel</button>
              </div>
            </div>
          )}
        </>
      )}
      {bad && <div className="notice red" style={{ marginTop: 8 }}>{bad}</div>}
      {msg && <div className="notice green" style={{ marginTop: 8 }}>{msg}</div>}
    </div>
  );
}

// --- Merge all the obvious ones ----------------------------------------------------------------------------------------------
function Obvious({ canResolve, onChanged }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [pick, setPick] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const load = () => api.get('/job-duplicates/auto-merge').then((r) => { setData(r.data); }).catch(() => setData({ proposals: [] }));
  useEffect(() => { if (open && !data) load(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  async function approve(body) {
    setBusy(true); setMsg('');
    try { const r = await api.post('/job-duplicates/auto-merge/approve', body); setMsg(r.data.message); setPick(new Set()); await load(); onChanged(); } catch (e) { setMsg(err(e, 'Could not merge.')); } finally { setBusy(false); }
  }
  const list = (data && data.proposals) || [];
  const ok = list.filter((p) => p.canApprove);
  return (
    <section className="jdup-sub">
      <h3>Merge all the obvious ones</h3>
      <div className="small-muted">Same client, same requirement, same city, both open. Nothing is merged until you approve; every merge can be undone for 7 days.</div>
      {!open && <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setOpen(true)}>Show the list</button>}
      {open && !data && <div className="small-muted" style={{ marginTop: 8 }}>Loading…</div>}
      {open && data && (
        <>
          {list.length === 0 && <div className="small-muted" style={{ marginTop: 8 }}>No obvious ones right now.</div>}
          {list.slice(0, 150).map((p) => (
            <div key={p.clusterId} className="jdup-prop">
              <label>
                {canResolve && p.canApprove && <input type="checkbox" checked={pick.has(p.clusterId)} onChange={(e) => setPick((s) => { const n = new Set(s); if (e.target.checked) n.add(p.clusterId); else n.delete(p.clusterId); return n; })} />}
                <span><b>{p.client}</b>{': '}{p.extras.map((e) => e.reqCode).join(', ')}{' joins '}<b>{p.kept.reqCode}</b> ({p.kept.title})</span>
              </label>
              <span className="small-muted">
                {p.willMove > 0 ? `${p.willMove} ${p.willMove === 1 ? 'person moves' : 'people move'}` : 'nobody to move'}
                {!p.canApprove && p.blocked.length ? ` · ${p.blocked[0]}` : ''}
              </span>
              {canResolve && p.canApprove && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => approve({ clusterIds: [p.clusterId] })}>Approve this one</button>}
            </div>
          ))}
          {canResolve && ok.length > 0 && (
            <div className="jdup-actions">
              <button type="button" className="btn btn-primary" disabled={busy || pick.size === 0} onClick={() => approve({ clusterIds: [...pick] })}>{busy ? 'Merging…' : `Approve ${pick.size || ''} ticked`}</button>
              <button type="button" className="btn" disabled={busy} onClick={() => setPick(new Set(ok.map((p) => p.clusterId)))}>Tick all I can approve</button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { if (window.confirm(`Merge all ${ok.length} obvious ones? Each can be undone for 7 days.`)) approve({ all: true }); }}>{`Approve all (${ok.length})`}</button>
            </div>
          )}
          {!canResolve && list.length > 0 && <div className="jdup-note">Only the client manager (BDE) team can approve these.</div>}
          {msg && <div className="notice" style={{ marginTop: 8 }}>{msg}</div>}
        </>
      )}
    </section>
  );
}

function Done({ data, canResolve, onChanged }) {
  const [msg, setMsg] = useState('');
  const [rows, setRows] = useState(data.merges || []);
  useEffect(() => { setRows(data.merges || []); }, [data]);
  async function undo(id) {
    setMsg('');
    try { const r = await api.post(`/job-duplicates/merges/${id}/undo`); setMsg(r.data.message); setRows((x) => x.map((m) => (m.id === id ? { ...m, status: 'UNDONE', canUndo: false } : m))); onChanged(); } catch (e) { setMsg(err(e, 'Could not undo.')); }
  }
  return (
    <>
      <section className="jdup-sub">
        <h3>Recent merges</h3>
        {rows.length === 0 && <div className="small-muted">Nothing has been merged yet.</div>}
        {rows.slice(0, 40).map((m) => (
          <div key={m.id} className="jdup-prop">
            <span>{m.summary}<span className="small-muted">{` · ${m.by || ''} · ${day(m.at)}`}</span></span>
            {m.status === 'UNDONE' ? <span className="small-muted">Undone</span>
              : m.canUndo && canResolve ? <button type="button" className="btn btn-sm" onClick={() => undo(m.id)}>Undo</button>
                : <span className="small-muted">{m.canUndo ? '' : 'Undo time is over'}</span>}
          </div>
        ))}
        {msg && <div className="notice" style={{ marginTop: 8 }}>{msg}</div>}
      </section>
      <section className="jdup-sub">
        <h3>Marked: not a duplicate</h3>
        {(data.decisions || []).length === 0 && <div className="small-muted">Nothing marked yet.</div>}
        {(data.decisions || []).slice(0, 40).map((d) => (
          <div key={d.id} className="jdup-prop">
            <span>{(d.a.reqCode || d.a.id)} and {(d.b.reqCode || d.b.id)}{d.a.title ? ` (${d.a.title})` : ''}<span className="small-muted">{` · ${d.reason || ''} · ${d.by || ''}`}</span></span>
          </div>
        ))}
      </section>
    </>
  );
}

// --- the tab ---------------------------------------------------------------------------------------------------------------
export default function JobDupWorklist({ onCountChange }) {
  const [tab, setTab] = useState('must');
  const [f, setF] = useState({ department: '', client: '', bde: '', tl: '', search: '' });
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  useEffect(() => { const t = setTimeout(() => setF((x) => ({ ...x, search: q })), 350); return () => clearTimeout(t); }, [q]);
  useEffect(() => { setPage(1); }, [tab, f.department, f.client, f.bde, f.tl, f.search]);
  useEffect(() => {
    seq.current += 1; const mine = seq.current;
    setLoading(true);
    const params = { tab, page, pageSize: 15, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) };
    api.get('/job-duplicates/worklist', { params })
      .then((r) => { if (mine === seq.current) { setData(r.data); setError(''); } })
      .catch((e) => { if (mine === seq.current) setError(err(e, 'Could not load the list.')); })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  }, [tab, page, f, tick]);

  const reload = () => { setTick((t) => t + 1); if (onCountChange) onCountChange(); };
  const counts = (data && data.counts) || {};
  const any = f.department || f.client || f.bde || f.tl || f.search;
  const setFilter = (k) => (v) => setF((x) => ({ ...x, [k]: v }));

  return (
    <div className="jdup-wrap">
      <div className="small-muted">Pick the requirement to keep. The other one is joined into it (its people move over) and closed. Nothing is deleted, and you can undo for 7 days.</div>
      <div className="jdup-tabs is-sub" role="tablist" aria-label="Duplicate requirements">
        {['must', 'likely', 'maybe', 'done'].map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-on' : ''} onClick={() => setTab(k)}>
            {TAB_WORDS[k]}{k !== 'done' && counts[k] > 0 && <span className={k === 'must' ? 'jdup-badge' : 'jdup-badge'} style={k === 'must' ? undefined : { background: k === 'likely' ? 'var(--amber,#9a6400)' : 'var(--navy,#0b3a6e)' }}>{counts[k]}</span>}
          </button>
        ))}
      </div>
      {tab !== 'done' && data && (
        <div className="jdup-filters">
          <Facet label="Department" value={f.department} onChange={setFilter('department')} options={data.facets.department} allLabel="All departments" />
          <Facet label="Client" value={f.client} onChange={setFilter('client')} options={data.facets.client} allLabel="All clients" />
          <Facet label="Client manager (BDE)" value={f.bde} onChange={setFilter('bde')} options={data.facets.bde} allLabel="All client managers" />
          <Facet label="Team lead" value={f.tl} onChange={setFilter('tl')} options={data.facets.tl} allLabel="All team leads" />
          <input type="search" aria-label="Search" placeholder="Search a client, requirement title or code" value={q} onChange={(e) => setQ(e.target.value)} />
          {any && <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setF({ department: '', client: '', bde: '', tl: '', search: '' }); setQ(''); }}>Clear filters</button>}
        </div>
      )}
      {tab === 'must' && data && <Obvious canResolve={data.canResolve} onChanged={reload} />}
      {error && <div className="notice red">{error}</div>}
      {!data && !error && <div className="small-muted">Loading…</div>}
      {data && data.supported === false && <div className="notice amber">Merging requirements needs a one-time update of the database. Ask the Super Admin. You can still look at the list.</div>}
      {data && tab === 'done' && <Done data={data} canResolve={data.canResolve} onChanged={reload} />}
      {data && tab !== 'done' && (
        <>
          {data.total === 0 && (
            <div className="jdup-empty">
              <b>{any ? 'Nothing matches these filters.' : tab === 'must' ? 'No duplicate requirements to sort out.' : 'Nothing here.'}</b>
              {any ? 'Clear a filter to see more.' : 'Every requirement is on its own.'}
            </div>
          )}
          {data.groups.map((g) => (
            <div key={g.clientId}>
              <div className="jdup-client">{g.client}</div>
              {g.clusters.map((c) => <Cluster key={c.id} c={c} tab={tab} canResolve={data.canResolve} canAsk={data.canAsk} onDone={reload} />)}
            </div>
          ))}
          {data.pages > 1 && (
            <div className="jdup-pager">
              <button type="button" className="btn btn-sm" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>Back</button>
              <span className="small-muted">{`Page ${data.page} of ${data.pages} · ${data.total} to look at`}</span>
              <button type="button" className="btn btn-sm" disabled={page >= data.pages || loading} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// --- the small note on a job -----------------------------------------------------------------------------------------------------
export function JobDupNote({ jobId, onOpenList }) {
  const [n, setN] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { let on = true; api.get(`/job-duplicates/job/${jobId}`).then((r) => { if (on) setN(r.data); }).catch(() => null); return () => { on = false; }; }, [jobId]);
  if (!n || !n.twin) return null;
  async function ask() {
    setBusy(true);
    try { const r = await api.post('/job-duplicates/ask-merge', { jobId }); setMsg(r.data.message); setN((x) => ({ ...x, asked: true })); } catch (e) { setMsg(err(e, 'Could not send.')); } finally { setBusy(false); }
  }
  return (
    <div className="jdup-jobnote" role="status">
      <span><b>Possible duplicate</b>{n.with.length ? ` of ${n.with.map((w) => w.reqCode || w.title).join(', ')}` : ''}. {n.canResolve ? 'You can merge them.' : 'Ask the client manager to check.'}</span>
      {n.canAsk && !n.asked && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={ask}>Ask the client manager to merge</button>}
      {n.canAsk && n.asked && <span className="small-muted">You asked. The client manager has it.</span>}
      {n.canResolve && onOpenList && <button type="button" className="btn btn-sm btn-primary" onClick={onOpenList}>Open Duplicate requirements</button>}
      {msg && <span className="small-muted">{msg}</span>}
    </div>
  );
}
