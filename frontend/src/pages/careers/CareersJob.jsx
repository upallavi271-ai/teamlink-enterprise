import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import api from '../../api';
import CareersChrome, { daysAgo } from './CareersChrome.jsx';

// /careers/:id — one job, and the Apply form (with the resume).
//
// This is the URL every public channel already uses: the jobs.xml / jobs.feed
// / Google Jobs feeds and the tagged links on the requirement page
// (/careers/<id>?src=Shine). ?src= is sent with the application and recorded
// as where the applicant saw the job. The application lands in Candidates →
// "New from job portal" at once (backend routes/careersPublic.js).

const MAX_MB = 10;
const OK_FILE = /\.(pdf|docx?)$/i;

function Section({ title, children }) {
  return (
    <section className="jp-panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

// B9.5: the Turnstile widget. Its script is loaded once; with implicit
// rendering it draws itself into the .cf-turnstile box and adds the hidden
// cf-turnstile-response input the form sends. Never drawn when not set up.
const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
function TurnstileBox({ siteKey }) {
  useEffect(() => {
    if (!siteKey || document.querySelector(`script[src^="${TURNSTILE_SRC}"]`)) return;
    const s = document.createElement('script');
    s.src = TURNSTILE_SRC; s.async = true; s.defer = true;
    document.head.appendChild(s);
  }, [siteKey]);
  if (!siteKey) return null;
  return (
    <div className="jp-turnstile" style={{ margin: '10px 0' }}>
      <div className="cf-turnstile" data-sitekey={siteKey} data-theme="light" />
      <noscript><div className="jp-note is-orange">Please turn on JavaScript to send your application.</div></noscript>
    </div>
  );
}

function ApplyForm({ job, src }) {
  const [form, setForm] = useState({
    name: '', phone: '', email: '', location: '', experienceYears: '',
    currentCompany: '', noticePeriod: '', expectedSalary: '', skills: '', website: '',
  });
  const [file, setFile] = useState(null);
  const [consent, setConsent] = useState(false);
  const [more, setMore] = useState(false);
  const [state, setState] = useState({ step: 'form', error: '' }); // form | sending | done | duplicate
  const fileRef = useRef(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  function pickFile(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) { setFile(null); return; }
    if (!OK_FILE.test(f.name)) { setFile(null); setState({ step: 'form', error: 'Your resume must be a PDF or Word file (.pdf, .doc, .docx).' }); e.target.value = ''; return; }
    if (f.size > MAX_MB * 1024 * 1024) { setFile(null); setState({ step: 'form', error: `Your resume is bigger than ${MAX_MB} MB. Please send a smaller file.` }); e.target.value = ''; return; }
    setState({ step: 'form', error: '' });
    setFile(f);
  }

  async function submit(e) {
    e.preventDefault();
    if (!file) { setState({ step: 'form', error: 'Please attach your resume (PDF or Word file).' }); return; }
    if (!consent) { setState({ step: 'form', error: 'Please tick the box to agree that TeamLink may use your resume for this job.' }); return; }
    setState({ step: 'sending', error: '' });
    const fd = new FormData();
    Object.entries(form).forEach(([k, v]) => fd.append(k, v));
    fd.append('consent', 'yes');
    // B9.5: the "I am human" token when Bot protection (Cloudflare Turnstile) is on.
    if (job.botProtection) {
      const tok = e.target.querySelector('[name="cf-turnstile-response"]');
      if (!tok || !tok.value) { setState({ step: 'form', error: 'Please tick the "I am human" box first.' }); return; }
      fd.append(job.botProtection.field || 'cf-turnstile-response', tok.value);
    }
    if (src) fd.append('src', src);
    fd.append('resume', file, file.name);
    try {
      await api.post(`/public/careers/jobs/${job.id}/apply`, fd);
      setState({ step: 'done', error: '' });
    } catch (err) {
      if (err.response?.status === 409 && err.response?.data?.duplicate) { setState({ step: 'duplicate', error: '' }); return; }
      setState({ step: 'form', error: err.response?.data?.error || 'Your application could not be sent. Please check your internet and try again.' });
    }
  }

  if (state.step === 'done') {
    return (
      <div className="jp-note is-green" role="status">
        <b>✓ Application sent</b>
        <p>{`We have your resume for ${job.title}. Our team will call you if your profile fits.`}</p>
        <Link className="jp-btn jp-btn-primary jp-btn-block" to="/careers/my-applications">See my applications</Link>
        <Link className="jp-link" to="/careers">Look at other jobs</Link>
      </div>
    );
  }
  if (state.step === 'duplicate') {
    return (
      <div className="jp-note is-orange" role="status">
        <b>You have already applied to this job.</b>
        <p>You do not need to apply again. You can follow it under My applications.</p>
        <Link className="jp-btn jp-btn-primary jp-btn-block" to="/careers/my-applications">See my applications</Link>
      </div>
    );
  }

  const sending = state.step === 'sending';
  return (
    <form className="jp-form" onSubmit={submit} noValidate={false}>
      <label htmlFor="apName">Full name</label>
      <input id="apName" required autoComplete="name" maxLength={100} value={form.name} onChange={set('name')} />
      <label htmlFor="apPhone">Mobile number</label>
      <input id="apPhone" required inputMode="tel" autoComplete="tel" maxLength={20} placeholder="10-digit mobile" value={form.phone} onChange={set('phone')} />
      <label htmlFor="apEmail">Email</label>
      <input id="apEmail" required type="email" autoComplete="email" maxLength={120} placeholder="you@gmail.com" value={form.email} onChange={set('email')} />

      <label htmlFor="apResume">Resume (PDF or Word, up to {MAX_MB} MB)</label>
      <input id="apResume" ref={fileRef} required type="file" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={pickFile} />
      {file && <div className="jp-file">📄 {file.name}</div>}

      <div className="jp-form-row">
        <div>
          <label htmlFor="apExp">Experience (years)</label>
          <input id="apExp" inputMode="decimal" maxLength={4} placeholder="e.g. 2" value={form.experienceYears} onChange={set('experienceYears')} />
        </div>
        <div>
          <label htmlFor="apLoc">Your city</label>
          <input id="apLoc" maxLength={80} autoComplete="address-level2" value={form.location} onChange={set('location')} />
        </div>
      </div>

      {!more ? (
        <button type="button" className="jp-link" onClick={() => setMore(true)}>+ Add more details (optional)</button>
      ) : (
        <>
          <label htmlFor="apCo">Current company</label>
          <input id="apCo" maxLength={120} value={form.currentCompany} onChange={set('currentCompany')} />
          <div className="jp-form-row">
            <div>
              <label htmlFor="apNotice">Notice period</label>
              <input id="apNotice" maxLength={40} placeholder="e.g. 30 days" value={form.noticePeriod} onChange={set('noticePeriod')} />
            </div>
            <div>
              <label htmlFor="apSal">Expected salary</label>
              <input id="apSal" maxLength={40} placeholder="e.g. 4 LPA" value={form.expectedSalary} onChange={set('expectedSalary')} />
            </div>
          </div>
          <label htmlFor="apSkills">Your skills</label>
          <input id="apSkills" maxLength={400} placeholder="e.g. Java, SQL, Teaching" value={form.skills} onChange={set('skills')} />
        </>
      )}

      {/* Not for people: a field bots fill in. Hidden from screens and screen readers. */}
      <div className="jp-hp" aria-hidden="true">
        <label htmlFor="apWebsite">Website</label>
        <input id="apWebsite" tabIndex={-1} autoComplete="off" value={form.website} onChange={set('website')} />
      </div>

      {/* B9.5: Cloudflare Turnstile — only drawn when Administration → Integrations → Bot protection is set up. */}
      {job.botProtection && job.botProtection.provider === 'turnstile' && <TurnstileBox siteKey={job.botProtection.siteKey} />}

      <label className="jp-check">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>I agree that TeamLink Consultants may use my resume and contact me about this job.</span>
      </label>

      {state.error && <div className="jp-note is-red" role="alert">{state.error}</div>}
      <button className="jp-btn jp-btn-primary jp-btn-block" type="submit" disabled={sending}>
        {sending ? 'Sending…' : 'Send application'}
      </button>
    </form>
  );
}

export default function CareersJob() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const src = params.get('src') || '';
  const [job, setJob] = useState(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setJob(null); setMissing(false); setError('');
    api.get(`/public/careers/jobs/${encodeURIComponent(id)}`)
      .then((r) => {
        if (!live) return;
        // An old /careers/<id> link moves to the readable one (?src= kept).
        if (r.data.slug && r.data.slug !== id) { navigate(`/careers/${r.data.slug}${window.location.search}`, { replace: true }); return; }
        setJob(r.data); document.title = `${r.data.title} — TeamLink Jobs`;
      })
      .catch((e) => {
        if (!live) return;
        if (e.response?.status === 404) setMissing(true);
        else setError(e.response?.data?.error || 'This job could not be loaded. Please try again.');
      });
    return () => { live = false; };
  }, [id]);

  // GOOGLE FOR JOBS reads schema.org JobPosting markup on the job's own page.
  // Only jobs with "Google Jobs" ticked answer (404 otherwise — nothing added).
  useEffect(() => {
    let tag = null;
    let alive = true;
    api.get(`/public/jobs/${encodeURIComponent(id)}/jsonld`).then((res) => {
      if (!alive) return;
      tag = document.createElement('script');
      tag.type = 'application/ld+json';
      tag.text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      document.head.appendChild(tag);
    }).catch(() => {});
    return () => { alive = false; if (tag) tag.remove(); };
  }, [id]);

  const back = <Link className="jp-back" to={`/careers${src ? `?src=${encodeURIComponent(src)}` : ''}`}>← All jobs</Link>;

  if (missing || (job && job.closed)) {
    return (
      <CareersChrome>
        <div className="jp-wrap jp-page">
          {back}
          <div className="jp-empty">
            <b>{job && job.closed ? `${job.title} — this job is closed.` : 'This job is not on the portal.'}</b>
            <p>It is not taking applications any more. Have a look at the other open jobs.</p>
            <Link className="jp-btn jp-btn-primary" to="/careers">See open jobs</Link>
          </div>
        </div>
      </CareersChrome>
    );
  }
  if (error) {
    return <CareersChrome><div className="jp-wrap jp-page">{back}<div className="jp-note is-red" role="alert">{error}</div></div></CareersChrome>;
  }
  if (!job) return <CareersChrome><div className="jp-wrap jp-page"><div className="jp-muted">Loading the job…</div></div></CareersChrome>;

  return (
    <CareersChrome>
      <div className="jp-wrap jp-page">
        {back}
        <div className="jp-detail">
          <div className="jp-detail-head jp-panel">
            <h1>{job.title}</h1>
            <div className="jp-card-co">{job.company}{job.location ? ` · ${job.location}` : ''}</div>
            <div className="jp-meta">
              {job.experience && <span>💼 {job.experience}</span>}
              {job.workMode && <span>🏠 {job.workMode}</span>}
              {job.employmentType && <span>🕒 {job.employmentType}</span>}
              {job.salary && <span>💰 {job.salary}</span>}
              {job.openings > 1 && <span>👥 {job.openings} openings</span>}
              <span>📅 {daysAgo(job.postedAt)}</span>
            </div>
          </div>

          <aside className="jp-detail-side">
            <section className="jp-panel jp-apply" id="apply">
              <h2>Apply for this job</h2>
              <ApplyForm job={job} src={src} />
            </section>
            {job.similar && job.similar.length > 0 && (
              <section className="jp-panel">
                <h2>Similar jobs</h2>
                <div className="jp-similar">
                  {job.similar.map((s) => (
                    <Link key={s.id} to={`/careers/${s.slug || s.id}${src ? `?src=${encodeURIComponent(src)}` : ''}`}>
                      <b>{s.title}</b>
                      <span className="jp-muted">{s.location || s.company}</span>
                    </Link>
                  ))}
                </div>
              </section>
            )}
          </aside>

          <div className="jp-detail-main">
            {job.description && <Section title="About the job"><p className="jp-pre">{job.description}</p></Section>}
            {job.responsibilities.length > 0 && (
              <Section title="What you will do"><ul>{job.responsibilities.map((r) => <li key={r}>{r}</li>)}</ul></Section>
            )}
            {job.requirements.length > 0 && (
              <Section title="What you need"><ul>{job.requirements.map((r) => <li key={r}>{r}</li>)}</ul></Section>
            )}
            {(job.skills.length > 0 || job.goodToHave.length > 0) && (
              <Section title="Key skills">
                <div className="jp-tags">{job.skills.map((s) => <span key={s} className="jp-tag">{s}</span>)}</div>
                {job.goodToHave.length > 0 && (
                  <>
                    <div className="jp-muted" style={{ marginTop: 10 }}>Good to have</div>
                    <div className="jp-tags">{job.goodToHave.map((s) => <span key={s} className="jp-tag is-soft">{s}</span>)}</div>
                  </>
                )}
              </Section>
            )}
            {(job.education || job.department || job.noticePeriodMax) && (
              <Section title="Education & team">
                <dl className="jp-kv">
                  {job.education && <><dt>Education</dt><dd>{job.education}</dd></>}
                  {job.department && <><dt>Team</dt><dd>{job.department}</dd></>}
                  {job.noticePeriodMax && <><dt>Notice period</dt><dd>{`Up to ${job.noticePeriodMax}`}</dd></>}
                </dl>
              </Section>
            )}
          </div>
        </div>
      </div>
    </CareersChrome>
  );
}
