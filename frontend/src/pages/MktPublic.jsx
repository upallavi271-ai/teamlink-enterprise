import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import api from '../api';
import './interviewPrepPage.css';
import './mktPublic.css';

// ---------------------------------------------------------------------------
// THE NO-LOGIN PAGES OF THE MARKET WAVE (2026-11-21; server routes/mktPublic.js + routes/careersPublic.js)
//   /book/:token       the candidate picks an interview time from the recruiter's link (07.03)
//   /test/:token       the candidate takes a short test (07.15)
//   /site              the agency's careers site: banner, about, jobs, job alerts, contact (10.18 / 10.14), English / Telugu / Hindi
//   /site/job/:id      one job + the apply form: quick fill from the resume (10.04), the job's own questions (10.03),
//                      "apply with LinkedIn" instead of a resume (10.10)
// ---------------------------------------------------------------------------
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d || 'That did not work. Please try again.';
const when = (v) => new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

export function SelfBookPage() {
  const { token } = useParams();
  const [v, setV] = useState(null); const [err, setErr] = useState(''); const [pick, setPick] = useState(''); const [done, setDone] = useState(''); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { api.get(`/public/mkt/book/${token}`).then((r) => setV(r.data)).catch((e) => setErr(errOf(e, 'This link does not work. Ask your recruiter for a new one.'))); }, [token]);
  if (err && !v) return <div className="ipp"><div className="ipp-card"><h1>Pick your interview time</h1><p className="ipp-err">{err}</p></div></div>;
  if (!v) return <div className="ipp"><div className="ipp-card"><p>Loading…</p></div></div>;
  async function book() { setBusy(true); setErr(''); try { const r = await api.post(`/public/mkt/book/${token}`, { slot: pick }); setDone(`Booked: ${when(r.data.slot)}. You will get the details by email / message.`); } catch (e) { setErr(errOf(e)); } setBusy(false); }
  async function none() { setBusy(true); setErr(''); try { const r = await api.post(`/public/mkt/book/${token}/none`, { note }); setDone(r.data.message); } catch (e) { setErr(errOf(e)); } setBusy(false); }
  return (
    <div className="ipp"><div className="ipp-card">
      <div className="ipp-brand">TeamLink</div>
      <h1>Pick your interview time</h1>
      <p>Hi {v.firstName}. This is for the <b>{v.job}</b> role with {v.company} (round {v.round}, about {v.minutes} minutes{v.mode ? `, ${v.mode.toLowerCase()}` : ''}).</p>
      {done ? <p className="mkp-ok" role="status">{done}</p> : (
        <>
          {v.status === 'booked' && <p className="mkp-ok">You already booked {v.pickedSlot ? when(v.pickedSlot) : 'a time'}.</p>}
          {v.status === 'expired' && <p className="ipp-err">This link has expired. Ask your recruiter for a new one.</p>}
          {v.status === 'open' && v.slots.length === 0 && <p className="ipp-err">These times have passed. Ask your recruiter for new ones.</p>}
          {v.status === 'open' && v.slots.length > 0 && (
            <>
              <div className="mkp-slots" role="radiogroup" aria-label="Interview times">
                {v.slots.map((s) => <label key={s} className={`mkp-slot${pick === s ? ' on' : ''}`}><input type="radio" name="slot" value={s} checked={pick === s} onChange={() => setPick(s)} /> {when(s)}</label>)}
              </div>
              <button type="button" className="mkp-btn" disabled={!pick || busy} onClick={book}>Book this time</button>
              <details className="mkp-none"><summary>None of these times work</summary>
                <textarea rows="2" placeholder="When are you free? (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
                <button type="button" className="mkp-btn ghost" disabled={busy} onClick={none}>Ask for new times</button>
              </details>
            </>
          )}
          {err && <p className="ipp-err" role="alert">{err}</p>}
        </>
      )}
    </div></div>
  );
}

