import { useEffect, useState } from 'react';
import api from '../../api';
import Combo from '../Combo.jsx';
import { useAuth } from '../../context/AuthContext.jsx';

// ---------------------------------------------------------------------------
// B9.4 — JOB TEMPLATES on the Add job form.
//   "Start from a template" — picks a saved template and fills the form
//   (the job's own fields only: never the client, the team, dates or sites).
//   "Save as template"      — saves what is on the form now under a name.
// Templates: GET/POST/DELETE /requirements/templates (AppSetting, no schema).
// Props: form (the form state), toForm (formFromRequirement), payload (the
// form → requirement body), onApply (patch the form).
// ---------------------------------------------------------------------------
const KEEP = ['title', 'department', 'openings', 'priority', 'jobDescription', 'responsibilities', 'qualifications', 'education',
  'skills', 'goodToHaveSkills', 'employmentType', 'workMode', 'location', 'preferredLocation', 'expMin', 'expMax', 'relevantExperience',
  'joiningTimeline', 'noticePeriodMax', 'jobPreference', 'salaryType', 'currency', 'salaryMin', 'salaryMax', 'qualificationId', 'specialisationId'];

export default function JobTemplates({ form, toForm, payload, onApply, onSaved }) {
  const [list, setList] = useState(null);
  const [picked, setPicked] = useState('');
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState('');
  const { user } = useAuth() || {};
  const isAdmin = ['SUPER_ADMIN', 'ADMIN'].includes(user && user.role);
  const [editing, setEditing] = useState(null); // { name, useForm }
  const [editBusy, setEditBusy] = useState(false);

  useEffect(() => {
    let on = true;
    api.get('/requirements/templates').then((r) => { if (on) setList(r.data || []); }).catch(() => { if (on) setList([]); });
    return () => { on = false; };
  }, []);

  function apply(id) {
    setPicked(id);
    const t = (list || []).find((x) => x.id === id);
    if (!t) return;
    const f = toForm({ ...t.fields });
    const patch = {};
    KEEP.forEach((k) => { if (f[k] !== undefined) patch[k] = f[k]; });
    onApply(patch);
    setMsg(`Filled from "${t.name}". Pick the client and the team, then save.`);
  }

  async function save() {
    const nm = name.trim();
    if (nm.length < 2) { setMsg('Give the template a name first.'); return; }
    if (!String(form.title || '').trim()) { setMsg('Fill in the requirement title before saving it as a template.'); return; }
    setSaving(true);
    try {
      const r = await api.post('/requirements/templates', { name: nm, fields: payload() });
      setList((l) => [...(l || []).filter((x) => x.id !== r.data.id), r.data]);
      setPicked(r.data.id);
      setName('');
      setMsg(r.data.replaced ? `Template "${nm}" updated.` : `Saved as template "${nm}". Next time, pick it under Start from a template.`);
      if (onSaved) onSaved();
    } catch (err) {
      setMsg(err.response?.data?.error || 'Could not save the template.');
    } finally { setSaving(false); }
  }

  async function saveEdit() {
    const t = (list || []).find((x) => x.id === picked);
    if (!t || !editing) return;
    const nm = editing.name.trim();
    if (nm.length < 2) { setMsg('Please give the template a name.'); return; }
    const body = { name: nm };
    if (editing.useForm) {
      if (!String(form.title || '').trim()) { setMsg('Please add the requirement title on the form first, then save the changes.'); return; }
      body.fields = payload();
    }
    setEditBusy(true);
    try {
      const r = await api.put(`/requirements/templates/${t.id}`, body);
      setList((l) => (l || []).map((x) => (x.id === t.id ? r.data : x)));
      setEditing(null);
      setMsg(`Template "${nm}" saved.`);
    } catch (err) {
      setMsg(err.response?.data?.error || 'Could not save the changes. Please try again.');
    } finally { setEditBusy(false); }
  }

  async function remove() {
    const t = (list || []).find((x) => x.id === picked);
    if (!t) return;
    if (!window.confirm(`Remove the template "${t.name}"?`)) return;
    try {
      await api.delete(`/requirements/templates/${t.id}`);
      setList((l) => (l || []).filter((x) => x.id !== t.id));
      setPicked('');
      setMsg(`Template "${t.name}" removed.`);
    } catch (err) { setMsg(err.response?.data?.error || 'Could not remove it.'); }
  }

  const has = (list || []).length > 0;
  return (
    <div className="jt-bar" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '8px 10px', border: '1px dashed var(--border, #d6dde8)', borderRadius: 8, marginBottom: 10, background: 'var(--surface-2, #f7f9fc)' }}>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
        <span style={{ fontWeight: 600, fontSize: 12.5 }}>Start from a template</span>
        <Combo value={picked} onChange={(e) => apply(e.target.value)} disabled={list === null} aria-label="Requirement template">
          <option value="">{list === null ? 'Loading…' : (has ? 'Pick a template' : 'No templates yet')}</option>
          {(list || []).map((t) => <option key={t.id} value={t.id}>{t.name}{t.createdByName ? ` — ${t.createdByName}` : ''}</option>)}
        </Combo>
      </label>
      {picked && (list || []).find((x) => x.id === picked && (x.mine || isAdmin)) && (
        <button type="button" className="btn btn-sm" onClick={() => { const t = (list || []).find((x) => x.id === picked); setEditing({ name: t ? t.name : '', useForm: false }); setMsg(''); }}>Edit template</button>
      )}
      {picked && (list || []).find((x) => x.id === picked && !x.mine && !isAdmin) && (
        <>
          {/* Every template shows its Edit button; for someone else's template it is switched off and says why. */}
          <button type="button" className="btn btn-sm" disabled title="Only the person who saved it, or an Admin, can edit this template.">Edit template</button>
          <span className="small-muted">Only the person who saved it, or an Admin, can edit this template.</span>
        </>
      )}
      {picked && (list || []).find((x) => x.id === picked && (x.mine || isAdmin)) && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={remove}>Remove template</button>
      )}
      {editing && (
        <div style={{ flex: '1 1 100%', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input style={{ width: 220 }} maxLength={80} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} aria-label="Template name" />
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0, fontSize: 12.5 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={editing.useForm} onChange={(e) => setEditing({ ...editing, useForm: e.target.checked })} />
            Also replace its requirement details with what is on the form now
          </label>
          <button type="button" className="btn btn-sm btn-primary" disabled={editBusy} onClick={saveEdit}>{editBusy ? 'Saving…' : 'Save changes'}</button>
          <button type="button" className="btn btn-sm" disabled={editBusy} onClick={() => setEditing(null)}>Cancel</button>
        </div>
      )}
      <span style={{ flex: 1 }} />
      <input style={{ width: 200 }} maxLength={80} placeholder="Template name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Template name" />
      <button type="button" className="btn btn-sm" disabled={saving} onClick={save} title="Saves this form's requirement details as a template (not the client, team, dates or sites)">
        {saving ? 'Saving…' : 'Save as template'}
      </button>
      {msg && <div className="small-muted" style={{ flex: '1 1 100%' }}>{msg}</div>}
    </div>
  );
}
