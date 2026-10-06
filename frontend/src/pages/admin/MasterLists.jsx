import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import ListPageHeader, { StatusTabs } from '../../components/ui/ListPageHeader.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { can } from '../../permissions';
import { refreshSpecTree, loadListMasters } from '../../utils/specMaster';
import './MasterLists.css';

// ---------------------------------------------------------------------------
// ADMINISTRATION -> MASTER LISTS (spec D + §18, 2026-10-03)
//
// ONE place for the words people pick from in every dropdown:
//   Specializations · Qualifications · Departments (read here; edited in
//   Departments & Teams) · Sources · Reject reasons · Priorities · Locations
//   · Suggestions (the back-fill review: Accept / Change / Skip).
// Add, rename, switch off. A value already used is never removed — it can
// only be switched off. Plain words, one main button per tab (5-second test).
// Server: routes/specialisations.js (+ utils/listMasters.js).
// ---------------------------------------------------------------------------

const TABS = [
  { key: 'specs', label: 'Specializations' },
  { key: 'depts', label: 'Departments' },
  { key: 'sources', label: 'Sources' },
  { key: 'rejectReasons', label: 'Reject reasons' },
  { key: 'priorities', label: 'Priorities' },
  { key: 'locations', label: 'Locations' },
  { key: 'review', label: 'Suggestions' },
];
const HELP = {
  specs: 'What a person is specialised in — Dermatology, Physics, Java.',
  depts: 'Add or switch off departments in Departments & Teams.',
  sources: 'Where a candidate came from — Naukri, Referral, Job Portal.',
  rejectReasons: 'Why someone was rejected. Pick who each reason is for.',
  priorities: 'How urgent a job is.',
  locations: 'Cities offered for jobs and candidates.',
  review: 'The app guessed the specialization of old jobs and people.',
};
const num = (n) => Number(n || 0).toLocaleString('en-IN');
const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;
const errText = (e, fallback) => e?.response?.data?.error || fallback;
const usedLine = (jobs, people) => {
  const parts = [];
  if (jobs) parts.push(plural(jobs, 'job', 'jobs'));
  if (people) parts.push(plural(people, 'person', 'people'));
  return parts.length ? `Used by ${parts.join(' · ')}` : 'Not used yet';
};

export default function MasterLists() {
  const { user } = useAuth();
  const canEdit = can(user, null, 'administration', 'Company Setup', 'edit');
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'specs';
  const setTab = (k) => setParams({ tab: k }, { replace: true });

  const [master, setMaster] = useState(null);
  const [masterErr, setMasterErr] = useState('');
  const [pending, setPending] = useState(null);
  const [flash, setFlash] = useState(null); // { text, undo?, bad? }

  const loadMaster = useCallback(() => {
    api.get('/specialisations/master')
      .then((r) => { setMaster(r.data); setMasterErr(''); })
      .catch((e) => setMasterErr(errText(e, 'Could not load the lists. Check your connection and try again.')));
  }, []);
  const loadPending = useCallback(() => {
    if (!canEdit) return;
    api.get('/specialisations/suggestions', { params: { pageSize: 25 } })
      .then((r) => setPending((r.data.counts || []).filter((c) => c.status === 'PENDING').reduce((s, c) => s + c.count, 0)))
      .catch(() => setPending(null));
  }, [canEdit]);
  useEffect(() => { loadMaster(); loadPending(); }, [loadMaster, loadPending]);
  useEffect(() => {
    if (!flash || flash.undo) return undefined;
    const t = setTimeout(() => setFlash(null), 5000);
    return () => clearTimeout(t);
  }, [flash]);
  const changed = (text, undo) => {
    setFlash({ text, undo });
    loadMaster();
    refreshSpecTree();
  };
  const failed = (e, fallback) => setFlash({ text: errText(e, fallback), bad: true });

  const tabs = TABS.map((t) => (t.key === 'review' && pending ? { ...t, label: `Suggestions`, count: pending } : t))
    .filter((t) => t.key !== 'review' || canEdit);

  return (
    <div className="mlx">
      <ListPageHeader title="Master lists" question="The words people pick from in every dropdown. Add, rename or switch off." />
      <StatusTabs tabs={tabs} value={tab} onChange={setTab} label="Lists" />
      <p className="mlx-help">{HELP[tab]}</p>
      {!canEdit && <div className="notice">You can look at these lists. Only an Admin can change them.</div>}

      {flash && (
        <div className={`mlx-flash${flash.bad ? ' bad' : ''}`} role="status">
          <span>{flash.text}</span>
          {flash.undo && (
            <button type="button" className="btn btn-sm" onClick={() => { const u = flash.undo; setFlash(null); u(); }}>Undo</button>
          )}
          <button type="button" className="mlx-x" aria-label="Close" onClick={() => setFlash(null)}>×</button>
        </div>
      )}

      {['specs', 'depts'].includes(tab) && masterErr && <div className="error-text">{masterErr}</div>}
      {['specs', 'depts'].includes(tab) && !master && !masterErr && <div className="small-muted">Loading…</div>}
      {tab === 'specs' && master && <SpecsTab master={master} canEdit={canEdit} onChanged={changed} onFail={failed} />}
      {tab === 'depts' && master && <DeptsTab master={master} />}
      {['sources', 'rejectReasons', 'priorities', 'locations'].includes(tab) && (
        <SimpleListTab key={tab} list={tab} canEdit={canEdit} setFlash={setFlash} />
      )}
      {tab === 'review' && canEdit && master && (
        <ReviewTab master={master} setFlash={setFlash} onCounts={loadPending} />
      )}
    </div>
  );
}

