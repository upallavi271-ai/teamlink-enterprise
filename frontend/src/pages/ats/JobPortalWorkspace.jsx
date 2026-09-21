import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api';
import ClientModuleTabs from '../../components/ClientModuleTabs.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { canSeePortalApplications, canSeePortalWorkspace, canSyncPortal } from '../../permissions';
import { JOB_PORTAL_URL } from '../JobPortalRedirect.jsx';

// ---------------------------------------------------------------------------
// B. The INTERNAL Job Portal workspace.
//
//   Job Portal → Publish → Sync → Applications → Import to ATS → Pipeline
//
// It lives inside Jobs / Requirements — it is a tab of that module and a
// feature of it (`requirements` / `Job Portal Workspace`), never a top-level
// ATS module. Every row below is already scoped by the server
// (utils/scope.js), and every button is shown from the SAME answer the API
// enforces: the workspace payload carries a `permissions` object resolved by
// backend/src/utils/permissions.js, and this screen only reads it. Hiding a
// button is a courtesy; the refusal comes from the API.
//
// SYNC and OPEN JOB PORTAL ARE TWO DIFFERENT BUTTONS and two different
// permissions. Sync writes to this ATS. Open Job Portal navigates away to the
// standalone portal document. Neither implies the other.
// ---------------------------------------------------------------------------

const STEPS = [
  ['publish', 'Publish', 'Put a live requirement on the portal'],
  ['sync', 'Sync', 'Push the posting out and re-read what came back'],
  ['applications', 'Applications', 'What arrived, with its recorded source'],
  ['import', 'Import to ATS', 'Admit an arrival into the pipeline'],
];

const syncBadge = (s) => ({
  Synced: 'active', Pending: 'pending', Failed: 'failed',
}[s] || 'notconnected');

const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

