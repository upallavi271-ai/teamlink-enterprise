import { useEffect, useState } from 'react';
import { HLink } from '../search/historyOpen.jsx'; // a history link opens in the drawer
import { Link, useParams } from 'react-router-dom';
import api from '../../api';
import ExportMenu from '../ExportMenu.jsx';
import HistorySeries, { mayOpenRecruiter, useHistoryAccess } from './HistorySeries.jsx';
import {
  Day, Definition, DropSummary, Filters, FunnelTiles, cleanParams, fmtDay, num,
} from './HistoryParts.jsx';

// ---------------------------------------------------------------------------
// TL HISTORY: the complete history of a team. The members each with their own totals (the team total is exactly their sum), the team's funnel,
// day / week / month wise work, requirements and clients served, the joined and dropped lists. GET /api/ats/history/tl/:id.
// ---------------------------------------------------------------------------
const NS = { cursor: 'default' };
const T_COLS = [['sourced', 'Sourced'], ['shared', 'Sent'], ['shortlisted', 'Shortlisted'], ['interviewScheduled', 'Interviews'], ['selected', 'Selected'], ['offerReleased', 'Offers'], ['joined', 'Joined'], ['dropped', 'Dropped'], ['left', 'Left after joining'], ['inprocess', 'In process']];

function People({ rows }) {
  return (
    <div className="hx-scroll">
      <table className="hx-table" style={{ minWidth: 900 }}>
        <thead><tr><th style={NS}>Candidate</th><th style={NS}>Recruiter</th><th style={NS}>Requirement</th><th style={NS}>Sent to client</th><th style={NS}>Joined</th><th style={NS}>Dropped</th></tr></thead>
        <tbody>
          {rows.map((x) => (
            <tr key={x.applicationId}>
              <td><HLink to={`/ats/history/candidate/${x.candidateId}`}>{x.candidate}</HLink></td><td>{x.recruiterName || '—'}</td><td>{x.requirement}<div className="hx-muted">{x.client}</div></td>
              <td><Day v={x.sent} /></td><td>{x.joinDay ? <Day v={x.joinDay} est={false} /> : '—'}</td>
              <td className="hx-why">{x.drop ? <><Day v={x.drop.day} est={x.drop.estimated} /><div><b>{x.drop.typeLabel}</b></div>{x.drop.reason && <div className="hx-muted">{x.drop.reason}</div>}</> : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function TlHistory({ personId, embedded = false }) {
  const routeParams = useParams();
  const id = personId || routeParams.id;
  const access = useHistoryAccess();
  const [f, setF] = useState({ from: '', to: '', period: '' });
  const [grain, setGrain] = useState('month');
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const params = { ...cleanParams(f), grain };
  const key = JSON.stringify(params);
  useEffect(() => {
    let live = true;
    setErr('');
    api.get(`/ats/history/tl/${id}`, { params })
      .then((r) => { if (live) setD(r.data); })
      .catch((e) => { if (live) setErr(e.response?.data?.error || 'The history could not be loaded.'); });
    return () => { live = false; };
  }, [id, key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err && !d) return <div>{!embedded && <Link className="small-muted" to="/ats/search">← Search</Link>}<div className="notice red" style={{ marginTop: 8 }}><span>{err}</span></div></div>;
  if (!d) return <div className="small-muted">Loading the history…</div>;
  const p = d.person;
  const head = (k, v) => v !== null && v !== undefined && v !== '' && <div><span className="k">{k}</span>{v}</div>;
  return (
    <div className="hx-tab">
      {!embedded && <Link className="small-muted" to="/ats/search">← Search</Link>}
      <div className="page-head" style={{ marginTop: 8 }}>
        <div><h1 style={{ fontSize: 20 }}>Team of {p.name}</h1><div className="page-sub">Team history: the whole team&apos;s work, from the first profile</div></div>
        {d.canExport && <ExportMenu url={`/ats/history/tl/${id}/export`} params={params} formats={['xlsx', 'csv']} label="Download Excel" />}
      </div>
      <div className="card section">
        <div className="hx-head">
          {head('Department', p.department)}{head('Section / team', p.section)}{head('Team lead', p.name)}{head('Status', p.statusWord)}{head('Members', d.team.members)}
          {head('Handovers', `${d.handovers.given} given, ${d.handovers.taken} taken`)}
        </div>
        <Filters f={f} setF={setF} recruiters={[]} />
        <FunnelTiles tiles={d.funnel} />
        <Definition text={d.definitions.dropped} joinedText={d.definitions.joined} joined={d.definitions.funnel} />
        <DropSummary s={d.dropSummary} />
        <HistorySeries series={d.series} grain={grain} setGrain={setGrain} targets={d.targets} />
      </div>

      <div className="card section hx-sec">
        <h3>The team, member by member</h3>
        <div className="hx-scroll">
          <table className="hx-table" style={{ minWidth: 900 }}>
            <thead><tr><th style={NS}>Recruiter</th>{T_COLS.map(([k, l]) => <th key={k} style={NS}>{l}</th>)}</tr></thead>
            <tbody>
              {d.members.map((m) => (
                <tr key={m.id || 'other'}>
                  <td>{m.id && mayOpenRecruiter(access, m.id) ? <HLink to={`/ats/history/recruiter/${m.id}`}>{m.name}</HLink> : m.name}{m.active === false ? <span className="hx-muted"> (left)</span> : null}</td>
                  {T_COLS.map(([k]) => <td key={k}>{num(m.totals[k])}</td>)}
                </tr>
              ))}
              <tr><td><b>Team total</b></td>{T_COLS.map(([k]) => <td key={k}><b>{num(d.total[k])}</b></td>)}</tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="card section hx-sec">
        <h3>Requirements handled ({d.requirements.length})</h3>
        <div className="hx-scroll">
          <table className="hx-table" style={{ minWidth: 760 }}>
            <thead><tr><th style={NS}>Requirement</th><th style={NS}>Client</th><th style={NS}>Status</th><th style={NS}>Openings</th><th style={NS}>Sent</th><th style={NS}>Joined</th><th style={NS}>Dropped</th><th style={NS} /></tr></thead>
            <tbody>
              {d.requirements.map((r) => (
                <tr key={r.id}>
                  <td>{r.reqCode ? `${r.reqCode} · ` : ''}{r.title}</td><td>{r.client}</td><td>{r.statusLabel}</td><td>{r.openings}</td><td>{r.numbers.shared}</td><td><b>{r.numbers.joined}</b></td><td>{r.numbers.dropped}</td>
                  <td><HLink className="btn btn-sm" to={`/requirements/${r.id}?tab=history`}>History</HLink></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card section hx-sec">
        <h3>Clients served ({d.clients.length})</h3>
        <div className="hx-scroll">
          <table className="hx-table" style={{ minWidth: 560 }}>
            <thead><tr><th style={NS}>Client</th><th style={NS}>Requirements</th><th style={NS}>Sent</th><th style={NS}>Selected</th><th style={NS}>Joined</th><th style={NS}>Dropped</th></tr></thead>
            <tbody>
              {d.clients.map((c) => (
                <tr key={c.id || c.name}><td>{c.name}</td><td>{c.requirements}</td><td>{c.numbers.shared}</td><td>{c.numbers.selected}</td><td><b>{c.numbers.joined}</b></td><td>{c.numbers.dropped}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card section hx-sec"><h3>Joined and still working ({d.joinedList.length})</h3>{d.joinedList.length ? <People rows={d.joinedList} /> : <div className="small-muted">Nobody yet.</div>}</div>
      <div className="card section hx-sec"><h3>Dropped, including left after joining ({d.droppedList.length})</h3>{d.droppedList.length ? <People rows={d.droppedList} /> : <div className="small-muted">Nobody.</div>}</div>
      <div className="hx-muted">As of {fmtDay(d.range.to)}.</div>
    </div>
  );
}
