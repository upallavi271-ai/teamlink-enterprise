import { useCallback, useEffect, useState } from 'react';
import useAtsLive from '../../utils/useAtsLive.js';
import { HLink } from '../search/historyOpen.jsx'; // a history link opens in the drawer
import { Link, useParams } from 'react-router-dom';
import api from '../../api';
import ExportMenu from '../ExportMenu.jsx';
import HistorySeries from './HistorySeries.jsx';
import {
  Day, Definition, DropSummary, Filters, FunnelTiles, StepPopup, cleanParams, fmtDay, num,
} from './HistoryParts.jsx';

// ---------------------------------------------------------------------------
// RECRUITER HISTORY (the page a search result for a recruiter opens): who they are, the requirements they handled with their own numbers, the
// funnel with dates, day / week / month wise work, a candidate table with every date, the handovers and the targets.
// GET /api/ats/history/recruiter/:id (utils/atsHistoryPeople.js). The server only answers a login that may open this person.
// ---------------------------------------------------------------------------
const NS = { cursor: 'default' };

export default function RecruiterHistory({ personId, embedded = false }) {
  const routeParams = useParams();
  const id = personId || routeParams.id;
  const [f, setF] = useState({ from: '', to: '', period: '' });
  const [grain, setGrain] = useState('month');
  const [status, setStatus] = useState('');
  const [step, setStep] = useState('');
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [loadedKey, setLoadedKey] = useState('');
  const closeStep = useCallback(() => setStep(''), []);
  const params = { ...cleanParams(f), grain, ...(status ? { status } : {}), ...(step ? { step } : {}) };
  const key = JSON.stringify(params);
  const live = useAtsLive(); // ATS data changed: load the numbers again (founder 2026-11-27)
  useEffect(() => {
    let live = true;
    setErr('');
    api.get(`/ats/history/recruiter/${id}`, { params })
      .then((r) => { if (live) { setD(r.data); setLoadedKey(key); } })
      .catch((e) => { if (live) setErr(e.response?.data?.error || 'The history could not be loaded.'); });
    return () => { live = false; };
  }, [live, id, key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err && !d) return <div>{!embedded && <Link className="small-muted" to="/ats/search">← Search</Link>}<div className="notice red" style={{ marginTop: 8 }}><span>{err}</span></div></div>;
  if (!d) return <div className="small-muted">Loading the history…</div>;
  const p = d.person;
  const picked = step ? d.funnel.find((t) => t.key === step) : null;
  const candTable = (rows) => (
    <div className="hx-scroll">
      <table className="hx-table" style={{ minWidth: 1000 }}>
        <thead>
          <tr>
            <th style={NS}>Candidate</th><th style={NS}>Requirement</th><th style={NS}>Added</th><th style={NS}>Sent to client</th><th style={NS}>Interview</th>
            <th style={NS}>Selected</th><th style={NS}>Offer</th><th style={NS}>Joined</th><th style={NS}>Dropped</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((x) => (
            <tr key={x.applicationId}>
              <td><HLink to={`/ats/history/candidate/${x.candidateId}`}>{x.candidate}</HLink></td>
              <td>{x.requirement}<div className="hx-muted">{x.client}</div></td>
              <td><Day v={x.added} /></td><td><Day v={x.sent} /></td>
              <td>{x.interviewDates.length ? x.interviewDates.map(fmtDay).join(', ') : '—'}</td><td><Day v={x.selected} /></td><td><Day v={x.offer} /></td>
              <td>{x.joinDay && x.outcome === 'joined' ? <Day v={x.joinDay} est={false} /> : x.joinDay ? <span className="hx-muted">{fmtDay(x.joinDay)} (left)</span> : '—'}</td>
              <td className="hx-why">{x.drop ? <><Day v={x.drop.day} est={x.drop.estimated} /><div><b>{x.drop.typeLabel}</b></div>{x.drop.reason && <div className="hx-muted">{x.drop.reason}</div>}</> : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  const head = (k, v) => v !== null && v !== undefined && v !== '' && <div><span className="k">{k}</span>{v}</div>;
  return (
    <div className="hx-tab">
      {!embedded && <Link className="small-muted" to="/ats/search">← Search</Link>}
      <div className="page-head" style={{ marginTop: 8 }}>
        <div><h1 style={{ fontSize: 20 }}>{p.name}</h1><div className="page-sub">Recruiter history: everything this recruiter has done, from the first profile</div></div>
        {d.canExport && <ExportMenu url={`/ats/history/recruiter/${id}/export`} params={params} formats={['xlsx', 'csv']} label="Download Excel" />}
      </div>
      <div className="card section">
        <div className="hx-head">
          {head('Department', p.department)}{head('Section / team', p.section)}{head('Seat', p.seat)}{head('Team lead', p.teamLead)}
          {head('Status', p.statusWord)}{head('With TeamLink since', `${fmtDay(p.since.day)}${p.since.est ? ' (estimated)' : ''}`)}{head('Designation', p.designation)}
        </div>
        <Filters f={f} setF={setF} recruiters={[]} clients={(d.options && d.options.clients) || []} requirements={(d.options && d.options.requirements) || []} statuses />
        <FunnelTiles tiles={d.funnel} active={step} onPick={(k) => { setStep(k); setStatus(''); }} />
        <StepPopup tile={picked} total={d.total} shown={d.rows.length} loading={loadedKey !== key} onClose={closeStep} rows={d.rows} render={candTable} />
        <Definition text={d.definitions.dropped} joinedText={d.definitions.joined} joined={d.definitions.funnel} />
        <DropSummary s={d.dropSummary} />
        <HistorySeries series={d.series} grain={grain} setGrain={setGrain} targets={d.targets} />
      </div>

      <div className="card section hx-sec">
        <h3>Requirements handled ({d.requirements.length})</h3>
        {d.requirements.length === 0 ? <div className="small-muted">None yet.</div> : (
          <div className="hx-scroll">
            <table className="hx-table" style={{ minWidth: 860 }}>
              <thead>
                <tr>
                  <th style={NS}>Requirement</th><th style={NS}>Client</th><th style={NS}>Status</th><th style={NS}>Openings</th><th style={NS}>Sourced</th><th style={NS}>Sent</th>
                  <th style={NS}>Interviews</th><th style={NS}>Selected</th><th style={NS}>Joined</th><th style={NS}>Dropped</th><th style={NS} />
                </tr>
              </thead>
              <tbody>
                {d.requirements.map((r) => (
                  <tr key={r.id}>
                    <td>{r.reqCode ? `${r.reqCode} · ` : ''}{r.title}</td>
                    <td>{r.clientId ? <HLink to={`/clients/${r.clientId}?tab=history`}>{r.client}</HLink> : r.client}</td>
                    <td>{r.statusLabel}</td><td>{r.openings}</td>
                    <td>{r.numbers.sourced}</td><td>{r.numbers.shared}</td><td>{r.numbers.interviewScheduled}</td><td>{r.numbers.selected}</td><td><b>{r.numbers.joined}</b></td><td>{r.numbers.dropped}</td>
                    <td><HLink className="btn btn-sm" to={`/requirements/${r.id}?tab=history`}>History</HLink></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card section hx-sec">
        <div className="hx-bar">
          <h3 style={{ margin: 0 }}>Candidates ({d.total})</h3><span style={{ flex: 1 }} />
          <label className="hx-muted">Show{' '}
            <select value={status} onChange={(e) => { setStatus(e.target.value); setStep(''); }}>
              {[['', 'Everyone'], ['joined', 'Joined (still working)'], ['dropped', 'Dropped'], ['inprocess', 'In process'], ['left', 'Left after joining']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
        </div>
        {candTable(d.rows)}
      </div>

      <div className="card section hx-sec">
        <h3>Handovers</h3>
        <div className="hx-muted" style={{ marginBottom: 6 }}>Given to others: {num(d.handovers.given.length)}. Taken over from others: {num(d.handovers.taken.length)}.</div>
        {[['Given', d.handovers.given], ['Taken', d.handovers.taken]].map(([t, list]) => list.length > 0 && (
          <div key={t}>
            <h4 style={{ margin: '6px 0 2px' }}>{t}</h4>
            <ul className="hx-time">
              {list.map((h, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <li key={i}><span className="d">{fmtDay(h.day)}</span><span className="t">{h.candidate}{h.requirement ? ` (${h.requirement})` : ''}: {h.from || '—'} to {h.to}{h.reason ? ` — ${h.reason}` : ''}</span></li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
