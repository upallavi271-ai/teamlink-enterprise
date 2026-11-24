// CRM > Follow-ups > Inbox (CRM wave B, 2026-11-24): every conversation in one place.
//   Conversations   the email / WhatsApp / SMS / call thread of every lead, deal and customer, the ones waiting for our reply first (07.11)
//   Website chat    visitors writing from the chat bubble on the company website; answer, make a lead, close (07.10)
//   Team mailbox    customer mail to the shared address (sales@ ...): take it, give it, reply, done (06.09)
//   Scheduled       messages and campaigns waiting to go at their time (06.06)
//   My mail         my signature, my templates, my Gmail / Outlook connection, the BCC address (06.02 06.03 06.08 06.10)
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../../api';
import { useCrm, errOf, dateTimeOf } from '../crmShared.jsx';
import { SubTabs, useLoad, OffNote, Empty, ago } from './bShared.jsx';

const CH_ICON = { Email: '✉️', WhatsApp: '💬', SMS: '📱', Call: '📞', Note: '📝' };

function Conversations() {
  const { openRecord, version } = useCrm();
  const [channel, setChannel] = useState('');
  const [waiting, setWaiting] = useState(false);
  const [q, setQ] = useState('');
  const [qq, setQq] = useState('');
  useEffect(() => { const t = setTimeout(() => setQq(q), 350); return () => clearTimeout(t); }, [q]);
  const { data, err } = useLoad('/crm/b/inbox', { channel: channel || undefined, waiting: waiting ? '1' : undefined, q: qq || undefined }, [version]);
  return (
    <>
      <div className="filter-row">
        <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search company, deal, subject" aria-label="Search conversations" style={{ minWidth: 220 }} />
        <select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Channel" style={{ width: 'auto' }}><option value="">Every channel</option>{['Email', 'WhatsApp', 'SMS', 'Call'].map((c) => <option key={c} value={c}>{c}</option>)}</select>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0, fontWeight: 500 }}><input type="checkbox" checked={waiting} onChange={(e) => setWaiting(e.target.checked)} style={{ width: 'auto' }} /> Waiting for our reply</label>
        {data && <span className="small-muted">{data.counts.waiting} waiting · {data.counts.total} conversations</span>}
      </div>
      {err && <div className="notice" role="alert">{err}</div>}
      {!data && !err && <div className="small-muted">Loading…</div>}
      {data && !data.threads.length && <Empty title="No conversations">Emails, WhatsApp, SMS and calls with leads and customers show here.</Empty>}
      {data && data.threads.length > 0 && (
        <div className="tbl-wrap"><table>
          <thead><tr><th>Who</th><th>Last message</th><th>Channels</th><th>When</th><th>Owner</th></tr></thead>
          <tbody>{data.threads.map((t) => (
            <tr key={`${t.kind}:${t.id}`} style={{ cursor: 'pointer' }} onClick={() => openRecord(t.kind, t.id)}>
              <td><b>{t.name || '—'}</b><div className="small-muted" style={{ fontSize: 11.5 }}>{t.kind}</div></td>
              <td style={{ maxWidth: 380 }}>{t.waiting && <span className="status rejected" style={{ marginRight: 6 }}>Waiting</span>}<span aria-hidden="true">{CH_ICON[t.lastChannel]}</span> {t.lastDirection === 'in' ? '' : 'You: '}<span className="small-muted">{t.lastText || t.lastSubject}</span></td>
              <td>{t.channels.map((c) => <span key={c} title={c} style={{ marginRight: 4 }}>{CH_ICON[c]}</span>)}<span className="small-muted"> {t.messages}</span></td>
              <td style={{ whiteSpace: 'nowrap' }}>{ago(t.lastAt)}</td>
              <td className="small-muted">{t.owner || '—'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}

function Chats() {
  const { toast, openRecord, me } = useCrm();
  const { data, reload } = useLoad('/crm/b/chats', { status: 'Open' });
  const [sel, setSel] = useState(null);
  const [d, setD] = useState(null);
  const [text, setText] = useState('');
  const timer = useRef(null);
  const loadOne = (id) => api.get(`/crm/b/chats/${id}`).then((r) => setD(r.data)).catch(() => setD(null));
  useEffect(() => {
    clearInterval(timer.current);
    timer.current = setInterval(() => { reload(); if (sel) loadOne(sel); }, 5000);
    return () => clearInterval(timer.current);
  }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (sel) loadOne(sel); else setD(null); }, [sel]);
  async function act(body, words) {
    try { const r = await api.post(`/crm/b/chats/${sel}`, body); if (words) toast(words); if (body.action === 'close') setSel(null); else loadOne(sel); reload(); return r.data; } catch (e) { toast(errOf(e, 'This did not work.')); return null; }
  }
  return (
    <>
      {data && <OffNote on={data.on} what="Website chat" />}
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="card" style={{ padding: 10 }}>
          <div className="section-label" style={{ marginTop: 0 }}>Open chats</div>
          {data && !data.chats.length && <div className="small-muted">No open chats. The chat bubble is put on the company website from Leads → Marketing → Website.</div>}
          {(data ? data.chats : []).map((c) => (
            <button key={c.id} type="button" className={`btn${sel === c.id ? ' btn-primary' : ''}`} style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 6 }} onClick={() => setSel(c.id)}>
              <b>{c.name || c.email || c.phone || 'Visitor'}</b>{Number(c.unread) > 0 && <span className="status rejected" style={{ marginLeft: 6 }}>{c.unread} new</span>}
              <div className="small-muted" style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.last} · {ago(c.lastAt)}</div>
            </button>
          ))}
        </div>
        <div className="card" style={{ padding: 10, minHeight: 200 }}>
          {!d && <div className="small-muted">Pick a chat.</div>}
          {d && (
            <>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
                <b style={{ flex: 1 }}>{d.chat.name || 'Visitor'} <span className="small-muted" style={{ fontWeight: 400 }}>{[d.chat.email, d.chat.phone].filter(Boolean).join(' · ')}</span></b>
                {d.chat.leadId ? <button type="button" className="btn btn-sm" onClick={() => openRecord('lead', d.chat.leadId)}>Open lead</button> : me.canEdit && <button type="button" className="btn btn-sm" onClick={() => act({ action: 'lead' }, 'Made a lead.')}>Make a lead</button>}
                {me.canEdit && <button type="button" className="btn btn-sm" onClick={() => act({ action: 'close' }, 'Chat closed.')}>Close</button>}
              </div>
              {d.chat.pageUrl && <div className="small-muted" style={{ fontSize: 11.5, marginBottom: 6, wordBreak: 'break-all' }}>From {d.chat.pageUrl}</div>}
              <div style={{ maxHeight: 300, overflow: 'auto', marginBottom: 8 }}>
                {d.messages.map((m) => (
                  <div key={m.id} style={{ margin: '5px 0', padding: '7px 10px', borderRadius: 9, maxWidth: '85%', fontSize: 13.5, ...(m.side === 'agent' ? { marginLeft: 'auto', background: 'var(--brand-soft, #eef2ff)' } : { background: 'var(--surface-2, #f4f6fa)' }) }}>
                    <div className="small-muted" style={{ fontSize: 11 }}>{m.side === 'agent' ? m.byName : (d.chat.name || 'Visitor')} · {dateTimeOf(m.at)}</div>{m.body}
                  </div>
                ))}
              </div>
              {me.canEdit && <div style={{ display: 'flex', gap: 6 }}>
                <input type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Write the answer" aria-label="Answer" onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) { act({ action: 'reply', body: text }); setText(''); } }} />
                <button type="button" className="btn btn-primary" disabled={!text.trim()} onClick={() => { act({ action: 'reply', body: text }); setText(''); }}>Send</button>
              </div>}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function TeamMail() {
  const { me, toast, openRecord } = useCrm();
  const [status, setStatus] = useState('Open');
  const { data, err, reload } = useLoad('/crm/b/team-mail', { status });
  const [open, setOpen] = useState(null);
  const [reply, setReply] = useState('');
  async function act(m, body, words) {
    try { await api.post(`/crm/b/team-mail/${m.id}`, body); toast(words); reload(); if (body.action === 'reply') { setReply(''); setOpen(null); } } catch (e) { toast(errOf(e, 'This did not work.')); }
  }
  return (
    <>
      <div className="filter-row">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" style={{ width: 'auto' }}><option value="Open">Open</option><option value="Done">Done</option><option value="">All</option></select>
        {data && <span className="small-muted">{data.counts.open} open · {data.counts.unassigned} nobody has taken · team mailbox {data.teamMailbox || '(the shared inbox)'}</span>}
      </div>
      {err && <div className="notice" role="alert">{err}</div>}
      {data && !data.rows.length && <Empty title="No team mail">Customer mail to the shared mailbox shows here once the shared inbox is connected (Administration → Integrations → Shared Inbox) and "Read the connected mailboxes" is on.</Empty>}
      {(data ? data.rows : []).map((m) => (
        <div key={m.id} className="card" style={{ padding: 10, marginBottom: 8 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <b style={{ flex: 1, minWidth: 200 }}>{m.subject || '(no subject)'} <span className="small-muted" style={{ fontWeight: 400 }}>from {m.fromName ? `${m.fromName} <${m.fromAddr}>` : m.fromAddr} · {ago(m.at)}</span></b>
            <span className="small-muted">{m.assigneeName ? `With ${m.assigneeName}` : 'Nobody yet'}{m.repliedAt ? ` · replied by ${m.repliedBy}` : ''}</span>
            {m.recordId && <button type="button" className="btn btn-sm" onClick={() => openRecord(m.kind, m.recordId)}>Open record</button>}
            {me.canEdit && !m.assigneeName && <button type="button" className="btn btn-sm" onClick={() => act(m, { action: 'assign' }, 'It is yours.')}>Take it</button>}
            {me.canAssign && <select value="" onChange={(e) => e.target.value && act(m, { action: 'assign', assigneeId: e.target.value }, 'Given.')} aria-label="Give to" style={{ width: 'auto' }}><option value="">Give to…</option>{me.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
            {me.canEdit && <button type="button" className="btn btn-sm" onClick={() => setOpen(open === m.id ? null : m.id)}>Reply</button>}
            {me.canEdit && <button type="button" className="btn btn-sm" onClick={() => act(m, { action: m.status === 'Done' ? 'reopen' : 'done' }, m.status === 'Done' ? 'Opened again.' : 'Done.')}>{m.status === 'Done' ? 'Open again' : 'Done'}</button>}
          </div>
          <div className="small-muted" style={{ whiteSpace: 'pre-wrap', fontSize: 13, marginTop: 6, maxHeight: 140, overflow: 'auto' }}>{m.text}</div>
          {open === m.id && <div style={{ marginTop: 8 }}><textarea rows={5} value={reply} onChange={(e) => setReply(e.target.value)} aria-label="Reply" /><button type="button" className="btn btn-primary" style={{ marginTop: 6 }} disabled={!reply.trim()} onClick={() => act(m, { action: 'reply', text: reply }, `Reply sent to ${m.fromAddr}.`)}>Send reply</button></div>}
        </div>
      ))}
    </>
  );
}

function Scheduled() {
  const { toast, openRecord } = useCrm();
  const { data, err, reload } = useLoad('/crm/b/scheduled');
  async function cancel(r) { try { await api.post(`/crm/b/scheduled/${r.id}/cancel`); toast('Cancelled.'); reload(); } catch (e) { toast(errOf(e, 'It could not be cancelled.')); } }
  return (
    <>
      {data && <OffNote on={data.on} what="Send later" />}
      {err && <div className="notice" role="alert">{err}</div>}
      {data && !data.rows.length && <Empty title="Nothing scheduled">Use "🕒 Send later" in the Email / WhatsApp / SMS window of a record, or on a campaign.</Empty>}
      {data && data.rows.length > 0 && <div className="tbl-wrap"><table>
        <thead><tr><th>Goes</th><th>What</th><th>To</th><th>By</th><th>Status</th><th /></tr></thead>
        <tbody>{data.rows.map((r) => (
          <tr key={r.id}>
            <td style={{ whiteSpace: 'nowrap' }}>{dateTimeOf(r.sendAt)}</td>
            <td>{r.what === 'campaign' ? 'Campaign: ' : `${r.channel}: `}{r.subject || String(r.body || '').slice(0, 60)}</td>
            <td>{r.what === 'campaign' ? '—' : (r.recordId ? <button type="button" className="crm-linkbtn" onClick={() => openRecord(r.kind, r.recordId)}>{r.toAddr || 'the record'}</button> : r.toAddr)}</td>
            <td className="small-muted">{r.byName}</td>
            <td><span className={`status ${r.status === 'Sent' ? 'joined' : (r.status === 'Waiting' ? 'pending' : 'rejected')}`}>{r.status}</span>{r.result && r.status === 'Failed' ? <div className="small-muted" style={{ fontSize: 11.5 }}>{r.result}</div> : null}</td>
            <td>{r.status === 'Waiting' && r.mine && <button type="button" className="btn btn-sm" onClick={() => cancel(r)}>Cancel</button>}</td>
          </tr>
        ))}</tbody>
      </table></div>}
    </>
  );
}

function MyMail() {
  const { me, toast } = useCrm();
  const sig = useLoad('/crm/b/signature');
  const tpl = useLoad('/crm/b/templates');
  const acc = useLoad('/crm/b/mail/accounts');
  const [text, setText] = useState(null);
  const [edit, setEdit] = useState(null);
  useEffect(() => { if (sig.data && text == null) setText(sig.data.text || ''); }, [sig.data]); // eslint-disable-line react-hooks/exhaustive-deps
  async function saveSig() { try { await api.put('/crm/b/signature', { text }); toast('Signature saved.'); sig.reload(); } catch (e) { toast(errOf(e, 'Not saved.')); } }
  async function saveTpl() {
    try { if (edit.id) await api.put(`/crm/b/templates/${edit.id}`, edit); else await api.post('/crm/b/templates', edit); toast('Template saved.'); setEdit(null); tpl.reload(); } catch (e) { toast(errOf(e, 'Not saved.')); }
  }
  async function delTpl(t) { if (!window.confirm(`Delete the template "${t.name}"?`)) return; try { await api.delete(`/crm/b/templates/${t.id}`); tpl.reload(); } catch (e) { toast(errOf(e, 'Not deleted.')); } }
  async function connect(p) { try { const r = await api.get(`/crm/b/mail/connect/${p}`); window.open(r.data.url, '_blank', 'noopener'); } catch (e) { toast(errOf(e, 'It cannot be connected yet.')); } }
  async function disconnect(p) { try { await api.delete(`/crm/b/mail/accounts/${p}`); acc.reload(); } catch (e) { toast(errOf(e, 'Not removed.')); } }
  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <div>
        <div className="card" style={{ padding: 12, marginBottom: 12 }}>
          <div className="section-label" style={{ marginTop: 0 }}>My email signature</div>
          <textarea rows={4} value={text || ''} placeholder={sig.data ? sig.data.suggestion : ''} onChange={(e) => setText(e.target.value)} aria-label="Signature" />
          <div className="small-muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>Put under every CRM email you send (records, the team mailbox, scheduled mail).</div>
          <button type="button" className="btn btn-primary btn-sm" onClick={saveSig}>Save signature</button>
        </div>
        <div className="card" style={{ padding: 12 }}>
          <div className="section-label" style={{ marginTop: 0 }}>My mailbox</div>
          {acc.data && (
            <>
              <div className="small-muted" style={{ fontSize: 12.5, marginBottom: 8 }}>Mail you send to and get from customers outside TeamLink is written on their records{acc.data.syncOn ? '' : ' (once an Admin switches on "Read the connected mailboxes")'}.{acc.data.bccAddress ? <> Or put <b>{acc.data.bccAddress}</b> in BCC of any mail to a customer.</> : ''}</div>
              {Object.entries(acc.data.providers).map(([k, p]) => (
                <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0', borderBottom: '1px solid var(--line-soft)' }}>
                  <b style={{ flex: 1 }}>{p.label}</b>
                  {p.account ? <><span className="small-muted">{p.account.email} · {p.account.status}{p.account.lastSyncAt ? ` · read ${ago(p.account.lastSyncAt)}` : ''}</span><button type="button" className="btn btn-sm" onClick={() => disconnect(k)}>Disconnect</button></>
                    : (p.ready ? <button type="button" className="btn btn-sm btn-primary" onClick={() => connect(k)}>Connect</button> : <span className="small-muted" style={{ fontSize: 12 }}>{p.reason}</span>)}
                </div>
              ))}
              <div className="small-muted" style={{ fontSize: 12, marginTop: 6 }}>Your own IMAP mailbox (Outreach tools → My mailbox) and the shared inbox are read too.</div>
            </>
          )}
        </div>
      </div>
      <div className="card" style={{ padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}><div className="section-label" style={{ margin: 0, flex: 1 }}>Templates</div>{me.canEdit && <button type="button" className="btn btn-sm" onClick={() => setEdit({ name: '', channel: 'email', subject: '', body: 'Hi {first_name},\n\n\n\nRegards,\n{sender}', shared: false })}>+ Template</button>}</div>
        {tpl.data && !tpl.data.templates.length && <div className="small-muted">No templates yet.</div>}
        {(tpl.data ? tpl.data.templates : []).map((t) => (
          <div key={t.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--line-soft)', display: 'flex', gap: 6, alignItems: 'center' }}>
            <div style={{ flex: 1, minWidth: 0 }}><b>{t.name}</b> <span className="small-muted">· {t.channel}{t.shared ? ' · whole team' : ''} · used {t.uses}×</span><div className="small-muted" style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.subject || t.body}</div></div>
            {t.canEdit && <><button type="button" className="btn btn-sm" onClick={() => setEdit({ ...t, shared: !!t.shared })}>Edit</button><button type="button" className="btn btn-sm" onClick={() => delTpl(t)}>Delete</button></>}
          </div>
        ))}
        {tpl.data && <div className="small-muted" style={{ fontSize: 11.5, marginTop: 6 }}>Merge fields: {tpl.data.mergeFields.join(' ')}</div>}
        {edit && (
          <div className="card" style={{ padding: 10, marginTop: 10 }}>
            <div className="grid-2"><div className="field"><label>Name</label><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
              <div className="field"><label>For</label><select value={edit.channel} onChange={(e) => setEdit({ ...edit, channel: e.target.value })}><option value="email">Email</option><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option></select></div></div>
            {edit.channel === 'email' && <div className="field"><label>Subject</label><input value={edit.subject || ''} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} /></div>}
            <div className="field"><label>Message</label><textarea rows={6} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></div>
            {me.canAssign && <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 500 }}><input type="checkbox" checked={!!edit.shared} onChange={(e) => setEdit({ ...edit, shared: e.target.checked })} style={{ width: 'auto' }} /> For the whole sales team</label>}
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}><button type="button" className="btn btn-primary btn-sm" onClick={saveTpl}>Save</button><button type="button" className="btn btn-sm" onClick={() => setEdit(null)}>Cancel</button></div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function CrmInbox() {
  const [sp] = useSearchParams();
  const [tab, setTab] = useState(['chat', 'team', 'scheduled', 'mymail'].includes(sp.get('sub')) ? sp.get('sub') : 'all');
  const { data } = useLoad('/crm/b/inbox', { waiting: '1' });
  const c = data ? data.counts : {};
  return (
    <div>
      <SubTabs value={tab} onChange={setTab} tabs={[['all', 'Conversations', c.waiting], ['chat', 'Website chat', c.chatUnread || c.chats], ['team', 'Team mailbox', c.teamMail], ['scheduled', 'Scheduled'], ['mymail', 'My mail settings']]} />
      {tab === 'all' && <Conversations />}
      {tab === 'chat' && <Chats />}
      {tab === 'team' && <TeamMail />}
      {tab === 'scheduled' && <Scheduled />}
      {tab === 'mymail' && <MyMail />}
    </div>
  );
}
