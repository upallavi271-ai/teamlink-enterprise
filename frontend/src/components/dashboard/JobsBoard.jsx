import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api';
import Modal from '../Modal.jsx';
import { Help } from '../ui/Guide.jsx';
import DrillExport, { useDrillRight } from '../DrillExport.jsx';
import { FacetSelect } from '../ui/ListPageHeader.jsx';
import { Avatar } from '../atskit/AtsKit.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { atsRoleOf } from '../../nav';
import { useRecruiterBench, benchPeople, recruiterLabel } from '../jobs/assignPeople.jsx';
import './jobsBoard.css';

// ---------------------------------------------------------------------------
// THE JOBS BOARD (user, 2026-10-12: "make this much clear, looking too clumsy").
// Replaces the old Open-jobs list of the dashboard / My Team page.
//
//   Summary tiles (they filter)  ·  search + cascading filters  ·  one line saying what Late means
//   Needs you now | In progress | Waiting on client | Done recently   (each collapsible, with a count)
//     one ROW per job: title · client/place · who is handling it · the 5 steps · ONE status chip · days open
//     a click opens THREE cards: Who is working on it · What is stuck · Next
//
// Data: GET /api/dashboard/ats/home/list ?set=__jobs&d_view=board (backend utils/atsHome.js jobsList):
// the same rows and the same step counts as before (the candidate tally is unchanged); the server adds
// what the viewer must do about each job. A job's detail is ?set=__job:<id>.
// "Assign" reuses POST /requirements/:id/assign and the least-busy recruiter list (jobs/assignPeople.jsx).
// ---------------------------------------------------------------------------
const LIST_URL = '/dashboard/ats/home/list';
const IN = new Intl.NumberFormat('en-IN');
const fmt = (n) => IN.format(Number(n) || 0);
const errText = (e) => (e && e.response && e.response.data && e.response.data.error) || 'This part could not be loaded. Refresh the page to try again.';
const STEPS = ['On this requirement', 'Sent to client', 'Interview', 'Selected', 'Joined'];
// One plain sentence per step (the same words as the tooltip on every screen that shows the strip).
const STEP_TIPS = [
  'People put on this requirement so far.',
  'People we sent to the client (including those who went further).',
  'People who got an interview or went further.',
  'People the client selected, or who reached offer or joining.',
  'People who have joined.',
];
const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;
const when = (v) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}, ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
};
const dayOf = (v) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
const readDensity = () => { try { return localStorage.getItem('tl_jb_density') === 'compact' ? 'compact' : 'comfortable'; } catch { return 'comfortable'; } };
const saveDensity = (v) => { try { localStorage.setItem('tl_jb_density', v); } catch { /* per-viewer convenience only */ } };

const SECTIONS = [
  { key: 'needs', title: 'Needs you now', tone: 'red', hint: 'A person is late, a requirement has no recruiter yet, or an interview is today or tomorrow.' },
  { key: 'progress', title: 'In progress', tone: 'blue', hint: 'Moving along. Nothing is late.' },
  { key: 'waiting', title: 'Waiting on client', tone: 'orange', hint: 'Everyone on these requirements is waiting for the client to reply.' },
  { key: 'idle', title: 'Not started yet', tone: 'grey', hint: 'Old requirements nobody is working on yet. Press Assign to give one to a recruiter.' },
  { key: 'done', title: 'Done recently', tone: 'green', hint: 'Requirements closed in the last 14 days.' },
];
const LATE_WORDS = 'Late = a person has waited longer than the time allowed for their step (for example, 5 days for the client to reply).';

