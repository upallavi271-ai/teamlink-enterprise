import { Fragment, useEffect, useState } from 'react';
import api from '../../api';
import StatusChip from '../ui/StatusChip.jsx';
import { Help } from '../ui/Guide.jsx';
import './homeSections.css';

// ---------------------------------------------------------------------------
// THE DASHBOARD'S "WHAT IS HAPPENING" SECTIONS (user feedback 2026-10-05:
// "when I select a department, the TLs should come, the open requirements
// should come; clicking a requirement should show who is handling it").
//   TodayStrip  what happened today, each number opens its list
//   TeamLeads   the team leads (top 5 + Show all, grouped by department);
//               a click opens their recruiters and their open jobs right here
//   OpenJobs    the open jobs (top 5 + Show all, search, sort); a click opens
//               who is handling the job, its people by step, the coming
//               interviews and the last 5 things that happened — right here
// Rows come from GET /api/dashboard/ats/home/list (?set=__tls | __jobs |
// __job:<id>, backend utils/atsHome.js), counted on the dashboard's own rows,
// so every number equals its list and every dashboard filter applies.
// ---------------------------------------------------------------------------
const LIST_URL = '/dashboard/ats/home/list';
const IN = new Intl.NumberFormat('en-IN');
const fmt = (n) => IN.format(Number(n) || 0);
const dayOf = (v) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
const whenOf = (v) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}, ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
};
const ageWords = (d) => (d === null || d === undefined ? '' : d === 0 ? 'today' : d === 1 ? '1 day' : `${fmt(d)} days`);
const STEP_SHORT = ['Added', 'Sent', 'Interview', 'Selected', 'Joined'];
const errText = (e) => (e && e.response && e.response.data && e.response.data.error) || 'This part could not be loaded. Refresh the page to try again.';

// One number that opens its list; a zero is a quiet dash (never a bare 0).
function N({ value, drill, onDrill, tone, what }) {
  if (!value) return <span className="hs-dash" aria-label="none">–</span>;
  return (
    <button type="button" className={`hs-n${tone ? ` t-${tone}` : ''}`} title={what ? `${what} — open the list` : 'Open the list'}
      onClick={(e) => { e.stopPropagation(); onDrill(drill); }}>{fmt(value)}</button>
  );
}
function Head({ title, help, right }) {
  return <div className="hs-head"><h3>{title}{help && <Help text={help} />}</h3>{right}</div>;
}

// ---- TODAY -------------------------------------------------------------------------------
export function TodayStrip({ w, onDrill }) {
  const any = w.items.some((i) => i.value);
  return (
    <section className="panel hs-box">
      <Head title={w.title} help="What happened today. Click a number to see the people." />
      {!any ? <div className="hs-empty">Nothing has happened yet today. New work shows here as it happens.</div> : (
        <div className="hs-today">
          {w.items.map((i) => (i.value ? (
            <button key={i.id} type="button" className={`hs-today-i t-${i.tone}`} title={`${i.hint} Click to see them.`} onClick={() => onDrill(i.drill)}>
              <b>{fmt(i.value)}</b><span>{i.label}</span>
            </button>
          ) : (
            <span key={i.id} className="hs-today-i is-none" title={i.hint}><b>–</b><span>{i.label}</span></span>
          )))}
        </div>
      )}
    </section>
  );
}

// ---- TEAM LEADS ---------------------------------------------------------------------------
const TL_COLS = [
  ['openJobs', 'Open jobs', 'Open jobs they lead or their recruiters hold.'],
  ['inProcess', 'In process', 'People on their jobs now (not rejected, on hold or joined).'],
  ['interviews', 'Interviews', 'Interviews in the dates you picked.'],
  ['selected', 'Selected', 'Selected or offered, not joined yet.'],
  ['joined', 'Joined', 'People who joined in the dates you picked.'],
  ['late', 'Late', 'Work past its due date.'],
];
function PersonCells({ r, onDrill }) {
  return TL_COLS.map(([k, l]) => (
    <td key={k} className="num" data-label={l}>
      <N value={r[k]} drill={r.drills[k]} onDrill={onDrill} tone={k === 'late' ? 'red' : k === 'joined' ? 'green' : null} what={`${r.name} — ${l}`} />
    </td>
  ));
}
const initials = (name) => String(name || '?').trim().split(/\s+/).map((s) => s[0]).slice(0, 2).join('').toUpperCase();

