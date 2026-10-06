import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../api';
import EmptyState from '../components/ui/EmptyState.jsx';
import Modal from '../components/Modal.jsx';
import {
  Chip, Tabs, Stat, InterviewLine, fmtDate, openFile,
} from './portal/portalUi.jsx';

// ---------------------------------------------------------------------------
// THE CANDIDATE PORTAL (user notes #4, point 3) — where a signed-in candidate
// lands (identity.js WORKSPACE_HOME.candidate = /my-applications).
//
//   My Applications  every application, its status in plain words
//                    ("Under review", "Shared with employer", "Interview
//                    scheduled", "Selected", "Not selected"), interview
//                    details, AI interview if pending, offer / joining
//   Interviews       date, time, mode, place / meeting link
//   My Profile       edit the basics, upload the resume (PDF)
//   Open Jobs        published openings, one-click apply
//
// Everything comes from GET /api/portal/candidate, which is pinned to the
// signed-in candidate and picks every field by name — never an internal stage
// code, a recruiter comment, a score, another candidate or the client's own
// feedback wording.
// ---------------------------------------------------------------------------

// The journey, in the candidate's words, for the little progress strip.
const STEPS = ['Applied', 'Under review', 'Shared with employer', 'Interview', 'Selected', 'Joined'];
function stepOf(status) {
  if (/^Joined/.test(status)) return 5;
  if (/Selected|Offer/.test(status)) return 4;
  if (/Interview (scheduled|done)/.test(status)) return 3;
  if (/Shared with employer/.test(status)) return 2;
  return 1;
}

function Steps({ status }) {
  const stopped = /Not selected/.test(status);
  const at = stepOf(status);
  return (
    <div className="tlp-steps" aria-label={`Progress: ${status}`}>
      {STEPS.map((s, i) => {
        let cls = '';
        if (i < at) cls = 'done';
        else if (i === at) cls = stopped ? 'stop' : 'now';
        return <span key={s} className={`tlp-step ${cls}`}>{i === at && stopped ? 'Not selected' : s}</span>;
      })}
    </div>
  );
}

