import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { JobPickerCombo } from '../JobPicker.jsx';
import { Card, Flash, Empty, useGet, useRun, day, when } from '../mktb/kit.jsx';

// ---------------------------------------------------------------------------
// CANDIDATES > Hiring tools (ATS wave 2 Y, backend /api/ats/y):
//   OutsideSearchY  "Outside search": Naukri Resdex (10.08 / IN-02) and the people-data provider (09.04), each brought onto a requirement
//   JobChangesY     inside "Records to refresh": every employer / title change seen (03.13), Apply / Dismiss, Check now (leads)
// ---------------------------------------------------------------------------
const Y = '/ats/y';

function Resdex() {
  const st = useGet(`${Y}/resdex/status`);
  const [f, setF] = useState({ keywords: '', location: '', minExperience: '', maxExperience: '', maxNoticeDays: '' });
  const [job, setJob] = useState('');
  const [res, setRes] = useState(null);
  const { busy, msg, run } = useRun();
  const s = st.data;
  const bring = (p) => run(() => api.post(`${Y}/resdex/import`, { resdexId: p.id, requirementId: job }), (r) => {
    const a = r.data.application;
    return `${r.data.duplicate ? 'Already in TeamLink' : 'Brought in'} (${r.data.how})${r.data.resumeSaved ? ', CV saved' : ''}.${a ? (a.ok ? ' Added to the requirement.' : ` Not added to the requirement: ${a.error}`) : ''}`;
  }).then((r) => r && setRes((x) => (x ? { ...x, profiles: x.profiles.map((y) => (y.id === p.id ? { ...y, inTeamLink: r.data.candidateId } : y)) } : x)));
  return (
    <Card title="Naukri Resdex" testid="atsy-resdex" note="Search Naukri's CV database from here. Contact details come only when you bring a person in (one Resdex download, logged); a person already in TeamLink is never downloaded again.">
      {s && !s.ready && <div className="notice">{s.hint}</div>}
      {s && s.ready && <div className="small-muted">{`Downloads today: ${s.usedToday} of ${s.dailyLimit}`}</div>}
      <div className="mkb-row" style={{ flexWrap: 'wrap' }}>
        <input placeholder="Skills / job title" value={f.keywords} onChange={(e) => setF({ ...f, keywords: e.target.value })} aria-label="Skills or job title" />
        <input placeholder="City" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} aria-label="City" style={{ width: 120 }} />
        <input type="number" min="0" placeholder="Min yrs" value={f.minExperience} onChange={(e) => setF({ ...f, minExperience: e.target.value })} aria-label="Minimum years" style={{ width: 80 }} />
        <input type="number" min="0" placeholder="Max yrs" value={f.maxExperience} onChange={(e) => setF({ ...f, maxExperience: e.target.value })} aria-label="Maximum years" style={{ width: 80 }} />
        <input type="number" min="0" placeholder="Notice ≤ days" value={f.maxNoticeDays} onChange={(e) => setF({ ...f, maxNoticeDays: e.target.value })} aria-label="Notice days at most" style={{ width: 110 }} />
        <button type="button" className="btn btn-sm btn-primary" disabled={busy || !f.keywords.trim() || (s && !s.ready)} onClick={() => run(() => api.post(`${Y}/resdex/search`, f), (r) => `${r.data.total} found.`).then((r) => r && setRes(r.data))}>Search Resdex</button>
      </div>
      {res && (
        <>
          <JobPickerCombo value={job} onChange={(e) => setJob(e.target.value)} blank="Bring them onto a requirement…" />
          {!res.profiles.length && <Empty>Nobody found.</Empty>}
          <ul className="mkb-list">
            {res.profiles.map((p) => (
              <li key={p.id}>
                <span className="mkb-grow"><b>{p.name}</b><div className="small-muted">{[p.title, p.company, p.experienceYears != null ? `${p.experienceYears} yrs` : null, p.location, p.noticePeriod, p.skills].filter(Boolean).join(' · ')}</div></span>
                {p.inTeamLink ? <Link className="mkb-chip good" to={`/candidates/${p.inTeamLink}`}>In TeamLink</Link> : null}
                <button type="button" className="btn btn-sm" disabled={busy || !job} title={job ? '' : 'Pick the requirement first'} onClick={() => bring(p)}>{p.inTeamLink ? 'Add to requirement' : 'Bring in with CV'}</button>
              </li>
            ))}
          </ul>
        </>
      )}
      <Flash msg={msg} />
    </Card>
  );
}

