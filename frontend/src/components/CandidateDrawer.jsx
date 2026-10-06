import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import { protoDate } from '../atsVocab';
import { can } from '../permissions';
import { CandidateActions, CurrentApplication } from './Candidate360.jsx';
import {
  C360Header, C360Tabs, candidateCode, currentAppOf, clientOf, tabKeyOf,
  ApplicationsMini, ApplicationsFullTab, NotesTab, DocumentsTab,
} from './Candidate360Tabs.jsx';
import { LocationRequirementsPanel } from './CandidateReach.jsx';
import './CandidateDrawer.css';
// cand7_: the profile top + the other agents' mount points.
import ProfileTop from './candidate/ProfileTop.jsx';
import ProfileLeft from './candidate/ProfileLeft.jsx';
import { RecordDocuments } from './candidate/CandidateRecord.jsx'; // ATS-100 B5
import {
  FitSlot, AlsoGoodFitSlot, RejectionHistorySlot, HistoryTimelineSlot,
} from './candidate/ProfileSlots.jsx';

// ---------------------------------------------------------------------------
// CANDIDATE PROFILE — the BIG centred window (user, 2026-09-29) that opens from
// a row or a board card on Candidates; the full page (/candidates/:id) has the
// same top, tabs and slots.
//
//   top    initials · name · phone · email · location · current step, and the
//          big Call / WhatsApp / Mail / SMS buttons (ContactButtons slot)
//   strip  Current application · Current step · Next step + who owns it
//   tabs   Overview · Resume · Applications · Fit · History · Notes · Documents
//          (Candidates §7, 2026-10-03 — was ten tabs; nothing was dropped:
//          Pipeline / Interviews / Client Submissions / Offers / Joining are
//          sections of Applications, AI Scores is Fit, Activity is History)
//
// Opened from a pipeline row, the window starts on THAT application
// (`applicationId`); picking another one switches what every tab reads. Every
// action re-reads the window and calls onChanged() so the list updates.
// ---------------------------------------------------------------------------
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

