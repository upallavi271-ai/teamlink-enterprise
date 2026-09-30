import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import { protoDate } from '../atsVocab';
import { CandidateActions, CurrentApplication } from './Candidate360.jsx';
import {
  C360Header, C360Tabs, candidateCode, currentAppOf, clientOf,
  ApplicationsTab, PipelineTab, InterviewsTab, SubmissionsTab, OffersTab, JoiningTab, AiScoresTab, ActivityTab, ResumeCard,
} from './Candidate360Tabs.jsx';
import { LocationRequirementsPanel } from './CandidateReach.jsx';
import './CandidateDrawer.css';

// ---------------------------------------------------------------------------
// CANDIDATE 360 — the BIG centred window (user, 2026-09-29) that opens from a
// row on Candidates & Pipeline; the full page (/candidates/:id) uses the same
// header and tabs (components/Candidate360Tabs.jsx).
//
//   header   name + ID (CAN-…) · contact · Current Application · Current
//            Stage · Next Action + who owns it
//   tabs     Overview · Resume · AI Scores · Applications · Pipeline ·
//            Interviews · Client Submissions · Offers · Joining · Activity
//
// Opened from an ATS Pipeline row, the window starts on THAT application
// (`applicationId`); picking another one on the Applications tab switches the
// current application every tab reads. Every action re-reads the window and
// calls onChanged() so the list behind it updates at once.
// ---------------------------------------------------------------------------
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

