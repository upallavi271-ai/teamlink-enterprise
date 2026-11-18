import { useCallback, useEffect, useState } from 'react';
import api from '../../api';

// ---------------------------------------------------------------------------
// OFFER LETTER TEMPLATES and SALARY BREAKUP (audit 252 / 253). Backend: routes/offerDepth.js, utils/offerTemplates.js.
//   <OfferExtras>          inside the letter window: which template this offer uses, and its salary breakup (auto-worked from the CTC, editable, the
//                          total must equal the CTC; saved, it is printed in the letter)
//   <OfferTemplatesAdmin>  Admin: several templates (name, body, a client OR an industry) and the default breakup split
// ---------------------------------------------------------------------------
const err = (e, f) => e?.response?.data?.error || f;
const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;

export function OfferExtras({ row, onChanged, readOnly = false }) {
  const [tpl, setTpl] = useState(null);
  const [bk, setBk] = useState(null);
  const [draft, setDraft] = useState({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const [t, b] = await Promise.all([api.get(`/ats/offers/${row.id}/template`), api.get(`/ats/offers/${row.id}/breakup`)]);
      setTpl(t.data); setBk(b.data); setDraft(b.data.components || {});
    } catch (e) { setMsg(err(e, 'Could not load the template and breakup.')); }
  }, [row.id]);
  useEffect(() => { load(); }, [load]);
  if (!tpl || !bk) return msg ? <div className="small-muted">{msg}</div> : null;
  const parts = bk.parts || [];
  const total = parts.reduce((a, p) => a + (Number(draft[p.key]) || 0), 0);
  const diff = Math.round(total - (bk.ctc || 0));
  const run = async (fn, ok) => { setBusy(true); setMsg(''); try { await fn(); await load(); if (onChanged) onChanged(); setMsg(ok); } catch (e) { setMsg(err(e, 'Could not save.')); } finally { setBusy(false); } };
  return (
    <div className="ivx-sec" style={{ marginTop: 12 }}>
      <b>Letter template</b>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select disabled={readOnly || busy} aria-label="Letter template" value={tpl.templateId || ''} onChange={(e) => run(() => api.put(`/ats/offers/${row.id}/template`, { templateId: e.target.value || null }), 'Template changed.')}>
          <option value="">Automatic ({tpl.templateName})</option>
          {tpl.templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.clientName ? ` · ${t.clientName}` : ''}{t.industry ? ` · ${t.industry}` : ''}{t.isDefault ? ' · default' : ''}</option>)}
        </select>
        <span className="small-muted">Using: {tpl.templateName} ({tpl.why})</span>
      </div>
      <div style={{ marginTop: 10 }}><b>Salary breakup (a year)</b> {bk.saved ? <span className="status active">saved, printed in the letter</span> : <span className="small-muted">not in the letter yet</span>}</div>
      {!(bk.ctc > 0) ? <div className="small-muted">Set the CTC to work out the breakup.</div> : (
        <>
          {bk.stale && <div className="error-text">The CTC changed after this was saved ({inr(bk.ctcAtSave)} to {inr(bk.ctc)}). Recalculate or edit it, or it is left out of the letter.</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 8, margin: '6px 0' }}>
            {parts.map((p) => (
              <label key={p.key}><span className="small-muted">{p.label}</span>
                <input type="number" min="0" disabled={readOnly || busy} value={draft[p.key] ?? 0} onChange={(e) => setDraft((d) => ({ ...d, [p.key]: e.target.value }))} />
              </label>
            ))}
          </div>
          <div className={diff === 0 ? 'small-muted' : 'error-text'}>Total {inr(total)} · CTC {inr(bk.ctc)}{diff === 0 ? ' · matches' : ` · ${diff > 0 ? 'over' : 'short'} by ${inr(Math.abs(diff))}`}</div>
          {!readOnly && (
            <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-sm btn-primary" disabled={busy || diff !== 0} onClick={() => run(() => api.put(`/ats/offers/${row.id}/breakup`, { components: draft }), 'Breakup saved. It is printed in the letter.')}>Save breakup</button>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.delete(`/ats/offers/${row.id}/breakup`), 'Worked out again from the CTC (not in the letter until saved).')}>Recalculate from CTC</button>
              {bk.saved && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => run(() => api.delete(`/ats/offers/${row.id}/breakup`), 'Breakup removed from the letter.')}>Leave out of the letter</button>}
            </div>
          )}
        </>
      )}
      {msg && <div className="small-muted" role="status">{msg}</div>}
    </div>
  );
}