export function TeamLeads({ w, onDrill, tls, params, onCand }) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(null);
  const data = tls && tls.data;
  if (!tls || tls.loading) return <section className="panel hs-box"><Head title={w.title} /><div className="hs-empty">Loading the team leads…</div></section>;
  if (tls.error) return <section className="panel hs-box"><Head title={w.title} /><div className="notice red">{tls.error}</div></section>;
  const rows = data.rows || [];
  const top = [...rows].sort((x, y) => y.late - x.late || y.inProcess - x.inProcess || y.openJobs - x.openJobs).slice(0, 5);
  const grouped = all && (data.groups || []).length > 1;
  const groups = all ? (data.groups || []) : [{ department: null, rows: top }];
  const showDept = !grouped && (data.groups || []).length > 1;
  const row = (r) => (
    <Fragment key={r.id}>
      <tr className={`hs-click${open === r.id ? ' is-open' : ''}`} onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
        <td className="hs-who" data-label="Team lead">
          <span className="hs-avatar" aria-hidden="true">{initials(r.name)}</span>
          <span><b>{r.name}</b>{showDept && r.department && <span className="hs-sub">{r.department}</span>}</span>
          <span className="hs-caret" aria-hidden="true">{open === r.id ? '▴' : '▾'}</span>
        </td>
        <td className="num" data-label="Recruiters">{r.teamSize ? fmt(r.teamSize) : <span className="hs-dash">–</span>}</td>
        <PersonCells r={r} onDrill={onDrill} />
      </tr>
      {open === r.id && (
        <tr className="hs-open-row"><td colSpan={TL_COLS.length + 2}>
          <div className="hs-inside">
            <h4>{r.name}'s recruiters</h4>
            {!r.recruiters.length ? <div className="hs-empty">No recruiter reports to {r.name} yet.</div> : (
              <table className="hs-tbl hs-tbl-in">
                <thead><tr><th>Recruiter</th>{TL_COLS.map(([k, l, h]) => <th key={k} className="num" title={h}>{l}</th>)}</tr></thead>
                <tbody>{r.recruiters.map((p) => (
                  <tr key={p.id}><td className="hs-who" data-label="Recruiter"><span className="hs-avatar" aria-hidden="true">{initials(p.name)}</span><b>{p.name}</b></td><PersonCells r={p} onDrill={onDrill} /></tr>
                ))}</tbody>
              </table>
            )}
            <h4>{r.name}'s open jobs</h4>
            <OpenJobs w={{ title: '', total: r.openJobs }} params={params} onDrill={onDrill} onCand={onCand} tlId={r.id} inner />
          </div>
        </td></tr>
      )}
    </Fragment>
  );
  return (
    <section className="panel hs-box">
      <Head
        title={w.title}
        help="Each team lead with their team's numbers. Click a name to see their recruiters and open jobs."
        right={rows.length > 5 ? <button type="button" className="link-btn" onClick={() => setAll(!all)}>{all ? 'Show top 5' : `Show all ${fmt(rows.length)}`}</button> : null}
      />
      {!rows.length ? <div className="hs-empty">No team lead here yet. Team leads show once jobs or recruiters are given to them.</div> : (
        <div className="hs-wrap">
          <table className="hs-tbl">
            <thead><tr><th>Team lead</th><th className="num" title="Recruiters whose seat reports to them">Recruiters</th>{TL_COLS.map(([k, l, h]) => <th key={k} className="num" title={h}>{l}</th>)}</tr></thead>
            {groups.map((g) => (
              <tbody key={g.department || 'top'}>
                {grouped && <tr className="hs-group"><td colSpan={TL_COLS.length + 2}>{g.department} · {g.rows.length} {g.rows.length === 1 ? 'team lead' : 'team leads'}</td></tr>}
                {g.rows.map(row)}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </section>
  );
}

// ---- OPEN JOBS ------------------------------------------------------------------------------
const SORTS = [['late', 'Most late first'], ['busy', 'Most people first'], ['newest', 'Newest first'], ['oldest', 'Oldest first'], ['title', 'Job name A–Z']];
function Steps({ s }) {
  return (
    <span className="hs-steps" aria-label={STEP_SHORT.map((l, i) => `${l} ${s[i]}`).join(', ')}>
      {STEP_SHORT.map((l, i) => (
        <span key={l} className={`hs-step${s[i] ? ' has' : ''}${i === 4 && s[i] ? ' t-green' : ''}`} title={`${l}: ${s[i]} ${s[i] === 1 ? 'person' : 'people'} reached this step`}>
          <i>{l}</i><b>{s[i] ? fmt(s[i]) : '–'}</b>
        </span>
      ))}
    </span>
  );
}

export function OpenJobs({ w, params, onDrill, onCand, tlId = null, inner = false }) {
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [sort, setSort] = useState('late');
  const [all, setAll] = useState(false);
  const [page, setPage] = useState(1);
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [open, setOpen] = useState(null);
  const pkey = JSON.stringify(params);
  useEffect(() => { const t = setTimeout(() => { setTerm(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    api.get(LIST_URL, { params: { ...params, set: '__jobs', d_q: term || undefined, d_sort: sort, d_page: page, d_size: all ? 25 : 5, d_tlid: tlId || undefined } })
      .then((r) => { if (live) setState({ loading: false, data: r.data, error: '' }); })
      .catch((e) => { if (live) setState({ loading: false, data: null, error: errText(e) }); });
    return () => { live = false; };
  }, [pkey, term, sort, page, all, tlId]); // eslint-disable-line react-hooks/exhaustive-deps
  const d = state.data;
  const pages = d ? Math.max(1, Math.ceil(d.filtered / d.pageSize)) : 1;
  const body = (
    <>
      <div className="hs-tools">
        <input type="search" className="hs-search" placeholder="Search job, job ID, client or person…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search open jobs" />
        <select value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }} aria-label="Sort open jobs">
          {SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        {d && d.total > 5 && (
          <button type="button" className="btn btn-sm" onClick={() => { setAll(!all); setPage(1); }}>{all ? 'Show top 5' : `Show all ${fmt(d.total)}`}</button>
        )}
      </div>
      {state.error && <div className="notice red">{state.error}</div>}
      {!d && state.loading && <div className="hs-empty">Loading the open jobs…</div>}
      {d && !d.rows.length && (
        <div className="hs-empty">{term ? `No open job matches "${term}". Try another word.` : tlId ? 'No open job for this team lead yet.' : 'No open jobs here. New jobs show here when a client asks for people.'}</div>
      )}
      {d && d.rows.length > 0 && (
        <ul className={`hs-jobs${state.loading ? ' is-loading' : ''}`}>
          {d.rows.map((r) => (
            <li key={r.id} className={open === r.id ? 'is-open' : ''}>
              <button type="button" className="hs-job" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                <span className="hs-job-main">
                  <span className="hs-job-t">{r.reqCode && <span className="hs-code">{r.reqCode}</span>}<b>{r.title}</b></span>
                  <span className="hs-sub">
                    {[r.client, r.tl ? `Team lead: ${r.tl}` : 'No team lead yet', r.recruiters.length ? `Recruiter: ${r.recruiters.join(', ')}` : 'No recruiter yet'].filter(Boolean).join(' · ')}
                  </span>
                  <span className="hs-sub">Opened {dayOf(r.createdAt)}{r.ageDays !== null ? ` · open ${ageWords(r.ageDays)}` : ''}</span>
                </span>
                <Steps s={r.steps} />
                <span className="hs-job-late">{r.late ? <StatusChip tone="red">{fmt(r.late)} late</StatusChip> : null}</span>
                <span className="hs-caret" aria-hidden="true">{open === r.id ? '▴' : '▾'}</span>
              </button>
              {open === r.id && <JobDetail id={r.id} params={params} onCand={onCand} />}
            </li>
          ))}
        </ul>
      )}
      {d && all && pages > 1 && (
        <div className="hs-pager">
          <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Back</button>
          <span className="small-muted">Page {page} of {fmt(pages)} · {fmt(d.filtered)} jobs</span>
          <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next →</button>
        </div>
      )}
    </>
  );
  if (inner) return <div className="hs-inner-jobs">{body}</div>;
  return (
    <section className="panel hs-box">
      <Head
        title={w.title}
        help="Every open job. Each shows how many people reached each step. Click a job to see who is handling it."
        right={w.total ? <button type="button" className="link-btn" onClick={() => onDrill(w.drill)} title="Open the full list with filters and Excel">{fmt(w.total)} open · list ↗</button> : null}
      />
      {body}
    </section>
  );
}

// ---- ONE JOB, OPENED IN PLACE -----------------------------------------------------------------
function JobDetail({ id, params, onCand }) {
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  useEffect(() => {
    let live = true;
    api.get(LIST_URL, { params: { ...params, set: `__job:${id}` } })
      .then((r) => { if (live) setState({ loading: false, data: r.data, error: '' }); })
      .catch((e) => { if (live) setState({ loading: false, data: null, error: errText(e) }); });
    return () => { live = false; };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (state.loading) return <div className="hs-detail"><div className="hs-empty">Loading who is handling this job…</div></div>;
  if (state.error) return <div className="hs-detail"><div className="notice red">{state.error}</div></div>;
  const d = state.data;
  const h = d.handlers;
  const person = (p) => (
    <button key={p.id} type="button" className={`hs-person${p.late ? ' is-late' : ''}`} onClick={() => onCand({ candidateId: p.candidateId, applicationId: p.id })} title={`${p.name}${p.recruiter ? ` · recruiter ${p.recruiter}` : ''}${p.late ? ' · late' : ''} — open the profile`}>
      {p.name}
    </button>
  );
  return (
    <div className="hs-detail">
      <div className="hs-detail-grid">
        <div>
          <h4>Who is handling it</h4>
          <dl className="hs-dl">
            <dt>Team lead</dt><dd>{h.tl || 'No team lead named yet'}{!h.tl && h.tlWorked && h.tlWorked.length > 0 ? <span className="hs-sub">Worked on by {h.tlWorked.join(', ')}</span> : null}</dd>
            <dt>Client manager (BDE)</dt><dd>{h.bde || 'Not named yet'}</dd>
          </dl>
          {!h.recruiters.length ? <div className="hs-empty">No recruiter yet. The team lead gives this job to a recruiter.</div> : (
            <table className="hs-tbl hs-tbl-in">
              <thead><tr><th>Recruiter</th>{STEP_SHORT.map((l) => <th key={l} className="num">{l}</th>)}<th className="num">Late</th></tr></thead>
              <tbody>{h.recruiters.map((r) => (
                <tr key={r.id || r.name}>
                  <td data-label="Recruiter"><b>{r.name}</b>{!r.assigned && <span className="hs-sub">worked on it (not assigned)</span>}</td>
                  {r.steps.map((n, i) => <td key={STEP_SHORT[i]} className="num" data-label={STEP_SHORT[i]}>{n ? fmt(n) : <span className="hs-dash">–</span>}</td>)}
                  <td className="num" data-label="Late">{r.late ? <span className="hs-red">{fmt(r.late)}</span> : <span className="hs-dash">–</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
          {h.othersMore > 0 && <div className="hs-sub">+ {fmt(h.othersMore)} more people worked on this job.</div>}
        </div>
        <div>
          <h4>Coming interviews</h4>
          {!d.interviews.length ? <div className="hs-empty">No interview booked. Book one from the person's profile.</div> : (
            <ul className="hs-mini">
              {d.interviews.map((i) => (
                <li key={i.id}><span className="hs-when">{whenOf(i.at)}</span><button type="button" className="hs-person" onClick={() => onCand({ candidateId: i.candidateId, applicationId: i.id })}>{i.name}</button><span className="hs-sub">Round {i.round}{i.mode ? ` · ${i.mode}` : ''}</span></li>
              ))}
            </ul>
          )}
          <h4>Last 5 things that happened</h4>
          {!d.activity.length ? <div className="hs-empty">Nothing recorded yet. Steps people move show here.</div> : (
            <ul className="hs-mini">
              {d.activity.map((a) => (
                <li key={a.id}><span className={`hs-dot t-${a.tone}`} aria-hidden="true" /><span>{a.text}<span className="hs-sub">{a.by} · {whenOf(a.at)}</span></span></li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <h4>People on this job, by step</h4>
      {!d.pipeline.length ? <div className="hs-empty">Nobody on this job yet. Add people from Candidates.</div> : (
        <div className="hs-pipe">
          {d.pipeline.map((p) => (
            <div key={p.step} className="hs-pipe-step">
              <div className="hs-pipe-h"><b>{p.step}</b><span className="hs-sub">{fmt(p.count)}</span></div>
              <div className="hs-pipe-p">
                {p.people.map(person)}
                {p.count > p.people.length && <span className="hs-sub">+ {fmt(p.count - p.people.length)} more</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
