import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { Card, Flash, Empty, useGet, useRun, day } from '../mktb/kit.jsx';

// ---------------------------------------------------------------------------
// CANDIDATE PAGE > Hiring tools (ATS wave 2 Y, backend /api/ats/y):
//   ProfileGraph   09.04 who-knows-whom from our own records (same employer, worked together, same college, referrals, our staff)
//   Contacts       09.06 e-mail / phone the person gave us elsewhere, then the provider's verified ones (not for the BDE team)
//   OutsideEnrich  03.12 the people-data provider's view: proposals for EMPTY fields only (OFF until the Admin switch + the account)
//   JobChanges     03.13 changes of employer / title seen for this person
//   Rsc            10.10 send this person and their steps to LinkedIn Recruiter (RSC; OFF by default)
// ---------------------------------------------------------------------------
const Y = '/ats/y';
const FIELD = { location: 'Location', currentCompany: 'Current company', currentDesignation: 'Designation', education: 'Education', experienceYears: 'Experience (years)', skills: 'Skills' };

// a small picture of the graph: the person in the middle, one spoke per group
function GraphPicture({ groups, name }) {
  const shown = groups.filter((g) => g.people.length);
  if (!shown.length) return null;
  const W = 320; const H = 170; const cx = W / 2; const cy = H / 2;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W }} role="img" aria-label={`Connections of ${name}`}>
      {shown.map((g, i) => {
        const a = (2 * Math.PI * i) / shown.length - Math.PI / 2; const x = cx + Math.cos(a) * 110; const y = cy + Math.sin(a) * 58;
        return (
          <g key={g.key}>
            <line x1={cx} y1={cy} x2={x} y2={y} stroke="currentColor" strokeOpacity="0.3" />
            <circle cx={x} cy={y} r={14 + Math.min(10, g.people.length)} fill="var(--accent, #1f6feb)" fillOpacity="0.15" stroke="var(--accent, #1f6feb)" />
            <text x={x} y={y + 4} textAnchor="middle" fontSize="11" fill="currentColor">{g.people.length}</text>
            <text x={x} y={y + 34 > H ? y - 22 : y + 30} textAnchor="middle" fontSize="9" fill="currentColor">{g.label.length > 26 ? `${g.label.slice(0, 24)}…` : g.label}</text>
          </g>
        );
      })}
      <circle cx={cx} cy={cy} r="16" fill="var(--accent, #1f6feb)" /><text x={cx} y={cy + 4} textAnchor="middle" fontSize="10" fill="#fff">them</text>
    </svg>
  );
}
function ProfileGraph({ c }) {
  const g = useGet(`${Y}/candidates/${c.id}/graph`);
  const d = g.data;
  return (
    <Card title="Who knows whom" testid="atsy-graph" note={d ? d.note : 'From TeamLink\'s own records.'}>
      {g.loading && <Empty>Loading…</Empty>}
      {g.error && <div className="notice">{g.error}</div>}
      {d && !d.total && <Empty>No connections in our records yet.</Empty>}
      {d && d.total > 0 && <GraphPicture groups={d.groups} name={c.name} />}
      {d && d.groups.map((grp) => (
        <div key={grp.key}>
          <b>{grp.label}</b>
          <ul className="mkb-list">{grp.people.map((p) => <li key={p.id || p.staffId || p.name}>{p.id ? <Link to={`/candidates/${p.id}`}>{p.name}</Link> : <span>{p.name}</span>}<span className="mkb-grow small-muted">{[p.currentDesignation, p.why].filter(Boolean).join(' · ')}</span></li>)}</ul>
        </div>
      ))}
      {d && d.hiddenOutsideScope > 0 && <div className="small-muted">{`${d.hiddenOutsideScope} more connection(s) outside your own view.`}</div>}
    </Card>
  );
}
function Contacts({ c, may }) {
  const [outside, setOutside] = useState(false);
  const f = useGet(`${Y}/candidates/${c.id}/contacts${outside ? '?outside=1' : ''}`);
  const { busy, msg, run } = useRun();
  const d = f.data;
  return (
    <Card title="Find contact details" testid="atsy-contacts" note="Our own records first: the person's resume, another record of the same person, messages already sent. Then, if an Admin has it on, the people-data provider's verified details.">
      {f.loading && <Empty>Looking…</Empty>}
      {f.error && <div className="notice">{f.error}</div>}
      {d && !d.found.length && <Empty>Nothing new found.</Empty>}
      {d && (
        <ul className="mkb-list">
          {d.found.map((x) => (
            <li key={`${x.kind}${x.value}`}>
              <b>{x.kind === 'email' ? 'E-mail' : 'Phone'}</b><span className="mkb-grow">{x.value}<div className="small-muted">{`from ${x.from}`}</div></span>
              {x.verified && <span className="mkb-chip good">verified</span>}
              {may.edit && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${Y}/candidates/${c.id}/contacts`, { kind: x.kind, value: x.value }), 'Saved on the profile.').then((r) => r && f.reload())}>Save</button>}
            </li>
          ))}
        </ul>
      )}
      {d && d.outsideError && <div className="small-muted">{d.outsideError}</div>}
      {d && !outside && <button type="button" className="mkb-link" disabled={!d.outside.switchOn || !d.outside.ready} title={d.outside.switchOn ? (d.outside.hint || '') : 'Switched off by the Admin'} onClick={() => setOutside(true)}>{d.outside.switchOn && d.outside.ready ? 'Also ask the people-data provider' : 'Outside look-up: not available (Admin switch / provider account)'}</button>}
      <Flash msg={msg} />
    </Card>
  );
}
function OutsideEnrich({ c, onChanged }) {
  const [d, setD] = useState(null);
  const [pick, setPick] = useState({});
  const { busy, msg, run } = useRun();
  return (
    <Card title="Fill gaps from an outside source" testid="atsy-enrich" note="The people-data provider's view of this person: only EMPTY fields are proposed, nothing is saved until you press Save. A different employer there becomes a job change to look at.">
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${Y}/candidates/${c.id}/enrich-outside`), (r) => `${r.data.proposals.length} proposal(s) from ${r.data.provider}.`).then((r) => r && setD(r.data))}>Look this person up</button>
      {d && (
        <>
          {!d.proposals.length && <Empty>Nothing to fill.</Empty>}
          <ul className="mkb-list">{d.proposals.map((p) => <li key={p.field}><label className="mkb-row"><input type="checkbox" checked={pick[p.field] !== false} onChange={(e) => setPick({ ...pick, [p.field]: e.target.checked })} /> <b>{FIELD[p.field] || p.field}</b></label><span className="mkb-grow">{String(p.value)}</span><span className="small-muted">{p.from}</span></li>)}</ul>
          {d.jobChange && <div className="small-muted">{`Seen there at ${d.jobChange.toCompany || '-'}${d.jobChange.toTitle ? ` as ${d.jobChange.toTitle}` : ''}: added to Records to refresh > Job changes.`}</div>}
          {d.proposals.length > 0 && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.post(`${Y}/candidates/${c.id}/enrich-outside/apply`, { provider: d.provider, fields: Object.fromEntries(d.proposals.filter((p) => pick[p.field] !== false).map((p) => [p.field, p.value])) }), 'Saved on the profile.').then((r) => { if (r) { setD(null); onChanged(); } })}>Save the ticked ones</button>}
        </>
      )}
      <Flash msg={msg} />
    </Card>
  );
}
function JobChanges({ c }) {
  const j = useGet(`${Y}/candidates/${c.id}/job-changes`);
  const rows = (j.data && j.data.rows) || [];
  if (!rows.length) return null;
  return (
    <Card title="Job changes seen" note="Employer / title changes from the person's own update, a new application, the career history or a connected source. Apply them in Candidates > Hiring tools > Records to refresh.">
      <ul className="mkb-list">{rows.map((r) => <li key={r.id}><span className="mkb-grow">{`${r.fromCompany || '-'} → ${r.toCompany || '-'}${r.toTitle ? ` (${r.toTitle})` : ''}`}<div className="small-muted">{`${r.source} · ${day(r.seenAt)}`}</div></span><span className={`mkb-chip ${r.status === 'New' ? 'new' : 'good'}`}>{r.status}</span></li>)}</ul>
    </Card>
  );
}
function Rsc({ c }) {
  const s = useGet(`${Y}/rsc`);
  const { busy, msg, run } = useRun();
  if (!s.data || (!s.data.ready && !s.data.switchOn)) return null;
  return (
    <Card title="LinkedIn Recruiter (RSC)" note="Shows this person and where each application stands inside LinkedIn Recruiter.">
      <button type="button" className="btn btn-sm" disabled={busy || !s.data.ready || !s.data.switchOn} onClick={() => run(() => api.post(`${Y}/rsc/candidates/${c.id}`), (r) => `Sent to LinkedIn (${r.data.applications} application(s)).`)}>Send to LinkedIn Recruiter</button>
      {!s.data.switchOn && <span className="small-muted"> Switched off by the Admin.</span>}
      <Flash msg={msg} />
    </Card>
  );
}

export default function CandidateSourcingY({ c, may, onChanged = () => {} }) {
  if (!c) return null;
  return (
    <div data-testid="atsy-cand">
      <ProfileGraph c={c} />
      {!may.bde && <Contacts c={c} may={may} />}
      {!may.bde && may.edit && <OutsideEnrich c={c} onChanged={onChanged} />}
      <JobChanges c={c} />
      {!may.bde && may.edit && <Rsc c={c} />}
    </div>
  );
}
