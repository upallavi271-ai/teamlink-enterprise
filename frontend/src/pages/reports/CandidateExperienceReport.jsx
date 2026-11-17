import { useEffect, useState } from 'react';
import api from '../../api';
import StatCard, { StatRow } from '../../components/ui/StatCard.jsx';
import {
  AutoSwitch, ComplaintsPanel, DateRange, Downloads, NpsTable, NpsTiles, SurveysList, day, errText,
} from './ExperienceBits.jsx';

// ---------------------------------------------------------------------------
// Reports & Team -> Reports -> "Candidate experience" (backend routes/atsExperience.js):
//   Survey results   NPS and average stars by month, recruiter, client and stage (interview / offer / joining)
//   Complaints       candidate complaints: owner, Open / In progress / Resolved, due in 48 h, late ones go to the TL
//   Surveys sent     every survey with how it went out and the answer
//   Apply form       the job-portal Apply form: started vs submitted, abandoned, completion rate per job and source
// ---------------------------------------------------------------------------
const PARTS = [['results', 'Survey results'], ['complaints', 'Complaints'], ['surveys', 'Surveys sent'], ['apply', 'Apply form (job portal)']];
const yearAgo = () => new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

function Results() {
  const [r, setR] = useState({ from: yearAgo(), to: today() });
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.get('/ats-experience/candidate-report', { params: r }).then((x) => { setD(x.data); setErr(''); }).catch((e) => setErr(errText(e, 'Could not load the report.'))); }, [r]);
  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <DateRange value={r} onChange={setR} />
        <span style={{ flex: 1 }} />
        <Downloads name="candidate-experience" params={r} onError={setErr} />
      </div>
      {err && <div className="notice red"><span>{err}</span></div>}
      <p className="small-muted" style={{ margin: '0 0 10px' }}>After the interview, the offer and joining, the candidate gets one short survey (1-5 stars, &quot;would you recommend us&quot; 0-10, a comment). NPS = % promoters (9-10) minus % detractors (0-6).</p>
      {!d ? <div className="small-muted">Loading…</div> : (
        <>
          <NpsTiles o={d.overall} />
          <NpsTable title="By stage" first="Stage" rows={d.byStage} />
          <NpsTable title="By month" first="Month" rows={d.byMonth} />
          <NpsTable title="By recruiter" first="Recruiter" rows={d.byRecruiter} />
          <NpsTable title="By client" first="Client" rows={d.byClient} />
          <section style={{ marginTop: 16 }}>
            <h3 style={{ fontSize: 14, margin: '0 0 6px' }}>Latest answers</h3>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Answered</th><th>Candidate</th><th>Stage</th><th>Client</th><th>Recruiter</th><th className="num">Stars</th><th className="num">0-10</th><th>Comment</th></tr></thead>
                <tbody>
                  {d.recent.map((a) => (
                    <tr key={a.id}><td>{day(a.at)}</td><td>{a.person}</td><td>{a.stage}</td><td>{a.client || '—'}</td><td>{a.recruiter || '—'}</td><td className="num">{a.stars || '—'}</td><td className="num"><b>{a.nps}</b></td><td>{a.comment || ''}{a.complaintId ? <div className="small-muted">Complaint #{a.complaintId}</div> : null}</td></tr>
                  ))}
                  {!d.recent.length && <tr><td colSpan={8} className="small-muted">No answers yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function ApplyFunnel() {
  const [r, setR] = useState({ from: new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10), to: today() });
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.get('/ats-experience/apply-funnel', { params: r }).then((x) => { setD(x.data); setErr(''); }).catch((e) => setErr(errText(e, 'Could not load the report.'))); }, [r]);
  const table = (title, first, rows) => (
    <section style={{ marginTop: 16 }}>
      <h3 style={{ fontSize: 14, margin: '0 0 6px' }}>{title}</h3>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>{first}</th><th className="num">Started</th><th className="num">Submitted</th><th className="num">Abandoned</th><th className="num">Still filling</th><th className="num">Completion rate</th><th className="num">Filled when abandoned</th></tr></thead>
          <tbody>
            {rows.map((g) => <tr key={g.key}><td>{g.label}</td><td className="num">{g.started}</td><td className="num">{g.submitted}</td><td className="num">{g.abandoned}</td><td className="num">{g.inProgress}</td><td className="num"><b>{g.completionRate === null ? '—' : `${g.completionRate}%`}</b></td><td className="num">{g.avgFilledWhenAbandoned === null ? '—' : `${g.avgFilledWhenAbandoned}%`}</td></tr>)}
            {!rows.length && <tr><td colSpan={7} className="small-muted">Nobody opened the Apply form in this period.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <DateRange value={r} onChange={setR} />
        <span style={{ flex: 1 }} />
        <Downloads name="apply-funnel" params={r} onError={setErr} />
      </div>
      {err && <div className="notice red"><span>{err}</span></div>}
      <p className="small-muted" style={{ margin: '0 0 10px' }}>Counted from the job portal&apos;s Apply form: &quot;started&quot; when it opens, how much of it is filled as the person types, &quot;submitted&quot; when the application arrives. Abandoned = not sent and nothing typed for 30 minutes.</p>
      {!d ? <div className="small-muted">Loading…</div> : (
        <>
          <StatRow>
            <StatCard label="Started" value={d.overall.started} zeroText="None yet" />
            <StatCard label="Submitted" value={d.overall.submitted} tone="green" zeroText="None yet" />
            <StatCard label="Abandoned" value={d.overall.abandoned} tone="red" upIsGood={false} zeroText="None" />
            <StatCard label="Completion rate" value={d.overall.completionRate === null ? null : `${d.overall.completionRate}%`} />
          </StatRow>
          {table('By job', 'Job', d.byJob)}
          {table('By source', 'Source', d.bySource)}
        </>
      )}
    </div>
  );
}

export default function CandidateExperienceReport() {
  const [part, setPart] = useState('results');
  return (
    <div>
      <AutoSwitch which="candidateSurveys" />
      <div className="tabs" role="tablist" aria-label="Candidate experience">
        {PARTS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={part === id} className={`tab-btn${part === id ? ' active' : ''}`} onClick={() => setPart(id)}>{label}</button>
        ))}
      </div>
      {part === 'results' && <Results />}
      {part === 'complaints' && <ComplaintsPanel side="candidate" />}
      {part === 'surveys' && <SurveysList side="candidate" />}
      {part === 'apply' && <ApplyFunnel />}
    </div>
  );
}