// --- Department picker: big plain buttons, not a dropdown --------------------
function DeptPicker({ master, value, onChange, countOf }) {
  // Departments that have values come first; the empty ones wait behind
  // one small button (needed only to start a new department's list).
  const [more, setMore] = useState(false);
  const all = master.departments.filter((d) => d.active || countOf(d) > 0);
  const list = all.filter((d) => more || countOf(d) > 0 || d.id === value);
  const hidden = all.length - list.length;
  return (
    <div className="mlx-depts" role="tablist" aria-label="Department">
      {list.map((d) => (
        <button
          key={d.id}
          type="button"
          role="tab"
          aria-selected={value === d.id}
          className={`mlx-dept${value === d.id ? ' on' : ''}`}
          onClick={() => onChange(d.id)}
        >
          {d.name}
          {countOf(d) > 0 && <span className="n">{num(countOf(d))}</span>}
          {!d.active && <span className="mlx-off-tag">off</span>}
        </button>
      ))}
      {hidden > 0 && <button type="button" className="mlx-dept mlx-more" onClick={() => setMore(true)}>{`+ ${hidden} more`}</button>}
    </div>
  );
}
function useDept(master, countOf) {
  const first = useMemo(() => {
    const withValues = master.departments.find((d) => d.active && countOf(d) > 0);
    return (withValues || master.departments[0] || {}).id || '';
  }, [master]); // eslint-disable-line react-hooks/exhaustive-deps
  const [dept, setDept] = useState(first);
  const d = master.departments.find((x) => x.id === dept) || master.departments.find((x) => x.id === first);
  return [d, setDept];
}

