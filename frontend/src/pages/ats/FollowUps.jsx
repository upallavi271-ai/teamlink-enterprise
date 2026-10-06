import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import api from '../../api';
import { PanelPad, EmptyMini } from '../../components/proto.jsx';
import AtsDataTools from '../../components/AtsDataTools.jsx';
import ListFilterBar, { useListFilters, ListEmpty } from '../../components/ui/ListFilters.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import HierarchyFilter, { EMPTY_HIERARCHY, toParams, hierarchyChips, useHierarchy } from '../../components/HierarchyFilter.jsx';
import FilterChips from '../../components/FilterChips.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { can } from '../../permissions';
// The per-step rules table moved to Administration → Step timing (pages/admin/AtsAlertSettings.jsx).

// ---------------------------------------------------------------------------
// THE FOLLOW-UP DASHBOARD (§21-§25) and DO THIS NOW (§27).
//
// The shape of this page is decided by the SERVER, from the caller's role —
// /followups/dashboard answers with `mine` for everybody, `team` for a lead,
// `health` for an admin and `escalation` for a Super Admin. Asking the browser
// to choose would be a lie, because a recruiter requesting the admin view
// would still only be answered about their own scope.
//
// DO THIS NOW IS FIRST AND IT IS SHORT. The whole point of §27 is that a user
// should not have to go looking for their own work: at most five things, most
// overdue first, each with one button.
// ---------------------------------------------------------------------------

const TONE = {
  Overdue: 'fu-overdue',
  'Due Today': 'fu-due',
  Upcoming: 'fu-upcoming',
  Completed: 'fu-done',
};
// Four colours only: red problem · orange waiting · blue going on · green done.
const DOT = {
  Overdue: '🔴', 'Due Today': '🟠', Upcoming: '🔵', Completed: '🟢',
};
// Everyday words for the server's status values (the values themselves are
// unchanged — they are what the API filters on).
const WORD = { Overdue: 'Late', 'Due Today': 'Due today', Upcoming: 'Upcoming', Completed: 'Done' };
const word = (s) => WORD[s] || s;
// Never a bare zero.
const n0 = (n) => (Number(n) > 0 ? n : '—');

function Tiles({ t }) {
  return (
    <div className="fu-tiles">
      {[
        ['Overdue', t.overdue], ['Due Today', t.dueToday],
        ['Upcoming', t.upcoming], ['Completed', t.completed],
      ].map(([label, n]) => (
        <div className={`fu-tile ${TONE[label]}`} key={label}>
          <span className="fu-tile-n">{n0(n)}</span>
          <span className="fu-tile-l">{DOT[label]} {word(label)}</span>
        </div>
      ))}
    </div>
  );
}