function People() {
  const [f, setF] = useState({ query: '', title: '', location: '', skills: '' });
  const [job, setJob] = useState('');
  const [why, setWhy] = useState('');
  const [res, setRes] = useState(null);
  const [needWhy, setNeedWhy] = useState(null);
  const { busy, msg, run } = useRun();
  const add = (p, reason) => run(() => api.post(`${Y}/outside/add`, { person: { ...p, provider: res.provider }, requirementId: job, overrideReason: reason || undefined }), (r) => (r.data.application.ok ? 'Added to the requirement.' : `Saved, not yet on the requirement: ${r.data.application.error}`)).then((r) => { if (r && r.data.application.needsReason) setNeedWhy(p); else setNeedWhy(null); });
  return (
    <Card title="Outside profiles (people-data provider)" testid="atsy-people" note="Search a licensed people-data provider (needs the founder's account and the Admin switch). The person is added without contact details; find them later on their Hiring tools tab.">
      <div className="mkb-row" style={{ flexWrap: 'wrap' }}>
        <input placeholder="What to look for" value={f.query} onChange={(e) => setF({ ...f, query: e.target.value })} aria-label="Search words" />
        <input placeholder="Job title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} aria-label="Job title" style={{ width: 140 }} />
        <input placeholder="City" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} aria-label="City" style={{ width: 110 }} />
        <input placeholder="Skills, comma separated" value={f.skills} onChange={(e) => setF({ ...f, skills: e.target.value })} aria-label="Skills" />
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${Y}/outside/search`, f), (r) => `${r.data.people.length} found at ${r.data.provider}.`).then((r) => r && setRes(r.data))}>Search outside</button>
      </div>
      {res && (
        <>
          <JobPickerCombo value={job} onChange={(e) => setJob(e.target.value)} blank="Add them to a requirement…" />
          <ul className="mkb-list">
            {res.people.map((p) => (
              <li key={p.id || p.profileUrl || p.name}>
                <span className="mkb-grow"><b>{p.name}</b><div className="small-muted">{[p.title, p.company, p.location, (p.skills || []).join(', ')].filter(Boolean).join(' · ')}</div>{p.profileUrl && <a href={p.profileUrl} target="_blank" rel="noreferrer" className="small-muted">profile</a>}</span>
                {p.inTeamLink && <Link className="mkb-chip good" to={`/candidates/${p.inTeamLink}`}>In TeamLink</Link>}
                <button type="button" className="btn btn-sm" disabled={busy || !job} onClick={() => add(p)}>Add</button>
              </li>
            ))}
          </ul>
          {needWhy && (
            <div className="mkb-row">
              <input placeholder="Why add them anyway?" value={why} onChange={(e) => setWhy(e.target.value)} aria-label="Reason" style={{ flex: 1 }} />
              <button type="button" className="btn btn-sm" disabled={busy || why.trim().length < 5} onClick={() => add(needWhy, why)}>Add with this reason</button>
            </div>
          )}
        </>
      )}
      <Flash msg={msg} />
    </Card>
  );
}

export function OutsideSearchY() {
  return <div data-testid="atsy-outside"><Resdex /><People /></div>;
}

export function JobChangesY() {
  const [status, setStatus] = useState('New');
  const j = useGet(`${Y}/job-changes?status=${status}`);
  const { busy, msg, run } = useRun();
  const rows = (j.data && j.data.rows) || [];
  return (
    <Card title="Job changes seen" testid="atsy-jobchanges" note={`Employer / title changes from the person's own update, a new application, their career history or a connected source. Apply puts the new employer and title on the profile with a note.${j.data && !j.data.alerts ? ' Bells to recruiters are OFF (Admin switch).' : ''}`}
      right={<span className="mkb-row"><select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Which"><option value="New">To look at</option><option value="Applied">Applied</option><option value="Dismissed">Dismissed</option><option value="all">All</option></select>
        <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => run(() => api.post(`${Y}/job-changes/scan`), (r) => `Checked: ${r.data.found} new.`).then(j.reload)}>Check now</button></span>}>
      {!rows.length && <Empty>{j.loading ? 'Loading…' : 'None.'}</Empty>}
      <ul className="mkb-list">
        {rows.map((r) => (
          <li key={r.id}>
            <Link to={`/candidates/${r.candidateId}?tab=tools`}>{r.name}</Link>
            <span className="mkb-grow small-muted">{`${r.fromCompany || '-'}${r.fromTitle ? ` (${r.fromTitle})` : ''} → ${r.toCompany || '-'}${r.toTitle ? ` (${r.toTitle})` : ''} · ${r.source} · ${day(r.seenAt)}`}</span>
            {r.status === 'New'
              ? <><button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${Y}/job-changes/${r.id}`, { decision: 'apply' }), 'Applied to the profile.').then(j.reload)}>Apply</button>
                <button type="button" className="mkb-link" disabled={busy} onClick={() => run(() => api.post(`${Y}/job-changes/${r.id}`, { decision: 'dismiss' }), 'Dismissed.').then(j.reload)}>Dismiss</button></>
              : <span className="small-muted">{`${r.status}${r.decidedBy ? ` by ${r.decidedBy} ${when(r.decidedAt)}` : ''}`}</span>}
          </li>
        ))}
      </ul>
      <Flash msg={msg} />
    </Card>
  );
}
