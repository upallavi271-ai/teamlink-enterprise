import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import Modal from '../components/Modal.jsx';
import MoreFilters from '../components/ui/MoreFilters.jsx';
import FilterChips from '../components/FilterChips.jsx';
import { ListEmpty } from '../components/ui/ListFilters.jsx';
import Pager from '../components/Pager.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import './CandidateDuplicates.css';

// ---------------------------------------------------------------------------
// Candidates > Duplicates (Super Admin / Admin) — review #2 §12.
//
// One Candidate Master, many applications. This lists the EXISTING records
// that share a phone (last ten digits) or an email, and separately the
// name-only look-alikes whose contact details do not contradict. Nothing is
// merged automatically: per group the admin picks the master, leaves out
// anybody who is a different person, previews exactly what moves, and
// confirms. Backend: routes/candidates.js /duplicates/* and
// utils/candidateDedupe.js.
// ---------------------------------------------------------------------------
const ADMIN = ['SUPER_ADMIN', 'ADMIN'];
const isAdmin = (u) => !!u && (ADMIN.includes(u.role) || ADMIN.includes(u.atsRole));
const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const errText = (e) => e?.response?.data?.error || e?.message || 'Something went wrong';
const AGREE = {
  same: ['Same name', 'cdd-agree-same'],
  variant: ['Name variant', 'cdd-agree-variant'],
  different: ['Different names — check', 'cdd-agree-diff'],
};

