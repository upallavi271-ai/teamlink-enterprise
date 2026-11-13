// ---------------------------------------------------------------------------
// THE SALES CRM - SHARED PIECES (founder 2026-11-02). The four screens (Dashboard, Leads, Deals, Accounts & Contacts) use:
//   CrmCtx / useCrm      who I am in the CRM (role, may edit / assign, owners, pick lists) + a small toast
//   RecordForm           add / edit a lead, account, contact or deal (duplicate warning with "Save anyway")
//   RecordPanel          one record: details, actions (convert, stage, add as client), timeline and follow-ups
//   money / ago / ...    small formatters
// Everything is read from and written to /api/crm (backend/src/crm/service.js holds the rules).
// ---------------------------------------------------------------------------
import { createContext, useContext, useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { DoneDialog, REMIND_WORDS } from './CrmFollowups.jsx';
import { useMoveLead } from './CrmLeadBoard.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { TicketList } from './CrmSupport.jsx'; // eslint-disable-line import/no-cycle

export const CrmCtx = createContext(null);
export const useCrm = () => useContext(CrmCtx);

export const errOf = (e, fb) => (e && e.response && e.response.data && e.response.data.error) || fb;
// ₹ in Indian grouping; short form in lakhs / crores for the board and the cards
export const money = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
export const moneyShort = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(v >= 1e8 ? 0 : 1)} Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(v >= 1e6 ? 0 : 1)} L`;
  return money(v);
};
export const dateOf = (iso) => { if (!iso) return ''; const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }); };
export const dateTimeOf = (iso) => { if (!iso) return ''; const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); };
export const istToday = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
export const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
// a deal still open with nothing logged for N days (CRM settings) is "going cold": the number of days, or 0
export function staleDays(deal, lastActivity, limit) {
  if (!deal || ['Won', 'Lost'].includes(deal.stage)) return 0;
  const last = (lastActivity && (lastActivity.at || lastActivity)) || deal.lastActivityAt || deal.createdAt;
  const days = Math.floor((Date.now() - Date.parse(last)) / 86400000);
  return days >= (limit || 14) ? days : 0;
}
export const ACT_ICON = { call: '📞', meeting: '🤝', email: '✉️', whatsapp: '💬', note: '📝' };
export const KIND_PATH = { lead: 'leads', deal: 'deals', account: 'accounts', contact: 'accounts' };
export const recordLink = (kind, id) => `/crm/${KIND_PATH[kind] || 'dashboard'}?open=${kind}:${id}`;
// EVERYTHING OPENS IN PLACE (founder 2026-11-02: "ey module lo vundi click chesthey, akkade display avvali, vere modules loki
// vellakudadhu"): a record named anywhere in the CRM opens as a panel on top of the page you are on (CrmPage keeps the stack),
// never by going to another page or module.
export function RecLink({ kind, id, children, className, style, title }) {
  const { openRecord } = useCrm();
  return (
    <button type="button" className={`crm-reclink${className ? ` ${className}` : ''}`} style={style} title={title} onClick={(e) => { e.stopPropagation(); openRecord(kind, id); }}>
      {children}
    </button>
  );
}

const STATUS_CLASS = { Draft: 'review', Sent: 'pending', Accepted: 'joined', Declined: 'rejected', Hot: 'overdue', Warm: 'pending', Cold: 'new', New: 'new', Contacted: 'pending', Qualified: 'active', Junk: 'rejected', Converted: 'joined', Won: 'joined', Lost: 'rejected', Prospect: 'new', Client: 'active' };
// a file from the API (CSV, PDF) with the login's token: opened (PDF) or saved (CSV)
export async function download(url, name, { open } = {}) {
  const r = await api.get(url, { responseType: 'blob' });
  const href = URL.createObjectURL(r.data);
  if (open) { window.open(href, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(href), 60000); return; }
  const a = document.createElement('a'); a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10000);
}
// Call / WhatsApp / Email straight from a record (the phone's dialer, WhatsApp, the mail app)
export function QuickContact({ phone, email }) {
  const digits = String(phone || '').replace(/\D/g, '');
  const wa = digits.length === 10 ? `91${digits}` : digits;
  if (!digits && !email) return null;
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      {digits && <a className="btn btn-sm" href={`tel:${phone}`} title={`Call ${phone}`}>📞 Call</a>}
      {digits.length >= 10 && <a className="btn btn-sm" href={`https://wa.me/${wa}`} target="_blank" rel="noopener noreferrer" title="Open WhatsApp">💬 WhatsApp</a>}
      {email && <a className="btn btn-sm" href={`mailto:${email}`} title={`Email ${email}`}>✉️ Email</a>}
    </span>
  );
}
export const Pill = ({ v }) => (v ? <span className={`status ${STATUS_CLASS[v] || 'review'}`}>{v}</span> : null);

// ---- the forms -------------------------------------------------------------------------------------------
function fieldsFor(kind, me) {
  const L = me.lists;
  if (kind === 'lead') {
    return [
      { k: 'company', label: 'Company *' }, { k: 'contactName', label: 'Contact person' }, { k: 'designation', label: 'Designation' },
      { k: 'phone', label: 'Phone', type: 'tel' }, { k: 'email', label: 'Email', type: 'email' }, { k: 'industry', label: 'Industry' },
      { k: 'city', label: 'City' }, { k: 'source', label: 'Source', type: 'select', options: L.sources }, { k: 'expectedValue', label: 'Expected value (₹)', type: 'number' },
      { k: 'rating', label: 'Rating', type: 'select', options: L.ratings },
      { k: 'status', label: 'Status', type: 'select', options: L.leadStatuses.filter((s) => s !== 'Converted'), editOnly: true },
      { k: 'notes', label: 'Notes', type: 'textarea', wide: true },
    ];
  }
  if (kind === 'account') {
    return [
      { k: 'name', label: 'Company name *' }, { k: 'industry', label: 'Industry' }, { k: 'city', label: 'City' }, { k: 'website', label: 'Website' },
      { k: 'phone', label: 'Phone', type: 'tel' }, { k: 'email', label: 'Email', type: 'email' }, { k: 'source', label: 'Source', type: 'select', options: L.sources },
      { k: 'gstin', label: 'GSTIN' }, { k: 'state', label: 'State' }, { k: 'pincode', label: 'Pincode' },
      { k: 'address', label: 'Address', type: 'textarea', wide: true },
      { k: 'tags', label: 'Tags', hint: 'Comma-separated, e.g. VIP, Repeat' },
      { k: 'notes', label: 'Notes', type: 'textarea', wide: true },
    ];
  }
  if (kind === 'contact') {
    return [
      { k: 'name', label: 'Name *' }, { k: 'designation', label: 'Designation' }, { k: 'role', label: 'Role in the deal', type: 'select', options: L.contactRoles },
      { k: 'phone', label: 'Phone', type: 'tel' }, { k: 'email', label: 'Email', type: 'email' }, { k: 'accountId', label: 'Account', type: 'account' },
      { k: 'notes', label: 'Notes', type: 'textarea', wide: true },
    ];
  }
  return [
    { k: 'title', label: 'Deal name *' }, { k: 'accountId', label: 'Account *', type: 'account' }, { k: 'contactId', label: 'Contact', type: 'contact' },
    { k: 'value', label: 'Deal value (₹)', type: 'number' },
    { k: 'discountPercent', label: 'Discount %', type: 'number', hint: 'Over the CRM limit, a manager has to approve it before the deal can be won' },
    { k: 'expectedClose', label: 'Expected close', type: 'date' },
    { k: 'nextStep', label: 'Next step', hint: 'For example: send the proposal, meet the HR head' },
  ];
}

