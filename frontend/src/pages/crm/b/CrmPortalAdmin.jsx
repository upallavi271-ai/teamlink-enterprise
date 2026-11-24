// CRM > Accounts & Contacts > Customer portal (CRM wave B, 2026-11-24): who may sign in at /crm-portal (customers see their quotes, invoices
// and tickets; partners register deals), the help articles, the partners and the deals they register, NPS / CSAT survey results.
import { useState } from 'react';
import api from '../../../api';
import { useCrm, errOf, dateOf, dateTimeOf, money } from '../crmShared.jsx';
import { SubTabs, useLoad, OffNote, CopyBox, Empty } from './bShared.jsx';

export function InviteForm({ accountId, contacts = [], resellerId, onDone }) {
  const { toast } = useCrm();
  const [contactId, setContactId] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState('');
  async function go() {
    setBusy(true);
    try {
      const r = await api.post('/crm/b/portal-users', { type: resellerId ? 'partner' : 'customer', accountId, resellerId, contactId: contactId || undefined, email: email || undefined, name: name || undefined });
      setLink(r.data.link);
      toast(r.data.mailed ? 'Invite emailed.' : `Invite made${r.data.mailError ? ` (not emailed: ${r.data.mailError})` : ''}: copy the link to them.`);
      if (onDone) onDone();
    } catch (e) { toast(errOf(e, 'The invite could not be made.')); } finally { setBusy(false); }
  }
  return (
    <div className="card" style={{ padding: 10, marginBottom: 10 }}>
      <div className="grid-3">
        {!resellerId && contacts.length > 0 && <div className="field"><label>Contact</label><select value={contactId} onChange={(e) => setContactId(e.target.value)}><option value="">Type an email instead</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name}{c.email ? ` · ${c.email}` : ''}</option>)}</select></div>}
        {!contactId && <div className="field"><label>Email</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>}
        {!contactId && <div className="field"><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>}
      </div>
      <button type="button" className="btn btn-primary btn-sm" disabled={busy || (!contactId && !email)} onClick={go}>{busy ? 'Inviting…' : 'Invite to the portal'}</button>
      {link && <CopyBox label="The invite link (works for 7 days)" value={link} rows={1} />}
    </div>
  );
}

function Logins() {
  const { toast } = useCrm();
  const { data, reload } = useLoad('/crm/b/portal-users');
  async function remove(u) { if (!window.confirm(`Stop ${u.email} signing in?`)) return; try { await api.delete(`/crm/b/portal-users/${u.id}`); reload(); } catch (e) { toast(errOf(e, 'Not removed.')); } }
  return (
    <>
      {data && <OffNote on={data.on} what="The customer and partner portal" />}
      {data && <p className="small-muted" style={{ marginTop: 0 }}>Customers sign in at <b>{data.loginUrl}</b> and see their own company's quotes, invoices and support tickets, and the help articles. Invite a customer from their account (Web &amp; engagement), a partner from Partners.</p>}
      {data && !data.users.length && <Empty title="Nobody is invited yet" />}
      {data && data.users.length > 0 && <div className="tbl-wrap"><table>
        <thead><tr><th>Login</th><th>For</th><th>Status</th><th>Last signed in</th><th /></tr></thead>
        <tbody>{data.users.map((u) => <tr key={u.id}><td><b>{u.name || u.email}</b><div className="small-muted" style={{ fontSize: 11.5 }}>{u.email}</div></td><td>{u.type === 'partner' ? `Partner · ${u.resellerName || ''}` : u.accountName}</td><td>{u.status}</td><td className="small-muted">{u.lastLoginAt ? dateTimeOf(u.lastLoginAt) : '—'}</td><td>{u.status !== 'Removed' && <button type="button" className="btn btn-sm" onClick={() => remove(u)}>Remove</button>}</td></tr>)}</tbody>
      </table></div>}
    </>
  );
}

function Kb() {
  const { me, toast } = useCrm();
  const { data, reload } = useLoad('/crm/b/kb');
  const [edit, setEdit] = useState(null);
  async function save() { try { const r = await api[edit.id ? 'put' : 'post'](edit.id ? `/crm/b/kb/${edit.id}` : '/crm/b/kb', edit); toast(r.data.note || 'Saved.'); setEdit(null); reload(); } catch (e) { toast(errOf(e, 'Not saved.')); } }
  async function del(a) { if (!window.confirm(`Delete "${a.title}"?`)) return; try { await api.delete(`/crm/b/kb/${a.id}`); reload(); } catch (e) { toast(errOf(e, 'Not deleted.')); } }
  return (
    <>
      {data && <p className="small-muted" style={{ marginTop: 0 }}>Help articles for customers: in the portal and on the public help page <a href={data.publicUrl} target="_blank" rel="noopener noreferrer">{data.publicUrl}</a>. A Sales manager publishes.</p>}
      {me.canEdit && !edit && <button type="button" className="btn btn-primary btn-sm" style={{ marginBottom: 10 }} onClick={() => setEdit({ title: '', category: '', body: '', published: false })}>+ Article</button>}
      {edit && <div className="card" style={{ padding: 12, marginBottom: 12 }}>
        <div className="grid-2"><div className="field"><label>Title</label><input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></div><div className="field"><label>Category</label><input value={edit.category || ''} onChange={(e) => setEdit({ ...edit, category: e.target.value })} placeholder="Invoices, Hiring process ..." /></div></div>
        <div className="field"><label>Article</label><textarea rows={8} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></div>
        {me.canAssign && <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 500 }}><input type="checkbox" checked={!!edit.published} onChange={(e) => setEdit({ ...edit, published: e.target.checked })} style={{ width: 'auto' }} /> Published (customers can read it)</label>}
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}><button type="button" className="btn btn-primary btn-sm" onClick={save}>Save</button><button type="button" className="btn btn-sm" onClick={() => setEdit(null)}>Cancel</button></div>
      </div>}
      {data && !data.articles.length && <Empty title="No articles yet" />}
      {(data ? data.articles : []).map((a) => (
        <div key={a.id} className="card" style={{ padding: 10, marginBottom: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ flex: 1, minWidth: 200 }}><b>{a.title}</b> <span className="small-muted">· {a.category || 'General'}</span><div className="small-muted" style={{ fontSize: 12 }}>{a.views} views · 👍 {a.helpfulYes} · 👎 {a.helpfulNo}</div></div>
          <span className={`status ${a.published ? 'joined' : 'review'}`}>{a.published ? 'Published' : 'Draft'}</span>
          {me.canEdit && <button type="button" className="btn btn-sm" onClick={() => setEdit({ ...a, published: !!a.published })}>Edit</button>}
          {me.canAssign && <button type="button" className="btn btn-sm" onClick={() => del(a)}>Delete</button>}
        </div>
      ))}
    </>
  );
}

