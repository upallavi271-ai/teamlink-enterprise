import { useState } from 'react';
import api from '../../api';
import {
  M, Card, Chips, Flash, FlagAi, Empty, useGet, useRun, day, when, downloadPdf,
} from './kit.jsx';
import CandidateSourcingY from '../atsY/CandidateSourcingY.jsx'; // ATS wave 2 Y: who knows whom, contact finding, outside enrichment, job changes, RSC

// ---------------------------------------------------------------------------
// CANDIDATE PAGE > More > Hiring tools (market wave B): the client resume PDF (03.15 / 09.12), submission notes + packet per
// application (04.06 / 04.05), screening answers from a call (02.10), the profile-update link (03.17), enrichment from the
// person's own resume (03.12), custom fields read from the resume (03.05), talent pools (03.10), fraud flags (03.20),
// profile reviews (03.21) and the risk after joining (09.20). BDE: no update link / enrichment (the server refuses too).
// ---------------------------------------------------------------------------
const FIELD = { location: 'Location', currentCompany: 'Current company', currentDesignation: 'Designation', education: 'Education', experienceYears: 'Experience (years)', noticePeriod: 'Notice period', skills: 'Skills' };

function ClientResume({ c }) {
  const { busy, msg, run } = useRun();
  const [hideName, setHideName] = useState(false);
  return (
    <Card title="Client resume (branded PDF)" note="Your company's header, a summary, skills, experience and education. Phone, e-mail and address are never on it.">
      <label className="mkb-row small-muted"><input type="checkbox" checked={hideName} onChange={(e) => setHideName(e.target.checked)} /> Hide the name too (show a reference number)</label>
      <div className="mkb-row">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => downloadPdf(`${M}/candidates/${c.id}/client-resume.pdf?ai=0&name=${hideName ? 0 : 1}`, `Profile-${c.id.slice(-6)}.pdf`), 'Downloaded.')}>Download</button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => downloadPdf(`${M}/candidates/${c.id}/client-resume.pdf?ai=1&name=${hideName ? 0 : 1}`, `Profile-${c.id.slice(-6)}.pdf`), 'Downloaded (the summary is written by the AI when it answers).')}>Download with an AI summary</button>
        <FlagAi feature="AI resume formatting" refType="Candidate" refId={c.id} output="client resume summary" />
      </div>
      <Flash msg={msg} />
    </Card>
  );
}

function Pitch({ app, onChanged, may }) {
  const [edit, setEdit] = useState('');
  const { busy, msg, run } = useRun();
  const draft = (app.pitches || []).find((p) => p.status === 'Draft');
  const approved = (app.pitches || []).find((p) => p.status === 'Approved');
  return (
    <div className="mkb-q">
      <div className="mkb-row"><b>{app.title}</b><span className="small-muted">{app.client || ''}</span></div>
      {approved && <><div className="small-muted">{`Approved note (${approved.approvedByName}, ${when(approved.approvedAt)})`}</div><div className="mkb-pre">{approved.text}</div></>}
      {draft && (
        <>
          <div className="small-muted">{`Draft by ${draft.source === 'ai' ? 'the AI' : 'the rules'} - a person must approve it`}</div>
          <textarea rows={6} style={{ width: '100%' }} value={edit || draft.text} onChange={(e) => setEdit(e.target.value)} aria-label="Submission note" disabled={!may.edit} />
          {may.edit && (
            <div className="mkb-row">
              <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.post(`${M}/pitches/${draft.id}`, { decision: 'Approved', text: edit || draft.text }), 'Approved.').then((r) => { if (r) { setEdit(''); onChanged(); } })}>Approve</button>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${M}/pitches/${draft.id}`, { decision: 'Rejected' }), 'Rejected.').then((r) => r && onChanged())}>Reject</button>
              <FlagAi feature="Submission note" refType="Pitch" refId={draft.id} output={draft.text} />
            </div>
          )}
        </>
      )}
      <div className="mkb-row">
        {may.edit && !draft && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${M}/applications/${app.id}/pitch`, { useAi: true }), (r) => `Drafted (${r.data.source === 'ai' ? 'AI' : 'rules'}). Check and approve it.`).then((r) => r && onChanged())}>Draft a submission note</button>}
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => downloadPdf(`${M}/applications/${app.id}/packet.pdf`, `Submission-${app.id.slice(-6)}.pdf`), approved ? 'Packet downloaded.' : 'Packet downloaded (the note in it is marked Draft until approved).')}>Client submission packet (PDF)</button>
      </div>
      {app.screening && (
        <div className="small-muted">
          {`Screening (${app.screening.source}): `}
          {app.screening.failed.length ? <span className="mkb-chip bad">{`Failed: ${app.screening.failed.map((f) => `${f.text} "${f.answer}"`).join('; ')}`}</span> : <span className="mkb-chip good">Passed</span>}
        </div>
      )}
      <ScreeningAnswers app={app} onChanged={onChanged} may={may} />
      <Flash msg={msg} />
    </div>
  );
}

