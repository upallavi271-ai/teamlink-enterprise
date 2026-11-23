import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import TabStrip from '../ui/TabStrip.jsx';
import '../interviews/interviewTools.css';
import AutoScreenTab from './AutoScreenTab.jsx'; // auto-screen new applications, OFF by default (2026-11-23)

// ---------------------------------------------------------------------------
// REQUIREMENT > KITS & TESTS (market wave 2026-11-21; server routes/mktInterviews.js + routes/mktComms.js)
//   Interview kit   the questions per round and how they are rated (07.09)
//   Apply form      extra questions on the job's apply form, "apply with LinkedIn", the candidate's own booking (10.03 / 10.10 / 07.03),
//                   and the job's public page in English / Telugu / Hindi (10.02)
//   Tests           MCQ / short-answer tests, a draft from the JD by AI (07.15 / 07.16)
//   SMS campaign    text this job to a talent pool (10.13)
// ---------------------------------------------------------------------------
const errOf = (e) => (e && e.response && e.response.data && e.response.data.error) || 'That did not work. Please try again.';
const SUB = [
  { key: 'kit', label: 'Interview kit', hint: 'The questions each round asks, and how they are rated.' },
  { key: 'form', label: 'Apply form & page', hint: 'Extra apply questions, LinkedIn apply, self-booking, and the public job page.' },
  { key: 'tests', label: 'Tests', hint: 'Short online tests for candidates, scored by TeamLink.' },
  { key: 'sms', label: 'SMS campaign', hint: 'Text this job to people in the talent pool.' },
  { key: 'screen', label: 'Auto-screen', hint: 'Check each new application against this job (off by default).' },
];

export default function JobKitsTab({ job }) {
  const [sub, setSub] = useState('kit');
  return (
    <div className="card section" data-testid="job-kits">
      <TabStrip small label="Kits and tests" tabs={SUB} value={sub} onChange={setSub} />
      {sub === 'kit' && <Kits job={job} />}
      {sub === 'form' && <FormSettings job={job} />}
      {sub === 'tests' && <Tests job={job} />}
      {sub === 'sms' && <SmsCampaign job={job} />}
      {sub === 'screen' && <AutoScreenTab job={job} />}
    </div>
  );
}