// --- Specializations (grouped under their qualification; both edited here) ----------
function SpecsTab({ master, canEdit, onChanged, onFail }) {
  const countOf = (d) => d.specialisations.filter((s) => s.active).length;
  const [dept, setDept] = useDept(master, countOf);
  const [edit, setEdit] = useState(null); // specialization { id?, name, qualificationId, aliases }
  const [editQ, setEditQ] = useState(null); // qualification { id?, name, aliases }
  const [showOff, setShowOff] = useState(false);
  if (!dept) return <div className="small-muted">No departments yet. Add one in Departments &amp; Teams.</div>;
  const quals = dept.qualifications;
  const groups = [...quals.map((q) => ({ q, items: dept.specialisations.filter((s) => s.qualificationId === q.id) })),
    { q: null, items: dept.specialisations.filter((s) => !s.qualificationId || !quals.some((q) => q.id === s.qualificationId)) }]
    .map((g) => ({ ...g, items: g.items.filter((s) => showOff || s.active) }))
    .filter((g) => (g.q ? (showOff || g.q.active) : g.items.length));
  const offCount = dept.specialisations.filter((s) => !s.active).length + quals.filter((q) => !q.active).length;

  const saveSpec = async (form) => {
    const body = { name: form.name, qualificationId: form.qualificationId || null, aliases: form.aliases };
    try {
      if (form.id) await api.put(`/specialisations/items/${form.id}`, body);
      else await api.post('/specialisations/items', { ...body, departmentId: dept.id });
      setEdit(null);
      onChanged(form.id ? `Saved "${form.name}".` : `Added "${form.name}".`);
    } catch (e) { throw new Error(errText(e, 'Could not save. Try again.')); }
  };
  const saveQual = async (form) => {
    const body = { name: form.name, aliases: form.aliases };
    try {
      if (form.id) await api.put(`/specialisations/qualifications/${form.id}`, body);
      else await api.post('/specialisations/qualifications', { ...body, departmentId: dept.id });
      setEditQ(null);
      onChanged(form.id ? `Saved "${form.name}".` : `Added "${form.name}".`);
    } catch (e) { throw new Error(errText(e, 'Could not save. Try again.')); }
  };
  const toggle = async (kind, x) => {
    const url = kind === 'q' ? `/specialisations/qualifications/${x.id}` : `/specialisations/items/${x.id}`;
    try {
      await api.put(url, { active: !x.active });
      onChanged(x.active ? `"${x.name}" is switched off. Old records keep it.` : `"${x.name}" is on again.`,
        async () => { try { await api.put(url, { active: x.active }); onChanged('Undone.'); } catch (e) { onFail(e, 'Could not undo.'); } });
    } catch (e) { onFail(e, 'Could not change it. Try again.'); }
  };
  const remove = async (kind, x) => {
    if (!window.confirm(`Remove "${x.name}"? Nothing uses it yet.`)) return;
    const url = kind === 'q' ? `/specialisations/qualifications/${x.id}` : `/specialisations/items/${x.id}`;
    try { await api.delete(url); onChanged(`Removed "${x.name}".`); } catch (e) { onFail(e, 'Could not remove it.'); }
  };

  return (
    <>
      <div className="mlx-bar">
        <DeptPicker master={master} value={dept.id} onChange={setDept} countOf={countOf} />
        {canEdit && (
          <span className="mlx-acts">
            <button type="button" className="btn" onClick={() => setEditQ({ name: '', aliases: '' })}>+ Add qualification</button>
            <button type="button" className="btn btn-primary" onClick={() => setEdit({ name: '', qualificationId: quals.find((q) => q.active)?.id || '', aliases: '' })}>
              + Add specialization
            </button>
          </span>
        )}
      </div>
      {offCount > 0 && (
        <label className="mlx-check"><input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} />{` Show switched-off (${offCount})`}</label>
      )}
      {!groups.length && <div className="mlx-empty">{`Nothing in ${dept.name} yet.`}{canEdit ? ' Add a qualification first, then its specializations.' : ''}</div>}
      {groups.map(({ q, items }) => (
        <section key={q ? q.id : 'none'} className="mlx-group">
          <h3>
            <span className="mlx-qname">
              {q ? q.name : 'No qualification'}
              {q && q.aliases.length > 0 && <span className="mlx-alias">{` · also ${q.aliases.join(', ')}`}</span>}
            </span>
            {q && !q.active && <span className="mlx-off-tag">Switched off</span>}
            {q && canEdit && (
              <span className="mlx-acts">
                <button type="button" className="btn btn-sm" onClick={() => setEditQ({ id: q.id, name: q.name, aliases: q.aliases.join(', ') })}>Edit</button>
                <button type="button" className="btn btn-sm" onClick={() => toggle('q', q)}>{q.active ? 'Switch off' : 'Switch on'}</button>
                {!q.requirements && !q.candidates && !q.specialisations && <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove('q', q)}>Remove</button>}
              </span>
            )}
          </h3>
          {!items.length && <div className="mlx-row"><span className="small-muted">No specializations under this yet.</span></div>}
          {items.map((s) => (
            <div key={s.id} className={`mlx-row${s.active ? '' : ' is-off'}`}>
              <div className="mlx-main">
                <b>{s.name}</b>
                {s.aliases.length > 0 && <span className="mlx-alias">{`Also spelt: ${s.aliases.join(', ')}`}</span>}
                <span className="mlx-used">
                  {usedLine(s.requirements, s.candidates)}
                  {s.pendingSuggestions ? ` · ${plural(s.pendingSuggestions, 'guess', 'guesses')} to check` : ''}
                </span>
              </div>
              {!s.active && <span className="mlx-off-tag">Switched off</span>}
              {canEdit && (
                <div className="mlx-acts">
                  <button type="button" className="btn btn-sm" onClick={() => setEdit({ id: s.id, name: s.name, qualificationId: s.qualificationId || '', aliases: s.aliases.join(', ') })}>Edit</button>
                  <button type="button" className="btn btn-sm" onClick={() => toggle('s', s)}>{s.active ? 'Switch off' : 'Switch on'}</button>
                  {!s.requirements && !s.candidates && <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove('s', s)}>Remove</button>}
                </div>
              )}
            </div>
          ))}
        </section>
      ))}
      {dept.legacyValues > 0 && (
        <p className="small-muted">{`${num(dept.legacyValues)} old spellings from the import stay hidden in the background.`}</p>
      )}
      {edit && (
        <NameModal
          title={edit.id ? 'Edit specialization' : `New specialization in ${dept.name}`}
          initial={edit}
          withQualification={quals}
          aliasHint="e.g. Dermatologist, Derma"
          onSave={saveSpec}
          onClose={() => setEdit(null)}
        />
      )}
      {editQ && (
        <NameModal
          title={editQ.id ? 'Edit qualification' : `New qualification in ${dept.name}`}
          initial={editQ}
          aliasHint="e.g. M.D, Doctor of Medicine"
          onSave={saveQual}
          onClose={() => setEditQ(null)}
        />
      )}
    </>
  );
}