function ScreeningAnswers({ app, onChanged, may }) {
  const [open, setOpen] = useState(false);
  const [vals, setVals] = useState({});
  const job = useGet(open && app.requirementId ? `${M}/jobs/${app.requirementId}/overview` : null);
  const { busy, msg, run } = useRun();
  if (!may.edit) return null;
  if (!open) return <button type="button" className="mkb-link" onClick={() => setOpen(true)}>Record screening answers from a call</button>;
  const qs = (job.data && job.data.screening && job.data.screening.questions) || [];
  return (
    <div>
      {!qs.length && <Empty>{job.loading ? 'Loading…' : 'This requirement has no screening questions (add them on the requirement > Hiring tools).'}</Empty>}
      {qs.map((qq) => (
        <div className="mkb-row" key={qq.id}>
          <span className="mkb-grow">{qq.text}</span>
          {qq.type === 'yesno' ? <select value={vals[qq.id] || ''} onChange={(e) => setVals({ ...vals, [qq.id]: e.target.value })} aria-label={qq.text}><option value="">-</option><option value="yes">Yes</option><option value="no">No</option></select>
            : qq.type === 'choice' ? <select value={vals[qq.id] || ''} onChange={(e) => setVals({ ...vals, [qq.id]: e.target.value })} aria-label={qq.text}><option value="">-</option>{qq.options.map((o) => <option key={o}>{o}</option>)}</select>
              : <input value={vals[qq.id] || ''} onChange={(e) => setVals({ ...vals, [qq.id]: e.target.value })} aria-label={qq.text} />}
        </div>
      ))}
      {qs.length > 0 && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${M}/applications/${app.id}/screening`, { answers: vals }), (r) => (r.data.failed.length ? `Saved: ${r.data.failed.length} knockout answer(s)${r.data.held ? ', put On hold' : ''}.` : 'Saved: passed.')).then((r) => { if (r) { setOpen(false); onChanged(); } })}>Save answers</button>}
      <Flash msg={msg} />
    </div>
  );
}

function UpdateLink({ c, links }) {
  const [link, setLink] = useState(null);
  const { busy, msg, run } = useRun();
  const wa = link ? `https://wa.me/?text=${encodeURIComponent(`Hello, please check and update your details for TeamLink here: ${link.url}`)}` : null;
  return (
    <Card title="Ask the person to update their profile" note="A private link (works once, ends in 14 days). You send it yourself; nothing goes out automatically. A job change they report is shown to the recruiters.">
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${M}/candidates/${c.id}/update-link`)).then((r) => r && setLink(r.data))}>Make an update link</button>
      {link && (
        <div className="mkb-row">
          <input className="mkb-grow" readOnly value={link.url} aria-label="Update link" onFocus={(e) => e.target.select()} />
          <button type="button" className="btn btn-sm" onClick={() => navigator.clipboard && navigator.clipboard.writeText(link.url)}>Copy</button>
          <a className="btn btn-sm" href={wa} target="_blank" rel="noreferrer">Share on WhatsApp</a>
        </div>
      )}
      {links.length > 0 && <div className="small-muted">{links.map((l) => `${day(l.createdAt)} by ${l.createdByName}: ${l.usedAt ? `used ${day(l.usedAt)}` : (new Date(l.expiresAt) < new Date() ? 'ended' : 'not used yet')}`).join(' · ')}</div>}
      <Flash msg={msg} />
    </Card>
  );
}

function Enrich({ c, onChanged }) {
  const e = useGet(`${M}/candidates/${c.id}/enrich`);
  const [pick, setPick] = useState({});
  const { busy, msg, run } = useRun();
  const rows = (e.data && e.data.proposals) || [];
  return (
    <Card title="Fill gaps from the person's own resume" note="Only the resume on file and the person's own updates are used. Nothing is looked up outside.">
      {e.loading && <Empty>Loading…</Empty>}
      {!e.loading && !rows.length && <Empty>Nothing to fill.</Empty>}
      <ul className="mkb-list">
        {rows.map((p) => (
          <li key={p.field}>
            <label className="mkb-row"><input type="checkbox" checked={pick[p.field] !== false} onChange={(ev) => setPick({ ...pick, [p.field]: ev.target.checked })} /> <b>{FIELD[p.field] || p.field}</b></label>
            <span className="mkb-grow">{String(p.value)}</span>
            <span className="small-muted">{`from ${p.from}`}</span>
          </li>
        ))}
      </ul>
      {e.data && e.data.links && e.data.links.length > 0 && <div className="small-muted">{`Links in the resume: ${e.data.links.join(', ')}`}</div>}
      {rows.length > 0 && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.post(`${M}/candidates/${c.id}/enrich`, { fields: Object.fromEntries(rows.filter((p) => pick[p.field] !== false).map((p) => [p.field, p.value])) }), 'Saved on the profile.').then((r) => { if (r) { e.reload(); onChanged(); } })}>Fill the ticked ones</button>}
      <Flash msg={msg} />
    </Card>
  );
}

function CustomFields({ c }) {
  const p = useGet(`${M}/candidates/${c.id}/parse-fields?ai=1`);
  const { busy, msg, run } = useRun();
  const rows = (p.data && p.data.proposals) || [];
  if (!p.loading && !rows.length) return null;
  return (
    <Card title="Custom fields read from the resume" note="The field-parsing rules (Administration > AI governance) read these from the resume. Check before saving.">
      <ul className="mkb-list">{rows.map((r) => <li key={r.fieldId}><b>{r.label}</b><span className="mkb-grow">{r.value}</span><span className="small-muted">{r.current ? `now: ${r.current}` : 'empty now'}</span></li>)}</ul>
      <button type="button" className="btn btn-sm" disabled={busy || !rows.length} onClick={() => run(() => api.post(`${M}/candidates/${c.id}/parse-fields/apply`, { values: Object.fromEntries(rows.map((r) => [r.fieldId, r.value])) }), 'Saved.').then((r) => r && p.reload())}>Save them</button>
      <Flash msg={msg} />
    </Card>
  );
}

function Pools({ c, inPools }) {
  const list = useGet(`${M}/pools`);
  const [pick, setPick] = useState('');
  const { busy, msg, run } = useRun();
  const mine = ((list.data && list.data.rows) || []).filter((p) => !inPools.some((x) => x.id === p.id));
  return (
    <Card title="Talent pools" note="Named lists of people to come back to (Candidates > Hiring tools > Talent pools).">
      <div className="mkb-row">{inPools.length ? inPools.map((p) => <span key={p.id} className="mkb-chip">{p.name}</span>) : <span className="small-muted">In no pool.</span>}</div>
      {mine.length > 0 && (
        <div className="mkb-row">
          <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Pool"><option value="">Pick a pool</option>{mine.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <button type="button" className="btn btn-sm" disabled={busy || !pick} onClick={() => run(() => api.post(`${M}/pools/${pick}/members`, { candidateIds: [c.id] }), 'Added to the pool.')}>Add</button>
        </div>
      )}
      <Flash msg={msg} />
    </Card>
  );
}

export default function CandidateTools({ candidateId, onChanged = () => {} }) {
  const ov = useGet(`${M}/candidates/${candidateId}/overview`);
  if (ov.error) return <div className="notice">{ov.error}</div>;
  if (!ov.data) return <div className="small-muted">Loading…</div>;
  const d = ov.data;
  const c = d.candidate;
  const changed = () => { ov.reload(); onChanged(); };
  return (
    <div data-testid="mkb-cand-tools">
      {d.fraud.length > 0 && (
        <Card title="Checks to look at" note="Signals only: nothing was decided. A team lead clears or confirms them in Candidates > Hiring tools > Review queue.">
          <ul className="mkb-list">{d.fraud.map((f) => <li key={f.id}><span className="mkb-chip bad">{f.kind}</span><span className="mkb-grow">{f.detail}</span></li>)}</ul>
        </Card>
      )}
      {d.risk && (
        <Card title="Risk of leaving (inside the guarantee)" note="A score from facts only, never name, gender or age.">
          <div className="mkb-row"><span className={`mkb-score ${d.risk.level}`}>{`${d.risk.level} (${d.risk.score})`}</span><span className="small-muted">{`${d.risk.requirement} · joined ${day(d.risk.joined)}`}</span></div>
          <Chips items={d.risk.factors.map((f) => ({ key: f.factor, label: f.factor, value: f.detail }))} />
        </Card>
      )}
      <ClientResume c={c} />
      <Card title="Submission notes and packets" note="The AI (or the rules) drafts a note to the client for each requirement; a person approves it before it goes in the packet. Nothing is sent from here.">
        {!d.applications.length && <Empty>No applications.</Empty>}
        {d.applications.map((a) => <Pitch key={a.id} app={a} onChanged={changed} may={d.may} />)}
      </Card>
      {!d.may.bde && d.may.edit && <UpdateLink c={c} links={d.links} />}
      {!d.may.bde && d.may.edit && <Enrich c={c} onChanged={changed} />}
      {!d.may.bde && d.may.edit && <CustomFields c={c} />}
      {d.may.edit && <Pools c={c} inPools={d.pools} />}
      <CandidateSourcingY c={c} may={d.may} onChanged={changed} />
      {d.reviews.length > 0 && (
        <Card title="Profile reviews">
          <ul className="mkb-list">{d.reviews.map((r) => <li key={r.id}><span className={`mkb-score ${r.verdict === 'Not a fit' ? 'bad' : 'good'}`}>{`${r.verdict} ${r.score}%`}</span><span className="mkb-grow">{r.summary}</span><span className="small-muted">{`${r.byName} · ${day(r.at)}`}</span></li>)}</ul>
        </Card>
      )}
    </div>
  );
}
