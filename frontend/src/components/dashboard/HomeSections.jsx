import { Fragment, useState } from 'react';
import { Help } from '../ui/Guide.jsx';
import { OpenJobs } from './JobsBoard.jsx';
import './homeSections.css';

export { OpenJobs };

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
// One number that opens its list; a real zero is a quiet grey 0 (a dash would look like missing data).
function N({ value, drill, onDrill, tone, what }) {
  if (!value) return <span className="hs-dash hs-zero" aria-label="none" title={what ? `None: ${what}` : 'None'}>0</span>;
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
            <span key={i.id} className="hs-today-i is-none" title={`${i.hint} None so far today.`}><b>0</b><span>{i.label}</span></span>
          )))}
        </div>
      )}
    </section>
  );
}

// ---- TEAM LEADS ---------------------------------------------------------------------------
// [key, label, hint, basis]: the second header line says what the column counts.
const TL_COLS = [
  ['openJobs', 'Open requirements', 'Open requirements they lead or their recruiters hold.', 'today'],
  ['inProcess', 'In process', 'People on their requirements now (not rejected, on hold or joined).', 'today'],
  ['interviews', 'Interviews', 'Interviews in the dates you picked.', 'dates'],
  ['selected', 'Selected', 'Selected or offered, not joined yet.', 'today'],
  ['joined', 'Joined', 'People whose joining date is in the dates you picked.', 'dates'],
  ['joinedTotal', 'Joined', 'Everyone marked Joined, whatever the joining date.', 'in total'],
  ['late', 'Late', 'Work past its due date.', 'today'],
];
const basisOf = (b, word) => (b === 'today' ? 'as of today' : b === 'dates' ? (word || 'in the dates picked') : b);
function TlHead({ cols, word }) {
  return cols.map(([k, l, h, b]) => (
    <th key={k} className="num hs-th" title={`${h} (${basisOf(b, word)})`}><span className="hs-th-l">{l}</span><small className="hs-th-b">{basisOf(b, word)}</small></th>
  ));
}
function PersonCells({ r, onDrill, cols = TL_COLS }) {
  // A person with nothing yet: one plain line, never a row of zeros.
  if (cols.every(([k]) => !r[k])) return <td colSpan={cols.length} className="hs-nojobs" style={{ textAlign: 'left' }}><span className="small-muted">No requirements yet</span></td>;
  return cols.map(([k, l]) => (
    <td key={k} className="num" data-label={l}>
      <N value={r[k]} drill={r.drills[k]} onDrill={onDrill} tone={k === 'late' ? 'red' : k === 'joined' || k === 'joinedTotal' ? 'green' : null} what={`${r.name} — ${l}`} />
    </td>
  ));
}
const initials = (name) => String(name || '?').trim().split(/\s+/).map((s) => s[0]).slice(0, 2).join('').toUpperCase();

export function TeamLeads({ w, onDrill, tls, params, onCand }) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(null);
  const data = tls && tls.data;
  if (!tls || tls.loading) return <section className="panel hs-box"><Head title={w.title} /><div className="hs-empty">Loading the team leads...</div></section>;
  if (tls.error) return <section className="panel hs-box"><Head title={w.title} /><div className="notice red">{tls.error}{tls.retry && <> <button type="button" className="btn btn-sm" onClick={tls.retry}>Try again</button></>}</div></section>;
  const rows = data.rows || [];
  const cols = TL_COLS.filter(([k]) => !(data.periodAll && k === 'joined'));
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
        <td className="num" data-label="Recruiters">{r.teamSize ? fmt(r.teamSize) : <span className="hs-dash hs-zero" title="None">0</span>}</td>
        <PersonCells r={r} onDrill={onDrill} cols={cols} />
      </tr>
      {open === r.id && (
        <tr className="hs-open-row"><td colSpan={cols.length + 2}>
          <div className="hs-inside">
            <h4>{r.name}'s recruiters</h4>
            {!r.recruiters.length ? <div className="hs-empty">No recruiter reports to {r.name} yet.</div> : (
              <table className="hs-tbl hs-tbl-in">
                <thead><tr><th>Recruiter</th><TlHead cols={cols} word={data.word} /></tr></thead>
                <tbody>{r.recruiters.map((p) => (
                  <tr key={p.id}><td className="hs-who" data-label="Recruiter"><span className="hs-avatar" aria-hidden="true">{initials(p.name)}</span><b>{p.name}</b></td><PersonCells r={p} onDrill={onDrill} cols={cols} /></tr>
                ))}</tbody>
              </table>
            )}
            <h4>{r.name}'s open requirements</h4>
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
        help="Each team lead with their team's numbers. Click a name to see their recruiters and open requirements."
        right={rows.length > 5 ? <button type="button" className="link-btn" onClick={() => setAll(!all)}>{all ? 'Show top 5' : `Show all ${fmt(rows.length)}`}</button> : null}
      />
      {!rows.length ? <div className="hs-empty">No team lead here yet. Team leads show once requirements or recruiters are given to them.</div> : (
        <div className="hs-wrap">
          <table className="hs-tbl">
            <thead><tr><th>Team lead</th><th className="num hs-th" title="Recruiters whose seat reports to them"><span className="hs-th-l">Recruiters</span><small className="hs-th-b">&nbsp;</small></th><TlHead cols={cols} word={data.word} /></tr></thead>
            {groups.map((g) => (
              <tbody key={g.department || 'top'}>
                {grouped && <tr className="hs-group"><td colSpan={cols.length + 2}>{g.department} · {g.rows.length} {g.rows.length === 1 ? 'team lead' : 'team leads'}</td></tr>}
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
// The jobs list (grouped by what to do, one row per job, three cards when opened) lives in
// JobsBoard.jsx (user, 2026-10-12: "make this much clear"). Same name, same props.
