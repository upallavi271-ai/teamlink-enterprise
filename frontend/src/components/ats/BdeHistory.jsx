import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { HLink } from '../search/historyOpen.jsx'; // a history link opens in the drawer
import api from '../../api';
import ExportMenu from '../ExportMenu.jsx';
import HistorySeries, { mayOpenBde, useHistoryAccess } from './HistorySeries.jsx';
import {
  Day, Definition, DropSummary, Filters, FunnelTiles, StepPopup, cleanParams, fmtDay, money, num,
} from './HistoryParts.jsx';

// ---------------------------------------------------------------------------
// BDE HISTORY (founder 2026-11-20: "when I search a BDE's name, their history does not come"). Who the BDE is, the clients they own, the
// requirements they handled with the funnel, day / week / month wise work, the joined and dropped lists, the follow-ups and meetings they
// logged and (only for a login that sees invoice amounts) the invoices of their clients. GET /api/ats/history/bde/:id (utils/atsHistoryPeople.js).
// ---------------------------------------------------------------------------
const NS = { cursor: 'default' };
const SERIES_COLS = [
  ['requirements', 'Requirements raised'], ['sent', 'Profiles shared'], ['interviews', 'Interviews'], ['joined', 'Joinings'],
  ['followups', 'Client follow-ups / meetings'], ['signed', 'New clients signed'],
];
const clientLink = (id, name) => (id ? <HLink to={`/clients/${id}?tab=history`}>{name}</HLink> : name);
const reqLink = (id, label) => (id ? <HLink to={`/requirements/${id}?tab=history`}>{label}</HLink> : label);