// The ONE status chip of a job, most important first.
function statusOf(r) {
  if (r.bucket === 'done') return { tone: 'grey', text: 'Closed', tip: 'This requirement was closed in the last 14 days.' };
  if (r.late > 0) {
    return {
      tone: 'red',
      text: `${fmt(r.late)} late`,
      tip: `${plural(r.late, 'person has', 'people have')} waited longer than the time allowed for their step.${r.lateDays ? ` The longest is ${plural(r.lateDays, 'day', 'days')} late.` : ''}`,
    };
  }
  if (r.noRecruiter) return { tone: 'orange', text: 'No recruiter', tip: 'Nobody is working on this requirement yet. Give it to a recruiter.' };
  if (r.ivSoon > 0) return { tone: 'blue', text: 'Interview soon', tip: `${plural(r.ivSoon, 'interview is', 'interviews are')} today or tomorrow.` };
  if (r.bucket === 'waiting') return { tone: 'orange', text: 'Waiting for client', tip: 'Everyone on this requirement is waiting for the client to reply.' };
  if (!r.inProcess && !r.steps[0]) return { tone: 'blue', text: 'Nobody added yet', tip: 'The recruiter has not added anyone to this requirement yet.' };
  return { tone: 'green', text: 'On track', tip: 'Nothing is late and nobody is stuck.' };
}

function Chip({ s }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="jb-chipwrap">
      <button type="button" className={`jb-chip t-${s.tone}`} title={s.tip} aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>{s.text}</button>
      {open && <span className="jb-tip" role="note" onClick={(e) => { e.stopPropagation(); setOpen(false); }}>{s.tip}{s.tone === 'red' ? ` ${LATE_WORDS}` : ''}</span>}
    </span>
  );
}

// The five steps in one strip. Only the steps that have people are strong.
function Strip({ s }) {
  const [tip, setTip] = useState(-1);
  return (
    <div className="jb-strip" role="group" aria-label={`People by step: ${STEPS.map((l, i) => `${l} ${s[i]}`).join(', ')}`} onClick={(e) => e.stopPropagation()}>
      {STEPS.map((l, i) => (
        <button
          key={l}
          type="button"
          className={`jb-step${s[i] ? ' has' : ''}${i === 4 && s[i] ? ' is-joined' : ''}${tip === i ? ' is-tip' : ''}`}
          title={`${l}: ${STEP_TIPS[i]}`}
          aria-expanded={tip === i}
          onClick={() => setTip(tip === i ? -1 : i)}
          onBlur={() => setTip(-1)}
          onKeyDown={(e) => { if (e.key === 'Escape') setTip(-1); }}
        >
          <b>{s[i] ? fmt(s[i]) : '–'}</b>
          <i>{l}</i>
          {tip === i && <span className="jb-steptip" role="note">{`${l}: ${STEP_TIPS[i]}`} <em>{s[i]} {s[i] === 1 ? 'person' : 'people'} here.</em></span>}
        </button>
      ))}
    </div>
  );
}

