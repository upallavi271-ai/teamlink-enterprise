// ---------------------------------------------------------------------------
// THE SALES CRM - SHARED PIECES (founder 2026-11-02). The four screens (Dashboard, Leads, Deals, Accounts & Contacts) use:
//   CrmCtx / useCrm      who I am in the CRM (role, may edit / assign, owners, pick lists) + a small toast
//   RecordForm           add / edit a lead, account, contact or deal (duplicate warning with "Save anyway")
//   RecordPanel          one record: details, actions (convert, stage, add as client), timeline and follow-ups
//   money / ago / ...    small formatters
// Everything is read from and written to /api/crm (backend/src/crm/service.js holds the rules).
// ---------------------------------------------------------------------------
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { DoneDialog, REMIND_WORDS } from './CrmFollowups.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import RecordEngage from './b/RecordEngage.jsx'; // eslint-disable-line import/no-cycle -- CRM wave B: email opens, office-line calls, pages viewed, surveys, portal
import { TicketList } from './CrmSupport.jsx'; // eslint-disable-line import/no-cycle
import CrmContactDialog, { ContactPanel } from './CrmContact.jsx'; // eslint-disable-line import/no-cycle
import { ProductSellBox } from './CrmProducts.jsx'; // eslint-disable-line import/no-cycle
import Conversation from './CrmConversation.jsx'; // eslint-disable-line import/no-cycle
// wave D (2026-11-24): products, splits, team chat, history, contracts, quote versions, pay online, consent, territory (CrmPlus.jsx)
import { plusOf, stagesOfDeal, pipelineOfDeal, fieldHidden, fieldReadOnly, DealProducts, DealTeam, Comments, DealHistory, FieldHistory, ContractsBox, QuotesPlus, PayBox, ConsentBox, TerritoryPick } from './CrmPlus.jsx'; // eslint-disable-line import/no-cycle
import { AiPredict, MoodChip, FillFromText, VisitButton, RecordCalls, RepeatPicker, RepeatLine, VideoButton } from './CrmPlusE.jsx'; // eslint-disable-line import/no-cycle
// CRM wave C (2026-11-24): custom fields / layouts / tags / currency / units on the forms, the More and Privacy tabs, Merge
import { usePlusSetup, applyLayout, CustomInput, TagInput, getNumberLocale, foreignMoney } from './crmPlusC.jsx';
import { t as tr, useLang } from '../../i18n.jsx'; // the CRM's words in Telugu / Hindi (crmPlusC.jsx adds them)
import { RecordMore, RecordPrivacy, MergeDialog } from './CrmRecordMore.jsx'; // eslint-disable-line import/no-cycle
import { ReceiptButtons, NotesBox, RepeatBox, LeadSequenceBox } from './CrmMoneyMore.jsx'; // eslint-disable-line import/no-cycle -- receipts, credit / debit notes, repeat, sequences (2026-11-26)

export const CrmCtx = createContext(null);
export const useCrm = () => useContext(CrmCtx);

export const errOf = (e, fb) => (e && e.response && e.response.data && e.response.data.error) || fb;
// ₹ in Indian grouping; short form in lakhs / crores for the board and the cards
export const money = (n) => `₹${Math.round(Number(n) || 0).toLocaleString(getNumberLocale())}`; // the number format: CRM settings > Customise (Indian by default)
export const moneyShort = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(v >= 1e8 ? 0 : 1)} Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(v >= 1e6 ? 0 : 1)} L`;
  return money(v);
};
export const dateOf = (iso) => { if (!iso) return ''; const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }); };
export const dateTimeOf = (iso) => { if (!iso) return ''; const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); };
export const istToday = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
// A DATE AS dd/mm/yyyy (founder 2026-11-14: the browser's own date box shows mm/dd/yyyy, the US order). Typed (the slashes come by themselves) or
// picked from the calendar button; the value that goes in and comes out is always yyyy-mm-dd, '' while it is empty, unfinished or not a real day,
// so every screen that held a native date value works unchanged. `min` (yyyy-mm-dd) refuses earlier days like the native box did.
const isoToDisplay = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? `${v.slice(8)}/${v.slice(5, 7)}/${v.slice(0, 4)}` : '');
function displayToIso(t) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t || '');
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
  return d.getUTCFullYear() === Number(m[3]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[1]) ? `${m[3]}-${m[2]}-${m[1]}` : '';
}
export function DateField({ value, onChange, min, style, 'aria-label': ariaLabel, placeholder = 'dd/mm/yyyy' }) {
  const [text, setText] = useState(isoToDisplay(value));
  const [bad, setBad] = useState(false);
  const pick = useRef(null);
  // a value changed from outside (a form reset, a preset) replaces what is typed - but never fights the person while they type
  useEffect(() => { if (displayToIso(text) !== (value || '')) { setText(isoToDisplay(value)); setBad(false); } }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const type = (raw) => {
    const digits = raw.replace(/\D/g, '').slice(0, 8);
    let t = digits;
    if (digits.length > 2) t = `${digits.slice(0, 2)}/${digits.slice(2)}`;
    if (digits.length > 4) t = `${t.slice(0, 5)}/${digits.slice(4)}`;
    setText(t);
    const iso = displayToIso(t);
    const tooEarly = !!(iso && min && iso < min);
    setBad(tooEarly || (t.length === 10 && !iso)); // a finished date that is not a real day, or before `min`
    onChange(tooEarly ? '' : iso);
  };
  const openCalendar = () => { const el = pick.current; if (!el) return; if (el.showPicker) { try { el.showPicker(); return; } catch { /* fall through */ } } el.click(); };
  return (
    <span style={{ position: 'relative', display: 'inline-block', width: (style && style.width) || '100%', ...(style || {}) }}>
      <input type="text" inputMode="numeric" autoComplete="off" placeholder={placeholder} maxLength={10} value={text} onChange={(e) => type(e.target.value)} aria-label={ariaLabel} aria-invalid={bad || undefined} style={{ width: '100%', paddingRight: 30, ...(bad ? { borderColor: 'var(--red)' } : {}) }} />
      <button type="button" onClick={openCalendar} aria-label="Pick the date from a calendar" title="Pick from a calendar" style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', border: 0, background: 'transparent', cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: 2 }}>📅</button>
      <input ref={pick} type="date" tabIndex={-1} aria-hidden="true" min={min} value={value || ''} onChange={(e) => { setText(isoToDisplay(e.target.value)); setBad(false); onChange(e.target.value); }} style={{ position: 'absolute', right: 0, bottom: 0, width: 1, height: 1, opacity: 0, pointerEvents: 'none', border: 0, padding: 0 }} />
    </span>
  );
}
// how many whole days a due date (yyyy-mm-dd) is behind today, at least 1 (only asked of a late follow-up)
export const daysLate = (due) => Math.max(1, Math.round((Date.parse(`${istToday()}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86400000));
export const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// LOG A CALL FROM ANYWHERE (founder 2026-11-14: a lead needs something logged before it is Contacted / Qualified, "extra clicks vaddu"): a small
// window - what it was, what came of it, a note, and optionally the next follow-up - opened from a row of the Leads table, a card on the board, or by
// itself when a move was refused for want of a log (then the move is tried again). `record` is a lead.
const LOG_KINDS = [['call', 'Call'], ['whatsapp', 'WhatsApp'], ['email', 'Email'], ['meeting', 'Meeting'], ['note', 'Note']];
// "MARK THE FOLLOW-UP DONE?" (the founder's review 2026-11-16: "call chesanu kani still late ani vastundi"): after a call / mail / WhatsApp / meeting is logged on a record that still has a
// follow-up open and due, ask once, with one button per follow-up. It is closed as done with the outcome just logged (no second line on the timeline).
export function MarkDonePrompt({ items, outcome, onClose }) {
  const { toast } = useCrm();
  const [left, setLeft] = useState(items || []);
  const doneIds = useRef(new Set()); // ids already closed (two quick clicks must not leave a stale list)
  const [busy, setBusy] = useState('');
  const today = istToday();
  async function done(t) {
    setBusy(t.id);
    try {
      await api.post(`/crm/tasks/${t.id}/done`, { outcome: outcome || undefined, noActivity: true });
      toast(`"${t.title}" is done.`);
      doneIds.current.add(t.id);
      const rest = (items || []).filter((x) => !doneIds.current.has(x.id));
      if (!rest.length) onClose(true); else setLeft(rest);
    } catch (e) { toast(errOf(e, 'The follow-up could not be closed.')); } finally { setBusy(''); }
  }
  return (
    <Modal title="Mark the follow-up done?" onClose={() => onClose(false)} foot={<button type="button" className="btn" onClick={() => onClose(false)}>Not yet</button>}>
      <p className="small-muted" style={{ marginTop: 0 }}>You have just logged this. This record still has {left.length === 1 ? 'a follow-up' : 'follow-ups'} waiting, so it keeps showing as late:</p>
      {left.map((t) => (
        <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--line-soft, #eef0f4)' }}>
          <div style={{ flex: 1, minWidth: 0 }}><b>{t.title}</b><div className="small-muted" style={{ fontSize: 12 }}>{t.type || 'Follow-up'} · due {dateOf(t.dueDate)}{t.dueTime ? ` ${t.dueTime}` : ''}{t.dueDate < today ? ' · late' : ''}</div></div>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy === t.id} onClick={() => done(t)}>{busy === t.id ? 'Saving…' : 'Mark done'}</button>
        </div>
      ))}
    </Modal>
  );
}