export default function JobPortalWorkspace() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [apps, setApps] = useState(null);
  const [view, setView] = useState('jobs');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    api.get('/job-portal/workspace')
      .then((r) => setData(r.data))
      .catch((e) => setError(e.response?.data?.error || 'Could not load the Job Portal workspace.'));
    // The applications list is a SEPARATE permission (Job Portal
    // Applications), so it is a separate request that can refuse on its own.
    if (canSeePortalApplications(user)) {
      api.get('/job-portal/applications')
        .then((r) => setApps(r.data))
        .catch(() => setApps({ applications: [], permissions: { import: false } }));
    }
  }, [user]);
  useEffect(load, [load]);

  // One place for every write, so nothing can reject uncaught.
  function run(key, fn, ok) {
    setBusy(key); setError(''); setNotice('');
    Promise.resolve(fn())
      .then((r) => { setNotice(ok(r)); load(); })
      .catch((e) => setError(e.response?.data?.error || 'That action was refused.'))
      .finally(() => setBusy(''));
  }

  const perms = data?.permissions || {};
  const stats = data?.stats || {};
  const jobs = data?.jobs || [];
  const applications = apps?.applications || [];
  const canImport = !!apps?.permissions?.import;

  // Typing the URL is not access. The API already refuses every call this
  // screen makes, but an Accountant or an HRMS-only Employee should not be
  // shown the workspace's chrome — including "Open Job Portal", which the
  // access matrix does not give them either. Same matrix, read once.
  if (!canSeePortalWorkspace(user)) {
    return (
      <div>
        <div className="page-head"><div><h1>Job Portal</h1></div></div>
        <div className="notice red">
          The Job Portal workspace isn&apos;t included in your role&apos;s permissions. Portal access comes from an
          ATS working role — Recruiter, BDE, TL, STL, Manager or Admin — never from being an employee.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Job Portal</h1>
          <div className="page-sub">
            Jobs / Requirements → Job Portal · publishing, sync and the applications arriving from the portal, in your scope
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {/* Two buttons, deliberately. Sync writes here; Open Job Portal
              leaves for the standalone portal document. */}
          {canSyncPortal(user) && perms.sync && (
            <button
              className="btn"
              disabled={busy === 'sync'}
              onClick={() => run('sync', () => api.post('/job-portal/sync'),
                (r) => `Sync: ${r.data.synced} published requirement(s) marked Synced, ${r.data.failed} no longer live. ${r.data.note}`)}
            >
              {busy === 'sync' ? 'Syncing…' : 'Sync'}
            </button>
          )}
          <a className="btn btn-primary" href={JOB_PORTAL_URL} target="_blank" rel="noreferrer">
            Open Job Portal ↗
          </a>
        </div>
      </div>

      <ClientModuleTabs active="jobportal" />

      {error && <div className="notice red">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      {/* The flow, named, so the screen says what it is for. */}
      <div className="statbar">
        {STEPS.map(([k, label, hint]) => (
          <div className="statitem" key={k} style={{ minWidth: 170 }}>
            <div className="l" style={{ textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
            <div className="s">{hint}</div>
          </div>
        ))}
      </div>

      {/* .statbar, not .stat-row: six KPIs in a flex strip wrap on a narrow
          screen, where a hard six-column grid would not — an inline
          grid-template-columns beats the stylesheet's own media queries. */}
      <div className="statbar">
        <div className="statitem"><div className="n">{stats.requirements ?? '—'}</div><div className="l">Requirements in scope</div></div>
        <div className="statitem"><div className="n">{stats.published ?? '—'}</div><div className="l">Published</div></div>
        <div className="statitem"><div className="n">{stats.unpublished ?? '—'}</div><div className="l">Live, not published</div></div>
        <div className="statitem"><div className="n">{stats.synced ?? '—'}</div><div className="l">Synced</div></div>
        <div className="statitem"><div className="n">{stats.applications ?? '—'}</div><div className="l">Portal applications</div></div>
        <div className="statitem"><div className="n">{stats.awaitingImport ?? '—'}</div><div className="l">Awaiting import</div></div>
      </div>

      {/* WHAT IS AND IS NOT REAL. Stated on the screen, not only in a commit
          message, because the two "job portals" in this product are easy to
          confuse and a wrong assumption here loses candidates. */}
      <div className="notice amber">
        <div>
          <strong>Open Job Portal</strong> opens the standalone TeamLink Job Portal served at <code>/job-portal/</code>.
          That app is self-contained: it keeps its own jobs, its own logins and its own applications in the browser&apos;s
          <code> localStorage</code>, and <strong>no data crosses between it and this database</strong>.
          <br />
          <strong>Publish</strong> records here, in this ATS, that a requirement is being offered, and who published it when.
          <strong> Sync</strong> re-reads this ATS and marks your published requirements Synced — it contacts nothing.
          The applications listed below are the ones submitted to <em>this</em> app&apos;s job form
          (<code>/careers/classic</code>, <code>POST /api/public/jobs/:id/apply</code>), which is the only route by which an
          application reaches this database today.
        </div>
      </div>

      <div className="tabs" style={{ marginBottom: 12 }}>
        <div className={`tab${view === 'jobs' ? ' active' : ''}`} onClick={() => setView('jobs')}>
          Jobs &amp; posting status
        </div>
        {canSeePortalApplications(user) && (
          <div className={`tab${view === 'apps' ? ' active' : ''}`} onClick={() => setView('apps')}>
            Applications from the portal
          </div>
        )}
      </div>

      {view === 'jobs' && (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Req ID</th><th>Job Title</th><th>Client</th><th>Department</th>
                <th>Requirement Status</th><th>Published</th><th>Job Sync Status</th>
                <th>Applications</th><th>Action</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td><b>{j.reqCode || j.id.slice(0, 8)}</b></td>
                  <td className="row-link" onClick={() => navigate(`/requirements/${j.id}`)}>
                    <span className="link-btn">{j.title}</span>
                  </td>
                  <td className="cell-muted">{j.internal ? 'TeamLink (internal)' : j.client || '—'}</td>
                  <td className="cell-muted">{j.department || '—'}</td>
                  <td className="cell-muted">{j.statusLabel}</td>
                  <td>
                    {j.published
                      ? <span className="status active">Published{j.publishedAt ? ` · ${fmt(j.publishedAt)}` : ''}</span>
                      : <span className="status notconnected">Not published</span>}
                  </td>
                  <td><span className={`status ${syncBadge(j.portalSyncStatus)}`}>{j.portalSyncStatus}</span></td>
                  <td className="cell-muted">{j.applications}</td>
                  <td>
                    {perms.publish ? (
                      <button
                        className="btn btn-sm"
                        disabled={busy === j.id || (!j.published && !j.live)}
                        title={!j.published && !j.live ? 'Only a live requirement can be published' : ''}
                        onClick={() => run(j.id,
                          () => api.post(`/job-portal/jobs/${j.id}/publish`, { published: !j.published }),
                          () => `${j.title} ${j.published ? 'unpublished from' : 'published to'} the job portal.`)}
                      >
                        {j.published ? 'Unpublish' : 'Publish'}
                      </button>
                    ) : <span className="small-muted">View only</span>}
                  </td>
                </tr>
              ))}
              {!jobs.length && (
                <tr><td colSpan="9" className="small-muted" style={{ padding: 16 }}>
                  {data ? 'No requirements in your scope.' : 'Loading…'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {view === 'apps' && (
        <>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Candidate</th><th>Email</th><th>Applied To</th><th>Department</th>
                  <th>Source</th><th>Applied</th><th>Pipeline Stage</th><th>Imported</th><th>Action</th>
                </tr>
              </thead>
              <tbody>
                {applications.map((a) => (
                  <tr key={a.id}>
                    <td className="row-link" onClick={() => navigate(`/candidates/${a.candidateId}`)}>
                      <span className="link-btn">{a.candidate}</span>
                    </td>
                    <td className="cell-muted">{a.email || '—'}</td>
                    <td className="cell-muted">{a.reqCode ? `${a.reqCode} · ` : ''}{a.job}</td>
                    <td className="cell-muted">{a.department || '—'}</td>
                    <td><span className="status new">{a.source}</span></td>
                    <td className="cell-muted">{fmt(a.appliedAt)}</td>
                    <td className="cell-muted">{a.stageLabel}</td>
                    <td className="cell-muted">{a.imported ? fmt(a.importedAt) : '—'}</td>
                    <td>
                      {a.imported
                        ? <span className="small-muted">In pipeline</span>
                        : canImport
                          ? (
                            <button
                              className="btn btn-sm"
                              disabled={busy === a.id}
                              onClick={() => run(a.id,
                                () => api.post(`/job-portal/applications/${a.id}/import`),
                                (r) => `${a.candidate} imported to the ATS — now at ${r.data.stageLabel}.`)}
                            >
                              Import to ATS
                            </button>
                          )
                          : <span className="small-muted">View only</span>}
                    </td>
                  </tr>
                ))}
                {!applications.length && (
                  <tr><td colSpan="9" className="small-muted" style={{ padding: 16 }}>
                    No portal applications in your scope.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 6 }}>
            <strong>Import to ATS</strong> does not fetch anything. A portal application is already a pipeline row —
            the public form creates the candidate and the application when it is submitted. Import is the recorded
            act of admitting it: it stamps who imported it and when, moves it from New to Recruiter Review, and
            writes the pipeline-history entry, so it shows up in Candidates &amp; Pipeline as a reviewed arrival
            rather than an untouched inbox row.
          </div>
        </>
      )}
    </div>
  );
}