function Kits({ job }) {
  const [d, setD] = useState(null); const [edit, setEdit] = useState(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  const load = useCallback(() => api.get(`/ats/mkt/jobs/${job.id}/kits`).then((r) => setD(r.data)).catch((e) => setErr(errOf(e))), [job.id]);
  useEffect(() => { load(); }, [load]);
  if (!d) return err ? <div className="error-text">{err}</div> : <div className="small-muted">Loading…</div>;
  const setQ = (i, patch) => setEdit((k) => ({ ...k, questions: k.questions.map((q, n) => (n === i ? { ...q, ...patch } : q)) }));
  const run = async (fn) => { setErr(''); setMsg(''); try { await fn(); } catch (e) { setErr(errOf(e)); } };
  return (
    <div className="ivt-body">
      {!edit && d.kits.map((k) => (
        <div key={k.round} className="mkt-q">
          <div className="ivt-row"><b>Round {k.round}: {k.title}</b><span className="small-muted">{k.saved ? `saved by ${k.updatedBy}` : 'ready-made from the job skills'} · scale 1-{k.scale}</span>
            {d.canEdit && <button type="button" className="btn btn-sm" onClick={() => setEdit({ ...k })}>Edit</button>}</div>
          <ol style={{ margin: 0, paddingLeft: 18 }}>{k.questions.map((q, i) => <li key={i}>{q.text} <span className="small-muted">({q.type})</span></li>)}</ol>
        </div>
      ))}
      {!edit && d.canEdit && <button type="button" className="btn btn-sm" onClick={() => setEdit({ round: d.kits.length + 1, title: `Round ${d.kits.length + 1}`, scale: 5, questions: [{ text: '', type: 'rating' }] })}>+ Kit for round {d.kits.length + 1}</button>}
      {edit && (
        <div className="mkt-q">
          <div className="ivt-row">
            <b>Round {edit.round}</b>
            <input type="text" value={edit.title || ''} onChange={(e) => setEdit({ ...edit, title: e.target.value })} placeholder="Kit name" />
            <label className="small-muted">Scale <select value={edit.scale} onChange={(e) => setEdit({ ...edit, scale: Number(e.target.value) })}>{d.scales.map((s) => <option key={s} value={s}>1-{s}</option>)}</select></label>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => run(async () => { const r = await api.post(`/ats/mkt/jobs/${job.id}/kits/${edit.round}/suggest`, { roundType: edit.roundType }); setEdit({ ...edit, questions: r.data.kit.questions }); setMsg(`Draft: ${r.data.kit.source}. Check it, then Save.`); })}>✨ Suggest from the JD</button>
          </div>
          {edit.questions.map((q, i) => (
            <div key={i} className="ivt-row">
              <input type="text" value={q.text} placeholder={`Question ${i + 1}`} onChange={(e) => setQ(i, { text: e.target.value })} />
              <select value={q.type} onChange={(e) => setQ(i, { type: e.target.value })}>{d.types.map((t) => <option key={t} value={t}>{t === 'yesno' ? 'yes / no' : t}</option>)}</select>
              <input type="text" value={q.guidance || ''} placeholder="What a good answer shows" onChange={(e) => setQ(i, { guidance: e.target.value })} />
              <button type="button" className="btn btn-sm btn-ghost" aria-label="Remove question" onClick={() => setEdit({ ...edit, questions: edit.questions.filter((_, n) => n !== i) })}>✕</button>
            </div>
          ))}
          <div className="ivt-row">
            <button type="button" className="btn btn-sm" onClick={() => setEdit({ ...edit, questions: [...edit.questions, { text: '', type: 'rating' }] })}>+ Question</button>
            <textarea rows="2" value={edit.guide || ''} placeholder="A short guide for the interviewer (optional)" onChange={(e) => setEdit({ ...edit, guide: e.target.value })} />
          </div>
          <div className="ivt-row">
            <button type="button" className="btn btn-sm btn-primary" onClick={() => run(async () => { await api.put(`/ats/mkt/jobs/${job.id}/kits/${edit.round}`, edit); setEdit(null); setMsg('Kit saved.'); load(); })}>Save kit</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEdit(null)}>Cancel</button>
            {edit.saved && <button type="button" className="btn btn-sm btn-danger" onClick={() => run(async () => { await api.delete(`/ats/mkt/jobs/${job.id}/kits/${edit.round}`); setEdit(null); load(); })}>Use the ready-made kit again</button>}
          </div>
        </div>
      )}
      {msg && <div className="notice">{msg}</div>}{err && <div className="error-text">{err}</div>}
    </div>
  );
}

