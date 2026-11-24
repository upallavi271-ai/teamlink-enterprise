// /crm-portal - THE CRM CUSTOMER / PARTNER PORTAL (CRM wave B, 2026-11-24). Its own login page, like the client portal: never a staff login.
// A customer sees their company's quotes (PDF, accept / decline), invoices (PDF, what is due), support tickets (raise one, write in it) and
// the help articles. A partner registers the companies they bring and follows them. The session token is kept in this browser only
// (sessionStorage) and sent as X-CRM-Portal; the server fences every answer by the login's own company / partner (routes/crmPortal.js).
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import axios from 'axios';

const KEY = 'tl_crm_portal';
const read = () => { try { return sessionStorage.getItem(KEY) || ''; } catch { return ''; } };
const http = axios.create({ baseURL: '/api/crm-portal' });
http.interceptors.request.use((c) => { const t = read(); if (t) c.headers['X-CRM-Portal'] = t; return c; });
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const money = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const wrap = { maxWidth: 980, margin: '0 auto', padding: 16 };
const card = { background: 'var(--card, #fff)', border: '1px solid var(--line, #e3e8f0)', borderRadius: 12, padding: 14, marginBottom: 12 };

async function openPdf(path) {
  const w = window.open('', '_blank');
  try { const r = await http.get(path, { responseType: 'blob' }); const u = URL.createObjectURL(r.data); if (w) w.location = u; else window.location = u; } catch (e) { if (w) w.close(); alert('The PDF could not be opened.'); } // eslint-disable-line no-alert
}

function Login({ onIn, invite }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [type, setType] = useState('customer');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function go(e) {
    e.preventDefault(); setBusy(true); setErr('');
    try { const r = invite ? await http.post('/accept', { invite, password }) : await http.post('/login', { email, password, type }); try { sessionStorage.setItem(KEY, r.data.token); } catch { /* this visit only */ } onIn(r.data.me); } catch (x) { setErr(errOf(x, 'It did not work. Please try again.')); } finally { setBusy(false); }
  }
  return (
    <div style={{ ...wrap, maxWidth: 420, marginTop: '8vh' }}>
      <div style={card}>
        <h1 style={{ fontSize: 22, margin: '0 0 6px' }}>{invite ? 'Set your password' : 'Sign in'}</h1>
        <p className="small-muted" style={{ marginTop: 0 }}>TeamLink Consultants {invite ? 'portal: choose a password (8 or more characters with letters and a number).' : 'customer and partner portal'}</p>
        {err && <div className="notice" role="alert" style={{ color: 'var(--red)', marginBottom: 10 }}>{err}</div>}
        <form onSubmit={go}>
          {!invite && <div className="field"><label htmlFor="pt">I am a</label><select id="pt" value={type} onChange={(e) => setType(e.target.value)}><option value="customer">Customer</option><option value="partner">Partner</option></select></div>}
          {!invite && <div className="field"><label htmlFor="pe">Email</label><input id="pe" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>}
          <div className="field"><label htmlFor="pp">Password</label><input id="pp" type="password" autoComplete={invite ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
          <button type="submit" className="btn btn-primary" disabled={busy} style={{ width: '100%' }}>{busy ? 'Please wait…' : (invite ? 'Save and sign in' : 'Sign in')}</button>
        </form>
      </div>
    </div>
  );
}

function useGet(path) {
  const [d, setD] = useState(null); const [err, setErr] = useState('');
  const load = () => http.get(path).then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'This could not be read.')));
  useEffect(() => { load(); }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  return { d, err, load };
}

