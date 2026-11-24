import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../../api';
import TabStrip from '../ui/TabStrip.jsx';
import { OutsideSearchY, JobChangesY } from '../atsY/SourcingToolsY.jsx'; // ATS wave 2 Y: Resdex + outside profiles, every job change seen
import { JobPickerCombo } from '../JobPicker.jsx';
import {
  M, Card, Chips, Flash, FlagAi, Empty, useGet, useRun, day, when,
} from './kit.jsx';

// ---------------------------------------------------------------------------
// CANDIDATES & PIPELINE > More > Hiring tools (market wave B). One tab strip (5 main, the rest under More):
//   Smart search    plain-words search with the filters shown (03.08) + saved searches with "new since" (03.09)
//   Talent pools    named lists, shared or own; add / remove many; add all to a requirement; review all (03.10 / 03.21)
//   Review queue    automatic decisions waiting for a person (09.17) + fraud / backdoor-hire flags (03.20 / 04.14)
//   Agents          task agents and the playbook: every proposed action waits for approval (09.08 / 09.09)
//   Bulk review     score up to 50 people against a job (03.21)
//   More: Placements (04.12 / 04.13) · Risk after joining (09.20) · Records to refresh (03.13 / 03.18)
// The server decides what each login sees (scope) and may change (Manager view only).
// ---------------------------------------------------------------------------
const TOOLS = [
  { key: 'search', label: 'Smart search', hint: 'Search in plain words; save a search and see who is new' },
  { key: 'pools', label: 'Talent pools', hint: 'Named lists of people: share, add many, add all to a job' },
  { key: 'review', label: 'Review queue', hint: 'Automatic decisions and checks waiting for a person' },
  { key: 'agents', label: 'Agents', hint: 'Agents propose; you approve each action' },
  { key: 'bulk', label: 'Bulk review', hint: 'Score many people against a requirement at once' },
  { key: 'placements', label: 'Placements', hint: 'Placement approval and temp-to-perm conversions', more: true },
  { key: 'risk', label: 'Risk after joining', hint: 'Joined people who may leave inside the guarantee', more: true },
  { key: 'records', label: 'Records to refresh', hint: 'Stale profiles, job changes, documents expiring', more: true },
  { key: 'outside', label: 'Outside search', hint: 'Naukri Resdex and outside profiles, brought onto a requirement', more: true },
];

