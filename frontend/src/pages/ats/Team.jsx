import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { isClientUser } from '../../permissions';

// ---------------------------------------------------------------------------
// Recruiter & BDE — the module's five tabs, driven by ?tab= so each one is its
// own nav entry and its own bookmarkable URL:
//
//   Recruiters / BDEs / Assignments / Workload / Pending Actions
//
// Everything is read from endpoints that are already scoped server-side
// (/ats/team, /requirements, /dashboard/ats), so a TL sees their department's
// people and a recruiter sees themselves.
// ---------------------------------------------------------------------------
// §9 / §10 — THE TAB SET DEPENDS ON WHO IS LOOKING.
//
// A recruiter opening this screen was shown the whole people table — every
// recruiter, every BDE, every TL — which is a lead's view, not theirs. And a
// recruiter and a BDE do different jobs: a recruiter works REQUIREMENTS AND
// CANDIDATES, a BDE works CLIENTS AND CLIENT DECISIONS. Showing each of them
// the other's workspace is noise.
//
// So: individual contributors get their own workspace, leads get the people
// tables they are responsible for. The DATA was always scoped correctly —
// this is about not showing somebody a screen that is not their job.
const LEAD_TABS = [
  ['recruiters', 'Recruiters'],
  ['bdes', 'BDEs'],
  ['assignments', 'Assignments'],
  ['workload', 'Workload'],
  ['pending', 'Pending Actions'],
];
const RECRUITER_TABS = [
  ['mywork', 'My Work'],
  ['assignments', 'My Assignments'],
  ['pending', 'My Pending Actions'],
];
const BDE_TABS = [
  ['mywork', 'My Work'],
  ['assignments', 'My Clients & Requirements'],
  ['pending', 'Client Decisions'],
];

function PeopleTable({ rows, empty }) {
  return (
    <div className="tbl-wrap">
      <table>
        <thead>
          <tr><th>Name</th><th>Role</th><th>Open Requirements</th><th>Active Pipeline</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td>{r.roleLabel || r.role}</td>
              {r.oversight ? (
                <td colSpan="2">Oversees all recruiter &amp; BDE activity</td>
              ) : (
                <>
                  <td>{r.openRequirements}</td>
                  <td>{r.activePipeline}</td>
                </>
              )}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan="4" className="small-muted" style={{ padding: 16 }}>{empty}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function Team() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = TABS.some(([id]) => id === searchParams.get('tab')) ? searchParams.get('tab') : 'workload';

  const [rows, setRows] = useState([]);
  const [requirements, setRequirements] = useState([]);
  const [pending, setPending] = useState(null);

  useEffect(() => {
    api.get('/ats/team').then((res) => setRows(res.data)).catch(() => setRows([]));
    api.get('/requirements').then((res) => setRequirements(res.data)).catch(() => setRequirements([]));
    api.get('/dashboard/ats').then((res) => setPending(res.data)).catch(() => setPending(null));
  }, []);

  const recruiters = useMemo(() => rows.filter((r) => r.role === 'RECRUITER'), [rows]);
  const bdes = useMemo(() => rows.filter((r) => r.role === 'BDE'), [rows]);

  if (isClientUser(user)) {
    return (
      <div className="empty">
        <h3>Not available for your role</h3>
        <div>Recruiter &amp; BDE workload is internal TeamLink information and isn&apos;t part of your client scope.</div>
      </div>
    );
  }

  // The three workspaces §9/§10 describe, chosen by the ATS role.
  // The same rows the ATS home draws, so the two screens cannot disagree.
  const myWork = pending ? pending.myWork : null;
  const myWorkTitle = pending ? pending.myWorkTitle : null;
  const atsRole = (user && (user.atsRole || user.role)) || '';
  const isRecruiter = atsRole === 'RECRUITER';
  const isBde = atsRole === 'BDE';
  const TABS = isRecruiter ? RECRUITER_TABS : (isBde ? BDE_TABS : LEAD_TABS);
  const tabIds = TABS.map(([id]) => id);
  const activeTab = tabIds.includes(tab) ? tab : tabIds[0];
  const heading = isRecruiter
    ? 'My Recruiter Workspace'
    : (isBde ? 'My BDE Workspace' : 'Recruiter & BDE');
  const sub = isRecruiter
    ? 'Your requirements, your candidates and what is waiting on you.'
    : (isBde
      ? 'Your clients, the decisions they owe and the joinings that follow.'
      : 'Who is carrying what, and what is waiting on them');

  const setTab = (id) => setSearchParams({ tab: id });

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{heading}</h1>
          <div className="page-sub">{sub}</div>
        </div>
      </div>

      <div className="tabbar">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            className={'tab-btn' + (activeTab === id ? ' active' : '')}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="tab-content">
        {/* §9 / §10 — an individual contributor sees THEIR OWN work first,
            drawn from the same /dashboard/ats rows the ATS home uses, so the
            two screens cannot disagree. */}
        {activeTab === 'mywork' && (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>{myWorkTitle || 'My Work'}</th><th style={{ width: 110, textAlign: 'right' }}>Count</th></tr></thead>
              <tbody>
                {(myWork || []).map((r) => (
                  <tr key={r.label} className="row-link" onClick={() => r.to && navigate(r.to)}>
                    <td>{r.label}</td>
                    <td style={{ textAlign: 'right' }}><b>{r.value}</b></td>
                  </tr>
                ))}
                {(!myWork || myWork.length === 0) && (
                  <tr><td colSpan="2" className="small-muted" style={{ padding: 16 }}>Nothing assigned to you yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {activeTab === 'recruiters' && <PeopleTable rows={recruiters} empty="No recruiters in your scope." />}
        {activeTab === 'bdes' && <PeopleTable rows={bdes} empty="No BDEs in your scope." />}
        {activeTab === 'workload' && <PeopleTable rows={rows} empty="No recruiters or BDEs on file." />}

        {activeTab === 'assignments' && (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>Requirement</th><th>Client</th><th>Department</th><th>Recruiter</th><th>BDE</th><th>Status</th></tr>
              </thead>
              <tbody>
                {requirements.map((r) => (
                  <tr key={r.id} className="row-link" onClick={() => navigate(`/requirements/${r.id}`)}>
                    <td>{r.title}</td>
                    <td>{r.client ? r.client.name : '—'}</td>
                    <td>{r.department || '—'}</td>
                    <td>{r.recruiter ? r.recruiter.name : <span className="cell-muted">Unassigned</span>}</td>
                    <td>{r.bde ? r.bde.name : <span className="cell-muted">Unassigned</span>}</td>
                    <td>{r.status}</td>
                  </tr>
                ))}
                {requirements.length === 0 && (
                  <tr><td colSpan="6" className="small-muted" style={{ padding: 16 }}>No requirements in your scope.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'pending' && (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>Candidate</th><th>Requirement</th><th>Current Stage</th><th>Next Action</th><th>Due</th></tr>
              </thead>
              <tbody>
                {((pending && pending.queue) || []).map((r) => (
                  <tr key={r.id} className="row-link" onClick={() => navigate(r.to)}>
                    <td>{r.candidate}</td>
                    <td>{r.requirement}</td>
                    <td>{r.stageLabel}</td>
                    <td><span className="link-btn">{r.nextAction} →</span></td>
                    <td>{r.overdue ? <span className="status overdue">Overdue</span> : (r.due || '—')}</td>
                  </tr>
                ))}
                {(!pending || pending.queue.length === 0) && (
                  <tr><td colSpan="5" className="small-muted" style={{ padding: 16 }}>Nothing is pending in your scope.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