// THE COMPANY'S ONE MEETING LINK (founder 2026-11-16: "okate meet link andhariki standard ga undeylaaga pettu, evari meeting ayina aa link through send cheyyadaniki"): CRM Settings holds it once
// (Meeting link: Google Meet / Zoom); a Meeting follow-up gets "Send invite" (and is offered right after it is made): the mail / WhatsApp window opens with the date, the time and the link
// written in, the person presses Send. In any mail or WhatsApp the window also has "Add meeting link".
const clock12 = (hm) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(hm || '')); if (!m) return ''; const h = Number(m[1]); return `${h % 12 || 12}${m[2] === '00' ? '' : `:${m[2]}`} ${h < 12 ? 'am' : 'pm'}`; };
export const meetingWhen = (dueDate, dueTime) => (dueDate ? `${dateOf(dueDate)}${dueTime ? ` at ${clock12(dueTime)}` : ''}` : '');
export const recordOfTask = (t) => {
  if (t.recordKind && t.recordId) return { kind: t.recordKind, id: t.recordId, name: t.recordName };
  if (t.dealId) return { kind: 'deal', id: t.dealId, name: t.recordName };
  if (t.leadId) return { kind: 'lead', id: t.leadId, name: t.recordName };
  if (t.accountId) return { kind: 'account', id: t.accountId, name: t.recordName };
  return null;
};
export function InviteButton({ task, record }) {
  const [open, setOpen] = useState(false);
  const rec = record || recordOfTask(task);
  if (!task || task.type !== 'Meeting' || task.status !== 'Open' || !rec) return null;
  return (
    <>
      <button type="button" className="btn btn-sm" title="Opens the email with the date, time and the company meeting link written in; you press Send" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>📅 Send invite</button>
      {open && <CrmContactDialog record={rec} channel="Email" invite={{ when: meetingWhen(task.dueDate, task.dueTime), link: task.meetingUrl || undefined }} onClose={() => setOpen(false)} />}
    </>
  );
}
export function MeetingInvitePrompt({ record, when, onClose }) {
  const [ch, setCh] = useState(null);
  const { me } = useCrm();
  if (ch) return <CrmContactDialog record={record} channel={ch} invite={{ when }} onClose={onClose} />;
  return (
    <Modal title="Send the meeting invite now?" onClose={onClose} foot={<button type="button" className="btn" onClick={onClose}>Later</button>}>
      <p style={{ marginTop: 0 }}>The meeting is set for <b>{when || 'the day you picked'}</b>. The invite has the date, the time and the company meeting link.</p>
      {!me.meetingLink && <div className="notice" style={{ marginBottom: 10, fontSize: 13 }}>The company meeting link is not set yet, so the invite will go without it. A Sales manager sets it once in CRM &gt; Dashboard &gt; Settings (Meeting link).</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary" onClick={() => setCh('Email')}>✉️ Email the invite</button>
        <button type="button" className="btn" onClick={() => setCh('WhatsApp')}>💬 WhatsApp the invite</button>
      </div>
    </Modal>
  );
}

export function QuickLog({ record, intro, onClose, onLogged }) {
  const { me, toast } = useCrm();
  const [ask, setAsk] = useState(null); // open follow-ups of this lead, asked about after the log is saved
  const [kind, setKind] = useState('call');
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');
  const [next, setNext] = useState('');
  const [nextTime, setNextTime] = useState('');
  const [busy, setBusy] = useState(false);
  const label = LOG_KINDS.find((k) => k[0] === kind)[1];
  // Call / WhatsApp / Email in this window are the real thing (founder 2026-11-16: "ikkada nunchey calls, wtsp msgs, email msgs send cheyyali"): the contact panel, with the person's own
  // integrations. "Only write it down" keeps the old log form for something done another way. Meeting and Note are always the log form.
  const ACT = { call: 'Call', whatsapp: 'WhatsApp', email: 'Email' };
  const [justLog, setJustLog] = useState(false);
  const [did, setDid] = useState(false); // something was sent / called from here: closing then counts as logged (the refused move is tried again)
  const act = !!ACT[kind] && !justLog;
  const closeIt = () => (did ? onLogged() : onClose());
  async function save() {
    if (!outcome && !note.trim()) { toast('Pick what came of it or write a line about it.'); return; }
    setBusy(true);
    try {
      const r = await api.post('/crm/activities', {
        kind, leadId: record.id, subject: `${label}${outcome ? `: ${outcome}` : ''}`, note: note.trim() || undefined, outcome: outcome || undefined,
        followUp: next ? { dueDate: next, dueTime: nextTime || undefined, title: `Follow up: ${record.company}` } : undefined,
      });
      toast(`Logged on ${record.company}.`);
      const items = (r.data && r.data.openFollowUps) || [];
      if (items.length && kind !== 'note') { setAsk({ items }); setBusy(false); return; }
      onLogged();
    } catch (e) { toast(errOf(e, 'This could not be saved.')); setBusy(false); }
  }
  const today = istToday();
  return (
    <>
    {ask && <MarkDonePrompt items={ask.items} outcome={outcome} onClose={() => { setAsk(null); onLogged(); }} />}
    <Modal title={`${act ? 'Contact' : 'Log'}: ${record.company}`} size={act ? 'wide' : undefined} onClose={closeIt} foot={act ? <button type="button" className="btn" onClick={closeIt}>Close</button> : <><button type="button" className="btn" onClick={closeIt}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></>}>
      {intro && <div className="notice" style={{ marginBottom: 10 }}>{intro}</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
        {LOG_KINDS.map(([k, l]) => <button key={k} type="button" className={`btn btn-sm${kind === k ? ' btn-primary' : ''}`} aria-pressed={kind === k} onClick={() => { setKind(k); setJustLog(false); }}>{l}</button>)}
      </div>
      {act && (
        <>
          <ContactPanel key={kind} record={{ kind: 'lead', id: record.id, name: record.contactName || record.company }} channel={ACT[kind]} hideTabs onDone={() => setDid(true)} />
          <div className="small-muted" style={{ marginTop: 12, fontSize: 12.5 }}>Did it another way? <button type="button" className="crm-linkbtn" onClick={() => setJustLog(true)}>Only write it down</button></div>
        </>
      )}
      {!act && <>
      {kind !== 'note' && (
        <div className="field">
          <label>What came of it?</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {me.lists.outcomes.map((o) => <button key={o} type="button" className={`btn btn-sm${outcome === o ? ' btn-primary' : ''}`} aria-pressed={outcome === o} onClick={() => setOutcome(outcome === o ? '' : o)}>{o}</button>)}
          </div>
          {outcome === 'No answer' && <div className="small-muted" style={{ marginTop: 4 }}>A call nobody picked up is logged, but the lead does not become Contacted.</div>}
        </div>
      )}
      <div className="field"><label>What happened?</label><textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Spoke to the owner, wants a quote by Friday" /></div>
      <div className="section-label" style={{ marginTop: 4 }}>Next follow-up (optional)</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
        {[['Tomorrow', 1], ['In 3 days', 3], ['Next week', 7]].map(([l, n]) => <button key={l} type="button" className={`btn btn-sm${next === addDays(today, n) ? ' btn-primary' : ''}`} onClick={() => setNext(addDays(today, n))}>{l}</button>)}
      </div>
      <div className="grid-2">
        <div className="field"><label>Date</label><DateField min={today} value={next} onChange={setNext} aria-label="Next follow-up date" /></div>
        <div className="field"><label>Time</label><input type="time" value={nextTime} disabled={!next} onChange={(e) => setNextTime(e.target.value)} /></div>
      </div>
      </>}
    </Modal>
    </>
  );
}
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

const STATUS_CLASS = { Draft: 'review', Sent: 'pending', Accepted: 'joined', Declined: 'rejected', Hot: 'overdue', Warm: 'pending', Cold: 'new', New: 'new', Contacted: 'pending', Qualified: 'active', Junk: 'rejected', Converted: 'joined', Won: 'joined', Lost: 'rejected', Prospect: 'new', Client: 'active', Paid: 'joined', 'Partly paid': 'pending', Overdue: 'overdue', Cancelled: 'rejected' };
// a file from the API (CSV, PDF) with the login's token: opened (PDF) or saved (CSV)
export async function download(url, name, { open } = {}) {
  const r = await api.get(url, { responseType: 'blob' });
  const href = URL.createObjectURL(r.data);
  if (open) { window.open(href, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(href), 60000); return; }
  const a = document.createElement('a'); a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10000);
}
// Call / WhatsApp / Email from a record (founder 2026-11-14: they must really work, through what Administration -> Integrations has connected).
// With `record` ({ kind, id, name }) each button opens the contact window (CrmContact.jsx): the real send / click-to-call when the integration is connected,
// the person's own app when it is not, and the timeline line either way. Without `record` (older callers) it is the plain tel: / wa.me / mailto: links.
export function QuickContact({ phone, email, record, onDone }) {
  const [open, setOpen] = useState(null);
  const digits = String(phone || '').replace(/\D/g, '');
  const wa = digits.length === 10 ? `91${digits}` : digits;
  if (record && record.id) {
    return (
      <span style={{ display: 'inline-flex', gap: 4 }}>
        <button type="button" className="btn btn-sm" onClick={() => setOpen('Call')} title={phone ? `Call ${phone}` : 'Call'}>📞 Call</button>
        <button type="button" className="btn btn-sm" onClick={() => setOpen('WhatsApp')} title="WhatsApp">💬 WhatsApp</button>
        <button type="button" className="btn btn-sm" onClick={() => setOpen('Email')} title={email ? `Email ${email}` : 'Email'}>✉️ Email</button>
        {open && <CrmContactDialog record={record} channel={open} onClose={() => setOpen(null)} onDone={onDone} />}
      </span>
    );
  }
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
// A follow-up's priority (2026-11-14): High is a red chip, Low a grey chip, Medium (also any follow-up from before priorities) plain quiet text
const PRIORITY_STYLE = { High: { background: 'rgba(220, 38, 38, 0.12)', color: '#b42318' }, Low: { background: 'rgba(100, 116, 139, 0.14)', color: '#475569' } };
export const PriorityPill = ({ v }) => (PRIORITY_STYLE[v] ? <span className="status" style={{ ...PRIORITY_STYLE[v], fontWeight: 700 }}>{v}</span> : <span className="small-muted" style={{ fontSize: 12 }}>{v === 'Medium' || !v ? 'Medium' : v}</span>);

// ---- the forms -------------------------------------------------------------------------------------------
function fieldsFor(kind, me) {
  const L = me.lists;
  if (kind === 'lead') {
    return [
      { k: 'company', label: 'Company *' }, { k: 'contactName', label: 'Contact person' }, { k: 'designation', label: 'Designation' },
      { k: 'phone', label: 'Phone', type: 'tel' }, { k: 'email', label: 'Email', type: 'email' }, { k: 'industry', label: 'Industry' },
      { k: 'city', label: 'City' }, { k: 'source', label: 'Source', type: 'select', options: L.sources }, { k: 'expectedValue', label: 'Expected value (₹)', type: 'number' },
      { k: 'rating', label: 'Rating', type: 'select', options: L.ratings },
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
    // wave D: which pipeline (new deals), the forecast category, and recurring billing (MRR / ARR, renewals)
    ...(plusOf(me).pipelines.length > 1 ? [{ k: 'pipelineId', label: 'Pipeline', type: 'select', createOnly: true, options: plusOf(me).pipelines.map((p) => ({ value: p.id === 'default' ? '' : p.id, label: p.name })) }] : []),
    { k: 'forecastCategory', label: 'Forecast category', type: 'select', options: plusOf(me).forecastCategories, hint: 'Empty: worked out from the probability' },
    { k: 'billing', label: 'Billing', type: 'select', options: plusOf(me).billings, hint: 'Monthly / Quarterly / Yearly counts in MRR and gets a renewal' },
    { k: 'termMonths', label: 'Term (months)', type: 'number', hint: 'Empty = 12' },
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
  // a field hidden from my CRM role is not on the form; a read-only one is shown but cannot be changed (CRM settings > Security)
  const setup = usePlusSetup();
  // CRM wave C: tags, parent company, currency, business unit, the custom fields - laid out by the layout (CRM settings > Customise)
  const waveFields = [
    ...(kind !== 'account' ? [{ k: 'tags', label: 'Tags', hint: 'Comma-separated, e.g. VIP, Expo 2026' }] : []),
    ...(kind === 'account' ? [{ k: 'parentId', label: 'Parent company', type: 'parent', hint: 'When this is a subsidiary or branch of another account' }] : []),
    ...(kind === 'deal' && setup && setup.currencies && setup.currencies.length ? [{ k: 'currency', label: 'Currency', type: 'currency' }, ...(f.currency && f.currency !== 'INR' ? [{ k: 'amountForeign', label: `Deal value (${f.currency})`, type: 'number', hint: 'The value in ₹ is worked out at the rate of the day and kept with the deal' }] : [])] : []),
    ...(kind !== 'contact' && setup && setup.unitsOn && setup.units.length ? [{ k: 'unitId', label: 'Business unit', type: 'unit' }] : []),
  ];
  const sections = applyLayout(kind, [...fieldsFor(kind, me).filter((x) => (editing ? !x.createOnly : !x.editOnly) && !fieldHidden(me, kind, x.k)), ...waveFields], setup, me.role);
  const fields = sections.flatMap((x) => x.fields);
  // an edited record's custom values as this person may see them (a sensitive one decrypted for its owner)
  useEffect(() => { if (editing && kind) api.get(`/crm/plusc/record/${kind}/${row.id}`).then((r) => setF((x) => ({ ...x, custom: { ...(r.data.custom || {}), ...(x.custom || {}) } }))).catch(() => null); }, [editing, kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const needsAccounts = fields.some((x) => x.type === 'account' || x.type === 'parent');
  useEffect(() => { if (needsAccounts) api.get('/crm/accounts').then((r) => setAccounts(r.data.rows)).catch(() => setAccounts([])); }, [needsAccounts]);
  useEffect(() => {
    if (kind !== 'deal' || !f.accountId) { setContacts([]); return; }
    api.get('/crm/contacts', { params: { accountId: f.accountId } }).then((r) => setContacts(r.data.rows)).catch(() => setContacts([]));
  }, [kind, f.accountId]);
  const set = (k, v) => { setF((x) => ({ ...x, [k]: v })); setErr(''); setDups(null); };

  async function save(force) {
    setBusy(true); setErr('');
    const body = {}; fields.forEach((x) => { if (x.custom) { body.custom = { ...(body.custom || {}), [x.k]: (f.custom || {})[x.k] ?? '' }; } else if (!(x.k === 'value' && f.currency && f.currency !== 'INR')) body[x.k] = f[x.k] ?? ''; });
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
    if (x.custom) return <CustomInput d={x.custom} value={(f.custom || {})[x.k]} readOnly={x.readOnly} onChange={(v) => { setF((y) => ({ ...y, custom: { ...(y.custom || {}), [x.k]: v } })); setErr(''); }} />;
    const v = f[x.k] ?? '';
    const ro = fieldReadOnly(me, kind, x.k);
    if (x.readOnly) return <input type="text" value={v} disabled aria-label={x.label} />;
    if (x.k === 'tags') return <TagInput value={v} onChange={(t) => set('tags', t)} kind={kind} />;
    if (x.type === 'parent') return <select value={v} onChange={(e) => set(x.k, e.target.value)} disabled={accounts == null}><option value="">— no parent —</option>{(accounts || []).filter((a) => !row || a.id !== row.id).map((a) => <option key={a.id} value={a.id}>{a.name}{a.city ? ` · ${a.city}` : ''}</option>)}</select>;
    if (x.type === 'currency') return <select value={v || 'INR'} onChange={(e) => set(x.k, e.target.value)}><option value="INR">₹ Indian rupee</option>{setup.currencies.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.symbol.trim()} (₹{c.rate})</option>)}</select>;
    if (x.type === 'unit') return <select value={v} onChange={(e) => set(x.k, e.target.value)}><option value="">—</option>{setup.units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>;
    if (x.k === 'value' && f.currency && f.currency !== 'INR') return <input type="text" disabled value={f.amountForeign ? `about ₹${Math.round(Number(f.amountForeign) * ((setup.currencies.find((c) => c.code === f.currency) || {}).rate || 0)).toLocaleString('en-IN')}` : ''} aria-label="Deal value in rupees" />;
    if (x.type === 'select') return <select value={v} disabled={ro} onChange={(e) => set(x.k, e.target.value)}>{!(x.options[0] && typeof x.options[0] === 'object') && <option value="">—</option>}{x.options.map((o) => (typeof o === 'object' ? <option key={o.value} value={o.value}>{o.label}</option> : <option key={o} value={o}>{o}</option>))}</select>;
    if (ro) return <input type="text" value={v} disabled title="Read only for your CRM role" />;
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
        {sections.map((sec) => [
          sec.name ? <div key={`sec-${sec.name}`} className="section-label" style={{ gridColumn: '1 / -1', margin: '6px 0 0' }}>{sec.name}</div> : null,
          ...sec.fields.map((x) => (
            <div key={x.k} className="field" style={x.wide ? { gridColumn: '1 / -1' } : undefined}>
              <label>{x.label}</label>
              {input(x)}
              {x.hint && <div className="small-muted" style={{ marginTop: 3 }}>{x.hint}</div>}
            </div>
          )),
        ])}
        {me.canAssign && (
          <div className="field">
            <label>Owner (salesperson)</label>
            <select value={f.ownerId || ''} onChange={(e) => set('ownerId', e.target.value)}>
              <option value="">{editing ? (row.ownerName || '—') : (kind === 'lead' && me.lists.autoAssignManual ? 'Next salesperson in turn' : 'Me')}</option>
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
  const [ask, setAsk] = useState(null);
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
      const r = await api.post('/crm/activities', { kind, subject, note, ...link, followUp: next ? { dueDate: next, title: nextTitle || undefined } : undefined });
      setSubject(''); setNote(''); setNext(''); setNextTitle('');
      toast(next ? 'Logged, with the next follow-up.' : 'Logged.');
      const items = (r.data && r.data.openFollowUps) || [];
      if (items.length) setAsk({ items });
      onDone();
    } catch (e) { setErr(errOf(e, 'This could not be saved.')); } finally { setBusy(false); }
  }
  const today = istToday();
  return (
    <div className="card" style={{ padding: 12, marginBottom: 12 }}>
      {ask && <MarkDonePrompt items={ask.items} onClose={() => { setAsk(null); onDone(); }} />}
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
        <DateField value={next} min={today} onChange={setNext} style={{ width: 150 }} aria-label="Follow-up date" />
        {next && <button type="button" className="btn btn-sm" onClick={() => setNext('')} aria-label="No follow-up">×</button>}
        {next && <input type="text" placeholder="Follow-up: what to do" value={nextTitle} onChange={(e) => setNextTitle(e.target.value)} style={{ flex: 1, minWidth: 160 }} />}
        <button type="button" className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} disabled={busy || (!subject.trim() && !note.trim())} onClick={save}>{busy ? 'Saving…' : 'Log it'}</button>
      </div>
      {err && <div className="small-muted" role="alert" style={{ color: 'var(--red)', marginTop: 6 }}>{err}</div>}
    </div>
  );
}

// A long note (a sent email or WhatsApp message with its whole text) is one short line with "View details" (founder 2026-11-16: "open or view details ani yedhokati ivvu, click chesthe
// open ayyelaaga"); a short note stays as it is. For a sent message the first line is "To <address>".
export function ActNote({ note, className, style }) {
  const [open, setOpen] = useState(false);
  const text = String(note || '');
  if (!text) return null;
  const lines = text.split('\n');
  const long = text.length > 140 || lines.length > 2;
  if (!long) return <div className={className} style={{ whiteSpace: 'pre-wrap', ...style }}>{text}</div>;
  const head = lines[0].slice(0, 110);
  return (
    <div className={className} style={style}>
      {open ? <div style={{ whiteSpace: 'pre-wrap' }}>{text}</div> : <div>{head}{lines.length > 1 || lines[0].length > 110 ? ' …' : ''}</div>}
      <button type="button" className="crm-linkbtn" style={{ marginTop: 2 }} aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>{open ? 'Hide details' : 'View details'}</button>
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
          <div className="timeline-label">{ACT_ICON[a.kind] || '•'} {a.subject || (a.kind === 'note' ? 'Note' : a.kind)}{a.deliveryStatus === 'Failed' && <> <span className="status rejected" style={{ fontSize: 11 }} title={a.deliveryDetail || ''}>✗ Not delivered</span></>}{a.deliveryStatus === 'Read' && <> <span className="status active" style={{ fontSize: 11 }} title={a.deliveryDetail || ''}>✓✓ Read</span></>}{a.deliveryStatus === 'Delivered' && <> <span className="status active" style={{ fontSize: 11 }} title={a.deliveryDetail || ''}>✓✓ Delivered</span></>}{a.deliveryStatus === 'Sent' && <> <span className="status pending" style={{ fontSize: 11 }} title={a.deliveryDetail || ''}>✓ Sent{a.kind === 'whatsapp' ? ' · waiting for WhatsApp' : ''}</span></>}{!a.deliveryStatus && /^Email sent/.test(a.subject || '') && <> <span className="status active" style={{ fontSize: 11 }}>✓ Sent</span></>}{/^(Mail app opened|WhatsApp opened)/.test(a.subject || '') && <> <span className="status pending" style={{ fontSize: 11 }} title="Opened in the person's own app: TeamLink cannot see whether it was sent">Not confirmed</span></>}</div>
          <ActNote note={a.note} style={{ fontSize: 12.5, color: 'var(--ink-soft)' }} />
          {a.deliveryDetail && a.deliveryStatus === 'Failed' && <div style={{ fontSize: 12.5, color: 'var(--red)' }}>{a.deliveryDetail}</div>}
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
  const [priority, setPriority] = useState('Medium');
  const [before, setBefore] = useState(String(me.lists.defaultRemindBefore));
  const [inApp, setInApp] = useState(true);
  const [wa, setWa] = useState(false);
  const [sms, setSms] = useState(false);
  const [repeat, setRepeat] = useState({ rule: '', until: '' });
  const [doing, setDoing] = useState(null);
  const [busy, setBusy] = useState(false);
  const today = istToday();
  async function add() {
    setBusy(true);
    try { await api.post('/crm/tasks', { title, dueDate: due, dueTime: time || undefined, type, priority, remindBefore: Number(before), notifyApp: inApp, notifyWhatsapp: wa, notifySms: sms, repeat: repeat.rule || undefined, repeatUntil: repeat.until || undefined, ...link }); setTitle(''); setTime(''); setRepeat({ rule: '', until: '' }); toast('Follow-up added.'); onChanged(); } catch (e) { toast(errOf(e, 'The follow-up could not be added.')); } finally { setBusy(false); }
  }
  return (
    <div>
      {link && canEdit && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
            <select value={type} onChange={(e) => setType(e.target.value)} style={{ width: 110 }} aria-label="Type">{me.lists.taskTypes.map((x) => <option key={x}>{x}</option>)}</select>
            <select value={priority} onChange={(e) => setPriority(e.target.value)} style={{ width: 105 }} aria-label="Priority">{me.lists.priorities.map((x) => <option key={x} value={x}>{x} priority</option>)}</select>
            <input type="text" placeholder="New follow-up" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: '1 1 160px' }} />
            <DateField value={due} min={today} onChange={setDue} style={{ width: 150 }} aria-label="Due date" />
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ width: 110 }} aria-label="Due time" />
            <button type="button" className="btn btn-sm" disabled={busy || !title.trim() || !due} onClick={add}>Add</button>
          </div>
          <div className="small-muted" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
            <span>Remind:</span>
            <select value={before} onChange={(e) => setBefore(e.target.value)} style={{ width: 150 }} aria-label="Remind before">{Object.entries(REMIND_WORDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            <label><input type="checkbox" checked={inApp} onChange={(e) => setInApp(e.target.checked)} style={{ width: 'auto' }} /> In app</label>
            <label><input type="checkbox" checked={wa} onChange={(e) => setWa(e.target.checked)} style={{ width: 'auto' }} /> WhatsApp</label>
            <label><input type="checkbox" checked={sms} onChange={(e) => setSms(e.target.checked)} style={{ width: 'auto' }} /> SMS</label>
            <RepeatPicker value={repeat.rule} until={repeat.until} onChange={(rule, until) => setRepeat({ rule, until })} />
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
              <div style={{ fontSize: 13 }}>
                <span style={{ textDecoration: t.status === 'Done' ? 'line-through' : undefined }}>{t.title}</span>
                {t.type && t.type !== 'Call' && <span className="small-muted"> · {t.type}</span>}
                {t.status === 'Open' && (t.priority === 'High' || t.priority === 'Low') && <> <PriorityPill v={t.priority} /></>}
                {t.status === 'Open' && t.type === 'Meeting' && canEdit && <> <InviteButton task={t} record={link ? { kind: Object.keys(link)[0].replace('Id', ''), id: Object.values(link)[0], name: '' } : recordOfTask(t)} /> <VideoButton task={t} onChanged={onChanged} /></>}
                <RepeatLine task={t} canEdit={canEdit} onChanged={onChanged} />
              </div>
              <div className="small-muted" style={{ fontSize: 11.5 }}>
                <span style={{ color: late ? 'var(--red)' : undefined, fontWeight: late ? 600 : undefined }}>{t.dueDate === today ? 'Today' : dateOf(t.dueDate)}{t.dueTime ? ` ${t.dueTime}` : ''}{late ? ` · ${daysLate(t.dueDate)} day${daysLate(t.dueDate) === 1 ? '' : 's'} late` : ''}</span>
                {showRecord && t.recordName && <> · <RecLink kind={t.recordKind} id={t.recordId}>{t.recordName}</RecLink></>}
                {t.ownerName && showRecord ? ` · ${t.ownerName}` : ''}
              </div>
              {t.status === 'Done' && (t.outcome || t.doneNote) && <div className="small-muted" style={{ fontSize: 11.5 }}>{[t.outcome, t.doneNote].filter(Boolean).join(' · ')}</div>}
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
          <div className="field"><label>Expected close</label><DateField value={f.expectedClose} onChange={(v) => set("expectedClose", v)} aria-label="Expected close" /></div>
        </div>
      )}
      {err && <div className="small-muted" role="alert" style={{ color: 'var(--red)' }}>{err}</div>}
    </Modal>
  );
}

// ---- invoices (the CRM's own - founder 2026-11-13: Won -> invoice; never the ATS Accounts invoices) ------------
export const INVOICE_STATUSES = ['Draft', 'Sent', 'Partly paid', 'Paid', 'Cancelled'];
export const invoicePill = (inv) => (inv.overdue ? 'Overdue' : inv.status);
export function InvoiceStatusSelect({ inv, onSaved }) {
  const { toast } = useCrm();
  const [busy, setBusy] = useState(false);
  async function set(status) {
    let paidAmount;
    if (status === 'Partly paid') {
      const v = window.prompt(`How much has been received so far? (the total is ${money(inv.total)})`, String(inv.paidAmount || ''));
      if (v == null) return;
      paidAmount = Number(String(v).replace(/[^\d.]/g, ''));
      if (!(paidAmount > 0)) { toast('Write the amount received.'); return; }
    }
    setBusy(true);
    try { const r = await api.post(`/crm/invoices/${inv.id}/status`, { status, paidAmount }); toast(`${inv.code} is ${status.toLowerCase()}.`); onSaved(r.data.invoice); } catch (e) { toast(errOf(e, 'The invoice could not be changed.')); } finally { setBusy(false); }
  }
  return (
    <select value={inv.status} disabled={busy} onChange={(e) => set(e.target.value)} onClick={(e) => e.stopPropagation()} aria-label={`Status of ${inv.code}`} style={{ width: 'auto', padding: '2px 6px', fontSize: 13 }}>
      {INVOICE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
    </select>
  );
}
// The invoice on WhatsApp: TeamLink sends nothing. It makes a link to the PDF (the customer needs no login) and opens WhatsApp with the message
// and the customer's number filled in; the person presses Send. The window is opened first and filled when the link is ready (a window opened
// after a wait is blocked by the browser).
export async function shareInvoiceWhatsApp(inv, toast, after) {
  const w = window.open('', '_blank');
  try {
    const r = await api.post(`/crm/invoices/${inv.id}/share`);
    if (w) w.location.href = r.data.waUrl; else window.open(r.data.waUrl, '_blank');
    toast(r.data.number ? `WhatsApp is open for +${r.data.number}. Press Send there.` : 'This customer has no number on the account: choose the chat in WhatsApp, the message is ready.');
    if (inv.status === 'Draft' && window.confirm(`Mark ${inv.code} as Sent?\n\n(It is a Draft until you do; only sent invoices count as Invoiced.)`)) {
      await api.post(`/crm/invoices/${inv.id}/status`, { status: 'Sent' });
      if (after) after();
    }
  } catch (e) {
    if (w) w.close();
    toast(errOf(e, 'The WhatsApp message could not be made.'));
  }
}
// THE INVOICE BY EMAIL (founder 2026-11-16): a small window with the customer's address, subject and words ready; Send email sends it with the PDF attached.
// (2026-11-17) CC, a plain "email is not set up" when it is not, and a Draft becomes Sent by the send itself.
export function InvoiceEmailDialog({ inv, onClose, onSent }) {
  const { toast } = useCrm();
  const [f, setF] = useState(null);
  const [ready, setReady] = useState({ ok: true, reason: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get(`/crm/invoices/${inv.id}/email-draft`).then((r) => { setF({ to: r.data.to || '', cc: r.data.cc || '', subject: r.data.subject, text: r.data.text }); setReady({ ok: r.data.mailReady !== false, reason: r.data.mailReason || '' }); }).catch((e) => setErr(errOf(e, 'The email could not be made.')));
  }, [inv.id]);
  async function send() {
    setBusy(true); setErr('');
    try {
      const r = await api.post(`/crm/invoices/${inv.id}/email`, f);
      toast(`${inv.code || 'The invoice'} emailed to ${f.to}${r.data.cc && r.data.cc.length ? ` (cc ${r.data.cc.join(', ')})` : ''} with the PDF attached.${inv.status === 'Draft' && r.data.status === 'Sent' ? ' It is marked Sent.' : ''}`);
      if (onSent) onSent();
      onClose();
    } catch (e) { setErr(errOf(e, 'It could not be sent.')); setBusy(false); }
  }
  return (
    <Modal title={`Send ${inv.code || 'invoice'} by email`} onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Close</button><button type="button" className="btn btn-primary" disabled={busy || !f || !ready.ok} onClick={send}>{busy ? 'Sending…' : 'Send email'}</button></>}>
      {!f && !err && <p className="small-muted">Getting the email ready…</p>}
      {f && !ready.ok && <div className="notice" role="alert" style={{ marginBottom: 10 }}><b>Email is not set up yet</b>, so it cannot be sent from here. An Admin connects it in Administration → Integrations → Email.{ready.reason ? ` (${ready.reason})` : ''} You can download the PDF and send it yourself.</div>}
      {f && (
        <>
          <div className="field"><label>To</label><input type="email" value={f.to} placeholder="customer@company.com" onChange={(e) => setF({ ...f, to: e.target.value })} aria-label="To" /></div>
          <div className="field"><label>CC <span className="small-muted">optional, commas between addresses</span></label><input type="text" value={f.cc} placeholder="accounts@company.com" onChange={(e) => setF({ ...f, cc: e.target.value })} aria-label="CC" /></div>
          <div className="field"><label>Subject</label><input type="text" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} aria-label="Subject" /></div>
          <div className="field"><label>Message</label><textarea rows={8} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} aria-label="Message" /></div>
          <div className="small-muted" style={{ fontSize: 12.5 }}>📎 The invoice PDF ({inv.code}) goes with the email. It is sent from your own name through the company mailbox; replies come to you.{inv.status === 'Draft' ? ' The Draft becomes Sent once the email goes, and cannot be edited after that.' : ''}</div>
        </>
      )}
      {err && <div className="notice" style={{ marginTop: 10 }} role="alert">{err}</div>}
    </Modal>
  );
}
// A DRAFT invoice is edited here (2026-11-17): its lines (description, SAC, qty, rate), notes and due date; the totals follow. Once Sent it is read-only.
export function InvoiceEditDialog({ inv, onClose, onSaved }) {
  const { toast } = useCrm();
  const [lines, setLines] = useState(() => (inv.lines || []).map((l) => ({ description: l.description || '', sac: l.sac || '', qty: String(l.qty ?? 1), rate: String(l.rate ?? '') })));
  const [notes, setNotes] = useState(inv.notes || '');
  const [dueDate, setDueDate] = useState(inv.dueDate || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const n = (v) => Number(String(v).replace(/[, ]/g, '')) || 0;
  const amount = Math.round(lines.reduce((a, l) => a + Math.round(n(l.qty) * n(l.rate) * 100) / 100, 0) * 100) / 100;
  const tax = Math.round(amount * ((Number(inv.taxPercent) || 0) / 100) * 100) / 100;
  const setLine = (i, k, v) => setLines((x) => x.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  async function save() {
    setBusy(true); setErr('');
    try {
      const r = await api.put(`/crm/invoices/${inv.id}`, { lines, notes, dueDate });
      toast(`${inv.code} saved: ${money(r.data.invoice.total)} with tax.`);
      onSaved(r.data.invoice);
    } catch (e) { setErr(errOf(e, 'The invoice could not be saved.')); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Edit ${inv.code} (Draft)`} size="wide" onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <div className="small-muted" style={{ marginBottom: 8 }}>While it is a Draft you can change the lines, notes and due date. The customer&#39;s GSTIN, address and state are copied again from the account when you save.</div>
      <div className="crm-inv-lines">
        <div className="crm-inv-line crm-inv-head small-muted"><span>Description</span><span>SAC</span><span>Qty</span><span>Rate ₹</span><span style={{ textAlign: 'right' }}>Amount</span><span /></div>
        {lines.map((l, i) => (
          <div key={i} className="crm-inv-line">{/* eslint-disable-line react/no-array-index-key */}
            <input type="text" value={l.description} maxLength={300} onChange={(e) => setLine(i, 'description', e.target.value)} aria-label={`Line ${i + 1} description`} />
            <input type="text" inputMode="numeric" value={l.sac} maxLength={8} onChange={(e) => setLine(i, 'sac', e.target.value.replace(/\D/g, ''))} aria-label={`Line ${i + 1} SAC`} />
            <input type="text" inputMode="decimal" value={l.qty} onChange={(e) => setLine(i, 'qty', e.target.value)} aria-label={`Line ${i + 1} quantity`} />
            <input type="text" inputMode="decimal" value={l.rate} onChange={(e) => setLine(i, 'rate', e.target.value)} aria-label={`Line ${i + 1} rate`} />
            <span style={{ textAlign: 'right', fontWeight: 600 }}>{money(Math.round(n(l.qty) * n(l.rate) * 100) / 100)}</span>
            <button type="button" className="btn btn-sm" disabled={lines.length === 1} onClick={() => setLines((x) => x.filter((_, j) => j !== i))} aria-label={`Remove line ${i + 1}`}>×</button>
          </div>
        ))}
      </div>
      <button type="button" className="btn btn-sm" style={{ margin: '6px 0 10px' }} disabled={lines.length >= 30} onClick={() => setLines((x) => [...x, { description: '', sac: (x[0] && x[0].sac) || '', qty: '1', rate: '' }])}>+ Line</button>
      <div className="small-muted" style={{ marginBottom: 10 }}>Taxable {money(amount)} · GST {inv.taxPercent}% {money(tax)} · <b>Total {money(amount + tax)}</b></div>
      <div className="grid-2">
        <div className="field"><label>Due date</label><DateField value={dueDate} onChange={setDueDate} min={inv.issueDate} style={{ width: 170 }} aria-label="Due date" /></div>
        <div className="field"><label>Notes on the invoice <span className="small-muted">optional</span></label><textarea rows={2} value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} aria-label="Notes" /></div>
      </div>
      {err && <div className="small-muted" role="alert" style={{ color: 'var(--red)' }}>{err}</div>}
    </Modal>
  );
}
// The GST lines of an invoice: CGST + SGST (same state) or IGST, the SAC, both GSTINs and the place of supply, and a warning when the state is not known.
export function GstBlock({ inv }) {
  const g = inv.gst || {};
  const pct = (v) => `${Math.round((Number(v) || 0) * 1000) / 1000}%`;
  return (
    <div style={{ marginTop: 8, fontSize: 12.5 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
        <div><div className="small-muted" style={{ fontSize: 11 }}>Taxable{inv.discountPercent ? ` (after ${inv.discountPercent}% off)` : ''}</div><b>{money(inv.amount)}</b></div>
        {g.mode === 'intra' && <><div><div className="small-muted" style={{ fontSize: 11 }}>CGST {pct(g.halfRate)}</div><b>{money(g.cgst)}</b></div><div><div className="small-muted" style={{ fontSize: 11 }}>SGST {pct(g.halfRate)}</div><b>{money(g.sgst)}</b></div></>}
        {g.mode === 'inter' && <div><div className="small-muted" style={{ fontSize: 11 }}>IGST {pct(g.rate)}</div><b>{money(g.igst)}</b></div>}
        {(!g.mode || g.mode === 'none') && <div><div className="small-muted" style={{ fontSize: 11 }}>Tax {inv.taxPercent}%</div><b>{money(inv.taxAmount)}</b></div>}
        <div><div className="small-muted" style={{ fontSize: 11 }}>Total</div><b>{money(inv.total)}</b></div>
      </div>
      <div className="small-muted" style={{ fontSize: 11.5, marginTop: 6, overflowWrap: 'anywhere' }}>
        SAC {g.sac || '—'} · place of supply {g.placeOfSupply ? `${g.placeOfSupply.name} (${g.placeOfSupply.code})` : 'not known'} · our GSTIN {g.ourGstin || 'not set'} · customer GSTIN {g.customerGstin || 'none'}
      </div>
      {g.flag && <div className="small-muted" role="status" style={{ fontSize: 12, marginTop: 4, color: 'var(--amber, #b45309)' }}>⚠ {g.flag}</div>}
    </div>
  );
}
export const openInvoicePdf = (inv, toast) => download(`/crm/invoices/${inv.id}/pdf`, `${inv.code || 'invoice'}.pdf`, { open: true }).catch(() => toast('The PDF could not be opened.'));
// ---- the PAYMENT LOG of an invoice (founder 2026-11-14: every amount received is a line - date, amount, mode; Partly paid / Paid follow from it) ----
export const PAYMENT_MODES = ['Bank transfer', 'UPI', 'Cheque', 'Cash', 'Card', 'Other'];
// what is still to come on an invoice: total - cash received - TDS the customer deducted
export const balanceOf = (inv) => (inv.balance != null ? inv.balance : Math.max(0, Math.round((inv.total - inv.paidAmount - (inv.tdsAmount || 0)) * 100) / 100));
function PaymentDialog({ inv, onClose, onSaved }) {
  const { toast } = useCrm();
  const left = balanceOf(inv);
  const [amount, setAmount] = useState(String(left));
  const [paidOn, setPaidOn] = useState(istToday());
  const [mode, setMode] = useState('Bank transfer');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  // TDS the customer deducted on this line (2026-11-17): none, rupees, or a % of the value before GST of what the line settles
  const [tdsWay, setTdsWay] = useState('none');
  const [tdsValue, setTdsValue] = useState('');
  const [tdsRef, setTdsRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const num = (v) => Number(String(v).replace(/[, ]/g, ''));
  const cash = num(amount) || 0;
  const tds = (() => {
    if (tdsWay === 'amount') return Math.round((num(tdsValue) || 0) * 100) / 100;
    if (tdsWay === 'percent') { const k = ((num(tdsValue) || 0) / 100) * (inv.total ? inv.amount / inv.total : 1); return k > 0 && k < 1 ? Math.round(((k * cash) / (1 - k)) * 100) / 100 : 0; }
    return 0;
  })();
  async function save() {
    const n = String(amount).trim() === '' ? 0 : num(amount);
    if (!Number.isFinite(n) || n < 0) { setErr('Write the amount received.'); return; }
    if (!(n > 0) && !(tds > 0)) { setErr('Write the amount received.'); return; }
    if (tdsWay !== 'none' && !(tds > 0)) { setErr(tdsWay === 'percent' ? 'Write the TDS % (more than 0).' : 'Write the TDS in rupees.'); return; }
    if (n + tds > left + 0.005) { setErr(`Only ${money(left)} is left on this invoice${tds > 0 ? `; this line settles ${money(n + tds)} (received + TDS)` : ''}.`); return; }
    if (!paidOn) { setErr('Write the date the money came.'); return; }
    if (paidOn > istToday()) { setErr('The payment date cannot be in the future.'); return; }
    setBusy(true); setErr('');
    try {
      const body = { amount: n, paidOn, mode, reference, note, tdsRef };
      if (tdsWay === 'amount') body.tdsAmount = tds; else if (tdsWay === 'percent') body.tdsPercent = num(tdsValue);
      const r = await api.post(`/crm/invoices/${inv.id}/payments`, body);
      toast(r.data.invoice.status === 'Paid' ? `${inv.code} is settled in full.` : `${money(n)} recorded${tds > 0 ? ` with ${money(tds)} TDS` : ''}. ${money(r.data.invoice.balance)} is left.`);
      onSaved(r.data.invoice);
    } catch (e) { setErr(errOf(e, 'The payment could not be saved.')); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Record a payment · ${inv.code}`} onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save payment'}</button></>}>
      <div className="small-muted" style={{ marginBottom: 8 }}>Total {money(inv.total)} · received so far {money(inv.paidAmount)}{inv.tdsAmount > 0 ? ` · TDS ${money(inv.tdsAmount)}` : ''} · left {money(left)}</div>
      <div className="field"><label>Amount received (cash in the bank)</label><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount received" /></div>
      <div className="field"><label>TDS deducted by the customer</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {[['none', 'No TDS'], ['amount', '₹ amount'], ['percent', '% rate']].map(([k, l]) => <button key={k} type="button" className={`btn btn-sm${tdsWay === k ? ' btn-primary' : ''}`} onClick={() => setTdsWay(k)}>{l}</button>)}
          {tdsWay !== 'none' && <input inputMode="decimal" value={tdsValue} onChange={(e) => setTdsValue(e.target.value)} placeholder={tdsWay === 'percent' ? 'e.g. 10' : 'e.g. 10000'} style={{ width: 120 }} aria-label={tdsWay === 'percent' ? 'TDS percent' : 'TDS amount'} />}
          {tdsWay !== 'none' && <span className="small-muted" style={{ fontSize: 12.5 }}>TDS {money(tds)} · this line settles {money(cash + tds)}</span>}
        </div>
        {tdsWay === 'percent' && <div className="small-muted" style={{ fontSize: 11.5, marginTop: 4 }}>The % is taken on the value before GST of what this line settles (10% on ₹1,00,000 + GST paid as ₹1,08,000 → TDS ₹10,000).</div>}
      </div>
      {tdsWay !== 'none' && <div className="field"><label>TDS certificate / reference <span className="small-muted">optional (Form 16A no., challan)</span></label><input value={tdsRef} maxLength={80} onChange={(e) => setTdsRef(e.target.value)} aria-label="TDS certificate or reference" /></div>}
      <div className="field"><label>Date the money came</label><DateField value={paidOn} onChange={setPaidOn} style={{ width: 160 }} aria-label="Payment date" /></div>
      <div className="field"><label>How it came</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{PAYMENT_MODES.map((m) => <button key={m} type="button" className={`btn btn-sm${mode === m ? ' btn-primary' : ''}`} onClick={() => setMode(m)}>{m}</button>)}</div>
      </div>
      <div className="field"><label>Reference (UTR / cheque no.) <span className="small-muted">optional</span></label><input value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} aria-label="Payment reference" /></div>
      <div className="field"><label>Note <span className="small-muted">optional</span></label><input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} aria-label="Payment note" /></div>
      {err && <div className="small-muted" role="alert" style={{ color: 'var(--red)' }}>{err}</div>}
    </Modal>
  );
}
export function PaymentLog({ inv, canEdit, onChanged }) {
  const { toast } = useCrm();
  const [adding, setAdding] = useState(false);
  const pays = inv.payments || [];
  const left = balanceOf(inv);
  async function remove(p) {
    if (!window.confirm(`Remove the payment of ${money(p.amount)}${p.tdsAmount > 0 ? ` (+ ${money(p.tdsAmount)} TDS)` : ''} on ${dateOf(p.paidOn)}? The invoice goes back to what is left to pay.`)) return;
    try { await api.delete(`/crm/invoices/${inv.id}/payments/${p.id}`); toast('Payment removed.'); onChanged(); } catch (e) { toast(errOf(e, 'The payment could not be removed.')); }
  }
  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--line, #e5e7eb)', paddingTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div className="section-label" style={{ margin: 0 }}>Payments</div>
        <span className="small-muted" style={{ fontSize: 12 }}>{money(inv.paidAmount)} of {money(inv.netTotal != null ? inv.netTotal : inv.total)} received{inv.tdsAmount > 0 ? ` · ${money(inv.tdsAmount)} TDS deducted` : ''}{left > 0 && inv.status !== 'Cancelled' ? ` · ${money(left)} left` : ''}</span>
        {canEdit && left > 0 && inv.status !== 'Cancelled' && <button type="button" className="btn btn-sm btn-primary" style={{ marginLeft: 'auto' }} onClick={() => setAdding(true)}>+ Record payment</button>}
      </div>
      {!pays.length && <div className="small-muted" style={{ fontSize: 12.5, marginTop: 6 }}>No payment recorded yet.</div>}
      {pays.length > 0 && (
        <div style={{ marginTop: 6 }}>
          {pays.map((p) => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderTop: '1px solid var(--line, #eef0f4)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}><b style={{ fontSize: 14 }}>{money(p.amount)}</b><span>{p.mode || '—'}</span><span className="small-muted">{dateOf(p.paidOn)}</span>{p.tdsAmount > 0 && <span className="small-muted" style={{ fontSize: 12 }}>+ TDS {money(p.tdsAmount)}{p.tdsPercent ? ` (${p.tdsPercent}%)` : ''}{p.tdsRef ? ` · ${p.tdsRef}` : ''}</span>}</div>
                {([p.reference, p.note].some(Boolean) || p.byName) && <div className="small-muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{[p.reference, p.note].filter(Boolean).join(' · ')}{p.byName ? `${[p.reference, p.note].some(Boolean) ? ' · ' : ''}by ${p.byName}` : ''}</div>}
              </div>
              <ReceiptButtons inv={inv} pay={p} canEdit={canEdit} />
              {canEdit && <button type="button" className="btn btn-sm" aria-label={`Remove the payment of ${money(p.amount)}`} onClick={() => remove(p)}>Remove</button>}
            </div>
          ))}
        </div>
      )}
      {adding && <PaymentDialog inv={inv} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); onChanged(); }} />}
    </div>
  );
}
function InvoiceBox({ deal, onChanged }) {
  const { toast, me } = useCrm();
  const [mailing, setMailing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get('/crm/invoices', { params: { dealId: deal.id } }).then((r) => setList(r.data.invoices)).catch(() => setList([]));
  useEffect(() => { load(); }, [deal.id, deal.stage]); // eslint-disable-line react-hooks/exhaustive-deps
  async function raise() {
    setBusy(true);
    try { const r = await api.post(`/crm/deals/${deal.id}/invoice`); toast(`Invoice ${r.data.invoice.code} is ready.`); load(); if (onChanged) onChanged(); } catch (e) { toast(errOf(e, 'The invoice could not be made.')); } finally { setBusy(false); }
  }
  if (!list) return null;
  const inv = list[0];
  return (
    <div className="card" style={{ padding: 12, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <div className="section-label" style={{ margin: 0 }}>Invoice</div>
        {!inv && deal.stage === 'Won' && me.canEdit && <button type="button" className="btn btn-sm btn-primary" style={{ marginLeft: 'auto' }} disabled={busy} onClick={raise}>{busy ? 'Making…' : 'Create invoice'}</button>}
      </div>
      {!inv && <div className="small-muted">{deal.stage === 'Won' ? 'No invoice yet. Create it: it is made from the deal value after the discount, with tax.' : 'An invoice is made automatically when this deal is Won.'}</div>}
      {inv && (
        <div style={{ fontSize: 13 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <b>{inv.code}</b> <Pill v={invoicePill(inv)} />
            <span className="small-muted" style={{ fontSize: 11.5, color: inv.overdue ? 'var(--red)' : undefined }}>issued {dateOf(inv.issueDate)}{inv.dueDate ? ` · due ${dateOf(inv.dueDate)}` : ''}{inv.overdue ? ' · overdue' : ''}</span>
            <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-sm" onClick={() => openInvoicePdf(inv, toast)}>PDF</button>
              {me.canEdit && inv.status === 'Draft' && <button type="button" className="btn btn-sm" title="Change the lines, notes and due date while it is a Draft" onClick={() => setEditing(true)}>✏️ Edit</button>}
              {me.canEdit && inv.status !== 'Cancelled' && <button type="button" className="btn btn-sm" title="Emails the invoice with the PDF attached" onClick={() => setMailing(true)}>✉️ Send by email</button>}
              {me.canEdit && inv.status !== 'Cancelled' && <button type="button" className="btn btn-sm" title="Opens WhatsApp with the message and a link to the invoice; you press Send" onClick={() => shareInvoiceWhatsApp(inv, toast, () => { load(); if (onChanged) onChanged(); })}>💬 WhatsApp</button>}
              {me.canEdit && <InvoiceStatusSelect inv={inv} onSaved={() => { load(); if (onChanged) onChanged(); }} />}
            </span>
          </div>
          {(inv.lines || []).length > 0 && (
            <div style={{ marginTop: 8 }}>
              {inv.lines.map((l, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, fontSize: 12.5, padding: '3px 0', borderBottom: '1px solid var(--line-soft, #eef0f4)' }}>{/* eslint-disable-line react/no-array-index-key */}
                  <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{l.description}</span>
                  <span className="small-muted">SAC {l.sac || '—'}</span>
                  <span className="small-muted">{l.qty} × {money(l.rate)}</span>
                  <b>{money(l.amount)}</b>
                </div>
              ))}
            </div>
          )}
          <GstBlock inv={inv} />
          <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
            {(inv.creditAmount > 0 || inv.debitAmount > 0) && <div><div className="small-muted" style={{ fontSize: 11 }}>After credit / debit notes</div><b>{money(inv.netTotal)}</b></div>}
            <div><div className="small-muted" style={{ fontSize: 11 }}>Received</div><b>{money(inv.paidAmount)}</b></div>
            {inv.tdsAmount > 0 && <div><div className="small-muted" style={{ fontSize: 11 }}>TDS deducted</div><b>{money(inv.tdsAmount)}</b></div>}
            <div><div className="small-muted" style={{ fontSize: 11 }}>Balance</div><b style={{ color: inv.overdue ? 'var(--red)' : undefined }}>{money(balanceOf(inv))}</b></div>
          </div>
          {inv.status !== 'Draft' && <div className="small-muted" style={{ fontSize: 11.5, marginTop: 4 }}>🔒 Sent to the customer: the invoice itself can no longer be edited.</div>}
          <PaymentLog inv={inv} canEdit={me.canEdit} onChanged={() => { load(); if (onChanged) onChanged(); }} />
          <NotesBox inv={inv} onChanged={() => { load(); if (onChanged) onChanged(); }} />
          <RepeatBox inv={inv} onChanged={() => { load(); if (onChanged) onChanged(); }} />
          <PayBox inv={inv} />
        </div>
      )}
      {mailing && inv && <InvoiceEmailDialog inv={inv} onClose={() => setMailing(false)} onSent={() => { load(); if (onChanged) onChanged(); }} />}
      {editing && inv && <InvoiceEditDialog inv={inv} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); if (onChanged) onChanged(); }} />}
    </div>
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
      toast(stage === 'Won' ? (r.data.invoice ? `🎉 Won! Invoice ${r.data.invoice.code} is ready.` : '🎉 Won!') : stage === 'Lost' && r.data.recheck ? `Marked lost. A follow-up to look at it again is set for ${dateOf(r.data.recheck.dueDate)}.` : `Moved to ${stage}.`);
      // the customer's GSTIN / address are copied onto the invoice when it is made: say so now, while it can still be put right on the account
      if (stage === 'Won' && r.data.invoice && r.data.invoice.missing && r.data.invoice.missing.length) setTimeout(() => toast(`Heads up: this customer has no ${r.data.invoice.missing.join(' and ')} on its account, so the invoice shows it blank. Add it on the account before sending the invoice.`), 700);
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

// ---- files kept on a deal: the quotation the customer was sent, their PO (2026-11-17; PDF / Word / Excel / picture, at most 10 MB) ------------------
const FILE_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.csv,.png,.jpg,.jpeg,.webp';
const sizeOf = (b) => (b >= 1024 * 1024 ? `${(b / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
function DealFiles({ dealId, onChanged }) {
  const { toast } = useCrm();
  const [d, setD] = useState(null);
  const [kind, setKind] = useState('Quotation');
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const load = () => api.get(`/crm/deals/${dealId}/files`).then((r) => setD(r.data)).catch(() => setD({ files: [], canEdit: false }));
  useEffect(() => { load(); }, [dealId]); // eslint-disable-line react-hooks/exhaustive-deps
  async function upload(file) {
    if (!file) return;
    const max = (d && d.maxBytes) || 10 * 1024 * 1024;
    if (file.size > max) { toast(`That file is ${sizeOf(file.size)}; at most 10 MB can be kept on a deal.`); return; }
    const fd = new FormData(); fd.append('kind', kind); fd.append('file', file, file.name);
    setBusy(true);
    try { await api.post(`/crm/deals/${dealId}/files`, fd); toast(`${file.name} is kept on the deal.`); load(); if (onChanged) onChanged(); } catch (e) { toast(errOf(e, 'The file could not be uploaded.')); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  async function remove(f) {
    if (!window.confirm(`Delete ${f.name} from this deal?`)) return;
    try { await api.delete(`/crm/deal-files/${f.id}`); toast('File deleted.'); load(); if (onChanged) onChanged(); } catch (e) { toast(errOf(e, 'The file could not be deleted.')); }
  }
  if (!d) return null;
  return (
    <div className="card" style={{ padding: 12, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
        <div className="section-label" style={{ margin: 0 }}>Quotations and files ({d.files.length})</div>
        {d.canEdit && (
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="What the file is" style={{ width: 'auto', padding: '2px 6px', fontSize: 13 }}>{(d.kinds || ['Quotation', 'Purchase order', 'Other']).map((k) => <option key={k} value={k}>{k}</option>)}</select>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => input.current && input.current.click()}>{busy ? 'Uploading…' : '+ Upload'}</button>
            <input ref={input} type="file" accept={FILE_ACCEPT} style={{ display: 'none' }} onChange={(e) => upload(e.target.files && e.target.files[0])} aria-label="Choose a file" />
          </span>
        )}
      </div>
      {!d.files.length && <div className="small-muted">No file yet. Upload the quotation you sent (PDF, Word, Excel or a picture, up to 10 MB).</div>}
      {d.files.map((f) => (
        <div key={f.id} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0', borderBottom: '1px solid var(--line-soft)', fontSize: 13 }}>
          <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}><b>{f.name}</b> <span className="small-muted" style={{ fontSize: 11.5 }}>{f.kind} · {sizeOf(f.size)} · {dateOf(f.createdAt)}{f.byName ? ` · ${f.byName}` : ''}</span></span>
          <button type="button" className="btn btn-sm" onClick={() => download(`/crm/deal-files/${f.id}`, f.name).catch(() => toast('The file could not be downloaded.'))}>Download</button>
          {d.canEdit && <button type="button" className="btn btn-sm" onClick={() => remove(f)} aria-label={`Delete ${f.name}`}>Delete</button>}
        </div>
      ))}
    </div>
  );
}

// ---- THE MEETING AGENT on a record (2026-11-18): a prep brief before the meeting; after it, the raw notes become a summary,
// decisions, next steps and a follow-up mail. Nothing is saved until "Save to timeline" (a Meeting activity + the ticked follow-ups).
function MeetingAgent({ kind, id, onClose, onChanged, onEmail }) {
  const { toast } = useCrm();
  const [tab, setTab] = useState('prep');
  const [purpose, setPurpose] = useState('');
  const [prep, setPrep] = useState(null);
  const [notes, setNotes] = useState('');
  const [res, setRes] = useState(null);
  const [pick, setPick] = useState({});
  const [busy, setBusy] = useState('');
  const link = { [`${kind}Id`]: id };
  const tomorrow = new Date(Date.now() + 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);
  async function makePrep() {
    setBusy('prep'); setPrep(null);
    try { const r = await api.post(`/crm/ai/meeting-prep/${kind}/${id}`, { purpose }); setPrep(r.data); } catch (e) { toast(errOf(e, 'The AI is not available right now.')); } finally { setBusy(''); }
  }
  async function makeNotes() {
    setBusy('notes'); setRes(null);
    try {
      const r = await api.post(`/crm/ai/meeting-notes/${kind}/${id}`, { notes });
      setRes(r.data);
      setPick(Object.fromEntries((r.data.nextSteps || []).map((s, i) => [i, s.owner !== 'client'])));
    } catch (e) { toast(errOf(e, 'The AI is not available right now.')); } finally { setBusy(''); }
  }
  async function save() {
    if (!res) return;
    setBusy('save');
    try {
      const note = [res.summary, res.decisions.length ? `Decisions:\n${res.decisions.map((d) => `- ${d}`).join('\n')}` : '', res.nextSteps.length ? `Next steps:\n${res.nextSteps.map((s) => `- ${s.task}${s.due ? ` (by ${s.due})` : ''}${s.owner === 'client' ? ' [client]' : ''}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
      await api.post('/crm/activities', { kind: 'meeting', subject: 'Meeting summary (Meeting Agent)', note, ...link });
      const chosen = res.nextSteps.filter((_, i) => pick[i]);
      for (const s of chosen) { await api.post('/crm/tasks', { title: s.task, dueDate: s.due || tomorrow, ...link }); } // eslint-disable-line no-await-in-loop
      toast(chosen.length ? `Saved to the timeline with ${chosen.length} follow-up${chosen.length > 1 ? 's' : ''}.` : 'Saved to the timeline.');
      if (onChanged) onChanged();
      onClose();
    } catch (e) { toast(errOf(e, 'It could not be saved.')); } finally { setBusy(''); }
  }
  const copy = (t) => navigator.clipboard.writeText(t).then(() => toast('Copied.')).catch(() => {});
  return (
    <Modal title="🤝 Meeting Agent" size="wide" onClose={onClose} foot={tab === 'notes' && res ? <><button type="button" className="btn" onClick={onClose}>Close</button><button type="button" className="btn btn-primary" disabled={!!busy} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save to timeline'}</button></> : <button type="button" className="btn" onClick={onClose}>Close</button>}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <button type="button" className={`btn btn-sm${tab === 'prep' ? ' btn-primary' : ''}`} onClick={() => setTab('prep')}>Before the meeting: prep brief</button>
        <button type="button" className={`btn btn-sm${tab === 'notes' ? ' btn-primary' : ''}`} onClick={() => setTab('notes')}>After the meeting: notes → summary</button>
      </div>
      {tab === 'prep' && (
        <div>
          <label className="small-muted" htmlFor="ma-purpose" style={{ fontSize: 12 }}>What is this meeting for? (optional)</label>
          <div style={{ display: 'flex', gap: 6, margin: '4px 0 10px' }}>
            <input id="ma-purpose" type="text" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. first call, agreement discussion, fee negotiation" style={{ flex: 1 }} maxLength={300} />
            <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={makePrep}>{busy === 'prep' ? 'Preparing…' : 'Make prep brief'}</button>
          </div>
          {prep && (
            <div className="card" style={{ padding: 10, whiteSpace: 'pre-wrap', fontSize: 13 }}>
              <div style={{ display: 'flex', marginBottom: 4 }}><b>Prep brief</b><span className="small-muted" style={{ fontSize: 10.5, marginLeft: 8 }}>{prep.provider ? `${prep.provider}${prep.ms ? ` · ${(prep.ms / 1000).toFixed(1)}s` : ''}` : ''}</span><button type="button" className="crm-linkbtn" style={{ marginLeft: 'auto' }} onClick={() => copy(prep.text)}>Copy</button></div>
              {prep.text}
            </div>
          )}
        </div>
      )}
      {tab === 'notes' && (
        <div>
          <label className="small-muted" htmlFor="ma-notes" style={{ fontSize: 12 }}>Type or paste what was said (rough notes are fine, any language)</label>
          <textarea id="ma-notes" rows={6} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Met Ravi (HR head). Need 5 nurses by Dec 10. Ok with 8.33% fee, wants 60-day replacement. Send agreement by Friday." style={{ width: '100%', margin: '4px 0 8px' }} maxLength={6000} />
          <button type="button" className="btn btn-primary btn-sm" disabled={!!busy || notes.trim().length < 10} onClick={makeNotes}>{busy === 'notes' ? 'Reading the notes…' : 'Make summary & next steps'}</button>
          {res && (
            <div className="card" style={{ padding: 10, marginTop: 10, fontSize: 13 }}>
              <b>Summary</b><div style={{ whiteSpace: 'pre-wrap', margin: '4px 0 8px' }}>{res.summary}</div>
              {res.decisions.length > 0 && <><b>Decisions</b><ul style={{ margin: '4px 0 8px', paddingLeft: 18 }}>{res.decisions.map((d) => <li key={d}>{d}</li>)}</ul></>}
              {res.nextSteps.length > 0 && (
                <>
                  <b>Next steps</b> <span className="small-muted" style={{ fontSize: 11.5 }}>ticked ones become follow-ups</span>
                  {res.nextSteps.map((s, i) => (
                    <label key={`${s.task}-${i}`} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', padding: '3px 0' }}> {/* eslint-disable-line react/no-array-index-key */}
                      <input type="checkbox" checked={!!pick[i]} onChange={(e) => setPick((p) => ({ ...p, [i]: e.target.checked }))} />
                      <span>{s.task} <span className="small-muted">{s.due ? `by ${s.due}` : `(no date: ${tomorrow})`}{s.owner === 'client' ? ' · client' : ''}</span></span>
                    </label>
                  ))}
                </>
              )}
              {res.followUpEmail && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center' }}><b>Follow-up email</b><span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8 }}><button type="button" className="crm-linkbtn" onClick={() => copy(res.followUpEmail)}>Copy</button>{onEmail && kind !== 'account' && <button type="button" className="crm-linkbtn" onClick={() => { const m = /^subject:\s*(.+)\n+([\s\S]*)$/i.exec(res.followUpEmail.trim()); onEmail({ subject: m ? m[1].trim() : '', text: m ? m[2].trim() : res.followUpEmail }); }}>Open in email</button>}</span></div>
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, background: 'var(--line-soft)', padding: 8, borderRadius: 8, marginTop: 4 }}>{res.followUpEmail}</div>
                </div>
              )}
              {res.provider && <div className="small-muted" style={{ fontSize: 10.5, marginTop: 6 }}>{res.provider}</div>}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ---- the AI assistant on a record: health score, next best actions (rules, always), summary / email draft (the model) ------
function AiInsight({ kind, id, refresh, onChanged }) {
  const { toast } = useCrm();
  const [d, setD] = useState(null);
  const [out, setOut] = useState(null); // { title, text }
  const [compose, setCompose] = useState(null); // the AI's email draft, open in the mail window with Send (CrmContact.jsx)
  const [busy, setBusy] = useState('');
  const [meeting, setMeeting] = useState(false);
  useEffect(() => { if (!['lead', 'deal', 'account'].includes(kind)) return; api.get(`/crm/ai/insight/${kind}/${id}`).then((r) => setD(r.data)).catch(() => setD(null)); }, [kind, id, refresh]);
  async function ask(what) {
    setBusy(what); setOut(null);
    try {
      const r = await api.post(`/crm/ai/${what}/${kind}/${id}`, {});
      if (what === 'draft') {
        const t = String(r.data.text || '').trim();
        const m = /^subject:\s*(.+)\n+([\s\S]*)$/i.exec(t);
        setCompose({ subject: m ? m[1].trim() : '', text: m ? m[2].trim() : t });
      } else setOut({ title: 'AI summary', text: r.data.text });
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
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-sm" onClick={() => setMeeting(true)}>🤝 Meeting Agent</button>
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
      <AiPredict kind={kind} id={id} refresh={refresh} />
      <MoodChip kind={kind} id={id} refresh={refresh} />
      {meeting && <MeetingAgent kind={kind} id={id} onClose={() => setMeeting(false)} onChanged={onChanged} onEmail={(draft) => { setMeeting(false); setCompose(draft); }} />}
      {compose && <CrmContactDialog record={{ kind, id }} channel="Email" initialDraft={compose} onClose={() => setCompose(null)} onDone={onChanged} />}
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
  const SUGGEST = ['Which deals need my attention this week?', 'Which follow-ups are late?', 'What meetings and follow-ups do I have coming up?', 'How far am I from my target this month?', 'Which leads should I call today?'];
  // THE CRM AGENT (2026-11-18): the conversation goes back with each question, so "and the second one?" works; answers come from the free fast AI
  async function send(text) {
    const question = (text || q).trim();
    if (!question || busy) return;
    const history = chat.filter((m) => !m.err).slice(-8).map((m) => ({ role: m.who === 'me' ? 'user' : 'assistant', content: m.text }));
    setChat((c) => [...c, { who: 'me', text: question }]); setQ(''); setBusy(true);
    try { const r = await api.post('/crm/ai/ask', { question, history }); setChat((c) => [...c, { who: 'ai', text: r.data.text, tag: r.data.provider ? `${r.data.provider}${r.data.ms ? ` · ${(r.data.ms / 1000).toFixed(1)}s` : ''}${r.data.note ? ` · ${r.data.note}` : ''}` : '' }]); } catch (e) { setChat((c) => [...c, { who: 'ai', text: errOf(e, 'The AI is not available right now.'), err: true }]); } finally { setBusy(false); }
  }
  return (
    <>
      <button type="button" className="crm-ask-fab" onClick={() => setOpen((o) => !o)} aria-expanded={open}>✨ CRM Agent</button>
      {open && (
        <div className="crm-ask-panel" role="dialog" aria-label="CRM Agent">
          <div className="crm-ask-head"><b>✨ CRM Agent</b><span className="small-muted" style={{ fontSize: 11.5 }}>answers from your CRM data</span>{chat.length > 0 && <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setChat([])}>New</button>}<button type="button" className="close-x" style={{ marginLeft: chat.length ? 0 : 'auto' }} onClick={() => setOpen(false)} aria-label="Close">×</button></div>
          <div className="crm-ask-body">
            {!chat.length && (
              <div>
                <div className="small-muted" style={{ marginBottom: 6 }}>Ask about your leads, deals, follow-ups and target. For example:</div>
                {SUGGEST.map((s) => <button key={s} type="button" className="btn btn-sm" style={{ display: 'block', marginBottom: 6, textAlign: 'left', width: '100%' }} onClick={() => send(s)}>{s}</button>)}
              </div>
            )}
            {chat.map((m, i) => <div key={i} className={`crm-ask-msg ${m.who}${m.err ? ' err' : ''}`}>{m.text}{m.tag && <div style={{ fontSize: 10.5, opacity: 0.55, marginTop: 4 }}>{m.tag}</div>}</div>)} {/* eslint-disable-line react/no-array-index-key */}
            {busy && <div className="crm-ask-msg ai small-muted">Thinking…</div>}
          </div>
          <div className="crm-ask-foot">
            <input type="text" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} placeholder="Ask the CRM Agent" aria-label="Question" />
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
  useLang(); // the tab names follow the app's language
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(null); // { kind, row, preset }
  const [converting, setConverting] = useState(false);
  const [merging, setMerging] = useState(false);
  const plusSetup = usePlusSetup();
  const load = () => api.get(`/crm/${kind}s/${id}`).then((r) => setD(r.data)).catch((e) => setErr(errOf(e, 'This record could not be opened.')));
  useEffect(() => { setD(null); setErr(''); load(); }, [kind, id]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = () => { load(); if (onChanged) onChanged(); };
  const { move, dialog } = useMoveDeal(changed);
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
      ? [['Territory', (plusOf(me).territories || []).length ? <TerritoryPick kind="lead" row={row} canEdit={d.canEdit} onChanged={changed} /> : null], ['Lead source', row.source], ['Stage', row.stage], ['Expected value', row.expectedValue ? `₹${Number(row.expectedValue).toLocaleString('en-IN')}` : null], ['Lost reason', row.lostReason], ['Industry', row.industry], ['Rating', row.rating && <Pill v={row.rating} />], ['Came from', [row.utmSource, row.utmMedium, row.utmCampaign].filter(Boolean).join(' / ')], ['Page', row.pageUrl]]
      : kind === 'deal'
        ? [['Account', d.account ? <RecLink kind="account" id={d.account.id}>{d.account.name}</RecLink> : '—'], ['Deal value', <b>{money(row.value)}{foreignMoney(row, plusSetup) ? <span className="small-muted" style={{ fontWeight: 500 }}> · {foreignMoney(row, plusSetup)}</span> : null}</b>],
          ...(row.discountPercent ? [['Discount', `${row.discountPercent}%`], ['Final value', <b>{money(row.finalValue)}</b>]] : []),
          ...(row.approvalStatus && row.approvalStatus !== 'None' ? [['Discount approval', <Pill v={row.approvalStatus} />]] : []),
          ['Probability', `${row.probability}%`],
          ['Expected close', dateOf(row.expectedClose)], ['Next step', row.nextStep], ...(row.stage === 'Lost' ? [['Lost because', row.lostReason]] : []),
          ...(plusOf(me).pipelines.length > 1 ? [['Pipeline', (pipelineOfDeal(me, row) || {}).name]] : []), ['Forecast', row.forecastCategory], ['Billing', row.billing && row.billing !== 'One-time' ? `${row.billing}${row.termMonths ? ` · ${row.termMonths} months` : ''}` : null]]
        : [['Territory', (plusOf(me).territories || []).length ? <TerritoryPick kind="account" row={row} canEdit={d.canEdit} onChanged={changed} /> : null], ['Industry', row.industry], ['Website', row.website], ['Source', row.source], ['GSTIN', row.gstin], ['State', row.state], ['Pincode', row.pincode], ['Address', row.address],
          ['Tags', row.tags ? row.tags.split(',').map((t) => t.trim()).filter(Boolean).map((t, i) => <Pill key={i} v={t} />) : null], ['Type', row.kind === 'Client' ? 'Customer' : 'Prospect']];
    const info = [
      ...about,
      ['Next follow-up', nextTask ? <span style={{ color: nextTask.dueDate < today ? 'var(--red)' : undefined, fontWeight: nextTask.dueDate <= today ? 600 : undefined }}>{nextTask.dueDate === today ? 'Today' : dateOf(nextTask.dueDate)} · {nextTask.title}</span> : 'None set'],
      ['Last touched', lastAct ? `${dateTimeOf(lastAct.at)}${lastAct.byName ? ` · ${lastAct.byName}` : ''}` : 'Never'],
    ].filter(([, v]) => v);
    const tabs = [['overview', 'Overview'], ['more', 'More'], ['privacy', 'Privacy'], ...(kind === 'lead' ? [['products', 'Products & demo']] : []), ...(kind === 'deal' ? [['lines', 'Products']] : []), ...(kind === 'lead' || kind === 'deal' ? [['conversation', 'Conversation']] : []), ['activities', `Activities (${(d.activities || []).length})`], ['calls', 'Calls'], ['followups', `Follow-ups (${openTasks.length})`], ...(kind === 'deal' ? [['proposals', 'Proposals'], ['invoice', 'Invoice & orders'], ['team', 'Team chat']] : [['comments', 'Comments']]), ...(kind === 'account' ? [['support', 'Support tickets']] : []), ...(kind === 'lead' ? [['consent', 'Consent']] : []), ['engage', 'Web & engagement'], ['history', 'History'], ['notes', 'Notes']];
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
              {kind !== 'account' && row.tags && row.tags.split(',').map((t) => t.trim()).filter(Boolean).map((t) => <span key={t} className="status review" style={{ fontWeight: 600 }}>#{t}</span>)}
              {d.onTeam && <span className="status pending" title="You are on this account's team: you can read it">Account team · read only</span>}
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
            <QuickContact phone={contactLine && contactLine.phone ? contactLine.phone : row.phone} email={contactLine && contactLine.email ? contactLine.email : row.email} record={d.canEdit ? { kind, id: row.id, name: row.contactName || row.name || row.company || row.title } : null} onDone={changed} />
            {d.canEdit && <button type="button" className="btn btn-sm" onClick={() => setEditing({ kind, row })}>Edit</button>}
            {d.canEdit && <FillFromText kind={kind} id={row.id} onApplied={changed} />}
            {d.canEdit && <VisitButton kind={kind} id={row.id} name={name} onChanged={changed} />}
            {d.canEdit && (kind === 'lead' || kind === 'account') && (me.canAssign || (me.rights && me.rights.delete)) && <button type="button" className="btn btn-sm" title="This is the same company or person as another record: make the two one" onClick={() => setMerging(true)}>Merge…</button>}
            {kind === 'deal' && row.approvalStatus === 'Pending' && me.canAssign && (
              <>
                <button type="button" className="btn btn-primary btn-sm" title={`Approve the ${row.discountPercent || 0}% discount`} onClick={() => decideDiscount('approve')}>Approve discount</button>
                <button type="button" className="btn btn-sm" onClick={() => decideDiscount('reject')}>Reject</button>
              </>
            )}
            {kind === 'lead' && (
              <span className="crm-stage-auto" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title="The stage moves on its own: Contacted when you call, message or mail the lead, Qualified after a meeting or details sent, Lost when it is not interested.">
                <Pill v={row.stage || row.status} /><span className="small-muted" style={{ fontSize: 11 }}>moves on its own</span>
              </span>
            )}
            {d.canEdit && kind === 'lead' && row.status !== 'Converted' && (row.stage === 'Lost') && (
              <button type="button" className="btn btn-sm" title={row.lostReason ? `Lost: ${row.lostReason}` : 'Put this lead back to work'} onClick={() => api.post(`/crm/leads/${row.id}/reopen`).then(() => { toast('The lead is back to work.'); changed(); }).catch((e) => toast(errOf(e, 'The lead could not be reopened.')))}>Reopen</button>
            )}
            {d.canEdit && kind === 'lead' && row.status !== 'Converted' && <button type="button" className="btn btn-sm" title="Stop or start the automatic mails, SMS, WhatsApp and calls to this lead" onClick={() => api.post(`/crm/leads/${row.id}/auto`, { paused: !row.autoPaused }).then(() => { toast(row.autoPaused ? 'Automatic follow-through is on for this lead.' : 'Automatic follow-through stopped for this lead.'); changed(); }).catch((e) => toast(errOf(e, 'This could not be changed.')))}>{row.autoPaused ? 'Start automatic' : 'Stop automatic'}</button>}
            {d.canEdit && kind === 'lead' && row.status !== 'Converted' && <button type="button" className="btn btn-primary btn-sm" onClick={() => setConverting(true)}>Convert to deal</button>}
            {kind === 'lead' && row.status === 'Converted' && row.dealId && <button type="button" className="btn btn-sm" onClick={() => openRecord('deal', row.dealId)}>Open the deal</button>}
            {kind === 'lead' && d.canEdit && (me.canAssign || (me.rights && me.rights.delete)) && (
              <button type="button" className="btn btn-sm" style={{ color: 'var(--red)', borderColor: 'var(--red)' }} title="Delete this lead with its own activities and follow-ups"
                onClick={() => {
                  // eslint-disable-next-line no-alert
                  if (!window.confirm(`Delete the lead "${name}"?\n\nIts own activities and follow-ups go with it. ${row.status === 'Converted' ? 'The account and the deal made from it stay.' : ''}\nThis cannot be undone.`)) return;
                  api.delete(`/crm/lead/${row.id}`).then(() => { toast('Lead deleted.'); if (onChanged) onChanged(); onClose(); }).catch((e) => toast(errOf(e, 'The lead could not be deleted.')));
                }}>Delete</button>
            )}
            {d.canEdit && kind === 'account' && <button type="button" className="btn btn-sm" onClick={() => setEditing({ kind: 'contact', preset: { accountId: row.id } })}>+ Contact</button>}
            {d.canEdit && kind === 'account' && <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing({ kind: 'deal', preset: { accountId: row.id, title: `${row.name} - deal` } })}>+ Deal</button>}
          </div>
        </div>
        {kind === 'deal' && (
          <div className="crm-stages" role="group" aria-label="Deal stage">
            {stagesOfDeal(me, row).map((st) => (
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
          {tabs.map(([k, l]) => <div key={k} role="tab" tabIndex={0} aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)} onKeyDown={(e) => { if (e.key === 'Enter') setTab(k); }}>{tr(l.replace(/ \(\d+\)$/, ''))}{(/ \(\d+\)$/.exec(l) || [''])[0]}</div>)}
        </div>
        {tab === 'overview' && (
          <>
            <AiInsight kind={kind} id={row.id} refresh={d} onChanged={changed} />
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
        {tab === 'conversation' && (kind === 'lead' || kind === 'deal') && <Conversation kind={kind} id={row.id} onChanged={changed} />}
        {tab === 'calls' && <RecordCalls kind={kind} id={row.id} canEdit={d.canEdit} onChanged={changed} />}
        {tab === 'more' && <RecordMore kind={kind} id={row.id} onChanged={changed} />}
        {tab === 'privacy' && <RecordPrivacy kind={kind} id={row.id} />}
        {tab === 'products' && kind === 'lead' && <ProductSellBox lead={row} canEdit={d.canEdit} onChanged={changed} />}
        {tab === 'followups' && kind === 'lead' && <LeadSequenceBox lead={row} onChanged={changed} />}
        {tab === 'followups' && <TaskList tasks={d.tasks || []} link={link} onChanged={changed} canEdit={d.canEdit} />}
        {tab === 'proposals' && kind === 'deal' && <><QuotesPlus deal={row} onChanged={changed} /><ProposalBox dealId={row.id} onChanged={changed} /><DealFiles dealId={row.id} onChanged={changed} /></>}
        {tab === 'invoice' && kind === 'deal' && <><InvoiceBox deal={row} onChanged={changed} /><ContractsBox deal={row} canEdit={d.canEdit} /></>}
        {tab === 'lines' && kind === 'deal' && <DealProducts deal={row} onChanged={changed} />}
        {tab === 'team' && kind === 'deal' && <><DealTeam deal={row} onChanged={changed} /><Comments kind="deal" id={row.id} live title="Deal room: the team chat on this deal" /></>}
        {tab === 'comments' && kind !== 'deal' && <Comments kind={kind} id={row.id} />}
        {tab === 'consent' && kind === 'lead' && <ConsentBox kind="lead" id={row.id} onChanged={changed} />}
        {tab === 'history' && (kind === 'deal' ? <DealHistory deal={row} canEdit={d.canEdit} onChanged={changed} /> : <FieldHistory kind={kind} id={row.id} />)}
        {tab === 'support' && kind === 'account' && <TicketList accountId={row.id} compact />}
        {tab === 'engage' && <RecordEngage kind={kind} row={row} d={d} />}
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
      <Modal title={tr(kind === 'lead' ? 'Lead record' : kind === 'deal' ? 'Deal record' : 'Customer record')} size="xwide" onClose={onClose}>{body}</Modal>
      {editing && <RecordForm kind={editing.kind} row={editing.row} preset={editing.preset} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); changed(); }} />}
      {merging && row && <MergeDialog kind={kind} keep={row} onClose={() => setMerging(false)} onMerged={() => { setMerging(false); changed(); }} />}
      {converting && row && <ConvertLead lead={row} onClose={() => setConverting(false)} onDone={(out) => { setConverting(false); changed(); if (out.deal) openRecord('deal', out.deal.id); }} />}
      {dialog}
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