function Partners() {
  const { me, toast, openRecord } = useCrm();
  const { data, reload } = useLoad('/crm/b/resellers');
  const [edit, setEdit] = useState(null);
  const [inviting, setInviting] = useState(null);
  async function save() { try { await api[edit.id ? 'put' : 'post'](edit.id ? `/crm/b/resellers/${edit.id}` : '/crm/b/resellers', edit); toast('Partner saved.'); setEdit(null); reload(); } catch (e) { toast(errOf(e, 'Not saved.')); } }
  async function decide(d, decision) {
    const reason = decision === 'reject' ? window.prompt('Why? (the partner sees this)') : null;
    if (decision === 'reject' && !reason) return;
    try { const r = await api.post(`/crm/b/reseller-deals/${d.id}`, { decision, reason }); toast(decision === 'accept' ? 'Accepted: it is a lead now.' : 'Rejected.'); reload(); if (r.data.leadId) openRecord('lead', r.data.leadId); } catch (e) { toast(errOf(e, 'Not saved.')); }
  }
  if (!data) return <div className="small-muted">Loading…</div>;
  return (
    <>
      <p className="small-muted" style={{ marginTop: 0 }}>Resellers and referral partners sign in to the portal and register the companies they bring. A company already in the CRM is marked Duplicate. Accept one and it becomes a lead (source Referral) for the partner's manager.</p>
      {data.canEdit && !edit && <button type="button" className="btn btn-primary btn-sm" style={{ marginBottom: 10 }} onClick={() => setEdit({ name: '', contactName: '', email: '', phone: '', city: '', commissionPercent: '' })}>+ Partner</button>}
      {edit && <div className="card" style={{ padding: 12, marginBottom: 12 }}><div className="grid-3">
        {[['name', 'Company'], ['contactName', 'Contact person'], ['email', 'Email'], ['phone', 'Phone'], ['city', 'City'], ['commissionPercent', 'Commission %']].map(([k, l]) => <div key={k} className="field"><label>{l}</label><input value={edit[k] == null ? '' : edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /></div>)}
        <div className="field"><label>Partner manager</label><select value={edit.ownerId || ''} onChange={(e) => setEdit({ ...edit, ownerId: e.target.value })}><option value="">Me</option>{me.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
      </div><div style={{ display: 'flex', gap: 6 }}><button type="button" className="btn btn-primary btn-sm" onClick={save}>Save</button><button type="button" className="btn btn-sm" onClick={() => setEdit(null)}>Cancel</button></div></div>}
      {data.resellers.map((r) => (
        <div key={r.id} className="card" style={{ padding: 10, marginBottom: 8 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ flex: 1, minWidth: 200 }}><b>{r.name}</b> <span className="small-muted">· {r.contactName} · {r.email} · {r.status}{r.commissionPercent != null ? ` · ${r.commissionPercent}%` : ''} · manager {r.ownerName}</span><div className="small-muted" style={{ fontSize: 12 }}>{r.deals} deals · {r.waiting} waiting</div></div>
            {data.canEdit && <button type="button" className="btn btn-sm" onClick={() => setEdit(r)}>Edit</button>}
            {data.canEdit && <button type="button" className="btn btn-sm" onClick={() => setInviting(inviting === r.id ? null : r.id)}>Portal login</button>}
          </div>
          {inviting === r.id && <InviteForm resellerId={r.id} onDone={reload} />}
        </div>
      ))}
      <div className="section-label">Deals partners registered</div>
      {!data.deals.length && <div className="small-muted">None yet.</div>}
      {data.deals.length > 0 && <div className="tbl-wrap"><table>
        <thead><tr><th>Company</th><th>Partner</th><th>Value</th><th>Status</th><th>When</th><th /></tr></thead>
        <tbody>{data.deals.map((d) => <tr key={d.id}><td><b>{d.company}</b><div className="small-muted" style={{ fontSize: 11.5 }}>{[d.contactName, d.phone, d.email].filter(Boolean).join(' · ')}</div></td><td>{d.resellerName}</td><td>{d.value ? money(d.value) : '—'}</td><td>{d.status}{d.reason ? <div className="small-muted" style={{ fontSize: 11.5 }}>{d.reason}</div> : null}</td><td className="small-muted">{dateOf(d.createdAt)}</td>
          <td style={{ whiteSpace: 'nowrap' }}>{data.canEdit && ['Submitted', 'Duplicate'].includes(d.status) && <><button type="button" className="btn btn-sm btn-primary" onClick={() => decide(d, 'accept')}>Accept</button> <button type="button" className="btn btn-sm" onClick={() => decide(d, 'reject')}>Reject</button></>}{d.leadId && <button type="button" className="btn btn-sm" onClick={() => openRecord('lead', d.leadId)}>Lead</button>}</td></tr>)}</tbody>
      </table></div>}
    </>
  );
}

function Surveys() {
  const { data } = useLoad('/crm/b/surveys');
  if (!data) return <div className="small-muted">Loading…</div>;
  return (
    <>
      <OffNote on={data.auto} what="Sending surveys by themselves after a won deal / a closed ticket" />
      <p className="small-muted" style={{ marginTop: 0 }}>Send an NPS or CSAT survey from a customer's record (Web &amp; engagement). A low score tells the owner and makes a call-back follow-up.</p>
      <div className="grid-2" style={{ marginBottom: 12 }}>
        <div className="card" style={{ padding: 12 }}><div className="small-muted">NPS (last 90 days)</div><div style={{ fontSize: 28, fontWeight: 700 }}>{data.nps.score == null ? '—' : data.nps.score}</div><div className="small-muted" style={{ fontSize: 12 }}>{data.nps.answers} answers of {data.nps.sent} · {data.nps.promoters} promoters · {data.nps.passives} passives · {data.nps.detractors} detractors</div></div>
        <div className="card" style={{ padding: 12 }}><div className="small-muted">CSAT (last 90 days)</div><div style={{ fontSize: 28, fontWeight: 700 }}>{data.csat.average == null ? '—' : `${data.csat.average} / 5`}</div><div className="small-muted" style={{ fontSize: 12 }}>{data.csat.answers} answers of {data.csat.sent} · {data.csat.happy}% happy</div></div>
      </div>
      {data.rows.length > 0 && <div className="tbl-wrap"><table>
        <thead><tr><th>Sent</th><th>To</th><th>About</th><th>Type</th><th>Score</th><th>Comment</th></tr></thead>
        <tbody>{data.rows.map((r) => <tr key={r.id}><td className="small-muted">{dateOf(r.createdAt)}</td><td>{r.name || r.email || '—'}</td><td>{r.about}</td><td>{String(r.type).toUpperCase()}</td><td>{r.score == null ? (r.sentAt ? 'waiting' : 'not sent') : <b style={{ color: (r.type === 'nps' ? r.score <= 6 : r.score <= 2) ? 'var(--red)' : 'inherit' }}>{r.score}</b>}</td><td className="small-muted">{r.comment}</td></tr>)}</tbody>
      </table></div>}
    </>
  );
}

export default function CrmPortalAdmin() {
  const [tab, setTab] = useState('logins');
  return (
    <div>
      <SubTabs value={tab} onChange={setTab} tabs={[['logins', 'Portal logins'], ['kb', 'Help articles'], ['partners', 'Partners'], ['surveys', 'Surveys (NPS / CSAT)']]} />
      {tab === 'logins' && <Logins />}
      {tab === 'kb' && <Kb />}
      {tab === 'partners' && <Partners />}
      {tab === 'surveys' && <Surveys />}
    </div>
  );
}