function PeopleRows({ rows, pick, onPick }) {
  if (!rows.length) return <Empty>Nobody found.</Empty>;
  return (
    <div className="table-wrap mkb-table">
      <table className="table">
        <thead><tr>{onPick && <th aria-label="Pick" />}<th>Name</th><th>Role</th><th>Experience</th><th>Location</th><th>Skills</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              {onPick && <td><input type="checkbox" checked={!!pick[r.id]} onChange={(e) => onPick(r.id, e.target.checked)} aria-label={`Pick ${r.name}`} /></td>}
              <td><Link to={`/candidates/${r.id}`}>{r.name}</Link>{r.isNew && <span className="mkb-chip new" style={{ marginLeft: 6 }}>New</span>}</td>
              <td>{r.designation || '-'}</td>
              <td>{r.experienceYears != null ? `${r.experienceYears} yrs` : '-'}</td>
              <td>{r.location || '-'}</td>
              <td className="small-muted">{(r.skills || []).slice(0, 5).join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SmartSearch() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [name, setName] = useState('');
  const [alert, setAlert] = useState(false);
  const saved = useGet(`${M}/saved-searches`);
  const [open, setOpen] = useState(null);
  const { busy, msg, run } = useRun();
  const go = () => run(() => api.post(`${M}/nl-search`, { query: q })).then((r) => r && setRes(r.data));
  return (
    <div>
      <Card title="Search in plain words" testid="mkb-nl" note='For example: "java developers in hyderabad 5+ years notice 30 days" or "staff nurse icu chennai immediate joiners". The filters it understood are shown, so you can check them.'>
        <form className="mkb-row" onSubmit={(e) => { e.preventDefault(); go(); }}>
          <input className="mkb-grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Who are you looking for?" aria-label="Search in plain words" />
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || q.trim().length < 3}>Search</button>
        </form>
        {res && (
          <>
            <Chips items={res.chips} />
            <div className="mkb-row small-muted">{`${res.total} found${res.capped ? ' (first 3,000 checked)' : ''}. `}<Link to={res.link}>Open these filters in the People list</Link></div>
            <PeopleRows rows={res.rows} />
            <div className="mkb-row">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this search" aria-label="Search name" />
              <label className="small-muted"><input type="checkbox" checked={alert} onChange={(e) => setAlert(e.target.checked)} /> Alert me when new people match</label>
              <button type="button" className="btn btn-sm" disabled={busy || !name.trim()} onClick={() => run(() => api.post(`${M}/saved-searches`, { name, query: q, filters: res.filters, alert }), 'Saved.').then((r) => { if (r) { setName(''); saved.reload(); } })}>Save search</button>
            </div>
            <FlagAi feature="Natural-language search" refType="Search" refId={q.slice(0, 60)} output={JSON.stringify(res.chips)} />
          </>
        )}
        <Flash msg={msg} />
      </Card>
      <Card title="Saved searches" note="Open one to see who is new since you last looked. Alerts (a bell) need the Admin switch in AI governance; they are off until then.">
        {!((saved.data && saved.data.rows) || []).length && <Empty>No saved searches yet.</Empty>}
        <ul className="mkb-list">
          {((saved.data && saved.data.rows) || []).map((s) => (
            <li key={s.id}>
              <span className="mkb-grow"><b>{s.name}</b> <span className="small-muted">{`${s.query || ''}${s.mine ? '' : ` · by ${s.ownerName}`}${s.alert ? ' · alert on' : ''}`}</span></span>
              {s.newCount > 0 && <span className="mkb-chip new">{`${s.newCount} new`}</span>}
              <button type="button" className="btn btn-sm" onClick={() => run(() => api.get(`${M}/saved-searches/${s.id}/run`)).then((r) => { if (r) { setOpen(r.data); saved.reload(); } })}>Open</button>
              {s.mine && <button type="button" className="mkb-link" onClick={() => run(() => api.put(`${M}/saved-searches/${s.id}`, { shared: !s.shared }), s.shared ? 'Now private.' : 'Shared with the team.').then(saved.reload)}>{s.shared ? 'Make private' : 'Share'}</button>}
              {s.mine && <button type="button" className="mkb-link" onClick={() => run(() => api.delete(`${M}/saved-searches/${s.id}`)).then(saved.reload)}>Delete</button>}
            </li>
          ))}
        </ul>
        {open && (<><h4 style={{ margin: '10px 0 4px' }}>{`${open.name}: ${open.total} people, ${open.newCount} new`}</h4><Chips items={open.chips} /><PeopleRows rows={open.rows} /></>)}
      </Card>
    </div>
  );
}

function Pools() {
  const list = useGet(`${M}/pools`);
  const [name, setName] = useState('');
  const [openId, setOpenId] = useState('');
  const pool = useGet(openId ? `${M}/pools/${openId}` : null);
  const [pick, setPick] = useState({});
  const [job, setJob] = useState('');
  const [adding, setAdding] = useState(null);
  const { busy, msg, run, setMsg } = useRun();
  const ids = Object.keys(pick).filter((k) => pick[k]);
  const rows = (pool.data && pool.data.rows) || [];
  const addAll = async () => {
    const out = { added: 0, why: [] };
    setAdding('Adding…');
    for (const id of (ids.length ? ids : rows.map((r) => r.id))) {
      // eslint-disable-next-line no-await-in-loop
      try { await api.post('/applications', { candidateId: id, requirementId: job }); out.added += 1; } catch (e) { const n = rows.find((r) => r.id === id); out.why.push(`${n ? n.name : id}: ${e?.response?.data?.error || 'not added'}`); }
    }
    setAdding(null);
    setMsg({ ok: !out.why.length, text: `${out.added} added to the requirement.${out.why.length ? ` Not added: ${out.why.slice(0, 5).join(' · ')}${out.why.length > 5 ? ' …' : ''} (add those from the requirement page, with a reason).` : ''}` });
  };
  const exportCsv = () => {
    const head = ['Name', 'Role', 'Experience', 'Location', 'Notice', 'Skills'];
    const lines = [head, ...rows.map((r) => [r.name, r.currentDesignation || '', r.experienceYears ?? '', r.location || '', r.noticePeriod || '', (r.skills || []).join('; ')])].map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = `${pool.data.pool.name}.csv`; a.click();
  };
  return (
    <div>
      <Card title="Talent pools" testid="mkb-pools" note="Named lists of people to come back to: a bench for a skill, silver medallists, a client's favourites. Share one with the team, or keep it to yourself.">
        <form className="mkb-row" onSubmit={(e) => { e.preventDefault(); run(() => api.post(`${M}/pools`, { name }), 'Pool made.').then((r) => { if (r) { setName(''); list.reload(); setOpenId(r.data.id); } }); }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New pool name" aria-label="New pool name" />
          <button type="submit" className="btn btn-sm" disabled={busy || !name.trim()}>Make a pool</button>
        </form>
        <ul className="mkb-list">
          {((list.data && list.data.rows) || []).map((p) => (
            <li key={p.id}>
              <span className="mkb-grow"><b>{p.name}</b> <span className="small-muted">{`${p.members} people${p.shared ? ' · shared' : ''}${p.mine ? '' : ` · by ${p.ownerName}`}`}</span></span>
              <button type="button" className="btn btn-sm" onClick={() => { setOpenId(p.id); setPick({}); }}>Open</button>
              {p.mine && <button type="button" className="mkb-link" onClick={() => run(() => api.put(`${M}/pools/${p.id}`, { shared: !p.shared })).then(list.reload)}>{p.shared ? 'Make private' : 'Share'}</button>}
              {p.mine && <button type="button" className="mkb-link" onClick={() => { if (window.confirm(`Delete the pool "${p.name}"? The people stay in the database.`)) run(() => api.delete(`${M}/pools/${p.id}`)).then(() => { setOpenId(''); list.reload(); }); }}>Delete</button>}
            </li>
          ))}
        </ul>
        {!((list.data && list.data.rows) || []).length && <Empty>No pools yet. Add people from a candidate&apos;s Hiring tools tab, or from a search here.</Empty>}
      </Card>
      {openId && pool.data && (
        <Card title={pool.data.pool.name} note={pool.data.hidden ? `${pool.data.hidden} more people in this pool are outside your scope and are not shown.` : null}>
          <PeopleRows rows={rows.map((r) => ({ ...r, designation: r.currentDesignation }))} pick={pick} onPick={(id, v) => setPick({ ...pick, [id]: v })} />
          <div className="mkb-row">
            <span className="small-muted">{ids.length ? `${ids.length} ticked` : 'Nothing ticked = all'}</span>
            <JobPickerCombo value={job} onChange={(e) => setJob(e.target.value)} blank="Add to a requirement…" />
            <button type="button" className="btn btn-sm" disabled={!job || !!adding || !rows.length} onClick={addAll}>{adding || 'Add to the requirement'}</button>
            <button type="button" className="btn btn-sm" disabled={busy || !ids.length} onClick={() => run(() => api.post(`${M}/pools/${openId}/members/remove`, { candidateIds: ids }), 'Removed from the pool.').then(() => { setPick({}); pool.reload(); list.reload(); })}>Remove ticked</button>
            <button type="button" className="btn btn-sm" disabled={!rows.length} onClick={exportCsv}>Download list</button>
          </div>
        </Card>
      )}
      <Flash msg={msg} />
    </div>
  );
}

function ReviewQueue() {
  const [status, setStatus] = useState('Pending');
  const r = useGet(`${M}/gov/reviews?status=${status}`);
  const [fstatus, setFstatus] = useState('Open');
  const f = useGet(`${M}/fraud?status=${fstatus}`);
  const [notes, setNotes] = useState({});
  const { busy, msg, run } = useRun();
  return (
    <div>
      <Card title="Automatic decisions waiting for a person" testid="mkb-reviews" note="Every automatic hold, auto-reject and 'Not a fit' review waits here. Confirm it, or overturn it with a reason (an overturned hold / rejection is put back).">
        <div className="mkb-row"><select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Show">{['Pending', 'Confirmed', 'Overturned'].map((s) => <option key={s}>{s}</option>)}</select></div>
        {!((r.data && r.data.rows) || []).length && <Empty>Nothing here.</Empty>}
        <ul className="mkb-list">
          {((r.data && r.data.rows) || []).map((x) => (
            <li key={x.id}>
              <span className="mkb-grow"><span className="mkb-chip">{x.kind}</span> {x.summary}<div className="small-muted">{`${x.aiDecision || ''} · ${when(x.at)}${x.reviewerName ? ` · ${x.status} by ${x.reviewerName}: ${x.note || ''}` : ''}`}</div></span>
              {x.candidateId && <Link to={`/candidates/${x.candidateId}`}>Open</Link>}
              {x.status === 'Pending' && (
                <>
                  <input value={notes[x.id] || ''} onChange={(e) => setNotes({ ...notes, [x.id]: e.target.value })} placeholder="Note / reason" aria-label="Note" />
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${M}/gov/reviews/${x.id}`, { decision: 'Confirmed', note: notes[x.id] }), 'Confirmed.').then(r.reload)}>Confirm</button>
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${M}/gov/reviews/${x.id}`, { decision: 'Overturned', note: notes[x.id] }), (o) => `Overturned${o.data.undone ? ` (${o.data.undone})` : ''}.`).then(r.reload)}>Overturn</button>
                </>
              )}
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Checks: possible fraud and backdoor hires" note="Same phone / e-mail / file on different names, experience that does not add up, proxy-interview words in feedback, and people we shared who now work at the client. Signals only: a team lead clears or confirms each with a note." right={<button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${M}/fraud/scan`), (o) => `${o.data.added} new flag(s).`).then(f.reload)}>Scan now</button>}>
        <div className="mkb-row"><select value={fstatus} onChange={(e) => setFstatus(e.target.value)} aria-label="Show">{['Open', 'Cleared', 'Confirmed'].map((s) => <option key={s}>{s}</option>)}</select></div>
        {!((f.data && f.data.rows) || []).length && <Empty>No flags.</Empty>}
        <ul className="mkb-list">
          {((f.data && f.data.rows) || []).map((x) => (
            <li key={x.id}>
              <span className="mkb-grow"><span className="mkb-chip bad">{x.kind}</span> <Link to={`/candidates/${x.candidateId}`}>{x.name}</Link>{x.otherCandidateId && <> and <Link to={`/candidates/${x.otherCandidateId}`}>{x.otherName}</Link></>}<div className="small-muted">{x.detail}{x.reviewerName ? ` · ${x.status} by ${x.reviewerName}: ${x.note}` : ''}</div></span>
              {x.status === 'Open' && (
                <>
                  <input value={notes[x.id] || ''} onChange={(e) => setNotes({ ...notes, [x.id]: e.target.value })} placeholder="What did you check?" aria-label="Note" />
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${M}/fraud/${x.id}`, { status: 'Cleared', note: notes[x.id] }), 'Cleared.').then(f.reload)}>Clear</button>
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${M}/fraud/${x.id}`, { status: 'Confirmed', note: notes[x.id] }), 'Confirmed: the person is tagged "Fraud risk".').then(f.reload)}>Confirm</button>
                </>
              )}
            </li>
          ))}
        </ul>
      </Card>
      <Flash msg={msg} />
    </div>
  );
}

