import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import './ExtraFields.css';

// Employee Management -> MANAGE FIELDS (HRMS spec item 15).
// Add your own fields to the employee form: Text, Number, Date, Dropdown,
// Multi-select, Checkbox or File — each with simple rules. One main button
// per step: "Add field" opens the form, "Save field" saves it.

const BLANK = { id: null, label: '', type: 'TEXT', options: '', required: false, minValue: '', maxValue: '', maxLength: '', helpText: '' };
const HINT = {
  TEXT: 'Short text, e.g. T-shirt size or nickname.',
  NUMBER: 'A number, e.g. years of experience.',
  DATE: 'A date, e.g. passport expiry.',
  DROPDOWN: 'Pick ONE from your list.',
  MULTISELECT: 'Pick ONE OR MORE from your list.',
  CHECKBOX: 'A yes / no tick, e.g. "Has own laptop".',
  FILE: 'A file (PDF or photo, up to 5 MB).',
};

export default function ManageFieldsModal({ onClose }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  function load() {
    api.get('/employee-fields', { params: { all: 1 } })
      .then((r) => setData(r.data))
      .catch((err) => setError(err.response?.data?.error || 'Could not load the fields.'));
  }
  useEffect(load, []);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  async function save() {
    setError(''); setNotice(''); setBusy(true);
    const body = {
      label: form.label, type: form.type, required: form.required, helpText: form.helpText,
      options: form.options, minValue: form.minValue, maxValue: form.maxValue, maxLength: form.maxLength,
    };
    try {
      if (form.id) await api.put(`/employee-fields/${form.id}`, body);
      else await api.post('/employee-fields', body);
      setNotice(form.id ? `Saved "${form.label}".` : `Added "${form.label}". It now shows on every employee's form.`);
      setForm(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'That field could not be saved.');
    } finally { setBusy(false); }
  }

  async function toggle(f) {
    setError(''); setNotice('');
    try {
      await api.put(`/employee-fields/${f.id}`, { active: !f.active });
      setNotice(f.active ? `"${f.label}" is hidden now. Its values are kept.` : `"${f.label}" shows on the form again.`);
      load();
    } catch (err) { setError(err.response?.data?.error || 'That change could not be saved.'); }
  }

  async function remove(f) {
    // eslint-disable-next-line no-alert
    if (!confirm(f.valueCount
      ? `"${f.label}" has values for ${f.valueCount} employee(s). It will be hidden and the values kept. Continue?`
      : `Remove "${f.label}"?`)) return;
    setError(''); setNotice('');
    try {
      const r = await api.delete(`/employee-fields/${f.id}`);
      setNotice(r.data?.message || 'Removed.');
      load();
    } catch (err) { setError(err.response?.data?.error || 'That field could not be removed.'); }
  }

  async function move(f, dir) {
    const list = data.fields;
    const i = list.findIndex((x) => x.id === f.id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    try {
      await Promise.all([
        api.put(`/employee-fields/${list[i].id}`, { position: j }),
        api.put(`/employee-fields/${list[j].id}`, { position: i }),
      ]);
      load();
    } catch (err) { setError(err.response?.data?.error || 'Could not move the field.'); }
  }

  const canConfigure = data?.canConfigure;
  const choiceType = form && ['DROPDOWN', 'MULTISELECT'].includes(form.type);

  return (
    <Modal
      title={form ? (form.id ? `Edit field — ${form.label || ''}` : 'Add a field') : 'Manage Fields'}
      size="wide"
      onClose={onClose}
      foot={form ? (
        <>
          <button type="button" className="btn" onClick={() => { setForm(null); setError(''); }}>Back</button>
          <button type="button" className="btn btn-primary" disabled={busy || !form.label.trim()} onClick={save}>{busy ? 'Saving…' : 'Save field'}</button>
        </>
      ) : (
        <>
          <button type="button" className="btn" onClick={onClose}>Close</button>
          {canConfigure && <button type="button" className="btn btn-primary" onClick={() => { setForm({ ...BLANK }); setNotice(''); }}>+ Add field</button>}
        </>
      )}
    >
      <div className="xfields">
        {error && <div className="error-text" style={{ marginBottom: 8 }}>{error}</div>}
        {notice && <div className="notice" style={{ marginBottom: 8 }}>{notice}</div>}

        {!data ? <div className="small-muted">Loading…</div> : form ? (
          <div className="xf-form">
            <label className="field"><span>Field name *</span>
              <input value={form.label} maxLength={60} onChange={set('label')} placeholder="e.g. T-shirt size" autoFocus />
            </label>
            <label className="field"><span>Type</span>
              <select value={form.type} onChange={set('type')} disabled={!!form.id && form.valueCount > 0}>
                {data.types.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <small className="cell-muted">{HINT[form.type]}{form.id && form.valueCount > 0 ? ' The type is locked because people already have a value.' : ''}</small>
            </label>
            {choiceType && (
              <label className="field xf-wide"><span>Choices * (one per line)</span>
                <textarea rows={5} value={form.options} onChange={set('options')} placeholder={'Small\nMedium\nLarge'} />
              </label>
            )}
            {form.type === 'NUMBER' && (
              <>
                <label className="field"><span>Smallest allowed</span><input type="number" value={form.minValue} onChange={set('minValue')} placeholder="No limit" /></label>
                <label className="field"><span>Largest allowed</span><input type="number" value={form.maxValue} onChange={set('maxValue')} placeholder="No limit" /></label>
              </>
            )}
            {form.type === 'TEXT' && (
              <label className="field"><span>Longest text (characters)</span><input type="number" min={1} max={2000} value={form.maxLength} onChange={set('maxLength')} placeholder="500" /></label>
            )}
            <label className="field xf-wide"><span>Help text (optional)</span>
              <input value={form.helpText} maxLength={200} onChange={set('helpText')} placeholder="Shown under the field" />
            </label>
            <label className="xf-check xf-wide">
              <input type="checkbox" checked={form.required} onChange={set('required')} />
              <span>{form.type === 'CHECKBOX' ? 'Must be ticked' : 'Required — the form cannot be saved without it'}</span>
            </label>
          </div>
        ) : data.fields.length === 0 ? (
          <div className="xf-empty">
            No extra fields yet.{canConfigure ? ' Press "+ Add field" to add your first one.' : ''}
          </div>
        ) : (
          <div className="xf-list">
            {data.fields.map((f, i) => (
              <div className={`xf-row${f.active ? '' : ' off'}`} key={f.id}>
                <div className="xf-main">
                  <b>{f.label}</b>{f.required && <span className="xf-req" title="Required"> ✱</span>}
                  <span className="xf-type">{f.typeLabel}</span>
                  {!f.active && <span className="status pending">Hidden</span>}
                  <div className="cell-muted xf-sub">
                    {f.options.length ? `${f.options.join(' · ')} · ` : ''}
                    {f.valueCount ? `${f.valueCount} employee${f.valueCount === 1 ? '' : 's'} filled in` : 'Nobody filled in yet'}
                  </div>
                </div>
                {canConfigure && (
                  <div className="xf-acts">
                    <button type="button" className="btn btn-sm" disabled={i === 0} onClick={() => move(f, -1)} title="Move up">↑</button>
                    <button type="button" className="btn btn-sm" disabled={i === data.fields.length - 1} onClick={() => move(f, 1)} title="Move down">↓</button>
                    <button type="button" className="btn btn-sm" onClick={() => setForm({
                      ...BLANK, ...f, options: f.options.join('\n'), minValue: f.minValue ?? '', maxValue: f.maxValue ?? '', maxLength: f.maxLength ?? '', helpText: f.helpText || '',
                    })}
                    >Edit</button>
                    <button type="button" className="btn btn-sm" onClick={() => toggle(f)}>{f.active ? 'Hide' : 'Show'}</button>
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => remove(f)}>Remove</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
