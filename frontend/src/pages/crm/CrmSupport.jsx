// CRM > CUSTOMER SUPPORT (2026-11-02, from the founder's reference CRM). Shown as the "Support tickets" tab of Accounts &
// Contacts, and inside an account's record. A ticket: number, subject, account / contact, category, priority (reply due:
// Urgent 4 h, High 1 day, Medium 2 days, Low 5 days), status, who handles it, and the thread - internal notes or a reply
// emailed to the customer. The rules are on the server (backend/src/crm/support.js).
import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { useCrm, errOf, dateTimeOf } from './crmShared.jsx';
import { SlaHoursButton } from './CrmMoneyMore.jsx'; // eslint-disable-line import/no-cycle -- the SLA hours a Sales manager sets (2026-11-26)

const PRIO_CLASS = { Urgent: 'rejected', High: 'overdue', Medium: 'pending', Low: 'new' };
const STATUS_CLASS = { Open: 'new', 'In progress': 'pending', 'Waiting on customer': 'review', Resolved: 'joined', Closed: 'joined' };
export const Prio = ({ v }) => <span className={`status ${PRIO_CLASS[v] || 'review'}`}>{v}</span>;
const TStatus = ({ v }) => <span className={`status ${STATUS_CLASS[v] || 'review'}`}>{v}</span>;
const dueText = (t) => {
  if (!t.dueAt || ['Resolved', 'Closed'].includes(t.status)) return '';
  const h = Math.round((Date.parse(t.dueAt) - Date.now()) / 3600000);
  if (h < 0) return `late by ${Math.abs(h) >= 48 ? `${Math.round(Math.abs(h) / 24)} days` : `${Math.abs(h)} h`}`;
  return `reply due in ${h >= 48 ? `${Math.round(h / 24)} days` : `${h} h`}`;
};

