// ---------------------------------------------------------------------------
// THE ORGANISATION STRUCTURE, AS A TREE.
//
//   Department -> Team -> TL position -> recruiter positions -> current holder
//                                                              (previous holders)
//
// This is the same kind / reportsTo the ATS scope engine reads on the server
// (backend/src/utils/positionScope.js), so the tree IS who sees what: a TL
// sees the work of the seats drawn under their seat, including everything the
// previous holders of those seats did. "Employees are replaceable, positions
// are not" — the handover button changes the person, never the seat.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import Combo from '../../components/Combo.jsx';
import ListFilterBar, { useListFilters } from '../../components/ui/ListFilters.jsx';
import './positions-tree.css';

const fmt = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const KIND_LABEL = { TL: 'TL', RECRUITER: 'Recruiter', STL: 'STL', OTHER: 'Other' };

function Seat({ seat, mayManage, onAssign, onOpen, onEdit, lead = false }) {
  const [showPrev, setShowPrev] = useState(false);
  const prev = seat.previous || [];
  return (
    <div className={`pt-seat${lead ? ' pt-tl' : ''}${seat.active ? '' : ' pt-inactive'}`}>
      <div>
        <div className="pt-code">
          {seat.code}
          {' '}
          <span className="status new" style={{ marginLeft: 4 }}>{KIND_LABEL[seat.kind] || seat.kind}</span>
          {!seat.active && <span className="status hold" style={{ marginLeft: 4 }}>Retired</span>}
        </div>
        <div className="pt-name">{seat.name || '—'}</div>
      </div>
      <div className="pt-holder">
        {seat.holder
          ? (
            <>
              <b>{seat.holder.name}</b>
              {seat.holder.employeeCode && <span className="pt-since">{` · ${seat.holder.employeeCode}`}</span>}
              <div className="pt-since">{`Since ${fmt(seat.holder.from)}`}</div>
            </>
          )
          : <span className="status pending">Vacant</span>}
        <div className="pt-work">
          {`${seat.work.requirements} req · ${seat.work.stageMoves} moves · ${seat.work.followUps} follow-ups (whole seat history)`}
        </div>
        {prev.length > 0 && (
          <>
            <button type="button" className="pt-prev-toggle" onClick={() => setShowPrev((v) => !v)}>
              {showPrev ? 'Hide previous holders' : `Previous holders (${prev.length})`}
            </button>
            {showPrev && (
              <ul className="pt-prev">
                {prev.map((p) => (
                  <li key={p.assignmentId}>
                    {`${p.name}${p.employeeCode ? ` (${p.employeeCode})` : ''} — ${fmt(p.from)} to ${fmt(p.to)}`}
                    {p.employmentStatus && p.employmentStatus !== 'Active' ? ` · ${p.employmentStatus}` : ''}
                    {p.note ? ` · ${p.note}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      <div className="pt-actions">
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onOpen(seat)}>History</button>
        {mayManage && (
          <>
            <button type="button" className="btn btn-sm" onClick={() => onAssign(seat)}>
              {seat.vacant ? 'Assign person' : 'Assign new person'}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => onEdit(seat)}>Edit</button>
          </>
        )}
      </div>
    </div>
  );
}

function Team({ team, show, ...rest }) {
  const recruiters = show ? team.recruiters.filter(show) : team.recruiters;
  return (
    <div className="pt-team">
      <div className="pt-team-title">{team.team || 'Team'}</div>
      <Seat seat={team.tl} lead {...rest} />
      <div className="pt-children">
        {recruiters.map((r) => <Seat key={r.id} seat={r} {...rest} />)}
        {!team.recruiters.length && <div className="small-muted">No recruiter positions report to this TL yet.</div>}
      </div>
    </div>
  );
}

// Every seat in the structure, flat, with its department — what the filter
// bar filters. The tree then draws only the seats (and their parents) that match.
function flatten(data) {
  const out = [];
  if (!data) return out;
  data.departments.forEach((d) => {
    const add = (seat) => { if (seat) out.push({ ...seat, deptGroup: d.department }); };
    const addTeam = (t) => { add(t.tl); t.recruiters.forEach(add); };
    d.stls.forEach((st) => { add(st); st.teams.forEach(addTeam); });
    d.teams.forEach(addTeam);
    d.outside.forEach(add); d.other.forEach(add); d.retired.forEach(add);
  });
  return out;
}

export default function PositionsTree({ mayManage, onAssign, onOpen, reloadKey }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [closed, setClosed] = useState({});
  const [editing, setEditing] = useState(null);
  const [editForm, setEditForm] = useState({});

  // THE FILTER STANDARD over the tree: Search · Department · Status · Kind,
  // Team under More Filters.
  const seats = useMemo(() => flatten(data), [data]);
  const lf = useListFilters(seats, [
    { key: 'q', type: 'search', placeholder: 'Search code, name or holder…',
      get: (p) => `${p.code} ${p.name || ''} ${p.holder ? `${p.holder.name} ${p.holder.employeeCode || ''}` : ''} ${(p.previous || []).map((x) => x.name).join(' ')}` },
    { key: 'department', label: 'Department', allLabel: 'All departments', primary: true, get: (p) => p.deptGroup },
    { key: 'state', label: 'Status', allLabel: 'Filled or vacant', primary: true,
      options: [{ value: 'filled', label: 'Filled' }, { value: 'vacant', label: 'Vacant' }, { value: 'retired', label: 'Retired' }],
      match: (p, v) => (v === 'vacant' ? p.vacant : v === 'filled' ? !p.vacant : !p.active) },
    { key: 'kind', label: 'Kind', allLabel: 'All kinds', primary: true, get: (p) => p.kind,
      options: Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label })) },
    { key: 'team', label: 'Team', allLabel: 'All teams', get: (p) => p.team },
  ]);

  function load() {
    api.get('/positions/structure')
      .then((r) => setData(r.data))
      .catch((e) => setError(e.response?.data?.error || 'Could not load the structure.'));
  }
  useEffect(load, [reloadKey]);

  // Every TL / STL seat — what a seat can report to.
  const leads = useMemo(() => {
    if (!data) return [];
    const out = [];
    data.departments.forEach((d) => {
      d.stls.forEach((s) => { out.push(s); s.teams.forEach((t) => out.push(t.tl)); });
      d.teams.forEach((t) => out.push(t.tl));
      d.outside.filter((p) => p.kind === 'TL' || p.kind === 'STL').forEach((p) => out.push(p));
    });
    return out;
  }, [data]);

  function edit(seat) {
    setError('');
    setEditing(seat);
    setEditForm({
      name: seat.name || '', kind: seat.kind || 'OTHER', team: seat.team || '',
      reportsToId: seat.reportsToId || '', active: seat.active,
    });
  }
  async function saveEdit(e) {
    e.preventDefault();
    setError('');
    try {
      await api.put(`/positions/${editing.id}`, { ...editForm, reportsToId: editForm.reportsToId || null });
      setEditing(null);
      load();
    } catch (err) { setError(err.response?.data?.error || 'Could not save that position.'); }
  }

  if (!data) return error ? <div className="notice red">{error}</div> : <div className="small-muted">Loading the structure…</div>;
  const seatProps = { mayManage, onAssign, onOpen, onEdit: edit };
  // With a filter on: only matching seats, their team's TL / STL as context,
  // departments with nothing left hidden and the rest opened.
  const filtering = lf.activeCount > 0;
  const hit = new Set(lf.rows.map((p) => p.id));
  const show = filtering ? (seat) => hit.has(seat.id) : null;
  const teamShows = (t) => !filtering || hit.has(t.tl.id) || t.recruiters.some((r) => hit.has(r.id));
  const stlShows = (st) => !filtering || hit.has(st.id) || st.teams.some(teamShows);
  const pick = (list) => (filtering ? list.filter((p) => hit.has(p.id)) : list);
  const visibleDepts = data.departments.map((d) => ({
    ...d,
    stls: d.stls.filter(stlShows).map((st) => ({ ...st, teams: st.teams.filter(teamShows) })),
    teams: d.teams.filter(teamShows),
    outside: pick(d.outside),
    other: pick(d.other),
    retired: pick(d.retired),
  })).filter((d) => !filtering || d.stls.length || d.teams.length || d.outside.length || d.other.length || d.retired.length);

  return (
    <div className="pos-tree">
      <ListFilterBar lf={lf} storageKey="admin-positions-tree" noun="positions" />
      {error && <div className="notice red">{error}</div>}
      {filtering && !visibleDepts.length && (
        <div className="notice">
          No positions match these filters.{' '}
          <button type="button" className="btn btn-sm" onClick={lf.clear}>Clear filters</button>
        </div>
      )}
      {visibleDepts.map((d) => {
        const structured = d.teams.length || d.stls.length;
        const isClosed = filtering ? false : (closed[d.department] ?? !structured);
        const count = d.teams.length + d.stls.reduce((n, s) => n + s.teams.length, 0);
        return (
          <div className="pt-dept" key={d.department}>
            <div className="pt-dept-head" onClick={() => setClosed((c) => ({ ...c, [d.department]: !isClosed }))}>
              <span>{isClosed ? '▸' : '▾'}</span>
              <h3>{d.department}</h3>
              <span className="pt-meta">
                {structured ? `${count} team${count === 1 ? '' : 's'}` : 'No team structure'}
                {d.outside.length ? ` · ${d.outside.length} outside the structure` : ''}
                {d.other.length ? ` · ${d.other.length} other seat${d.other.length === 1 ? '' : 's'}` : ''}
                {d.retired.length ? ` · ${d.retired.length} retired` : ''}
              </span>
            </div>
            {!isClosed && (
              <div className="pt-body">
                {d.stls.map((s) => (
                  <div key={s.id}>
                    <Seat seat={s} lead {...seatProps} />
                    <div className="pt-children">
                      {s.teams.map((t) => <Team key={t.tl.id} team={t} show={show} {...seatProps} />)}
                    </div>
                  </div>
                ))}
                {d.teams.map((t) => <Team key={t.tl.id} team={t} show={show} {...seatProps} />)}

                {d.outside.length > 0 && (
                  <div>
                    <div className="pt-flag">
                      These positions are in use but report to no TL, so no team lead sees their work.
                      Decide where each belongs: move the holder to a team seat (Assign new person on
                      that seat), set Reports to, or retire the seat once it is empty.
                    </div>
                    <div className="pt-children" style={{ marginLeft: 0, borderLeft: 0, paddingLeft: 0 }}>
                      {d.outside.map((p) => <Seat key={p.id} seat={p} {...seatProps} />)}
                    </div>
                  </div>
                )}
                {d.other.length > 0 && (
                  <details open={filtering || undefined}>
                    <summary>{`Other seats (${d.other.length}) — not part of a TL team`}</summary>
                    <div className="pt-children">
                      {d.other.map((p) => <Seat key={p.id} seat={p} {...seatProps} />)}
                    </div>
                  </details>
                )}
                {d.retired.length > 0 && (
                  <details open={filtering || undefined}>
                    <summary>{`Retired seats (${d.retired.length}) — history kept`}</summary>
                    <div className="pt-children">
                      {d.retired.map((p) => <Seat key={p.id} seat={p} {...seatProps} />)}
                    </div>
                  </details>
                )}
              </div>
            )}
          </div>
        );
      })}

      {editing && (
        <Modal
          title={`Edit ${editing.code}`}
          onClose={() => setEditing(null)}
          footer={(
            <>
              <button className="btn" type="button" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn btn-primary" type="submit" form="posStructureForm">Save</button>
            </>
          )}
        >
          <form id="posStructureForm" onSubmit={saveEdit}>
            <div className="small-muted" style={{ marginBottom: 10 }}>
              The code stays as it is — it is stamped on every record made from this seat. Kind and
              Reports to decide which team lead sees this seat&apos;s work.
            </div>
            <label className="field">
              <span>Name</span>
              <input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} />
            </label>
            <div className="grid-2">
              <label className="field">
                <span>Kind</span>
                <Combo value={editForm.kind} onChange={(e) => setEditForm((f) => ({ ...f, kind: e.target.value }))}>
                  <option value="RECRUITER">Recruiter</option>
                  <option value="TL">TL</option>
                  <option value="STL">STL</option>
                  <option value="OTHER">Other</option>
                </Combo>
              </label>
              <label className="field">
                <span>Team</span>
                <input placeholder="Team A" value={editForm.team} onChange={(e) => setEditForm((f) => ({ ...f, team: e.target.value }))} />
              </label>
            </div>
            <label className="field">
              <span>Reports to</span>
              <Combo value={editForm.reportsToId} onChange={(e) => setEditForm((f) => ({ ...f, reportsToId: e.target.value }))}>
                <option value="">— Nobody —</option>
                {leads.filter((p) => p.id !== editing.id).map((p) => (
                  <option key={p.id} value={p.id}>
                    {`${p.code}${p.name ? ` — ${p.name}` : ''}${p.holder ? ` (${p.holder.name})` : ' (vacant)'}`}
                  </option>
                ))}
              </Combo>
            </label>
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={!!editForm.active}
                onChange={(e) => setEditForm((f) => ({ ...f, active: e.target.checked }))}
                style={{ width: 'auto' }}
              />
              <span>Active (untick to retire — its history is kept)</span>
            </label>
          </form>
        </Modal>
      )}
    </div>
  );
}