export default function CandidateDrawer({
  candidateId, applicationId = null, user, onClose, onChanged,
}) {
  const [c, setC] = useState(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [tab, setTab] = useState('overview');
  const [selectedAppId, setSelectedAppId] = useState(applicationId);

  function load() {
    setError('');
    return api.get(`/candidates/${candidateId}`)
      .then((r) => setC(r.data))
      .catch((err) => setError(err.response?.data?.error || 'This candidate could not be opened.'));
  }
  useEffect(() => {
    setC(null); setFlash(''); setSelectedAppId(applicationId); setTab('overview');
    load();
  }, [candidateId, applicationId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e) => {
      // A modal opened from the window (contact, schedule) closes itself first.
      if (e.key === 'Escape' && !document.querySelector('.overlay.show')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const app = c ? currentAppOf(c, selectedAppId) : null;
  const internal = !!(c && c.viewer && c.viewer.internal);
  const changed = async () => { await load(); if (onChanged) onChanged(); };
  const comms = (c && c.communications) || [];
  const pickApp = (id) => {
    setSelectedAppId(id);
    setTab('overview');
    const body = document.querySelector('.cdw-body');
    if (body) body.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="cdw-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="cdw cdw-tabbed" role="dialog" aria-label="Candidate 360">
        <div className="cdw-head">
          <div style={{ minWidth: 0 }}>
            <div className="cdw-name">
              {c ? c.name : 'Loading…'}
              {c && <span className="cdw-code" title={c.id}>{c.code || candidateCode(c.id)}</span>}
            </div>
            {c && (
              <div className="cdw-contact">
                {c.phone && <a href={`tel:${c.phone}`}>{c.phone}</a>}
                {c.email && <a href={`mailto:${c.email}`}>{c.email}</a>}
                {c.location && <span>{c.location}</span>}
                {c.experienceYears != null && <span>{`${c.experienceYears} yrs exp`}</span>}
                <span className="small-muted">{`${(c.applications || []).length} application(s)`}</span>
              </div>
            )}
          </div>
          <div className="cdw-headbtns">
            {c && <Link className="btn btn-sm" to={`/candidates/${c.id}`}>Open full profile →</Link>}
            <button type="button" className="cdw-x" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>

        {error && <div className="error-text" style={{ margin: '8px 16px' }}>{error}</div>}
        {!c && !error && <div className="small-muted" style={{ padding: 16 }}>Loading…</div>}

        {c && (
          <div className="cdw-top">
            <C360Header c={c} app={app} compact onBackToLatest={() => setSelectedAppId(null)} />
            <C360Tabs tab={tab} setTab={setTab} c={c} />
          </div>
        )}

        {c && (
          <div className="cdw-body is-tabbed">
            {flash && <div className="notice" style={{ marginBottom: 10 }}>{flash}</div>}

            {tab === 'overview' && (
              <>
                {c.duplicateHint && (
                  <div className="notice amber" style={{ marginBottom: 10 }}>
                    {`${c.duplicateHint.count} other profile(s) share this phone or email: ${c.duplicateHint.names.join(', ')}.`}
                    {c.duplicateHint.canMerge && <> <Link to="/candidates?view=master&sub=duplicates">Review duplicates →</Link></>}
                  </div>
                )}
                <CandidateActions c={c} app={app} user={user} onChanged={changed} onFlash={setFlash} compact />
                <div className="c360t-grid">
                  <div>
                    <section className="cdw-card">
                      <div className="cdw-label">Profile</div>
                      <div className="cdw-kv"><span>Candidate ID</span><b>{c.code || candidateCode(c.id)}</b></div>
                      <div className="cdw-kv"><span>Phone</span><b>{c.phone || '—'}</b></div>
                      <div className="cdw-kv"><span>Email</span><b>{c.email || '—'}</b></div>
                      <div className="cdw-kv"><span>Location</span><b>{c.location || '—'}</b></div>
                      <div className="cdw-kv"><span>Experience</span><b>{c.experienceYears != null ? `${c.experienceYears} yrs` : '—'}</b></div>
                      <div className="cdw-kv"><span>Source</span><b>{c.source || '—'}</b></div>
                      <div className="cdw-kv"><span>Added</span><b>{protoDate(c.createdAt)}</b></div>
                      {list(c.skills).length > 0 && (
                        <div className="c360-skills" style={{ marginTop: 6 }}>
                          {list(c.skills).slice(0, 12).map((s) => <span className="skillpill" key={s}>{s}</span>)}
                        </div>
                      )}
                    </section>
                  </div>
                  <div>
                    <section className="cdw-card">
                      <div className="cdw-label">{app && c.latestApplicationId && app.id !== c.latestApplicationId ? 'Selected application' : 'Current application'}</div>
                      <CurrentApplication
                        app={app}
                        ownership={c.ownership}
                        clientName={clientOf(app)}
                        linkTo={(a) => <Link to={`/requirements/${a.requirementId}`}>{a.requirement?.title || '—'}</Link>}
                      />
                      {(c.applications || []).length > 1 && (
                        <button type="button" className="link-btn" style={{ marginTop: 6 }} onClick={() => setTab('applications')}>
                          {`See all ${(c.applications || []).length} applications →`}
                        </button>
                      )}
                    </section>
                    {internal && (c.rejectedBy?.length > 0) && (
                      <section className="cdw-card">
                        <div className="cdw-label">Rejected by · still eligible for</div>
                        {c.rejectedBy.map((r) => (
                          <div key={r.applicationId} className="small-muted">
                            <b style={{ color: 'var(--ink)' }}>{r.clientName || '—'}</b>
                            {` · ${r.requirementTitle || ''}${r.side ? ` · ${r.side}` : ''}${r.reason ? ` · ${r.reason}` : ''}`}
                          </div>
                        ))}
                        <div className="small-muted" style={{ marginTop: 4 }}>
                          {`Still eligible for ${c.eligibleTotal ?? (c.eligibleClients || []).filter((x) => !x.rejectedEarlier).length} client(s)`}
                        </div>
                      </section>
                    )}
                  </div>
                </div>
                {internal && <LocationRequirementsPanel candidateId={c.id} compact onApplied={changed} />}
              </>
            )}

            {tab === 'resume' && <ResumeCard c={c} />}
            {tab === 'ai' && <AiScoresTab c={c} app={app} internal={internal} />}
            {tab === 'applications' && <ApplicationsTab c={c} app={app} onSelect={pickApp} />}
            {tab === 'pipeline' && <PipelineTab c={c} app={app} user={user} />}
            {tab === 'interviews' && <InterviewsTab c={c} app={app} internal={internal} />}
            {tab === 'submissions' && <SubmissionsTab c={c} />}
            {tab === 'offers' && <OffersTab c={c} />}
            {tab === 'joining' && <JoiningTab c={c} />}

            {tab === 'activity' && (
              <div className="c360t-grid">
                <div>
                  <ActivityTab c={c} internal={internal} limit={40} />
                </div>
                <div>
                  {c.viewer?.kind !== 'client' && (
                    <section className="cdw-card">
                      <div className="cdw-label">{`Communication (${comms.length})`}</div>
                      {comms.slice(0, 10).map((m) => (
                        <div key={m.id} className="cdw-note">
                          <div>{`${m.channel} · ${m.templateLabel || m.template}`}</div>
                          <div className="small-muted">{`${protoDate(m.createdAt)} · ${m.senderName || '—'} · ${m.status === 'SENT' ? 'Sent' : (m.status === 'LOGGED' ? 'Logged' : 'Not sent')}`}</div>
                        </div>
                      ))}
                      {comms.length === 0 && <div className="small-muted">No messages or calls recorded.</div>}
                    </section>
                  )}
                  {internal && (
                    <section className="cdw-card">
                      <div className="cdw-label">{`Recruiter notes (${(c.notes || []).length})`}</div>
                      {(c.notes || []).slice(0, 10).map((n) => (
                        <div key={n.id} className="cdw-note">
                          <div>{n.body}</div>
                          <div className="small-muted">{`${n.authorName || '—'} · ${protoDate(n.createdAt)}`}</div>
                        </div>
                      ))}
                      {(c.notes || []).length === 0 && <div className="small-muted">No notes yet — use Add Note on the Overview tab.</div>}
                    </section>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