export function TakeTestPage() {
  const { token } = useParams();
  const [v, setV] = useState(null); const [err, setErr] = useState(''); const [started, setStarted] = useState(false); const [ans, setAns] = useState({}); const [done, setDone] = useState(''); const [left, setLeft] = useState(null);
  useEffect(() => { api.get(`/public/mkt/test/${token}`).then((r) => { setV(r.data); if (r.data.startedAt) setStarted(true); }).catch((e) => setErr(errOf(e, 'This test link does not work.'))); }, [token]);
  useEffect(() => {
    if (!started || !v || !v.minutes) return undefined;
    const end = (v.startedAt ? new Date(v.startedAt).getTime() : Date.now()) + v.minutes * 60000;
    const t = setInterval(() => setLeft(Math.max(0, Math.round((end - Date.now()) / 1000))), 1000);
    return () => clearInterval(t);
  }, [started, v]);
  if (err && !v) return <div className="ipp"><div className="ipp-card"><h1>Test</h1><p className="ipp-err">{err}</p></div></div>;
  if (!v) return <div className="ipp"><div className="ipp-card"><p>Loading…</p></div></div>;
  if (done || v.status === 'submitted') return <div className="ipp"><div className="ipp-card"><h1>{v.title}</h1><p className="mkp-ok">{done || 'Your answers were sent in. Thank you.'}</p></div></div>;
  if (v.expired) return <div className="ipp"><div className="ipp-card"><h1>{v.title}</h1><p className="ipp-err">This link has expired.</p></div></div>;
  const set = (i, val) => setAns((a) => ({ ...a, [i]: val }));
  async function submit() { setErr(''); try { const r = await api.post(`/public/mkt/test/${token}/submit`, { answers: ans }); setDone(r.data.message); } catch (e) { setErr(errOf(e)); } }
  return (
    <div className="ipp"><div className="ipp-card">
      <div className="ipp-brand">TeamLink</div>
      <h1>{v.title}</h1>
      {!started ? (
        <>
          <p>{v.count} questions · about {v.minutes} minutes. Start when you are ready; the clock starts then. Answer on your own.</p>
          <button type="button" className="mkp-btn" onClick={async () => { await api.post(`/public/mkt/test/${token}/start`, {}).catch(() => null); setStarted(true); setV({ ...v, startedAt: new Date().toISOString() }); }}>Start the test</button>
        </>
      ) : (
        <>
          {left !== null && <p className={left < 60 ? 'ipp-err' : 'small-muted'}>Time left: {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</p>}
          <ol className="mkp-qs">
            {v.questions.map((q, i) => (
              <li key={i}>
                <p><b>{q.text}</b> <span className="small-muted">({q.points} point{q.points > 1 ? 's' : ''}{q.type === 'multi' ? ', tick all that are right' : ''})</span></p>
                {q.type === 'short' && <textarea rows="3" value={ans[i] || ''} onChange={(e) => set(i, e.target.value)} aria-label={`Answer ${i + 1}`} />}
                {q.type === 'mcq' && q.options.map((o, n) => <label key={n} className="mkp-opt"><input type="radio" name={`q${i}`} checked={ans[i] === n} onChange={() => set(i, n)} /> {o}</label>)}
                {q.type === 'multi' && q.options.map((o, n) => <label key={n} className="mkp-opt"><input type="checkbox" checked={(ans[i] || []).includes(n)} onChange={(e) => set(i, e.target.checked ? [...(ans[i] || []), n] : (ans[i] || []).filter((x) => x !== n))} /> {o}</label>)}
              </li>
            ))}
          </ol>
          <button type="button" className="mkp-btn" onClick={submit}>Send my answers</button>
          {err && <p className="ipp-err" role="alert">{err}</p>}
        </>
      )}
    </div></div>
  );
}

const LANG_NAMES = { en: 'English', te: 'తెలుగు', hi: 'हिन्दी' };
function useLang() {
  const [sp, setSp] = useSearchParams();
  const lang = ['en', 'te', 'hi'].includes(sp.get('lang')) ? sp.get('lang') : 'en';
  const setLang = (l) => { const n = new URLSearchParams(sp); if (l === 'en') n.delete('lang'); else n.set('lang', l); setSp(n, { replace: true }); };
  return [lang, setLang];
}
function LangBar({ lang, setLang }) {
  return <div className="mkp-langs">{Object.entries(LANG_NAMES).map(([k, n]) => <button key={k} type="button" className={k === lang ? 'on' : ''} onClick={() => setLang(k)}>{n}</button>)}</div>;
}

function AlertsForm({ labels, lang }) {
  const [f, setF] = useState({ email: '', keywords: '', location: '', consent: false, website: '' }); const [msg, setMsg] = useState(''); const [err, setErr] = useState('');
  async function go(e) { e.preventDefault(); setErr(''); setMsg(''); try { const r = await api.post('/public/mkt/alerts/subscribe', { ...f, consent: f.consent ? 'yes' : '', lang }); setMsg(r.data.message); } catch (x) { setErr(errOf(x)); } }
  return (
    <form className="mkp-alerts" onSubmit={go}>
      <h2>{labels.alert}</h2>
      <input type="email" required placeholder="you@gmail.com" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} aria-label="Email" />
      <input type="text" placeholder="Job words, e.g. nurse, java" value={f.keywords} onChange={(e) => setF({ ...f, keywords: e.target.value })} aria-label="Job words" />
      <input type="text" placeholder="City" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} aria-label="City" />
      <input type="text" tabIndex="-1" autoComplete="off" className="mkp-hp" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} aria-hidden="true" />
      <label className="mkp-opt"><input type="checkbox" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} /> Email me new jobs. I can stop it any time.</label>
      <button type="submit" className="mkp-btn">Sign up</button>
      {msg && <p className="mkp-ok">{msg}</p>}{err && <p className="ipp-err">{err}</p>}
    </form>
  );
}