function FormSettings({ job }) {
  const [d, setD] = useState(null); const [fields, setFields] = useState([]); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  const load = useCallback(() => api.get(`/ats/mkt/jobs/${job.id}/settings`).then((r) => { setD(r.data); setFields(r.data.fields || []); }).catch((e) => setErr(errOf(e))), [job.id]);
  useEffect(() => { load(); }, [load]);
  if (!d) return err ? <div className="error-text">{err}</div> : <div className="small-muted">Loading…</div>;
  const save = async (patch) => { setErr(''); setMsg(''); try { const r = await api.put(`/ats/mkt/jobs/${job.id}/settings`, patch); setD({ ...d, ...r.data }); setFields(r.data.fields || []); setMsg('Saved.'); } catch (e) { setErr(errOf(e)); } };
  const setF = (i, patch) => setFields((l) => l.map((f, n) => (n === i ? { ...f, ...patch } : f)));
  const slug = job.slug || job.id;
  return (
    <div className="ivt-body">
      <div className="mkt-sec">
        <h3>Extra questions on the apply form</h3>
        <div className="small-muted">Asked on the TeamLink careers site after the usual details. A yes / no question can screen out ("knock-out") - the application still comes in, marked.</div>
        {fields.map((f, i) => (
          <div key={i} className="ivt-row">
            <input type="text" value={f.label} placeholder="The question" disabled={!d.canEdit} onChange={(e) => setF(i, { label: e.target.value })} />
            <select value={f.type} disabled={!d.canEdit} onChange={(e) => setF(i, { type: e.target.value })}>{d.fieldTypes.map((t) => <option key={t} value={t}>{t === 'yesno' ? 'yes / no' : t}</option>)}</select>
            {f.type === 'choice' && <input type="text" value={Array.isArray(f.options) ? f.options.join(', ') : (f.options || '')} placeholder="Choices, with commas" disabled={!d.canEdit} onChange={(e) => setF(i, { options: e.target.value })} />}
            {f.type === 'yesno' && <select value={f.knockout || ''} disabled={!d.canEdit} onChange={(e) => setF(i, { knockout: e.target.value || undefined })} aria-label="Knock-out answer"><option value="">no knock-out</option><option value="no">flag a "no"</option><option value="yes">flag a "yes"</option></select>}
            <label className="small-muted"><input type="checkbox" checked={!!f.required} disabled={!d.canEdit} onChange={(e) => setF(i, { required: e.target.checked })} /> required</label>
            {d.canEdit && <button type="button" className="btn btn-sm btn-ghost" aria-label="Remove" onClick={() => setFields(fields.filter((_, n) => n !== i))}>✕</button>}
          </div>
        ))}
        {d.canEdit && <div className="ivt-row"><button type="button" className="btn btn-sm" onClick={() => setFields([...fields, { label: '', type: 'text' }])}>+ Question</button><button type="button" className="btn btn-sm btn-primary" onClick={() => save({ fields })}>Save questions</button></div>}
      </div>
      <div className="mkt-sec">
        <h3>How people apply and book</h3>
        <label className="mkt-switch"><input type="checkbox" checked={d.linkedinApply} disabled={!d.canEdit} onChange={(e) => save({ linkedinApply: e.target.checked })} /><span><b>Apply with LinkedIn</b><br /><span className="small-muted">People may send their LinkedIn profile link instead of a resume.</span></span></label>
        <label className="mkt-switch"><input type="checkbox" checked={d.selfBook} disabled={!d.canEdit} onChange={(e) => save({ selfBook: e.target.checked })} /><span><b>Candidates may pick their own interview time</b><br /><span className="small-muted">From a link with a few free times. {d.selfSchedulingSwitch ? '' : 'Also needs the company switch (Admin, off now).'}</span></span></label>
      </div>
      <div className="mkt-sec">
        <h3>Public job page</h3>
        <div className="small-muted">For Google and phones: title, description, job markup, and the page text in three languages.</div>
        <div className="ivt-row">
          <a className="btn btn-sm" href={`/site/job/${encodeURIComponent(slug)}`} target="_blank" rel="noreferrer">Apply page</a>
          <a className="btn btn-sm" href={`/api/public/mkt/job/${encodeURIComponent(slug)}`} target="_blank" rel="noreferrer">English</a>
          <a className="btn btn-sm" href={`/api/public/mkt/job/${encodeURIComponent(slug)}?lang=te`} target="_blank" rel="noreferrer">తెలుగు</a>
          <a className="btn btn-sm" href={`/api/public/mkt/job/${encodeURIComponent(slug)}?lang=hi`} target="_blank" rel="noreferrer">हिन्दी</a>
        </div>
      </div>
      {msg && <div className="notice">{msg}</div>}{err && <div className="error-text">{err}</div>}
    </div>
  );
}

