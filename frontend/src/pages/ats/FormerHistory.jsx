import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import EmptyState from '../../components/ui/EmptyState.jsx';
import '../../components/CandidateDrawer.css';
import './FormerHistory.css';

// ---------------------------------------------------------------------------
// A FORMER PERSON'S WORK HISTORY (user, 2026-10-05) — the side panel Team →
// People opens for somebody who has left. Everything is read from HRMS (seats,
// departments, last working day) and from the ATS work attributed to them;
// nothing is stored for this screen. Data: GET /api/ats/team/former/:id
// (utils/formerPeople.js) — scope-checked on the server: a TL / Manager sees
// only the work in their own departments.
// ---------------------------------------------------------------------------

const fmt = (n) => Number(n || 0).toLocaleString('en-IN');
const day = (v) => (v ? new Date(`${String(v).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : null);
const monthName = (m) => (m ? new Date(`${m}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) : '');
const span = (from, to) => `${day(from) || 'start not recorded'} – ${day(to) || 'end not recorded'}`;
export const leftLine = (leftOn) => (leftOn ? `Left on ${day(leftOn)}` : 'Left · last day not recorded');

const COLS = [
  ['added', 'Added', 'Candidates they put forward on a job'],
  ['sent', 'Sent to client', 'Of those, sent to the client'],
  ['interviews', 'Interviews', 'Reached an interview'],
  ['selected', 'Selected', 'Selected or offered'],
  ['joined', 'Joined', 'Joined'],
];
const JOBS_PREVIEW = 8;
const ROLE_PARAM = { RECRUITER: 'recruiter', TL: 'tl', STL: 'tl', BDE: 'bde' };

function Section({ title, children, right }) {
  return (
    <section className="cdw-card fh-sec">
      <div className="cdw-label fh-sec-head"><span>{title}</span>{right}</div>
      {children}
    </section>
  );
}

