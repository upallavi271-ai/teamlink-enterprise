import { Fragment, forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import api from '../../api';
import './ExtraFields.css';

// The fields an administrator added in Employee Management -> Manage Fields
// (HRMS spec item 15), on one employee's record.
//   editable  inside HR's Edit form — the form's own "Save changes" calls
//             ref.save(); ref.validate() first says what is wrong, in words.
//   (else)    read-only list on the record view.
// A File field uploads at once (the employee already exists).

function checkOne(f, v) {
  const empty = v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
  if (f.type === 'FILE') return '';
  if (f.type === 'CHECKBOX') return f.required && !v ? `Tick "${f.label}".` : '';
  if (empty) return f.required ? `"${f.label}" is required.` : '';
  if (f.type === 'NUMBER') {
    const n = Number(v);
    if (!Number.isFinite(n)) return `"${f.label}" must be a number.`;
    if (f.minValue != null && n < f.minValue) return `"${f.label}" must be at least ${f.minValue}.`;
    if (f.maxValue != null && n > f.maxValue) return `"${f.label}" must be at most ${f.maxValue}.`;
  }
  if (f.type === 'TEXT' && String(v).length > (f.maxLength || 500)) return `"${f.label}" can have at most ${f.maxLength || 500} characters.`;
  return '';
}

function shown(f) {
  const v = f.value;
  if (f.type === 'CHECKBOX') return v ? 'Yes' : 'No';
  if (f.type === 'MULTISELECT') return v && v.length ? v.join(', ') : '—';
  if (f.type === 'DATE' && v) return new Date(`${v}T00:00:00`).toLocaleDateString('en-GB');
  if (f.type === 'FILE') return v ? v.name : 'No file yet';
  return v === null || v === undefined || v === '' ? '—' : String(v);
}

const ExtraFields = forwardRef(function ExtraFields({ employeeId, editable = false }, ref) {
  const [data, setData] = useState(null);
  const [vals, setVals] = useState({});
  const [errs, setErrs] = useState({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');

  function load() {
    if (!employeeId) return;
    api.get(`/employee-fields/values/${employeeId}`)
      .then((r) => {
        setData(r.data);
        setVals(Object.fromEntries(r.data.fields.map((f) => [f.key, f.value])));
      })
      .catch(() => setData({ fields: [], canEdit: false }));
  }
  useEffect(load, [employeeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const fields = data?.fields || [];
  const canEdit = editable && data?.canEdit;

  function validate() {
    const e = {};
    fields.forEach((f) => { const why = checkOne(f, vals[f.key]); if (why) e[f.key] = why; });
    setErrs(e);
    return Object.values(e)[0] || '';
  }

  async function save() {
    if (!canEdit || !fields.length) return { saved: 0 };
    const why = validate();
    if (why) throw new Error(why);
    const values = Object.fromEntries(fields.filter((f) => f.type !== 'FILE').map((f) => [f.key, vals[f.key]]));
    try {
      const r = await api.put(`/employee-fields/values/${employeeId}`, { values });
      load();
      return r.data;
    } catch (err) {
      if (err.response?.data?.errors) setErrs(err.response.data.errors);
      throw new Error(err.response?.data?.error || 'The extra details could not be saved.');
    }
  }

  useImperativeHandle(ref, () => ({ save, validate }));

  async function upload(f, file) {
    if (!file) return;
    setMsg(''); setBusy(f.key);
    try {
      const body = new FormData();
      body.append('file', file);
      await api.post(`/employee-fields/values/${employeeId}/${f.id}/file`, body);
      setMsg(`"${f.label}" uploaded.`);
      load();
    } catch (err) {
      setErrs((e) => ({ ...e, [f.key]: err.response?.data?.error || 'Upload failed.' }));
    } finally { setBusy(''); }
  }

  async function openFile(f) {
    try {
      const r = await api.get(`/employee-fields/values/${employeeId}/${f.id}/file`, { params: { disposition: 'attachment' }, responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url; a.download = f.value?.name || 'file';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { setErrs((e) => ({ ...e, [f.key]: 'Could not open that file.' })); }
  }

  if (!data || !fields.length) return null;
  // Fields HR put under a heading of their own (Manage Fields -> Group) are shown under it.
  const groupsOf = (list) => {
    const out = [];
    list.forEach((f) => {
      const name = f.group || '';
      let g = out.find((x) => x.name === name);
      if (!g) { g = { name, items: [] }; out.push(g); }
      g.items.push(f);
    });
    return out;
  };

  const set = (k, v) => { setVals((s) => ({ ...s, [k]: v })); setErrs((e) => ({ ...e, [k]: '' })); };

  if (!canEdit) {
    return (
      <div className="card section xfields">
        <h3>Extra details</h3>
        {groupsOf(fields).map((g) => (
          <div key={g.name || '_'}>
            {g.name && <h4 style={{ margin: '10px 0 6px', fontSize: 12.5 }}>{g.name}</h4>}
            <div className="xf-view">
              {g.items.map((f) => (
                <div className="kv" key={f.key}>
                  <span className="k">{f.label}</span>
                  <span>
                    {shown(f)}
                    {f.type === 'FILE' && f.value && <> <button type="button" className="btn btn-sm" onClick={() => openFile(f)}>Download</button></>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="xfields xf-embedded">
      <h3 style={{ marginTop: 14 }}>Extra details</h3>
      {msg && <div className="notice" style={{ marginBottom: 8 }}>{msg}</div>}
      <div className="xf-grid">
        {groupsOf(fields).flatMap((g) => g.items).map((f, idx, ordered) => {
          const v = vals[f.key];
          const label = <span>{f.label}{f.required && <b className="xf-req"> ✱</b>}</span>;
          let input;
          if (f.type === 'TEXT') input = <input value={v || ''} maxLength={f.maxLength || 500} onChange={(e) => set(f.key, e.target.value)} />;
          else if (f.type === 'NUMBER') input = <input type="number" value={v ?? ''} min={f.minValue ?? undefined} max={f.maxValue ?? undefined} onChange={(e) => set(f.key, e.target.value)} />;
          else if (f.type === 'DATE') input = <input type="date" value={v || ''} onChange={(e) => set(f.key, e.target.value)} />;
          else if (f.type === 'DROPDOWN') {
            input = (
              <select value={v || ''} onChange={(e) => set(f.key, e.target.value)}>
                <option value="">Choose…</option>
                {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            );
          } else if (f.type === 'MULTISELECT') {
            const list = Array.isArray(v) ? v : [];
            input = (
              <div className="xf-chips">
                {f.options.map((o) => (
                  <label key={o} className={`xf-chip${list.includes(o) ? ' on' : ''}`}>
                    <input type="checkbox" checked={list.includes(o)} onChange={(e) => set(f.key, e.target.checked ? [...list, o] : list.filter((x) => x !== o))} />
                    {o}
                  </label>
                ))}
              </div>
            );
          } else if (f.type === 'CHECKBOX') {
            input = <label className="xf-check"><input type="checkbox" checked={!!v} onChange={(e) => set(f.key, e.target.checked)} /> <span>Yes</span></label>;
          } else if (f.type === 'FILE') {
            input = (
              <div className="xf-file">
                <span className="cell-muted">{f.value ? f.value.name : 'No file yet'}</span>
                {f.value && <button type="button" className="btn btn-sm" onClick={() => openFile(f)}>Download</button>}
                <label className="btn btn-sm xf-pick">
                  {busy === f.key ? 'Uploading…' : (f.value ? 'Replace file' : 'Upload file')}
                  <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" disabled={busy === f.key} onChange={(e) => { upload(f, e.target.files[0]); e.target.value = ''; }} />
                </label>
                <small className="cell-muted">{data.fileRule}</small>
              </div>
            );
          }
          const heading = f.group && (idx === 0 || ordered[idx - 1].group !== f.group);
          return (
            <Fragment key={f.key}>
              {heading && <h4 className="xf-wide" style={{ margin: '10px 0 0', fontSize: 12.5 }}>{f.group}</h4>}
              <div className={`field xf-field${['MULTISELECT', 'FILE'].includes(f.type) ? ' xf-wide' : ''}`}>
                {label}
                {input}
                {f.helpText && <small className="cell-muted">{f.helpText}</small>}
                {errs[f.key] && <small className="error-text">{errs[f.key]}</small>}
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
});

export default ExtraFields;
