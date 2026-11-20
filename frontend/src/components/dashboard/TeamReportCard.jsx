import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import './teamReportCard.css';

// "REPORT OF YOUR TEAM" on the ATS dashboard (founder 2026-11-20): only for team leads. One small table, one row per recruiter, four numbers
// and a View button; View opens that recruiter's report in a side panel: the candidates they added and every follow-up with what was written.
// A Super Admin has no card; they get one button, "Overall report", that opens the same table for everybody.
// The server (/api/followup-report, utils/followUpScope.js) decides who is in the picture; this screen only draws what it is sent.
const DAY = 86400000;
const plus = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const monday = (ymd) => plus(ymd, -((new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7));
const monthStart = (ymd) => `${ymd.slice(0, 7)}-01`;
const fmtDay = (ymd) => {
  const [y, m, d] = String(ymd || '').slice(0, 10).split('-').map(Number);
  if (!y) return '';
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
};
const presetsFor = (today) => {
  const wk = monday(today);
  return [
    ['today', 'Today', today, today],
    ['yesterday', 'Yesterday', plus(today, -1), plus(today, -1)],
    ['thisweek', 'This week', wk, plus(wk, 6)],
    ['thismonth', 'This month', monthStart(today), today],
  ];
};
// the history says each date as { day, est }
const dayOf = (v) => String((v && typeof v === 'object' ? v.day : v) || '').slice(0, 10);
const SHOWN = [['added', 'Follow-ups added'], ['done', 'Follow-ups done'], ['logged', 'Calls / messages'], ['overdue', 'Overdue']];
const STATUS_CLASS = { Overdue: 'trc-bad', 'Done late': 'trc-warn', Done: 'trc-ok', 'Due today': 'trc-warn' };

// the side panel: ONE person's report for the chosen days
function PersonPanel({ person, from, to, onClose }) {
  const [fu, setFu] = useState(null);
  const [cands, setCands] = useState(undefined); // undefined = loading, null = not allowed to read
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    api.get('/followup-report/list', { params: { from, to, personId: person.id, limit: 300 } })
      .then((r) => { if (alive) setFu(r.data); }).catch((e) => { if (alive) setErr(e.response?.data?.error || 'The follow-ups could not be loaded.'); });
    api.get(`/ats/history/recruiter/${person.id}`, { params: { from, to } })
      .then((r) => { if (alive) setCands(r.data); }).catch(() => { if (alive) setCands(null); });
    return () => { alive = false; };
  }, [person.id, from, to]);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  // the people this recruiter ADDED in these days (the history rows say the day each was added)
  const added = useMemo(() => {
    if (!cands || !cands.rows) return [];
    return cands.rows.filter((x) => dayOf(x.added) && dayOf(x.added) >= from && dayOf(x.added) <= to)
      .sort((a, b) => dayOf(b.added).localeCompare(dayOf(a.added)));
  }, [cands, from, to]);

  return (
    <div className="trd-wrap" role="presentation">
      <div className="trd-back" onMouseDown={onClose} aria-hidden="true" />
      <aside className="trd-panel" role="dialog" aria-modal="true" aria-label={`Report of ${person.name}`}>
        <div className="trd-bar">
          <div className="trd-title">
            <b>{person.name}</b>
            <span className="small-muted">{[person.role, person.leadName ? `TL ${person.leadName}` : '', `${fmtDay(from)}${from === to ? '' : ` to ${fmtDay(to)}`}`].filter(Boolean).join(' · ')}</span>
          </div>
          <Link className="btn btn-sm" to={`/ats/history/recruiter/${person.id}`} onClick={onClose}>Complete history</Link>
          <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
        <div className="trd-body">
          <div className="trd-nums">
            {SHOWN.map(([k, l], i) => <div key={k} className={k === 'overdue' && person.m[i] ? 'trc-bad' : ''}><b>{person.m[i] || 0}</b><span>{l}</span></div>)}
            <div><b>{added.length}</b><span>Candidates added</span></div>
          </div>

          <h4>Candidates added</h4>
          {cands === undefined ? <div className="small-muted">Loading…</div> : cands === null ? <div className="small-muted">This list is not available to you.</div> : (
            <div className="trd-scroll">
              <table className="trc-table">
                <thead><tr><th>Added on</th><th>Candidate</th><th>Requirement</th><th>Now</th></tr></thead>
                <tbody>
                  {added.map((x) => (
                    <tr key={x.applicationId}>
                      <td>{fmtDay(dayOf(x.added))}</td>
                      <td><Link to={`/candidates/${x.candidateId}`} onClick={onClose}>{x.candidate}</Link></td>
                      <td>{x.requirement}{x.client ? <div className="small-muted">{x.client}</div> : null}</td>
                      <td>{x.outcome ? String(x.outcome).replace(/^./, (c) => c.toUpperCase()) : (x.stageLabel || x.step || '')}</td>
                    </tr>
                  ))}
                  {added.length === 0 && <tr><td colSpan={4} className="small-muted">No candidate was added in these days.</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          <h4>Follow-ups and what was written</h4>
          {err && <div className="error-text">{err}</div>}
          {!fu && !err ? <div className="small-muted">Loading…</div> : fu && (
            <div className="trd-scroll">
              <table className="trc-table">
                <thead><tr><th>Date</th><th>Candidate / client</th><th>Requirement</th><th>What happened</th><th>Call back on</th><th>Answer</th><th>Status</th></tr></thead>
                <tbody>
                  {fu.rows.map((r) => (
                    <tr key={r.id}>
                      <td>{fmtDay(r.day)}</td>
                      <td>{r.link ? <Link to={r.link} onClick={onClose}>{r.candidateName || r.kind}</Link> : r.candidateName}<div className="small-muted">{r.type}</div></td>
                      <td>{r.requirement || ''}{r.client ? <div className="small-muted">{r.client}</div> : null}</td>
                      <td className="trc-what">{r.what}</td>
                      <td>{r.callBackDay ? fmtDay(r.callBackDay) : ''}</td>
                      <td>{r.outcome || ''}</td>
                      <td><span className={STATUS_CLASS[r.status] || ''}>{r.status}</span></td>
                    </tr>
                  ))}
                  {fu.rows.length === 0 && <tr><td colSpan={7} className="small-muted">No follow-up in these days.</td></tr>}
                </tbody>
              </table>
              {fu.total > fu.rows.length && <div className="small-muted">{`${fu.rows.length} of ${fu.total} follow-ups shown. Narrow the days to see the rest.`}</div>}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

// the days chosen (Today, Yesterday, This week, This month or two dates), shared by every level of the Overall report
function useRange() {
  const [opts, setOpts] = useState(null);
  const [range, setRange] = useState({ from: '', to: '' });
  const [preset, setPreset] = useState('today');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.get('/followup-report/options').then((r) => {
      setOpts(r.data);
      const p = presetsFor(r.data.today)[0];
      setRange({ from: p[2], to: p[3] });
    }).catch(() => setFailed(true));
  }, []);
  return {
    opts, range, preset, failed,
    choose: (key, from, to) => { setPreset(key); setRange({ from, to }); },
    setFrom: (v) => { setPreset('custom'); setRange((r) => ({ ...r, from: v })); },
    setTo: (v) => { setPreset('custom'); setRange((r) => ({ ...r, to: v })); },
  };
}
function RangeBar({ r, children }) {
  return (
    <div className="trc-bar">
      {presetsFor(r.opts.today).map(([k, l, f, t]) => <button key={k} type="button" className={`btn btn-sm${r.preset === k ? ' btn-primary' : ''}`} onClick={() => r.choose(k, f, t)}>{l}</button>)}
      <label className="small-muted">From <input type="date" value={r.range.from} max={r.range.to || undefined} onChange={(e) => r.setFrom(e.target.value)} /></label>
      <label className="small-muted">To <input type="date" value={r.range.to} min={r.range.from || undefined} onChange={(e) => r.setTo(e.target.value)} /></label>
      {children}
    </div>
  );
}
const useSummary = (r, leadId) => {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!r.opts || !r.range.from || !r.range.to || r.range.to < r.range.from) return;
    api.get('/followup-report/summary', { params: { from: r.range.from, to: r.range.to, period: 'day', imported: 'include', leadId: leadId || undefined } })
      .then((x) => { setData(x.data); setFailed(false); }).catch(() => setFailed(true));
  }, [r.opts, r.range.from, r.range.to, leadId]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, failed };
};
const sum4 = (rows) => [0, 1, 2, 3].map((i) => rows.reduce((n, x) => n + (x.m[i] || 0), 0));
const Num = ({ v, bad }) => <td className={`trc-num${v ? '' : ' trc-zero'}${bad && v ? ' trc-bad' : ''}`}>{v || '–'}</td>;

// ONE team: one row per recruiter + View, and the team's overall line. Used in the team lead's card and inside the Super Admin's team page.
function TeamTable({ r, leadId, title, onBack, onClose }) {
  const { data, failed } = useSummary(r, leadId);
  const [open, setOpen] = useState(null);
  if (failed && !data) return onClose ? <div className="error-text">The report could not be loaded.</div> : null; // a login with no report simply has no card
  if (!r.opts) return onClose ? <div className="small-muted">Loading…</div> : null;
  const idx = data ? SHOWN.map(([k]) => data.fields.indexOf(k)) : [];
  const shown = (x) => ({ ...x, m: idx.map((i) => (i >= 0 ? x.m[i] : 0)) });
  return (
    <>
      <div className="trc-head">
        <div className="trc-titlebar">
          {onBack && <button type="button" className="btn btn-sm" onClick={onBack}>← All team leads</button>}
          <h3>{title}</h3>
        </div>
        <RangeBar r={r}>{onClose && <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>}</RangeBar>
      </div>
      {!data ? <div className="small-muted">Loading…</div> : (
        <div className="trd-scroll">
          <table className="trc-table">
            <thead>
              <tr><th>Recruiter</th>{SHOWN.map(([k, l]) => <th key={k} className="trc-num">{l}</th>)}<th /></tr>
            </thead>
            <tbody>
              {data.rows.map((raw) => {
                const x = shown(raw);
                return (
                  <tr key={x.id}>
                    <td><b>{x.name}</b>{x.role === 'TL' ? <span className="trc-tag">team lead</span> : null}{x.former ? <span className="trc-tag">left</span> : null}</td>
                    {x.m.map((v, i) => <Num key={SHOWN[i][0]} v={v} bad={SHOWN[i][0] === 'overdue'} />)}
                    <td className="trc-act"><button type="button" className="btn btn-sm" onClick={() => setOpen(x)}>View</button></td>
                  </tr>
                );
              })}
              {data.rows.length === 0 && <tr><td colSpan={SHOWN.length + 2} className="small-muted">Nobody in this team yet.</td></tr>}
            </tbody>
            {data.rows.length > 1 && (
              <tfoot>
                <tr><td><b>Team overall</b></td>{idx.map((i, n) => <td key={SHOWN[n][0]} className="trc-num"><b>{(i >= 0 && data.total.m[i]) || '–'}</b></td>)}<td /></tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {open && <PersonPanel person={open} from={r.range.from} to={r.range.to} onClose={() => setOpen(null)} />}
    </>
  );
}

// the Super Admin's first page: ONE ROW PER TEAM LEAD with the team's numbers; View opens that team (its recruiters, the team overall)
function TlList({ r, onPick, onClose }) {
  const { data, failed } = useSummary(r, '');
  const [openOne, setOpenOne] = useState(null);
  if (failed && !data) return <div className="error-text">The report could not be loaded.</div>;
  if (!r.opts || !data) return <div className="small-muted">Loading…</div>;
  const idx = SHOWN.map(([k]) => data.fields.indexOf(k));
  const mOf = (x) => idx.map((i) => (i >= 0 ? x.m[i] : 0));
  const tls = data.rows.filter((x) => ['TL', 'STL'].includes(x.role));
  const teams = tls.map((tl) => {
    const members = data.rows.filter((x) => x.id !== tl.id && x.leadName === tl.name);
    return { tl, members, m: sum4([{ m: mOf(tl) }, ...members.map((x) => ({ m: mOf(x) }))]) };
  }).sort((a, b) => a.tl.name.localeCompare(b.tl.name));
  const none = data.rows.filter((x) => !['TL', 'STL'].includes(x.role) && !x.leadName);
  return (
    <>
      <div className="trc-head">
        <h3>Overall report</h3>
        <RangeBar r={r}>{onClose && <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>}</RangeBar>
      </div>
      <div className="trd-scroll">
        <table className="trc-table">
          <thead>
            <tr><th>Team lead</th><th className="trc-num">Recruiters</th>{SHOWN.map(([k, l]) => <th key={k} className="trc-num">{l}</th>)}<th /></tr>
          </thead>
          <tbody>
            {teams.map(({ tl, members, m }) => (
              <tr key={tl.id}>
                <td><b>{tl.name}</b>{tl.former ? <span className="trc-tag">left</span> : null}</td>
                <td className="trc-num">{members.length || '–'}</td>
                {m.map((v, i) => <Num key={SHOWN[i][0]} v={v} bad={SHOWN[i][0] === 'overdue'} />)}
                <td className="trc-act"><button type="button" className="btn btn-sm" onClick={() => onPick(tl)}>View</button></td>
              </tr>
            ))}
            {none.length > 0 && (
              <tr>
                <td><b>No team lead</b><div className="small-muted">{none.map((x) => x.name).join(', ')}</div></td>
                <td className="trc-num">{none.length}</td>
                {sum4(none.map((x) => ({ m: mOf(x) }))).map((v, i) => <Num key={SHOWN[i][0]} v={v} bad={SHOWN[i][0] === 'overdue'} />)}
                <td className="trc-act">{none.length === 1 ? <button type="button" className="btn btn-sm" onClick={() => setOpenOne(none[0])}>View</button> : null}</td>
              </tr>
            )}
            {teams.length === 0 && none.length === 0 && <tr><td colSpan={SHOWN.length + 3} className="small-muted">Nobody to show.</td></tr>}
          </tbody>
          <tfoot>
            <tr><td><b>Everyone</b></td><td />{idx.map((i, n) => <td key={SHOWN[n][0]} className="trc-num"><b>{(i >= 0 && data.total.m[i]) || '–'}</b></td>)}<td /></tr>
          </tfoot>
        </table>
      </div>
      {openOne && <PersonPanel person={{ ...openOne, m: mOf(openOne) }} from={r.range.from} to={r.range.to} onClose={() => setOpenOne(null)} />}
    </>
  );
}

function OverallPanel({ onClose }) {
  const r = useRange();
  const [lead, setLead] = useState(null);
  if (r.failed) return <div className="error-text">The report could not be loaded.</div>;
  if (!r.opts) return <div className="small-muted">Loading…</div>;
  return lead
    ? <TeamTable r={r} leadId={lead.id} title={`${lead.name}'s team`} onBack={() => setLead(null)} onClose={onClose} />
    : <TlList r={r} onPick={setLead} onClose={onClose} />;
}

// the team lead's own report page (inside the side panel): their team, recruiter by recruiter, with the team overall
function TlPanel({ onClose }) {
  const r = useRange();
  if (r.failed) return <div className="error-text">The report could not be loaded.</div>;
  if (!r.opts) return <div className="small-muted">Loading…</div>;
  return <TeamTable r={r} title="Report of your team" onClose={onClose} />;
}

// the dashboard piece: the SAME "Overall report" button for a Super Admin (team leads first) and for a team lead (their team); it opens a side
// panel. Nobody else gets anything.
export default function TeamReportCard({ user }) {
  const [open, setOpen] = useState(false);
  if (!user) return null;
  const admin = user.role === 'SUPER_ADMIN';
  if (!admin && user.atsRole !== 'TL') return null;
  return (
    <div className="trc-adminbar">
      <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>Overall report</button>
      <span className="small-muted">{admin ? "Every team lead's team: click a team lead for their recruiters, a recruiter for their own work." : "Your team: every recruiter's follow-ups, calls and the candidates they added. Click View on a recruiter."}</span>
      {open && (
        <div className="trd-wrap" role="presentation">
          <div className="trd-back" onMouseDown={() => setOpen(false)} aria-hidden="true" />
          <aside className="trd-panel" role="dialog" aria-modal="true" aria-label={admin ? 'Overall report' : 'Report of your team'}>
            <div className="trd-body">{admin ? <OverallPanel onClose={() => setOpen(false)} /> : <TlPanel onClose={() => setOpen(false)} />}</div>
          </aside>
        </div>
      )}
    </div>
  );
}