// FILTERS (user notes #1 / #11, review #3 §14 / §21 / §22).
//   Page level   Department → Section → TL → Recruiter (HierarchyFilter — a
//                recruiter sees no levels; a TL only their own recruiters),
//                sent to the server, so every panel below narrows together.
//   My Follow-ups  Search · Status · Method | More: Stage · Client (client desk
//                only) · Due date range, Sort, 25/50/100 rows.
//   Team table   Search owner · Role, 25/50/100 rows.
const MINE_SORTS = [
  { key: 'urgent', label: 'Most urgent first', cmp: null },
  { key: 'due', label: 'Due date — soonest', cmp: (a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')) },
  { key: 'dueLate', label: 'Due date — latest', cmp: (a, b) => String(b.dueDate || '').localeCompare(String(a.dueDate || '')) },
  { key: 'name', label: 'Name A–Z', cmp: (a, b) => String(a.candidateName || '').localeCompare(String(b.candidateName || '')) },
];

function Rows({ rows, empty }) {
  if (!rows.length) return empty && typeof empty === 'object' ? empty : <EmptyMini>{empty}</EmptyMini>;
  return (
    <div className="tbl-wrap">
      <table>
        <thead>
          <tr>
            <th style={{ width: 120 }}>Due</th>
            <th>Person</th>
            <th>Purpose</th>
            <th style={{ width: 110 }}>Method</th>
            <th style={{ width: 120 }}>Status</th>
            <th style={{ width: 110 }}>Next</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f.applicationId}>
              <td className="cell-muted">
                {f.dueDate || '—'}{f.dueTime ? ` ${f.dueTime}` : ''}
              </td>
              <td className="row-link">
                <Link to={`/candidates/${f.candidateId}`}>{f.candidateName}</Link>
                <div className="small-muted" style={{ fontSize: 11 }}>{f.requirementTitle}</div>
              </td>
              <td className="cell-muted">{f.purpose || f.nextAction}</td>
              <td className="cell-muted">{f.contactMode || '—'}</td>
              <td><span className={`fu-chip ${TONE[f.status]}`}>{DOT[f.status]} {word(f.status)}</span></td>
              <td>
                <Link className="btn btn-sm btn-primary" to={`/candidates/${f.candidateId}`}>
                  {f.status === 'Upcoming' ? 'View' : 'Contact'}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// /ats/followups is a TAB of Recruiter & BDE now (user, 2026-10-03: no extra
// modules). The old address opens that tab; a login without the Recruiter &
// BDE page keeps the stand-alone screen, so nobody loses it.
export function FollowUpsRoute() {
  const { user } = useAuth();
  if (can(user, null, 'recruiterbde', 'Team View', 'view')) return <Navigate to="/ats/team?view=followups" replace />;
  return <FollowUps />;
}

// embedded: drawn inside Recruiter & BDE (no page title of its own).
export default function FollowUps({ embedded = false }) {
  const { user } = useAuth();
  const clientDesk = can(user, null, 'clients', 'Client List', 'view');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [hier, setHier] = useState(EMPTY_HIERARCHY);
  const tree = useHierarchy();
  const hierKey = JSON.stringify(toParams(hier, tree.data));
  const lv = (tree.data && tree.data.viewer && tree.data.viewer.levels) || {};
  const showHier = !!(lv.department || lv.section || lv.tl || lv.recruiter);

  const load = useCallback(() => {
    api.get('/followups/dashboard', { params: { rows: 'all', ...JSON.parse(hierKey) } })
      .then((r) => { setData(r.data); setError(''); })
      .catch((err) => setError(err.response?.data?.error || (err.response?.status === 403
        ? 'Follow-ups are not part of your role.'
        : 'Could not load follow-ups. Please try again.')));
  }, [hierKey]);
  useEffect(load, [load]);

  const mineLf = useListFilters((data && data.mine && data.mine.rows) || [], [
    { key: 'q', type: 'search', placeholder: 'Search name, job or purpose…', get: (f) => `${f.candidateName || ''} ${f.requirementTitle || ''} ${f.requirementCode || ''} ${f.purpose || f.nextAction || ''}` },
    { key: 'status', label: 'Status', primary: true, get: (f) => f.status, options: ['Overdue', 'Due Today', 'Upcoming', 'Completed'] },
    { key: 'method', label: 'Method', primary: true, get: (f) => f.contactMode },
    { key: 'stage', label: 'Step', get: (f) => f.stageLabel },
    { key: 'client', label: 'Client', get: (f) => f.clientName, show: clientDesk },
    { key: 'due', type: 'daterange', label: 'Due date', get: (f) => f.dueDate },
  ], { sorts: MINE_SORTS });
  const minePage = usePaged(mineLf.rows);

  const teamLf = useListFilters((data && data.team && data.team.owners) || [], [
    { key: 'q', type: 'search', placeholder: 'Search owner…', get: (o) => o.owner },
    { key: 'role', label: 'Role', primary: true, get: (o) => o.ownerRole },
  ], {
    sorts: [
      { key: 'overdue', label: 'Most late first', cmp: null },
      { key: 'name', label: 'Owner A–Z', cmp: (a, b) => String(a.owner || '').localeCompare(String(b.owner || '')) },
    ],
  });
  const teamPage = usePaged(teamLf.rows);

  if (error) return <div className="error-text">{error}</div>;
  if (!data) return <div className="small-muted">Loading follow-ups…</div>;

  return (
    <div>
      {/* The Shell already draws the breadcrumb — no second one here. */}
      <div className="page-head">
        <div>
          {!embedded && <h1>Follow-ups</h1>}
          <div className="page-sub">
            Who to contact, why, and by when.
            {data.scope ? <>{' · '}<b className="scope-tag">Your area: {data.scope}</b></> : null}
          </div>
        </div>
        {/* Template · Import · Export: every follow-up in your scope
            (GET /followups) and follow-up updates recorded as the dialog does. */}
        <AtsDataTools module="followups" kinds={['followups']} onImported={load} />
      </div>

      {/* Department → Section → TL → Recruiter — draws nothing for a login
          that only sees its own follow-ups. Narrows every panel below. */}
      {showHier && (
        <div className="filter-row">
          <HierarchyFilter value={hier} onChange={setHier} />
        </div>
      )}
      <FilterChips filters={hierarchyChips(hier, tree.data, setHier)} onClearAll={() => setHier(EMPTY_HIERARCHY)} />

      {/* §27 — first, short, and each one has a button. */}
      <div className="card section do-now">
        <h3>Do this now</h3>
        {data.doThisNow.length === 0
          ? <EmptyMini>Nothing late or due today. You&apos;re all caught up.</EmptyMini>
          : (
            <ol className="do-now-list">
              {data.doThisNow.map((d) => (
                <li key={d.applicationId}>
                  <span className="do-now-what">
                    <b>{d.what}</b>
                    <span className="small-muted"> — {d.why}</span>
                  </span>
                  <span className={`fu-chip ${TONE[d.status]}`}>{DOT[d.status]} {word(d.status)}{d.due ? ` · ${d.due}` : ''}</span>
                  <Link className="btn btn-sm btn-primary" to={`/candidates/${d.candidateId}`}>Contact</Link>
                </li>
              ))}
            </ol>
          )}
      </div>

      {/* §21 */}
      <PanelPad style={{ marginTop: 14 }}>
        <h3>My follow-ups</h3>
        <Tiles t={data.mine} />
        <ListFilterBar lf={mineLf} storageKey="fu-mine" noun="follow-ups" />
        <Rows
          rows={minePage.slice}
          empty={mineLf.activeCount ? <ListEmpty lf={mineLf} noun="follow-ups" /> : 'No follow-ups for you right now.'}
        />
        {mineLf.rows.length > 0 && <Pager page={minePage} noun="follow-ups" />}
      </PanelPad>

      {/* §22 / §23 — who has not followed up, answered directly. */}
      {data.team && (
        <PanelPad style={{ marginTop: 14 }}>
          <h3>{data.team.label}</h3>
          <Tiles t={data.team} />
          {data.team.owners.length > 0 && <ListFilterBar lf={teamLf} storageKey="fu-team" noun="owners" />}
          {data.team.owners.length === 0
            ? <EmptyMini>No one else in your area has follow-ups.</EmptyMini>
            : teamLf.rows.length === 0 ? <ListEmpty lf={teamLf} noun="owners" /> : (
              <>
              <div className="tbl-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Owner</th><th style={{ width: 120 }}>Role</th>
                      <th style={{ width: 110 }}>🔴 Late</th>
                      <th style={{ width: 110 }}>🟠 Due today</th>
                      <th style={{ width: 110 }}>🔵 Upcoming</th>
                    </tr>
                  </thead>
                  <tbody>
                    {teamPage.slice.map((o) => (
                      <tr key={o.ownerUserId || o.owner}>
                        <td><b>{o.owner}</b></td>
                        <td className="cell-muted">{o.ownerRole}</td>
                        <td className={o.overdue ? 'fu-num-bad' : 'cell-muted'}>{n0(o.overdue)}</td>
                        <td className="cell-muted">{n0(o.dueToday)}</td>
                        <td className="cell-muted">{n0(o.upcoming)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager page={teamPage} noun="owners" />
              </>
            )}
        </PanelPad>
      )}

      {/* §24 */}
      {data.health && (
        <PanelPad style={{ marginTop: 14 }}>
          <h3>All follow-ups</h3>
          <Tiles t={data.health} />
          {(data.health.unassigned > 0 || data.health.escalated > 0) && (
            <div className="small-muted">
              {data.health.unassigned > 0 && <><b>{data.health.unassigned}</b> have no owner — give them one.</>}
              {data.health.unassigned > 0 && data.health.escalated > 0 && ' · '}
              {data.health.escalated > 0 && <><b>{data.health.escalated}</b> sent up to a lead.</>}
            </div>
          )}
        </PanelPad>
      )}

      {/* §25 — only genuinely unresolved items are on the ladder. */}
      {data.escalation && (
        <PanelPad style={{ marginTop: 14 }}>
          <h3>Sent up to a lead</h3>
          <div className="fu-ladder">
            {data.escalation.map((r) => (
              <div className={`fu-rung${r.count ? ' has-any' : ''}`} key={r.level}>
                <span className="fu-rung-n">{n0(r.count)}</span>
                <span className="fu-rung-l">
                  Level {r.level} — {r.label}
                  {r.afterDays ? <span className="small-muted"> · after {r.afterDays}d</span> : null}
                </span>
              </div>
            ))}
          </div>
          <div className="small-muted" style={{ marginTop: 8 }}>
            It leaves this list once it is done. The owner still does the work.
          </div>
        </PanelPad>
      )}

      {/* C1 (2026-10-03): when a follow-up is due, per step. Only the people
          who can open Step timing (Super Admin / Admin) see this pointer. */}
      {user && ['SUPER_ADMIN', 'ADMIN'].includes(user.role) && (
        <PanelPad style={{ marginTop: 14 }}>
          {/* One screen for every per-step day: Administration → Company Setup → Step timing. */}
          <b>Due days per step</b> are set in <Link to="/admin/step-timing">Step timing</Link>.
        </PanelPad>
      )}
    </div>
  );
}
