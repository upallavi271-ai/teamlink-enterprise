import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../api';
import Modal from '../components/Modal.jsx';
import Combo from '../components/Combo.jsx';
import MoreFilters from '../components/ui/MoreFilters.jsx';
import FilterChips from '../components/FilterChips.jsx';
import { ListEmpty } from '../components/ui/ListFilters.jsx';
import Pager, { usePaged } from '../components/Pager.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import './ClientDuplicates.css';

// ?focus=<clientId>[&with=<clientId>] (review #3 §5 / §20 — the duplicate
// dialog's [Merge Review]): the page opens on the detected group(s) holding
// that client, and offers "Compare & merge with…" for any pair the detector
// did not group. Both go through the SAME preview → confirm → merge engine
// (routes/clientMerge.js → utils/clientDedupe.js mergeClients: requirements,
// candidates, agreements and activity move to the master; ClientMerge history
// and ClientAlias rows are written). The admin picks the master; a manual pair
// is always treated as needing the "same company" confirmation.
const contactCount = (c) => ['contactName', 'secondaryContactName', 'billingContactName', 'recruitmentContactName'].filter((k) => c[k]).length;
function manualGroup(focus, other) {
  const member = (c) => ({
    id: c.id,
    name: c.name,
    clientCode: c.clientCode || c.displayCode || null,
    status: c.status || null,
    ownerDepartment: c.ownerDepartment || null,
    location: c.location || null,
    openReqs: c.activeRequirements || 0,
    reqs: c.totalRequirements || 0,
    apps: c.candidatesTotal || 0,
    invs: c.invoiceSummary ? c.invoiceSummary.count : '—',
    agreementStatus: c.agreementStatus || null,
    agreementFeePercent: c.agreementFeePercent ?? null,
    contacts: contactCount(c),
    createdAt: c.createdAt,
  });
  const conflicts = [];
  const differ = (k, label) => { if (focus[k] && other[k] && String(focus[k]).trim().toUpperCase() !== String(other[k]).trim().toUpperCase()) conflicts.push(`Different ${label}: ${focus[k]} / ${other[k]}`); };
  differ('gst', 'GSTIN');
  differ('pan', 'PAN');
  differ('location', 'location');
  differ('ownerDepartment', 'department');
  if (focus.agreementStatus === 'ACTIVE' && other.agreementStatus === 'ACTIVE') conflicts.push('Both have an Active agreement — keep the one whose terms are in force as the master.');
  return {
    id: `manual-${focus.id}-${other.id}`,
    cls: 'AMBIGUOUS',
    proposedName: focus.name,
    primaryId: focus.id,
    members: [member(focus), member(other)],
    totals: { openReqs: (focus.activeRequirements || 0) + (other.activeRequirements || 0), reqs: (focus.totalRequirements || 0) + (other.totalRequirements || 0) },
    departments: [...new Set([focus.ownerDepartment, other.ownerDepartment].filter(Boolean))],
    linkTypes: ['manual compare'],
    conflicts,
    removable: 1,
  };
}

// Clients > Duplicate clients (Super Admin / Admin). The same company was
// imported under several spellings; this screen shows each group, lets the
// admin pick the main client, the final name and who is left out, previews
// exactly what moves, and merges one group at a time (or every SAFE group).
// Backend: routes/clientMerge.js + utils/clientDedupe.js.

const ADMIN = ['SUPER_ADMIN', 'ADMIN'];
export const isClientMergeAdmin = (user) => !!user && (ADMIN.includes(user.role) || ADMIN.includes(user.atsRole));

const CLASS_INFO = {
  SAFE: 'Same name once punctuation, Pvt/Ltd, brackets and the address part are ignored — nothing contradicts.',
  NEAR: 'Names differ by a typo (Netwrok / Network). Some are different companies (Sankhya / Sandhya) — check each one.',
  AMBIGUOUS: 'Something contradicts (different places, location, department, phone or agreement terms) — often real branches. Leave out the members that are separate.',
};
const MOVE_LABELS = [
  ['requirements', 'Requirements'], ['applications', 'Applications (follow their requirement)'], ['invoices', 'Invoices'],
  ['users', 'Client logins'], ['stageEvents', 'Pipeline history rows'], ['feedback', 'Client interview feedback'],
  ['auditRows', 'Audit history rows'], ['scopeUsers', 'Users with this client in their scope'], ['aliases', 'Existing aliases'],
];
const SKIP_KEY = 'tl_client_dupes_skipped';
const readSkipped = () => { try { return new Set(JSON.parse(localStorage.getItem(SKIP_KEY) || '[]')); } catch { return new Set(); } };
const writeSkipped = (s) => { try { localStorage.setItem(SKIP_KEY, JSON.stringify([...s])); } catch { /* private window */ } };
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
const errText = (e) => e?.response?.data?.error || e?.message || 'Something went wrong';

