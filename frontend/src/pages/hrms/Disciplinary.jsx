import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { Panel, PanelHead, QaRow } from '../../components/proto.jsx';
import { isHR as hasHrmsAdmin, canManageServices } from '../../permissions';
import Combo from '../../components/Combo.jsx';
import PeopleFilterBar, { EMPTY_PEOPLE_FILTERS, peopleMatches, peopleOptions, statusOptions, textMatches } from '../../components/PeopleFilterBar.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import { ListEmpty } from '../../components/ui/ListFilters.jsx';
import { ComposeModal, Field, AiAssist, useSubmit } from '../../components/ComposeForm.jsx';
import DataIoBar from '../../components/dataio/DataIoBar.jsx';
import { useAudienceOptions } from '../../components/AudiencePicker.jsx';
import './Disciplinary.css';

const CATEGORIES = ['Warning', 'Suspension', 'Termination', 'Other'];
// A case is logged Open and closed with Close Case.
const CASE_STATUSES = ['Open', 'Closed'];
// Test fixtures are never offered (the server skips them too).
const TEST_PERSON = /zztest|example\.test/i;

// LOG CASE — for one person, or many at once. Tick one or MORE departments
// and/or pick one or MORE people; the case is recorded once for every person
// in the mix (no one twice, nobody who has left). The lists come from
// /audience/options, already held to your area, and the server checks again.
// Before saving, the form shows exactly who it will be recorded for — the
// server's own answer (POST /disciplinary with preview: true).
function LogCaseModal({ onClose, onSaved }) {
  const [form, setForm] = useState({ category: 'Warning', detail: '' });
  const [departments, setDepartments] = useState([]);
  const [employeeIds, setEmployeeIds] = useState([]);
  const [q, setQ] = useState('');
  const { opts, error: optsError } = useAudienceOptions();
  const [preview, setPreview] = useState(null); // { count, people, left } | { error }
  const { busy, error, setError, run } = useSubmit();

  const people = useMemo(() => (opts?.employees || []).filter((e) => !TEST_PERSON.test(e.name || '')), [opts]);
  const byId = useMemo(() => new Map(people.map((e) => [e.id, e])), [people]);
  const countBy = useMemo(() => {
    const m = {};
    people.forEach((e) => { m[e.department] = (m[e.department] || 0) + 1; });
    return m;
  }, [people]);
  // Only departments someone active sits in (never a zero-count option).
  const deptList = (opts?.departments || []).filter((d) => countBy[d] > 0);
  // FILTER CASCADE for adding people: Department -> Team -> TL -> Employee,
  // each list held to the step above it, with counts, never a zero option.
  const [fDept, setFDept] = useState('');
  const [fTeam, setFTeam] = useState('');
  const [fTl, setFTl] = useState('');
  const tally = (list, key) => {
    const m = new Map();
    list.forEach((e) => { const k = e[key]; if (k) m.set(k, (m.get(k) || 0) + 1); });
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  };
  const inDept = useMemo(() => people.filter((e) => !fDept || e.department === fDept), [people, fDept]);
  const inTeam = useMemo(() => inDept.filter((e) => !fTeam || e.team === fTeam), [inDept, fTeam]);
  const inTl = useMemo(() => inTeam.filter((e) => !fTl || e.tl === fTl), [inTeam, fTl]);
  const teamOpts = useMemo(() => tally(inDept, 'team'), [inDept]);
  const tlOpts = useMemo(() => tally(inTeam, 'tl'), [inTeam]);
  const narrowed = !!(fDept || fTeam || fTl);
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t && !narrowed) return [];
    return inTl.filter((e) => !employeeIds.includes(e.id)
      && (!t || [e.name, e.employeeCode, e.department, e.designation].some((x) => String(x || '').toLowerCase().includes(t))));
  }, [inTl, q, narrowed, employeeIds]);
  const addShown = () => { setEmployeeIds((list) => [...new Set([...list, ...matches.map((e) => e.id)])]); setQ(''); };
  const picked = departments.length + employeeIds.length > 0;

  // Ask the server who this reaches whenever the choice changes.
  useEffect(() => {
    if (!picked) { setPreview(null); return undefined; }
    let live = true;
    setPreview(null);
    const t = setTimeout(() => {
      api.post('/disciplinary', { preview: true, departments, employeeIds })
        .then((r) => { if (live) setPreview(r.data); })
        .catch((err) => { if (live) setPreview({ error: err.response?.data?.error || 'Could not check who this is for.' }); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [departments, employeeIds, picked]);

  const toggleDept = (d) => setDepartments((list) => (list.includes(d) ? list.filter((x) => x !== d) : [...list, d]));
  const addPerson = (id) => { setEmployeeIds((list) => (list.includes(id) ? list : [...list, id])); setQ(''); };
  const removePerson = (id) => setEmployeeIds((list) => list.filter((x) => x !== id));
  const n = preview && !preview.error ? preview.count : 0;
  const nWord = `${n} ${n === 1 ? 'person' : 'people'}`;

  async function submit() {
    if (!picked) { setError('Pick a department or a person.'); return; }
    if (!form.detail.trim()) { setError('Write what happened.'); return; }
    if (preview?.error) { setError(preview.error); return; }
    if (!n) { setError('Nobody in that choice can get this — they may have left the company.'); return; }
    const common = {
      title: form.category, category: form.category, detail: form.detail.trim(), date: new Date().toISOString().slice(0, 10),
    };
    // One person and no department is the plain one-person case, as before.
    const single = !departments.length && employeeIds.length === 1;
    const res = await run(() => api.post('/disciplinary', single
      ? { ...common, employeeId: employeeIds[0] }
      : { ...common, departments, employeeIds }), 'Could not save the case. Please try again.');
    if (res) onSaved(single ? 'Saved for 1 person' : (res.data.message || `Saved for ${res.data.created} people`));
  }

  return (
    <ComposeModal
      title="Log Disciplinary Case" onClose={onClose} onSubmit={submit} busy={busy} error={error} wide
      submitLabel={n ? `Save for ${nWord}` : 'Save'} disabled={!n}
    >
      <div className="aud-picker field disc-pick">
        <label>Who is this for? <span className="compose-req">*</span></label>
        <div className="disc-help">Tick departments, pick people, or both. Each person is counted once.</div>
        {optsError && <div className="error-text">{optsError}</div>}
        {!opts && !optsError && <div className="aud-summary">Loading your people…</div>}
        {opts && (
          <>
            <div className="disc-sub">Departments</div>
            {deptList.length === 0 ? <div className="small-muted">No departments in your area.</div> : (
              <div className="disc-chips">
                {deptList.map((d) => (
                  <button type="button" key={d} className={`disc-dchip${departments.includes(d) ? ' on' : ''}`} aria-pressed={departments.includes(d)} onClick={() => toggleDept(d)}>
                    {departments.includes(d) ? '✓ ' : ''}{d} <span className="disc-n">{countBy[d] || 0}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="disc-sub">People</div>
            {employeeIds.length > 0 && (
              <div className="aud-chips">
                {employeeIds.map((id) => {
                  const e = byId.get(id);
                  return (
                    <span key={id} className="aud-chip">
                      {e ? e.name : 'Unknown'}{e?.employeeCode ? ` · ${e.employeeCode}` : ''}
                      <button type="button" aria-label={`Remove ${e ? e.name : 'person'}`} onClick={() => removePerson(id)}>×</button>
                    </span>
                  );
                })}
              </div>
            )}
            <div className="disc-cascade">
              <select value={fDept} aria-label="Department" onChange={(e) => { setFDept(e.target.value); setFTeam(''); setFTl(''); }}>
                <option value="">All departments ({people.length})</option>
                {deptList.map((d) => <option key={d} value={d}>{d} ({countBy[d]})</option>)}
              </select>
              {teamOpts.length > 0 && (
                <select value={fTeam} aria-label="Team" onChange={(e) => { setFTeam(e.target.value); setFTl(''); }}>
                  <option value="">All teams ({inDept.length})</option>
                  {teamOpts.map(([t, c]) => <option key={t} value={t}>{t} ({c})</option>)}
                </select>
              )}
              {tlOpts.length > 0 && (
                <select value={fTl} aria-label="TL" onChange={(e) => setFTl(e.target.value)}>
                  <option value="">All TLs ({inTeam.length})</option>
                  {tlOpts.map(([t, c]) => <option key={t} value={t}>TL {t} ({c})</option>)}
                </select>
              )}
            </div>
            <input
              type="search" className="disc-search" placeholder="Type a name or employee code to add a person" value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (matches[0]) addPerson(matches[0].id); } }}
            />
            {(q.trim() || narrowed) && (
              <div className="aud-list disc-results">
                {matches.length > 1 && (
                  <button type="button" className="disc-result disc-addall" onClick={addShown}>+ Add all {matches.length} shown</button>
                )}
                {matches.length === 0 ? <div className="small-muted" style={{ padding: 6 }}>Nobody left to add here.</div> : matches.slice(0, 60).map((e) => (
                  <button type="button" key={e.id} className="disc-result" onClick={() => addPerson(e.id)}>
                    <b>+ {e.name}</b> <span className="aud-meta">· {e.employeeCode || '—'} · {[e.department, e.team].filter(Boolean).join(' / ') || 'No department'}</span>
                  </button>
                ))}
                {matches.length > 60 && <div className="small-muted" style={{ padding: 6 }}>{matches.length - 60} more — type a name to find them.</div>}
              </div>
            )}
          </>
        )}

        {picked && (
          <div className={`disc-preview${preview?.error ? ' bad' : ''}`} aria-live="polite">
            {!preview && 'Checking who this is for…'}
            {preview?.error}
            {preview && !preview.error && (n === 0
              ? 'Nobody active is in that choice.'
              : (
                <>
                  <div>This will be recorded for <b>{nWord}</b>:</div>
                  <div className="disc-names">{preview.people.map((p) => p.name).join(', ')}</div>
                </>
              ))}
            {preview?.left > 0 && <div className="disc-left">{preview.left} picked {preview.left === 1 ? 'person has' : 'people have'} left the company and will be skipped.</div>}
          </div>
        )}
      </div>

      <Field label="What kind of action?" required>
        <Combo creatable value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
          {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
        </Combo>
      </Field>
      <AiAssist kind="disciplinary" title={form.category} text={form.detail} onText={(detail) => setForm((f) => ({ ...f, detail }))} />
      <Field label="What happened?" required><textarea rows="4" value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} /></Field>
    </ComposeModal>
  );
}

export default function Disciplinary() {
  const { user } = useAuth();
  // isHR here DRAWS WRITE CONTROLS, so it asks the write permission and not
  // only the read one. A Manager and an Assistant Manager are view-only (§3,
  // §4) and still hold Employee Management/view, so isHR() alone would have
  // gone on offering them every button on this screen. Both halves, because
  // the screen is an administration screen AND these are writes.
  const hrView = hasHrmsAdmin(user);
  const isHR = hrView && canManageServices(user);
  const [records, setRecords] = useState([]);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState('');
  const [pf, setPf] = useState({ q: '', ...EMPTY_PEOPLE_FILTERS, category: '', from: '', to: '' });

  function load() {
    api.get('/disciplinary').then((res) => setRecords(res.data));
  }
  useEffect(load, [isHR]);

  async function closeCase(r) {
    await api.patch(`/disciplinary/${r.id}/status`, { status: 'Closed' });
    load();
  }

  const shown = records.filter((r) => textMatches(`${r.detail || ''} ${r.raisedBy || ''}`, pf.q)
    && peopleMatches(r, pf) && (!pf.category || r.category === pf.category));
  const opts = peopleOptions(records);
  const page = usePaged(shown);
  const clearPf = () => setPf((f) => Object.fromEntries(Object.keys(f).map((k) => [k, ''])));
  const categories = [...new Set([...CATEGORIES, ...records.map((r) => r.category).filter(Boolean)])];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Disciplinary Action Tracking</h1>
          <div className="page-sub">Disciplinary action tracking — candidate/case history is never deleted</div>
        </div>
      </div>
      {/* The head is hidden when this screen sits inside Performance &
          Development's tab strip, so the action lives in its own row. */}
      {/* Data I/O: export all / one employee and import of case history with
          the compulsory sample (backend src/io/disciplinary.js). */}
      <QaRow style={{ marginBottom: 14 }}>
        {isHR && <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>Log Case</button>}
        <DataIoBar
          ioKey="disciplinary"
          params={Object.fromEntries(['department', 'status', 'category', 'from', 'to'].filter((k) => pf[k]).map((k) => [k, pf[k]]))}
          onImported={load}
        />
      </QaRow>
      {saved && <div className="notice disc-saved" role="status">✓ {saved}<button type="button" className="btn btn-sm" onClick={() => setSaved('')}>OK</button></div>}

      <Panel>
        <PanelHead title="Cases" />
        <div style={{ padding: '0 18px' }}>
          <PeopleFilterBar
            filters={pf} setFilters={setPf} people={hrView}
            departments={hrView ? opts.departments : undefined} roles={hrView ? opts.roles : undefined}
            statuses={statusOptions(records, CASE_STATUSES)} shown={shown.length} total={records.length}
            search="Description or raised by" dates="Date" labels={{ category: 'Category' }}
          >
            <Combo value={pf.category} title="Category" onChange={(e) => setPf((f) => ({ ...f, category: e.target.value }))}>
              <option value="">All categories</option>
              {categories.map((c) => <option key={c}>{c}</option>)}
            </Combo>
          </PeopleFilterBar>
        </div>
        {shown.length === 0 ? <ListEmpty lf={{ activeCount: Object.values(pf).some(Boolean) ? 1 : 0, clear: clearPf }} noun="cases" title="No disciplinary cases on file." /> : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Employee</th><th>Category</th><th>Description</th><th>Raised By</th><th>Date</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {page.slice.map((r) => (
                  <tr key={r.id}>
                    <td>{r.employee?.name}</td>
                    <td><span className={`status ${r.category === 'Warning' ? 'pending' : r.category === 'Other' ? 'review' : 'rejected'}`}>{r.category || '—'}</span></td>
                    <td>{r.detail || '—'}</td>
                    <td className="cell-muted">{r.raisedBy || '—'}</td>
                    <td className="cell-muted">{r.date || '—'}</td>
                    <td>{r.status}</td>
                    <td>{r.status === 'Open' && isHR ? <button className="btn btn-sm" onClick={() => closeCase(r)}>Close Case</button> : <span className="small-muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {page.total > 0 && <Pager page={page} noun="cases" />}
      </Panel>

      {open && <LogCaseModal onClose={() => setOpen(false)} onSaved={(msg) => { setOpen(false); setSaved(msg); load(); }} />}
    </div>
  );
}
