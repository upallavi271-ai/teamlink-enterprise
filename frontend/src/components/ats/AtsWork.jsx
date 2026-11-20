import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Modal from '../Modal.jsx';

// RECRUITER WORK: targets, score, ranking, end of day, allocation, automation settings, cases (founder ATS audit round 3).
// Every screen here reads /api/ats/work/* (backend/src/routes/atsWork.js); who may see what is decided there, not here.
const say = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const dmy = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '—');
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const inr = (n) => (n === null || n === undefined ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`);
const PERIODS = [['DAILY', 'Day'], ['WEEKLY', 'Week'], ['MONTHLY', 'Month']];
const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

function Bar({ pct }) {
  const p = pct === null || pct === undefined ? 0 : Math.min(100, pct);
  return <div style={{ height: 5, background: 'var(--line, #e5e7eb)', borderRadius: 3, marginTop: 3 }}><div style={{ width: `${p}%`, height: 5, borderRadius: 3, background: p >= 100 ? '#16a34a' : (p >= 50 ? '#d97706' : '#dc2626') }} /></div>;
}
const Notice = ({ children, tone }) => (children ? <div className={`notice${tone ? ` ${tone}` : ''}`} style={{ margin: '8px 0' }}>{children}</div> : null);

// =========================================================== targets, score, ranking (Reports -> Results vs target)
export function WorkTargetsPanel() {
  const [period, setPeriod] = useState('MONTHLY');
  const [date, setDate] = useState(today());
  const [tab, setTab] = useState('results');
  const [data, setData] = useState(null);
  const [extra, setExtra] = useState(null);
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState(null);
  const q = `period=${period}&date=${date}`;
  useEffect(() => {
    setErr(''); setExtra(null);
    const path = { results: 'results', board: 'leaderboard', under: 'underperformers', eod: 'eod/compliance', offer: 'offer-ratio', cost: 'cost-revenue' }[tab];
    api.get(`/ats/work/${path}?${tab === 'cost' ? `month=${date.slice(0, 7)}` : q}`)
      .then((r) => { if (tab === 'results') setData(r.data); else setExtra(r.data); })
      .catch((e) => { setErr(say(e, 'Could not load this.')); if (tab === 'results') setData(null); });
  }, [tab, period, date]); // eslint-disable-line react-hooks/exhaustive-deps
  const reload = () => { setDate((d) => d); api.get(`/ats/work/results?${q}`).then((r) => setData(r.data)).catch(() => {}); };
  const TABS = [['results', 'Targets and score'], ['board', 'Leaderboard'], ['under', 'Underperformers'], ['eod', 'End-of-day reports'], ['offer', 'Offer to joining'], ['cost', 'Cost vs revenue']];
  return (
    <div className="card section" style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>Targets and performance</h3>
        <span style={{ flex: 1 }} />
        {PERIODS.map(([k, l]) => <button key={k} type="button" className={`btn btn-sm${period === k ? ' btn-primary' : ''}`} onClick={() => setPeriod(k)}>{l}</button>)}
        <input type="date" value={date} onChange={(e) => setDate(e.target.value || today())} />
      </div>
      <div className="small-muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>
        The numbers are the Daily report&apos;s own. The score is worked out from the targets: joinings 40, submissions 20, interviews 15, calls and sourcing 15, end-of-day reports 10 (an Admin can change these).
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {TABS.map(([k, l]) => <button key={k} type="button" className={`btn btn-sm${tab === k ? ' btn-primary' : ''}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      <Notice tone="red">{err}</Notice>
      {tab === 'results' && data && (
        <div className="tbl-wrap">
          <div className="small-muted" style={{ marginBottom: 4 }}>{data.label} · {dmy(data.from)} to {dmy(data.to)}</div>
          <table>
            <thead><tr><th>Person</th><th>Score</th>{data.metrics.map((m) => <th key={m.key}>{m.label}</th>)}<th>End of day</th><th>Reviewer&apos;s score</th>{data.canSet && <th />}</tr></thead>
            <tbody>
              {data.rows.length === 0 && <tr><td colSpan={data.metrics.length + 5} className="cell-muted">Nobody has work or a target in this period yet.</td></tr>}
              {data.rows.map((r) => (
                <tr key={r.userId}>
                  <td>{r.name}</td>
                  <td title={r.scoreParts.map((p) => `${p.label} (${p.weight}): ${p.pct === null ? 'no target' : `${p.pct}%`}`).join('\n')}>{r.score === null ? <span className="cell-muted">no targets</span> : <b>{r.score}</b>}</td>
                  {data.metrics.map((m) => { const c = r.metrics[m.key]; return (
                    <td key={m.key} title={c.source || 'No target set'}>
                      {c.done}{c.target !== null ? <span className="cell-muted"> / {c.target}</span> : null}
                      {c.target ? <Bar pct={c.pct} /> : null}
                    </td>
                  ); })}
                  <td>{r.eod.pct === null ? '—' : `${r.eod.pct}%`}</td>
                  <td>{r.reviewerScore ? `${r.reviewerScore.score} (${r.reviewerScore.period})` : '—'}</td>
                  {data.canSet && <td><button type="button" className="btn btn-sm" onClick={() => setEdit(r)}>Set targets</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
          {data.note && <div className="small-muted" style={{ marginTop: 6 }}>{data.note}</div>}
        </div>
      )}
      {tab === 'board' && extra && (extra.hidden ? <Notice>{extra.message}</Notice> : (
        <div className="tbl-wrap">
          {extra.you && <div style={{ marginBottom: 6 }}>Your rank: <b>{extra.you.rank}</b> of {extra.you.of} · score {extra.you.score === null ? 'not worked out yet' : extra.you.score}</div>}
          <div className="small-muted" style={{ marginBottom: 4 }}>{extra.scope} · {extra.label}</div>
          <table>
            <thead><tr><th>#</th><th>Person</th><th>Score</th><th>Joinings</th>{extra.rows[0] && 'submissions' in extra.rows[0] && <><th>Submissions</th><th>Interviews</th></>}</tr></thead>
            <tbody>{extra.rows.map((r) => <tr key={`${r.rank}-${r.name}`} style={r.you ? { fontWeight: 600 } : undefined}><td>{r.rank}</td><td>{r.name}{r.you ? ' (you)' : ''}</td><td>{r.score === null ? '—' : r.score}</td><td>{r.joinings}</td>{'submissions' in r && <><td>{r.submissions}</td><td>{r.interviews}</td></>}</tr>)}
              {extra.rows.length === 0 && <tr><td colSpan={5} className="cell-muted">No ranking yet.</td></tr>}</tbody>
          </table>
        </div>
      ))}
      {tab === 'under' && extra && (
        !extra.enabled ? <Notice>The underperformer flag is switched off (Administration → Step timing).</Notice> : (
          <div className="tbl-wrap">
            <div className="small-muted" style={{ marginBottom: 4 }}>Flagged when the weekly score is below {extra.settings.threshold} for {extra.settings.weeks} weeks in a row.</div>
            <table>
              <thead><tr><th>Person</th><th>Average</th>{(extra.weeksChecked || []).map((w) => <th key={w.from}>Week of {dmy(w.from)}</th>)}</tr></thead>
              <tbody>
                {extra.rows.length === 0 && <tr><td colSpan={2 + (extra.weeksChecked || []).length} className="cell-muted">Nobody is below the threshold for {extra.settings.weeks} weeks in a row.</td></tr>}
                {extra.rows.map((r) => <tr key={r.userId}><td>{r.name}</td><td><b>{r.average}</b></td>{r.weeks.map((w) => <td key={w.from}>{w.score}</td>)}</tr>)}
              </tbody>
            </table>
          </div>
        )
      )}
      {tab === 'eod' && extra && (
        <div className="tbl-wrap">
          <div style={{ marginBottom: 6 }}>{(extra.teams || []).map((t) => <span key={t.team} style={{ marginRight: 14 }}><b>{t.team}</b>: {t.pct === null ? '—' : `${t.pct}%`}</span>)}</div>
          <table>
            <thead><tr><th>Person</th><th>Team</th><th>Confirmed</th><th>Working days</th><th>Compliance</th></tr></thead>
            <tbody>{(extra.people || []).map((p) => <tr key={p.userId}><td>{p.name}</td><td className="cell-muted">{p.team}</td><td>{p.done}</td><td>{p.due}</td><td>{p.pct === null ? '—' : `${p.pct}%`}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {tab === 'offer' && extra && (
        <div className="tbl-wrap">
          <div style={{ marginBottom: 6 }}>Offers <b>{extra.offers}</b> · Joined <b>{extra.joined}</b> · Offer-to-joining <b>{extra.ratio === null ? '—' : `${extra.ratio}%`}</b></div>
          <table>
            <thead><tr><th>Person</th><th>Offers</th><th>Joined</th><th>Ratio</th></tr></thead>
            <tbody>{(extra.rows || []).map((r) => <tr key={r.name}><td>{r.name}</td><td>{r.offers}</td><td>{r.joined}</td><td>{r.ratio === null ? '—' : `${r.ratio}%`}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {tab === 'cost' && extra && (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Person</th><th>Joinings</th><th>Revenue</th><th>Cost (one month)</th><th>Net</th><th>Revenue per ₹1 of cost</th></tr></thead>
            <tbody>
              {extra.rows.length === 0 && <tr><td colSpan={6} className="cell-muted">No credited joinings this month.</td></tr>}
              {extra.rows.map((r) => <tr key={r.userId}><td>{r.name}</td><td>{r.joinings}</td><td>{inr(r.revenue)}</td><td>{r.cost === null ? <span className="cell-muted">cost not set</span> : inr(r.cost)}</td><td>{inr(r.net)}</td><td>{r.ratio === null ? '—' : r.ratio}</td></tr>)}
            </tbody>
          </table>
          <div className="small-muted" style={{ marginTop: 6 }}>{extra.note}</div>
        </div>
      )}
      {edit && <SetTargets person={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </div>
  );
}

function SetTargets({ person, onClose, onSaved }) {
  const [cur, setCur] = useState(null);
  const [vals, setVals] = useState({ DAILY: {}, WEEKLY: {}, MONTHLY: {} });
  const [msg, setMsg] = useState('');
  useEffect(() => { api.get(`/ats/work/targets/${person.userId}`).then((r) => { setCur(r.data); setVals({ DAILY: { ...r.data.explicit.DAILY }, WEEKLY: { ...r.data.explicit.WEEKLY }, MONTHLY: { ...r.data.explicit.MONTHLY } }); }).catch((e) => setMsg(say(e, 'Could not load.'))); }, [person.userId]);
  const save = async () => {
    setMsg('');
    try {
      for (const p of PERIODS) {
        const values = {}; cur.metrics.forEach((m) => { const v = vals[p[0]][m.key]; values[m.key] = v === undefined || v === '' ? '' : Number(v); });
        // eslint-disable-next-line no-await-in-loop
        await api.put(`/ats/work/targets/${person.userId}`, { period: p[0], values });
      }
      onSaved();
    } catch (e) { setMsg(say(e, 'Could not save.')); }
  };
  return (
    <Modal title={`Targets for ${person.name}`} size="wide" onClose={onClose} foot={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={save} disabled={!cur}>Save</button></>}>
      <p className="small-muted" style={{ marginTop: 0 }}>Leave a box empty for no target. A daily target wins over a weekly one, and a weekly over a monthly one; the monthly HRMS target is used when nothing is set here.</p>
      <Notice tone="red">{msg}</Notice>
      {cur && (
        <table>
          <thead><tr><th>Target</th>{PERIODS.map(([k, l]) => <th key={k}>Per {l.toLowerCase()}</th>)}<th>HRMS monthly</th></tr></thead>
          <tbody>
            {cur.metrics.map((m) => (
              <tr key={m.key}>
                <td>{m.label}</td>
                {PERIODS.map(([k]) => <td key={k}><input type="number" min="0" style={{ width: 80 }} value={vals[k][m.key] ?? ''} onChange={(e) => setVals((v) => ({ ...v, [k]: { ...v[k], [m.key]: e.target.value } }))} /></td>)}
                <td className="cell-muted">{cur.hrms[m.key] ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

// =========================================================== a compact "against target" strip (dashboard and Daily report)
// A recruiter sees their own day / week / month; a lead sees the area's totals (only people who have a target count).
export function TargetsStrip() {
  const [d, setD] = useState(null);
  useEffect(() => {
    const day = today();
    Promise.all(PERIODS.map(([k]) => api.get(`/ats/work/results?period=${k}&date=${day}`).then((r) => r.data).catch(() => null))).then((all) => setD(all));
  }, []);
  if (!d || d.every((x) => !x)) return null;
  const sum = (res, key) => {
    let done = 0; let target = 0;
    (res.rows || []).forEach((r) => { const c = r.metrics[key]; if (c.target) { done += c.done; target += c.target; } });
    return { done, target };
  };
  const first = d.find((x) => x);
  const anyTarget = d.some((res) => res && first.metrics.some((m) => sum(res, m.key).target > 0));
  if (!anyTarget) return null;
  return (
    <div className="card section" style={{ marginBottom: 12 }}>
      <h3 style={{ margin: 0 }}>{first.selfOnly ? 'My targets' : 'Team against target'}</h3>
      <div className="tbl-wrap" style={{ marginTop: 6 }}>
        <table>
          <thead><tr><th /> {first.metrics.map((m) => <th key={m.key}>{m.label}</th>)}</tr></thead>
          <tbody>
            {PERIODS.map(([k, l], i) => (d[i] ? (
              <tr key={k}><td><b>{l === 'Day' ? 'Today' : `This ${l.toLowerCase()}`}</b></td>
                {first.metrics.map((m) => { const x = sum(d[i], m.key); return <td key={m.key}>{x.target ? <>{x.done}<span className="cell-muted"> / {x.target}</span><Bar pct={Math.round((x.done * 100) / x.target)} /></> : <span className="cell-muted">—</span>}</td>; })}
              </tr>) : null))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// =========================================================== the dashboard: carried over, end of day, AI shortlist approval
export function HomeWorkCards() {
  const [co, setCo] = useState(null);
  const [eod, setEod] = useState(null);
  const [rank, setRank] = useState(null);
  const [msg, setMsg] = useState('');
  const [openCo, setOpenCo] = useState(false);
  const load = useCallback(() => {
    api.get('/ats/work/carry-over').then((r) => setCo(r.data)).catch(() => setCo(null));
    api.get('/ats/work/eod/me').then((r) => setEod(r.data)).catch(() => setEod(null));
    api.get('/ats/work/leaderboard').then((r) => setRank(r.data && r.data.you ? r.data : null)).catch(() => setRank(null));
  }, []);
  useEffect(() => { load(); }, [load]);
  const confirm = async () => { setMsg(''); try { const r = await api.post('/ats/work/eod/confirm', {}); setMsg(r.data.already ? 'Already sent.' : 'Sent. Your team lead can see the time.'); load(); } catch (e) { setMsg(say(e, 'Could not send.')); } };
  if (!co && !eod) return null;
  const hasEod = eod && eod.totals;
  return (
    <>
      <TargetsStrip />
      {co && co.count > 0 && (
        <div className="card section" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0 }}>Carried over from yesterday <span className="badge" style={{ marginLeft: 6 }}>{co.count}</span></h3>
            <span style={{ flex: 1 }} />
            <button type="button" className="btn btn-sm" onClick={() => setOpenCo((o) => !o)}>{openCo ? 'Hide' : 'Show'}</button>
          </div>
          <div className="small-muted" style={{ fontSize: 12 }}>{co.followUps.length} follow-up{co.followUps.length === 1 ? '' : 's'} not done and {co.toReview.length} profile{co.toReview.length === 1 ? '' : 's'} still to review since {dmy(co.since)}.</div>
          {openCo && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              {co.followUps.map((f) => <li key={f.id}><Link to={`/candidates/${f.candidateId || ''}`}>{f.what}</Link> — {f.candidate} · {f.job} <span className="cell-muted">(due {dmy(f.due)})</span></li>)}
              {co.toReview.map((a) => <li key={a.applicationId}>Review: {a.candidate} · {a.job}</li>)}
            </ul>
          )}
        </div>
      )}
      {hasEod && (
        <div className="card section" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0 }}>My end-of-day report</h3>
            <span className="small-muted">{dmy(eod.day)}</span>
            <span style={{ flex: 1 }} />
            {eod.confirmedAt ? <span className="badge green">Sent {when(eod.confirmedAt)}</span> : <button type="button" className="btn btn-sm btn-primary" onClick={confirm}>Confirm and send</button>}
          </div>
          <div className="small-muted" style={{ fontSize: 12, margin: '4px 0' }}>
            {['calls', 'added', 'verified', 'sentClient', 'interviews', 'offers', 'joined'].filter((k) => eod.labels[k]).map((k) => `${eod.labels[k]}: ${eod.totals[k] || 0}`).join(' · ')}
          </div>
          {rank && rank.you && <div style={{ fontSize: 12.5 }}>Your rank this month: <b>{rank.you.rank}</b> of {rank.you.of}{rank.you.score !== null && rank.you.score !== undefined ? ` · score ${rank.you.score}` : ''}</div>}
          {msg && <div className="small-muted">{msg}</div>}
        </div>
      )}
      <ShortlistApproval />
    </>
  );
}

export function ShortlistApproval() {
  const [d, setD] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [msg, setMsg] = useState('');
  const load = () => api.get('/ats/work/shortlist').then((r) => setD(r.data)).catch(() => setD(null));
  useEffect(() => { load(); }, []);
  if (!d || !d.enabled || !d.rows.length) return null;
  const toggle = (id) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const decide = async (decision) => {
    setMsg('');
    try { const r = await api.post('/ats/work/shortlist/decide', { applicationIds: [...picked], decision }); setMsg(`${r.data.done} ${decision === 'approve' ? 'approved' : 'rejected'}.${r.data.results.filter((x) => !x.ok).map((x) => ` ${x.error}`).join('')}`); setPicked(new Set()); load(); } catch (e) { setMsg(say(e, 'Could not do that.')); }
  };
  return (
    <div className="card section" style={{ marginBottom: 12 }}>
      <h3 style={{ margin: 0 }}>Recruiter approval <span className="badge" style={{ marginLeft: 6 }}>{d.rows.length}</span></h3>
      <div className="small-muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>These candidates passed the AI rule (65%). Approve to send them to the ATS as Shortlisted, or reject.</div>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th /><th>Candidate</th><th>Job</th><th>Why</th></tr></thead>
          <tbody>{d.rows.map((r) => <tr key={r.applicationId}><td><input type="checkbox" checked={picked.has(r.applicationId)} onChange={() => toggle(r.applicationId)} /></td><td>{r.candidate}</td><td>{r.job}</td><td className="cell-muted">{r.reasons}</td></tr>)}</tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" className="btn btn-sm btn-primary" disabled={!picked.size} onClick={() => decide('approve')}>Approve {picked.size || ''}</button>
        <button type="button" className="btn btn-sm" disabled={!picked.size} onClick={() => decide('reject')}>Reject {picked.size || ''}</button>
        <button type="button" className="btn btn-sm" onClick={() => setPicked(new Set(d.rows.map((r) => r.applicationId)))}>Select all</button>
      </div>
      {msg && <div className="small-muted" style={{ marginTop: 4 }}>{msg}</div>}
    </div>
  );
}

// =========================================================== a requirement: suggestions, assign, match, close pipeline, trail
export function RequirementWorkPanel({ requirement, canAssign, onChanged }) {
  const [sg, setSg] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [msg, setMsg] = useState('');
  const [closeList, setCloseList] = useState(null);
  const [trail, setTrail] = useState(false);
  const id = requirement.id;
  const load = useCallback(() => {
    api.get(`/ats/work/requirements/${id}/suggest`).then((r) => setSg(r.data)).catch(() => setSg(null));
    if (requirement.status === 'CLOSED') api.get(`/ats/work/requirements/${id}/close-list`).then((r) => setCloseList(r.data)).catch(() => setCloseList(null));
  }, [id, requirement.status]);
  useEffect(() => { load(); }, [load]);
  const assign = async () => {
    setMsg('');
    try { const r = await api.post(`/ats/work/requirements/${id}/assign-suggested`, { userIds: [...picked] }); setMsg(`Given to ${r.data.assigned.join(', ')}. Good-fit candidates: ${r.data.match && r.data.match.goodFit !== undefined ? r.data.match.goodFit : '—'}.`); setPicked(new Set()); load(); if (onChanged) onChanged(); } catch (e) { setMsg(say(e, 'Could not assign.')); }
  };
  const closeAll = async () => {
    if (!window.confirm(`Close ${closeList.count} open candidate${closeList.count === 1 ? '' : 's'} with this requirement? They are moved to Rejected (Requirement closed) and told through the usual messages.`)) return;
    setMsg('');
    try { const r = await api.post(`/ats/work/requirements/${id}/close-and-notify`); setMsg(`${r.data.moved} closed${r.data.skipped.length ? `, ${r.data.skipped.length} could not be moved` : ''}.`); load(); } catch (e) { setMsg(say(e, 'Could not close them.')); }
  };
  const show = sg || (closeList && closeList.count > 0);
  return (
    <div className="card section" style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>Recruiters and workflow</h3>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-sm" onClick={() => setTrail(true)}>Workflow trail</button>
      </div>
      {sg && sg.waitsForRecruiter && <Notice tone="amber">{sg.waitsForRecruiter}</Notice>}
      {sg && (
        <>
          <div className="small-muted" style={{ fontSize: 12, margin: '6px 0' }}>Suggested recruiters, best fit first (skills and industry from their joinings, then how busy they are). {sg.autoAssign.enabled ? `The best ${sg.autoAssign.count} are given a new requirement automatically.` : 'Nothing is assigned until you press Assign.'}</div>
          <div className="tbl-wrap">
            <table>
              <thead><tr>{canAssign && <th />}<th>Recruiter</th><th>Why</th></tr></thead>
              <tbody>{sg.suggestions.map((s) => (
                <tr key={s.userId} style={s.away ? { opacity: 0.6 } : undefined}>
                  {canAssign && <td><input type="checkbox" disabled={!!s.away} checked={picked.has(s.userId)} onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(s.userId)) n.delete(s.userId); else n.add(s.userId); return n; })} /></td>}
                  <td>{s.name}</td><td className="cell-muted">{s.reason}</td>
                </tr>))}</tbody>
            </table>
          </div>
          {canAssign && <div style={{ marginTop: 8 }}><button type="button" className="btn btn-sm btn-primary" disabled={!picked.size} onClick={assign}>Assign {picked.size || ''}</button></div>}
          {sg.match && <div className="small-muted" style={{ marginTop: 6 }}>Matching ran {when(sg.match.ranAt)}: {sg.match.goodFit} good fit of {sg.match.total} candidates.</div>}
        </>
      )}
      {closeList && closeList.count > 0 && (
        <div style={{ marginTop: 10 }}>
          <b>{closeList.count} candidate{closeList.count === 1 ? ' is' : 's are'} still in the pipeline of this closed requirement.</b>
          <ul style={{ margin: '4px 0', paddingLeft: 18 }}>{closeList.rows.slice(0, 12).map((r) => <li key={r.applicationId}>{r.candidate} <span className="cell-muted">({r.step})</span></li>)}</ul>
          {closeList.enabled ? <button type="button" className="btn btn-sm btn-primary" onClick={closeAll}>Close and notify them</button> : <div className="small-muted">An Admin can turn on “Close and notify” in Administration → Step timing.</div>}
        </div>
      )}
      {msg && <Notice>{msg}</Notice>}
      {!show && <div className="small-muted">Nothing to suggest right now.</div>}
      {trail && <TrailModal path={`requirement/${id}`} onClose={() => setTrail(false)} />}
    </div>
  );
}

export function TrailModal({ path, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.get(`/ats/work/trail/${path}`).then((r) => setD(r.data)).catch((e) => setErr(say(e, 'Could not load the trail.'))); }, [path]);
  return (
    <Modal title={`Workflow trail${d ? ` — ${d.title}` : ''}`} size="wide" onClose={onClose} foot={<button className="btn" onClick={onClose}>Close</button>}>
      <Notice tone="red">{err}</Notice>
      {d && (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>When</th><th>What</th><th>Who</th><th>Kind</th></tr></thead>
            <tbody>{d.events.map((e, i) => <tr key={`${e.at}-${i}`}><td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>{when(e.at)}</td><td>{e.what}</td><td>{e.who || '—'}</td><td className="cell-muted">{e.kind}</td></tr>)}</tbody>
          </table>
          <div className="small-muted" style={{ marginTop: 6 }}>{d.count} events, from the requirement request to the invoice, in time order.</div>
        </div>
      )}
    </Modal>
  );
}
export function TrailButton({ applicationId, requirementId, label = 'Workflow trail' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>{label}</button>
      {open && <TrailModal path={applicationId ? `application/${applicationId}` : `requirement/${requirementId}`} onClose={() => setOpen(false)} />}
    </>
  );
}

// =========================================================== Administration -> Step timing: switches, escalation, failed steps
const SW = [
  ['autoAssign', 'Suggest and auto-assign recruiters when a requirement opens', 'The best recruiters (skills, industry, workload; never anyone on leave or off shift) are given the job and told, and matching runs once. The TL always sees the suggestions and can assign by hand.', 'count', 'How many'],
  ['requireRecruiter', 'Require a recruiter before posting', 'A new requirement is posted only once a recruiter is on it. Older requirements are never held back.'],
  ['leaderboard', 'Recruiters see the leaderboard', 'A recruiter sees their own rank and the ranking of their own team. Team leads, managers and admins always see everyone in their area.', null, null, 'recruitersSee'],
  ['aiShortlistApproval', 'Recruiter approves the AI shortlist', 'Candidates who pass the 65% rule wait in a Recruiter approval list instead of going straight to Shortlisted.'],
  ['onHoldPause', 'Pause tasks when a requirement is put on hold', 'The recruiters are told, and the requirement\'s tasks leave their carried-over list until it opens again.'],
  ['closeNotify', 'Offer “Close and notify” when a requirement is closed', 'Shows the open candidates and one button that closes them, with the usual candidate message.'],
  ['payoutProposal', 'Draft payout proposals when a joining is confirmed', 'A recruiter incentive and referral proposal wait for Accounts to approve. No money is posted.'],
  ['eventDedupe', 'Ignore the same event twice', 'A double click or a repeated request does not repeat a stage move or a joining.'],
  ['autoRetry', 'Retry failed AI and API steps every hour', 'Up to 3 tries, each wait longer. A Retry button is always there.'],
  ['joiningProof', 'Require joining proof before billing', 'The placement invoice waits until a proof file is uploaded for the joining.', null, null, 'required'],
];
export function AtsWorkSettings() {
  const [s, setS] = useState(null);
  const [can, setCan] = useState(false);
  const [esc, setEsc] = useState(null);
  const [msg, setMsg] = useState('');
  const load = useCallback(() => {
    api.get('/ats/work/settings').then((r) => { setS(r.data.settings); setCan(!!r.data.canEdit); }).catch(() => setS(null));
    api.get('/ats/work/escalation').then((r) => setEsc(r.data)).catch(() => setEsc(null));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (!s) return null;
  const put = async (patch) => { setMsg(''); try { const r = await api.put('/ats/work/settings', patch); setS(r.data.settings); setMsg('Saved.'); } catch (e) { setMsg(say(e, 'Could not save.')); } };
  const flag = (k, key = 'enabled') => !!(s[k] && s[k][key]);
  const num = (sec, key, lo, hi) => <input type="number" min={lo} max={hi} style={{ width: 64 }} disabled={!can} defaultValue={s[sec][key]} onBlur={(e) => { if (Number(e.target.value) !== s[sec][key]) put({ [sec]: { [key]: Number(e.target.value) } }); }} />;
  return (
    <>
      <div className="panel">
        <div className="panel-head"><h3>Work allocation and automation</h3></div>
        <div style={{ padding: '8px 18px 14px' }}>
          {!can && <div className="notice">Only a Super Admin or Admin changes these.</div>}
          {msg && <div className="notice green">{msg}</div>}
          {SW.map(([k, title, hint, numKey, numLabel, flagKey]) => (
            <div key={k} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 0', borderBottom: '1px solid var(--line, #eee)' }}>
              <input type="checkbox" style={{ marginTop: 4 }} disabled={!can} checked={flag(k, flagKey || 'enabled')} onChange={(e) => put({ [k]: { [flagKey || 'enabled']: e.target.checked } })} />
              <div style={{ flex: 1 }}>
                <b>{title}</b>{numKey && <span> · {numLabel} {num(k, numKey, 1, 5)}</span>}
                <div className="small-muted" style={{ fontSize: 12 }}>{hint}</div>
              </div>
            </div>
          ))}
          <h4 style={{ margin: '14px 0 4px' }}>Performance score</h4>
          <div className="small-muted" style={{ fontSize: 12, marginBottom: 6 }}>Weights of the automatic score (they are used as shares of what has a target).</div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            {[['joinings', 'Joinings'], ['submissions', 'Submissions'], ['interviews', 'Interviews'], ['activity', 'Calls and sourcing'], ['eod', 'End-of-day reports']].map(([k, l]) => <label key={k}>{l} {num('weights', k, 0, 100)}</label>)}
          </div>
          <div style={{ marginTop: 10, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <label><input type="checkbox" disabled={!can} checked={flag('underperformer')} onChange={(e) => put({ underperformer: { enabled: e.target.checked } })} /> Flag underperformers: score below {num('underperformer', 'threshold', 1, 100)} for {num('underperformer', 'weeks', 1, 12)} weeks in a row</label>
            <label>A recruiter&apos;s ownership of a candidate lasts {num('ownership', 'validityDays', 7, 730)} days without activity</label>
          </div>
          <h4 style={{ margin: '14px 0 4px' }}>Due dates and escalation</h4>
          <label><input type="checkbox" disabled={!can} checked={flag('sla', 'workingDaysOnly')} onChange={(e) => put({ sla: { workingDaysOnly: e.target.checked } })} /> SLA counts working days only (uses the HRMS holiday calendar; Sunday is off)</label>
          <div style={{ marginTop: 4 }}><label><input type="checkbox" disabled={!can} checked={flag('sla', 'businessHoursOnly')} onChange={(e) => put({ sla: { businessHoursOnly: e.target.checked } })} /> Hour-based timers count business hours only ({num('sla', 'startHour', 0, 23)}:00 to {num('sla', 'endHour', 1, 24)}:00)</label></div>
        </div>
      </div>
      {esc && (
        <div className="panel">
          <div className="panel-head"><h3>Tell the team lead when a recruiter does not finish tasks</h3></div>
          <div style={{ padding: '8px 18px 14px' }}>
            <div>Now: <b style={{ color: esc.enabled ? '#16a34a' : '#dc2626' }}>{esc.enabled ? 'ON' : 'OFF'}</b> · owner first, the team lead after {esc.tlAfterDays} day{esc.tlAfterDays === 1 ? '' : 's'} late, the manager after {esc.managerAfterDays}. {esc.lastRunAt ? `Last ran ${when(esc.lastRunAt)}.` : 'It has not run yet.'}</div>
            <div className="small-muted" style={{ fontSize: 12 }}>{esc.note}</div>
            {esc.canEdit && <div style={{ marginTop: 6 }}><button type="button" className="btn btn-sm btn-primary" onClick={async () => { try { await api.post('/ats/work/escalation/turn-on', { enabled: !esc.enabled }); load(); } catch (e) { setMsg(say(e, 'Could not change it.')); } }}>{esc.enabled ? 'Turn off' : 'Turn on'}</button></div>}
          </div>
        </div>
      )}
      <FailedSteps canMark={can} />
    </>
  );
}

export function FailedSteps({ canMark }) {
  const [rows, setRows] = useState(null);
  const [msg, setMsg] = useState('');
  const load = () => api.get('/ats/work/failures').then((r) => setRows(r.data.rows)).catch(() => setRows(null));
  useEffect(() => { load(); }, []);
  if (!rows) return null;
  const shown = rows.filter((r) => r.status !== 'Done');
  const retry = async (id) => { setMsg(''); try { const r = await api.post(`/ats/work/failures/${id}/retry`); setMsg(r.data.ok ? 'It worked this time.' : `Still failing: ${r.data.error}`); load(); } catch (e) { setMsg(say(e, 'Could not retry.')); } };
  const done = async (id) => { try { await api.post(`/ats/work/failures/${id}/done`); load(); } catch (e) { setMsg(say(e, 'Could not mark it.')); } };
  return (
    <div className="panel">
      <div className="panel-head"><h3>Failed steps <span className="badge" style={{ marginLeft: 6 }}>{shown.length}</span></h3></div>
      <div style={{ padding: '8px 18px 14px' }}>
        {msg && <div className="notice">{msg}</div>}
        {shown.length === 0 ? <div className="small-muted">Nothing has failed.</div> : (
          <div className="tbl-wrap"><table>
            <thead><tr><th>Step</th><th>What went wrong</th><th>Tries</th><th>Status</th><th /></tr></thead>
            <tbody>{shown.map((r) => <tr key={r.id}><td>{r.label}</td><td className="cell-muted">{r.error || '—'}</td><td>{r.tries}</td><td>{r.status}</td><td style={{ whiteSpace: 'nowrap' }}><button type="button" className="btn btn-sm" onClick={() => retry(r.id)}>Retry</button>{canMark && <button type="button" className="btn btn-sm" style={{ marginLeft: 6 }} onClick={() => done(r.id)}>Mark done</button>}</td></tr>)}</tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}

// =========================================================== Accounts: pending payout approvals
export function PayoutApprovals() {
  const [rows, setRows] = useState(null);
  const [amt, setAmt] = useState({});
  const [msg, setMsg] = useState('');
  const load = () => api.get('/ats/work/payouts').then((r) => setRows(r.data.rows)).catch(() => setRows(null));
  useEffect(() => { load(); }, []);
  if (!rows || !rows.length) return null;
  const decide = async (id, decision) => { setMsg(''); try { await api.post(`/ats/work/payouts/${id}/decide`, { decision, amount: amt[id] }); load(); } catch (e) { setMsg(say(e, 'Could not record it.')); } };
  return (
    <div className="card section" style={{ marginTop: 14 }}>
      <h3 style={{ margin: 0 }}>Pending payout approvals <span className="badge" style={{ marginLeft: 6 }}>{rows.length}</span></h3>
      <div className="small-muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>Drafted when a joining was confirmed. Approving records the decision only — pay it through payroll or Accounts.</div>
      {msg && <Notice tone="red">{msg}</Notice>}
      <div className="tbl-wrap"><table>
        <thead><tr><th>For</th><th>Kind</th><th>Candidate · job</th><th>Amount</th><th /></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td>{r.personName || '—'}</td><td>{r.kind}</td><td>{r.candidateName} · {r.jobTitle}<div className="cell-muted">{r.clientName}</div></td><td><input type="number" min="0" style={{ width: 90 }} placeholder="₹" value={amt[r.id] ?? (r.amount ?? '')} onChange={(e) => setAmt((a) => ({ ...a, [r.id]: e.target.value }))} /></td><td style={{ whiteSpace: 'nowrap' }}><button type="button" className="btn btn-sm btn-primary" onClick={() => decide(r.id, 'Approved')}>Approve</button><button type="button" className="btn btn-sm" style={{ marginLeft: 6 }} onClick={() => decide(r.id, 'Rejected')}>Reject</button></td></tr>)}</tbody>
      </table></div>
    </div>
  );
}

// =========================================================== reassign a leaver's work
export function ReassignWork() {
  const [people, setPeople] = useState(null);
  const [open, setOpen] = useState(null);
  useEffect(() => { api.get('/ats/work/reassign/people').then((r) => setPeople(r.data.people)).catch(() => setPeople(null)); }, []);
  if (!people || !people.length) return null;
  return (
    <>
      <div className="notice amber" style={{ marginBottom: 12, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ flex: '1 1 260px' }}><b>Work still with people who are no longer active:</b> {people.map((p) => `${p.name} (${p.total})`).join(', ')}.</span>
        {people.slice(0, 3).map((p) => <button key={p.userId} type="button" className="btn btn-sm btn-primary" onClick={() => setOpen(p)}>Reassign {p.name.split(' ')[0]}&apos;s work</button>)}
      </div>
      {open && <ReassignModal person={open} onClose={() => setOpen(null)} onDone={() => { setOpen(null); api.get('/ats/work/reassign/people').then((r) => setPeople(r.data.people)).catch(() => {}); }} />}
    </>
  );
}
function ReassignModal({ person, onClose, onDone }) {
  const [d, setD] = useState(null);
  const [who, setWho] = useState([]);
  const [to, setTo] = useState('');
  const [picked, setPicked] = useState(() => new Set());
  const [msg, setMsg] = useState('');
  useEffect(() => {
    api.get(`/ats/work/reassign/${person.userId}`).then((r) => { setD(r.data); setPicked(new Set(r.data.sections.filter((s) => s.count && !s.adminOnly).map((s) => s.key))); }).catch((e) => setMsg(say(e, 'Could not load.')));
    api.get('/ats/work/delegation-people').then((r) => setWho(r.data.people)).catch(() => {});
    api.get('/requirements/assignable-people', { params: { recruiters: 1 } }).then((r) => { const list = (r.data.groups || []).flatMap((g) => g.people); if (list.length) setWho((w) => [...new Map([...w, ...list].map((p) => [p.id, p])).values()]); }).catch(() => {});
  }, [person.userId]);
  const go = async () => {
    setMsg('');
    try { const r = await api.post(`/ats/work/reassign/${person.userId}`, { toUserId: to, what: [...picked] }); setMsg(`Done: ${Object.entries(r.data.done).map(([k, n]) => `${n} ${k}`).join(', ')} now with ${r.data.to}.`); setTimeout(onDone, 1400); } catch (e) { setMsg(say(e, 'Could not reassign.')); }
  };
  return (
    <Modal title={`Reassign ${person.name}'s work`} size="wide" onClose={onClose} foot={<><button className="btn" onClick={onClose}>Close</button><button className="btn btn-primary" disabled={!to || !picked.size} onClick={go}>Reassign selected</button></>}>
      <Notice>{msg}</Notice>
      {d && (
        <>
          <label>Give it to&nbsp;
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">Choose a person…</option>
              {who.map((p) => <option key={p.id} value={p.id}>{p.name}{p.atsRole ? ` (${p.atsRole})` : ''}</option>)}
            </select>
          </label>
          {d.sections.map((s) => (
            <div key={s.key} style={{ margin: '10px 0', opacity: s.count ? 1 : 0.5 }}>
              <label><input type="checkbox" disabled={!s.count || s.adminOnly} checked={picked.has(s.key)} onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(s.key)) n.delete(s.key); else n.add(s.key); return n; })} /> <b>{s.label}</b> ({s.count}){s.adminOnly ? ' — an Admin moves these' : ''}</label>
              {s.items.length > 0 && <div className="small-muted" style={{ marginLeft: 22 }}>{s.items.slice(0, 6).join(' · ')}{s.count > 6 ? ' …' : ''}</div>}
            </div>
          ))}
        </>
      )}
    </Modal>
  );
}

// =========================================================== candidate: who holds it, claim, dispute
export function OwnershipPanel({ candidateId }) {
  const [own, setOwn] = useState(null);
  const [dis, setDis] = useState(null);
  const [form, setForm] = useState(false);
  const [evidence, setEvidence] = useState('');
  const [msg, setMsg] = useState('');
  const [reason, setReason] = useState({});
  const load = useCallback(() => {
    api.get(`/ats/work/ownership/${candidateId}`).then((r) => setOwn(r.data)).catch(() => setOwn(null));
    api.get('/ats/work/disputes', { params: { candidateId } }).then((r) => setDis(r.data)).catch(() => setDis(null));
  }, [candidateId]);
  useEffect(() => { load(); }, [load]);
  if (!own || !own.holders.length) return null;
  const claim = async () => { setMsg(''); try { await api.post(`/ats/work/ownership/${candidateId}/claim`); setMsg('The candidate is yours now.'); load(); } catch (e) { setMsg(say(e, 'Could not claim.')); } };
  const open = async () => { setMsg(''); try { await api.post('/ats/work/disputes', { candidateId, evidence }); setForm(false); setEvidence(''); setMsg('Dispute sent to the team lead.'); load(); } catch (e) { setMsg(say(e, 'Could not open the dispute.')); } };
  const decide = async (d, winnerId) => { setMsg(''); try { await api.post(`/ats/work/disputes/${d.id}/decide`, { winnerId, reason: reason[d.id] }); load(); } catch (e) { setMsg(say(e, 'Could not decide.')); } };
  const expired = own.holders.some((h) => h.expired);
  return (
    <div className="card section" style={{ marginTop: 12 }}>
      <h3 style={{ margin: 0 }}>Who owns this candidate</h3>
      <div className="small-muted" style={{ fontSize: 12, margin: '4px 0' }}>{own.holders.map((h) => `${h.name} — ${h.expired ? 'expired, no activity' : `valid until ${dmy(h.validUntil)}`}`).join(' · ')} (ownership lasts {own.validityDays} days without activity).</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {expired && <button type="button" className="btn btn-sm btn-primary" onClick={claim}>Claim this candidate</button>}
        <button type="button" className="btn btn-sm" onClick={() => setForm((f) => !f)}>Dispute ownership</button>
      </div>
      {form && <div style={{ marginTop: 8 }}><textarea rows={3} style={{ width: '100%' }} placeholder="Evidence: when and how you sourced this person (date, message, source)" value={evidence} onChange={(e) => setEvidence(e.target.value)} /><button type="button" className="btn btn-sm btn-primary" onClick={open}>Send to the team lead</button></div>}
      {msg && <Notice>{msg}</Notice>}
      {dis && dis.rows.length > 0 && (
        <div className="tbl-wrap" style={{ marginTop: 8 }}><table>
          <thead><tr><th>Claimant</th><th>Holder</th><th>Evidence</th><th>Status</th></tr></thead>
          <tbody>{dis.rows.map((d) => (
            <tr key={d.id}><td>{d.claimantName}</td><td>{d.holderName || '—'}</td><td>{d.evidence}</td>
              <td>{d.status === 'Open' ? (dis.canDecide ? (
                <div><input placeholder="Reason for the decision" value={reason[d.id] || ''} onChange={(e) => setReason((r) => ({ ...r, [d.id]: e.target.value }))} />
                  <div style={{ marginTop: 4 }}><button type="button" className="btn btn-sm" onClick={() => decide(d, d.claimantId)}>Claimant wins</button> <button type="button" className="btn btn-sm" onClick={() => decide(d, d.holderId)}>Holder keeps it</button></div></div>
              ) : 'Open') : `${d.winnerName} — ${d.decision}`}</td></tr>))}</tbody>
        </table></div>
      )}
    </div>
  );
}

// =========================================================== approvals while I am away
export function DelegationCard() {
  const [rows, setRows] = useState(null);
  const [who, setWho] = useState([]);
  const [f, setF] = useState({ toUserId: '', fromDate: today(), toDate: today() });
  const [msg, setMsg] = useState('');
  const [show, setShow] = useState(false);
  const load = () => api.get('/ats/work/delegations').then((r) => setRows(r.data.rows)).catch(() => setRows(null));
  useEffect(() => { load(); api.get('/ats/work/delegation-people').then((r) => setWho(r.data.people)).catch(() => {}); }, []);
  if (!rows) return null;
  const mine = rows.filter((r) => r.mine); const forMe = rows.filter((r) => !r.mine);
  const save = async () => { setMsg(''); try { await api.post('/ats/work/delegations', f); setShow(false); load(); } catch (e) { setMsg(say(e, 'Could not save.')); } };
  return (
    <div className="card section" style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>Delegate my approvals while I am away</h3><span style={{ flex: 1 }} />
        <button type="button" className="btn btn-sm" onClick={() => setShow((s) => !s)}>{show ? 'Close' : 'Delegate'}</button>
      </div>
      <div className="small-muted" style={{ fontSize: 12, margin: '4px 0' }}>For the days you pick, the person you choose can approve what would wait for you (team lead, BDE team lead and manager approvals). It works beside the leave cover.</div>
      {show && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={f.toUserId} onChange={(e) => setF({ ...f, toUserId: e.target.value })}><option value="">Choose a person…</option>{who.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.atsRole})</option>)}</select>
          <label>From <input type="date" value={f.fromDate} onChange={(e) => setF({ ...f, fromDate: e.target.value })} /></label>
          <label>To <input type="date" value={f.toDate} onChange={(e) => setF({ ...f, toDate: e.target.value })} /></label>
          <button type="button" className="btn btn-sm btn-primary" disabled={!f.toUserId} onClick={save}>Save</button>
        </div>
      )}
      {msg && <Notice tone="red">{msg}</Notice>}
      {mine.map((r) => <div key={r.id} style={{ marginTop: 4 }}>Your approvals go to <b>{r.toName}</b>, {dmy(r.fromDate)} to {dmy(r.toDate)} <button type="button" className="btn btn-sm" onClick={async () => { await api.delete(`/ats/work/delegations/${r.id}`); load(); }}>Cancel</button></div>)}
      {forMe.map((r) => <div key={r.id} style={{ marginTop: 4 }}>You can approve for someone else, {dmy(r.fromDate)} to {dmy(r.toDate)}.</div>)}
    </div>
  );
}

// =========================================================== "Who will move" before any bulk action
export function BulkPreview({ body, confirmLabel = 'Confirm and do it', onConfirm, onCancel }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.post('/ats/work/bulk-preview', body).then((r) => setD(r.data)).catch((e) => setErr(say(e, 'Could not check who will move.'))); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal title="Who will move" size="wide" onClose={onCancel} foot={<><button className="btn" onClick={onCancel}>Back</button><button className="btn btn-primary" disabled={!d || !d.counts.willMove} onClick={onConfirm}>{confirmLabel}{d ? ` (${d.counts.willMove})` : ''}</button></>}>
      <Notice tone="red">{err}</Notice>
      {!d && !err && <div className="small-muted">Checking…</div>}
      {d && (
        <>
          <div style={{ marginBottom: 8 }}><b>{d.counts.willMove}</b> will move · <b>{d.counts.skipped}</b> will be skipped.</div>
          {d.willMove.length > 0 && <div className="tbl-wrap" style={{ maxHeight: 220, overflow: 'auto' }}><table><thead><tr><th>Will move</th><th>From</th><th>To</th></tr></thead><tbody>{d.willMove.map((r) => <tr key={r.id}><td>{r.name}</td><td className="cell-muted">{r.from}</td><td className="cell-muted">{r.to}</td></tr>)}</tbody></table></div>}
          {d.skipped.length > 0 && <div className="tbl-wrap" style={{ maxHeight: 200, overflow: 'auto', marginTop: 8 }}><table><thead><tr><th>Skipped</th><th>Why</th></tr></thead><tbody>{d.skipped.map((r) => <tr key={r.id}><td>{r.name}</td><td className="cell-muted">{r.reason}</td></tr>)}</tbody></table></div>}
        </>
      )}
    </Modal>
  );
}

// =========================================================== joining proof
export function JoiningProofBox({ applicationId }) {
  const [d, setD] = useState(null);
  const [msg, setMsg] = useState('');
  const load = useCallback(() => api.get(`/ats/work/joining-proof/${applicationId}`).then((r) => setD(r.data)).catch(() => setD(null)), [applicationId]);
  useEffect(() => { load(); }, [load]);
  if (!d || (!d.required && !d.proof)) return null;
  const upload = async (e) => {
    const file = e.target.files && e.target.files[0]; if (!file) return;
    setMsg(''); const fd = new FormData(); fd.append('file', file);
    try { const r = await api.post(`/ats/work/joining-proof/${applicationId}`, fd, { headers: { 'Content-Type': 'multipart/form-data' } }); setMsg(r.data.invoiceId ? 'Proof saved. The invoice is raised.' : 'Proof saved.'); load(); } catch (er) { setMsg(say(er, 'Could not upload.')); }
  };
  return (
    <div className="small-muted" style={{ fontSize: 12, marginTop: 4 }}>
      Joining proof: {d.proof ? <b>{d.proof.fileName} ({when(d.proof.uploadedAt)})</b> : <b style={{ color: '#d97706' }}>missing{d.billingStatus === 'Waiting for joining proof' ? ' — the invoice is waiting' : ''}</b>}
      {' '}<label className="btn btn-sm" style={{ marginLeft: 4 }}>Upload<input type="file" accept="application/pdf,image/png,image/jpeg" style={{ display: 'none' }} onChange={upload} /></label>
      {msg && <span> {msg}</span>}
    </div>
  );
}