// --- Departments (read here; the HRMS screen adds / switches them off) ---------------
function DeptsTab({ master }) {
  return (
    <>
      <div className="notice">
        <span>
          Departments are added, renamed and switched off in
          {' '}<Link to="/admin/departments">Departments &amp; Teams</Link>.
          A switched-off department is hidden from every dropdown.
        </span>
      </div>
      <section className="mlx-group">
        {master.departments.map((d) => (
          <div key={d.id} className={`mlx-row${d.active ? '' : ' is-off'}`}>
            <div className="mlx-main">
              <b>{d.name}</b>
              <span className="mlx-used">
                {[d.jobs ? plural(d.jobs, 'job', 'jobs') : 'No jobs yet',
                  d.qualifications.length ? plural(d.qualifications.length, 'qualification', 'qualifications') : null,
                  d.specialisations.length ? plural(d.specialisations.length, 'specialization', 'specializations') : null].filter(Boolean).join(' · ')}
              </span>
            </div>
            <span className={`mlx-state ${d.active ? 'on' : 'off'}`}>{d.active ? 'On' : 'Switched off'}</span>
          </div>
        ))}
      </section>
    </>
  );
}

// --- Add / edit name (+ qualification, + other spellings) -------------------------------
function NameModal({
  title, initial, withQualification, aliasHint, onSave, onClose,
}) {
  const [form, setForm] = useState(initial);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!String(form.name || '').trim()) { setErr('Type a name first.'); return; }
    setBusy(true);
    setErr('');
    try { await onSave(form); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Save'}</button>
        </>
      )}
    >
      <label className="field">
        <span>Name *</span>
        <input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
      </label>
      {withQualification && (
        <label className="field">
          <span>Qualification</span>
          <select value={form.qualificationId || ''} onChange={(e) => setForm({ ...form, qualificationId: e.target.value })}>
            <option value="">No qualification</option>
            {withQualification.filter((q) => q.active || q.id === form.qualificationId).map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
          </select>
        </label>
      )}
      <label className="field">
        <span>Other spellings (comma between)</span>
        <input value={form.aliases || ''} placeholder={aliasHint} onChange={(e) => setForm({ ...form, aliases: e.target.value })} />
      </label>
      <div className="small-muted">Other spellings help the app recognise old values and resumes.</div>
      {err && <div className="error-text" style={{ marginTop: 8 }}>{err}</div>}
    </Modal>
  );
}

// --- Sources / Reject reasons / Priorities / Locations ---------------------------------
const LIST_WORDS = {
  sources: { one: 'source', add: '+ Add source', usedBy: ['record', 'records'] },
  rejectReasons: { one: 'reason', add: '+ Add reason', usedBy: ['rejection', 'rejections'] },
  priorities: { one: 'priority', add: '+ Add priority', usedBy: ['job', 'jobs'] },
  locations: { one: 'location', add: '+ Add location', usedBy: ['record', 'records'] },
};
const SIDE_LABELS = [['Client', 'Client'], ['Internal', 'Our team'], ['Candidate', 'Candidate']];
const PRIORITY_SHOWN = { Urgent: 'Critical' };

