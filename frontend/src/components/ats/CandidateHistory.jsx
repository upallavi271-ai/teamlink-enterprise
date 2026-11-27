import { useEffect, useState } from 'react';
import useAtsLive from '../../utils/useAtsLive.js';
import { HLink } from '../search/historyOpen.jsx'; // a history link opens in the drawer
import { Link, useParams, useSearchParams } from 'react-router-dom';
import api from '../../api';
import ExportMenu from '../ExportMenu.jsx';
import { Day, fmtDay, num } from './HistoryParts.jsx';

// ---------------------------------------------------------------------------
// CANDIDATE HISTORY: the complete history of a person. Totals (applications, selected, rejected with reasons and by whom, offered, joined,
// dropped, withdrawn), every application with its dates, and ONE time-ordered timeline of everything (stage moves, interviews and feedback, calls,
// messages, notes, follow-ups, handovers, duplicate merges, documents by name, consent). GET /api/ats/history/candidate/:id.
// A login that may not read contacts / internal notes (a BDE) gets the limited view the server cuts for it.
// Used as a page (/ats/history/candidate/:id) and inside the candidate's History tab (embedded).
// ---------------------------------------------------------------------------
const NS = { cursor: 'default' };
const KIND = {
  sourced: 'Added', stage: 'Step', interview: 'Interview', feedback: 'Feedback', offer: 'Offer', joined: 'Joined', dropped: 'Dropped', message: 'Message', call: 'Call', followup: 'Follow-up', note: 'Note', handover: 'Handover', merge: 'Duplicate', document: 'Document', consent: 'Consent',
};

// A search result for an interview / offer / joining / follow-up / document opens this page scrolled to that event, highlighted (?focus=interview-<application>).
const FOCUS_OF = { interview: 'interview', feedback: 'interview', offer: 'offer', joined: 'joining', followup: 'followup', call: 'followup' };
const anchorOf = (e) => (e.kind === 'document' ? (e.refId ? `document-${e.refId}` : '') : (FOCUS_OF[e.kind] && e.applicationId ? `${FOCUS_OF[e.kind]}-${e.applicationId}` : ''));