const blankQ = () => ({ type: 'mcq', text: '', options: ['', ''], answer: [0], points: 1 });
function Tests({ job }) {
  const [d, setD] = useState(null); const [edit, setEdit] = useState(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  const load = useCallback(() => api.get(`/ats/mkt/jobs/${job.id}/assessments`).then((r) => setD(r.data)).catch((e) => setErr(errOf(e))), [job.id]);
  useEffect(() => { load(); }, [load]);
  if (!d) return err ? <div className="error-text">{err}</div> : <div className="small-muted">Loading…</div>;
  const run = async (fn) => { setErr(''); setMsg(''); try { await fn(); } catch (e) { setErr(errOf(e)); } };
  const setQ = (i, patch) => setEdit((t) => ({ ...t, questions: t.questions.map((q, n) => (n === i ? { ...q, ...patch } : q)) }));
  return (
    <div className="ivt-body">
      {!d.switchOn && <div className="notice">Sending tests is switched off. You can build them now; an Admin turns sending on (Administration &gt; Step timing and alerts &gt; Add-on switches).</div>}
      {!edit && d.rows.map((t) => (
        <div key={t.id} className="mkt-q"><div className="ivt-row"><b>{t.title}</b><span className="small-muted">{t.questions.length} questions · {t.totalPoints} points · pass {t.passMark}% · {t.minutes} min · {t.source === 'ai' ? 'AI draft' : 'built'}{t.active ? '' : ' · off'}</span>
          {d.canEdit && <button type="button" className="btn btn-sm" onClick={() => setEdit({ ...t })}>Edit</button>}</div></div>
      ))}
      {!edit && !d.rows.length && <div className="small-muted">No tests for this job yet.</div>}
      {!edit && d.canEdit && (
        <div className="ivt-row">
          <button type="button" className="btn btn-sm" onClick={() => setEdit({ title: `${job.title} test`, passMark: 60, minutes: 20, questions: [blankQ()] })}>+ New test</button>
          <button type="button" className="btn btn-sm" onClick={() => run(async () => { const r = await api.post(`/ats/mkt/jobs/${job.id}/assessments/generate`, { count: 8 }); setEdit({ title: r.data.title, passMark: 60, minutes: 20, questions: r.data.questions, source: r.data.ai ? 'ai' : 'manual' }); setMsg(`Draft: ${r.data.source}`); })}>✨ Draft a test from the JD</button>
        </div>
      )}
      {edit && (
        <div className="mkt-q">
          <div className="ivt-row">
            <input type="text" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} aria-label="Test name" />
            <label className="small-muted">Pass % <input type="number" min="1" max="100" style={{ width: 60 }} value={edit.passMark} onChange={(e) => setEdit({ ...edit, passMark: e.target.value })} /></label>
            <label className="small-muted">Minutes <input type="number" min="5" max="180" style={{ width: 60 }} value={edit.minutes} onChange={(e) => setEdit({ ...edit, minutes: e.target.value })} /></label>
          </div>
          {edit.questions.map((q, i) => (
            <div key={i} className="mkt-q">
              <div className="ivt-row">
                <select value={q.type} onChange={(e) => setQ(i, e.target.value === 'short' ? { type: 'short', keywords: q.keywords || [] } : { type: e.target.value, options: q.options || ['', ''], answer: q.answer || [0] })}><option value="mcq">One answer</option><option value="multi">Several answers</option><option value="short">Written answer</option></select>
                <input type="text" value={q.text} placeholder={`Question ${i + 1}`} onChange={(e) => setQ(i, { text: e.target.value })} />
                <label className="small-muted">Points <input type="number" min="1" max="20" style={{ width: 52 }} value={q.points} onChange={(e) => setQ(i, { points: Number(e.target.value) })} /></label>
                <button type="button" className="btn btn-sm btn-ghost" aria-label="Remove question" onClick={() => setEdit({ ...edit, questions: edit.questions.filter((_, n) => n !== i) })}>✕</button>
              </div>
              {q.type === 'short' ? (
                <input type="text" value={Array.isArray(q.keywords) ? q.keywords.join(', ') : (q.keywords || '')} placeholder="Key words that earn the points, with commas" onChange={(e) => setQ(i, { keywords: e.target.value })} />
              ) : (
                <>{(q.options || []).map((o, n) => (
                  <div key={n} className="ivt-row">
                    <input type={q.type === 'mcq' ? 'radio' : 'checkbox'} name={`ans-${i}`} checked={(q.answer || []).includes(n)} aria-label="Right answer" onChange={(e) => setQ(i, { answer: q.type === 'mcq' ? [n] : (e.target.checked ? [...(q.answer || []), n] : (q.answer || []).filter((a) => a !== n)) })} />
                    <input type="text" value={o} placeholder={`Choice ${n + 1}`} onChange={(e) => setQ(i, { options: q.options.map((x, m) => (m === n ? e.target.value : x)) })} />
                  </div>
                ))}
                {(q.options || []).length < 6 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setQ(i, { options: [...q.options, ''] })}>+ Choice</button>}</>
              )}
            </div>
          ))}
          <div className="ivt-row">
            <button type="button" className="btn btn-sm" onClick={() => setEdit({ ...edit, questions: [...edit.questions, blankQ()] })}>+ Question</button>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => run(async () => { if (edit.id) await api.put(`/ats/mkt/assessments/${edit.id}`, edit); else await api.post(`/ats/mkt/jobs/${job.id}/assessments`, edit); setEdit(null); setMsg('Test saved. Send it from the candidate\'s Outreach tools tab.'); load(); })}>Save test</button>
            {edit.id && <button type="button" className="btn btn-sm" onClick={() => run(async () => { await api.put(`/ats/mkt/assessments/${edit.id}`, { ...edit, active: !edit.active }); setEdit(null); load(); })}>{edit.active ? 'Switch off' : 'Switch on'}</button>}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </div>
      )}
      {msg && <div className="notice">{msg}</div>}{err && <div className="error-text">{err}</div>}
    </div>
  );
}

