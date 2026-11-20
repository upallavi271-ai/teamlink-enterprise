import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import ExportMenu from '../ExportMenu.jsx';
import { mayOpenRecruiter, useHistoryAccess } from './HistorySeries.jsx';
import {
  Day, Definition, DropSummary, Filters, FunnelTiles, JoinedNote, cleanParams, fmtDay, stepLabel,
} from './HistoryParts.jsx';

// ---------------------------------------------------------------------------
// REQUIREMENT HISTORY (the "History" tab of the Requirement page, and where a search result opens).
// Header, the numbered funnel (each tile opens the people behind it), the candidate-by-candidate table, the timeline.
// All numbers come from GET /api/ats/history/requirement/:id (utils/atsHistory.js); this file only draws them.
// ---------------------------------------------------------------------------
const STATUS = [['', 'Everyone'], ['joined', 'Joined'], ['dropped', 'Dropped'], ['inprocess', 'In process'], ['selected', 'Selected, not joined yet'], ['left', 'Left after joining']];
const COLS = [
  ['candidate', 'Candidate'], ['recruiter', 'Recruiter'], ['shared', 'Sent to client'], ['stage', 'Step now'], ['interview', 'Interview'],
  ['selected', 'Selected'], ['offer', 'Offer'], ['joined', 'Joining date'], ['dropped', 'Dropped'],
];
const STATUS_WORD = { joined: 'Joined', dropped: 'Dropped', inprocess: 'In process', selected: 'Selected' };

