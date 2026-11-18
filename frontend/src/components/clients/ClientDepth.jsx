import { useCallback, useEffect, useState } from 'react';
import api from '../../api';

// ---------------------------------------------------------------------------
// CLIENT DEPTH on Client 360 (audit 133 / 134 / 142 / 377 / 711). Backend: routes/clientDepth.js, utils/clientDepth.js.
//   <ClientContacts>  unlimited contacts, each with a role (HR, HOD, Dean, Principal, Director, Finance, Other); the four old slots are in the list
//   <ClientCredit>    credit period in days and the credit limit; the invoice due date follows the days
//   <PortalUsage>     what the client's logins view and do in the portal (BDE team, Managers, Admins; hides itself for anyone else)
// ---------------------------------------------------------------------------
const err = (e, f) => e?.response?.data?.error || f;
const tel = (v) => String(v).replace(/[^\d+]/g, '');
const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const when = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const BLANK = { id: null, role: 'HR', name: '', designation: '', phone: '', email: '', whatsapp: '', notes: '' };

export function ClientContacts({ clientId, onChanged }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get(`/ats-clients/clients/${clientId}/contacts`).then((r) => setData(r.data)).catch((e) => setMsg(err(e, 'The contacts could not be loaded.'))), [clientId]);
  useEffect(() => { load(); }, [load]);
  if (!data) return <div className="small-muted">{msg || 'Loading the contacts…'}</div>;
  async function save() {
    setBusy(true); setMsg('');
    try {
      const body = { role: form.role, name: form.name, designation: form.designation, phone: form.phone, email: form.email, whatsapp: form.whatsapp, notes: form.notes };
      if (form.id) await api.put(`/ats-clients/contacts/${form.id}`, body); else await api.post(`/ats-clients/clients/${clientId}/contacts`, body);
      setForm(null); await load(); if (onChanged) onChanged();
    } catch (e) { setMsg(err(e, 'Could not save the contact.')); } finally { setBusy(false); }
  }
  async function remove(c) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Remove ${c.name || c.role}?`)) return;
    try { await api.delete(`/ats-clients/contacts/${c.id}`); await load(); if (onChanged) onChanged(); } catch (e) { setMsg(err(e, 'Could not remove.')); }
  }
  return (
    <div>
      {data.rows.length === 0 ? <div className="small-muted">No contact yet.</div> : (
        <div className="clrole-contacts">
          {data.rows.map((c) => (
            <div key={c.id} className="card">
              <div className="role">{c.role}</div>
              <div className="who">{c.name || '—'}</div>
              {c.designation && <div className="small-muted">{c.designation}</div>}
              {c.phone && <div><a href={`tel:${tel(c.phone)}`}>{c.phone}</a></div>}
              {c.email && <div><a href={`mailto:${c.email}`}>{c.email}</a></div>}
              {c.whatsapp && <div className="small-muted">WhatsApp {c.whatsapp}</div>}
              {c.notes && <div className="small-muted">{c.notes}</div>}
              {data.canEdit && <div style={{ marginTop: 4 }}><button type="button" className="link-btn" onClick={() => setForm({ ...BLANK, ...c })}>Edit</button> <button type="button" className="link-btn" onClick={() => remove(c)}>Remove</button></div>}
            </div>
          ))}
        </div>
      )}
      {data.canEdit && !form && <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setForm({ ...BLANK })}>+ Add a contact</button>}
      {form && (
        <div className="card" style={{ padding: 12, marginTop: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
            <select aria-label="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{data.roles.map((r) => <option key={r}>{r}</option>)}</select>
            <input placeholder="Name" value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input placeholder="Designation" value={form.designation || ''} onChange={(e) => setForm({ ...form, designation: e.target.value })} />
            <input placeholder="Phone" value={form.phone || ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <input placeholder="Email" type="email" value={form.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <input placeholder="WhatsApp" value={form.whatsapp || ''} onChange={(e) => setForm({ ...form, whatsapp: e.target.value })} />
          </div>
          <input placeholder="Note (optional)" style={{ width: '100%', marginTop: 8 }} value={form.notes || ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}><button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save contact'}</button><button type="button" className="btn btn-sm btn-ghost" onClick={() => setForm(null)}>Cancel</button></div>
        </div>
      )}
      {msg && <div className="error-text" role="alert">{msg}</div>}
    </div>
  );
}

export function ClientCredit({ clientId }) {
  const [c, setC] = useState(null);
  const [draft, setDraft] = useState({ creditDays: '', creditLimit: '' });
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get(`/ats-clients/clients/${clientId}/credit`).then((r) => { setC(r.data); setDraft({ creditDays: r.data.creditDays ?? '', creditLimit: r.data.creditLimit ?? '' }); }).catch(() => setC(null)), [clientId]);
  useEffect(() => { load(); }, [load]);
  if (!c) return null;
  async function save() {
    setBusy(true); setMsg('');
    try { await api.put(`/ats-clients/clients/${clientId}/credit`, draft); await load(); setMsg('Saved. New invoices fall due this many days after their date.'); } catch (e) { setMsg(err(e, 'Could not save.')); } finally { setBusy(false); }
  }
  return (
    <div className="ccr-section" style={{ marginTop: 16 }}>
      <div className="section-label">Credit terms</div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        {c.canEdit ? (
          <>
            <label><span className="small-muted">Credit period (days)</span><input type="number" min="0" max="365" style={{ width: 110 }} value={draft.creditDays} onChange={(e) => setDraft({ ...draft, creditDays: e.target.value })} /></label>
            <label><span className="small-muted">Credit limit (₹)</span><input type="number" min="0" style={{ width: 150 }} value={draft.creditLimit} onChange={(e) => setDraft({ ...draft, creditLimit: e.target.value })} /></label>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={save}>Save</button>
          </>
        ) : <span>{c.creditDays == null ? 'No credit period set' : `${c.creditDays} days`}{c.creditLimit != null ? ` · limit ${inr(c.creditLimit)}` : ''}</span>}
        <span className={c.overLimit ? 'error-text' : 'small-muted'}>Outstanding {inr(c.outstanding)}{c.overLimit ? ' - over the limit' : ''}</span>
      </div>
      {msg && <div className="small-muted" role="status">{msg}</div>}
    </div>
  );
}

export function PortalUsage({ clientId }) {
  const [u, setU] = useState(null);
  useEffect(() => { api.get(`/ats-clients/clients/${clientId}/portal-usage`, { params: { days: 30 } }).then((r) => setU(r.data)).catch(() => setU(null)); }, [clientId]);
  if (!u) return null;
  const tile = (n, label) => <div className="card" style={{ padding: '8px 12px', minWidth: 110 }}><div style={{ fontSize: 20, fontWeight: 600 }}>{n}</div><div className="small-muted">{label}</div></div>;
  return (
    <div className="ccr-section" style={{ marginTop: 16 }}>
      <div className="section-label">Portal use (last {u.days} days)</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {tile(u.logins, 'Logins')}{tile(u.visits, 'Visits')}{tile(u.requirementsRaised, 'Requirements raised')}{tile(u.profilesReviewed, 'Profiles reviewed')}{tile(u.decisions, 'Decisions made')}
      </div>
      <div className="small-muted" style={{ marginTop: 4 }}>Last login {when(u.lastLogin)} · last activity {when(u.lastActivity)}{!u.counting ? ' · counting started with this update' : ''}</div>
    </div>
  );
}