const BLANK = { id: null, name: '', body: '', target: 'none', clientId: '', industry: '', isDefault: false, active: true };
export function OfferTemplatesAdmin() {
  const [data, setData] = useState(null);
  const [clients, setClients] = useState([]);
  const [form, setForm] = useState(null);
  const [split, setSplit] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api.get('/ats/offer-templates').then((r) => setData(r.data)).catch((e) => setMsg(err(e, 'Could not load the templates.')));
    api.get('/ats/offer-breakup-settings').then((r) => setSplit(r.data)).catch(() => null);
  }, []);
  useEffect(() => { load(); api.get('/clients', { params: { pageSize: 500 } }).then((r) => setClients(Array.isArray(r.data) ? r.data : (r.data.rows || r.data.clients || []))).catch(() => null); }, [load]);
  if (!data) return <div className="small-muted">{msg || 'Loading…'}</div>;
  const edit = (t) => setForm({ ...BLANK, ...t, target: t.clientId ? 'client' : t.industry ? 'industry' : 'none' });
  async function save() {
    setBusy(true); setMsg('');
    try {
      const body = { name: form.name, body: form.body, isDefault: form.isDefault, active: form.active, clientId: form.target === 'client' ? form.clientId : null, industry: form.target === 'industry' ? form.industry : null };
      if (form.id) await api.put(`/ats/offer-templates/${form.id}`, body); else await api.post('/ats/offer-templates', body);
      setForm(null); load(); setMsg('Saved.');
    } catch (e) { setMsg(err(e, 'Could not save the template.')); } finally { setBusy(false); }
  }
  async function saveSplit() {
    setBusy(true); setMsg('');
    try { await api.put('/ats/offer-breakup-settings', split.split); load(); setMsg('Default split saved. New breakups use it.'); } catch (e) { setMsg(err(e, 'Could not save the split.')); } finally { setBusy(false); }
  }
  const special = split ? Math.round((100 - Object.values(split.split).reduce((a, b) => a + (Number(b) || 0), 0)) * 100) / 100 : 0;
  return (
    <div className="ivx-fb" style={{ marginTop: 16 }}>
      <b>More letter templates</b>
      <div className="ivx-hint">An offer uses the template chosen on it, else the one for its client, else the one for the client's industry, else the default, else the standard letter above.</div>
      {data.rows.length === 0 && <div className="small-muted">None yet. The standard letter is used for everyone.</div>}
      {data.rows.map((t) => (
        <div key={t.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0' }}>
          <b>{t.name}</b>
          <span className="small-muted">{t.clientName ? `client: ${t.clientName}` : t.industry ? `industry: ${t.industry}` : 'any'}{t.isDefault ? ' · default' : ''}{t.active ? '' : ' · off'}</span>
          <button type="button" className="link-btn" onClick={() => edit(t)}>Edit</button>
          <button type="button" className="link-btn" onClick={async () => { if (window.confirm(`Remove "${t.name}"?`)) { await api.delete(`/ats/offer-templates/${t.id}`).catch((e) => setMsg(err(e, 'Could not remove.'))); load(); } }}>Remove</button>
        </div>
      ))}
      {!form && <button type="button" className="btn btn-sm" onClick={() => setForm({ ...BLANK })}>+ Add a template</button>}
      {form && (
        <div className="card" style={{ padding: 10, marginTop: 6 }}>
          <input placeholder="Template name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ width: '100%' }} />
          <div style={{ display: 'flex', gap: 8, margin: '6px 0', flexWrap: 'wrap' }}>
            <select value={form.target} aria-label="Applies to" onChange={(e) => setForm({ ...form, target: e.target.value })}><option value="none">Any client (use as a default or pick it by hand)</option><option value="client">One client</option><option value="industry">An industry</option></select>
            {form.target === 'client' && <select value={form.clientId} aria-label="Client" onChange={(e) => setForm({ ...form, clientId: e.target.value })}><option value="">Pick the client…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
            {form.target === 'industry' && <input placeholder="Industry, e.g. Education" value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value })} />}
            <label><input type="checkbox" checked={form.isDefault} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} /> Default</label>
            <label><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> On</label>
          </div>
          <textarea rows="9" style={{ width: '100%' }} placeholder="Dear {{name}}, ..." value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
          <div className="ivx-hint">{(data.tokens || []).map((k) => `{{${k}}}`).join(' ')}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}><button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={save}>Save template</button><button type="button" className="btn btn-sm btn-ghost" onClick={() => setForm(null)}>Cancel</button></div>
        </div>
      )}
      {split && (
        <div style={{ marginTop: 14 }}>
          <b>Default salary breakup (percent of yearly CTC)</b>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '6px 0' }}>
            {split.parts.filter((p) => p.key !== 'specialAllowance').map((p) => (
              <label key={p.key}><span className="small-muted">{p.label} %</span>
                <input type="number" min="0" max="100" step="0.01" style={{ width: 90 }} disabled={!split.canEdit} value={split.split[p.key]} onChange={(e) => setSplit({ ...split, split: { ...split.split, [p.key]: e.target.value } })} />
              </label>
            ))}
            <label><span className="small-muted">Special allowance % (the balance)</span><input style={{ width: 90 }} disabled value={special} readOnly /></label>
          </div>
          {split.canEdit && <button type="button" className="btn btn-sm btn-primary" disabled={busy || special < 0} onClick={saveSplit}>Save split</button>}
          {special < 0 && <span className="error-text"> The parts add up to more than 100%.</span>}
        </div>
      )}
      {msg && <div className="small-muted" role="status">{msg}</div>}
    </div>
  );
}