export default function CandidateHome() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState('applications');
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [jobQ, setJobQ] = useState('');
  const fileRef = useRef(null);
  // Spec B2 self-service: documents, offer answer, withdraw, delete-my-data, password.
  const [extras, setExtras] = useState(null);
  const [docType, setDocType] = useState('');
  const [ask, setAsk] = useState(null); // { kind: 'decline'|'withdraw'|'privacy', app? }
  const [askText, setAskText] = useState('');
  const [pw, setPw] = useState('');
  const docRef = useRef(null);

  const load = useCallback(() => {
    api.get('/portal/candidate')
      .then((r) => {
        setData(r.data);
        const p = r.data.profile;
        setForm(Object.fromEntries(Object.keys(p.fields).map((k) => [k, p[k] ?? ''])));
        setError('');
      })
      .catch((e) => setError(e.response?.data?.error || 'Could not load your applications.'));
    api.get('/portal/candidate/extras').then((r) => setExtras(r.data)).catch(() => setExtras(null));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    try {
      const n = sessionStorage.getItem('tl_portal_notice');
      if (n) { setNotice(n); sessionStorage.removeItem('tl_portal_notice'); }
    } catch { /* ignore */ }
  }, []);

  function post(path, body, okMsg) {
    setError(''); setNotice('');
    return api.post(path, body || {})
      .then((r) => { setNotice(r.data.message || okMsg || 'Saved.'); setAsk(null); setAskText(''); load(); })
      .catch((err) => setError(err.response?.data?.error || 'That did not work. Please try again.'));
  }

  function uploadDoc(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('docType', docType || 'Other');
    fd.append('file', file);
    setUploading(true); setError(''); setNotice('');
    api.post('/portal/candidate/documents', fd)
      .then((r) => { setNotice(r.data.message || 'Uploaded.'); load(); })
      .catch((err) => setError(err.response?.data?.error || 'Could not upload the file.'))
      .finally(() => { setUploading(false); if (docRef.current) docRef.current.value = ''; });
  }
  const withdrawAsked = (id) => (extras?.requests || []).some((r) => r.kind === 'CANDIDATE_WITHDRAW' && r.status === 'Pending' && r.applicationId === id);
  const privacyAsked = (extras?.requests || []).some((r) => r.kind === 'CANDIDATE_PRIVACY' && r.status === 'Pending');

  function saveProfile(e) {
    e.preventDefault();
    setSaving(true); setError(''); setNotice('');
    api.put('/portal/candidate', form)
      .then(() => { setNotice('Profile saved.'); load(); })
      .catch((err) => setError(err.response?.data?.error || 'Could not save your profile.'))
      .finally(() => setSaving(false));
  }

  function uploadResume(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    setUploading(true); setError(''); setNotice('');
    api.post('/portal/candidate/resume', fd)
      .then(() => { setNotice('Resume uploaded.'); load(); })
      .catch((err) => setError(err.response?.data?.error || 'Could not upload the resume.'))
      .finally(() => { setUploading(false); if (fileRef.current) fileRef.current.value = ''; });
  }

  function apply(job) {
    setError(''); setNotice('');
    api.post(`/portal/candidate/apply/${job.id}`)
      .then((r) => { setNotice(r.data.message || 'Application sent.'); load(); })
      .catch((err) => setError(err.response?.data?.error || 'Could not apply.'));
  }

  if (error && !data) return <div className="tlp"><div className="notice red"><span>{error}</span></div></div>;
  if (!data) return <div className="tlp small-muted">Loading…</div>;

  const { profile, resume, applications, interviews, openJobs } = data;
  const active = applications.filter((a) => !/Not selected|Joined/.test(a.status));
  const upcoming = interviews.filter((i) => i.upcoming);
  const offers = applications.filter((a) => a.offer);
  const jobs = openJobs.filter((j) => !jobQ || `${j.title} ${j.location || ''} ${j.department || ''}`.toLowerCase().includes(jobQ.toLowerCase()));

  return (
    <div className="tlp">
      <div className="page-head">
        <div>
          <h1 className="tlp-hello">Hi {profile.name?.split(' ')[0] || 'there'}</h1>
          <div className="tlp-sub">Your applications, interviews and profile</div>
        </div>
      </div>
      {error && <div className="notice red"><span>{error}</span></div>}
      {notice && <div className="notice"><span>{notice}</span></div>}

      <div className="tlp-stats">
        <Stat value={applications.length} label="Applications" onClick={() => setTab('applications')} />
        <Stat value={active.length} label="In progress" onClick={() => setTab('applications')} />
        <Stat value={upcoming.length} label="Interviews coming up" onClick={() => setTab('interviews')} />
        <Stat value={offers.length} label="Offers / joining" onClick={() => setTab('applications')} />
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'applications', label: 'My Applications', count: applications.length },
          { id: 'interviews', label: 'Interviews', count: interviews.length },
          { id: 'profile', label: 'My Profile' },
          { id: 'jobs', label: 'Open Jobs', count: openJobs.length },
        ]}
      />

      {tab === 'applications' && (
        applications.length ? (
          <div className="tlp-list">
            {applications.map((a) => (
              <div className="tlp-item" key={a.id}>
                <div className="tlp-item-top">
                  <div>
                    <div className="tlp-item-title">{a.jobTitle}</div>
                    <div className="tlp-meta">{[a.company, a.location, a.reference].filter(Boolean).join(' · ')}</div>
                    <div className="tlp-meta">Applied {fmtDate(a.appliedAt)} · last update {fmtDate(a.updatedAt)}</div>
                  </div>
                  <Chip label={a.status} tone={a.tone} />
                </div>
                <Steps status={a.status} />
                {a.aiInterview && (
                  <div className="tlp-box">
                    <b>AI interview pending.</b> Your recruiter will send you the link by email / WhatsApp
                    {a.aiInterview.deadline ? <> — please complete it by <b>{a.aiInterview.deadline}</b></> : ''}.
                    {a.aiInterview.link && <> <a href={a.aiInterview.link} target="_blank" rel="noreferrer">Start AI interview →</a></>}
                  </div>
                )}
                <InterviewLine iv={a.interview} />
                {a.offer && (
                  <div className="tlp-box">
                    <b>Offer &amp; joining</b>
                    <div className="tlp-meta">
                      {[a.offer.status, a.offer.date ? `offer dated ${a.offer.date}` : null,
                        a.offer.ctc ? `CTC ₹${Number(a.offer.ctc).toLocaleString('en-IN')}` : null,
                        a.offer.joiningDate ? `joining ${a.offer.joiningDate}` : null,
                        a.offer.documents ? `documents: ${a.offer.documents}` : null,
                        a.offer.joinedAt ? `joined ${fmtDate(a.offer.joinedAt)}` : null].filter(Boolean).join(' · ') || 'Your recruiter will share the details.'}
                    </div>
                    {a.offer.canRespond && (
                      <div className="tlp-actions">
                        <button type="button" className="btn btn-primary" onClick={() => window.confirm(`Accept the offer for ${a.jobTitle}?`) && post(`/portal/candidate/applications/${a.id}/offer`, { decision: 'accept' })}>Accept offer</button>
                        <button type="button" className="btn" onClick={() => { setAsk({ kind: 'decline', app: a }); setAskText(''); }}>Decline</button>
                      </div>
                    )}
                  </div>
                )}
                {a.canWithdraw && (
                  <div className="tlp-meta" style={{ marginTop: 6 }}>
                    {withdrawAsked(a.id)
                      ? 'You asked to withdraw — your recruiter will close this application.'
                      : <button type="button" className="link-btn" onClick={() => { setAsk({ kind: 'withdraw', app: a }); setAskText(''); }}>Withdraw this application</button>}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="You have no applications yet"
            hint="Browse the open jobs and apply with one click."
            action={<button type="button" className="btn btn-primary" onClick={() => setTab('jobs')}>See open jobs</button>}
          />
        )
      )}

      {tab === 'interviews' && (
        interviews.length ? (
          <div className="tlp-list">
            {interviews.map((i) => (
              <div className="tlp-item" key={`${i.applicationId}-${i.at}`}>
                <div className="tlp-item-title">{i.jobTitle}</div>
                <div className="tlp-meta">{i.company}</div>
                <InterviewLine iv={i} />
              </div>
            ))}
          </div>
        ) : <EmptyState icon="📅" title="No interviews scheduled yet" hint="When an interview is fixed, the date, time, mode and meeting link appear here." />
      )}

      {tab === 'profile' && (
        <div className="tlp-grid">
          <form className="tlp-card" onSubmit={saveProfile}>
            <h3>My details</h3>
            <div className="tlp-meta" style={{ marginBottom: 10 }}>{profile.name} · {profile.email} (your sign-in email)</div>
            <div className="tlp-form">
              {Object.entries(profile.fields).map(([k, label]) => (
                <label key={k}>
                  {label}
                  <input
                    type={k === 'experienceYears' ? 'number' : 'text'}
                    min={k === 'experienceYears' ? 0 : undefined}
                    step={k === 'experienceYears' ? 0.5 : undefined}
                    value={form[k] ?? ''}
                    onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                  />
                </label>
              ))}
            </div>
            <div className="tlp-actions">
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save profile'}</button>
            </div>
          </form>
          <div className="tlp-card">
            <h3>Resume</h3>
            {resume ? (
              <div className="tlp-meta">
                Current: <b>{resume.name}</b>{resume.uploadedAt ? ` · uploaded ${fmtDate(resume.uploadedAt)}` : ''}
              </div>
            ) : <div className="tlp-meta">No resume uploaded yet.</div>}
            <div className="tlp-actions">
              {resume?.downloadable && <button type="button" className="btn btn-sm" onClick={() => openFile('/portal/candidate/resume').catch(() => setError('Could not open the resume.'))}>📄 View</button>}
              <label className="btn btn-sm btn-primary" style={{ cursor: 'pointer' }}>
                {uploading ? 'Uploading…' : (resume ? 'Upload a new resume' : 'Upload resume')}
                <input ref={fileRef} type="file" accept="application/pdf" hidden onChange={uploadResume} disabled={uploading} />
              </label>
            </div>
            <div className="tlp-muted" style={{ marginTop: 8 }}>PDF only, up to 5 MB. Your recruiter sees the latest one.</div>
          </div>
          {extras && (
            <div className="tlp-card">
              <h3>Documents for joining</h3>
              {extras.documents.length
                ? extras.documents.map((d) => <div className="tlp-meta" key={d.id}><b>{d.docType}</b> · {d.name} · {fmtDate(d.createdAt)}</div>)
                : <div className="tlp-meta">No documents uploaded yet. Your recruiter will tell you which ones are needed.</div>}
              <div className="tlp-actions">
                <select value={docType} onChange={(e) => setDocType(e.target.value)} aria-label="Document type">
                  <option value="">Choose the document…</option>
                  {extras.documentTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <label className={`btn btn-sm btn-primary${docType ? '' : ' disabled'}`} style={{ cursor: docType ? 'pointer' : 'not-allowed', opacity: docType ? 1 : 0.6 }}>
                  {uploading ? 'Uploading…' : 'Upload'}
                  <input ref={docRef} type="file" accept="application/pdf,image/png,image/jpeg" hidden onChange={uploadDoc} disabled={uploading || !docType} />
                </label>
              </div>
              <div className="tlp-muted" style={{ marginTop: 8 }}>PDF, JPG or PNG, up to 5 MB.</div>
            </div>
          )}
          {extras && (
            <div className="tlp-card">
              <h3>Sign-in</h3>
              <div className="tlp-meta">
                {extras.passwordSet ? 'You have a password. You can also sign in with a code by email.' : 'You sign in with a code sent to your email. A password is optional.'}
              </div>
              <div className="tlp-actions">
                <input type="password" autoComplete="new-password" placeholder={extras.passwordSet ? 'New password' : 'Choose a password (optional)'} value={pw} onChange={(e) => setPw(e.target.value)} />
                <button type="button" className="btn btn-sm" disabled={pw.length < 8} onClick={() => post('/portal/candidate/password', { password: pw }).then(() => setPw(''))}>Save password</button>
              </div>
            </div>
          )}
          {extras && (
            <div className="tlp-card">
              <h3>Your data</h3>
              <div className="tlp-meta">
                {privacyAsked
                  ? 'Your "delete my data" request is with our team. We will contact you before anything is removed.'
                  : 'You can ask TeamLink to delete your data. A person from our team handles it and contacts you first.'}
              </div>
              {!privacyAsked && (
                <div className="tlp-actions">
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => { setAsk({ kind: 'privacy' }); setAskText(''); }}>Ask to delete my data</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {ask && (
        <Modal
          title={{ decline: 'Decline the offer', withdraw: 'Withdraw this application', privacy: 'Delete my data' }[ask.kind]}
          note={ask.app ? ask.app.jobTitle : 'Nothing is deleted straight away — our team contacts you first.'}
          onClose={() => setAsk(null)}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setAsk(null)}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={ask.kind === 'decline' && !askText.trim()}
                onClick={() => {
                  if (ask.kind === 'decline') post(`/portal/candidate/applications/${ask.app.id}/offer`, { decision: 'decline', reason: askText });
                  else if (ask.kind === 'withdraw') post(`/portal/candidate/applications/${ask.app.id}/withdraw`, { reason: askText });
                  else post('/portal/candidate/privacy-request', { reason: askText });
                }}
              >
                {{ decline: 'Decline offer', withdraw: 'Withdraw', privacy: 'Send request' }[ask.kind]}
              </button>
            </>
          )}
        >
          <label className="field">
            <span>{ask.kind === 'decline' ? 'Why? (a few words)' : 'Why? (optional)'}</span>
            <input value={askText} onChange={(e) => setAskText(e.target.value)} />
          </label>
          {error && <div className="notice red"><span>{error}</span></div>}
        </Modal>
      )}

      {tab === 'jobs' && (
        <>
          <div className="tlp-filters">
            <input placeholder="Search job title, location or department…" value={jobQ} onChange={(e) => setJobQ(e.target.value)} />
            {jobQ && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setJobQ('')}>Clear</button>}
          </div>
          <div className="tlp-list">
            {jobs.map((j) => (
              <div className="tlp-item" key={j.id}>
                <div className="tlp-item-top">
                  <div>
                    <div className="tlp-item-title">{j.title}</div>
                    <div className="tlp-meta">{[j.location, j.experience ? (/yr/i.test(j.experience) ? j.experience : `${j.experience} yrs`) : null, j.employmentType, j.workMode].filter(Boolean).join(' · ')}</div>
                    <div className="tlp-meta">Posted {fmtDate(j.postedAt)}{j.reference ? ` · ${j.reference}` : ''}</div>
                  </div>
                  {j.applied
                    ? <Chip label="Applied" tone="green" />
                    : <button type="button" className="btn btn-sm btn-primary" onClick={() => apply(j)}>Apply</button>}
                </div>
              </div>
            ))}
            {!jobs.length && <EmptyState icon="🔎" title="No open jobs match" hint="Try a different search, or check back soon." />}
          </div>
        </>
      )}
    </div>
  );
}