export default function CandidateHistory({ candidateId, embedded = false }) {
  const params = useParams();
  const [sp] = useSearchParams();
  const focus = sp.get('focus') || '';
  const id = candidateId || params.id;
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [newest, setNewest] = useState(false);
  const [kind, setKind] = useState('');
  const live = useAtsLive(); // ATS data changed: load the numbers again (founder 2026-11-27)
  useEffect(() => {
    let live = true;
    setErr(''); setD(null);
    api.get(`/ats/history/candidate/${id}`)
      .then((r) => { if (live) setD(r.data); })
      .catch((e) => { if (live) setErr(e.response?.data?.error || 'The history could not be loaded.'); });
    return () => { live = false; };
  }, [live, id]);
  useEffect(() => {
    if (!d || !focus) return undefined;
    const t = setTimeout(() => {
      const hits = [...document.querySelectorAll('[data-hx]')].filter((el) => el.getAttribute('data-hx').split(' ').includes(focus));
      hits.forEach((el) => el.classList.add('hx-focus'));
      if (hits[0]) hits[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 150);
    return () => clearTimeout(t);
  }, [d, focus]);
  if (err && !d) return embedded ? <div className="small-muted">{err}</div> : <div><Link className="small-muted" to="/ats/search">← Search</Link><div className="notice red" style={{ marginTop: 8 }}><span>{err}</span></div></div>;
  if (!d) return <div className="small-muted">Loading the history…</div>;
  const c = d.candidate; const t = d.totals;
  const tiles = [['Applications', t.applications], ['Selected', t.selected], ['Rejected', t.rejected], ['Offered', t.offered], ['Joined (still working)', t.joined], ['Dropped', t.dropped], ['Withdrawn', t.withdrawn],
    ...(t.declinedOffer ? [['Declined the offer', t.declinedOffer]] : []), ...(t.didNotJoin ? [['Did not join', t.didNotJoin]] : []), ...(t.leftAfterJoining ? [['Left after joining', t.leftAfterJoining]] : [])];
  const kinds = [...new Set(d.timeline.map((e) => e.kind))];
  let tl = d.timeline.filter((e) => !kind || e.kind === kind);
  if (newest) tl = [...tl].reverse();
  const head = (k, v) => v !== null && v !== undefined && v !== '' && <div><span className="k">{k}</span>{v}</div>;
  return (
    <div className="hx-tab">
      {!embedded && <Link className="small-muted" to="/ats/search">← Search</Link>}
      <div className="hx-bar">
        <h3 style={{ margin: 0 }}>{embedded ? 'Complete history' : c.name}</h3><span style={{ flex: 1 }} />
        {d.canExport && <ExportMenu url={`/ats/history/candidate/${id}/export`} formats={['xlsx', 'csv']} label="Download Excel" />}
      </div>
      <div className="hx-head" style={{ marginTop: 8 }}>
        {head('Name', c.name)}{head('Candidate ID', c.code)}{head('Came on', c.cameOn ? fmtDay(c.cameOn) : null)}{head('Source', c.source)}{head('Phone', c.phone)}{head('Email', c.email)}
        {head('With', c.owners.length ? c.owners.join(', ') : null)}
        {c.consent && head('Consent', c.consent.status ? `${String(c.consent.status).replace(/_/g, ' ').toLowerCase()}${c.consent.at ? ` (${fmtDay(c.consent.at)})` : ''}` : 'Not recorded')}
      </div>
      {d.limited && <div className="hx-muted" style={{ marginBottom: 8 }}>Limited view: contact details, pay, documents and internal notes are not shown for your role.</div>}
      <div className="hx-tiles">
        {tiles.map(([l, n]) => (
          <div className={`hx-tile${l === 'Rejected' || l === 'Dropped' ? ' bad' : ''}${l.startsWith('Joined') ? ' good' : ''}`} key={l} style={{ cursor: 'default' }}>
            <b className="hx-n">{num(n)}</b><span className="hx-l">{l}</span>
          </div>
        ))}
      </div>
      {d.rejections.length > 0 && (
        <div className="hx-box" style={{ marginBottom: 12 }}>
          <h4>Rejections: {d.rejectedBy.map((r) => `${r.by} (${r.count})`).join(', ')}</h4>
          {d.rejections.map((r, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <div className="hx-line" key={i}><span>{r.requirement}: <b>{r.by}</b>{r.stageLabel ? ` at “${r.stageLabel}”` : ''}{r.reason ? ` — ${r.reason}` : ''}</span><span>{fmtDay(r.day)}</span></div>
          ))}
        </div>
      )}
      <div className="hx-sec">
        <h3>All applications ({d.applications.length})</h3>
        <div className="hx-scroll">
          <table className="hx-table" style={{ minWidth: 1000 }}>
            <thead>
              <tr>
                <th style={NS}>Requirement</th><th style={NS}>Recruiter / TL</th><th style={NS}>Applied</th><th style={NS}>Sent to client</th><th style={NS}>Interview</th>
                <th style={NS}>Selected</th><th style={NS}>Offer</th><th style={NS}>Joined</th><th style={NS}>Result</th>
              </tr>
            </thead>
            <tbody>
              {d.applications.map((x) => (
                <tr key={x.applicationId} data-hx={['interview', 'offer', 'joining', 'followup'].map((k) => `${k}-${x.applicationId}`).join(' ')}>
                  <td><HLink to={`/requirements/${x.requirementId}?tab=history`}>{x.requirement}</HLink><div className="hx-muted">{x.client}</div></td>
                  <td>{x.recruiterName || '—'}<div className="hx-muted">{x.tl || ''}</div></td>
                  <td><Day v={x.added} /></td><td><Day v={x.sent} /></td>
                  <td>{x.interviews.length ? x.interviews.map(fmtDay).join(', ') : '—'}{x.interviewResult ? <div className="hx-muted">{x.interviewResult}</div> : null}</td>
                  <td><Day v={x.selected} /></td><td><Day v={x.offer} /></td>
                  <td>{x.joinDay ? <Day v={x.joinDay} est={false} /> : '—'}</td>
                  <td className="hx-why">
                    <span className={`hx-badge ${x.outcome}`}>{x.outcome === 'joined' ? 'Joined' : x.outcome === 'dropped' ? 'Dropped' : x.outcome === 'selected' ? 'Selected' : 'In process'}</span>
                    {x.drop && <><div><b>{x.drop.typeLabel}</b> <Day v={x.drop.day} est={x.drop.estimated} /></div>{x.drop.reason && <div className="hx-muted">{x.drop.reason}</div>}</>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="hx-sec">
        <div className="hx-bar">
          <h3 style={{ margin: 0 }}>Everything, in time order ({tl.length})</h3><span style={{ flex: 1 }} />
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All kinds</option>
            {kinds.map((k) => <option key={k} value={k}>{KIND[k] || k}</option>)}
          </select>
          <button type="button" className="btn btn-sm" onClick={() => setNewest(!newest)}>{newest ? 'Newest first' : 'Oldest first'}</button>
        </div>
        <ul className="hx-time">
          {tl.map((e, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <li key={i} data-hx={anchorOf(e) || undefined}><span className="d">{fmtDay(e.day)}{e.est && <sup className="hx-est">est.</sup>}</span><span className="t"><span className="hx-badge inprocess" style={{ marginRight: 6 }}>{KIND[e.kind] || e.kind}</span>{e.text}</span></li>
          ))}
        </ul>
      </div>
    </div>
  );
}