export function CareersSitePage() {
  const [lang, setLang] = useLang();
  const [v, setV] = useState(null); const [err, setErr] = useState(''); const [q, setQ] = useState('');
  useEffect(() => { api.get('/public/mkt/site', { params: { lang } }).then((r) => setV(r.data)).catch((e) => setErr(errOf(e))); }, [lang]);
  useEffect(() => { if (v && v.site) document.title = `${v.site.brand.name} - Jobs`; }, [v]);
  const jobs = useMemo(() => ((v && v.jobs) || []).filter((j) => !q || `${j.title} ${j.location} ${(j.skills || []).join(' ')}`.toLowerCase().includes(q.toLowerCase())), [v, q]);
  if (err) return <div className="ipp"><div className="ipp-card"><p className="ipp-err">{err}</p></div></div>;
  if (!v) return <div className="ipp"><div className="ipp-card"><p>Loading…</p></div></div>;
  if (!v.published) return <div className="ipp"><div className="ipp-card"><h1>Careers</h1><p>Our careers site is being set up. <a href="/jobs/">See open jobs on the job portal</a>.</p></div></div>;
  const s = v.site; const L = v.labels || {};
  const color = s.brand.color || '#1f6feb';
  const parts = {
    hero: <section key="hero" className="mkp-hero" style={{ background: color }}><div className="mkp-wrap"><h1>{s.hero.title}</h1>{s.hero.subtitle && <p>{s.hero.subtitle}</p>}<a href="#jobs" className="mkp-btn light">{s.hero.button}</a></div></section>,
    about: s.about && s.about.text ? <section key="about" className="mkp-wrap mkp-sec"><h2>{s.about.title}</h2><p>{s.about.text}</p></section> : null,
    jobs: (
      <section key="jobs" id="jobs" className="mkp-wrap mkp-sec">
        <h2>{s.jobs.title} ({v.jobs.length})</h2>
        <input type="search" className="mkp-search" placeholder="Search jobs" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search jobs" />
        <div className="mkp-jobs">
          {jobs.map((j) => (
            <Link key={j.id} to={`/site/job/${encodeURIComponent(j.slug || j.id)}${lang === 'en' ? '' : `?lang=${lang}`}`} className="mkp-job">
              <b>{j.title}</b>
              <span>{[j.location, j.experience, j.workMode].filter(Boolean).join(' · ')}</span>
              {j.salary && <span className="small-muted">{L.salary}: {j.salary}</span>}
            </Link>
          ))}
          {!jobs.length && <p className="small-muted">No jobs match.</p>}
        </div>
      </section>
    ),
    alerts: v.alerts ? <section key="alerts" className="mkp-wrap mkp-sec"><AlertsForm labels={L} lang={lang} /></section> : null,
    contact: <section key="contact" className="mkp-wrap mkp-sec"><h2>{s.contact.title}</h2>{s.contact.email && <p>✉ <a href={`mailto:${s.contact.email}`}>{s.contact.email}</a></p>}{s.contact.phone && <p>☎ {s.contact.phone}</p>}{s.contact.address && <p>{s.contact.address}</p>}</section>,
  };
  return (
    <div className="mkp">
      <header className="mkp-top"><div className="mkp-wrap mkp-topin">{s.brand.logoUrl ? <img src={s.brand.logoUrl} alt={s.brand.name} height="32" /> : <b>{s.brand.name}</b>}<LangBar lang={lang} setLang={setLang} /></div></header>
      {s.sections.map((k) => parts[k])}
      <footer className="mkp-wrap mkp-foot small-muted">© {s.brand.name}</footer>
    </div>
  );
}

