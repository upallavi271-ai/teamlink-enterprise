import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../../api';
import { useOmni } from '../omniContext.js';
import omni, { errOf } from '../omniApi.js';
import { PageHead, Btn, Banner, GsModal, Pill, fmtDate } from '../ui.jsx';
import { download, relTime, timeOf, chWord } from '../console/consoleKit.js';
import '../console/console.css';
import { useWaSender } from '../../messaging/WaSender.jsx';

// ---------------------------------------------------------------------------
// WHATSAPP INBOX (Green Start "Customer conversations"): a view over the app's ONE inbox. The same conversations, the same scope per role.
// Replying, Mark done and Manage agents use the existing endpoints of routes/conversations.js (no second send path).
// Tabs: Chats (WhatsApp) / Calls, and two the app needs: Email & SMS (the other ways of the same inbox), Job-portal applications.
// ---------------------------------------------------------------------------
const CONV = (p) => `/conversations${p}`;
const initials = (n) => String(n || '?').replace(/\(.*\)/, '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

export default function InboxPage() {
  const { toast, dept } = useOmni();
  const navigate = useNavigate();
  const [ov, setOv] = useState(null);
  const [tab, setTab] = useState('chats');
  const [list, setList] = useState(null);
  const [apps, setApps] = useState(null);
  const [q, setQ] = useState('');
  const [country, setCountry] = useState('');
  const [acctId, setAcctId] = useState('all');
  const [menu, setMenu] = useState(false);
  const [sel, setSel] = useState(null); // { audience, personId, name, channel }
  const [thread, setThread] = useState(null);
  const [profile, setProfile] = useState(null);
  const [selApp, setSelApp] = useState(null);
  const [text, setText] = useState('');
  const [replyCh, setReplyCh] = useState('WhatsApp');
  // WhatsApp: the company number the reply leaves from (an existing chat keeps its own number; only numbers the Admin gave this login)
  const wa = useWaSender(replyCh === 'WhatsApp');
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState(null); // { ok, text }
  const [showChat, setShowChat] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [err, setErr] = useState('');
  const scroller = useRef(null);
  const acct = ov && ov.accounts.find((a) => a.id === acctId);

  useEffect(() => { omni.get('/gs/inbox/overview').then(setOv).catch((e) => setErr(errOf(e, 'The inbox could not be opened.'))); }, [dept]);

  const loadList = useCallback(async () => {
    try {
      const d = await omni.get('/gs/inbox/list', { tab: tab === 'apps' ? 'chats' : tab, q: q.trim(), country, accounts: acct && acct.departments ? acct.departments.join(',') : '' });
      setList(d); setErr('');
    } catch (e) { setErr(errOf(e, 'The conversations could not be loaded.')); }
  }, [tab, q, country, acct, dept]);
  useEffect(() => { const t = setTimeout(loadList, q ? 250 : 0); return () => clearTimeout(t); }, [loadList]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setInterval(loadList, 20000); return () => clearInterval(t); }, [loadList]);
  const loadApps = useCallback(() => { omni.get('/gs/inbox/applications').then(setApps).catch(() => setApps({ allowed: false, why: 'The applications could not be loaded.', rows: [], total: 0, waiting: 0 })); }, []);
  useEffect(() => { loadApps(); }, [loadApps, dept]);

  const loadThread = useCallback(async (s) => {
    if (!s) return;
    try {
      const r = await api.get(CONV(`/person/${s.audience}/${s.personId}`));
      setThread(r.data); setMsg(null);
    } catch (e) { setThread({ error: errOf(e, 'Could not open this conversation.') }); }
    omni.get(`/gs/inbox/profile/${s.audience}/${s.personId}`).then(setProfile).catch(() => setProfile(null));
  }, []);
  useEffect(() => { if (sel) { setThread(null); setProfile(null); loadThread(sel); } }, [sel && sel.audience, sel && sel.personId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!sel) return undefined; const t = setInterval(() => loadThread(sel), 15000); return () => clearInterval(t); }, [sel, loadThread]);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [thread]);

  const openChat = (r) => { setSelApp(null); setSel({ audience: r.audience, personId: r.personId, name: r.name, channel: r.channel }); setReplyCh(r.channel === 'Email' || r.channel === 'SMS' ? r.channel : 'WhatsApp'); setShowChat(true); setText(''); setMsg(null); };
  const refresh = () => { loadList(); loadApps(); if (sel) loadThread(sel); toast('Inbox refreshed'); };

  const send = async (e) => {
    if (e) e.preventDefault();
    const body = text.trim();
    if (!body || !sel || sending) return;
    setSending(true); setMsg(null);
    try {
      const r = await api.post(CONV('/send'), { audience: sel.audience, id: sel.personId, channel: replyCh, purpose: 'Message', waNumberId: replyCh === 'WhatsApp' ? wa.numberId : undefined, perChannel: { [replyCh]: { subject: 'Message', body } } });
      if (r.data.ok) { setText(''); toast(r.data.stillSending ? 'Reply is going out' : 'Reply sent'); setMsg({ ok: true, text: r.data.result && r.data.result.status && r.data.result.status !== 'sent' ? `Saved: ${r.data.result.reason || r.data.result.status}` : 'Reply sent.' }); loadThread(sel); loadList(); } else setMsg({ ok: false, text: r.data.error || 'The reply could not be sent.' });
    } catch (x) { setMsg({ ok: false, text: errOf(x, 'The reply could not be sent.') }); } finally { setSending(false); }
  };
  const markDone = async () => {
    if (!sel || !thread || !thread.thread) return;
    try { await api.post(CONV(`/person/${sel.audience}/${sel.personId}/done`), { done: !thread.thread.done }); loadThread(sel); loadList(); } catch (e) { toast(errOf(e, 'That did not work.')); }
  };
  const exportChat = async () => {
    if (!sel) { toast('Open a chat first'); return; }
    try { download(await omni.blob(`/gs/inbox/transcript/${sel.audience}/${sel.personId}`), `${sel.personId}_chat_transcript.csv`); } catch (e) { toast(e && e.response && e.response.status === 404 ? 'No messages to export' : 'The chat could not be exported.'); }
  };

  const rows = (list && list.rows) || [];
  const unreadWa = list && list.unread ? list.unread.chats : 0;
  const counts = (list && list.counts) || {};
  const t = thread && !thread.error ? thread : null;
  const items = t ? t.timeline : [];

  if (err && !ov) return <div><PageHead eyebrow="Customer conversations" title="WhatsApp Inbox" lead="Respond to customers, assign follow-ups and turn conversations into conversions." /><Banner tone="error">{err}</Banner></div>;

  const appRows = (apps && apps.rows) || [];
  const qq = q.trim().toLowerCase();
  const shownApps = qq ? appRows.filter((a) => `${a.name} ${a.job} ${a.jobCode}`.toLowerCase().includes(qq)) : appRows;

  return (
    <div>
      <PageHead eyebrow="Customer conversations" title="WhatsApp Inbox" lead="Respond to customers, assign follow-ups and turn conversations into conversions.">
        <Btn onClick={() => (ov && ov.mayNew ? setNewOpen(true) : toast('Starting a chat is for the BDE team, Team Leads, HR and Admins.'))}>＋ New conversation</Btn>
      </PageHead>
      {ov && ov.rehearsal && ov.testWords && <Banner tone="test">{ov.testWords}</Banner>}
      {ov && ov.note && <Banner tone="info">{ov.note}</Banner>}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="wa-header">
          <div className="wa-header-left">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><b style={{ fontSize: 12 }}>WhatsApp</b><span className="wa-unread-pill">{unreadWa} unread</span></div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" className="wa-icon-btn" onClick={exportChat} title="Export" aria-label="Export this chat as a file">⬇</button>
              <button type="button" className="wa-icon-btn" onClick={refresh} title="Refresh" aria-label="Refresh">↻</button>
            </div>
          </div>
          <div className="wa-header-right">
            <div>
              <b style={{ fontSize: 11 }}>WhatsApp Web</b>
              <div style={{ marginTop: 3 }}><span className="wa-conn"><i className={ov && ov.connected ? '' : 'off'} />{ov ? (ov.connected ? 'Connected' : (ov.connectedWhy || 'Not connected')) : '…'}</span></div>
            </div>
            <div className="dropdown">
              <button type="button" className="wa-account-btn" onClick={() => setMenu(!menu)} aria-expanded={menu}>{acct ? `${acct.label}${acct.number ? ` (${acct.number})` : ''}` : 'Company WhatsApp number'} ⌄</button>
              {menu && ov && (
                <div className="menu show" style={{ right: 0, minWidth: 260 }}>
                  {ov.accounts.map((a) => (
                    <button type="button" key={a.id} className={a.id === acctId ? 'active' : ''} onClick={() => { setAcctId(a.id); setMenu(false); toast(`Switched to ${a.label}`); }}>
                      {a.label}{a.number ? ` (${a.number})` : ''}{a.id === acctId ? ' ●' : ''}
                      {a.departments && a.departments.length ? <small style={{ display: 'block', fontWeight: 600, opacity: 0.7 }}>Shows the chats of {a.departments.join(', ')}</small> : null}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className={`chat-layout wa3${showChat ? ' show-chat' : ''}`}>
          <div className="chat-list">
            <div className="chat-search">
              <div style={{ display: 'flex', background: '#eef2ef', borderRadius: 9, padding: 3, gap: 3, marginBottom: 8 }}>
                <button type="button" className={`wa-tab${tab === 'chats' ? ' active' : ''}`} onClick={() => setTab('chats')}>💬 Chats{counts.chats ? <b style={{ marginLeft: 4, color: '#25a05f' }}>{counts.chats}</b> : null}</button>
                <button type="button" className={`wa-tab${tab === 'calls' ? ' active' : ''}`} onClick={() => setTab('calls')}>📞 Calls{counts.calls ? <b style={{ marginLeft: 4, color: '#25a05f' }}>{counts.calls}</b> : null}</button>
              </div>
              <div className="con-tabrow">
                <button type="button" className={`wa-tab${tab === 'other' ? ' active' : ''}`} onClick={() => setTab('other')}>✉ Email &amp; SMS{list && list.unread && list.unread.other ? <b>{list.unread.other}</b> : null}</button>
                <button type="button" className={`wa-tab${tab === 'apps' ? ' active' : ''}`} onClick={() => setTab('apps')} title="Job-portal applications">📋 Job-portal applications{apps && apps.waiting ? <b>{apps.waiting}</b> : null}</button>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <select aria-label="Country" value={country} onChange={(e) => setCountry(e.target.value)} style={{ width: 84, border: '1px solid var(--line)', borderRadius: 8, fontSize: 9 }}>
                  <option value="">All</option><option value="IN">IN +91</option><option value="US">US +1</option><option value="UK">UK +44</option>
                </select>
                <input className="search" style={{ flex: 1, minWidth: 0 }} placeholder="Phone number or name" aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
            </div>
            {err && <div className="con-err">{err}</div>}
            {tab !== 'apps' && (
              <div>
                {!list && <div className="con-empty">Opening the inbox…</div>}
                {list && !list.ready && <div className="con-empty">The inbox is being set up. It will be here in a few minutes.</div>}
                {list && list.ready && !rows.length && <div className="con-empty">{tab === 'calls' ? 'No calls saved yet. A call you save on a person\'s page shows here.' : (tab === 'other' ? 'No email or SMS conversations yet.' : (q || country ? 'No chat matches your search.' : 'No WhatsApp conversations yet. When a customer writes back, it appears here.'))}</div>}
                {tab === 'calls'
                  ? rows.map((r) => (
                    <div key={r.id} className={`call-item${sel && sel.personId === r.personId ? ' chat-item active' : ''}`} style={{ cursor: 'pointer' }} onClick={() => openChat(r)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') openChat(r); }}>
                      <span className="avatar2">{r.initials}</span>
                      <div style={{ flex: 1, minWidth: 0 }}><strong style={{ overflowWrap: 'anywhere' }}>{r.name}</strong><small><span className="call-dir" style={{ color: r.direction === 'IN' ? '#0a7040' : '#4d7ddb' }}>{r.direction === 'IN' ? '↙' : '↗'}</span> {r.direction === 'IN' ? 'Incoming' : 'Call saved'}{r.snippet ? ` · ${r.snippet}` : ''}</small></div>
                      <span style={{ fontSize: 8, color: 'var(--muted)' }}>{relTime(r.lastAt)}</span>
                    </div>
                  ))
                  : rows.map((r) => (
                    <div key={r.id} className={`chat-item${sel && sel.personId === r.personId ? ' active' : ''}`} onClick={() => openChat(r)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') openChat(r); }}>
                      <div className="avatar2">{r.initials}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="chat-item-row"><strong>{r.name}</strong><span style={{ fontSize: 7, color: '#9aa39d', flex: '0 0 auto' }}>{relTime(r.lastAt)}</span></div>
                        <div className="chat-item-row2"><small>{r.direction === 'OUT' ? 'You: ' : ''}{r.snippet}{r.numbers && r.numbers.length ? ' · ' + r.numbers.join(', ') : ''}</small>{r.unread > 0 ? <span className="unread-badge">{r.unread}</span> : null}</div>
                        {(tab === 'other' || r.department || r.done) && <span className="con-tag">{tab === 'other' ? `${chWord(r.channel)} · ` : ''}{r.department}{r.done ? `${r.department ? ' · ' : ''}done` : ''}</span>}
                      </div>
                    </div>
                  ))}
                {list && list.truncated && <div className="con-empty">Showing the latest 100. Use the search to find an older chat.</div>}
              </div>
            )}
            {tab === 'apps' && (
              <div>
                {!apps && <div className="con-empty">Opening…</div>}
                {apps && !apps.allowed && <div className="con-empty">{apps.why}</div>}
                {apps && apps.allowed && !shownApps.length && <div className="con-empty">No applications from the Job Portal yet.</div>}
                {shownApps.map((a) => (
                  <div key={a.id} className={`chat-item${selApp && selApp.id === a.id ? ' active' : ''}`} onClick={() => { setSelApp(a); setSel(null); setShowChat(true); }} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') { setSelApp(a); setSel(null); setShowChat(true); } }}>
                    <div className="avatar2">{a.initials}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="chat-item-row"><strong>{a.name}</strong><span style={{ fontSize: 7, color: '#9aa39d', flex: '0 0 auto' }}>{relTime(a.appliedAt)}</span></div>
                      <div className="chat-item-row2"><small>{a.job}{a.jobCode ? ` (${a.jobCode})` : ''}</small>{!a.pickedUp ? <span className="unread-badge" title="Waiting to be picked up">new</span> : null}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="chat-main">
            {tab === 'apps' && selApp ? (
              <>
                <div className="chat-head" style={{ background: '#0b3d2c', color: '#fff' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><button type="button" className="chat-back" onClick={() => setShowChat(false)} aria-label="Back to the list">&#8592;</button><div className="avatar2" style={{ background: '#12523c', color: '#dff6e7' }}>{selApp.initials}</div><div><b style={{ color: '#fff', overflowWrap: 'anywhere' }}>{selApp.name}</b><div style={{ fontSize: 8, opacity: 0.8 }}>Applied {timeOf(selApp.appliedAt)}</div></div></div>
                  <Pill tone={selApp.pickedUp ? 'draft' : 'live'}>{selApp.pickedUp ? 'Picked up' : 'Waiting to be picked up'}</Pill>
                </div>
                <div className="con-appd">
                  <div><div className="panel-title" style={{ fontSize: 12 }}>{selApp.job}{selApp.jobCode ? ` (${selApp.jobCode})` : ''}</div><div className="panel-sub">{selApp.department}{selApp.stage ? ` · step: ${selApp.stage}` : ''}</div></div>
                  <div className="kv-grid">
                    <div className="kv-item"><small>Phone</small><b>{selApp.phone || '—'}</b></div>
                    <div className="kv-item"><small>Email</small><b style={{ overflowWrap: 'anywhere' }}>{selApp.email || '—'}</b></div>
                    <div className="kv-item"><small>Salary</small><b>{apps.masked ? 'Hidden for your login' : (selApp.salary || '—')}</b></div>
                    <div className="kv-item"><small>Location</small><b>{selApp.location || '—'}</b></div>
                  </div>
                  {apps.masked && <p style={{ fontSize: 9, color: 'var(--muted)', margin: 0 }}>Your login does not see the candidate's phone, email or salary. Open the candidate to work on the application.</p>}
                  <div><Btn primary onClick={() => navigate(`/candidates/${selApp.candidateId}`)}>Open candidate</Btn></div>
                </div>
              </>
            ) : sel ? (
              <>
                <div className="chat-head" style={{ background: '#0b3d2c', color: '#fff' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <button type="button" className="chat-back" onClick={() => setShowChat(false)} aria-label="Back to conversations">&#8592;</button>
                    <div className="avatar2" style={{ background: '#12523c', color: '#dff6e7' }}>{initials(sel.name)}</div>
                    <div style={{ minWidth: 0 }}><b style={{ color: '#fff', overflowWrap: 'anywhere' }}>{sel.name}</b><div style={{ fontSize: 8, opacity: 0.8 }}>{t && t.thread ? (t.thread.ownerName ? `Handled by ${t.thread.ownerName}` : 'Nobody handles this yet') : 'Opening…'}{profile && profile.department ? ` · ${profile.department}` : ''}{(() => { const used = [...new Set(items.filter((m) => m.waNumber).map((m) => m.waNumber.label))]; return used.length ? ` · WhatsApp number: ${used.join(', ')}` : ''; })()}</div></div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <Pill tone={t && t.thread && t.thread.done ? 'draft' : 'live'}>{t && t.thread && t.thread.done ? 'Done' : '● Open'}</Pill>
                    <button type="button" className="wa-icon-btn" style={{ width: 'auto', padding: '0 8px', fontSize: 8 }} onClick={markDone}>{t && t.thread && t.thread.done ? 'Open again' : 'Mark done'}</button>
                  </div>
                </div>
                <div ref={scroller} className="chat-messages">
                  {thread && thread.error && <div className="con-err">{thread.error}</div>}
                  {!thread && <div className="con-empty">Opening the conversation…</div>}
                  {t && !items.length && <div className="con-empty">No messages yet. Write the first one below.</div>}
                  {items.map((m) => (
                    m.channel === 'Call' ? <div key={m.id} className="con-sysmsg">📞 {m.stateWord || 'Call saved'}{m.body ? `: ${m.body}` : ''} · {timeOf(m.at)}</div>
                      : (
                        <div key={m.id} className={`msg ${m.direction === 'in' ? 'incoming' : 'outgoing'}`}>
                          {m.channel !== 'WhatsApp' && <span className="con-mch">{chWord(m.channel)}{m.subject ? ` · ${m.subject}` : ''}</span>}
                          <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.body || m.template || m.stateWord}</span>
                          <span className="con-mt">{timeOf(m.at)}{m.direction === 'out' && m.stateWord ? ` · ${m.stateWord}` : ''}{m.who ? ` · ${m.who}` : ''}{m.waNumber ? ` · ${m.waNumber.label}` : ''}</span>
                        </div>
                      )
                  ))}
                </div>
                {t && t.person && t.person.doNotContact && <div className="con-err">This person asked not to be contacted. Nothing can be sent.</div>}
                {msg && <div className={msg.ok ? 'con-ok' : 'con-err'} role="status">{msg.text}</div>}
                {replyCh === 'WhatsApp' && wa.node}
                <form className="chat-compose" onSubmit={send}>
                  {(tab === 'other' || sel.channel === 'Email' || sel.channel === 'SMS') && (
                    <select aria-label="Reply on" value={replyCh} onChange={(e) => setReplyCh(e.target.value)}><option value="WhatsApp">WhatsApp</option><option value="SMS">SMS</option><option value="Email">Mail</option></select>
                  )}
                  <input placeholder={`Write a reply${replyCh === 'WhatsApp' ? '' : ` on ${chWord(replyCh)}`}...`} aria-label="Write a reply" value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} />
                  <button type="submit" className="btn primary" disabled={sending || !text.trim() || (replyCh === 'WhatsApp' && !wa.canSend)}>{sending ? 'Sending…' : 'Send'}</button>
                </form>
              </>
            ) : (
              <div className="con-empty" style={{ margin: 'auto' }}>{tab === 'apps' ? 'Pick an application to see the details.' : 'Pick a conversation on the left to read it and answer.'}</div>
            )}
          </div>

          <aside className="profile-side">
            {sel && profile ? (
              <>
                <div style={{ display: 'flex', justifyContent: 'center' }}><div className="big-avatar" style={{ width: 58, height: 58, borderRadius: 17, background: 'var(--green-3)', color: 'var(--green-2)', display: 'grid', placeItems: 'center', fontSize: 17, fontWeight: 950 }}>{profile.initials}</div></div>
                <div style={{ textAlign: 'center', marginTop: 9 }}><b style={{ fontSize: 11, overflowWrap: 'anywhere' }}>{profile.name}</b><div style={{ fontSize: 8, color: '#89938d', marginTop: 3 }}>{profile.since ? `Customer since ${fmtDate(profile.since)}` : profile.lifecycle}</div></div>
                <div className="kv-grid">
                  <div className="kv-item"><small>Phone</small><b style={{ overflowWrap: 'anywhere' }}>{profile.phone || '—'}</b></div>
                  <div className="kv-item"><small>Lifecycle</small><b>{profile.lifecycle}</b></div>
                  <div className="kv-item"><small>Kind</small><b>{profile.kinds && profile.kinds.length ? profile.kinds.join(', ') : '—'}</b></div>
                  <div className="kv-item"><small>Last reply</small><b>{profile.lastReply ? timeOf(profile.lastReply) : '—'}</b></div>
                  <div className="kv-item" style={{ gridColumn: '1/-1' }}><small>Handled by</small><b>{profile.owner ? profile.owner.name : 'Nobody yet'}</b></div>
                </div>
                {profile.masked && <p style={{ fontSize: 8, color: 'var(--muted)', margin: '8px 0 0' }}>The number is hidden for your login. You reach this person through TeamLink.</p>}
                <div style={{ marginTop: 12 }}><Btn small onClick={() => setAgentsOpen(true)}>👤 Manage agents</Btn></div>
                <div style={{ marginTop: 18 }}>
                  <div className="panel-title" style={{ fontSize: 10 }}>Recent activity</div>
                  <div className="timeline">
                    {profile.activity.length ? profile.activity.map((a, i) => <div className="timeline-row" key={i}><i className="timeline-dot" /><div><b>{a.title}</b><small>{timeOf(a.at)}</small></div></div>) : <small style={{ color: 'var(--muted)' }}>Nothing yet.</small>}{/* eslint-disable-line react/no-array-index-key */}
                  </div>
                </div>
              </>
            ) : <div className="con-empty">{sel ? 'Opening the profile…' : 'The person\'s details show here.'}</div>}
          </aside>
        </div>
      </div>

      {newOpen && <NewConversation onClose={() => setNewOpen(false)} toast={toast} onOpened={(o) => { setTab('chats'); if (o) { setSel({ audience: o.audience, personId: o.personId, name: '', channel: 'WhatsApp' }); setShowChat(true); } loadList(); }} />}
      {agentsOpen && sel && <AgentsModal sel={sel} owner={profile && profile.owner} onClose={() => setAgentsOpen(false)} toast={toast} onChanged={() => { loadThread(sel); loadList(); }} />}
    </div>
  );
}

// "New conversation": pick one of YOUR contacts who agreed to WhatsApp, write the first message. The server applies the same rules as every single message
// (agreed, not stopped, Test mode = rehearsal).
function NewConversation({ onClose, onOpened, toast }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [pick, setPick] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { const t = setTimeout(() => { omni.get('/gs/inbox/contacts', { q }).then((d) => setRows(d.rows || [])).catch((e) => setErr(errOf(e, 'The contacts could not be loaded.'))); }, 250); return () => clearTimeout(t); }, [q]);
  const go = async () => {
    if (!pick) { setErr('Pick a person first.'); return; }
    if (!text.trim()) { setErr('Write the message.'); return; }
    setBusy(true); setErr('');
    try { const d = await omni.post('/gs/inbox/new', { contactId: pick.id, text }); toast(d.opened ? 'Opened the existing conversation' : (d.ok || 'Done')); onOpened(d.opened); onClose(); } catch (e) { setErr(errOf(e, 'The message could not be sent.')); } finally { setBusy(false); }
  };
  return (
    <GsModal title="New conversation" sub="Start a chat with one of your contacts who agreed to WhatsApp." width={520} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={busy} onClick={go}>Start conversation</Btn></>}>
      <div className="field"><label>FIND A PERSON</label><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a name, company or city" aria-label="Find a person" /></div>
      <div style={{ maxHeight: 190, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 10, margin: '8px 0' }}>
        {!rows.length && <div className="con-empty">No contact who agreed to WhatsApp matches.</div>}
        {rows.map((r) => (
          <button type="button" key={r.id} className="con-agent" style={{ width: '100%', border: 0, background: pick && pick.id === r.id ? '#edf9f0' : 'transparent', textAlign: 'left', cursor: 'pointer', padding: '9px 12px' }} onClick={() => setPick(r)}>
            <span className="avatar2">{initials(r.name)}</span>
            <span style={{ flex: 1 }}><b style={{ fontSize: 11, overflowWrap: 'anywhere' }}>{r.name || '(no name)'}</b><small style={{ display: 'block', fontSize: 8, color: '#8a948d' }}>{r.phone || ''}</small></span>
            {pick && pick.id === r.id ? <Pill tone="live">Picked</Pill> : null}
          </button>
        ))}
      </div>
      <div className="field"><label>FIRST MESSAGE</label><textarea style={{ minHeight: 80 }} value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} placeholder="Write the message" /></div>
      <p style={{ fontSize: 9, color: 'var(--muted)', margin: '8px 0 0' }}>A &quot;Reply STOP to stop&quot; line is added. In Test mode this is a rehearsal and nothing is sent.</p>
      {err && <div className="con-err" style={{ margin: '8px 0 0' }}>{err}</div>}
    </GsModal>
  );
}

// "Manage Agents": give this chat to a colleague (the app's one owner per chat; they are told).
function AgentsModal({ sel, owner, onClose, toast, onChanged }) {
  const [people, setPeople] = useState(null);
  const [q, setQ] = useState('');
  const [cur, setCur] = useState(owner ? owner.id : null);
  useEffect(() => { api.get(CONV('/assignees'), { params: { audience: sel.audience, id: sel.personId } }).then((r) => setPeople(r.data.people || [])).catch(() => setPeople([])); }, [sel.audience, sel.personId]);
  const toggle = async (p) => {
    const to = cur === p.id ? null : p.id;
    try { await api.post(CONV(`/person/${sel.audience}/${sel.personId}/assign`), { userId: to }); setCur(to); toast(to ? `Chat given to ${p.name}` : 'Nobody handles this chat now'); onChanged(); } catch (e) { toast(errOf(e, 'That did not work.')); }
  };
  const shown = (people || []).filter((p) => !q || `${p.name} ${p.role} ${p.department || ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <GsModal title="Manage Agents" sub={`Chat: ${sel.name || 'this person'}`} width={560} onClose={onClose} foot={<p style={{ fontSize: 9, color: '#1d4fa8', textAlign: 'center', lineHeight: 1.6, width: '100%', margin: 0 }}>A chat belongs to one colleague at a time. They are told when you give it to them and they reply from their own inbox.</p>}>
      <div className="field"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a person" aria-label="Search a person" /></div>
      {!people && <div className="con-empty">Opening…</div>}
      {people && !shown.length && <div className="con-empty">Nobody found in your area.</div>}
      {shown.map((p) => (
        <div className="con-agent" key={p.id}>
          <span className="avatar2">👤</span>
          <span style={{ flex: 1 }}><b>{p.name}</b><small>{p.role}{p.department ? ` · ${p.department}` : ''}</small></span>
          <Btn small primary={cur === p.id} onClick={() => toggle(p)}>{cur === p.id ? '✓ Assigned' : '+ Assign'}</Btn>
        </div>
      ))}
    </GsModal>
  );
}