export function RecordForm({ kind, row, preset, onClose, onSaved }) {
  const { me, toast } = useCrm();
  const editing = !!(row && row.id);
  const [f, setF] = useState(() => ({ ...(preset || {}), ...(row || {}) }));
  const [accounts, setAccounts] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [dups, setDups] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const fields = fieldsFor(kind, me).filter((x) => editing || !x.editOnly);
  const needsAccounts = fields.some((x) => x.type === 'account');
  useEffect(() => { if (needsAccounts) api.get('/crm/accounts').then((r) => setAccounts(r.data.rows)).catch(() => setAccounts([])); }, [needsAccounts]);
  useEffect(() => {
    if (kind !== 'deal' || !f.accountId) { setContacts([]); return; }
    api.get('/crm/contacts', { params: { accountId: f.accountId } }).then((r) => setContacts(r.data.rows)).catch(() => setContacts([]));
  }, [kind, f.accountId]);
  const set = (k, v) => { setF((x) => ({ ...x, [k]: v })); setErr(''); setDups(null); };

  async function save(force) {
    setBusy(true); setErr('');
    const body = {}; fields.forEach((x) => { body[x.k] = f[x.k] ?? ''; });
    if (me.canAssign) body.ownerId = f.ownerId || undefined;
    if (force) body.force = true;
    try {
      const r = editing ? await api.put(`/crm/${kind}s/${row.id}`, body) : await api.post(`/crm/${kind}s`, body);
      toast(editing ? 'Saved.' : `${kind === 'lead' ? 'Lead' : kind === 'deal' ? 'Deal' : kind === 'account' ? 'Account' : 'Contact'} added.`);
      onSaved(r.data[kind]);
    } catch (e) {
      if (e.response && e.response.status === 409) setDups(e.response.data.duplicates || []);
      setErr(errOf(e, 'This could not be saved.'));
    } finally { setBusy(false); }
  }

  const input = (x) => {
    const v = f[x.k] ?? '';
    if (x.type === 'select') return <select value={v} onChange={(e) => set(x.k, e.target.value)}><option value="">—</option>{x.options.map((o) => <option key={o} value={o}>{o}</option>)}</select>;
    if (x.type === 'textarea') return <textarea rows={3} value={v} onChange={(e) => set(x.k, e.target.value)} />;
    if (x.type === 'account') {
      return (
        <select value={v} onChange={(e) => { set(x.k, e.target.value); if (kind === 'deal') set('contactId', ''); }} disabled={accounts == null}>
          <option value="">{accounts == null ? 'Loading…' : kind === 'contact' ? '— no account —' : '— pick the account —'}</option>
          {(accounts || []).map((a) => <option key={a.id} value={a.id}>{a.name}{a.city ? ` · ${a.city}` : ''}</option>)}
        </select>
      );
    }
    if (x.type === 'contact') return <select value={v} onChange={(e) => set(x.k, e.target.value)} disabled={!f.accountId}><option value="">—</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name}{c.designation ? ` · ${c.designation}` : ''}</option>)}</select>;
    return <input type={x.type || 'text'} value={v} min={x.type === 'number' ? 0 : undefined} onChange={(e) => set(x.k, e.target.value)} />;
  };
  const title = `${editing ? 'Edit' : 'New'} ${kind}`;
  return (
    <Modal
      title={title.charAt(0).toUpperCase() + title.slice(1)}
      size="wide"
      onClose={onClose}
      foot={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          {dups && dups.length > 0 && <button type="button" className="btn" disabled={busy} onClick={() => save(true)}>Save anyway</button>}
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => save(false)}>{busy ? 'Saving…' : 'Save'}</button>
        </>
      )}
    >
      <div className="grid-2">
        {fields.map((x) => (
          <div key={x.k} className="field" style={x.wide ? { gridColumn: '1 / -1' } : undefined}>
            <label>{x.label}</label>
            {input(x)}
            {x.hint && <div className="small-muted" style={{ marginTop: 3 }}>{x.hint}</div>}
          </div>
        ))}
        {me.canAssign && (
          <div className="field">
            <label>Owner (salesperson)</label>
            <select value={f.ownerId || ''} onChange={(e) => set('ownerId', e.target.value)}>
              <option value="">{editing ? (row.ownerName || '—') : 'Me'}</option>
              {me.owners.map((o) => <option key={o.id} value={o.id}>{o.name}{o.tl ? ' · Sales manager' : ''}</option>)}
            </select>
          </div>
        )}
      </div>
      {err && <div className="notice" role="alert" style={{ marginTop: 6, color: dups ? undefined : 'var(--red)' }}>{err}</div>}
      {dups && dups.length > 0 && (
        <div className="card" style={{ marginTop: 8, padding: 12 }}>
          <div className="small-muted" style={{ marginBottom: 6 }}>Already in TeamLink — please check before adding again:</div>
          {dups.map((d) => <div key={`${d.where}${d.id}`} style={{ fontSize: 13, padding: '2px 0' }}><b>{d.name}</b> · {d.where}{d.status ? ` (${d.status})` : ''}{d.owner ? ` · owner ${d.owner}` : ''}</div>)}
        </div>
      )}
    </Modal>
  );
}