export default function FormerHistory({ personId, onClose }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [allJobs, setAllJobs] = useState(false);
  useEffect(() => {
    setD(null);
    setError('');
    api.get(`/ats/team/former/${encodeURIComponent(personId)}`)
      .then((r) => setD(r.data))
      .catch((e) => setError(e.response?.data?.error || 'Could not open this person. Please try again.'));
  }, [personId]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const p = d && d.person;
  const t = (d && d.totals) || {};
  const showMoved = !!(d && d.totals && d.totals.moved);
  const param = p && ROLE_PARAM[p.role];
  const candidatesLink = p && param ? `/candidates?${param}=${encodeURIComponent(`name:${p.name}`)}` : null;
  const jobs = d ? (allJobs ? d.jobs : d.jobs.slice(0, JOBS_PREVIEW)) : [];

  return (
    <div className="cdw-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="cdw fh" role="dialog" aria-label={p ? `${p.name} — work history` : 'Work history'}>
        <div className="cdw-head">
          <div style={{ minWidth: 0 }}>
            <div className="cdw-name">{p ? p.name : 'Loading…'}</div>
            {p && (
              <div className="cdw-contact">
                <span className="small-muted">{`Former ${p.roleLabel}`}</span>
                {p.employeeCode && <span>{`Employee ID ${p.employeeCode}`}</span>}
                <span className="fh-left">{leftLine(p.leftOn)}</span>
              </div>
            )}
          </div>
          <button type="button" className="cdw-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        {error && <div className="notice red" style={{ margin: '10px 16px' }}>{error}</div>}
        {!d && !error && <div className="small-muted" style={{ padding: 16 }}>Loading…</div>}

        {d && (
          <div className="cdw-body">
            {d.partial && <div className="fh-note">Only the work in your departments is shown.</div>}

            {/* --- Totals --- */}
            <Section
              title="Their work, in total"
              right={candidatesLink && t.added > 0 ? <Link to={candidatesLink} className="fh-all">Open their candidates →</Link> : null}
            >
              {t.added
                ? (
                  <div className="fh-tiles">
                    {COLS.map(([k, label, hint]) => (
                      <div key={k} className="fh-tile" title={hint}>
                        <span className="small-muted">{label}</span>
                        <b className={t[k] ? '' : 'is-zero'}>{t[k] ? fmt(t[k]) : 'None'}</b>
                      </div>
                    ))}
                    <div className="fh-tile" title="Jobs they worked on">
                      <span className="small-muted">Jobs</span>
                      <b>{fmt(t.jobs)}</b>
                    </div>
                  </div>
                )
                : <EmptyState compact icon="🗂️" title="No ATS work is recorded under their name." />}
              {t.added > 0 && (d.asRole.TL > 0 || d.asRole.BDE > 0) && (
                <div className="small-muted fh-roles">
                  {[['RECRUITER', 'as recruiter'], ['TL', 'as team lead'], ['BDE', 'as client manager (BDE)']]
                    .filter(([k]) => d.asRole[k] > 0).map(([k, w]) => `${fmt(d.asRole[k])} ${w}`).join(' · ')}
                </div>
              )}
            </Section>

            {/* --- Seats and departments over time --- */}
            <Section title="Seats and departments">
              {d.seats.length > 0 && (
                <div className="fh-list">
                  {d.seats.map((s, i) => (
                    // eslint-disable-next-line react/no-array-index-key
                    <div key={`${s.code}-${i}`} className="fh-row">
                      <div className="fh-row-main">
                        <b>{s.code}</b>
                        <span className="small-muted">{[s.team || s.department, s.tl && `TL ${s.tl}`].filter(Boolean).join(' · ')}</span>
                      </div>
                      <div className="small-muted">{span(s.from, s.to)}</div>
                    </div>
                  ))}
                </div>
              )}
              <div className="fh-list">
                {d.stints.map((s) => (
                  <div key={s.department} className="fh-row">
                    <div className="fh-row-main">
                      <b>{s.department}</b>
                      <span className="small-muted">{s.via.join(', ')}</span>
                    </div>
                    <div className="small-muted">{span(s.from, s.to)}</div>
                  </div>
                ))}
              </div>
              {!d.seats.length && <div className="small-muted fh-pad">No seat is recorded for them in Positions & Seat History.</div>}
            </Section>

            {/* --- Month by month --- */}
            <Section title="Month by month">
              {d.months.length
                ? (
                  <div className="tbl-wrap">
                    <table className="fh-table">
                      <thead>
                        <tr>
                          <th>Month</th>
                          {COLS.map(([k, label, hint]) => <th key={k} className="num" title={hint}>{label}</th>)}
                          {showMoved && <th className="num" title="Steps they moved candidates on">Moved</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {d.months.map((m) => (
                          <tr key={m.month}>
                            <td>{monthName(m.month)}</td>
                            {COLS.map(([k]) => <td key={k} className="num">{m[k] ? fmt(m[k]) : <span className="cell-muted">—</span>}</td>)}
                            {showMoved && <td className="num">{m.moved ? fmt(m.moved) : <span className="cell-muted">—</span>}</td>}
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td>Total</td>
                          {COLS.map(([k]) => <td key={k} className="num">{fmt(t[k])}</td>)}
                          {showMoved && <td className="num">{fmt(t.moved)}</td>}
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )
                : <EmptyState compact icon="📅" title="No dated work to show month by month." />}
            </Section>

            {/* --- Jobs --- */}
            <Section title={`Jobs they worked${d.jobs.length ? ` (${fmt(d.jobs.length)})` : ''}`}>
              {d.jobs.length
                ? (
                  <div className="fh-list">
                    {jobs.map((j) => (
                      <div key={j.id} className="fh-row">
                        <div className="fh-row-main">
                          <Link to={`/requirements/${j.id}`} className="fh-strong">{j.title || 'Job'}</Link>
                          <span className="small-muted">{[j.reqCode, j.client, j.department].filter(Boolean).join(' · ')}</span>
                        </div>
                        <div className="small-muted">
                          {[`${fmt(j.candidates)} added`, j.sent && `${fmt(j.sent)} sent`, j.joined && `${fmt(j.joined)} joined`].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                    ))}
                    {d.jobs.length > JOBS_PREVIEW && (
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAllJobs(!allJobs)}>
                        {allJobs ? `Show the first ${JOBS_PREVIEW}` : `Show all ${fmt(d.jobs.length)} jobs`}
                      </button>
                    )}
                  </div>
                )
                : <EmptyState compact icon="💼" title="No jobs recorded under their name." />}
            </Section>

            {/* --- Who took over --- */}
            <Section title="Who took over">
              {d.takeover.length > 0 && (
                <div className="fh-list">
                  {d.takeover.map((x) => (
                    <div key={`${x.seat}-${x.name}`} className="fh-row">
                      <div className="fh-row-main">
                        <b>{x.name}</b>
                        <span className="small-muted">{`took seat ${x.seat}${x.left ? ' · has also left' : ''}`}</span>
                      </div>
                      <div className="small-muted">{`from ${day(x.from) || 'date not recorded'}`}</div>
                    </div>
                  ))}
                </div>
              )}
              {d.openWork.count > 0
                ? (
                  <div className="fh-pad">
                    <div>{`${fmt(d.openWork.count)} of their candidates are still in process.`}</div>
                    {d.openWork.nowWith.length > 0 && (
                      <div className="small-muted">
                        {`Their jobs are now with ${d.openWork.nowWith.slice(0, 3).map((w) => `${w.name} (${fmt(w.count)})`).join(', ')}.`}
                      </div>
                    )}
                  </div>
                )
                : <div className="small-muted fh-pad">Nothing of theirs is still in process.</div>}
              {!d.takeover.length && d.openWork.count > 0 && !d.openWork.nowWith.length && (
                <div className="small-muted fh-pad">Nobody is recorded as taking over their seat.</div>
              )}
            </Section>
          </div>
        )}
      </aside>
    </div>
  );
}