function GroupCard({ group, kind, onPreview, onKeepSeparate }) {
  const [masterId, setMasterId] = useState(group.suggestedMasterId);
  const [included, setIncluded] = useState(() => new Set(group.memberIds));
  const donors = group.members.filter((m) => m.id !== masterId && included.has(m.id));
  const toggle = (id) => setIncluded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const [label, cls] = AGREE[group.nameAgreement] || ['', ''];
  return (
    <div className={`cdd-card${group.nameAgreement === 'different' ? ' is-warn' : ''}`}>
      <div className="cdd-card-head">
        <div>
          <b>{group.members.map((m) => m.name).filter((v, i, a) => a.indexOf(v) === i).join(' / ')}</b>
          <div className="small-muted">
            {kind === 'contact'
              ? [
                group.sharedPhones.length ? `Same phone ${group.sharedPhones.join(', ')}` : null,
                group.sharedEmails.length ? `Same email ${group.sharedEmails.join(', ')}` : null,
              ].filter(Boolean).join(' · ')
              : 'Same name, no conflicting phone or email — a possible match only'}
          </div>
        </div>
        <div className="cdd-card-tags">
          {label && <span className={`cdd-agree ${cls}`}>{label}</span>}
          {group.sameRequirement > 0 && <span className="cdd-agree cdd-agree-variant">{`${group.sameRequirement} requirement(s) applied by both`}</span>}
        </div>
      </div>
      <div className="tbl-wrap cdd-tbl">
        <table>
          <thead>
            <tr>
              <th>Master</th><th>Include</th><th>Name</th><th>Phone</th><th>Email</th><th>Location</th>
              <th>Source · added</th><th>Applications</th><th>Notes · Docs · Msgs</th>
            </tr>
          </thead>
          <tbody>
            {group.members.map((m) => (
              <tr key={m.id} className={`${m.id === masterId ? 'cdd-master' : ''}${included.has(m.id) ? '' : ' cdd-out'}`}>
                <td><input type="radio" name={`m-${group.id}`} checked={m.id === masterId} onChange={() => { setMasterId(m.id); setIncluded((s) => new Set([...s, m.id])); }} /></td>
                <td><input type="checkbox" checked={included.has(m.id)} disabled={m.id === masterId} onChange={() => toggle(m.id)} /></td>
                <td className="cdd-name"><Link to={`/candidates/${m.id}`} target="_blank" rel="noreferrer">{m.name}</Link>{m.externalRef && <div className="small-muted">{`ref ${m.externalRef}`}</div>}</td>
                <td>{m.phone || '—'}</td>
                <td>{m.email || '—'}</td>
                <td>{m.location || '—'}</td>
                <td className="small-muted">{`${m.source || '—'} · ${fmt(m.createdAt)}`}</td>
                <td className="cdd-apps">
                  {m.applications.length === 0 && <span className="small-muted">none</span>}
                  {m.applications.slice(0, 4).map((a) => (
                    <div key={a.id}>{`${a.requirementTitle || '—'} · ${a.clientName || '—'}`} <span className="small-muted">{`— ${a.stageLabel}`}</span></div>
                  ))}
                  {m.applications.length > 4 && <div className="small-muted">{`+${m.applications.length - 4} more`}</div>}
                </td>
                <td className="small-muted">{`${m.notes} · ${m.documents} · ${m.messages}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="cdd-card-foot">
        <span className="small-muted">
          {donors.length
            ? `Merge ${donors.length} record(s) into ${group.members.find((m) => m.id === masterId)?.name}. Nothing on the master is overwritten; its blanks are filled.`
            : 'Tick at least one other record to merge.'}
        </span>
        <span className="cdd-actions">
          <button type="button" className="btn btn-sm" title="Different people — stop suggesting this group (recorded in the audit trail; nothing is merged or deleted)" onClick={() => onKeepSeparate(group)}>Keep Separate</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={!donors.length} onClick={() => onPreview(group, masterId, donors.map((d) => d.id))}>
            Review merge…
          </button>
        </span>
      </div>
    </div>
  );
}

// `embedded`: shown inside Candidates & Pipeline → Candidate Master →
// Duplicates (no page header / back link). /candidates/duplicates still
// opens it as its own page.
export default function CandidateDuplicates({ embedded = false }) {
  const { user } = useAuth();
  const [summary, setSummary] = useState(null);
  const [kind, setKind] = useState('contact');
  const [agreement, setAgreement] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  // List standard (user notes #1 / #11): Search · Name agreement · Matched by,
  // Sort, chips, Clear All, 25/50/100 groups per page — all server-side
  // (GET /candidates/duplicates/groups ?agreement ?matchedBy ?sort ?pageSize).
  const [matchedBy, setMatchedBy] = useState('');
  const [sort, setSort] = useState('');
  const [pageSize, setPageSize] = useState(25);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  // Keep Separate (spec §10): stored server-side as a decision row, so the
  // group stops being suggested for everyone — not a per-browser skip.
  const [keepFor, setKeepFor] = useState(null); // { group, reason, busy, error }
  const [kept, setKept] = useState(null); // decisions list, when opened
  const [review, setReview] = useState(null); // { group, masterId, donorIds, preview, confirmed, nameOk, busy, error }
  const [tick, setTick] = useState(0);

  useEffect(() => { const t = setTimeout(() => setQ(search.trim()), 350); return () => clearTimeout(t); }, [search]);
  useEffect(() => { setPage(1); }, [kind, agreement, q, matchedBy, sort, pageSize]);
  useEffect(() => {
    if (!isAdmin(user)) return;
    api.get('/candidates/duplicates/summary').then((r) => setSummary(r.data)).catch((e) => setError(errText(e)));
  }, [user, tick]);
  useEffect(() => {
    if (!isAdmin(user)) return;
    setLoading(true);
    api.get('/candidates/duplicates/groups', {
      params: {
        kind, agreement: agreement || undefined, search: q || undefined, page, pageSize,
        matchedBy: (kind === 'contact' && matchedBy) || undefined, sort: sort || undefined,
      },
    })
      .then((r) => { setData(r.data); setError(''); })
      .catch((e) => setError(errText(e)))
      .finally(() => setLoading(false));
  }, [user, kind, agreement, q, page, tick, matchedBy, sort, pageSize]);

  if (!isAdmin(user)) {
    return <div className="notice">Only a Super Admin or Admin can review duplicate candidates.</div>;
  }

  async function keepSeparate() {
    setKeepFor((x) => ({ ...x, busy: true, error: '' }));
    try {
      await api.post('/candidates/duplicates/keep-separate', { memberIds: keepFor.group.memberIds, groupId: keepFor.group.id, reason: keepFor.reason || undefined });
      setMsg(`Kept separate: ${keepFor.group.members.map((m) => m.name).join(' / ')} — this group is no longer suggested.`);
      setKeepFor(null);
      setTick((t) => t + 1);
    } catch (e) {
      setKeepFor((x) => ({ ...x, busy: false, error: errText(e) }));
    }
  }
  async function openKept() {
    try { const r = await api.get('/candidates/duplicates/kept-separate'); setKept(r.data.decisions || []); } catch (e) { setError(errText(e)); }
  }
  async function undoKept(d) {
    try {
      await api.post('/candidates/duplicates/keep-separate/undo', { memberIds: d.memberIds });
      setMsg(`${d.names.join(' / ')} will be suggested again.`);
      setTick((t) => t + 1);
      openKept();
    } catch (e) { setError(errText(e)); }
  }

  async function openReview(group, masterId, donorIds) {
    setReview({ group, masterId, donorIds, preview: null, confirmed: false, nameOk: false, busy: true, error: '' });
    try {
      const r = await api.post('/candidates/duplicates/preview', { masterId, donorIds });
      setReview((x) => ({ ...x, preview: r.data, busy: false }));
    } catch (e) {
      setReview((x) => ({ ...x, error: errText(e), busy: false }));
    }
  }

  async function doMerge() {
    setReview((x) => ({ ...x, busy: true, error: '' }));
    try {
      const r = await api.post('/candidates/duplicates/merge', {
        masterId: review.masterId, donorIds: review.donorIds, confirm: true, nameOnlyConfirmed: kind === 'name' ? review.nameOk : undefined,
      });
      const m = r.data.moved;
      setMsg(`Merged into ${review.preview.master.name}: ${m.applications} application(s) moved, ${m.conflicts} same-requirement conflict(s) resolved, ${m.notes} note(s), ${m.documents} document(s), ${m.messages} message(s).`);
      setReview(null);
      setTick((t) => t + 1);
    } catch (e) {
      setReview((x) => ({ ...x, busy: false, error: errText(e) }));
    }
  }

  const groups = data?.groups || [];
  const s = summary;
  const filtersOn = [search.trim(), kind === 'contact' ? agreement : '', kind === 'contact' ? matchedBy : ''].filter(Boolean).length;
  const clearFilters = () => { setSearch(''); setAgreement(''); setMatchedBy(''); };
  const AGREE_LABEL = { same: 'Same name', variant: 'Name variant', different: 'Different names — check' };
  // The shared Pager's page object, fed by the server's page / pages / total.
  const eff = (data && data.pageSize) || pageSize; // the server caps it at 100
  const serverPage = data ? {
    total: data.total || 0,
    pages: data.pages || 1,
    page: data.page || 1,
    size: pageSize,
    setSize: setPageSize,
    setPage,
    from: data.total ? ((data.page || 1) - 1) * eff + 1 : 0,
    to: Math.min((data.page || 1) * eff, data.total || 0),
  } : null;
  return (
    <div className="cdd">
      {!embedded && <Link className="small-muted" to="/candidates?view=master&sub=duplicates">← Back to candidates</Link>}
      {!embedded && (
        <div className="page-head" style={{ marginTop: 10 }}>
          <div>
            <h1>Duplicate candidates</h1>
            <div className="page-sub">
              One person keeps one profile with many applications. Review each group, choose the master record and confirm — nothing is merged automatically, and never on a name alone.
            </div>
          </div>
        </div>
      )}
      {embedded && (
        <div className="small-muted" style={{ marginBottom: 10 }}>
          A data-quality check, not a pipeline stage: compare the possible duplicates, then <b>Merge</b> (you pick the master; every application and its history move to it) or <b>Keep Separate</b>. Nothing is merged automatically.
        </div>
      )}

      {s && (
        <div className="cdd-stats">
          <button type="button" className={`cdd-stat${kind === 'contact' ? ' on' : ''}`} onClick={() => setKind('contact')}>
            <b>{s.contact.groups.toLocaleString()}</b>
            <span>{`groups share a phone or email · ${s.contact.records.toLocaleString()} records (${s.contact.removable.toLocaleString()} would merge away)`}</span>
          </button>
          <button type="button" className={`cdd-stat${kind === 'name' ? ' on' : ''}`} onClick={() => setKind('name')}>
            <b>{s.name.groups.toLocaleString()}</b>
            <span>{`possible matches by name only · ${s.name.records.toLocaleString()} records — a hint, check each`}</span>
          </button>
        </div>
      )}
      {msg && <div className="notice" style={{ marginBottom: 10 }}>{msg}</div>}
      {error && <div className="error-text">{error}</div>}

      <MoreFilters
        storageKey="canddupes"
        onClearAll={filtersOn ? clearFilters : undefined}
        primary={(
          <>
            <input type="search" placeholder="Search name, phone or email…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
            {kind === 'contact' && s && (
              <select value={agreement} onChange={(e) => setAgreement(e.target.value)} title="Name agreement">
                <option value="">All names</option>
                <option value="same">{`Same name (${s.contact.sameName})`}</option>
                <option value="variant">{`Name variant (${s.contact.nameVariant})`}</option>
                <option value="different">{`Different names — check (${s.contact.nameDifferent})`}</option>
              </select>
            )}
            {kind === 'contact' && s && (s.contact.byPhone > 0 && s.contact.byEmail > 0 || !!matchedBy) && (
              <select value={matchedBy} onChange={(e) => setMatchedBy(e.target.value)} title="Matched by">
                <option value="">Phone or email</option>
                <option value="phone">{`Same phone (${s.contact.byPhone})`}</option>
                <option value="email">{`Same email (${s.contact.byEmail})`}</option>
              </select>
            )}
            {s && s.keptSeparate > 0 && (
              <button type="button" className="link-btn small-muted" onClick={openKept}>{`Kept separate (${s.keptSeparate})`}</button>
            )}
          </>
        )}
        extra={(
          <label className="small-muted" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            Sort
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="">As detected</option>
              <option value="size">Most records first</option>
            </select>
          </label>
        )}
      />
      <FilterChips
        onClearAll={filtersOn ? clearFilters : undefined}
        filters={[
          { key: 'q', label: 'Search', value: search.trim(), onRemove: () => setSearch('') },
          { key: 'agree', label: 'Names', value: kind === 'contact' ? (AGREE_LABEL[agreement] || '') : '', onRemove: () => setAgreement('') },
          { key: 'by', label: 'Matched by', value: kind === 'contact' ? ({ phone: 'Same phone', email: 'Same email' }[matchedBy] || '') : '', onRemove: () => setMatchedBy('') },
        ]}
      />

      {kind === 'name' && (
        <div className="notice amber" style={{ marginBottom: 10 }}>
          These share only a name (e.g. &ldquo;C. Pravalika&rdquo; / &ldquo;Pravalika C&rdquo;) and have no conflicting phone or email.
          Many will be different people — merge only after checking, and the merge asks for an extra confirmation.
        </div>
      )}

      {loading && <div className="small-muted">Loading…</div>}
      {data && !loading && groups.length === 0 && (
        filtersOn
          ? <ListEmpty lf={{ activeCount: filtersOn, clear: clearFilters }} noun="duplicate groups" />
          : <ListEmpty lf={{ activeCount: 0 }} noun="duplicate groups" icon="✅" title="No groups to review." hint={s && s.keptSeparate ? 'Groups you kept separate are not suggested again.' : undefined} />
      )}
      {groups.map((g) => (
        <GroupCard key={`${g.id}-${tick}`} group={g} kind={kind} onKeepSeparate={(grp) => setKeepFor({ group: grp, reason: '', busy: false, error: '' })} onPreview={openReview} />
      ))}

      {serverPage && serverPage.total > 0 && <Pager page={serverPage} noun="groups" />}

      {keepFor && (
        <Modal
          title="Keep these records separate?"
          onClose={() => !keepFor.busy && setKeepFor(null)}
          footer={(
            <>
              <button type="button" className="btn" disabled={keepFor.busy} onClick={() => setKeepFor(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={keepFor.busy} onClick={keepSeparate}>{keepFor.busy ? 'Saving…' : 'Keep Separate'}</button>
            </>
          )}
        >
          <div className="notice">
            <b>{keepFor.group.members.map((m) => m.name).join(' / ')}</b>
            {' — these stay separate candidates. The group stops being suggested; nothing is merged or deleted, and the decision is recorded in the audit trail (it can be undone).'}
          </div>
          <label className="field" style={{ marginTop: 10 }}>
            <span>Why (optional)</span>
            <input value={keepFor.reason} maxLength={300} placeholder="e.g. same family phone, different people" onChange={(e) => setKeepFor((x) => ({ ...x, reason: e.target.value }))} />
          </label>
          {keepFor.error && <div className="error-text">{keepFor.error}</div>}
        </Modal>
      )}
      {kept && (
        <Modal title="Kept separate" size="wide" onClose={() => setKept(null)} footer={<button type="button" className="btn" onClick={() => setKept(null)}>Close</button>}>
          {kept.length === 0 && <div className="small-muted">No keep-separate decisions.</div>}
          {kept.map((d) => (
            <div key={d.memberIds.join('|')} className="cdd-kept">
              <div>
                <b>{d.names.join(' / ')}</b>
                <div className="small-muted">{`${d.by || '—'} · ${fmt(d.at)}${d.reason ? ` · ${d.reason}` : ''}`}</div>
              </div>
              <button type="button" className="btn btn-sm" onClick={() => undoKept(d)}>Suggest again</button>
            </div>
          ))}
        </Modal>
      )}
      {review && (
        <Modal
          title="Merge duplicate candidates"
          size="wide"
          onClose={() => !review.busy && setReview(null)}
          footer={(
            <>
              <button type="button" className="btn" disabled={review.busy} onClick={() => setReview(null)}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={review.busy || !review.preview || !review.confirmed || (kind === 'name' && !review.nameOk)}
                onClick={doMerge}
              >
                {review.busy ? 'Working…' : 'Merge now'}
              </button>
            </>
          )}
        >
          {!review.preview && review.busy && <div className="small-muted">Working out what would move…</div>}
          {review.preview && (
            <>
              <div className="notice">
                {`Master: `}<b>{review.preview.master.name}</b>
                {` · merging in ${review.preview.donors.map((d) => d.name).join(', ')}`}
              </div>
              <ul className="cdd-list">
                <li>{`${review.preview.counts.applications} application(s) move to the master`}</li>
                <li>{`${review.preview.counts.notes} note(s), ${review.preview.counts.documents} document(s), ${review.preview.counts.messages} message(s), ${review.preview.counts.followUps} follow-up(s) move with them`}</li>
                <li>Pipeline history, interview feedback, AI interview results, invoices and candidate logins move too</li>
              </ul>
              {review.preview.conflicts.length > 0 && (
                <>
                  <div className="section-label">Both applied to the same requirement</div>
                  {review.preview.conflicts.map((cf) => (
                    <div key={cf.donor.applicationId} className="small-muted" style={{ marginBottom: 4 }}>
                      <b style={{ color: 'var(--ink)' }}>{cf.requirement}</b>
                      {` — master at ${cf.master.stage}, ${cf.donor.candidate} at ${cf.donor.stage}. Keeping the more advanced (${cf.keptStage}); the other is recorded in a note on the master and its history moves across.`}
                    </div>
                  ))}
                </>
              )}
              {Object.keys(review.preview.fills).length > 0 && (
                <>
                  <div className="section-label">Blank fields on the master that will be filled</div>
                  <div className="small-muted">
                    {Object.entries(review.preview.fills).map(([f, v]) => `${f}: ${String(v.value).slice(0, 40)} (from ${v.from})`).join(' · ')}
                  </div>
                </>
              )}
              {review.preview.lostRefs.length > 0 && (
                <div className="notice amber" style={{ marginTop: 8 }}>
                  {`Import reference(s) ${review.preview.lostRefs.join(', ')} cannot be kept (the master already has one) — they are saved in the audit snapshot.`}
                </div>
              )}
              <label className="cdd-confirm">
                <input type="checkbox" checked={review.confirmed} onChange={(e) => setReview((x) => ({ ...x, confirmed: e.target.checked }))} />
                I have checked these records are the same person. The other record(s) are removed after everything moves; a full snapshot is kept in the audit trail.
              </label>
              {kind === 'name' && (
                <label className="cdd-confirm">
                  <input type="checkbox" checked={review.nameOk} onChange={(e) => setReview((x) => ({ ...x, nameOk: e.target.checked }))} />
                  They share only a name — I confirm from other details that this is one person.
                </label>
              )}
            </>
          )}
          {review.error && <div className="error-text">{review.error}</div>}
        </Modal>
      )}
    </div>
  );
}
