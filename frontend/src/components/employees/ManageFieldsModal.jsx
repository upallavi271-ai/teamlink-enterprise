import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Modal from '../Modal.jsx';
import { invalidateFieldLayout } from '../../utils/employeeFieldLayout';
import './ExtraFields.css';
import Combo from '../Combo.jsx';

// Employee Management -> MANAGE FIELDS (HRMS spec item 15).
//
// ONE list of every field on the employee form: the old built-in ones (Name,
// Email, Blood Group, Bank name …) and the ones we added. Each row has plain,
// visible buttons — Edit, Pause / Resume, and up / down arrows. No menus.
//
//   Pause    hides the field from the forms, the profile and new exports.
//            Nothing is deleted: the saved values stay and Resume brings it back.
//   Needed   fields the system cannot work without show "Needed by the system"
//            instead of Pause. Their label can still be changed.
//
// Super Admin and HR only; the server refuses anyone else.

const BLANK = { id: null, builtin: false, label: '', type: 'TEXT', options: '', required: false, minValue: '', maxValue: '', maxLength: '', helpText: '', group: '' };
const HINT = {
  TEXT: 'Short text, e.g. T-shirt size or nickname.',
  NUMBER: 'A number, e.g. years of experience.',
  DATE: 'A date, e.g. passport expiry.',
  DROPDOWN: 'Pick ONE from your list.',
  MULTISELECT: 'Pick ONE OR MORE from your list.',
  CHECKBOX: 'A yes / no tick, e.g. "Has own laptop".',
  FILE: 'A file (PDF or photo, up to 5 MB).',
};
const FILTERS = [
  ['all', 'All'],
  ['active', 'Active'],
  ['paused', 'Paused'],
  ['builtin', 'Built-in'],
  ['added', 'Added by us'],
];

function Where({ f }) {
  const w = f.where || {};
  return (
    <span className="xf-where" title="Where this field is shown">
      {w.form && <span className="xf-w">Form</span>}
      {w.profile && <span className="xf-w">Profile</span>}
      {w.list && <span className="xf-w">List</span>}
    </span>
  );
}