function ClassBadge({ cls }) {
  return <span className={`cdup-cls cdup-cls-${cls.toLowerCase()}`}>{cls}</span>;
}

function AgreementCell({ m }) {
  if (!m.agreementStatus || m.agreementStatus === 'DRAFT') return <span className="cell-muted">Draft</span>;
  return (
    <span className={m.agreementStatus === 'ACTIVE' ? 'status active' : 'status pending'}>
      {m.agreementStatus === 'ACTIVE' ? 'Active' : m.agreementStatus === 'SIGNED' ? 'Signed' : m.agreementStatus}
      {m.agreementFeePercent != null ? ` · ${m.agreementFeePercent}%` : ''}
    </span>
  );
}

function GroupCard({ group, onMerge, onSkip }) {
  const [primaryId, setPrimaryId] = useState(group.primaryId);
  const [name, setName] = useState(group.proposedName);
  const [included, setIncluded] = useState(() => new Set(group.members.map((m) => m.id)));
  const donors = group.members.filter((m) => m.id !== primaryId && included.has(m.id));
  const leftOut = group.members.filter((m) => !included.has(m.id));
  const toggle = (id) => setIncluded((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const choosePrimary = (id) => { setPrimaryId(id); setIncluded((s) => new Set([...s, id])); };
  const reset = () => { setPrimaryId(group.primaryId); setName(group.proposedName); setIncluded(new Set(group.members.map((m) => m.id))); };

  return (
    <div className={`cdup-card cdup-card-${group.cls.toLowerCase()}`}>
      <div className="cdup-card-head">
        <ClassBadge cls={group.cls} />
        <div className="cdup-card-title">
          <label className="cdup-name-label" htmlFor={`cdup-name-${group.id}`}>Final client name</label>
          <input id={`cdup-name-${group.id}`} type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
        </div>
        <div className="cdup-card-meta">
          {group.members.length} records · {group.totals.openReqs}/{group.totals.reqs} requirements open · {group.departments.join(', ') || 'no department'}
          <div className="cell-muted">matched by: {group.linkTypes.join(', ')}</div>
        </div>
      </div>

      {group.conflicts.length > 0 && (
        <ul className="cdup-conflicts">
          {group.conflicts.map((c) => <li key={c}>{c}</li>)}
        </ul>
      )}

      <div className="tbl-wrap cdup-tbl">
        <table>
          <thead>
            <tr>
              <th title="The client that survives">Main</th>
              <th title="Untick to leave this record out (a branch or a different company)">Merge</th>
              <th>Name as stored</th>
              <th>Status</th>
              <th>Dept</th>
              <th>Location</th>
              <th title="Open / total requirements">Reqs</th>
              <th>Apps</th>
              <th>Invoices</th>
              <th>Agreement</th>
              <th>Contacts</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {group.members.map((m) => {
              const isMain = m.id === primaryId;
              const inc = included.has(m.id);
              return (
                <tr key={m.id} className={`${isMain ? 'cdup-main' : ''} ${inc ? '' : 'cdup-out'}`}>
                  <td><input type="radio" name={`main-${group.id}`} checked={isMain} onChange={() => choosePrimary(m.id)} aria-label={`Keep ${m.name} as the main client`} /></td>
                  <td><input type="checkbox" checked={inc} disabled={isMain} onChange={() => toggle(m.id)} aria-label={`Merge ${m.name}`} /></td>
                  <td className="cdup-name-cell">
                    <Link to={`/clients/${m.id}`} target="_blank" rel="noreferrer">{m.name}</Link>
                    {m.clientCode && <span className="cell-muted"> · {m.clientCode}</span>}
                  </td>
                  <td>{m.status || '-'}</td>
                  <td>{m.ownerDepartment || '-'}</td>
                  <td>{m.location || '-'}</td>
                  <td>{m.openReqs}/{m.reqs}</td>
                  <td>{m.apps}</td>
                  <td>{m.invs}</td>
                  <td><AgreementCell m={m} /></td>
                  <td>{m.contacts}</td>
                  <td>{fmtDate(m.createdAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="cdup-card-foot">
        <span className="cell-muted">
          {donors.length ? `${donors.length} record(s) will be merged into the main client` : 'Nothing to merge — tick at least one other record'}
          {leftOut.length ? ` · ${leftOut.length} left out` : ''}
        </span>
        <div className="cdup-actions">
          <button type="button" className="btn btn-sm btn-ghost" onClick={reset}>Reset</button>
          <button type="button" className="btn btn-sm" onClick={() => onSkip(group)}>Skip</button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={!donors.length || !name.trim()}
            onClick={() => onMerge({ group, primaryId, donorIds: donors.map((d) => d.id), name: name.trim(), splitOut: leftOut.map((d) => d.id) })}
          >
            Merge this group
          </button>
        </div>
      </div>
    </div>
  );
}

function PreviewBody({ req, preview, group }) {
  const moved = MOVE_LABELS.filter(([k]) => (preview.moved?.[k] || 0) > 0);
  const left = group.members.filter((m) => req.splitOut.includes(m.id));
  return (
    <div className="cdup-preview">
      <p>
        <strong>{preview.donors.length}</strong> record(s) will be merged into <strong>{preview.primary.name}</strong>
        {preview.finalName !== preview.primary.name && <> — renamed to <strong>{preview.finalName}</strong></>}. The merged records are then deleted.
      </p>
      <h4>Merged and deleted</h4>
      <ul>{preview.donors.map((d) => <li key={d.id}>{d.name}</li>)}</ul>
      {left.length > 0 && (<><h4>Left out (stay separate)</h4><ul>{left.map((d) => <li key={d.id}>{d.name}</li>)}</ul></>)}
      <h4>Moves to the main client</h4>
      {moved.length ? <ul>{moved.map(([k, l]) => <li key={k}>{l}: <strong>{preview.moved[k]}</strong></li>)}</ul> : <p className="cell-muted">No linked records to move.</p>}
      <h4>Filled on the main client (only where it is blank)</h4>
      {preview.filled.length ? (
        <ul>{preview.filled.map((f) => <li key={f.field}><code>{f.field}</code> = {String(f.value).slice(0, 80)} {f.fromName && <span className="cell-muted">(from {f.fromName})</span>}</li>)}</ul>
      ) : <p className="cell-muted">Nothing — the main client already has every field the others have.</p>}
      {preview.kept.length > 0 && (
        <>
          <h4>Kept as on the main client (other values dropped)</h4>
          <ul>{preview.kept.map((k) => <li key={k.field}><code>{k.field}</code>: keeps “{String(k.kept).slice(0, 60)}” — drops {k.dropped.map((d) => `“${String(d).slice(0, 40)}”`).join(', ')}</li>)}</ul>
        </>
      )}
      {preview.aliases.length > 0 && (
        <p className="cell-muted">Old names kept as aliases (imports using them will reach this client): {preview.aliases.join(' · ')}</p>
      )}
    </div>
  );
}

export default function ClientDuplicates() {
  const { user } = useAuth();
  const allowed = isClientMergeAdmin(user);
  const [data, setData] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [cls, setCls] = useState('');
  const [dept, setDept] = useState('');
  const [search, setSearch] = useState('');
  // List standard (user notes #1 / #11): Search · Class · Department, Sort,
  // chips, Clear All, 25/50/100 groups per page — UI filters only; nothing
  // here changes what a merge does.
  const [sort, setSort] = useState('');
  const [junkQ, setJunkQ] = useState('');
  const [histQ, setHistQ] = useState('');
  const [skipped, setSkipped] = useState(readSkipped);
  const [showSkipped, setShowSkipped] = useState(false);
  const [confirm, setConfirm] = useState(null); // { req, preview, group, ack, busy, error }
  const [bulk, setBulk] = useState(null); // { groups, busy, result, error }
  const [cardKey, setCardKey] = useState(0);
  // "Merge all recommended": the approved rule set (utils/clientDedupe.js
  // computePlan), shown first, applied only after typing MERGE.
  const [planView, setPlanView] = useState(null); // { plan, typed, busy, result, error }
  // ?focus= / ?with= — see manualGroup() above.
  const [searchParams, setSearchParams] = useSearchParams();
  const focusId = searchParams.get('focus') || '';
  const [withId, setWithId] = useState(searchParams.get('with') || '');
  const [allClients, setAllClients] = useState(null);
  useEffect(() => {
    if (!allowed || !focusId || allClients) return;
    api.get('/clients').then((r) => setAllClients(r.data)).catch(() => setAllClients([]));
  }, [allowed, focusId, allClients]);
  const clearFocus = () => { setSearchParams({}, { replace: true }); setWithId(''); };

  async function openPlan() {
    setPlanView({ plan: null, typed: '', busy: true, result: null, error: '' });
    try {
      const r = await api.get('/client-merge/plan');
      setPlanView((p) => p && { ...p, plan: r.data, busy: false });
    } catch (e) {
      setPlanView((p) => p && { ...p, busy: false, error: errText(e) });
    }
  }
  async function applyPlan() {
    setPlanView((p) => ({ ...p, busy: true, error: '' }));
    try {
      const r = await api.post('/client-merge/apply-plan', { confirm: 'MERGE' }, { timeout: 600000 });
      setPlanView((p) => ({ ...p, busy: false, result: r.data }));
      load();
    } catch (e) {
      setPlanView((p) => ({ ...p, busy: false, error: errText(e) }));
    }
  }

  async function load() {
    setLoading(true);
    setError('');
    try {
      const [g, h] = await Promise.all([api.get('/client-merge/groups'), api.get('/client-merge/history')]);
      setData(g.data);
      setHistory(h.data.merges || []);
      setCardKey((k) => k + 1);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { if (allowed) load(); else setLoading(false); }, [allowed]);

  const groups = data?.groups || [];
  const depts = useMemo(() => [...new Set(groups.flatMap((g) => g.departments))].sort(), [groups]);
  const focusGroups = useMemo(
    () => (focusId ? groups.filter((g) => g.members.some((m) => m.id === focusId || (withId && m.id === withId))) : []),
    [groups, focusId, withId],
  );
  const focusClient = focusId && allClients ? allClients.find((c) => c.id === focusId) : null;
  const withClient = withId && allClients ? allClients.find((c) => c.id === withId) : null;
  const pairGrouped = focusGroups.some((g) => g.members.some((m) => m.id === focusId) && withId && g.members.some((m) => m.id === withId));
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (focusId) return [];
    return groups.filter((g) => (!cls || g.cls === cls)
      && (!dept || g.departments.includes(dept))
      && (showSkipped || !skipped.has(g.id))
      && (!q || g.proposedName.toLowerCase().includes(q) || g.members.some((m) => m.name.toLowerCase().includes(q))))
      .sort(sort === 'reqs' ? (a, b) => ((b.totals && b.totals.reqs) || 0) - ((a.totals && a.totals.reqs) || 0)
        : sort === 'members' ? (a, b) => b.members.length - a.members.length
          : sort === 'name' ? (a, b) => String(a.proposedName || '').localeCompare(String(b.proposedName || ''))
            : () => 0);
  }, [groups, cls, dept, search, skipped, showSkipped, focusId, sort]);
  const groupPage = usePaged(visible);
  const filtersOn = [search.trim(), cls, dept].filter(Boolean).length;
  const clearFilters = () => { setSearch(''); setCls(''); setDept(''); };
  const junkRows = useMemo(() => {
    const q = junkQ.trim().toLowerCase();
    return ((data && data.junk) || []).filter((j) => !q || `${j.name} ${j.reason || ''} ${j.ownerDepartment || ''}`.toLowerCase().includes(q));
  }, [data, junkQ]);
  const histRows = useMemo(() => {
    const q = histQ.trim().toLowerCase();
    return history.filter((h) => !q || `${h.primaryName || ''} ${(h.donorNames || []).join(' ')} ${h.mergedByName || ''}`.toLowerCase().includes(q));
  }, [history, histQ]);
  const safeGroups = groups.filter((g) => g.cls === 'SAFE' && !skipped.has(g.id));
  const skippedCount = groups.filter((g) => skipped.has(g.id)).length;

  function skip(group) {
    const n = new Set(skipped);
    if (n.has(group.id)) n.delete(group.id); else n.add(group.id);
    setSkipped(n);
    writeSkipped(n);
  }

  async function openMerge(req) {
    setConfirm({ req, group: req.group, preview: null, ack: req.group.cls === 'SAFE', busy: true, error: '' });
    try {
      const r = await api.post('/client-merge/preview', { primaryId: req.primaryId, donorIds: req.donorIds, name: req.name });
      setConfirm((c) => c && { ...c, preview: r.data, busy: false });
    } catch (e) {
      setConfirm((c) => c && { ...c, busy: false, error: errText(e) });
    }
  }
  async function doMerge() {
    const { req } = confirm;
    setConfirm((c) => ({ ...c, busy: true, error: '' }));
    try {
      const r = await api.post('/client-merge/merge', { primaryId: req.primaryId, donorIds: req.donorIds, name: req.name, splitOut: req.splitOut });
      setConfirm(null);
      setNotice(`Merged into “${r.data.name}”: ${r.data.deleted} duplicate record(s) removed, ${r.data.moved.requirements} requirement(s) and ${r.data.moved.invoices} invoice(s) moved. The merge is in Merge history below.`);
      if (focusId) { setAllClients(null); if (req.donorIds.includes(focusId)) setSearchParams({ focus: req.primaryId }, { replace: true }); setWithId(''); }
      load();
    } catch (e) {
      setConfirm((c) => ({ ...c, busy: false, error: errText(e) }));
    }
  }
  async function doBulk() {
    setBulk((b) => ({ ...b, busy: true, error: '' }));
    try {
      const r = await api.post('/client-merge/merge-safe', { groupIds: bulk.groups.map((g) => g.id) });
      setBulk((b) => ({ ...b, busy: false, result: r.data }));
      load();
    } catch (e) {
      setBulk((b) => ({ ...b, busy: false, error: errText(e) }));
    }
  }

  if (!allowed) {
    return (
      <div className="cdup">
        <div className="page-head"><div><h1>Duplicate clients</h1></div></div>
        <div className="card">Only a Super Admin or Admin can review and merge duplicate clients.</div>
      </div>
    );
  }

  const S = data?.summary;
  return (
    <div className="cdup">
      <div className="page-head">
        <div>
          <h1>Duplicate clients</h1>
          <div className="page-sub">
            <Link to="/clients">Clients</Link> · the same company stored under several spellings. Pick the main client, check the name, leave out branches, then merge — each client keeps all its requirements.
          </div>
        </div>
        <div className="cdup-head-actions">
          <button type="button" className="btn" onClick={load} disabled={loading}>{loading ? 'Checking…' : 'Re-check'}</button>
          <button type="button" className="btn btn-primary" disabled={!safeGroups.length || loading} onClick={() => setBulk({ groups: safeGroups, busy: false, result: null, error: '' })}>
            Merge all SAFE groups ({safeGroups.length})
          </button>
        </div>
      </div>

      {error && <div className="error-text cdup-msg">{error}</div>}
      {notice && <div className="cdup-msg cdup-notice">{notice} <button type="button" className="btn btn-sm btn-ghost" onClick={() => setNotice('')}>Dismiss</button></div>}

      {focusId && (
        <div className="card cdup-section" style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <div>
              <h3 style={{ fontSize: 14, margin: 0 }}>
                {'Merge review — '}
                {focusClient ? <Link to={`/clients/${focusClient.id}`} target="_blank" rel="noreferrer">{focusClient.name}</Link> : (allClients ? 'client not found (merged or removed?)' : 'loading…')}
              </h3>
              <div className="small-muted" style={{ fontSize: 12, marginTop: 2 }}>
                Choose the main client (it survives), check the name, then Merge. You confirm before anything moves; nothing is merged automatically.
              </div>
            </div>
            <button type="button" className="btn btn-sm" onClick={clearFocus}>Show all duplicate groups</button>
          </div>

          {loading && !data && <div className="small-muted" style={{ marginTop: 10 }}>Checking every client for duplicates…</div>}
          {data && focusGroups.length === 0 && (
            <div className="small-muted" style={{ marginTop: 10 }}>The duplicate check did not group this client with any other. Compare it with a specific client below.</div>
          )}
          <div key={`f-${cardKey}`} style={{ marginTop: 10 }}>
            {focusGroups.map((g) => <GroupCard key={g.id} group={g} onMerge={openMerge} onSkip={skip} />)}
          </div>

          {focusClient && (
            <div style={{ marginTop: 12 }}>
              <div className="section-label" style={{ marginTop: 0 }}>Compare &amp; merge with…</div>
              <div className="filter-row" style={{ marginBottom: 8 }}>
                <Combo value={withId} onChange={(e) => setWithId(e.target.value)} style={{ minWidth: 320 }}>
                  <option value="">— Pick the other client —</option>
                  {(allClients || []).filter((c) => c.id !== focusId).map((c) => (
                    <option key={c.id} value={c.id}>{`${c.name}${c.location ? ` · ${c.location}` : ''}${c.displayCode ? ` · ${c.displayCode}` : ''}`}</option>
                  ))}
                </Combo>
              </div>
              {withClient && !pairGrouped && (
                <GroupCard key={`m-${focusId}-${withId}-${cardKey}`} group={manualGroup(focusClient, withClient)} onMerge={openMerge} onSkip={() => setWithId('')} />
              )}
              {withClient && pairGrouped && <div className="small-muted">These two are already in the group above.</div>}
            </div>
          )}
        </div>
      )}

      {S && (
        <div className="statbar">
          <div className="statitem"><div className="n">{data.totalClients}</div><div className="l">Clients now</div></div>
          <div className="statitem"><div className="n">{S.all.groups}</div><div className="l">Duplicate groups</div><div className="s">{S.all.removable} records would disappear</div></div>
          {['SAFE', 'NEAR', 'AMBIGUOUS'].map((k) => (
            <button type="button" key={k} className={`statitem cdup-stat ${cls === k ? 'on' : ''}`} onClick={() => setCls(cls === k ? '' : k)} title={CLASS_INFO[k]}>
              <div className="n">{S[k].groups}</div>
              <div className="l"><ClassBadge cls={k} /> groups</div>
              <div className="s">{S[k].removable} records would disappear</div>
            </button>
          ))}
          <div className="statitem"><div className="n">{data.totalClients - S.all.removable}</div><div className="l">Clients after merging all</div></div>
          <div className="statitem"><div className="n">{data.junk.length}</div><div className="l">Not a company — review</div></div>
        </div>
      )}

      <div className="cdup-legend">
        {['SAFE', 'NEAR', 'AMBIGUOUS'].map((k) => <div key={k}><ClassBadge cls={k} /> {CLASS_INFO[k]}</div>)}
      </div>

      <MoreFilters
        storageKey="clientdupes"
        onClearAll={filtersOn ? clearFilters : undefined}
        primary={(
          <>
            <input type="search" placeholder="Search a client name…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
            <select value={cls} onChange={(e) => setCls(e.target.value)} title="Class">
              <option value="">All classes</option>
              <option value="SAFE">SAFE</option>
              <option value="NEAR">NEAR</option>
              <option value="AMBIGUOUS">AMBIGUOUS</option>
            </select>
            <select value={dept} onChange={(e) => setDept(e.target.value)} title="Department">
              <option value="">All departments</option>
              {depts.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            {skippedCount > 0 && (
              <label className="cdup-check"><input type="checkbox" checked={showSkipped} onChange={(e) => setShowSkipped(e.target.checked)} /> Show {skippedCount} skipped</label>
            )}
          </>
        )}
        extra={(
          <>
            <label className="small-muted" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              Sort
              <select value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="">Detector order</option>
                <option value="reqs">Most requirements first</option>
                <option value="members">Most records first</option>
                <option value="name">Name A–Z</option>
              </select>
            </label>
            <span className="cell-muted">{visible.length} group(s)</span>
          </>
        )}
      />
      <FilterChips
        onClearAll={filtersOn ? clearFilters : undefined}
        filters={[
          { key: 'q', label: 'Search', value: search.trim(), onRemove: () => setSearch('') },
          { key: 'cls', label: 'Class', value: cls, onRemove: () => setCls('') },
          { key: 'dept', label: 'Department', value: dept, onRemove: () => setDept('') },
        ]}
      />

      {loading && !data && <div className="card">Checking every client for duplicates…</div>}
      {data && !visible.length && (
        filtersOn
          ? <ListEmpty lf={{ activeCount: filtersOn, clear: clearFilters }} noun="duplicate groups" />
          : <ListEmpty lf={{ activeCount: 0 }} noun="duplicate groups" title="No duplicate groups to review." icon="✅" />
      )}

      <div key={cardKey}>
        {groupPage.slice.map((g) => (
          <div key={g.id} className={skipped.has(g.id) ? 'cdup-skipped' : ''}>
            {skipped.has(g.id) && <div className="cell-muted cdup-skipnote">Skipped — <button type="button" className="btn btn-sm btn-ghost" onClick={() => skip(g)}>Un-skip</button></div>}
            <GroupCard group={g} onMerge={openMerge} onSkip={skip} />
          </div>
        ))}
      </div>
      {visible.length > 0 && <Pager page={groupPage} noun="groups" />}

      {data && (
        <details className="cdup-section">
          <summary>Not a company — review ({data.junk.length})</summary>
          <p className="cell-muted">These records are a source, a sheet header, a place or a code rather than a company. They are never merged automatically — open each one and fix or re-point its requirements by hand.</p>
          <div className="filter-row">
            <input type="search" placeholder="Search name, reason or department…" value={junkQ} onChange={(e) => setJunkQ(e.target.value)} aria-label="Search" />
            <span className="cell-muted">{junkQ.trim() ? `${junkRows.length} of ${data.junk.length}` : data.junk.length} record(s)</span>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Name as stored</th><th>Why</th><th>Status</th><th>Dept</th><th>Reqs</th><th>Invoices</th></tr></thead>
              <tbody>
                {junkRows.map((j) => (
                  <tr key={j.id}>
                    <td><Link to={`/clients/${j.id}`} target="_blank" rel="noreferrer">{j.name}</Link></td>
                    <td>{j.reason}</td><td>{j.status || '-'}</td><td>{j.ownerDepartment || '-'}</td>
                    <td>{j.openReqs}/{j.reqs}</td><td>{j.invs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <details className="cdup-section">
        <summary>Merge history ({history.length})</summary>
        {history.length > 0 && (
          <div className="filter-row">
            <input type="search" placeholder="Search client or who merged…" value={histQ} onChange={(e) => setHistQ(e.target.value)} aria-label="Search" />
            <span className="cell-muted">{histQ.trim() ? `${histRows.length} of ${history.length}` : history.length} merge(s)</span>
          </div>
        )}
        {history.length ? (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>When</th><th>Merged into</th><th>Records merged</th><th>Moved</th><th>By</th></tr></thead>
              <tbody>
                {histRows.map((h) => (
                  <tr key={h.id}>
                    <td>{new Date(h.createdAt).toLocaleString('en-IN')}</td>
                    <td><Link to={`/clients/${h.primaryId}`}>{h.primaryName}</Link></td>
                    <td>{h.donorNames.join(' · ')}{h.note && <div className="cell-muted">{h.note}</div>}</td>
                    <td>{h.moved.requirements || 0} req · {h.moved.invoices || 0} inv{h.filled.length ? ` · ${h.filled.length} field(s) filled` : ''}</td>
                    <td>{h.mergedByName || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="cell-muted">No merges yet.</p>}
      </details>

      {confirm && (
        <Modal
          title="Merge this group?"
          size="wide"
          onClose={() => !confirm.busy && setConfirm(null)}
          footer={(
            <>
              {confirm.preview && confirm.group.cls !== 'SAFE' && (
                <label className="cdup-check cdup-ack">
                  <input type="checkbox" checked={confirm.ack} onChange={(e) => setConfirm((c) => ({ ...c, ack: e.target.checked }))} />
                  I checked: these are the same company, not separate branches
                </label>
              )}
              <button type="button" className="btn" disabled={confirm.busy} onClick={() => setConfirm(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={confirm.busy || !confirm.preview || !confirm.ack} onClick={doMerge}>
                {confirm.busy && confirm.preview ? 'Merging…' : 'Merge'}
              </button>
            </>
          )}
        >
          {confirm.group.conflicts.length > 0 && (
            <ul className="cdup-conflicts">{confirm.group.conflicts.map((c) => <li key={c}>{c}</li>)}</ul>
          )}
          {confirm.error && <div className="error-text">{confirm.error}</div>}
          {!confirm.preview && !confirm.error && <p>Working out exactly what moves…</p>}
          {confirm.preview && <PreviewBody req={confirm.req} preview={confirm.preview} group={confirm.group} />}
        </Modal>
      )}

      {bulk && (
        <Modal
          title={bulk.result ? 'SAFE groups merged' : `Merge all ${bulk.groups.length} SAFE groups?`}
          size="wide"
          onClose={() => !bulk.busy && setBulk(null)}
          footer={bulk.result ? (
            <button type="button" className="btn btn-primary" onClick={() => setBulk(null)}>Close</button>
          ) : (
            <>
              <button type="button" className="btn" disabled={bulk.busy} onClick={() => setBulk(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={bulk.busy} onClick={doBulk}>{bulk.busy ? 'Merging…' : `Merge ${bulk.groups.length} groups`}</button>
            </>
          )}
        >
          {bulk.error && <div className="error-text">{bulk.error}</div>}
          {!bulk.result && (
            <>
              <p>
                Each SAFE group is merged into its proposed main client under its proposed name, one group per transaction —
                {' '}<strong>{bulk.groups.reduce((s, g) => s + g.removable, 0)}</strong> duplicate records will be removed and their requirements, invoices and history moved.
                Changes you made on a card (main client, name, left-out members) are NOT used here — merge those groups one by one. Skipped groups are not included.
              </p>
              <div className="cdup-bulk-list">
                {bulk.groups.map((g) => (
                  <div key={g.id}><strong>{g.proposedName}</strong> <span className="cell-muted">← {g.members.map((m) => m.name).join(' · ')}</span></div>
                ))}
              </div>
            </>
          )}
          {bulk.result && (
            <>
              <p><strong>{bulk.result.merged}</strong> group(s) merged, <strong>{bulk.result.removed}</strong> duplicate record(s) removed{bulk.result.failed ? `, ${bulk.result.failed} failed` : ''}.</p>
              {bulk.result.failed > 0 && (
                <ul className="cdup-conflicts">
                  {bulk.result.results.filter((r) => !r.ok).map((r) => <li key={r.groupId}>{r.name || r.groupId}: {r.error}</li>)}
                </ul>
              )}
            </>
          )}
        </Modal>
      )}

      {planView && (
        <Modal
          title={planView.result ? 'Recommended merge done' : 'Merge all recommended groups?'}
          size="wide"
          onClose={() => !planView.busy && setPlanView(null)}
          footer={planView.result ? (
            <button type="button" className="btn btn-primary" onClick={() => setPlanView(null)}>Close</button>
          ) : (
            <>
              <button type="button" className="btn" disabled={planView.busy} onClick={() => setPlanView(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={planView.busy || !planView.plan || planView.typed !== 'MERGE'} onClick={applyPlan}>
                {planView.busy && planView.plan ? 'Backing up and merging…' : `Merge ${planView.plan ? planView.plan.summary.sets : ''} groups`}
              </button>
            </>
          )}
        >
          {planView.error && <div className="error-text">{planView.error}</div>}
          {!planView.plan && !planView.error && <p>Working out the plan…</p>}
          {planView.plan && !planView.result && (() => {
            const s = planView.plan.summary;
            const RULE = {
              SAFE: 'Same client, nothing conflicting', NEAR: 'Spelling variants of one client',
              CHAIN: 'Hospital / company chain with one agreement → one client', EDU_PLACE: 'College at several places → one client per place',
              ONE_PLACE: 'Copies at the same place (or with no place)', AGREEMENT: 'Different agreements → kept apart, copies merged per agreement',
            };
            return (
              <>
                <p>
                  <strong>{planView.plan.totalClients}</strong> clients now → <strong>{s.clientsAfter}</strong> after: {s.sets} groups merged,
                  {' '}<strong>{s.removable}</strong> duplicate records removed. Every requirement, invoice and history row moves to the main client
                  (the one with the Active agreement first), old spellings are kept as aliases, and every merge is recorded.
                </p>
                <ul className="cdup-conflicts">
                  {Object.entries(s.byRule).map(([k, v]) => (
                    <li key={k}>{RULE[k] || k}: {v.sets} group(s), {v.removable} record(s) removed</li>
                  ))}
                </ul>
                <p className="small-muted">
                  Kept separate: colleges at different places, clients with different Active agreements, false matches (e.g. Sankhya / Sandhya),
                  junk rows (place names, "Just Dial"…) and the Internal client. <strong>A full backup of the database is made first.</strong>
                </p>
                <div className="cdup-bulk-list">
                  {planView.plan.sets.slice(0, 60).map((x) => (
                    <div key={x.key}><strong>{x.name}</strong> <span className="cell-muted">← {x.members.map((m) => m.name).join(' · ')}</span></div>
                  ))}
                  {planView.plan.sets.length > 60 && <div className="cell-muted">…and {planView.plan.sets.length - 60} more</div>}
                </div>
                <div className="field" style={{ marginTop: 10 }}>
                  <label>Type <strong>MERGE</strong> to confirm</label>
                  <input value={planView.typed} onChange={(e) => setPlanView((p) => ({ ...p, typed: e.target.value.trim().toUpperCase() }))} placeholder="MERGE" />
                </div>
              </>
            );
          })()}
          {planView.result && (
            <>
              <p>
                Clients: <strong>{planView.result.before}</strong> → <strong>{planView.result.after}</strong>.
                {' '}{planView.result.merged} group(s) merged, {planView.result.removed} duplicate record(s) removed{planView.result.failed ? `, ${planView.result.failed} failed` : ''}.
              </p>
              <p className="small-muted">Backup taken first: backend/backups/{planView.result.backup}</p>
              {planView.result.failed > 0 && (
                <ul className="cdup-conflicts">
                  {planView.result.results.filter((r) => !r.ok).map((r) => <li key={r.key}>{r.name || r.key}: {r.error}</li>)}
                </ul>
              )}
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