function People({ rows }) {
  return (
    <div className="hx-scroll">
      <table className="hx-table" style={{ minWidth: 900 }}>
        <thead><tr><th style={NS}>Candidate</th><th style={NS}>Recruiter</th><th style={NS}>Requirement</th><th style={NS}>Sent to client</th><th style={NS}>Joined</th><th style={NS}>Dropped</th></tr></thead>
        <tbody>
          {rows.map((x) => (
            <tr key={x.applicationId}>
              <td><HLink to={`/ats/history/candidate/${x.candidateId}`}>{x.candidate}</HLink></td><td>{x.recruiterName || '—'}</td>
              <td>{reqLink(x.requirementId, x.requirement)}<div className="hx-muted">{clientLink(x.clientId, x.client)}</div></td>
              <td><Day v={x.sent} /></td><td>{x.joinDay ? <Day v={x.joinDay} est={false} /> : '—'}</td>
              <td className="hx-why">{x.drop ? <><Day v={x.drop.day} est={x.drop.estimated} /><div><b>{x.drop.typeLabel}</b></div>{x.drop.reason && <div className="hx-muted">{x.drop.reason}</div>}</> : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function BdeHistory({ personId, embedded = false }) {
  const routeParams = useParams();
  const id = personId || routeParams.id;
  const access = useHistoryAccess();
  const [f, setF] = useState({ from: '', to: '', period: '' });
  const [step, setStep] = useState(''); // a funnel card picked: its people open in a popup (2026-11-25)
  const [loadedKey, setLoadedKey] = useState('');
  const closeStep = useCallback(() => setStep(''), []);
  const [grain, setGrain] = useState('month');
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const params = { ...{ ...cleanParams(f), grain }, ...(step ? { step } : {}) };
  const key = JSON.stringify(params);
  useEffect(() => {
    let live = true;
    setErr('');
    api.get(`/ats/history/bde/${id}`, { params })
      .then((r) => { if (live) { setD(r.data); setLoadedKey(key); } })
      .catch((e) => { if (live) setErr(e.response?.data?.error || 'The history could not be loaded.'); });
    return () => { live = false; };
  }, [id, key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err && !d) return <div>{!embedded && <Link className="small-muted" to="/ats/search">← Search</Link>}<div className="notice red" style={{ marginTop: 8 }}><span>{err}</span></div></div>;
  if (!d) return <div className="small-muted">Loading the history…</div>;
  const p = d.person;
  const head = (k, v) => v !== null && v !== undefined && v !== '' && <div><span className="k">{k}</span>{v}</div>;
  return (
    <div className="hx-tab" data-testid="bde-history">
      {!embedded && <Link className="small-muted" to="/ats/search">← Search</Link>}
      <div className="page-head" style={{ marginTop: 8 }}>
        <div><h1 style={{ fontSize: 20 }}>{p.name}</h1><div className="page-sub">{p.role} history: the clients, requirements and joinings of this {p.role}, from the first requirement</div></div>
        {d.canExport && <ExportMenu url={`/ats/history/bde/${id}/export`} params={params} formats={['xlsx', 'csv']} label="Download Excel" />}
      </div>
      <div className="card section">
        <div className="hx-head">
          {head('Role', p.role)}{head('Employee code', p.employeeCode)}{head('Department', p.department)}{head('Seat', p.seat)}
          {p.role === 'BDE' && head('BDE TL', p.teamLead)}{head('Status', p.statusWord)}{head('With TeamLink since', `${fmtDay(p.since.day)}${p.since.est ? ' (estimated)' : ''}`)}
          {p.bdes && head('BDEs', p.bdes.length ? p.bdes.map((b, i) => <span key={b.id}>{i ? ', ' : ''}{mayOpenBde(access, b.id) ? <HLink to={`/ats/history/bde/${b.id}`}>{b.name}</HLink> : b.name}</span>) : 'None')}
        </div>
        <Filters f={f} setF={setF} clients={(d.options && d.options.clients) || []} requirements={(d.options && d.options.requirements) || []} statuses />
        <FunnelTiles tiles={d.funnel} active={step} onPick={setStep} />
        <StepPopup tile={step ? d.funnel.find((t) => t.key === step) : null} total={d.stepTotal || 0} shown={(d.stepRows || []).length} loading={loadedKey !== key} onClose={closeStep}><People rows={d.stepRows || []} /></StepPopup>
        <Definition text={d.definitions.dropped} joinedText={d.definitions.joined} joined={d.definitions.funnel} />
        <DropSummary s={d.dropSummary} />
        <HistorySeries series={d.series} grain={grain} setGrain={setGrain} cols={SERIES_COLS} />
      </div>

      <div className="card section hx-sec">
        <h3>Clients ({d.clients.length})</h3>
        {d.clients.length === 0 ? <div className="small-muted">None yet.</div> : (
          <div className="hx-scroll">
            <table className="hx-table" style={{ minWidth: 820 }}>
              <thead><tr><th style={NS}>Client</th><th style={NS}>How</th>{d.clients[0].agreementStatus !== undefined && <><th style={NS}>Agreement</th><th style={NS}>Signed</th></>}<th style={NS}>Requirements</th><th style={NS}>Open</th><th style={NS}>Sent</th><th style={NS}>Joined</th><th style={NS}>Dropped</th></tr></thead>
              <tbody>
                {d.clients.map((c) => (
                  <tr key={c.id}>
                    <td>{clientLink(c.id, c.name)}{c.code && <div className="hx-muted">{c.code}</div>}</td><td className="hx-muted">{c.owner}</td>
                    {c.agreementStatus !== undefined && <><td>{c.agreementStatus || '—'}</td><td><Day v={c.signedDay} est={false} /></td></>}
                    <td>{c.requirements}</td><td>{c.open}</td><td>{c.shared}</td><td><b>{c.joined}</b></td><td>{c.dropped}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card section hx-sec">
        <h3>Requirements handled ({d.requirements.length})</h3>
        {d.requirements.length === 0 ? <div className="small-muted">None yet.</div> : (
          <div className="hx-scroll">
            <table className="hx-table" style={{ minWidth: 900 }}>
              <thead><tr><th style={NS}>Requirement</th><th style={NS}>Client</th><th style={NS}>Status</th><th style={NS}>Raised</th><th style={NS}>Openings</th><th style={NS}>Sent</th><th style={NS}>Shortlisted</th><th style={NS}>Interviews</th><th style={NS}>Selected</th><th style={NS}>Offers</th><th style={NS}>Joined</th><th style={NS}>Dropped</th></tr></thead>
              <tbody>
                {d.requirements.map((r) => (
                  <tr key={r.id}>
                    <td>{reqLink(r.id, `${r.reqCode ? `${r.reqCode} · ` : ''}${r.title}`)}</td><td>{clientLink(r.clientId, r.client)}</td><td>{r.statusLabel}</td><td><Day v={r.createdDay} est={false} /></td><td>{r.openings}</td>
                    <td>{r.numbers.shared}</td><td>{r.numbers.shortlisted}</td><td>{r.numbers.interviewScheduled}</td><td>{r.numbers.selected}</td><td>{r.numbers.offerReleased}</td><td><b>{r.numbers.joined}</b></td><td>{r.numbers.dropped}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card section hx-sec"><h3>Joined and still working ({d.joinedList.length})</h3>{d.joinedList.length ? <People rows={d.joinedList} /> : <div className="small-muted">Nobody yet.</div>}</div>
      <div className="card section hx-sec"><h3>Dropped, including left after joining ({d.droppedList.length})</h3>{d.droppedList.length ? <People rows={d.droppedList} /> : <div className="small-muted">Nobody.</div>}</div>

      {d.replacements.table.length > 0 && (
        <div className="card section hx-sec">
          <h3>Replacements</h3>
          <div className="hx-muted" style={{ marginBottom: 6 }}>Given: {num(d.replacements.replaced)}. Still owed: {num(d.replacements.pending)}.</div>
          <div className="hx-scroll">
            <table className="hx-table" style={{ minWidth: 700 }}>
              <thead><tr><th style={NS}>Dropped candidate</th><th style={NS}>Replaced by</th><th style={NS}>Client</th><th style={NS}>Requirement</th><th style={NS}>Dropped on</th><th style={NS}>Replacement joined</th><th style={NS}>Where it stands</th></tr></thead>
              <tbody>
                {d.replacements.table.map((t) => (
                  <tr key={t.id}><td>{t.droppedCandidate}</td><td>{t.replacementCandidate || '—'}</td><td>{t.clientName || '—'}</td><td>{t.jobTitle || '—'}</td><td><Day v={t.droppedOn} est={false} /></td><td><Day v={t.replacementJoinedOn} est={false} /></td><td>{t.words || '—'}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card section hx-sec">
        <h3>Client follow-ups and meetings logged ({d.followupTotal})</h3>
        {d.followups.length === 0 ? <div className="small-muted">None in this period.</div> : (
          <ul className="hx-time">
            {d.followups.map((t) => (
              <li key={t.id}><span className="d">{fmtDay(t.day)}</span><span className="t"><b>{t.kind}</b> · {clientLink(t.clientId, t.client)}: {t.text}</span></li>
            ))}
          </ul>
        )}
        {d.followupTotal > d.followups.length && <div className="hx-muted">The newest {d.followups.length} are shown; the Excel has them all.</div>}
      </div>

      {d.billing && (
        <div className="card section hx-sec">
          <h3>Invoices of these clients</h3>
          <div className="hx-avg">
            <span><b>{num(d.billing.raised)}</b> raised</span><span><b>{num(d.billing.paid)}</b> paid</span><span><b>{num(d.billing.overdue)}</b> overdue</span>
            <span>Amount: <b>{money(d.billing.amount)}</b></span><span>Received: <b>{money(d.billing.received)}</b></span>{d.billing.overdue > 0 && <span>Overdue: <b>{money(d.billing.overdueAmount)}</b></span>}
          </div>
          {d.billing.rows.length > 0 && (
            <div className="hx-scroll">
              <table className="hx-table" style={{ minWidth: 760 }}>
                <thead><tr><th style={NS}>Invoice</th><th style={NS}>Client</th><th style={NS}>Candidate</th><th style={NS}>Date</th><th style={NS}>Due</th><th style={NS}>Amount</th><th style={NS}>Status</th><th style={NS}>Paid on</th></tr></thead>
                <tbody>
                  {d.billing.rows.map((i) => (
                    <tr key={i.id}>
                      <td><Link to={`/invoices/${i.id}`}>{i.invoiceNumber || 'Invoice'}</Link></td><td>{clientLink(i.clientId, i.client)}</td>
                      <td>{i.candidateId ? <HLink to={`/ats/history/candidate/${i.candidateId}`}>{i.candidate}</HLink> : '—'}</td>
                      <td><Day v={i.invoiceDay} est={false} /></td><td><Day v={i.dueDay} est={false} /></td><td>{money(i.amount)}</td>
                      <td><span className={`hx-badge ${i.status === 'Paid' ? 'joined' : i.status === 'Overdue' ? 'dropped' : 'inprocess'}`}>{i.status}</span></td><td><Day v={i.paidDay} est={false} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      <div className="hx-muted">As of {fmtDay(d.range.to)}.</div>
    </div>
  );
}