function Agents() {
  const runs = useGet(`${M}/agents/runs`);
  const [openId, setOpenId] = useState('');
  const run1 = useGet(openId ? `${M}/agents/runs/${openId}` : null);
  const [job, setJob] = useState('');
  const { busy, msg, run } = useRun();
  const start = (kind) => run(() => api.post(`${M}/agents/run`, { kind, requirementId: job || undefined })).then((r) => { if (r) { runs.reload(); setOpenId(r.data.id); } });
  const decide = (decision, ids) => run(() => api.post(`${M}/agents/runs/${openId}/decide`, { decision, ids }), (r) => `${r.data.done.length} ${decision.toLowerCase()}.`).then(() => { run1.reload(); runs.reload(); });
  const d = run1.data;
  return (
    <div>
      <Card title="Agents" testid="mkb-agents" note="Each agent looks at the data and PROPOSES actions. Nothing happens until a person approves; every step and decision is kept. Agents never send messages.">
        <div className="mkb-row">
          <JobPickerCombo value={job} onChange={(e) => setJob(e.target.value)} blank="For a requirement (needed for some)…" />
          <button type="button" className="btn btn-sm" disabled={busy || !job} onClick={() => start('submission')}>Submission notes</button>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => start('followup')}>Follow-ups</button>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => start('cleanup')}>Data clean-up</button>
          <button type="button" className="btn btn-sm" disabled={busy || !job} onClick={() => start('playbook')}>Rediscovery playbook</button>
        </div>
        <ul className="mkb-list">
          {((runs.data && runs.data.rows) || []).map((x) => (
            <li key={x.id}>
              <span className="mkb-grow"><b>{x.kind}</b> <span className="small-muted">{`${when(x.at)} · ${x.byName} · ${x.status} · ${x.open} of ${x.total} waiting`}</span></span>
              <button type="button" className="btn btn-sm" onClick={() => setOpenId(x.id)}>Open</button>
            </li>
          ))}
        </ul>
      </Card>
      {d && (
        <Card title={`${d.kind}: ${d.status}`}>
          <ol className="small-muted">{d.steps.map((s) => <li key={s.step}>{`${s.step}: ${s.result}${s.at ? ` (${when(s.at)})` : ''}`}</li>)}</ol>
          {d.actions.some((a) => a.status === 'Proposed') && (
            <div className="mkb-row">
              <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => decide('Approved', null)}>Approve all waiting</button>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => decide('Rejected', null)}>Reject all waiting</button>
            </div>
          )}
          <ul className="mkb-list">
            {d.actions.map((a) => (
              <li key={a.id}>
                <span className="mkb-grow">{a.title}{a.payload && a.payload.text && <div className="mkb-pre">{a.payload.text}</div>}<div className="small-muted">{a.status}{a.decidedByName ? ` by ${a.decidedByName}` : ''}{a.result ? `: ${a.result}` : ''}</div></span>
                {a.status === 'Proposed' && (
                  <>
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => decide('Approved', [a.id])}>Approve</button>
                    <button type="button" className="mkb-link" disabled={busy} onClick={() => decide('Rejected', [a.id])}>Reject</button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Flash msg={msg} />
    </div>
  );
}

function BulkReview() {
  const [job, setJob] = useState('');
  const [ids, setIds] = useState('');
  const [pool, setPool] = useState('');
  const pools = useGet(`${M}/pools`);
  const [res, setRes] = useState(null);
  const [ai, setAi] = useState(false);
  const { busy, msg, run } = useRun();
  const go = async () => {
    let list = ids.split(/[\s,]+/).filter(Boolean);
    if (pool) { const p = await api.get(`${M}/pools/${pool}`); list = p.data.rows.map((r) => r.id); }
    const r = await run(() => api.post(`${M}/bulk-review`, { candidateIds: list, requirementId: job || null, useAi: ai }));
    if (r) setRes(r.data);
  };
  return (
    <Card title="Bulk profile review" testid="mkb-bulk" note="Up to 50 people against a requirement: a score from the facts (skills, experience, location, notice, completeness) with the reasons; the AI may add a line. It never uses name, gender or age. 'Not a fit' waits in the review queue for a person.">
      <div className="mkb-row">
        <JobPickerCombo value={job} onChange={(e) => setJob(e.target.value)} blank="Against a requirement…" />
        <select value={pool} onChange={(e) => setPool(e.target.value)} aria-label="People from a pool"><option value="">People from a pool…</option>{((pools.data && pools.data.rows) || []).map((p) => <option key={p.id} value={p.id}>{`${p.name} (${p.members})`}</option>)}</select>
        <label className="small-muted"><input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} /> Add an AI line</label>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy || !job || (!pool && !ids.trim())} onClick={go}>Review</button>
      </div>
      {!pool && <textarea rows={2} style={{ width: '100%' }} value={ids} onChange={(e) => setIds(e.target.value)} placeholder="…or paste candidate ids" aria-label="Candidate ids" />}
      {res && (
        <ul className="mkb-list">
          {res.rows.map((r) => (
            <li key={r.id}>
              <span className="mkb-grow"><Link to={`/candidates/${r.candidateId}`}>{r.name}</Link> <span className={`mkb-score ${r.verdict === 'Not a fit' ? 'bad' : 'good'}`}>{`${r.verdict} ${r.score}%`}</span><div className="small-muted">{r.summary}</div></span>
              <FlagAi feature="Profile review" refType="ProfileReview" refId={r.id} output={r.summary} />
            </li>
          ))}
        </ul>
      )}
      <Flash msg={msg} />
    </Card>
  );
}