// ---- log a call / meeting / ... and the next follow-up ---------------------------------------------------
function LogActivity({ link, onDone }) {
  const { me, toast } = useCrm();
  const [kind, setKind] = useState('call');
  const [subject, setSubject] = useState('');
  const [note, setNote] = useState('');
  const [next, setNext] = useState('');
  const [nextTitle, setNextTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function save() {
    setBusy(true); setErr('');
    try {
      await api.post('/crm/activities', { kind, subject, note, ...link, followUp: next ? { dueDate: next, title: nextTitle || undefined } : undefined });
      setSubject(''); setNote(''); setNext(''); setNextTitle('');
      toast(next ? 'Logged, with the next follow-up.' : 'Logged.');
      onDone();
    } catch (e) { setErr(errOf(e, 'This could not be saved.')); } finally { setBusy(false); }
  }
  const today = istToday();
  return (
    <div className="card" style={{ padding: 12, marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {Object.entries(me.lists.activityKinds).map(([k, label]) => (
          <button key={k} type="button" className={`btn btn-sm${kind === k ? ' btn-primary' : ''}`} onClick={() => setKind(k)}>{ACT_ICON[k]} {label}</button>
        ))}
      </div>
      <input type="text" placeholder={kind === 'note' ? 'Note title' : `What was the ${me.lists.activityKinds[kind].toLowerCase()} about?`} value={subject} onChange={(e) => setSubject(e.target.value)} style={{ marginBottom: 6 }} />
      <textarea rows={2} placeholder="What happened / what they said" value={note} onChange={(e) => setNote(e.target.value)} />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
        <span className="small-muted">Next follow-up:</span>
        {[['Tomorrow', 1], ['In 3 days', 3], ['Next week', 7]].map(([l, n]) => (
          <button key={l} type="button" className={`btn btn-sm${next === addDays(today, n) ? ' btn-primary' : ''}`} onClick={() => setNext(addDays(today, n))}>{l}</button>
        ))}
        <input type="date" value={next} min={today} onChange={(e) => setNext(e.target.value)} style={{ width: 150 }} aria-label="Follow-up date" />
        {next && <button type="button" className="btn btn-sm" onClick={() => setNext('')} aria-label="No follow-up">×</button>}
        {next && <input type="text" placeholder="Follow-up: what to do" value={nextTitle} onChange={(e) => setNextTitle(e.target.value)} style={{ flex: 1, minWidth: 160 }} />}
        <button type="button" className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} disabled={busy || (!subject.trim() && !note.trim())} onClick={save}>{busy ? 'Saving…' : 'Log it'}</button>
      </div>
      {err && <div className="small-muted" role="alert" style={{ color: 'var(--red)', marginTop: 6 }}>{err}</div>}
    </div>
  );
}

export function Timeline({ activities }) {
  if (!activities.length) return <div className="small-muted" style={{ padding: '6px 0' }}>Nothing logged yet. Log the first call, meeting or note above.</div>;
  return (
    <div className="timeline">
      {activities.map((a) => (
        <div key={a.id} className="timeline-item">
          <div className="timeline-date">{dateTimeOf(a.at)}{a.byName ? ` · ${a.byName}` : ''}</div>
          <div className="timeline-label">{ACT_ICON[a.kind] || '•'} {a.subject || (a.kind === 'note' ? 'Note' : a.kind)}</div>
          {a.note && <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', whiteSpace: 'pre-wrap' }}>{a.note}</div>}
        </div>
      ))}
    </div>
  );
}

// Follow-ups of one record (add, done) or of the dashboard (with the record they belong to).
export function TaskList({ tasks, link, onChanged, showRecord, canEdit = true }) {
  const { toast } = useCrm();
  const { me } = useCrm();
  const [title, setTitle] = useState('');
  const [due, setDue] = useState(istToday());
  const [time, setTime] = useState('');
  const [type, setType] = useState('Call');
  const [before, setBefore] = useState(String(me.lists.defaultRemindBefore));
  const [inApp, setInApp] = useState(true);
  const [wa, setWa] = useState(false);
  const [sms, setSms] = useState(false);
  const [doing, setDoing] = useState(null);
  const [busy, setBusy] = useState(false);
  const today = istToday();
  async function add() {
    setBusy(true);
    try { await api.post('/crm/tasks', { title, dueDate: due, dueTime: time || undefined, type, remindBefore: Number(before), notifyApp: inApp, notifyWhatsapp: wa, notifySms: sms, ...link }); setTitle(''); setTime(''); toast('Follow-up added.'); onChanged(); } catch (e) { toast(errOf(e, 'The follow-up could not be added.')); } finally { setBusy(false); }
  }
  return (
    <div>
      {link && canEdit && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
            <select value={type} onChange={(e) => setType(e.target.value)} style={{ width: 110 }} aria-label="Type">{me.lists.taskTypes.map((x) => <option key={x}>{x}</option>)}</select>
            <input type="text" placeholder="New follow-up" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: '1 1 160px' }} />
            <input type="date" value={due} min={today} onChange={(e) => setDue(e.target.value)} style={{ width: 150 }} aria-label="Due date" />
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ width: 110 }} aria-label="Due time" />
            <button type="button" className="btn btn-sm" disabled={busy || !title.trim() || !due} onClick={add}>Add</button>
          </div>
          <div className="small-muted" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
            <span>Remind:</span>
            <select value={before} onChange={(e) => setBefore(e.target.value)} style={{ width: 150 }} aria-label="Remind before">{Object.entries(REMIND_WORDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            <label><input type="checkbox" checked={inApp} onChange={(e) => setInApp(e.target.checked)} style={{ width: 'auto' }} /> In app</label>
            <label><input type="checkbox" checked={wa} onChange={(e) => setWa(e.target.checked)} style={{ width: 'auto' }} /> WhatsApp</label>
            <label><input type="checkbox" checked={sms} onChange={(e) => setSms(e.target.checked)} style={{ width: 'auto' }} /> SMS</label>
          </div>
        </div>
      )}
      {!tasks.length && <div className="small-muted">No follow-ups.</div>}
      {tasks.map((t) => {
        const late = t.status === 'Open' && t.dueDate < today;
        return (
          <div key={t.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 0', borderBottom: '1px solid var(--line-soft)', opacity: t.status === 'Done' ? 0.55 : 1 }}>
            {t.status === 'Open' && canEdit
              ? <input type="checkbox" checked={false} aria-label={`Mark "${t.title}" done`} onChange={() => setDoing(t)} style={{ marginTop: 3, width: 'auto' }} />
              : <span aria-hidden="true" style={{ width: 13 }}>{t.status === 'Done' ? '✓' : ''}</span>}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, textDecoration: t.status === 'Done' ? 'line-through' : undefined }}>{t.title}</div>
              <div className="small-muted" style={{ fontSize: 11.5 }}>
                <span style={{ color: late ? 'var(--red)' : undefined, fontWeight: late ? 600 : undefined }}>{t.dueDate === today ? 'Today' : dateOf(t.dueDate)}{t.dueTime ? ` ${t.dueTime}` : ''}{late ? ' · late' : ''}</span>
                {showRecord && t.recordName && <> · <RecLink kind={t.recordKind} id={t.recordId}>{t.recordName}</RecLink></>}
                {t.ownerName && showRecord ? ` · ${t.ownerName}` : ''}
              </div>
            </div>
          </div>
        );
      })}
      {doing && <DoneDialog task={doing} onClose={() => setDoing(null)} onDone={() => { setDoing(null); onChanged(); }} />}
    </div>
  );
}