// ---- give a job to a recruiter (the existing assignment flow) ----------------------------------------
function AssignModal({ job, assign, onClose, onDone }) {
  const takeIt = !job.tlId && assign.asTl && !assign.global; // a team lead taking a job nobody leads yet
  const tlId = job.tlId || (assign.asTl ? assign.meId : '');
  const bench = useRecruiterBench(tlId, true, job.department || '');
  const people = benchPeople(bench);
  // SEVERAL RECRUITERS (2026-10-13): tick one or more; the first one is the main recruiter.
  const [picks, setPicks] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!picks.length && people.length) { const best = people.find((p) => p.leastBusy) || people[0]; setPicks([best.id]); }
  }, [bench]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = picks[0] || '';
  const whoNames = picks.map((id) => (people.find((p) => p.id === id) || {}).name).filter(Boolean);
  const who = whoNames.length ? { name: whoNames.length > 2 ? `${whoNames.length} recruiters` : whoNames.join(' and ') } : null;
  async function save() {
    setBusy(true); setError('');
    try {
      await api.post(`/requirements/${job.id}/assign`, { recruiterId: picks[0], recruiterIds: picks.slice(1), ...(takeIt ? { tlId: assign.meId } : {}) });
      onDone(`Saved. ${job.reqCode || job.title} now has ${who ? who.name : 'a recruiter'}.`);
    } catch (e) {
      setError((e.response && e.response.data && e.response.data.error) || 'Could not give this requirement to the recruiter. Try again.');
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Give this requirement to a recruiter`}
      note={job.reqCode || ''}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!pick || busy} onClick={save}>{busy ? 'Saving…' : who ? `Give to ${who.name}` : 'Give requirement'}</button>
        </>
      )}
    >
      <div className="jb-assign-job"><b>{job.title}</b><span>{[job.client, job.location].filter(Boolean).join(' · ')}</span></div>
      {takeIt && <div className="jb-assign-note">Nobody leads this requirement yet, so it becomes yours when you pick a recruiter.</div>}
      {bench === null && <div className="jb-empty">Loading your recruiters…</div>}
      {bench !== null && !people.length && <div className="jb-empty">No recruiter is in this team yet, so the requirement cannot be given. Ask an Admin to add one.</div>}
      {people.length > 0 && (
        <ul className="jb-assign-list" aria-label="Recruiters, least busy first. Tick one or more.">
          {people.map((p) => (
            <li key={p.id}>
              <label className={picks.includes(p.id) ? 'is-on' : ''}>
                <input type="checkbox" checked={picks.includes(p.id)} onChange={() => setPicks((cur) => (cur.includes(p.id) ? cur.filter((x) => x !== p.id) : [...cur, p.id]))} />
                <Avatar name={p.name} size={28} />
                <span className="jb-assign-t">{recruiterLabel(p)}{picks[0] === p.id && picks.length > 1 ? ' · Main' : ''}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {people.length > 1 && <div className="jb-muted">Tick one or more recruiters. Everyone you tick works on this requirement.</div>}
      {error && <div className="notice red">{error}</div>}
    </Modal>
  );
}

// ---- one job opened: three cards ---------------------------------------------------------------------
function JobPanel({ row, params, onCand, canAssign, onAssign, hidden }) {
  const navigate = useNavigate();
  const [st, setSt] = useState({ loading: true, data: null, error: '' });
  const [people, setPeople] = useState(false);
  useEffect(() => {
    let live = true;
    api.get(LIST_URL, { params: { ...params, set: `__job:${row.id}` } })
      .then((r) => { if (live) setSt({ loading: false, data: r.data, error: '' }); })
      .catch((e) => { if (live) setSt({ loading: false, data: null, error: errText(e) }); });
    return () => { live = false; };
  }, [row.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (st.loading) return <div className="jb-panel"><div className="jb-empty">Loading this requirement…</div></div>;
  if (st.error) return <div className="jb-panel"><div className="notice red">{st.error}</div></div>;
  const d = st.data;
  const h = d.handlers;
  const open = (p) => onCand({ candidateId: p.candidateId, applicationId: p.id });
  return (
    <div className="jb-panel">
      <div className="jb-cards">
        <section className="jb-card">
          <h4>Who is working on it</h4>
          <dl className="jb-dl">
            {!hidden && <><dt>Team lead</dt><dd>{h.tl || (h.tlWorked && h.tlWorked.length ? `Not named yet · ${h.tlWorked.join(', ')} worked on it` : 'Not named yet')}</dd></>}
            <dt>Client manager (BDE)</dt><dd>{h.bde || 'Not named yet'}</dd>
          </dl>
          {hidden ? null : !h.recruiters.length ? (
            <div className="jb-line">
              <span>Nobody is working on this requirement yet.</span>
              {canAssign && <button type="button" className="btn btn-sm jb-assign" onClick={onAssign}>Assign a recruiter</button>}
            </div>
          ) : (
            <ul className="jb-people">
              {h.recruiters.map((r) => (
                <li key={r.id || r.name}>
                  <Avatar name={r.name} size={26} />
                  <span className="jb-people-n"><b>{r.name}</b>{!r.assigned && <small>helped (not assigned)</small>}</span>
                  <span className="jb-people-c">
                    {r.inProcess ? plural(r.inProcess, 'person', 'people') : 'nobody yet'}
                    {r.late > 0 && <em>{r.late} late</em>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {h.othersMore > 0 && <div className="jb-muted">+ {fmt(h.othersMore)} more helped on this requirement.</div>}
        </section>

        <section className="jb-card">
          <h4>What is stuck</h4>
          {!d.stuck.length ? <div className="jb-ok">Nothing is stuck on this requirement.</div> : (
            <ul className="jb-stuck">
              {d.stuck.map((p) => (
                <li key={p.id}>
                  <div className="jb-stuck-t">
                    <b>{p.name}</b>
                    <span>{p.step}{p.daysLate ? ` · ${plural(p.daysLate, 'day', 'days')} late` : ''}{p.allowedDays ? ` (allowed ${plural(p.allowedDays, 'day', 'days')})` : ''}</span>
                    <span className="jb-muted">{p.waitingOnClient ? 'Waiting for the client to reply.' : p.owner ? `${p.owner}${p.action ? `: ${p.action}` : ''}` : p.action || ''}</span>
                  </div>
                  <button type="button" className="btn btn-sm" onClick={() => open(p)}>Open profile</button>
                </li>
              ))}
            </ul>
          )}
          {d.stuckMore > 0 && <div className="jb-muted">+ {fmt(d.stuckMore)} more late.</div>}
        </section>

        <section className="jb-card">
          <h4>Next</h4>
          {!d.interviews.length ? <div className="jb-line"><span>No interview booked yet.</span></div> : (
            <ul className="jb-iv">
              {d.interviews.slice(0, 4).map((i) => (
                <li key={i.id}>
                  <span className="jb-when">{when(i.at)}</span>
                  <button type="button" className="jb-link" onClick={() => open(i)}>{i.name}</button>
                  <span className="jb-muted">Round {i.round}{i.mode ? ` · ${i.mode}` : ''}</span>
                </li>
              ))}
            </ul>
          )}
          {d.interviews.length > 4 && <div className="jb-muted">+ {fmt(d.interviews.length - 4)} more interviews.</div>}
          <div className="jb-card-btn">
            {d.interviews.length
              ? <button type="button" className="btn btn-sm btn-primary" onClick={() => navigate('/ats/calendar')}>Open interview calendar</button>
              : <button type="button" className="btn btn-sm btn-primary" onClick={() => navigate(`/candidates?requirementId=${encodeURIComponent(row.id)}`)}>Open candidates</button>}
          </div>
          {d.activity.length > 0 ? (
            <>
              <h5>Last things that happened</h5>
              <ul className="jb-act">
                {d.activity.slice(0, 3).map((a) => (
                  <li key={a.id}><span className={`jb-dot t-${a.tone}`} aria-hidden="true" /><span>{a.text}<small>{a.by} · {when(a.at)}</small></span></li>
                ))}
              </ul>
            </>
          ) : <div className="jb-muted jb-quiet">Nothing recorded on this requirement yet.</div>}
        </section>
      </div>
      {d.pipeline.length > 0 && (
        <div className="jb-all">
          <button type="button" className="link-btn" aria-expanded={people} onClick={() => setPeople(!people)}>
            {people ? 'Hide' : 'Show'} all {fmt(d.total)} {d.total === 1 ? 'person' : 'people'} on this requirement, by step
          </button>
          {people && (
            <div className="jb-pipe">
              {d.pipeline.map((p) => (
                <div key={p.step} className="jb-pipe-step">
                  <div className="jb-pipe-h"><b>{p.step}</b><span>{fmt(p.count)}</span></div>
                  <div className="jb-pipe-p">
                    {p.people.map((x) => (
                      <button key={x.id} type="button" className={`jb-chipp${x.late ? ' is-late' : ''}`} onClick={() => open(x)} title={`${x.name}${x.late ? ' · late' : ''} — open the profile`}>{x.name}</button>
                    ))}
                    {p.count > p.people.length && <span className="jb-muted">+ {fmt(p.count - p.people.length)} more</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- one job row ----------------------------------------------------------------------------------------
function JobRow({ r, open, onToggle, assign, params, onCand, onAssign, viewAs, hidden }) {
  const s = statusOf(r);
  const mayAssign = !!(!hidden && assign && assign.allowed && (assign.global || !r.tlId || r.tlId === assign.meId || (r.extraTlIds || []).includes(assign.meId)));
  const mine = assign && (r.tlId === assign.meId || (r.extraTlIds || []).includes(assign.meId));
  const place = [r.client, r.location].filter(Boolean).join(' · ');
  const lead = (mine || hidden) ? null : (r.tl ? `Team lead: ${r.tl}` : 'No team lead yet');
  const key = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } };
  return (
    <li className={`jb-row t-${r.bucket}${open ? ' is-open' : ''}`}>
      <div className="jb-head" role="button" tabIndex={0} aria-expanded={open} onClick={onToggle} onKeyDown={key}>
        <div className="jb-title">
          <div className="jb-t1">{r.reqCode && <span className="jb-code">{r.reqCode}</span>}<b>{r.title}</b></div>
          {place && <div className="jb-t2">{place}</div>}
        </div>
        <div className="jb-who">
          {hidden ? (
            r.bde ? <span className="jb-rec" title={`Client manager: ${r.bde}`}><Avatar name={r.bde} size={26} /><span>{r.bde}</span></span> : <span className="jb-noone">No client manager yet</span>
          ) : r.recruiters.length ? (
            <span className="jb-rec" title={r.recruiters.join(', ')}>
              <Avatar name={r.recruiters[0]} size={26} />
              <span>{r.recruiters[0]}{r.recruiters.length > 1 ? <em> +{r.recruiters.length - 1}</em> : null}</span>
            </span>
          ) : r.bucket === 'done' ? <span className="jb-muted">No recruiter</span> : mayAssign ? (
            <button type="button" className="btn btn-sm jb-assign" disabled={viewAs} title={viewAs ? 'You are in View as mode, which is read-only.' : 'Give this requirement to a recruiter'} onClick={(e) => { e.stopPropagation(); onAssign(r); }}>Assign</button>
          ) : <span className="jb-noone">No recruiter yet</span>}
          {lead && <small className="jb-lead">{lead}</small>}
        </div>
        <Strip s={r.steps} />
        <div className="jb-state">
          <Chip s={s} />
          <small>{r.bucket === 'done' ? (r.closedAt ? `Closed ${dayOf(r.closedAt)}` : 'Closed') : r.ageDays !== null ? `Open ${plural(r.ageDays, 'day', 'days')}` : ''}</small>
        </div>
        <span className="jb-caret" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </div>
      {open && <JobPanel row={r} params={params} onCand={onCand} canAssign={mayAssign && !viewAs} onAssign={() => onAssign(r)} hidden={hidden} />}
    </li>
  );
}

// ---- a collapsible section ---------------------------------------------------------------------------------
function Section({ sec, data, defaultOpen, baseParams, params, assign, onCand, onAssign, viewAs, reload, hidden }) {
  const [openSec, setOpenSec] = useState(defaultOpen);
  const [openRow, setOpenRow] = useState(null);
  const [all, setAll] = useState(false);
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(null);
  const bkey = JSON.stringify(baseParams);
  useEffect(() => { setAll(false); setPage(1); setMore(null); }, [bkey, reload]);
  useEffect(() => {
    if (!all) return undefined;
    let live = true;
    api.get(LIST_URL, { params: { ...baseParams, d_bucket: sec.key, d_size: 25, d_page: page } })
      .then((r) => { if (live) setMore({ rows: r.data.rows, filtered: r.data.filtered }); })
      .catch(() => { if (live) setMore({ rows: [], filtered: 0, error: true }); });
    return () => { live = false; };
  }, [all, page, bkey, reload]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = all && more ? more.rows : data.rows;
  const pages = all && more ? Math.max(1, Math.ceil(more.filtered / 25)) : 1;
  return (
    <section className={`jb-sec t-${sec.tone}${openSec ? ' is-open' : ''}`}>
      <button type="button" className="jb-sec-h" aria-expanded={openSec} onClick={() => setOpenSec(!openSec)} title={sec.hint}>
        <span className="jb-sec-c" aria-hidden="true">{openSec ? '▾' : '▸'}</span>
        <span className="jb-sec-t">{sec.title}</span>
        <span className="jb-sec-n">{fmt(data.total)}</span>
        <span className="jb-sec-s">{sec.hint}</span>
      </button>
      {openSec && (
        <div className="jb-sec-b">
          {!rows.length ? <div className="jb-ok">{sec.key === 'needs' ? 'Nothing needs you right now. Good work.' : 'No requirements here.'}</div> : (
            <ul className="jb-rows">
              {rows.map((r) => (
                <JobRow key={r.id} r={r} open={openRow === r.id} onToggle={() => setOpenRow(openRow === r.id ? null : r.id)} assign={assign} params={params} onCand={onCand} onAssign={onAssign} viewAs={viewAs} hidden={hidden} />
              ))}
            </ul>
          )}
          {data.total > data.rows.length && (
            <div className="jb-more">
              {!all
                ? <button type="button" className="btn btn-sm" onClick={() => { setAll(true); setPage(1); }}>Show all {fmt(data.total)}</button>
                : (
                  <>
                    <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Back</button>
                    <span className="jb-muted">Page {page} of {fmt(pages)}</span>
                    <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next →</button>
                    <button type="button" className="link-btn" onClick={() => setAll(false)}>Show fewer</button>
                  </>
                )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ---- the board ------------------------------------------------------------------------------------------------
function Tile({ n, label, sub, zero, on, onClick, tone }) {
  const empty = !n;
  return (
    <button type="button" className={`jb-tile${on ? ' is-on' : ''}${tone ? ` t-${tone}` : ''}${empty ? ' is-zero' : ''}`} aria-pressed={on} disabled={empty && !on} onClick={onClick}>
      <b>{empty ? '–' : fmt(n)}</b>
      <span className="jb-tile-l">{label}</span>
      <span className="jb-tile-s">{empty ? zero : sub}</span>
    </button>
  );
}

export function OpenJobs({ w, params, onDrill, onCand, tlId = null, inner = false }) {
  const { user } = useAuth();
  const viewAs = !!(user && user.viewAs);
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  // A team lead opens on her own jobs; the "Jobs I handle" tile switches to all of them.
  const [flag, setFlag] = useState(() => (!inner && atsRoleOf(user) === 'TL' ? 'mine' : ''));
  const [fv, setFv] = useState({ dept: '', client: '', tl: '', rec: '' });
  const [density, setDensity] = useState(readDensity);
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [reload, setReload] = useState(0);
  const [assignFor, setAssignFor] = useState(null);
  const [flash, setFlash] = useState('');
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const baseParams = useMemo(() => ({
    ...params, set: '__jobs', d_view: 'board', d_sort: 'attention', d_per: 6,
    d_q: term || undefined, d_tlid: tlId || undefined, d_flag: flag || undefined,
    d_dept: fv.dept || undefined, d_client: fv.client || undefined, d_tl: fv.tl || undefined, d_rec: fv.rec || undefined,
  }), [JSON.stringify(params), term, tlId, flag, fv.dept, fv.client, fv.tl, fv.rec]); // eslint-disable-line react-hooks/exhaustive-deps
  const bkey = JSON.stringify(baseParams);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    api.get(LIST_URL, { params: baseParams })
      .then((r) => { if (live) setState({ loading: false, data: r.data, error: '' }); })
      .catch((e) => { if (live) setState((s) => ({ loading: false, data: s.data, error: errText(e) })); });
    return () => { live = false; };
  }, [bkey, reload]); // eslint-disable-line react-hooks/exhaustive-deps
  const d = state.data;
  const sm = d && d.summary;
  const anyFilter = !!(flag || term || fv.dept || fv.client || fv.tl || fv.rec);
  const clearAll = () => { setFlag(''); setQ(''); setTerm(''); setFv({ dept: '', client: '', tl: '', rec: '' }); };
  const setDensityTo = (v) => { setDensity(v); saveDensity(v); };
  const facetUi = (key, field, label, allLabel) => {
    const opts = (d && d.facets && d.facets[key]) || [];
    if (opts.length < 2 && !fv[field]) return null;
    return <FacetSelect label={label} value={fv[field]} onChange={(v) => setFv({ ...fv, [field]: v })} options={opts} allLabel={allLabel} />;
  };
  const mayExport = useDrillRight('ats');
  // The file holds every requirement the board lists for the search / filters picked, group by group (not only the few shown per group).
  async function buildFile() {
    const rows = [];
    const STEPS = ['On this requirement', 'Sent to client', 'Interview', 'Selected', 'Joined'];
    for (const sec of SECTIONS) {
      const s = d.sections[sec.key];
      if (!s || !s.total) continue; // eslint-disable-line no-continue
      const pages = Math.max(1, Math.ceil(s.total / 100));
      for (let p = 1; p <= pages; p += 1) {
        // eslint-disable-next-line no-await-in-loop
        const r = await api.get(LIST_URL, { params: { ...baseParams, d_view: undefined, d_per: undefined, d_bucket: sec.key, d_size: 100, d_page: p } });
        (r.data.rows || []).forEach((x) => rows.push([sec.title, x.reqCode, x.title, x.client, x.department, x.tl, (x.recruiters || []).join(', '), dayOf(x.createdAt), x.ageDays, ...STEPS.map((_, i) => (x.steps || [])[i]), x.inProcess, x.late]));
      }
    }
    return { headers: ['Group', 'Job ID', 'Requirement', 'Client', 'Department', 'Team lead', 'Recruiters', 'Opened', 'Days open', 'On this requirement', 'Sent to client', 'Interview', 'Selected', 'Joined', 'In process', 'Late'], rows };
  }
  const firstOpen = d ? (d.sections.needs.total ? 'needs' : d.sections.progress.total ? 'progress' : d.sections.waiting.total ? 'waiting' : d.sections.idle.total ? 'idle' : 'needs') : 'needs';

  const body = (
    <>
      {flash && <div className="notice jb-flash" role="status">{flash} <button type="button" className="link-btn" onClick={() => setFlash('')}>OK</button></div>}
      {!inner && sm && (
        <div className="jb-tiles">
          {sm.mineOnly
            ? <Tile n={sm.mine} label={sm.mineLabel} sub="Requirements you lead or your recruiters hold" zero="No requirement is yours yet" tone="blue" on={flag === 'mine'} onClick={() => setFlag(flag === 'mine' ? 'all' : 'mine')} />
            : <Tile n={sm.open} label="Open requirements" sub="All open requirements here" zero="No open requirements" tone="blue" on={!flag || flag === 'all'} onClick={() => setFlag('')} />}
          <Tile n={sm.late} label="Late" sub={`${plural(sm.lateRows, 'person', 'people')} waiting too long`} zero="Nothing is late" tone="red" on={flag === 'late'} onClick={() => setFlag(flag === 'late' ? '' : 'late')} />
          <Tile n={sm.noRecruiter} label="No recruiter yet" sub="Nobody is working on these requirements yet" zero="Every requirement has a recruiter" tone="orange" on={flag === 'norec'} onClick={() => setFlag(flag === 'norec' ? '' : 'norec')} />
          <Tile n={sm.interviewsWeek} label="Interviews this week" sub={`In the next 7 days, in ${plural(sm.interviewsWeekJobs, 'requirement', 'requirements')}`} zero="No interview booked this week" tone="green" on={flag === 'iv'} onClick={() => setFlag(flag === 'iv' ? '' : 'iv')} />
        </div>
      )}
      <div className="jb-tools">
        <input type="search" className="jb-search" placeholder="Search requirement, requirement ID, client or person…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search requirements" />
        {!inner && facetUi('department', 'dept', 'Department', 'All departments')}
        {!inner && facetUi('client', 'client', 'Client', 'All clients')}
        {!inner && facetUi('tl', 'tl', 'Team lead', 'All team leads')}
        {!inner && facetUi('rec', 'rec', 'Recruiter', 'All recruiters')}
        {anyFilter && <button type="button" className="link-btn" onClick={clearAll}>Clear filters</button>}
        {d && d.filtered > 0 && <DrillExport name={tlId ? 'Open requirements - team lead' : 'Open requirements'} allowed={mayExport} disabled={state.loading} build={buildFile} />}
        <span className="jb-density" role="group" aria-label="Row size">
          <button type="button" className={density === 'comfortable' ? 'on' : ''} aria-pressed={density === 'comfortable'} onClick={() => setDensityTo('comfortable')}>Comfortable</button>
          <button type="button" className={density === 'compact' ? 'on' : ''} aria-pressed={density === 'compact'} onClick={() => setDensityTo('compact')}>Compact</button>
        </span>
      </div>
      <div className="jb-legend"><b>Late</b> = a person has waited longer than the time allowed for their step (for example, 5 days for the client to reply). </div>
      <div className="jb-legend jb-legend2">The numbers in each requirement are <b>people</b>. Each number counts the people who reached that step <b>or went further</b>, so the numbers only go down from left to right. Press a step to see what it means.</div>
      {state.error && <div className="notice red">{state.error}</div>}
      {!d && state.loading && <div className="jb-empty">Loading the requirements…</div>}
      {d && d.filtered === 0 && (
        <div className="jb-empty">
          {flag === 'mine' && !term ? 'No requirement is yours yet. Press "No recruiter yet" above to pick one up, or press "Requirements I handle" to see every open requirement.' : anyFilter ? 'No requirement matches. Remove a filter or try another word.' : tlId ? 'No open requirement for this team lead yet.' : 'No open requirements here. New requirements show here when a client asks for people.'}
        </div>
      )}
      {d && d.filtered > 0 && (
        <div className={`jb-secs${state.loading ? ' is-loading' : ''}`}>
          {SECTIONS.filter((sec) => d.sections[sec.key].total > 0 || (sec.key === 'needs' && !flag)).map((sec) => (
            <Section
              key={sec.key}
              sec={sec}
              data={d.sections[sec.key]}
              defaultOpen={sec.key === firstOpen}
              baseParams={{ ...baseParams, d_view: undefined, d_per: undefined }}
              params={params}
              assign={d.assign}
              onCand={onCand}
              onAssign={setAssignFor}
              viewAs={viewAs}
              reload={reload}
              hidden={!!d.peopleHidden}
            />
          ))}
        </div>
      )}
      {assignFor && d && (
        <AssignModal
          job={assignFor}
          assign={d.assign}
          onClose={() => setAssignFor(null)}
          onDone={(msg) => { setAssignFor(null); setFlash(msg); setReload((n) => n + 1); }}
        />
      )}
    </>
  );
  if (inner) return <div className={`jb jb-inner jb-${density}`}>{body}</div>;
  return (
    <section className={`panel jb jb-${density}`}>
      <div className="jb-top">
        <h3>{w.title}<Help text="Every open requirement, grouped by what you need to do. Click a requirement to see who is working on it, what is stuck and what is next." /></h3>
        {w.total ? <button type="button" className="link-btn" onClick={() => onDrill(w.drill)} title="Open the full list with filters and Excel">{fmt(w.total)} open · full list ↗</button> : null}
      </div>
      {body}
    </section>
  );
}

export default OpenJobs;