export function NewTicket({ preset, onClose, onDone }) {
  const { me, toast } = useCrm();
  const L = me.lists;
  const [f, setF] = useState({ subject: '', description: '', priority: 'Medium', category: '', channel: 'Phone', accountId: '', contactId: '', ownerId: '', ...(preset || {}) });
  const [accounts, setAccounts] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api.get('/crm/accounts').then((r) => setAccounts(r.data.rows)).catch(() => setAccounts([])); }, []);
  useEffect(() => { if (!f.accountId) { setContacts([]); return; } api.get('/crm/contacts', { params: { accountId: f.accountId } }).then((r) => setContacts(r.data.rows)).catch(() => setContacts([])); }, [f.accountId]);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  async function save() {
    setBusy(true); setErr('');
    try { const r = await api.post('/crm/tickets', f); toast(`Ticket ${r.data.ticket.number} opened.`); onDone(r.data.ticket); } catch (e) { setErr(errOf(e, 'The ticket could not be opened.')); } finally { setBusy(false); }
  }
  return (
    <Modal title="New support ticket" size="wide" onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Opening…' : 'Open ticket'}</button></>}>
      <div className="field"><label>What is the issue? *</label><input type="text" value={f.subject} onChange={(e) => set('subject', e.target.value)} placeholder="For example: candidate left in 10 days, needs a replacement" /></div>
      <div className="field"><label>Details</label><textarea rows={4} value={f.description} onChange={(e) => set('description', e.target.value)} /></div>
      <div className="grid-3">
        <div className="field"><label>Account</label><select value={f.accountId} onChange={(e) => { set('accountId', e.target.value); set('contactId', ''); }} disabled={accounts == null}><option value="">{accounts == null ? 'Loading…' : '— pick the customer —'}</option>{(accounts || []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
        <div className="field"><label>Contact</label><select value={f.contactId} onChange={(e) => set('contactId', e.target.value)} disabled={!f.accountId}><option value="">—</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name}{c.email ? ` · ${c.email}` : ''}</option>)}</select></div>
        <div className="field"><label>Category</label><select value={f.category} onChange={(e) => set('category', e.target.value)}><option value="">—</option>{L.ticketCategories.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
        <div className="field"><label>Priority</label><select value={f.priority} onChange={(e) => set('priority', e.target.value)}>{L.ticketPriorities.map((p) => <option key={p} value={p}>{p} (reply within {L.slaHours[p] >= 24 ? `${L.slaHours[p] / 24} day${L.slaHours[p] > 24 ? 's' : ''}` : `${L.slaHours[p]} h`})</option>)}</select></div>
        <div className="field"><label>Came in by</label><select value={f.channel} onChange={(e) => set('channel', e.target.value)}>{L.ticketChannels.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
        {me.canAssign && <div className="field"><label>Handled by</label><select value={f.ownerId} onChange={(e) => set('ownerId', e.target.value)}><option value="">Me</option>{me.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>}
      </div>
      {err && <div className="small-muted" role="alert" style={{ color: 'var(--red)' }}>{err}</div>}
    </Modal>
  );
}

export function TicketView({ id, onClose, onChanged }) {
  const { me, toast } = useCrm();
  const [d, setD] = useState(null);
  const [text, setText] = useState('');
  const [toCustomer, setToCustomer] = useState(false);
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api.get(`/crm/tickets/${id}`).then((r) => { setD(r.data); setTo((r.data.contact && r.data.contact.email) || ''); }).catch((e) => toast(errOf(e, 'The ticket could not be opened.')));
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function change(patch) {
    try { await api.put(`/crm/tickets/${id}`, patch); load(); if (onChanged) onChanged(); } catch (e) { toast(errOf(e, 'This could not be saved.')); }
  }
  async function send() {
    setBusy(true);
    try { await api.post(`/crm/tickets/${id}/comments`, { body: text, toCustomer, to }); toast(toCustomer ? 'Reply emailed to the customer.' : 'Note saved.'); setText(''); load(); if (onChanged) onChanged(); } catch (e) { toast(errOf(e, 'This could not be saved.')); } finally { setBusy(false); }
  }
  const t = d && d.ticket;
  return (
    <Modal title={t ? `${t.number} · ${t.subject}` : 'Ticket'} size="xwide" onClose={onClose}>
      {!d && <div className="small-muted">Loading…</div>}
      {d && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            <Prio v={t.priority} /> <TStatus v={t.status} />
            {t.late && <span className="status rejected">Reply late</span>}
            <span className="small-muted">{dueText(t)}</span>
            <span className="small-muted">· {d.account ? d.account.name : 'No account'}{d.contact ? ` · ${d.contact.name}` : ''}{t.category ? ` · ${t.category}` : ''}{t.channel ? ` · by ${t.channel}` : ''}</span>
          </div>
          {d.canEdit && (
            <div className="grid-3" style={{ marginBottom: 10 }}>
              <div className="field"><label>Status</label><select value={t.status} onChange={(e) => change({ status: e.target.value })}>{me.lists.ticketStatuses.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
              <div className="field"><label>Priority</label><select value={t.priority} onChange={(e) => change({ priority: e.target.value })}>{me.lists.ticketPriorities.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
              <div className="field"><label>Handled by</label>{me.canAssign ? <select value={t.ownerId || ''} onChange={(e) => change({ ownerId: e.target.value })}>{!me.owners.some((o) => o.id === t.ownerId) && <option value={t.ownerId || ''}>{t.ownerName || '—'}</option>}{me.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select> : <div style={{ padding: '8px 0' }}>{t.ownerName}</div>}</div>
            </div>
          )}
          {t.description && <div className="card" style={{ padding: 12, whiteSpace: 'pre-wrap', fontSize: 13.5, marginBottom: 12 }}>{t.description}</div>}
          <div className="section-label">Conversation</div>
          {!d.comments.length && <div className="small-muted" style={{ marginBottom: 8 }}>No notes or replies yet.</div>}
          <div className="timeline" style={{ marginBottom: 12 }}>
            {d.comments.map((c) => (
              <div key={c.id} className="timeline-item">
                <div className="timeline-date">{dateTimeOf(c.createdAt)} · {c.byName || ''} {c.internal ? '· internal note' : `· emailed to ${c.emailedTo}`}</div>
                <div style={{ fontSize: 13.5, whiteSpace: 'pre-wrap', color: c.internal ? 'var(--ink-soft)' : 'var(--ink)' }}>{c.body}</div>
              </div>
            ))}
          </div>
          {d.canEdit && (
            <div className="card" style={{ padding: 12 }}>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <button type="button" className={`btn btn-sm${!toCustomer ? ' btn-primary' : ''}`} onClick={() => setToCustomer(false)}>Internal note</button>
                <button type="button" className={`btn btn-sm${toCustomer ? ' btn-primary' : ''}`} onClick={() => setToCustomer(true)}>Reply to customer (email)</button>
              </div>
              {toCustomer && <input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="Customer's email" style={{ marginBottom: 6 }} aria-label="Customer's email" />}
              <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={toCustomer ? 'Your reply (sent by email, with the ticket number)' : 'A note for the team'} aria-label="Message" />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}><button type="button" className="btn btn-primary btn-sm" disabled={busy || !text.trim()} onClick={send}>{busy ? 'Saving…' : toCustomer ? 'Send reply' : 'Save note'}</button></div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

// The ticket list (whole page, or one account's tickets when accountId is given)
export function TicketList({ accountId, compact }) {
  const { me } = useCrm();
  const [status, setStatus] = useState('open');
  const [priority, setPriority] = useState('');
  const [owner, setOwner] = useState('');
  const [late, setLate] = useState(false);
  const [q, setQ] = useState('');
  const [d, setD] = useState(null);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState(null);
  const load = () => api.get('/crm/tickets', { params: { status, priority: priority || undefined, owner: owner || undefined, late: late ? 1 : undefined, q: q || undefined, accountId: accountId || undefined } }).then((r) => setD(r.data)).catch(() => setD({ rows: [], stats: {} }));
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [status, priority, owner, late, q, accountId]); // eslint-disable-line react-hooks/exhaustive-deps
  const s = (d && d.stats) || {};
  return (
    <div>
      {!compact && d && (
        <div className="statbar">
          <div className="statitem"><div className="n">{s.open ?? 0}</div><div className="l">Open tickets</div></div>
          <div className="statitem"><div className="n" style={{ color: s.late ? 'var(--red)' : undefined }}>{s.late ?? 0}</div><div className="l">Reply late (SLA)</div></div>
          <div className="statitem"><div className="n">{s.urgent ?? 0}</div><div className="l">Urgent open</div></div>
          <div className="statitem"><div className="n">{s.resolved30 ?? 0}</div><div className="l">Resolved, 30 days</div></div>
          <div className="statitem"><div className="n">{s.avgResolveHours != null ? (s.avgResolveHours >= 48 ? `${Math.round(s.avgResolveHours / 24)} d` : `${s.avgResolveHours} h`) : '—'}</div><div className="l">Average time to resolve</div></div>
          <div className="statitem"><div className="n">{s.slaMet30 != null ? `${s.slaMet30}%` : '—'}</div><div className="l">Replied within SLA</div></div>
        </div>
      )}
      <div className="filter-row">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="open">Open tickets</option>{me.lists.ticketStatuses.map((x) => <option key={x} value={x}>{x}</option>)}</select>
        <select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority"><option value="">Any priority</option>{me.lists.ticketPriorities.map((x) => <option key={x} value={x}>{x}</option>)}</select>
        {me.seesAll && !accountId && <select value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Handled by"><option value="">Everyone</option>{me.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0, fontWeight: 500 }}><input type="checkbox" checked={late} onChange={(e) => setLate(e.target.checked)} style={{ width: 'auto' }} /> Late only</label>
        {!accountId && <input type="text" placeholder="Search number, subject, company" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 220 }} aria-label="Search tickets" />}
        {!accountId && !compact && <span style={{ marginLeft: 'auto' }}><SlaHoursButton /></span>}
        {me.canEdit && <button type="button" className="btn btn-primary btn-sm" style={{ marginLeft: accountId || compact ? 'auto' : 0 }} onClick={() => setAdding(true)}>+ Ticket</button>}
      </div>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Ticket</th>{!accountId && <th>Customer</th>}<th>Priority</th><th>Status</th><th>Reply</th><th>Handled by</th></tr></thead>
          <tbody>
            {!d && <tr><td colSpan={6} className="small-muted">Loading…</td></tr>}
            {d && !d.rows.length && <tr><td colSpan={6}><div className="empty"><h3>No tickets here</h3>A client's issue after the sale (replacement, invoice, requirement change, complaint) goes here as a ticket.</div></td></tr>}
            {d && d.rows.map((t) => (
              <tr key={t.id} className="row-link" onClick={() => setOpenId(t.id)}>
                <td><b>{t.number}</b> {t.subject}<div className="small-muted" style={{ fontSize: 11.5 }}>{[t.category, t.channel, `${t.comments} message${t.comments === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</div></td>
                {!accountId && <td>{t.accountName || '—'}<div className="small-muted" style={{ fontSize: 11.5 }}>{t.contactName || ''}</div></td>}
                <td><Prio v={t.priority} /></td>
                <td><TStatus v={t.status} /></td>
                <td style={{ color: t.late ? 'var(--red)' : undefined, fontWeight: t.late ? 600 : undefined, fontSize: 12.5 }}>{dueText(t) || '—'}</td>
                <td>{t.ownerName || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {adding && <NewTicket preset={accountId ? { accountId } : undefined} onClose={() => setAdding(false)} onDone={(t) => { setAdding(false); load(); setOpenId(t.id); }} />}
      {openId && <TicketView id={openId} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}

