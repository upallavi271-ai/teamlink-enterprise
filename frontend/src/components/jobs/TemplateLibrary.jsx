import { useEffect, useState } from 'react';
import api from '../../api';

// "My job templates" (2026-10-13): use, rename, replace with the text now on screen, delete; and save a new one.
// onUse(template) fills the editor. texts = the text now on screen. Server: /api/job-broadcast/templates (GET/POST/PUT/DELETE).
export default function TemplateLibrary({ texts, jobTitle = '', onUse, canSaveNew = true }) {
  const [lib, setLib] = useState([]);
  const [canEdit, setCanEdit] = useState(false);
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState(null); // { id, name }
  const [editingId, setEditingId] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const load = () => api.get('/job-broadcast/templates').then((r) => { setLib(r.data.templates || []); setCanEdit(!!r.data.canEdit); }).catch(() => {});
  useEffect(() => { load(); }, []);
  async function run(fn, ok) {
    setBusy(true); setErr(''); setMsg('');
    try { const r = await fn(); setMsg((r && r.data && r.data.ok) || ok); await load(); } catch (e) { setErr(e.response?.data?.error || 'That did not work. Please try again.'); } finally { setBusy(false); }
  }
  return (
    <div className="rsp-libbox">
      {lib.length === 0 && <div className="rsp-note">Nothing saved yet. Save this text to use it for similar requirements.</div>}
      {lib.map((t) => (
        <div key={t.id} className="rsp-librow" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', margin: '4px 0' }}>
          {renaming && renaming.id === t.id ? (
            <>
              <input value={renaming.name} maxLength={80} onChange={(e) => setRenaming({ id: t.id, name: e.target.value })} aria-label="New name" />
              <button type="button" className="btn btn-sm btn-primary" disabled={busy || renaming.name.trim().length < 2} onClick={() => run(() => api.put(`/job-broadcast/templates/${t.id}`, { name: renaming.name }).then((r) => { setRenaming(null); return r; }), 'Renamed.')}>Save name</button>
              <button type="button" className="btn btn-sm" onClick={() => setRenaming(null)}>Cancel</button>
            </>
          ) : (
            <>
              <button type="button" className="rsp-tab" onClick={() => { onUse(t); setMsg(`Filled from "${t.name}". Read it, then save.`); setErr(''); }}>{t.name}</button>
              {canEdit && (
                <>
                  <button type="button" className="btn btn-sm" title="Open this template's words in the editor, change them, then save" onClick={() => { onUse(t); setEditingId(t.id); setErr(''); setMsg(`Editing "${t.name}". Change the text, then press Save changes.`); }}>Edit</button>
                  <button type="button" className="rsp-link" onClick={() => setRenaming({ id: t.id, name: t.name })}>Rename</button>
                  <button type="button" className="rsp-link" disabled={busy || !texts} title="Replace this template's text with the text now on screen" onClick={() => run(() => api.put(`/job-broadcast/templates/${t.id}`, { texts }).then((r) => { setEditingId(''); return r; }), 'Template text updated.')}>{editingId === t.id ? 'Save changes' : 'Update text from screen'}</button>
                  <button type="button" className="rsp-link" disabled={busy} onClick={() => { if (window.confirm(`Delete the template "${t.name}"?`)) run(() => api.delete(`/job-broadcast/templates/${t.id}`), 'Deleted.'); }}>Delete</button>
                </>
              )}
            </>
          )}
        </div>
      ))}
      {canEdit && canSaveNew && (
        <div className="rsp-libsave">
          <input maxLength={80} placeholder="Name, for example Staff nurse" value={name} onChange={(e) => setName(e.target.value)} aria-label="Template name" />
          <button type="button" className="btn btn-sm" disabled={busy || name.trim().length < 2 || !texts} onClick={() => run(() => api.post('/job-broadcast/templates', { name, texts, jobTitle }).then((r) => { setName(''); return r; }), 'Saved.')}>{busy ? 'Saving…' : 'Save to My job templates'}</button>
        </div>
      )}
      {msg && <div className="rsp-note" role="status">{msg}</div>}
      {err && <div className="rsp-note rsp-err" role="alert">{err}</div>}
    </div>
  );
}