const BASIC = ['name', 'email', 'phone', 'location', 'experienceYears', 'currentCompany', 'noticePeriod', 'currentSalary', 'expectedSalary', 'skills'];
export function SiteJobPage() {
  const { id } = useParams();
  const [lang, setLang] = useLang();
  const [job, setJob] = useState(null); const [site, setSite] = useState(null); const [err, setErr] = useState('');
  const [f, setF] = useState({ consent: false, website: '' }); const [file, setFile] = useState(null); const [useLi, setUseLi] = useState(false); const [fillMsg, setFillMsg] = useState(''); const [sent, setSent] = useState(''); const [busy, setBusy] = useState(false); const [ferr, setFerr] = useState('');
  const [sp] = useSearchParams();
  useEffect(() => {
    api.get(`/public/careers/jobs/${encodeURIComponent(id)}`, { params: { src: sp.get('src') || undefined } }).then((r) => setJob(r.data)).catch((e) => setErr(errOf(e, 'This job is not open any more.')));
    api.get('/public/mkt/site', { params: { lang } }).then((r) => setSite(r.data)).catch(() => null);
  }, [id, lang, sp]);
  useEffect(() => { if (job && job.title) document.title = `${job.title}${job.location ? ` - ${job.location}` : ''}`; }, [job]);
  if (err) return <div className="ipp"><div className="ipp-card"><p className="ipp-err">{err}</p><Link to="/site">See other jobs</Link></div></div>;
  if (!job) return <div className="ipp"><div className="ipp-card"><p>Loading…</p></div></div>;
  const L = (site && site.labels) || { apply: 'Apply now', location: 'Location', experience: 'Experience', salary: 'Salary', skills: 'Skills', about: 'About the job', linkedin: 'Apply with LinkedIn' };
  const form = job.form || { fields: [], linkedinApply: true };
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  async function quickFill(fl) {
    setFile(fl); setFillMsg('Reading your resume…');
    try {
      const fd = new FormData(); fd.append('file', fl);
      const r = await api.post('/public/mkt/quick-fill', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setF((x) => { const n = { ...x }; Object.entries(r.data.fields).forEach(([k, v]) => { if (v != null && v !== '' && !n[k]) n[k] = String(v); }); return n; });
      setFillMsg(r.data.note);
    } catch (e) { setFillMsg(errOf(e)); }
  }
  async function apply(e) {
    e.preventDefault(); setFerr(''); setBusy(true);
    try {
      const fd = new FormData();
      BASIC.forEach((k) => { if (f[k]) fd.append(k, f[k]); });
      form.fields.forEach((q) => { if (f[`q_${q.key}`]) fd.append(`q_${q.key}`, f[`q_${q.key}`]); });
      fd.append('consent', f.consent ? 'yes' : ''); fd.append('website', f.website || '');
      if (sp.get('src')) fd.append('src', sp.get('src'));
      if (useLi) fd.append('linkedinUrl', f.linkedinUrl || ''); else if (file) fd.append('file', file);
      const r = await api.post(`/public/careers/jobs/${encodeURIComponent(job.id)}/apply`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setSent(r.data.message || 'Application sent.');
    } catch (x) { setFerr(errOf(x)); }
    setBusy(false);
  }
  const inp = (k, label, props = {}) => <label className="mkp-f">{label}<input value={f[k] || ''} onChange={(e) => set(k, e.target.value)} {...props} /></label>;
  return (
    <div className="mkp">
      <header className="mkp-top"><div className="mkp-wrap mkp-topin"><Link to={`/site${lang === 'en' ? '' : `?lang=${lang}`}`}><b>{(site && site.site && site.site.brand && site.site.brand.name) || 'Jobs'}</b></Link><LangBar lang={lang} setLang={setLang} /></div></header>
      <main className="mkp-wrap mkp-sec">
        <h1 className="mkp-h1">{job.title}</h1>
        {job.closed ? <p className="ipp-err">This job is closed.</p> : (
          <>
            <div className="mkp-facts">
              {job.location && <span><b>{L.location}</b> {job.location}</span>}
              {job.experience && <span><b>{L.experience}</b> {job.experience}</span>}
              {job.salary && <span><b>{L.salary}</b> {job.salary}</span>}
            </div>
            {(job.skills || []).length > 0 && <p><b>{L.skills}:</b> {job.skills.join(', ')}</p>}
            {job.description && <><h2>{L.about}</h2><p className="mkp-desc">{job.description}</p></>}
            {(job.responsibilities || []).length > 0 && <ul>{job.responsibilities.map((x, i) => <li key={i}>{x}</li>)}</ul>}
            <h2 id="apply">{L.apply}</h2>
            {sent ? <p className="mkp-ok" role="status">{sent}</p> : (
              <form className="mkp-form" onSubmit={apply}>
                <div className="mkp-choose">
                  <label className={!useLi ? 'on' : ''}><input type="radio" checked={!useLi} onChange={() => setUseLi(false)} /> Resume</label>
                  {form.linkedinApply && <label className={useLi ? 'on' : ''}><input type="radio" checked={useLi} onChange={() => setUseLi(true)} /> {L.linkedin}</label>}
                </div>
                {!useLi && <label className="mkp-f">Your resume (PDF or Word) - we fill the form from it<input type="file" accept=".pdf,.doc,.docx" onChange={(e) => e.target.files[0] && quickFill(e.target.files[0])} /></label>}
                {!useLi && fillMsg && <p className="small-muted">{fillMsg}</p>}
                {useLi && inp('linkedinUrl', 'Your LinkedIn profile link', { type: 'url', placeholder: 'https://www.linkedin.com/in/your-name', required: true })}
                <div className="mkp-grid">
                  {inp('name', 'Full name', { required: true })}
                  {inp('email', 'Email', { type: 'email', required: true })}
                  {inp('phone', 'Mobile number', { type: 'tel', required: true })}
                  {inp('location', 'City')}
                  {inp('experienceYears', 'Experience (years)', { type: 'number', step: '0.5', min: 0 })}
                  {inp('noticePeriod', 'Notice period')}
                  {inp('currentSalary', 'Current salary (e.g. 4.5 LPA)', { required: true })}
                  {inp('expectedSalary', 'Expected salary', { required: true })}
                </div>
                {form.fields.map((q) => (
                  <label key={q.key} className="mkp-f">{q.label}{q.required ? ' *' : ''}
                    {q.type === 'yesno' ? <select value={f[`q_${q.key}`] || ''} required={q.required} onChange={(e) => set(`q_${q.key}`, e.target.value)}><option value="">-</option><option value="yes">Yes</option><option value="no">No</option></select>
                      : q.type === 'choice' ? <select value={f[`q_${q.key}`] || ''} required={q.required} onChange={(e) => set(`q_${q.key}`, e.target.value)}><option value="">-</option>{(q.options || []).map((o) => <option key={o}>{o}</option>)}</select>
                        : <input type={{ number: 'number', date: 'date', url: 'url' }[q.type] || 'text'} required={q.required} value={f[`q_${q.key}`] || ''} onChange={(e) => set(`q_${q.key}`, e.target.value)} />}
                  </label>
                ))}
                <input type="text" tabIndex="-1" autoComplete="off" className="mkp-hp" value={f.website} onChange={(e) => set('website', e.target.value)} aria-hidden="true" />
                <label className="mkp-opt"><input type="checkbox" checked={f.consent} onChange={(e) => set('consent', e.target.checked)} required /> I agree that TeamLink may use my details and resume for this job.</label>
                <button type="submit" className="mkp-btn" disabled={busy}>{busy ? 'Sending…' : L.apply}</button>
                {ferr && <p className="ipp-err" role="alert">{ferr}</p>}
              </form>
            )}
          </>
        )}
      </main>
    </div>
  );
}