function Placements() {
  const p = useGet(`${M}/placements`);
  const c = useGet(`${M}/contracts`);
  const [notes, setNotes] = useState({});
  const [conv, setConv] = useState({});
  const { busy, msg, run } = useRun();
  return (
    <div>
      <Card title="Placement approval" note={p.data && p.data.on ? 'ON: every joining waits for an Admin or BDE TL to approve the placement. Invoices are not touched by this.' : 'The approval step is OFF (Admin switch). You can still approve placements here as a record.'}>
        {!((p.data && p.data.rows) || []).length && <Empty>No recent placements.</Empty>}
        <ul className="mkb-list">
          {((p.data && p.data.rows) || []).map((r) => (
            <li key={r.applicationId}>
              <span className="mkb-grow"><Link to={`/candidates/${r.candidateId}`}>{r.name}</Link> <span className="small-muted">{`${r.requirement} · ${r.client || ''} · joined ${day(r.joined)}${r.ctc ? ` · CTC ${r.ctc}` : ''}${r.guarantee ? ` · guarantee ${r.guarantee}` : ''}`}</span></span>
              <span className={`mkb-chip ${r.status === 'Approved' ? 'good' : r.status === 'Rejected' ? 'bad' : 'new'}`}>{r.status}</span>
              {r.status === 'Waiting' && (
                <>
                  <input value={notes[r.applicationId] || ''} onChange={(e) => setNotes({ ...notes, [r.applicationId]: e.target.value })} placeholder="Note" aria-label="Note" />
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${M}/placements/${r.applicationId}`, { decision: 'Approved', note: notes[r.applicationId] }), 'Approved.').then(p.reload)}>Approve</button>
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${M}/placements/${r.applicationId}`, { decision: 'Rejected', note: notes[r.applicationId] }), 'Not approved.').then(p.reload)}>Reject</button>
                </>
              )}
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Temp-to-perm (contract placements)" note={(c.data && c.data.note) || ''}>
        {!((c.data && c.data.rows) || []).length && <Empty>No contract placements.</Empty>}
        <ul className="mkb-list">
          {((c.data && c.data.rows) || []).map((r) => {
            const v = conv[r.applicationId] || {};
            const set = (k, x) => setConv({ ...conv, [r.applicationId]: { ...v, [k]: x } });
            return (
              <li key={r.applicationId}>
                <span className="mkb-grow"><Link to={`/candidates/${r.candidateId}`}>{r.name}</Link> <span className="small-muted">{`${r.requirement} · ${r.client || ''} · ${r.type} · joined ${day(r.joined)}`}</span>{r.due && <span className="mkb-chip new">Conversion due</span>}</span>
                <span className={`mkb-chip ${r.status === 'Converted' ? 'good' : ''}`}>{r.status}{r.convertedOn ? ` ${r.convertedOn}` : ''}</span>
                {r.status === 'Contract' && (
                  <>
                    <label className="small-muted">Due <input type="date" value={v.dueOn ?? (r.dueOn || '')} onChange={(e) => set('dueOn', e.target.value)} /></label>
                    <label className="small-muted">Converted <input type="date" value={v.convertedOn || ''} onChange={(e) => set('convertedOn', e.target.value)} /></label>
                    <input type="number" placeholder="New CTC" style={{ width: 110 }} value={v.newCtc || ''} onChange={(e) => set('newCtc', e.target.value)} aria-label="New CTC" />
                    <input type="number" placeholder="Conversion fee" style={{ width: 120 }} value={v.fee || ''} onChange={(e) => set('fee', e.target.value)} aria-label="Conversion fee" />
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.put(`${M}/contracts/${r.applicationId}`, { ...v, dueOn: v.dueOn ?? r.dueOn, status: v.convertedOn ? 'Converted' : 'Contract' }), 'Saved.').then(c.reload)}>Save</button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
      <Flash msg={msg} />
    </div>
  );
}

function Risk() {
  const r = useGet(`${M}/attrition`);
  const rows = (r.data && r.data.rows) || [];
  return (
    <Card title="Risk of leaving inside the guarantee" testid="mkb-risk" note={(r.data && r.data.note) || 'Loading…'}>
      {!rows.length && !r.loading && <Empty>Nobody inside a guarantee period right now.</Empty>}
      <ul className="mkb-list">
        {rows.map((x) => (
          <li key={x.applicationId}>
            <span className="mkb-grow"><Link to={`/candidates/${x.candidateId}`}>{x.name}</Link> <span className="small-muted">{`${x.requirement} · ${x.client || ''} · day ${x.daysSinceJoining ?? '?'} of ${x.guaranteeDays}`}</span><Chips items={x.factors.map((f) => ({ key: f.factor, label: f.factor, value: f.detail }))} /></span>
            <span className={`mkb-score ${x.level}`}>{`${x.level} ${x.score}`}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Records() {
  const st = useGet(`${M}/stale`);
  const jc = useGet(`${M}/job-changes`);
  const ex = useGet(`${M}/expiring-docs`);
  return (
    <div className="mkb-two">
      <Card title="Documents expiring" note="Expired or expiring in the next 30 days. Set the dates on a candidate's Documents tab.">
        {!((ex.data && ex.data.rows) || []).length && <Empty>Nothing expiring.</Empty>}
        <ul className="mkb-list">{((ex.data && ex.data.rows) || []).map((r) => <li key={r.documentId}><Link to={`/candidates/${r.candidateId}?tab=documents`}>{r.name}</Link><span className="mkb-grow small-muted">{`${r.document} (${r.docType})`}</span><span className={`mkb-chip ${r.state === 'Expired' ? 'bad' : 'new'}`}>{`${r.state} ${r.expiresOn}`}</span></li>)}</ul>
      </Card>
      <Card title="Job changes the people told us" note="From their own profile-update link.">
        {!((jc.data && jc.data.rows) || []).length && <Empty>None yet.</Empty>}
        <ul className="mkb-list">{((jc.data && jc.data.rows) || []).map((r) => <li key={`${r.candidateId}${r.at}`}><Link to={`/candidates/${r.candidateId}`}>{r.name}</Link><span className="mkb-grow small-muted">{`${r.from || '-'} -> ${r.to}`}</span><span className="small-muted">{day(r.at)}</span></li>)}</ul>
      </Card>
      <Card title={`Stale profiles${st.data ? ` (no change for ${st.data.days}+ days)` : ''}`} note="Send them the update link from their Hiring tools tab.">
        {!((st.data && st.data.rows) || []).length && <Empty>None.</Empty>}
        <ul className="mkb-list">{((st.data && st.data.rows) || []).slice(0, 50).map((r) => <li key={r.id}><Link to={`/candidates/${r.id}?tab=tools`}>{r.name}</Link><span className="mkb-grow small-muted">{[r.currentDesignation, r.location].filter(Boolean).join(' · ')}</span><span className="small-muted">{r.linkSentAt ? `link sent ${day(r.linkSentAt)}` : `added ${day(r.createdAt)}`}</span></li>)}</ul>
      </Card>
    </div>
  );
}

export default function HiringTools() {
  const [sp, setSp] = useSearchParams();
  const tool = TOOLS.some((t) => t.key === sp.get('tool')) ? sp.get('tool') : 'search';
  const go = (k) => { const n = new URLSearchParams(sp); n.set('tool', k); setSp(n, { replace: true }); };
  return (
    <div data-testid="mkb-hiring-tools">
      <TabStrip small label="Hiring tools" value={tool} onChange={go} maxMain={5} tabs={TOOLS.map((t) => ({ key: t.key, label: t.label, hint: t.hint, more: !!t.more }))} />
      {tool === 'search' && <SmartSearch />}
      {tool === 'pools' && <Pools />}
      {tool === 'review' && <ReviewQueue />}
      {tool === 'agents' && <Agents />}
      {tool === 'bulk' && <BulkReview />}
      {tool === 'placements' && <Placements />}
      {tool === 'risk' && <Risk />}
      {tool === 'records' && <><JobChangesY /><Records /></>}
      {tool === 'outside' && <OutsideSearchY />}
    </div>
  );
}