export default function ManageFieldsModal({ onClose }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null); // { text, undo? }
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');

  function load() {
    return api.get('/employee-fields', { params: { all: 1 } })
      .then((r) => setData(r.data))
      .catch((err) => setError(err.response?.data?.error || 'Could not load the fields.'));
  }
  useEffect(() => { load(); }, []);

  const changed = () => { invalidateFieldLayout(); return load(); };
  const say = (text, undo) => setNotice({ text, undo });
  const fail = (err, fallback) => setError(err.response?.data?.error || fallback);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  async function save() {
    setError(''); setNotice(null); setBusy(true);
    try {
      if (form.builtin) {
        await api.put(`/employee-fields/${form.id}`, { label: form.label, helpText: form.helpText, required: form.required });
      } else {
        const body = {
          label: form.label, type: form.type, required: form.required, helpText: form.helpText,
          options: form.options, minValue: form.minValue, maxValue: form.maxValue, maxLength: form.maxLength, group: form.group,
        };
        if (form.id) await api.put(`/employee-fields/${form.id}`, body);
        else await api.post('/employee-fields', body);
      }
      say(form.id ? `Saved "${form.label}". It shows like this on the form and the profile now.` : `Added "${form.label}". It now shows on every employee's form.`);
      setForm(null);
      await changed();
    } catch (err) {
      fail(err, 'That field could not be saved.');
    } finally { setBusy(false); }
  }

  async function setActive(f, active) {
    setError(''); setNotice(null);
    try {
      await api.put(`/employee-fields/${f.id}`, { active });
      say(
        active
          ? `"${f.label}" is back on the form, the profile and the list.`
          : `"${f.label}" is paused. It is hidden from the form, the profile and the list. Its saved values are kept.`,
        active ? null : () => setActive(f, true),
      );
      await changed();
    } catch (err) { fail(err, 'That change could not be saved.'); }
  }

  async function remove(f) {
    // eslint-disable-next-line no-alert
    if (!confirm(f.valueCount
      ? `"${f.label}" has values for ${f.valueCount} employee(s). It will be paused and the values kept. Continue?`
      : `Remove "${f.label}"?`)) return;
    setError(''); setNotice(null);
    try {
      const r = await api.delete(`/employee-fields/${f.id}`);
      say(r.data?.message || 'Removed.');
      await changed();
    } catch (err) { fail(err, 'That field could not be removed.'); }
  }

  async function move(f, direction) {
    setError(''); setNotice(null);
    try {
      await api.post('/employee-fields/reorder', { id: f.id, direction });
      await changed();
    } catch (err) { fail(err, 'Could not move the field.'); }
  }

  const canConfigure = data?.canConfigure;
  const fields = data?.fields || [];
  const counts = useMemo(() => ({
    all: fields.length,
    active: fields.filter((f) => f.active).length,
    paused: fields.filter((f) => !f.active).length,
    builtin: fields.filter((f) => f.builtin).length,
    added: fields.filter((f) => !f.builtin).length,
  }), [fields]);

  const shownFields = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return fields.filter((f) => {
      if (filter === 'active' && !f.active) return false;
      if (filter === 'paused' && f.active) return false;
      if (filter === 'builtin' && !f.builtin) return false;
      if (filter === 'added' && f.builtin) return false;
      if (!needle) return true;
      return `${f.label} ${f.originalName} ${f.section} ${f.typeLabel}`.toLowerCase().includes(needle);
    });
  }, [fields, filter, q]);

  const moving = filter === 'all' && !q.trim(); // arrows only make sense on the whole list
  const editing = form;
  const choiceType = editing && !editing.builtin && ['DROPDOWN', 'MULTISELECT'].includes(editing.type);

  function openEdit(f) {
    setError(''); setNotice(null);
    setForm({
      ...BLANK, ...f, options: (f.options || []).join('\n'), minValue: f.minValue ?? '', maxValue: f.maxValue ?? '', maxLength: f.maxLength ?? '', helpText: f.helpText || '', group: f.group || '',
    });
  }

  let lastSection = null;

  return (
    <Modal
      title={editing ? (editing.id ? `Edit — ${editing.originalName || editing.label}` : 'Add a new field') : 'Manage fields'}
      size="wide"
      onClose={onClose}
      foot={editing ? (
        <>
          <button type="button" className="btn" onClick={() => { setForm(null); setError(''); }}>Back</button>
          <button type="button" className="btn btn-primary" disabled={busy || !editing.label.trim()} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        </>
      ) : (
        <>
          <button type="button" className="btn" onClick={onClose}>Close</button>
          {canConfigure && <button type="button" className="btn btn-primary" onClick={() => { setForm({ ...BLANK }); setNotice(null); setError(''); }}>+ Add a new field</button>}
        </>
      )}
    >
      <div className="xfields">
        {error && <div className="error-text" style={{ marginBottom: 8 }}>{error}</div>}
        {notice && (
          <div className="notice xf-notice" style={{ marginBottom: 8 }}>
            <span>{notice.text}</span>
            {notice.undo && <button type="button" className="btn btn-sm" onClick={notice.undo}>Undo</button>}
          </div>
        )}

        {!data ? <div className="small-muted">{error ? '' : 'Loading…'}</div> : editing ? (
          <div className="xf-form">
            {editing.builtin && (
              <div className="xf-wide notice">
                <span>
                  This is a <b>built-in field</b>{editing.needed ? <> and it is <b>needed by the system</b> ({editing.neededWhy.toLowerCase()})</> : null}.
                  Its place in the employee record never changes — here you change only how it is shown.
                </span>
              </div>
            )}
            <label className="field xf-wide"><span>Field name</span>
              <input value={editing.label} maxLength={60} onChange={set('label')} placeholder="e.g. T-shirt size" autoFocus />
              {editing.builtin && editing.originalName !== editing.label && <small className="cell-muted">Original name: {editing.originalName}</small>}
            </label>
            {editing.builtin ? (
              <div className="field"><span>Type</span>
                <div className="xf-ro">{editing.typeLabel}{editing.hint ? ` · ${editing.hint}` : ''}</div>
                <small className="cell-muted">Section: {editing.section}</small>
              </div>
            ) : (
              <label className="field"><span>Type</span>
                <Combo value={editing.type} onChange={set('type')} disabled={!!editing.id && editing.valueCount > 0}>
                  {data.types.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </Combo>
                <small className="cell-muted">{HINT[editing.type]}{editing.id && editing.valueCount > 0 ? ' The type is locked because people already have a value.' : ''}</small>
              </label>
            )}
            {!editing.builtin && (
              <label className="field"><span>Group (optional)</span>
                <input list="xf-groups" value={editing.group} maxLength={40} onChange={set('group')} placeholder="Extra details" />
                <datalist id="xf-groups">{(data.groups || []).map((g) => <option key={g} value={g} />)}</datalist>
                <small className="cell-muted">The heading it sits under. Empty = “Extra details”.</small>
              </label>
            )}
            {editing.builtin && editing.choicesFrom && (
              <div className="field xf-wide"><span>Choices</span>
                <div className="xf-ro">The choices come from the company lists.</div>
                <small className="cell-muted">To change them go to <Link to="/admin/master-lists" onClick={onClose}>Company Setup → Master lists</Link>.</small>
              </div>
            )}
            {choiceType && (
              <label className="field xf-wide"><span>Choices (one per line)</span>
                <textarea rows={5} value={editing.options} onChange={set('options')} placeholder={'Small\nMedium\nLarge'} />
              </label>
            )}
            {!editing.builtin && editing.type === 'NUMBER' && (
              <>
                <label className="field"><span>Smallest allowed</span><input type="number" value={editing.minValue} onChange={set('minValue')} placeholder="No limit" /></label>
                <label className="field"><span>Largest allowed</span><input type="number" value={editing.maxValue} onChange={set('maxValue')} placeholder="No limit" /></label>
              </>
            )}
            {!editing.builtin && editing.type === 'TEXT' && (
              <label className="field"><span>Longest text (characters)</span><input type="number" min={1} max={2000} value={editing.maxLength} onChange={set('maxLength')} placeholder="500" /></label>
            )}
            <label className="field xf-wide"><span>Help text (optional)</span>
              <input value={editing.helpText} maxLength={200} onChange={set('helpText')} placeholder="Shown under the field" />
            </label>
            {(() => {
              const lockedWhy = editing.requiredLocked ? 'Always required — the system needs it.'
                : (editing.id && !editing.active ? 'This field is paused. Resume it before making it required.' : '');
              return (
                <label className="xf-check xf-wide">
                  <input type="checkbox" checked={editing.required} disabled={!!lockedWhy} onChange={set('required')} />
                  <span>{lockedWhy || (editing.type === 'CHECKBOX' ? 'Must be ticked' : 'Required — the form cannot be saved without it')}</span>
                </label>
              );
            })()}
            {editing.id && (
              <div className="xf-wide small-muted">
                Shown in: {Object.entries(editing.where || {}).filter(([, on]) => on).map(([k]) => ({ form: 'the form', profile: 'the profile', list: 'the list' }[k])).join(', ') || '—'}.
                {editing.valueCount != null && ` ${editing.valueCount} ${editing.valueCount === 1 ? 'person has' : 'people have'} a value saved.`}
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="xf-help">
              Every field of the employee form is here. <b>Pause</b> hides a field from the form, the profile and the list
              — nothing is deleted, and <b>Resume</b> brings it back. Fields the system needs cannot be paused.
              {!canConfigure && <> <b>Only the Super Admin and HR can change fields.</b></>}
            </div>
            <div className="xf-bar">
              <input
                type="search" className="xf-search" placeholder="Search a field…" value={q}
                onChange={(e) => setQ(e.target.value)} aria-label="Search fields"
              />
              <div className="xf-filters" role="group" aria-label="Show">
                {FILTERS.map(([id, label]) => (
                  <button
                    type="button" key={id}
                    className={`btn btn-sm xf-filter${filter === id ? ' on' : ''}`}
                    onClick={() => setFilter(id)}
                    aria-pressed={filter === id}
                  >{label} <span className="xf-count">{counts[id]}</span></button>
                ))}
              </div>
            </div>
            {!moving && canConfigure && <div className="small-muted" style={{ marginBottom: 6 }}>To move a field up or down, show <b>All</b> and clear the search.</div>}

            {shownFields.length === 0 ? (
              <div className="xf-empty">No field matches{q ? ` “${q}”` : ''}{filter !== 'all' ? ` in ${FILTERS.find((x) => x[0] === filter)[1]}` : ''}. {fields.length ? 'Press “All” to see every field.' : ''}</div>
            ) : (
              <div className="xf-list">
                {shownFields.map((f) => {
                  const head = f.section !== lastSection;
                  lastSection = f.section;
                  const allIdx = fields.findIndex((x) => x.id === f.id);
                  const sameAbove = allIdx > 0 && fields[allIdx - 1].section === f.section;
                  const sameBelow = allIdx < fields.length - 1 && fields[allIdx + 1].section === f.section;
                  return (
                    <div key={f.id}>
                      {head && <div className="xf-section">{f.section}</div>}
                      <div className={`xf-row${f.active ? '' : ' off'}`}>
                        <div className="xf-main">
                          <b>{f.label}</b>{f.required && <span className="xf-req" title="Needed"> (needed)</span>}
                          <span className={`xf-tag ${f.builtin ? 'built' : 'added'}`}>{f.builtin ? 'Built-in' : 'Added by us'}</span>
                          <span className="xf-type">{f.typeLabel}</span>
                          <span className={`status ${f.active ? 'active' : 'pending'}`}>{f.active ? 'Active' : 'Paused'}</span>
                          <div className="cell-muted xf-sub">
                            {f.originalName !== f.label ? `Original name: ${f.originalName} · ` : ''}
                            <Where f={f} />
                            {f.options && f.options.length ? ` · ${f.options.join(' · ')}` : ''}
                            {f.hint ? ` · ${f.hint}` : ''}
                            {' · '}{f.valueCount == null ? '' : (f.valueCount ? `${f.valueCount} filled in` : 'Nobody filled in yet')}
                            {!f.builtin && f.group ? ` · Group: ${f.group}` : ''}
                          </div>
                          {!f.canPause && f.active && (
                            <div className="xf-why">{f.needed ? f.neededWhy : 'Required — make it optional first, then you can pause it.'}</div>
                          )}
                        </div>
                        {canConfigure && (
                          <div className="xf-acts">
                            <button type="button" className="btn btn-sm" disabled={!moving || !sameAbove} onClick={() => move(f, 'up')} title="Move up" aria-label={`Move ${f.label} up`}>↑</button>
                            <button type="button" className="btn btn-sm" disabled={!moving || !sameBelow} onClick={() => move(f, 'down')} title="Move down" aria-label={`Move ${f.label} down`}>↓</button>
                            <button type="button" className="btn btn-sm" onClick={() => openEdit(f)}>Edit</button>
                            {f.active ? (
                              f.needed
                                ? <span className="xf-needed" title={f.neededWhy}>Needed by the system</span>
                                : <button type="button" className="btn btn-sm" disabled={!f.canPause} title={f.canPause ? 'Hide this field. Its saved values are kept.' : f.pauseBlockedWhy} onClick={() => setActive(f, false)}>Pause</button>
                            ) : <button type="button" className="btn btn-sm btn-primary" onClick={() => setActive(f, true)}>Resume</button>}
                            {!f.builtin && <button type="button" className="btn btn-sm btn-danger" onClick={() => remove(f)}>Remove</button>}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