function Quotes() {
  const { d, err, load } = useGet('/quotes');
  async function decide(q, decision) { if (!window.confirm(decision === 'accept' ? 'Accept this proposal?' : 'Decline this proposal?')) return; try { await http.post(`/quotes/${q.id}/decision`, { decision }); load(); } catch (e) { alert(errOf(e, 'Not saved.')); } } // eslint-disable-line no-alert
  return (
    <div style={card}>
      <h2 style={{ fontSize: 17, marginTop: 0 }}>Quotes and proposals</h2>
      {err && <div className="notice">{err}</div>}
      {d && !d.quotes.length && <div className="small-muted">No proposals yet.</div>}
      {d && d.quotes.map((q) => (
        <div key={q.id} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--line-soft, #eef0f4)' }}>
          <div style={{ flex: 1, minWidth: 180 }}><b>{q.number}</b> {q.title ? `· ${q.title}` : ''}<div className="small-muted" style={{ fontSize: 12 }}>Sent {day(q.sentAt)}{q.decidedAt ? ` · ${q.status.toLowerCase()} ${day(q.decidedAt)}` : ''}</div></div>
          <span className={`status ${q.status === 'Accepted' ? 'joined' : q.status === 'Declined' ? 'rejected' : 'pending'}`}>{q.status}</span>
          <button type="button" className="btn btn-sm" onClick={() => openPdf(`/quotes/${q.id}/pdf`)}>PDF</button>
          {q.status === 'Sent' && <><button type="button" className="btn btn-sm btn-primary" onClick={() => decide(q, 'accept')}>Accept</button><button type="button" className="btn btn-sm" onClick={() => decide(q, 'decline')}>Decline</button></>}
        </div>
      ))}
    </div>
  );
}
function Invoices() {
  const { d, err } = useGet('/invoices');
  return (
    <div style={card}>
      <h2 style={{ fontSize: 17, marginTop: 0 }}>Invoices</h2>
      {err && <div className="notice">{err}</div>}
      {d && !d.invoices.length && <div className="small-muted">No invoices yet.</div>}
      {d && d.invoices.map((i) => (
        <div key={i.id} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--line-soft, #eef0f4)' }}>
          <div style={{ flex: 1, minWidth: 180 }}><b>{i.code || 'Invoice'}</b> {i.title ? `· ${i.title}` : ''}<div className="small-muted" style={{ fontSize: 12 }}>{day(i.issueDate)}{i.dueDate ? ` · due ${day(i.dueDate)}` : ''}</div></div>
          <span>{money(i.total)}</span>{i.due > 0 ? <span className="status pending">Due {money(i.due)}</span> : <span className="status joined">Paid</span>}
          <button type="button" className="btn btn-sm" onClick={() => openPdf(`/invoices/${i.id}/pdf`)}>PDF</button>
        </div>
      ))}
    </div>
  );
}
function Tickets() {
  const { d, err, load } = useGet('/tickets');
  const [f, setF] = useState(null);
  const [open, setOpen] = useState(null);
  const [msg, setMsg] = useState('');
  async function raise() { try { await http.post('/tickets', f); setF(null); load(); } catch (e) { alert(errOf(e, 'Not sent.')); } } // eslint-disable-line no-alert
  async function show(t) { try { const r = await http.get(`/tickets/${t.id}`); setOpen(r.data); } catch (e) { alert(errOf(e, 'Not available.')); } } // eslint-disable-line no-alert
  async function write() { try { await http.post(`/tickets/${open.ticket.id}/comments`, { body: msg }); setMsg(''); show(open.ticket); load(); } catch (e) { alert(errOf(e, 'Not sent.')); } } // eslint-disable-line no-alert
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center' }}><h2 style={{ fontSize: 17, margin: 0, flex: 1 }}>Support tickets</h2>{!f && <button type="button" className="btn btn-sm btn-primary" onClick={() => setF({ subject: '', description: '', priority: 'Medium' })}>+ New ticket</button>}</div>
      {err && <div className="notice">{err}</div>}
      {f && <div style={{ marginTop: 10 }}>
        <div className="field"><label htmlFor="ts">What is it about?</label><input id="ts" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></div>
        <div className="field"><label htmlFor="td">Tell us more</label><textarea id="td" rows={4} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
        <div className="field"><label htmlFor="tp">How urgent?</label><select id="tp" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}><option>High</option><option>Medium</option><option>Low</option></select></div>
        <button type="button" className="btn btn-primary btn-sm" disabled={!f.subject.trim()} onClick={raise}>Send</button> <button type="button" className="btn btn-sm" onClick={() => setF(null)}>Cancel</button>
      </div>}
      {d && !d.tickets.length && !f && <div className="small-muted" style={{ marginTop: 8 }}>No tickets.</div>}
      {d && d.tickets.map((t) => (
        <div key={t.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line-soft, #eef0f4)' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><b style={{ flex: 1 }}>{t.number} · {t.subject}</b><span className="status pending">{t.status}</span><button type="button" className="btn btn-sm" onClick={() => (open && open.ticket.id === t.id ? setOpen(null) : show(t))}>{open && open.ticket.id === t.id ? 'Close' : 'Open'}</button></div>
          {open && open.ticket.id === t.id && (
            <div style={{ marginTop: 8 }}>
              {open.ticket.description && <p style={{ whiteSpace: 'pre-wrap', fontSize: 13.5 }}>{open.ticket.description}</p>}
              {open.comments.map((c, i) => <div key={i} style={{ padding: '6px 10px', margin: '4px 0', borderRadius: 8, background: 'var(--surface-2, #f4f6fa)', fontSize: 13.5 }}><div className="small-muted" style={{ fontSize: 11.5 }}>{c.by} · {day(c.at)}</div>{c.body}</div>)}
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}><input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Write to us" aria-label="Write to us" /><button type="button" className="btn btn-primary btn-sm" disabled={!msg.trim()} onClick={write}>Send</button></div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
function Help() {
  const [q, setQ] = useState('');
  const [list, setList] = useState(null);
  const [a, setA] = useState(null);
  useEffect(() => { const t = setTimeout(() => http.get('/kb', { params: { q: q || undefined } }).then((r) => setList(r.data.articles)).catch(() => setList([])), 300); return () => clearTimeout(t); }, [q]);
  return (
    <div style={card}>
      <h2 style={{ fontSize: 17, marginTop: 0 }}>Help articles</h2>
      {a ? (
        <div><button type="button" className="btn btn-sm" onClick={() => setA(null)}>← All articles</button><h3>{a.title}</h3><div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.55 }}>{a.body}</div>
          <div style={{ marginTop: 10 }} className="small-muted">Did this help? <button type="button" className="btn btn-sm" onClick={() => { http.post(`/kb/${a.id}/helpful`, { yes: true }); setA(null); }}>Yes</button> <button type="button" className="btn btn-sm" onClick={() => { http.post(`/kb/${a.id}/helpful`, { yes: false }); setA(null); }}>No</button></div></div>
      ) : (
        <>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the help articles" aria-label="Search the help articles" />
          {list && !list.length && <div className="small-muted" style={{ marginTop: 8 }}>Nothing found.</div>}
          {(list || []).map((x) => <div key={x.id} style={{ padding: '7px 0', borderBottom: '1px solid var(--line-soft, #eef0f4)' }}><button type="button" className="crm-linkbtn" style={{ fontWeight: 600 }} onClick={() => http.get(`/kb/${x.id}`).then((r) => setA(r.data.article))}>{x.title}</button><div className="small-muted" style={{ fontSize: 12 }}>{x.category || 'General'} · {x.excerpt}</div></div>)}
        </>
      )}
    </div>
  );
}
function PartnerDeals() {
  const { d, err, load } = useGet('/deals');
  const [f, setF] = useState({ company: '', contactName: '', phone: '', email: '', value: '', notes: '' });
  const [note, setNote] = useState('');
  async function reg() { try { const r = await http.post('/deals', f); setNote(r.data.note); setF({ company: '', contactName: '', phone: '', email: '', value: '', notes: '' }); load(); } catch (e) { setNote(errOf(e, 'Not registered.')); } }
  return (
    <>
      <div style={card}>
        <h2 style={{ fontSize: 17, marginTop: 0 }}>Register a deal</h2>
        {note && <div className="notice" role="status" style={{ marginBottom: 8 }}>{note}</div>}
        <div className="grid-2">{[['company', 'Company *'], ['contactName', 'Contact person'], ['phone', 'Phone'], ['email', 'Email'], ['value', 'Expected value (₹)']].map(([k, l]) => <div key={k} className="field"><label htmlFor={`d-${k}`}>{l}</label><input id={`d-${k}`} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></div>)}</div>
        <div className="field"><label htmlFor="d-notes">What they need</label><textarea id="d-notes" rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
        <button type="button" className="btn btn-primary" disabled={!f.company.trim()} onClick={reg}>Register</button>
      </div>
      <div style={card}>
        <h2 style={{ fontSize: 17, marginTop: 0 }}>My deals</h2>
        {err && <div className="notice">{err}</div>}
        {d && !d.deals.length && <div className="small-muted">None yet.</div>}
        {d && d.deals.map((x) => <div key={x.id} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '7px 0', borderBottom: '1px solid var(--line-soft, #eef0f4)' }}><b style={{ flex: 1 }}>{x.company}</b><span>{x.value ? money(x.value) : ''}</span><span className={`status ${x.status === 'Accepted' ? 'joined' : (x.status === 'Rejected' || x.status === 'Duplicate' ? 'rejected' : 'pending')}`}>{x.status}</span>{x.reason && <div className="small-muted" style={{ width: '100%', fontSize: 12 }}>{x.reason}</div>}</div>)}
      </div>
    </>
  );
}

export default function CrmPortal() {
  const [sp, setSp] = useSearchParams();
  const invite = sp.get('invite') || '';
  const [me, setMe] = useState(null);
  const [checked, setChecked] = useState(false);
  const [tab, setTab] = useState('quotes');
  useEffect(() => {
    if (invite || !read()) { setChecked(true); return; }
    http.get('/me').then((r) => setMe(r.data.me)).catch(() => { try { sessionStorage.removeItem(KEY); } catch { /* gone */ } }).finally(() => setChecked(true));
  }, [invite]);
  useEffect(() => { document.title = 'TeamLink portal'; }, []);
  if (!checked) return <div style={wrap} className="small-muted">Loading…</div>;
  if (!me) return <Login invite={invite} onIn={(m) => { setMe(m); if (invite) setSp({}, { replace: true }); setTab(m.type === 'partner' ? 'deals' : 'quotes'); }} />;
  const tabs = me.type === 'partner' ? [['deals', 'My deals'], ['help', 'Help']] : [['quotes', 'Quotes'], ['invoices', 'Invoices'], ['tickets', 'Support'], ['help', 'Help']];
  const cur = tabs.some(([k]) => k === tab) ? tab : tabs[0][0];
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg, #f5f7fb)' }}>
      <div style={{ ...wrap, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1 }}><h1 style={{ fontSize: 20, margin: 0 }}>{me.company || 'TeamLink portal'}</h1><div className="small-muted">{me.name || me.email} · {me.type === 'partner' ? 'Partner' : 'Customer'} portal of TeamLink Consultants</div></div>
        <button type="button" className="btn btn-sm" onClick={() => { http.post('/logout').catch(() => {}); try { sessionStorage.removeItem(KEY); } catch { /* gone */ } setMe(null); }}>Sign out</button>
      </div>
      <div style={wrap}>
        <div className="tabs" role="tablist" style={{ marginBottom: 12 }}>{tabs.map(([k, l]) => <div key={k} role="tab" tabIndex={0} aria-selected={cur === k} className={`tab${cur === k ? ' active' : ''}`} onClick={() => setTab(k)} onKeyDown={(e) => { if (e.key === 'Enter') setTab(k); }}>{l}</div>)}</div>
        {cur === 'quotes' && <Quotes />}
        {cur === 'invoices' && <Invoices />}
        {cur === 'tickets' && <Tickets />}
        {cur === 'help' && <Help />}
        {cur === 'deals' && <PartnerDeals />}
      </div>
    </div>
  );
}