export default function HistoryTab({ requirementId }) {
  const access = useHistoryAccess();
  const [f, setF] = useState({ from: '', to: '', period: '', recruiter: '' });
  const [status, setStatus] = useState('');
  const [step, setStep] = useState('');
  const [sort, setSort] = useState({ key: 'shared', dir: 'asc' });
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);

  const params = { ...cleanParams(f), ...(status ? { status } : {}), ...(step ? { step } : {}), sort: sort.key, dir: sort.dir };
  const key = JSON.stringify(params);
  useEffect(() => {
    let live = true;
    setBusy(true); setErr('');
    api.get(`/ats/history/requirement/${requirementId}`, { params })
      .then((r) => { if (live) setD(r.data); })
      .catch((e) => { if (live) setErr(e.response?.data?.error || 'The history could not be loaded.'); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [requirementId, key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err && !d) return <div className="notice red"><span>{err}</span></div>;
  if (!d) return <div className="small-muted">Loading the history…</div>;
  const r = d.requirement;
  const head = (k, v) => v !== null && v !== undefined && v !== '' && <div><span className="k">{k}</span>{v}</div>;
  const th = (k) => setSort((s) => (s.key === k ? { key: k, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'asc' }));
  const arrow = (k) => (sort.key === k ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');
  const picked = d.funnel.find((t) => t.key === step);
  const time = all ? d.timeline : d.timeline.slice(0, 25);
  return (
    <div className="hx-tab">
      <div className="hx-head">
        {head('Client', r.client.name)}
        {head('Requirement', `${r.reqCode ? `${r.reqCode} · ` : ''}${r.title}`)}
        {head('Status', r.statusLabel)}
        {head('Openings', r.openings)}
        {head('Created', fmtDay(r.createdDay) + (r.createdBy ? ` by ${r.createdBy}` : ''))}
        {head('Posted', r.posted.length ? r.posted.map((p) => `${p.where} ${fmtDay(p.day)}`).join(', ') : 'Not posted anywhere yet')}
        {head('Assigned', r.assigned.length ? r.assigned.map((a) => `${a.name} (${a.role}, ${fmtDay(a.day)}${a.est ? ' est.' : ''})`).join('; ') : 'Not assigned yet')}
        {head(r.closedDay ? 'Closed' : 'Still open', r.closedDay ? `${fmtDay(r.closedDay)}${r.closedEstimated ? ' (estimated)' : ''}` : 'Yes')}
        {head('Days open', r.daysOpen)}
      </div>

      <Filters f={f} setF={setF} recruiters={d.recruiters} />
      <FunnelTiles tiles={d.funnel} active={step} onPick={(k) => { setStep(k); setStatus(''); }} />
      <JoinedNote detail={d.joinedDetail} />
      <Definition text={d.definitions.dropped} joinedText={d.definitions.joined} joined={d.definitions.funnel} />
      <DropSummary s={d.dropSummary} />
      {d.notes.estimatedDates > 0 && <div className="hx-muted">{d.notes.estimatedDates} date{d.notes.estimatedDates === 1 ? ' is' : 's are'} marked “est.”: the exact day was not recorded, so the nearest recorded day is shown.</div>}

      <div className="hx-sec">
        <div className="hx-bar">
          <h3 style={{ margin: 0 }}>Candidate by candidate ({d.total}{busy ? '…' : ''})</h3>
          <span style={{ flex: 1 }} />
          <label className="hx-muted">Show{' '}
            <select value={status} onChange={(e) => { setStatus(e.target.value); setStep(''); }}>
              {STATUS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          {d.canExport && <ExportMenu url={`/ats/history/requirement/${requirementId}/export`} params={params} formats={['xlsx', 'csv']} label="Download Excel" />}
        </div>
        {picked && <div className="hx-muted" style={{ marginBottom: 6 }}>Showing: {stepLabel(picked)}. <button type="button" className="btn btn-sm btn-ghost" onClick={() => setStep('')}>Show everyone</button></div>}
        {d.rows.length === 0 ? <div className="small-muted">Nobody matches.</div> : (
          <div className="hx-scroll">
            <table className="hx-table">
              <thead>
                <tr>{COLS.map(([k, l]) => <th key={k} onClick={() => th(k)}>{l}{arrow(k)}</th>)}<th>Result</th></tr>
              </thead>
              <tbody>
                {d.rows.map((x) => (
                  <tr key={x.applicationId}>
                    <td><Link to={`/ats/history/candidate/${x.candidateId}`}>{x.candidate}</Link></td>
                    <td>{x.recruiterName && mayOpenRecruiter(access, x.recruiterId) ? <Link to={`/ats/history/recruiter/${x.recruiterId}`}>{x.recruiterName}</Link> : (x.recruiterName || '—')}</td>
                    <td><Day v={x.shared} /></td>
                    <td>{x.stageLabel}</td>
                    <td>{x.interviewDates.length ? x.interviewDates.map(fmtDay).join(', ') : '—'}{x.interviewResult ? <div className="hx-muted">{x.interviewResult}</div> : null}</td>
                    <td><Day v={x.selected} /></td>
                    <td><Day v={x.offer} />{x.offerAccepted ? <div className="hx-muted">accepted <Day v={x.offerAccepted} /></div> : null}</td>
                    <td>{x.joinDay ? <><Day v={x.joinDay} est={false} />{x.guaranteeEnd ? <div className="hx-muted">guarantee to {fmtDay(x.guaranteeEnd)}</div> : null}</> : (x.joinedUncounted ? <span className="hx-muted">No joining day</span> : '—')}</td>
                    <td className="hx-why">
                      {x.drop ? (
                        <>
                          <Day v={x.drop.day} est={x.drop.estimated} />
                          {x.drop.stageLabel && x.drop.type !== 'left_after_joining' && <div className="hx-muted">at “{x.drop.stageLabel}”</div>}
                          <div><b>{x.drop.typeLabel}</b></div>
                          {x.drop.reason && <div className="hx-muted">{x.drop.reason}</div>}
                          {(x.drop.byName || x.drop.by) && <div className="hx-muted">by {[x.drop.byName, x.drop.by].filter(Boolean).join(', ')}</div>}
                        </>
                      ) : '—'}
                    </td>
                    <td>
                      <span className={`hx-badge ${x.outcome}`}>{STATUS_WORD[x.outcome] || x.outcome}</span>
                      {x.drop && x.drop.type === 'left_after_joining' && <div className="hx-muted">joined, then left</div>}
                      {x.daysShareToJoin !== null && x.daysShareToJoin !== undefined && <div className="hx-muted">{x.daysShareToJoin} days from sharing to joining</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="hx-sec">
        <h3>Timeline</h3>
        {time.length === 0 ? <div className="small-muted">Nothing recorded yet.</div> : (
          <ul className="hx-time">
            {time.map((e, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <li key={i}><span className="d">{fmtDay(e.day)}{e.est && <sup className="hx-est">est.</sup>}</span><span className="t">{e.text}</span></li>
            ))}
          </ul>
        )}
        {!all && d.timeline.length > 25 && <button type="button" className="btn btn-sm" onClick={() => setAll(true)}>Show all {d.timeline.length} events</button>}
      </div>
    </div>
  );
}
