import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import RequirementForm from '../components/RequirementForm.jsx';
import ScopeLine from '../components/ScopeLine.jsx';
import {
  deptOptions, LOCS, PRIORITIES, priorityBadgeClass,
  requirementStatusLabel, requirementBadgeClass, requirementIsLive, REQUIREMENT_STATUS_CODES,
  agreementStatusLabel,
} from '../atsVocab';
import { useAuth } from '../context/AuthContext.jsx';
import { canRaiseRequirement } from '../permissions';
import ClientModuleTabs from '../components/ClientModuleTabs.jsx';
import Combo from '../components/Combo.jsx';

// The prototype's Jobs / Requirements screen: requirementListShell() (6917),
// renderRequirementList() (6937), openRequirementsHtml() (6832),
// agreementMonthHtml() (6906) and the Create Requirement modal
// openAddRequirementModal() (6956) with its seven lettered sections.

const MONTH = (value) => {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return { key: d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }), at: d };
};

export default function Requirements() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [requirements, setRequirements] = useState([]);
  const [clients, setClients] = useState([]);
  const [team, setTeam] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [notice, setNotice] = useState('');
  // The prototype's three views: All Requirements / Open Requirements /
  // Agreement Report. They are sub-views of the Requirements TAB now — the
  // module's own tab strip (Clients · Requirements · Agreements · Job Portal)
  // sits above them.
  const [view, setView] = useState('all');

  // ONE consistent filter set across both list views, exactly as specified:
  //   Department · Client · Location · Recruiter · TL · BDE · Status ·
  //   Priority · Date Range
  // Applied SERVER-SIDE (GET /requirements?…), so a filter can only narrow
  // what the signed-in user is already allowed to see.
  const [filters, setFilters] = useState({
    search: '', department: '', clientId: '', location: '',
    recruiterId: '', tlId: '', bdeId: '', status: '', priority: '', from: '', to: '',
  });
  const setFilter = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const clearFilters = () => setFilters({
    search: '', department: '', clientId: '', location: '',
    recruiterId: '', tlId: '', bdeId: '', status: '', priority: '', from: '', to: '',
  });
  const activeFilterCount = Object.entries(filters).filter(([, v]) => v).length;


  function load() {
    const params = {};
    Object.entries(filters).forEach(([k, v]) => { if (v) params[k] = v; });
    api.get('/requirements', { params }).then((res) => setRequirements(res.data));
  }
  useEffect(load, [filters]);
  useEffect(() => {
    api.get('/clients').then((res) => setClients(res.data)).catch(() => setClients([]));
    // The assignment picker's source — scoped server-side.
    api.get('/requirements/assignable-people').then((res) => setTeam(res.data)).catch(() => {
      api.get('/ats/team').then((r) => setTeam(r.data)).catch(() => setTeam([]));
    });
  }, []);

  // /requirements/assignable-people returns atsRole; the older /ats/team
  // fallback returns role. Read whichever the response carries.
  const roleOf = (t) => t.atsRole || t.role;
  const recruiters = team.filter((t) => roleOf(t) === 'RECRUITER');
  const bdes = team.filter((t) => roleOf(t) === 'BDE');
  const tls = team.filter((t) => roleOf(t) === 'TL');
  const stls = team.filter((t) => roleOf(t) === 'STL');

  const clientNameOf = (r) => (r.internal ? 'TeamLink Internal' : r.client?.name || '—');

  // The server already applied every filter; these are just the two views.
  const rows = requirements;
  const openRows = useMemo(() => requirements.filter((r) => requirementIsLive(r.status)), [requirements]);

  // The prototype's agreementMonthReport() — counts derived from each client's
  // own agreement milestones, months with no activity are not shown.
  const agreementMonths = useMemo(() => {
    const months = {};
    const bump = (value, key) => {
      const m = MONTH(value);
      if (!m) return;
      months[m.key] = months[m.key] || { created: 0, signed: 0, active: 0, expired: 0, pending: 0, at: m.at };
      months[m.key][key] += 1;
    };
    clients.forEach((c) => {
      bump(c.createdAt, 'created');
      if (c.agreementSignedAt) bump(c.agreementSignedAt, 'signed');
      if (c.agreementStatus === 'ACTIVE') bump(c.agreementActivatedAt || c.agreementSignedAt || c.createdAt, 'active');
      if (c.agreementStatus === 'EXPIRED') bump(c.agreementEnd, 'expired');
      if (['DRAFT', 'SENT'].includes(c.agreementStatus)) bump(c.createdAt, 'pending');
    });
    return Object.entries(months).sort((a, b) => a[1].at - b[1].at);
  }, [clients]);


  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Jobs / Requirements</h1>
          <div className="page-sub">
            <ScopeLine user={user} count={requirements.length} noun="requirement" />
          </div>
        </div>
        {canRaiseRequirement(user) && (
          <button className="btn btn-primary" onClick={() => { setNotice(''); setShowForm(true); }}>
            Add Requirement
          </button>
        )}
      </div>

      {/* Clients and Requirements are one module now — this is its tab strip. */}
      <ClientModuleTabs active="requirements" />

      {notice && <div className="notice amber">{notice}</div>}

      <div className="tabs" style={{ marginBottom: 12 }}>
        <div className={`tab${view === 'all' ? ' active' : ''}`} onClick={() => setView('all')}>All Requirements</div>
        <div className={`tab${view === 'open' ? ' active' : ''}`} onClick={() => setView('open')}>Open Requirements</div>
        <div className={`tab${view === 'agreements' ? ' active' : ''}`} onClick={() => setView('agreements')}>Agreement Report</div>
      </div>

      {/* ONE filter set, shared by both list views, applied server-side:
          Department · Client · Location · Recruiter · TL · BDE · Status ·
          Priority · Date Range. */}
      {view !== 'agreements' && (
        <>
          <div className="filter-row">
            <input
              type="text"
              placeholder="Search title, skill or REQ id…"
              value={filters.search}
              onChange={(e) => setFilter({ search: e.target.value })}
            />
            <Combo value={filters.department} onChange={(e) => setFilter({ department: e.target.value })}>
              <option value="">All departments</option>
              {deptOptions(user).map((d) => <option key={d} value={d}>{d}</option>)}
            </Combo>
            <Combo value={filters.clientId} onChange={(e) => setFilter({ clientId: e.target.value })}>
              <option value="">All clients</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Combo>
            <Combo value={filters.location} onChange={(e) => setFilter({ location: e.target.value })}>
              <option value="">All locations</option>
              {LOCS.map((l) => <option key={l} value={l}>{l}</option>)}
            </Combo>
            <Combo value={filters.recruiterId} onChange={(e) => setFilter({ recruiterId: e.target.value })}>
              <option value="">All recruiters</option>
              {recruiters.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Combo>
            <Combo value={filters.tlId} onChange={(e) => setFilter({ tlId: e.target.value })}>
              <option value="">All TLs</option>
              {tls.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Combo>
            <Combo value={filters.bdeId} onChange={(e) => setFilter({ bdeId: e.target.value })}>
              <option value="">All BDEs</option>
              {bdes.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Combo>
            <Combo value={filters.status} onChange={(e) => setFilter({ status: e.target.value })}>
              <option value="">All statuses</option>
              <option value="LIVE">Live (open → candidates available)</option>
              {REQUIREMENT_STATUS_CODES.map((s) => <option key={s} value={s}>{requirementStatusLabel(s)}</option>)}
            </Combo>
            <Combo value={filters.priority} onChange={(e) => setFilter({ priority: e.target.value })}>
              <option value="">All priorities</option>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </Combo>
            <input type="date" title="Created from" value={filters.from} onChange={(e) => setFilter({ from: e.target.value })} />
            <input type="date" title="Created to" value={filters.to} onChange={(e) => setFilter({ to: e.target.value })} />
            {activeFilterCount > 0 && (
              <button className="btn btn-sm btn-ghost" onClick={clearFilters}>{`Clear ${activeFilterCount} filter(s)`}</button>
            )}
          </div>
          <div className="cell-muted" style={{ fontSize: 11.5, marginBottom: 10 }}>
            Filters run on the server against your own scope — they narrow what you may see, never widen it.
          </div>
        </>
      )}

      {view === 'all' && (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Requirement ID</th><th>Job Title</th><th>Client</th><th>Department</th><th>Location</th>
                <th>Experience</th><th>Recruiter</th><th>TL</th><th>BDE</th>
                <th>Priority</th><th>Openings</th><th>Target Date</th><th>Portal Sync</th><th>Status</th>{/* §13/§14 */}<th>Next Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="row-link" onClick={() => navigate(`/requirements/${r.id}`)}>
                  <td><b>{r.reqCode || r.id.slice(0, 8)}</b></td>
                  <td>{r.title}</td>
                  <td className="cell-muted">{clientNameOf(r)}</td>
                  <td className="cell-muted">{r.department || '—'}</td>
                  <td className="cell-muted">{r.location || '—'}</td>
                  <td className="cell-muted">{r.experience || '—'}</td>
                  <td className="cell-muted">
                    {r.recruiter?.name || '—'}
                    {r.coRecruiterNames?.length ? ` +${r.coRecruiterNames.length}` : ''}
                  </td>
                  <td className="cell-muted">{r.tlName || r.tl || '—'}</td>
                  <td className="cell-muted">{r.bde?.name || '—'}</td>
                  <td><span className={`status ${priorityBadgeClass(r.priority)}`}>{r.priority}</span></td>
                  <td>{r.openings}</td>
                  <td className="cell-muted">{r.targetDate || r.closingDate || '—'}</td>
                  <td className="cell-muted">{r.portalSyncStatus || 'Not Synced'}</td>
                  <td><span className={`status ${requirementBadgeClass(r.status)}`}>{requirementStatusLabel(r.status)}</span></td>
                  {/* §13 / §14 — STATUS is what is happening; this is what to
                      DO about it. Using the status as the action is what makes
                      a list read like a database instead of a worklist. */}
                  <td>
                    {r.nextAction || <span className="small-muted">—</span>}
                    {r.owner && (
                      <div className="small-muted" style={{ fontSize: 11 }}>
                        {r.owner}{r.ownerRole ? ` · ${r.ownerRole}` : ''}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan="14" className="small-muted" style={{ padding: 16 }}>No requirements match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {view === 'open' && (
        <>
          <div className="cell-muted" style={{ fontSize: 12, marginBottom: 8 }}>
            {`${openRows.length} live requirement(s) — Open, Recruiter Assigned, Sourcing or Candidates Available.`}
          </div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Requirement ID</th><th>Job Title</th><th>Client / Internal</th><th>Department</th><th>Location</th>
                  <th>Openings</th><th>Filled</th><th>Remaining</th><th>Matching</th><th>Recruiter</th><th>TL</th><th>BDE</th>
                  <th>Priority</th><th>Created</th><th>Closing</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {openRows.map((r) => (
                  <tr key={r.id} className="row-link" onClick={() => navigate(`/requirements/${r.id}`)}>
                    <td><b>{r.reqCode || r.id.slice(0, 8)}</b></td>
                    <td>{r.title}</td>
                    <td className="cell-muted">{clientNameOf(r)}</td>
                    <td className="cell-muted">{r.department || '—'}</td>
                    <td className="cell-muted">{r.location || '—'}</td>
                    <td className="cell-muted">{r.openings || 1}</td>
                    <td className="cell-muted">{r.filled ?? 0}</td>
                    <td><b>{r.remaining ?? r.openings}</b></td>
                    <td onClick={(e) => { e.stopPropagation(); navigate(`/requirements/${r.id}`); }}>
                      <span className="link-btn">{r.matchingCandidates ?? 0}</span>
                    </td>
                    <td className="cell-muted">{r.recruiter?.name || '—'}</td>
                    <td className="cell-muted">{r.tlName || r.tl || "—"}</td>
                    <td className="cell-muted">{r.bde?.name || '—'}</td>
                    <td className="cell-muted">{r.priority || '—'}</td>
                    <td className="cell-muted">{r.createdAt ? new Date(r.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}</td>
                    <td className="cell-muted">{r.closingDate || '—'}</td>
                    <td><span className={`status ${requirementBadgeClass(r.status)}`}>{requirementStatusLabel(r.status)}</span></td>
                  </tr>
                ))}
                {openRows.length === 0 && (
                  <tr><td colSpan="17" className="small-muted" style={{ padding: 16 }}>No open requirements in your scope.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {view === 'agreements' && (
        agreementMonths.length === 0
          ? <div className="empty-mini">No agreement activity recorded yet.</div>
          : (
            <>
              <div className="tbl-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Month</th><th>Agreements Created</th><th>Signed</th><th>Active</th><th>Expired</th><th>Pending</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agreementMonths.map(([key, m]) => (
                      <tr key={key}>
                        <td><b>{key}</b></td>
                        <td>{m.created}</td>
                        <td className="cell-muted">{m.signed}</td>
                        <td className="cell-muted">{m.active}</td>
                        <td className="cell-muted">{m.expired}</td>
                        <td className="cell-muted">{m.pending}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                Computed from each client&apos;s agreement history — months with no activity are not shown.
              </div>
            </>
          )
      )}

      {showForm && (
        <RequirementForm
          mode="create"
          clients={clients}
          team={team}
          onClose={() => setShowForm(false)}
          onSaved={(saved) => {
            // The agreement gate parks a client requirement at Agreement Check
            // rather than refusing the save — say so instead of pretending it
            // went live.
            if (saved?.gateNote) setNotice(saved.gateNote);
            setShowForm(false);
            load();
          }}
        />
      )}
    </div>
  );
}