function SmsCampaign({ job }) {
  const [f, setF] = useState({ skills: job.skills || '', location: job.location || '', minExp: '', maxExp: '', text: '', limit: 200 });
  const [plan, setPlan] = useState(null); const [rows, setRows] = useState([]); const [on, setOn] = useState(false); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  const load = useCallback(() => api.get(`/ats/mkt/jobs/${job.id}/sms-campaigns`).then((r) => { setRows(r.data.rows); setOn(r.data.switchOn); }).catch(() => null), [job.id]);
  useEffect(() => { load(); }, [load]);
  const run = async (fn) => { setErr(''); setMsg(''); try { await fn(); } catch (e) { setErr(errOf(e)); } };
  return (
    <div className="ivt-body">
      {!on && <div className="notice">SMS campaigns are switched off (an Admin turns them on). You can still see who would get it.</div>}
      <div className="small-muted">The talent pool: candidates in your scope with a mobile number, not already on this job, who never replied STOP. The job link and "Reply STOP to opt out" are added. SMS goes through the company's SMS account and its rules (DLT template, delivery-report check).</div>
      <div className="mkt-grid">
        <label className="field">Skills (any)<input type="text" value={f.skills} onChange={(e) => setF({ ...f, skills: e.target.value })} /></label>
        <label className="field">Location<input type="text" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></label>
        <label className="field">Experience from<input type="number" value={f.minExp} onChange={(e) => setF({ ...f, minExp: e.target.value })} /></label>
        <label className="field">to<input type="number" value={f.maxExp} onChange={(e) => setF({ ...f, maxExp: e.target.value })} /></label>
      </div>
      <textarea rows="2" maxLength="300" placeholder="Message (leave empty for the standard one). {{link}} is the job link." value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} />
      <div className="ivt-row">
        <button type="button" className="btn btn-sm" onClick={() => run(async () => { const r = await api.post(`/ats/mkt/jobs/${job.id}/sms-campaign/plan`, f); setPlan(r.data); })}>Who would get it?</button>
        {plan && on && plan.count > 0 && <button type="button" className="btn btn-sm btn-primary" onClick={() => run(async () => { if (!window.confirm(`Send this SMS to ${plan.count} people?`)) return; const r = await api.post(`/ats/mkt/jobs/${job.id}/sms-campaign`, f); setMsg(`Started for ${r.data.total} people.`); setTimeout(load, 2000); })}>Send to {plan.count}</button>}
      </div>
      {plan && <div className="notice">{plan.count} people{plan.optedOut ? `, ${plan.optedOut} left out (said STOP)` : ''}{plan.badNumber ? `, ${plan.badNumber} with a wrong number` : ''}. e.g. {plan.sample.join(', ') || '-'}<div className="small-muted">Text: {plan.text}</div></div>}
      {rows.map((c) => <div key={c.id} className="kv"><span className="k">{new Date(c.createdAt).toLocaleString('en-IN')} · {c.createdBy}</span><span>{c.status} · {c.sent} sent, {c.skipped} not sent, {c.failed} failed of {c.total}{c.note ? ` · ${c.note}` : ''}</span></div>)}
      {msg && <div className="notice">{msg}</div>}{err && <div className="error-text">{err}</div>}
    </div>
  );
}