export default function CandidateDrawer({
  candidateId, applicationId = null, user, onClose, onChanged,
}) {
  const [c, setC] = useState(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [tab, setTabRaw] = useState('applications');
  const setTab = (k) => setTabRaw(tabKeyOf(k));
  const [selectedAppId, setSelectedAppId] = useState(applicationId);
  const [refreshKey, setRefreshKey] = useState(0);

  function load() {
    setError('');
    return api.get(`/candidates/${candidateId}`)
      .then((r) => setC(r.data))
      .catch((err) => setError(err.response?.data?.error || 'Could not open this person. Please try again.'));
  }
  useEffect(() => {
    setC(null); setFlash(''); setSelectedAppId(applicationId); setTabRaw('applications');
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
  const changed = async () => { setRefreshKey((n) => n + 1); await load(); if (onChanged) onChanged(); };
  const comms = (c && c.communications) || [];
  const pickApp = (id) => {
    setSelectedAppId(id);
    const body = document.querySelector('.cdw-body');
    if (body) body.scrollTo({ top: 0, behavior: 'smooth' });
  };
  async function addToJob(requirementId) {
    await api.post('/applications', { candidateId: c.id, requirementId });
    await changed();
  }
  async function addNote(body) {
    try {
      await api.post(`/candidates/${c.id}/notes`, { body });
      setFlash('Note saved.');
      await load();
      return true;
    } catch (err) {
      setFlash(err.response?.data?.error || 'Could not save the note. Please try again.');
      return false;
    }
  }
  const slot = {
    c, app, user, internal, onChanged: changed, onAddToJob: addToJob, onSeeTab: setTab,
  };

  return (
    <div className="cdw-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="cdw cdw-tabbed" role="dialog" aria-label="Candidate profile">
        <div className="cdw-head">
          <div style={{ minWidth: 0 }} className="small-muted">
            {c ? `Profile · ${c.code || candidateCode(c.id)} · ${(c.applications || []).length} application(s)` : 'Loading…'}
          </div>
          <div className="cdw-headbtns">
            {c && <Link className="btn btn-sm" to={`/candidates/${c.id}`}>Open full page →</Link>}
            <button type="button" className="cdw-x" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>

        {error && <div className="error-text" style={{ margin: '8px 16px' }}>{error}</div>}
        {!c && !error && <div className="small-muted" style={{ padding: 16 }}>Loading…</div>}

        {c && (
          <div className="cdw-top">
            <ProfileTop c={c} app={app} internal={internal} onChanged={changed} />
            <C360Header c={c} app={app} compact onBackToLatest={() => setSelectedAppId(null)} />
          </div>
        )}

        {c && (
          <div className="cdw-body is-tabbed">
            {/* ATS layout v3: left = personal info, resume, skills, CTC, notice;
                right = Applications · Notes · Documents · Timeline. */}
            <div className="pfl-frame">
            <ProfileLeft c={c} user={user} internal={internal} slot={slot} onChanged={changed} onDeleted={() => { if (onChanged) onChanged(); onClose(); }} />
            <div className="pfl-right">
            <C360Tabs tab={tab} setTab={setTab} c={c} className="pfl-tabs" />
            {flash && <div className="notice" style={{ marginBottom: 10 }}>{flash}</div>}

            {tab === 'applications' && (
              <>
                {c.profileStatus === 'Archived' && (
                  <div className="notice amber" style={{ marginBottom: 10 }}>This person is archived — hidden from every list. Nothing was deleted.</div>
                )}
                {c.duplicateHint && (
                  <div className="notice amber" style={{ marginBottom: 10 }}>
                    {`${c.duplicateHint.count} other profile(s) share this phone or email: ${c.duplicateHint.names.join(', ')}.`}
                    {c.duplicateHint.canMerge && <> <Link to="/candidates?view=master&sub=duplicates">Review duplicates →</Link></>}
                  </div>
                )}
                <CandidateActions c={c} app={app} user={user} onChanged={changed} onFlash={setFlash} compact />
                {/* The result per client: Job · Client · Step · Fit · Status. */}
                <ApplicationsMini c={c} app={app} onSelect={pickApp} />
                <section className="cdw-card">
                  <div className="cdw-label">{app && c.latestApplicationId && app.id !== c.latestApplicationId ? 'Selected application' : 'Current application'}</div>
                  <CurrentApplication
                    app={app}
                    ownership={c.ownership}
                    clientName={clientOf(app)}
                    linkTo={(a) => <Link to={`/requirements/${a.requirementId}`}>{a.requirement?.title || '—'}</Link>}
                  />
                </section>
                <RejectionHistorySlot {...slot} />
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
              </>
            )}

            {tab === 'applications' && (
              <ApplicationsFullTab
                c={c}
                app={app}
                user={user}
                internal={internal}
                onSelect={(c.applications || []).length ? pickApp : null}
                extra={internal ? <LocationRequirementsPanel candidateId={c.id} compact onApplied={changed} /> : null}
                hideList
              />
            )}
            {/* Fit (was its own tab): AI scores, the match detail, jobs this person fits. */}
            {tab === 'applications' && internal && (
              <>
                <div className="pfl-label" style={{ marginTop: 12 }}>Fit</div>
                <FitSlot {...slot} />
                <AlsoGoodFitSlot {...slot} />
              </>
            )}

            {tab === 'history' && (
              <div className="c360t-grid">
                <div>
                  <HistoryTimelineSlot {...slot} refreshKey={refreshKey} />
                </div>
                <div>
                  {c.viewer?.kind !== 'client' && (
                    <section className="cdw-card">
                      <div className="cdw-label">{`Messages and calls (${comms.length})`}</div>
                      {comms.slice(0, 15).map((m) => (
                        <div key={m.id} className="cdw-note">
                          <div>{`${m.channel} · ${m.templateLabel || m.template}`}</div>
                          <div className="small-muted">{`${protoDate(m.createdAt)} · ${m.senderName || '—'} · ${m.status === 'SENT' ? 'Sent' : (m.status === 'LOGGED' ? 'Logged' : 'Not sent')}`}</div>
                        </div>
                      ))}
                      {comms.length === 0 && <div className="small-muted">No messages or calls yet.</div>}
                    </section>
                  )}
                </div>
              </div>
            )}

            {tab === 'notes' && internal && (
              <NotesTab c={c} canAdd={can(user, 'ats', 'candidates', 'Candidate Master', 'edit')} onAdd={addNote} />
            )}
            {/* ATS-100 B5: certifications + documents with a real file (upload / view / download / delete). */}
            {tab === 'documents' && <RecordDocuments c={c} internal={internal} />}
            </div>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