function SimpleListTab({ list, canEdit, setFlash }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(null);
  const words = LIST_WORDS[list];
  const load = useCallback(() => {
    api.get('/specialisations/lists/admin').then((r) => { setData(r.data); setErr(''); })
      .catch((e) => setErr(errText(e, 'Could not load this list.')));
  }, []);
  useEffect(() => { load(); }, [load]);
  const send = async (body, okText, undoBody) => {
    try {
      const r = await api.post(`/specialisations/lists/${list}`, body);
      setData(r.data.lists);
      loadListMasters();
      setFlash({
        text: okText,
        undo: undoBody ? async () => {
          try { const u = await api.post(`/specialisations/lists/${list}`, undoBody); setData(u.data.lists); loadListMasters(); setFlash({ text: 'Undone.' }); } catch (e) { setFlash({ text: errText(e, 'Could not undo.'), bad: true }); }
        } : undefined,
      });
      return true;
    } catch (e) {
      setFlash({ text: errText(e, 'Could not save. Try again.'), bad: true });
      return false;
    }
  };
  if (err) return <div className="error-text">{err}</div>;
  if (!data) return <div className="small-muted">Loading…</div>;
  const items = data[list] || [];
  const shown = (name) => (list === 'priorities' && PRIORITY_SHOWN[name] ? `${PRIORITY_SHOWN[name]} (saved as "${name}")` : name);
  return (
    <>
      {canEdit && (
        <div className="mlx-bar">
          <span />
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>{words.add}</button>
        </div>
      )}
      {!data.savedAt && <p className="small-muted">These are the starting values. Change them any time.</p>}
      <section className="mlx-group">
        {items.map((x) => (
          <div key={x.name} className={`mlx-row${x.active ? '' : ' is-off'}`}>
            <div className="mlx-main">
              <b>{shown(x.name)}</b>
              <span className="mlx-used">
                {x.used ? `Used by ${plural(x.used, words.usedBy[0], words.usedBy[1])}` : 'Not used yet'}
                {x.locked ? ' · Fixed — the app’s own rules use it' : ''}
              </span>
              {list === 'rejectReasons' && (
                <span className="mlx-sides">
                  <span className="small-muted">Shows for:</span>
                  {SIDE_LABELS.map(([side, label]) => {
                    const on = (x.sides || []).includes(side);
                    return (
                      <button
                        key={side}
                        type="button"
                        className={`mlx-side${on ? ' on' : ''}`}
                        disabled={!canEdit}
                        aria-pressed={on}
                        onClick={() => {
                          const next = on ? x.sides.filter((s) => s !== side) : [...x.sides, side];
                          send({ action: 'sides', name: x.name, sides: next }, `"${x.name}" now shows for ${next.map((s) => SIDE_LABELS.find(([k]) => k === s)[1]).join(', ') || 'nobody'}.`, { action: 'sides', name: x.name, sides: x.sides });
                        }}
                      >
                        {on ? '✓ ' : ''}{label}
                      </button>
                    );
                  })}
                </span>
              )}
            </div>
            {!x.active && <span className="mlx-off-tag">Switched off</span>}
            {canEdit && !x.locked && (
              <div className="mlx-acts">
                {!x.used && <button type="button" className="btn btn-sm" onClick={() => setRenaming(x)}>Rename</button>}
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => send({ action: x.active ? 'off' : 'on', name: x.name },
                    x.active ? `"${x.name}" is switched off. Old records keep it.` : `"${x.name}" is switched on again.`,
                    { action: x.active ? 'on' : 'off', name: x.name })}
                >
                  {x.active ? 'Switch off' : 'Switch on'}
                </button>
                {!x.used && (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => { if (window.confirm(`Remove "${x.name}"? Nothing uses it yet.`)) send({ action: 'remove', name: x.name }, `Removed "${x.name}".`); }}>Remove</button>
                )}
              </div>
            )}
          </div>
        ))}
      </section>
      {canEdit && items.some((x) => x.used && !x.locked) && (
        <p className="small-muted">Used values can&apos;t be renamed. Switch it off and add a new one.</p>
      )}
      {adding && (
        <SimpleNameModal
          title={`Add a ${words.one}`}
          withSides={list === 'rejectReasons'}
          onClose={() => setAdding(false)}
          onSave={async (name, sides) => {
            if (await send({ action: 'add', name, sides }, `Added "${name}".`, { action: 'remove', name })) setAdding(false);
          }}
        />
      )}
      {renaming && (
        <SimpleNameModal
          title={`Rename "${renaming.name}"`}
          initial={renaming.name}
          onClose={() => setRenaming(null)}
          onSave={async (name) => {
            if (await send({ action: 'rename', name: renaming.name, newName: name }, `Renamed to "${name}".`, { action: 'rename', name, newName: renaming.name })) setRenaming(null);
          }}
        />
      )}
    </>
  );
}

