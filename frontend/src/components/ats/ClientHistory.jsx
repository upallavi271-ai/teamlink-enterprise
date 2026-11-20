import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import ExportMenu from '../ExportMenu.jsx';
import {
  Day, Definition, DropSummary, Filters, FunnelTiles, JoinedNote, cleanParams, fmtDay, money, num,
} from './HistoryParts.jsx';

// ---------------------------------------------------------------------------
// CLIENT HISTORY (top of the History tab of the Client page): the same funnel across all the client's requirements, the joinings with their
// dates and guarantee, why people dropped, the agreement, one row per requirement (each opens its own History), and - only for the logins that
// already see invoice amounts - billing. GET /api/ats/history/client/:id (utils/atsHistory.js).
// ---------------------------------------------------------------------------
const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthWord = (k) => `${MN[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`;

export default function ClientHistory({ clientId }) {
  const [f, setF] = useState({ from: '', to: '', period: '', recruiter: '' });
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [denied, setDenied] = useState(false);
  const params = cleanParams(f);
  const key = JSON.stringify(params);
  useEffect(() => {
    let live = true;
    setErr('');
    api.get(`/ats/history/client/${clientId}`, { params })
      .then((r) => { if (live) setD(r.data); })
      .catch((e) => { if (live) { if (e.response?.status === 403) setDenied(true); setErr(e.response?.data?.error || 'The client history could not be loaded.'); } });
    return () => { live = false; };
  }, [clientId, key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (denied) return null; // not the client desk: the older date-by-date history below is all this login gets
  if (err && !d) return <div className="notice red"><span>{err}</span></div>;
  if (!d) return <div className="small-muted">Loading the history…</div>;
  const rq = d.requirements;
  return (
    <div className="hx-tab">
      <div className="hx-bar">
        <h3 style={{ margin: 0 }}>Hiring history: {d.client.name}</h3>
        <span style={{ flex: 1 }} />
        {d.canExport && <ExportMenu url={`/ats/history/client/${clientId}/export`} params={params} formats={['xlsx', 'csv']} label="Download Excel" />}
      </div>
      <div className="hx-big">
        <div className="hx-bigbox"><b>{num(d.big.requirementsGiven)}</b><span>requirements given so far</span></div>
        <div className="hx-bigbox"><b>{num(d.big.joinings)}</b><span>joinings so far (still working){d.big.leftAfterJoining ? `, ${d.big.leftAfterJoining} more left after joining` : ''}</span></div>
      </div>
      <Filters f={f} setF={setF} recruiters={d.recruiters} />
      <FunnelTiles tiles={d.funnel} />
      <JoinedNote detail={d.joinedDetail} />
      <Definition text={d.definitions.dropped} joinedText={d.definitions.joined} joined={d.definitions.funnel} />
      <div className="hx-avg">
        <span><b>{num(rq.opened)}</b> requirement{rq.opened === 1 ? '' : 's'} opened</span>
        <span><b>{num(rq.closed)}</b> closed</span>
        <span><b>{num(rq.open)}</b> open now</span>
        <span>Average days to fill: <b>{d.averages.daysToFill === null ? 'not enough data' : d.averages.daysToFill}</b>{d.averages.filledRequirements ? ` (${d.averages.filledRequirements} filled)` : ''}</span>
        <span>Average days from sharing to joining: <b>{d.averages.daysShareToJoin === null ? 'not enough data' : d.averages.daysShareToJoin}</b></span>
      </div>
      {d.notes.estimatedDates > 0 && <div className="hx-muted">{d.notes.estimatedDates} date{d.notes.estimatedDates === 1 ? ' is' : 's are'} estimated (the exact day was not recorded).</div>}

      <DropSummary s={d.dropSummary} />

      <div className="hx-sec">
        <h3>Year by year and month by month</h3>
        <div className="hx-scroll">
          <table className="hx-table" style={{ minWidth: 560 }}>
            <thead><tr><th style={{ cursor: 'default' }}>Period</th><th style={{ cursor: 'default' }}>Requirements given</th><th style={{ cursor: 'default' }}>Openings</th><th style={{ cursor: 'default' }}>Sent to client</th><th style={{ cursor: 'default' }}>Joined</th><th style={{ cursor: 'default' }}>Dropped</th></tr></thead>
            <tbody>
              {d.breakdown.years.map((y) => <tr key={y.key}><td><b>{y.key}</b></td><td><b>{y.requirements}</b></td><td><b>{y.openings}</b></td><td><b>{y.shared}</b></td><td><b>{y.joined}</b></td><td><b>{y.dropped}</b></td></tr>)}
              {d.breakdown.months.map((m) => <tr key={m.key}><td>{monthWord(m.key)}</td><td>{m.requirements}</td><td>{m.openings}</td><td>{m.shared}</td><td>{m.joined}</td><td>{m.dropped}</td></tr>)}
            </tbody>
          </table>
        </div>
      </div>

      <div className="hx-sec">
        <h3>Requirement by requirement</h3>
        {d.requirementRows.length === 0 ? <div className="small-muted">No requirements in this period.</div> : (
          <div className="hx-scroll">
            <table className="hx-table" style={{ minWidth: 900 }}>
              <thead><tr><th>Requirement</th><th>Status</th><th>Openings</th><th>Created</th><th>Days open</th><th>Sourced</th><th>Sent</th><th>Shortlisted</th><th>Interviews</th><th>Selected</th><th>Offers</th><th>Joined</th><th>Dropped</th><th>In process</th></tr></thead>
              <tbody>
                {d.requirementRows.map((x) => (
                  <tr key={x.id}>
                    <td><Link to={`/requirements/${x.id}?tab=history`}>{x.reqCode ? `${x.reqCode} · ` : ''}{x.title}</Link></td>
                    <td>{x.statusLabel}</td><td>{x.openings}</td><td><Day v={x.createdDay} est={false} /></td><td>{x.daysOpen === null ? '—' : x.daysOpen}</td>
                    <td>{x.sourced}</td><td>{x.shared}</td><td>{x.shortlisted}</td><td>{x.interviews}</td><td>{x.selected}</td><td>{x.offers}</td><td><b>{x.joined}</b></td><td>{x.dropped}</td><td>{x.inProcess}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="hx-sec">
        <h3>Joinings ({d.joinings.length})</h3>
        {d.joinings.length === 0 ? <div className="small-muted">Nobody has joined yet.</div> : (
          <div className="hx-scroll">
            <table className="hx-table" style={{ minWidth: 640 }}>
              <thead><tr><th>Candidate</th><th>Requirement</th><th>Recruiter</th><th>Joining date</th><th>Guarantee</th></tr></thead>
              <tbody>
                {d.joinings.map((j) => (
                  <tr key={j.applicationId}>
                    <td>{j.candidate}</td><td><Link to={`/requirements/${j.requirementId}?tab=history`}>{j.requirement}</Link></td><td>{j.recruiterName || '—'}</td>
                    <td><Day v={j.joinDay} est={false} /></td>
                    <td>{j.guarantee}{j.guaranteeEnd ? ` (to ${fmtDay(j.guaranteeEnd)})` : ''}{j.left && j.left.reason ? <div className="hx-muted">left: {j.left.reason}</div> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {d.agreements && (
        <div className="hx-sec">
          <h3>Agreement</h3>
          <div className="hx-avg">
            <span>Status: <b>{d.agreements.status}</b></span>
            {d.agreements.renewal && <span>Renewal date: <b>{fmtDay(d.agreements.renewal)}</b></span>}
            {d.agreements.guarantee && <span>Guarantee: <b>{d.agreements.guarantee}</b></span>}
          </div>
          <ul className="hx-time">
            {d.agreements.events.map((e, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <li key={i}><span className="d">{fmtDay(e.day)}</span><span className="t">{e.label}{e.who ? ` (${e.who})` : ''}</span></li>
            ))}
          </ul>
        </div>
      )}

      {d.billing && (
        <div className="hx-sec">
          <h3>Billing</h3>
          <div className="hx-avg">
            <span><b>{num(d.billing.raised)}</b> invoices raised</span><span><b>{num(d.billing.paid)}</b> paid</span>
            <span>Revenue: <b>{money(d.billing.revenue)}</b></span><span>Received: <b>{money(d.billing.received)}</b></span>
          </div>
          <div className="hx-scroll">
            <table className="hx-table" style={{ minWidth: 560 }}>
              <thead><tr><th>Candidate</th><th>Invoice</th><th>Date</th><th>Amount</th><th>Status</th><th>Paid on</th></tr></thead>
              <tbody>
                {d.billing.perJoining.map((b) => (
                  <tr key={b.applicationId}><td>{b.candidate}</td><td>{b.invoiceNumber || '—'}</td><td><Day v={b.invoiceDay} est={false} /></td><td>{b.amount === null ? '—' : money(b.amount)}</td><td>{b.status}</td><td><Day v={b.paidDay} est={false} /></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