// ---- convert a lead -------------------------------------------------------------------------------------
function ConvertLead({ lead, onClose, onDone }) {
  const { toast } = useCrm();
  const [f, setF] = useState({ dealTitle: `${lead.company} - deal`, value: lead.expectedValue || '', expectedClose: '', createDeal: true });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  async function go() {
    setBusy(true); setErr('');
    try { const r = await api.post(`/crm/leads/${lead.id}/convert`, f); toast('Converted: account, contact and deal are ready.'); onDone(r.data); } catch (e) { setErr(errOf(e, 'The lead could not be converted.')); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Convert ${lead.company}`} onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={go}>{busy ? 'Converting…' : 'Convert'}</button></>}>
      <p className="small-muted" style={{ marginTop: 0 }}>This makes an <b>account</b> for {lead.company}{lead.contactName ? <>, a <b>contact</b> ({lead.contactName})</> : null} and a <b>deal</b> on the pipeline. The lead&apos;s calls and follow-ups move with it.</p>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 500, marginBottom: 10 }}><input type="checkbox" checked={f.createDeal} onChange={(e) => set('createDeal', e.target.checked)} style={{ width: 'auto' }} /> Also make a deal</label>
      {f.createDeal && (
        <div className="grid-2">
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Deal name</label><input type="text" value={f.dealTitle} onChange={(e) => set('dealTitle', e.target.value)} /></div>
          <div className="field"><label>Deal value (₹)</label><input type="number" min={0} value={f.value} onChange={(e) => set('value', e.target.value)} /></div>
          <div className="field"><label>Expected close</label><input type="date" value={f.expectedClose} onChange={(e) => set('expectedClose', e.target.value)} /></div>
        </div>
      )}
      {err && <div className="small-muted" role="alert" style={{ color: 'var(--red)' }}>{err}</div>}
    </Modal>
  );
}

// ---- move a deal (Lost asks the reason) -------------------------------------------------------------------
export function useMoveDeal(onMoved) {
  const { me, toast } = useCrm();
  const [asking, setAsking] = useState(null); // { deal }
  const [reason, setReason] = useState('');
  async function move(deal, stage, lostReason) {
    if (stage === 'Lost' && !lostReason) { setAsking({ deal }); setReason(''); return; }
    try {
      const r = await api.post(`/crm/deals/${deal.id}/stage`, { stage, lostReason });
      toast(stage === 'Won' ? '🎉 Won! Add it as a client when you are ready.' : `Moved to ${stage}.`);
      onMoved(r.data.deal);
    } catch (e) { toast(errOf(e, 'The deal could not be moved.')); }
  }
  const dialog = asking && (
    <Modal title={`Why was "${asking.deal.title}" lost?`} onClose={() => setAsking(null)} foot={<><button type="button" className="btn" onClick={() => setAsking(null)}>Cancel</button><button type="button" className="btn btn-danger" disabled={!reason} onClick={() => { const d = asking.deal; setAsking(null); move(d, 'Lost', reason); }}>Mark lost</button></>}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {me.lists.lostReasons.map((r) => <button key={r} type="button" className={`btn btn-sm${reason === r ? ' btn-primary' : ''}`} onClick={() => setReason(r)}>{r}</button>)}
      </div>
    </Modal>
  );
  return { move, dialog };
}

// ---- proposals of a deal (PDF, email to the client, accepted / declined) ------------------------------------------
function ProposalForm({ dealId, defaults, onClose, onDone }) {
  const { toast } = useCrm();
  const [f, setF] = useState(() => ({ ...defaults, roles: defaults.roles.map((r) => ({ ...r })) }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setRole = (i, k, v) => setF((x) => ({ ...x, roles: x.roles.map((r, j) => (j === i ? { ...r, [k]: v } : r)) }));
  async function save() {
    setBusy(true); setErr('');
    try { const r = await api.post(`/crm/deals/${dealId}/proposals`, f); toast(`Proposal ${r.data.proposal.number} is ready.`); onDone(r.data.proposal); } catch (e) { setErr(errOf(e, 'The proposal could not be made.')); } finally { setBusy(false); }
  }
  const numField = (k, label, extra) => <div className="field"><label>{label}</label><input type="number" min={0} value={f[k] ?? ''} onChange={(e) => set(k, e.target.value)} {...extra} /></div>;
  return (
    <Modal title="New proposal" size="wide" onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Making…' : 'Make the proposal (PDF)'}</button></>}>
      <div className="grid-3">
        <div className="field"><label>Company</label><input type="text" value={f.company || ''} onChange={(e) => set('company', e.target.value)} /></div>
        <div className="field"><label>To (person)</label><input type="text" value={f.toName || ''} onChange={(e) => set('toName', e.target.value)} /></div>
        <div className="field"><label>Their email</label><input type="email" value={f.toEmail || ''} onChange={(e) => set('toEmail', e.target.value)} /></div>
      </div>
      <div className="section-label" style={{ marginTop: 4 }}>Positions</div>
      {f.roles.map((r, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '3fr 1fr 2fr auto', gap: 6, marginBottom: 6 }}>
          <input type="text" placeholder="Job title" value={r.title} onChange={(e) => setRole(i, 'title', e.target.value)} aria-label="Job title" />
          <input type="number" min={0} placeholder="Openings" value={r.openings} onChange={(e) => setRole(i, 'openings', e.target.value)} aria-label="Openings" />
          <input type="number" min={0} placeholder="Annual CTC ₹" value={r.ctc} onChange={(e) => setRole(i, 'ctc', e.target.value)} aria-label="Annual CTC" />
          <button type="button" className="btn btn-sm" disabled={f.roles.length === 1} onClick={() => setF((x) => ({ ...x, roles: x.roles.filter((_, j) => j !== i) }))} aria-label="Remove position">×</button>
        </div>
      ))}
      <button type="button" className="btn btn-sm" onClick={() => setF((x) => ({ ...x, roles: [...x.roles, { title: '', openings: '', ctc: '' }] }))}>+ Position</button>
      <div className="section-label">Terms</div>
      <div className="grid-3">
        {numField('feePercent', 'Fee (% of annual CTC)', { step: '0.01' })}
        {numField('gstPercent', 'GST %')}
        {numField('paymentDays', 'Payment within (days of invoice)')}
        {numField('guaranteeDays', 'Replacement guarantee (days)')}
        {numField('validityDays', 'Proposal valid for (days)')}
      </div>
      <div className="field"><label>Notes (optional)</label><textarea rows={3} value={f.notes || ''} onChange={(e) => set('notes', e.target.value)} /></div>
      {err && <div className="small-muted" role="alert" style={{ color: 'var(--red)' }}>{err}</div>}
    </Modal>
  );
}

function ProposalBox({ dealId, onChanged }) {
  const { toast } = useCrm();
  const [d, setD] = useState(null);
  const [making, setMaking] = useState(false);
  const [sending, setSending] = useState(null); // the proposal being emailed
  const [to, setTo] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api.get(`/crm/deals/${dealId}/proposals`).then((r) => setD(r.data)).catch(() => setD({ proposals: [], canEdit: false }));
  useEffect(() => { load(); }, [dealId]); // eslint-disable-line react-hooks/exhaustive-deps
  const pdf = (p) => download(`/crm/proposals/${p.id}/pdf`, `${p.number}.pdf`, { open: true }).catch(() => toast('The PDF could not be opened.'));
  async function send() {
    setBusy(true);
    try { const r = await api.post(`/crm/proposals/${sending.id}/send`, { to, message: msg }); toast(`Sent to ${r.data.sentTo}.`); setSending(null); load(); if (onChanged) onChanged(); } catch (e) { toast(errOf(e, 'The proposal was not sent.')); } finally { setBusy(false); }
  }
  async function decide(p, status) {
    try { await api.post(`/crm/proposals/${p.id}/status`, { status }); toast(`Marked ${status.toLowerCase()}.`); load(); if (onChanged) onChanged(); } catch (e) { toast(errOf(e, 'This could not be saved.')); }
  }
  if (!d) return null;
  return (
    <div className="card" style={{ padding: 12, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <div className="section-label" style={{ margin: 0 }}>Proposals ({d.proposals.length})</div>
        {d.canEdit && d.defaults && <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setMaking(true)}>+ Proposal</button>}
      </div>
      {!d.proposals.length && <div className="small-muted">No proposal yet. Make one: positions and fee terms, as a PDF you can email to the client.</div>}
      {d.proposals.map((p) => (
        <div key={p.id} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0', borderBottom: '1px solid var(--line-soft)', fontSize: 13 }}>
          <b>{p.number}</b> <Pill v={p.status} />
          <span className="small-muted" style={{ fontSize: 11.5 }}>{p.sentAt ? `sent ${dateOf(p.sentAt)} to ${p.sentTo}` : `made ${dateOf(p.createdAt)}`}</span>
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-sm" onClick={() => pdf(p)}>PDF</button>
            {d.canEdit && <button type="button" className="btn btn-sm" onClick={() => { setSending(p); setTo(d.defaults ? d.defaults.toEmail : ''); setMsg(''); }}>Email</button>}
            {d.canEdit && p.status !== 'Accepted' && <button type="button" className="btn btn-sm" onClick={() => decide(p, 'Accepted')}>Accepted</button>}
            {d.canEdit && p.status !== 'Declined' && <button type="button" className="btn btn-sm" onClick={() => decide(p, 'Declined')}>Declined</button>}
          </span>
        </div>
      ))}
      {making && <ProposalForm dealId={dealId} defaults={d.defaults} onClose={() => setMaking(false)} onDone={(p) => { setMaking(false); load(); pdf(p); }} />}
      {sending && (
        <Modal title={`Email ${sending.number}`} onClose={() => setSending(null)} foot={<><button type="button" className="btn" onClick={() => setSending(null)}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy || !to} onClick={send}>{busy ? 'Sending…' : 'Send'}</button></>}>
          <div className="field"><label>To (email)</label><input type="email" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <div className="field"><label>Message (optional: a polite default is used when empty)</label><textarea rows={4} value={msg} onChange={(e) => setMsg(e.target.value)} /></div>
          <div className="small-muted">The PDF is attached. The deal moves to "Proposal sent" and the email is written on its timeline.</div>
        </Modal>
      )}
    </div>
  );
}

// ---- the AI assistant on a record: health score, next best actions (rules, always), summary / email draft (the model) ------
function AiInsight({ kind, id, refresh }) {
  const { toast } = useCrm();
  const [d, setD] = useState(null);
  const [out, setOut] = useState(null); // { title, text }
  const [busy, setBusy] = useState('');
  useEffect(() => { if (!['lead', 'deal', 'account'].includes(kind)) return; api.get(`/crm/ai/insight/${kind}/${id}`).then((r) => setD(r.data)).catch(() => setD(null)); }, [kind, id, refresh]);
  async function ask(what) {
    setBusy(what); setOut(null);
    try {
      const r = await api.post(`/crm/ai/${what}/${kind}/${id}`, {});
      setOut({ title: what === 'summary' ? 'AI summary' : 'Follow-up email draft', text: r.data.text });
    } catch (e) { toast(errOf(e, 'The AI is not available right now.')); } finally { setBusy(''); }
  }
  if (!d) return null;
  const tone = d.score >= 70 ? 'var(--teal)' : d.score >= 45 ? 'var(--amber)' : 'var(--red)';
  return (
    <div className="crm-ai">
      <div className="crm-ai-head">
        <span className="crm-ai-badge" aria-hidden="true">✨</span>
        <b>AI assistant</b>
        <span className="small-muted" style={{ fontSize: 11.5 }}>{d.ai && d.ai.available ? `model: ${d.ai.provider}` : 'insights from your CRM data'}</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
          <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => ask('summary')}>{busy === 'summary' ? 'Thinking…' : 'Summarize'}</button>
          {kind !== 'account' && <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => ask('draft')}>{busy === 'draft' ? 'Writing…' : 'Draft follow-up email'}</button>}
        </span>
      </div>
      <div className="crm-ai-body">
        <div className="crm-ai-score" title={d.reasons.map((r) => r.why).join('\n')}>
          <div className="ring" style={{ background: `conic-gradient(${tone} ${d.score * 3.6}deg, var(--line-soft) 0)` }}><span>{d.score}</span></div>
          <div><b style={{ color: tone }}>{d.label}</b><div className="small-muted" style={{ fontSize: 11.5 }}>{kind === 'deal' ? 'deal health' : kind === 'lead' ? 'lead score' : 'account health'}</div></div>
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="small-muted" style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 4 }}>NEXT BEST ACTIONS</div>
          {!d.actions.length && <div className="small-muted">Nothing pressing. Keep the follow-ups going.</div>}
          {d.actions.map((a) => <div key={a.text} style={{ fontSize: 13, padding: '2px 0' }}>{a.urgent ? '🔴' : '•'} {a.text}</div>)}
          <details style={{ marginTop: 4 }}><summary className="small-muted" style={{ fontSize: 11.5, cursor: 'pointer' }}>Why this score</summary>{d.reasons.map((r) => <div key={r.why} className="small-muted" style={{ fontSize: 12 }}>{r.pts > 0 ? `+${r.pts}` : r.pts || ''} {r.why}</div>)}</details>
        </div>
      </div>
      {out && (
        <div className="card" style={{ padding: 10, marginTop: 8, whiteSpace: 'pre-wrap', fontSize: 13 }}>
          <div style={{ display: 'flex', marginBottom: 4 }}><b>{out.title}</b><button type="button" className="crm-linkbtn" style={{ marginLeft: 'auto' }} onClick={() => { navigator.clipboard.writeText(out.text).then(() => toast('Copied.')).catch(() => {}); }}>Copy</button></div>
          {out.text}
        </div>
      )}
    </div>
  );
}

// "Ask AI" about my pipeline: a floating button on every CRM page
export function AskAi() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [chat, setChat] = useState([]);
  const [busy, setBusy] = useState(false);
  const SUGGEST = ['Which deals need my attention this week?', 'Which follow-ups are late?', 'How far am I from my target this month?', 'Which leads should I call today?'];
  async function send(text) {
    const question = (text || q).trim();
    if (!question) return;
    setChat((c) => [...c, { who: 'me', text: question }]); setQ(''); setBusy(true);
    try { const r = await api.post('/crm/ai/ask', { question }); setChat((c) => [...c, { who: 'ai', text: r.data.text }]); } catch (e) { setChat((c) => [...c, { who: 'ai', text: errOf(e, 'The AI is not available right now.'), err: true }]); } finally { setBusy(false); }
  }
  return (
    <>
      <button type="button" className="crm-ask-fab" onClick={() => setOpen((o) => !o)} aria-expanded={open}>✨ Ask AI</button>
      {open && (
        <div className="crm-ask-panel" role="dialog" aria-label="Ask AI about your sales">
          <div className="crm-ask-head"><b>✨ AI assistant</b><span className="small-muted" style={{ fontSize: 11.5 }}>answers from your CRM data</span><button type="button" className="close-x" style={{ marginLeft: 'auto' }} onClick={() => setOpen(false)} aria-label="Close">×</button></div>
          <div className="crm-ask-body">
            {!chat.length && (
              <div>
                <div className="small-muted" style={{ marginBottom: 6 }}>Ask about your leads, deals, follow-ups and target. For example:</div>
                {SUGGEST.map((s) => <button key={s} type="button" className="btn btn-sm" style={{ display: 'block', marginBottom: 6, textAlign: 'left', width: '100%' }} onClick={() => send(s)}>{s}</button>)}
              </div>
            )}
            {chat.map((m, i) => <div key={i} className={`crm-ask-msg ${m.who}${m.err ? ' err' : ''}`}>{m.text}</div>)} {/* eslint-disable-line react/no-array-index-key */}
            {busy && <div className="crm-ask-msg ai small-muted">Thinking…</div>}
          </div>
          <div className="crm-ask-foot">
            <input type="text" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} placeholder="Ask a question" aria-label="Question" />
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !q.trim()} onClick={() => send()}>Ask</button>
          </div>
        </div>
      )}
    </>
  );
}

// ---- one record ---------------------------------------------------------------------------------------------
export function RecordPanel({ kind, id, onClose, onChanged }) {
  const { me, toast, openRecord } = useCrm();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(null); // { kind, row, preset }
  const [converting, setConverting] = useState(false);
  const load = () => api.get(`/crm/${kind}s/${id}`).then((r) => setD(r.data)).catch((e) => setErr(errOf(e, 'This record could not be opened.')));
  useEffect(() => { setD(null); setErr(''); load(); }, [kind, id]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = () => { load(); if (onChanged) onChanged(); };
  const { move, dialog } = useMoveDeal(changed);
  const { move: moveLead, dialog: leadDialog } = useMoveLead(changed);
  const L = me.lists;
  const row = d && d[kind];
  const name = row ? (row.company || row.name || row.title) : '';
  const stale = kind === 'deal' && row ? staleDays(row, (d.activities || [])[0], me.lists.staleDays) : 0;
  const link = row ? { [`${kind}Id`]: row.id } : null;
  const [tab, setTab] = useState('overview');
  const [notes, setNotes] = useState(null); // the notes being edited, or null
  useEffect(() => { setTab('overview'); setNotes(null); }, [kind, id]);
  async function assign(ownerId) {
    try { await api.put(`/crm/${kind}s/${row.id}`, { ownerId }); toast('Assigned.'); changed(); } catch (e) { toast(errOf(e, 'This could not be assigned.')); }
  }
  async function saveNotes() {
    try { await api.put(`/crm/${kind}s/${row.id}`, { notes }); toast('Notes saved.'); setNotes(null); changed(); } catch (e) { toast(errOf(e, 'The notes could not be saved.')); }
  }
  // Approve / reject an over-limit discount on a deal (Sales manager / Admin) — founder 2026-11-13.
  async function decideDiscount(decision) {
    try { await api.post(`/crm/deals/${row.id}/approval`, { decision }); toast(decision === 'approve' ? 'Discount approved — the deal can be won now.' : 'Discount rejected.'); changed(); } catch (e) { toast(errOf(e, 'This could not be saved.')); }
  }


  let body = null;
  if (err) body = <div className="notice" role="alert">{err}</div>;
  else if (!d) body = <div className="small-muted">Loading…</div>;
  else {
    const today = istToday();
    const openTasks = (d.tasks || []).filter((t) => t.status === 'Open').sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
    const nextTask = openTasks[0];
    const lastAct = (d.activities || [])[0];
    const contactLine = kind === 'deal' ? d.contact : (kind === 'lead' ? { name: row.contactName, designation: row.designation, phone: row.phone, email: row.email } : (d.contacts || [])[0]);
    // left: how to reach them; right: what the record is
    const reach = [
      ['📞', contactLine && contactLine.phone ? contactLine.phone : (kind === 'account' ? row.phone : null)],
      ['✉️', contactLine && contactLine.email ? contactLine.email : (kind === 'account' ? row.email : null)],
      ['👤', contactLine && contactLine.name ? `${contactLine.name}${contactLine.designation ? ` · ${contactLine.designation}` : ''}` : null],
      ['📍', kind === 'deal' ? (d.account && d.account.city) : row.city],
    ].filter(([, v]) => v);
    const about = kind === 'lead'
      ? [['Lead source', row.source], ['Stage', row.stage], ['Expected value', row.expectedValue ? `₹${Number(row.expectedValue).toLocaleString('en-IN')}` : null], ['Lost reason', row.lostReason], ['Industry', row.industry], ['Rating', row.rating && <Pill v={row.rating} />], ['Came from', [row.utmSource, row.utmMedium, row.utmCampaign].filter(Boolean).join(' / ')], ['Page', row.pageUrl]]
      : kind === 'deal'
        ? [['Account', d.account ? <RecLink kind="account" id={d.account.id}>{d.account.name}</RecLink> : '—'], ['Deal value', <b>{money(row.value)}</b>],
          ...(row.discountPercent ? [['Discount', `${row.discountPercent}%`], ['Final value', <b>{money(row.finalValue)}</b>]] : []),
          ...(row.approvalStatus && row.approvalStatus !== 'None' ? [['Discount approval', <Pill v={row.approvalStatus} />]] : []),
          ['Probability', `${row.probability}%`],
          ['Expected close', dateOf(row.expectedClose)], ['Next step', row.nextStep], ...(row.stage === 'Lost' ? [['Lost because', row.lostReason]] : [])]
        : [['Industry', row.industry], ['Website', row.website], ['Source', row.source], ['GSTIN', row.gstin], ['State', row.state], ['Pincode', row.pincode], ['Address', row.address],
          ['Tags', row.tags ? row.tags.split(',').map((t) => t.trim()).filter(Boolean).map((t, i) => <Pill key={i} v={t} />) : null], ['Type', row.kind === 'Client' ? 'Customer' : 'Prospect']];
    const info = [
      ...about,
      ['Next follow-up', nextTask ? <span style={{ color: nextTask.dueDate < today ? 'var(--red)' : undefined, fontWeight: nextTask.dueDate <= today ? 600 : undefined }}>{nextTask.dueDate === today ? 'Today' : dateOf(nextTask.dueDate)} · {nextTask.title}</span> : 'None set'],
      ['Last touched', lastAct ? `${dateTimeOf(lastAct.at)}${lastAct.byName ? ` · ${lastAct.byName}` : ''}` : 'Never'],
    ].filter(([, v]) => v);
    const tabs = [['overview', 'Overview'], ['activities', `Activities (${(d.activities || []).length})`], ['followups', `Follow-ups (${openTasks.length})`], ...(kind === 'deal' ? [['proposals', 'Proposals']] : []), ...(kind === 'account' ? [['support', 'Support tickets']] : []), ['notes', 'Notes']];
    const kindPill = kind === 'lead' ? row.status : kind === 'deal' ? row.stage : row.kind;
    body = (
      <>
        <div className="crm-rec-head">
          <div className="crm-rec-avatar" aria-hidden="true">{kind === 'lead' ? '🎯' : kind === 'deal' ? '💼' : '🏢'}</div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <h2 className="crm-rec-title">{name}</h2>
              {row.code && <span className="small-muted" style={{ fontWeight: 700, fontFamily: 'monospace' }}>{row.code}</span>}
              <Pill v={kindPill} />
              {kind === 'deal' && stale > 0 && <span className="status overdue" title={`Nothing logged for ${stale} days`}>💤 {stale} days quiet</span>}
            </div>
            <div className="small-muted" style={{ marginTop: 3, display: 'flex', alignItems: 'center', gap: 6 }}>
              Assigned to:{' '}
              {me.canAssign && d.canEdit ? (
                <select value={row.ownerId || ''} onChange={(e) => assign(e.target.value)} style={{ width: 'auto', padding: '2px 6px', fontSize: 12.5 }} aria-label="Assigned to">
                  {!me.owners.some((o) => o.id === row.ownerId) && <option value={row.ownerId || ''}>{row.ownerName || '—'}</option>}
                  {me.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              ) : <b>{row.ownerName || '—'}</b>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <QuickContact phone={contactLine && contactLine.phone ? contactLine.phone : row.phone} email={contactLine && contactLine.email ? contactLine.email : row.email} />
            {d.canEdit && <button type="button" className="btn btn-sm" onClick={() => setEditing({ kind, row })}>Edit</button>}
            {kind === 'deal' && row.approvalStatus === 'Pending' && me.canAssign && (
              <>
                <button type="button" className="btn btn-primary btn-sm" title={`Approve the ${row.discountPercent || 0}% discount`} onClick={() => decideDiscount('approve')}>Approve discount</button>
                <button type="button" className="btn btn-sm" onClick={() => decideDiscount('reject')}>Reject</button>
              </>
            )}
            {d.canEdit && kind === 'lead' && row.status !== 'Converted' && (
              <select value={row.stage || ''} onChange={(e) => moveLead(row, e.target.value)} aria-label="Stage" style={{ width: 'auto' }}>
                {L.leadStages.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
            )}
            {d.canEdit && kind === 'lead' && row.status !== 'Converted' && <button type="button" className="btn btn-sm" title="Stop or start the automatic mails, SMS, WhatsApp and calls to this lead" onClick={() => api.post(`/crm/leads/${row.id}/auto`, { paused: !row.autoPaused }).then(() => { toast(row.autoPaused ? 'Automatic follow-through is on for this lead.' : 'Automatic follow-through stopped for this lead.'); changed(); }).catch((e) => toast(errOf(e, 'This could not be changed.')))}>{row.autoPaused ? 'Start automatic' : 'Stop automatic'}</button>}
            {d.canEdit && kind === 'lead' && row.status !== 'Converted' && <button type="button" className="btn btn-primary btn-sm" onClick={() => setConverting(true)}>Convert to deal</button>}
            {kind === 'lead' && row.status === 'Converted' && row.dealId && <button type="button" className="btn btn-sm" onClick={() => openRecord('deal', row.dealId)}>Open the deal</button>}
            {d.canEdit && kind === 'account' && <button type="button" className="btn btn-sm" onClick={() => setEditing({ kind: 'contact', preset: { accountId: row.id } })}>+ Contact</button>}
            {d.canEdit && kind === 'account' && <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing({ kind: 'deal', preset: { accountId: row.id, title: `${row.name} - deal` } })}>+ Deal</button>}
          </div>
        </div>
        {kind === 'deal' && (
          <div className="crm-stages" role="group" aria-label="Deal stage">
            {me.lists.stages.map((st) => (
              <button key={st} type="button" disabled={!d.canEdit || st === row.stage} className={`crm-stage${st === row.stage ? ' on' : ''}${st === 'Won' ? ' won' : ''}${st === 'Lost' ? ' lost' : ''}`} onClick={() => move(row, st)}>{st}</button>
            ))}
          </div>
        )}
        <div className="crm-rec-info">
          <div style={{ flexDirection: 'column', gap: 6 }}>
            {reach.map(([ic, v]) => <div key={ic}><span aria-hidden="true">{ic}</span><span>{v}</span></div>)}
            {!reach.length && <span className="small-muted">No phone or email yet. Add a contact.</span>}
          </div>
          <div style={{ flexDirection: 'column', gap: 6 }}>
            {info.map(([k, v]) => <div key={k}><span className="k">{k}</span><span style={{ minWidth: 0 }}>{v}</span></div>)}
          </div>
        </div>
        <div className="tabs" role="tablist" style={{ marginBottom: 12 }}>
          {tabs.map(([k, l]) => <div key={k} role="tab" tabIndex={0} aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)} onKeyDown={(e) => { if (e.key === 'Enter') setTab(k); }}>{l}</div>)}
        </div>
        {tab === 'overview' && (
          <>
            <AiInsight kind={kind} id={row.id} refresh={d} />
            {kind === 'account' && (
              <div className="grid-2" style={{ marginBottom: 12 }}>
                <div className="card" style={{ padding: 12 }}>
                  <div className="section-label" style={{ marginTop: 0 }}>Contacts ({d.contacts.length})</div>
                  {!d.contacts.length && <div className="small-muted">No contacts yet.</div>}
                  {d.contacts.map((c) => (
                    <div key={c.id} style={{ padding: '5px 0', borderBottom: '1px solid var(--line-soft)', fontSize: 13, display: 'flex', gap: 6 }}>
                      <div style={{ flex: 1 }}><b>{c.name}</b>{c.designation ? ` · ${c.designation}` : ''}{c.role ? <span className="small-muted"> · {c.role}</span> : null}<div className="small-muted">{[c.phone, c.email].filter(Boolean).join(' · ')}</div></div>
                      {d.canEdit && <button type="button" className="btn btn-sm" onClick={() => setEditing({ kind: 'contact', row: c })}>Edit</button>}
                    </div>
                  ))}
                </div>
                <div className="card" style={{ padding: 12 }}>
                  <div className="section-label" style={{ marginTop: 0 }}>Deals ({d.deals.length})</div>
                  {!d.deals.length && <div className="small-muted">No deals yet.</div>}
                  {d.deals.map((x) => (
                    <div key={x.id} style={{ padding: '5px 0', borderBottom: '1px solid var(--line-soft)', fontSize: 13 }}>
                      <RecLink kind="deal" id={x.id}>{x.title}</RecLink> <span className="small-muted">· {x.stage} · {moneyShort(x.value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="crm-two">
              <div>
                <div className="section-label" style={{ marginTop: 0 }}>Log a call, meeting or note</div>
                {d.canEdit && <LogActivity link={link} onDone={changed} />}
                <Timeline activities={(d.activities || []).slice(0, 6)} />
                {(d.activities || []).length > 6 && <button type="button" className="crm-linkbtn" style={{ marginTop: 6 }} onClick={() => setTab('activities')}>All {(d.activities || []).length} activities →</button>}
              </div>
              <div>
                <div className="section-label" style={{ marginTop: 0 }}>Follow-ups</div>
                <TaskList tasks={openTasks} link={link} onChanged={changed} canEdit={d.canEdit} />
              </div>
            </div>
          </>
        )}
        {tab === 'activities' && (
          <>
            {d.canEdit && <LogActivity link={link} onDone={changed} />}
            <Timeline activities={d.activities || []} />
          </>
        )}
        {tab === 'followups' && <TaskList tasks={d.tasks || []} link={link} onChanged={changed} canEdit={d.canEdit} />}
        {tab === 'proposals' && kind === 'deal' && <ProposalBox dealId={row.id} onChanged={changed} />}
        {tab === 'support' && kind === 'account' && <TicketList accountId={row.id} compact />}
        {tab === 'notes' && (
          <div>
            {notes == null ? (
              <>
                <div className="card" style={{ padding: 12, whiteSpace: 'pre-wrap', fontSize: 13.5, minHeight: 60 }}>{row.notes || <span className="small-muted">No notes yet.</span>}</div>
                {d.canEdit && <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setNotes(row.notes || '')}>Edit notes</button>}
              </>
            ) : (
              <>
                <textarea rows={8} value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Notes" />
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button type="button" className="btn btn-primary btn-sm" onClick={saveNotes}>Save notes</button>
                  <button type="button" className="btn btn-sm" onClick={() => setNotes(null)}>Cancel</button>
                </div>
              </>
            )}
          </div>
        )}
      </>
    );
  }
  return (
    <>
      <Modal title={kind === 'lead' ? 'Lead record' : kind === 'deal' ? 'Deal record' : 'Customer record'} size="xwide" onClose={onClose}>{body}</Modal>
      {editing && <RecordForm kind={editing.kind} row={editing.row} preset={editing.preset} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); changed(); }} />}
      {converting && row && <ConvertLead lead={row} onClose={() => setConverting(false)} onDone={(out) => { setConverting(false); changed(); if (out.deal) openRecord('deal', out.deal.id); }} />}
      {dialog}{leadDialog}
    </>
  );
}

// ?open=kind:id in the address opens that record (links from the dashboard, the bell, an email)
export function useOpenParam(searchParams, setSearchParams) {
  const raw = searchParams.get('open') || '';
  const [kind, id] = raw.split(':');
  const open = kind && id ? { kind, id } : null;
  const setOpen = (o) => {
    const next = new URLSearchParams(searchParams);
    if (o) next.set('open', `${o.kind}:${o.id}`); else next.delete('open');
    setSearchParams(next, { replace: !o });
  };
  return [open, setOpen];
}