function SimpleNameModal({
  title, initial = '', withSides, onSave, onClose,
}) {
  const [name, setName] = useState(initial);
  const [sides, setSides] = useState(['Client', 'Internal', 'Candidate']);
  const [err, setErr] = useState('');
  const submit = () => {
    if (!name.trim()) { setErr('Type a name first.'); return; }
    if (withSides && !sides.length) { setErr('Pick at least one: Client, Our team or Candidate.'); return; }
    onSave(name.trim(), sides);
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={submit}>Save</button>
        </>
      )}
    >
      <label className="field">
        <span>Name *</span>
        <input autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
      </label>
      {withSides && (
        <div className="mlx-sides">
          <span className="small-muted">Shows for:</span>
          {SIDE_LABELS.map(([side, label]) => {
            const on = sides.includes(side);
            return (
              <button key={side} type="button" className={`mlx-side${on ? ' on' : ''}`} aria-pressed={on}
                onClick={() => setSides(on ? sides.filter((s) => s !== side) : [...sides, side])}
              >
                {on ? '✓ ' : ''}{label}
              </button>
            );
          })}
        </div>
      )}
      {err && <div className="error-text" style={{ marginTop: 8 }}>{err}</div>}
    </Modal>
  );
}

// --- Suggestions: the back-fill review ------------------------------------------------
const CONF = [
  ['', 'Any'],
  ['high', 'Sure (85% and up)'],
  ['mid', 'Likely (65–84%)'],
  ['low', 'Unsure (under 65%)'],
];
const confRange = (k) => (k === 'high' ? { minConfidence: 85 } : k === 'mid' ? { minConfidence: 65, maxConfidence: 84 } : k === 'low' ? { maxConfidence: 64 } : {});
const confWord = (n) => (n >= 85 ? ['Sure', 'sure'] : n >= 65 ? ['Likely', 'likely'] : ['Unsure', 'unsure']);
const STATUS_TABS = [['PENDING', 'Waiting'], ['ACCEPTED', 'Accepted'], ['SKIPPED', 'Skipped']];

function ReviewTab({ master, setFlash, onCounts }) {
  const [status, setStatus] = useState('PENDING');
  const [f, setF] = useState({ entityType: '', departmentId: '', specialisationId: '', conf: '', search: '' });
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [changing, setChanging] = useState(null);
  const query = useMemo(() => ({
    status, page, pageSize: 25,
    ...(f.entityType ? { entityType: f.entityType } : {}),
    ...(f.departmentId ? { departmentId: f.departmentId } : {}),
    ...(f.specialisationId ? { specialisationId: f.specialisationId } : {}),
    ...(f.search ? { search: f.search } : {}),
    ...confRange(f.conf),
  }), [status, page, f]);
  const load = useCallback(() => {
    api.get('/specialisations/suggestions', { params: query })
      .then((r) => { setData(r.data); setErr(''); })
      .catch((e) => setErr(errText(e, 'Could not load the suggestions.')));
  }, [query]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setTimeout(() => { if (search !== f.search) { setF((x) => ({ ...x, search })); setPage(1); } }, 400);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps
  const setFilter = (patch) => {
    setF((x) => ({ ...x, ...patch, ...(patch.departmentId !== undefined ? { specialisationId: '' } : {}) }));
    setPage(1);
  };
  const countOf = (st) => (data?.counts || []).filter((c) => c.status === st).reduce((s, c) => s + c.count, 0);
  const refresh = () => { load(); onCounts(); };

  const decide = async (items, okText, undoItems) => {
    setBusy(true);
    try {
      await api.post('/specialisations/suggestions/decide', { items });
      refresh();
      refreshSpecTree();
      setFlash({
        text: okText,
        undo: undoItems ? async () => {
          try { await api.post('/specialisations/suggestions/decide', { items: undoItems }); refresh(); setFlash({ text: 'Undone.' }); } catch (e) { setFlash({ text: errText(e, 'Could not undo.'), bad: true }); }
        } : undefined,
      });
    } catch (e) {
      setFlash({ text: errText(e, 'Could not save. Try again.'), bad: true });
    } finally { setBusy(false); }
  };
  const scan = async () => {
    setScanning(true);
    try {
      const r = await api.post('/specialisations/suggestions/scan', {}, { timeout: 180000 });
      setFlash({ text: `Done. ${num(r.data.requirementSuggestions)} jobs and ${num(r.data.candidateSuggestions)} people have a suggestion. Nothing was changed yet.` });
      setStatus('PENDING');
      setPage(1);
      refresh();
    } catch (e) {
      setFlash({ text: errText(e, 'Could not find suggestions. Try again.'), bad: true });
    } finally { setScanning(false); }
  };
  const acceptAll = async () => {
    const n = data?.total || 0;
    if (!n) return;
    if (!window.confirm(`Accept all ${num(n)} suggestions in this list? Each job or person gets the suggested specialization.`)) return;
    setBusy(true);
    try {
      const r = await api.post('/specialisations/suggestions/accept-filter', {
        expect: n,
        filter: {
          entityType: f.entityType, departmentId: f.departmentId, specialisationId: f.specialisationId, search: f.search, ...confRange(f.conf),
        },
      });
      refresh();
      setFlash({ text: `Accepted ${num(r.data.accepted)}: ${plural(r.data.requirements, 'job', 'jobs')} and ${plural(r.data.candidates, 'person', 'people')} updated. Undo one at a time from the Accepted tab.` });
    } catch (e) {
      setFlash({ text: errText(e, 'Could not accept them. Refresh and try again.'), bad: true });
    } finally { setBusy(false); }
  };

  const facets = data?.facets || {};
  const deptOpts = facets.departmentId || [];
  const specOpts = facets.specialisationId || [];
  const typeOpts = facets.entityType || [];
  const total = data?.total || 0;
  const nothingYet = data && !(data.counts || []).length;

  return (
    <>
      <div className="notice">
        <span>
          <b>These are only suggestions.</b> Nothing changes on a job or a person until you click <b>Accept</b>.
        </span>
      </div>
      <div className="mlx-bar">
        <StatusTabs
          tabs={STATUS_TABS.map(([k, l]) => ({ key: k, label: l, count: data ? countOf(k) : undefined }))}
          value={status}
          onChange={(k) => { setStatus(k); setPage(1); }}
          label="Suggestion status"
        />
        <button type="button" className="btn btn-primary" disabled={scanning} onClick={scan}>
          {scanning ? 'Looking… (about half a minute)' : 'Find suggestions'}
        </button>
      </div>
      {nothingYet && (
        <div className="mlx-empty">
          No suggestions yet. Press <b>Find suggestions</b> — the app looks at every job and person that has no specialization yet. It only makes suggestions; it changes nothing.
        </div>
      )}

      {!nothingYet && (
        <div className="mlx-filters">
          <input type="search" placeholder="Search old value or reason…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search suggestions" />
          {typeOpts.length > 0 && (
            <label>
              <span>Jobs or people</span>
              <select value={f.entityType} onChange={(e) => setFilter({ entityType: e.target.value })}>
                <option value="">Both</option>
                {typeOpts.map((o) => <option key={o.value} value={o.value}>{`${o.value === 'REQUIREMENT' ? 'Jobs' : 'People'} (${num(o.count)})`}</option>)}
              </select>
            </label>
          )}
          {deptOpts.length > 0 && (
            <label>
              <span>Department</span>
              <select value={f.departmentId} onChange={(e) => setFilter({ departmentId: e.target.value })}>
                <option value="">All departments</option>
                {deptOpts.map((o) => <option key={o.value} value={o.value}>{`${o.label} (${num(o.count)})`}</option>)}
              </select>
            </label>
          )}
          {specOpts.length > 0 && (
            <label>
              <span>Suggested specialization</span>
              <select value={f.specialisationId} onChange={(e) => setFilter({ specialisationId: e.target.value })}>
                <option value="">All</option>
                {specOpts.map((o) => <option key={o.value} value={o.value}>{`${o.label} (${num(o.count)})`}</option>)}
              </select>
            </label>
          )}
          <label>
            <span>How sure</span>
            <select value={f.conf} onChange={(e) => setFilter({ conf: e.target.value })}>
              {CONF.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
        </div>
      )}

      {err && <div className="error-text">{err}</div>}
      {data && status === 'PENDING' && total > 0 && (
        <div className="mlx-bulk">
          <span>{`${num(total)} waiting in this list.`}</span>
          {(f.departmentId || f.specialisationId || f.conf || f.entityType || f.search)
            ? <button type="button" className="btn btn-sm" disabled={busy} onClick={acceptAll}>{`Accept all ${num(total)}`}</button>
            : <span className="small-muted">Pick a filter to accept many at once.</span>}
        </div>
      )}
      {data && !nothingYet && !data.rows.length && (
        <div className="mlx-empty">{status === 'PENDING' ? 'Nothing waiting here. Change a filter, or press Find suggestions.' : `No ${status === 'ACCEPTED' ? 'accepted' : 'skipped'} suggestions here.`}</div>
      )}

      <div className="mlx-sugg-list">
        {(data?.rows || []).map((s) => {
          const [word, cls] = confWord(s.confidence);
          return (
            <div key={s.id} className="mlx-sugg">
              <div className="mlx-sugg-who">
                <span className="mlx-kind">{s.entityType === 'REQUIREMENT' ? 'Job' : 'Person'}</span>
                {s.record.link ? <Link to={s.record.link} target="_blank" rel="noreferrer">{s.record.label}</Link> : <b>{s.record.label}</b>}
                {s.record.sub && <span className="small-muted">{` · ${s.record.sub}`}</span>}
                <div className="small-muted">{`Old value: ${s.record.oldValue || '—'}${s.record.education ? ` · Education: ${s.record.education}` : ''}`}</div>
              </div>
              <div className="mlx-sugg-what">
                <div><span className="small-muted">Suggested: </span><b>{[s.department, s.qualification, s.specialisation].filter(Boolean).join(' › ')}</b></div>
                <div className="small-muted">{s.reason}</div>
              </div>
              <span className={`mlx-conf ${cls}`} title={`${s.confidence}% sure`}>{`${word} · ${s.confidence}%`}</span>
              <div className="mlx-acts">
                {s.status === 'PENDING' && (
                  <>
                    <button type="button" className="btn btn-sm btn-primary" disabled={busy}
                      onClick={() => decide([{ id: s.id, action: 'accept' }], `Accepted: ${s.record.label} → ${s.specialisation}.`, [{ id: s.id, action: 'undo' }])}
                    >
                      Accept
                    </button>
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setChanging(s)}>Change</button>
                    <button type="button" className="btn btn-sm btn-ghost" disabled={busy}
                      onClick={() => decide([{ id: s.id, action: 'skip' }], `Skipped: ${s.record.label}.`, [{ id: s.id, action: 'reopen' }])}
                    >
                      Skip
                    </button>
                  </>
                )}
                {s.status !== 'PENDING' && (
                  <button type="button" className="btn btn-sm" disabled={busy}
                    onClick={() => decide([{ id: s.id, action: 'undo' }], `Back to waiting: ${s.record.label}.`)}
                  >
                    {s.status === 'ACCEPTED' ? 'Undo accept' : 'Back to waiting'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {data && data.pages > 1 && (
        <div className="mlx-pager">
          <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Back</button>
          <span>{`Page ${page} of ${num(data.pages)}`}</span>
          <button type="button" className="btn btn-sm" disabled={page >= data.pages} onClick={() => setPage(page + 1)}>Next →</button>
        </div>
      )}
      {changing && (
        <ChangeModal
          s={changing}
          master={master}
          onClose={() => setChanging(null)}
          onSave={(specialisationId, qualificationId, label) => {
            setChanging(null);
            decide([{ id: changing.id, action: 'change', specialisationId, qualificationId }], `Saved: ${changing.record.label} → ${label}.`, [{ id: changing.id, action: 'undo' }]);
          }}
        />
      )}
    </>
  );
}

function ChangeModal({
  s, master, onClose, onSave,
}) {
  const [deptId, setDeptId] = useState(s.departmentId || '');
  const dept = master.departments.find((d) => d.id === deptId);
  const [specId, setSpecId] = useState(s.specialisationId || '');
  const specs = (dept?.specialisations || []).filter((x) => x.active);
  const spec = specs.find((x) => x.id === specId);
  return (
    <Modal
      title={`Pick the right specialization — ${s.record.label}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!spec} onClick={() => onSave(spec.id, spec.qualificationId || null, spec.name)}>Save</button>
        </>
      )}
    >
      <div className="small-muted" style={{ marginBottom: 8 }}>{`Old value: ${s.record.oldValue || '—'}`}</div>
      <label className="field">
        <span>Department</span>
        <select value={deptId} onChange={(e) => { setDeptId(e.target.value); setSpecId(''); }}>
          <option value="">Pick a department</option>
          {master.departments.filter((d) => d.active && d.specialisations.some((x) => x.active)).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Specialization</span>
        <select value={specId} onChange={(e) => setSpecId(e.target.value)} disabled={!dept}>
          <option value="">Pick one</option>
          {(dept?.qualifications || []).filter((q) => q.active).map((q) => {
            const list = specs.filter((x) => x.qualificationId === q.id);
            return list.length ? (
              <optgroup key={q.id} label={q.name}>
                {list.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </optgroup>
            ) : null;
          })}
          {specs.filter((x) => !x.qualificationId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </label>
      <div className="small-muted">Not in the list? Add it on the Specializations tab first.</div>
    </Modal>
  );
}
