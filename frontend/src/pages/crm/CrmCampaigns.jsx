// CRM > CAMPAIGNS (2026-11-02, from the founder's reference CRM). Shown as the "Campaigns" tab of Leads. One message to many
// leads or contacts by email or WhatsApp: choose who (with a live count of who can be reached), write the message with
// {first_name} {company} ..., send yourself a test, then send. Every person's result is kept (sent / failed / skipped and
// why). A sales manager / Admin sends; a salesperson reads. The rules are on the server (backend/src/crm/campaigns.js).
import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { useCrm, errOf, dateTimeOf } from './crmShared.jsx';

const ST_CLASS = { Draft: 'review', Sending: 'pending', Sent: 'joined', Cancelled: 'rejected' };
const R_CLASS = { sent: 'joined', failed: 'rejected', skipped: 'review', queued: 'pending' };
const FIELDS = ['{first_name}', '{name}', '{company}', '{city}', '{sender}'];

function CampaignForm({ row, onClose, onDone }) {
  const { me, toast } = useCrm();
  const L = me.lists;
  const [f, setF] = useState(() => (row ? { ...row } : {
    name: '', channel: 'email', subject: 'Hiring support for {company}', waTemplate: '', waLanguage: 'en',
    body: 'Hi {first_name},\n\nTeamLink Consultants helps companies like {company} hire the right people faster - IT, non-IT, healthcare and manufacturing roles, with a replacement guarantee.\n\nCould we have a 10-minute call this week about your open positions?\n\nRegards,\n{sender}\nTeamLink Consultants',
    audience: { kind: 'leads', status: 'open', source: '', rating: '', city: '', industry: '', role: '', accountKind: '', owner: '' },
  }));
  const [pv, setPv] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setA = (k, v) => setF((x) => ({ ...x, audience: { ...x.audience, [k]: v } }));
  useEffect(() => {
    const t = setTimeout(() => api.post('/crm/campaigns/preview', { channel: f.channel, audience: f.audience }).then((r) => setPv(r.data)).catch(() => setPv(null)), 300);
    return () => clearTimeout(t);
  }, [f.channel, JSON.stringify(f.audience)]); // eslint-disable-line react-hooks/exhaustive-deps
  async function save() {
    setBusy(true); setErr('');
    try { const r = row ? await api.put(`/crm/campaigns/${row.id}`, f) : await api.post('/crm/campaigns', f); toast('Campaign saved as a draft.'); onDone(r.data.campaign); } catch (e) { setErr(errOf(e, 'The campaign could not be saved.')); } finally { setBusy(false); }
  }
  const a = f.audience;
  const sample = { name: 'Ravi Kumar', company: 'Acme Pvt Ltd', city: 'Hyderabad' };
  const show = (txt) => String(txt || '').replace(/\{first_name\}/gi, 'Ravi').replace(/\{name\}/gi, sample.name).replace(/\{company\}/gi, sample.company).replace(/\{city\}/gi, sample.city).replace(/\{sender\}/gi, me.name || '');
  return (
    <Modal title={row ? 'Edit campaign' : 'New campaign'} size="xwide" onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save draft'}</button></>}>
      <div className="grid-3">
        <div className="field" style={{ gridColumn: 'span 2' }}><label>Campaign name *</label><input type="text" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="For example: November - manufacturing companies" /></div>
        <div className="field"><label>Send by</label><select value={f.channel} onChange={(e) => set('channel', e.target.value)}><option value="email">Email</option><option value="whatsapp">WhatsApp</option></select></div>
      </div>
      <div className="section-label">1. Who gets it</div>
      <div className="grid-3">
        <div className="field"><label>People</label><select value={a.kind} onChange={(e) => setA('kind', e.target.value)}><option value="leads">Leads</option><option value="contacts">Contacts (people at accounts)</option></select></div>
        {a.kind === 'leads' ? (
          <>
            <div className="field"><label>Lead status</label><select value={a.status} onChange={(e) => setA('status', e.target.value)}><option value="open">Open leads</option>{L.leadStatuses.map((s) => <option key={s} value={s}>{s}</option>)}<option value="all">All</option></select></div>
            <div className="field"><label>Source</label><select value={a.source} onChange={(e) => setA('source', e.target.value)}><option value="">Any</option>{L.sources.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
            <div className="field"><label>Rating</label><select value={a.rating} onChange={(e) => setA('rating', e.target.value)}><option value="">Any</option>{L.ratings.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
          </>
        ) : (
          <>
            <div className="field"><label>Role</label><select value={a.role} onChange={(e) => setA('role', e.target.value)}><option value="">Any</option>{L.contactRoles.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
            <div className="field"><label>Account type</label><select value={a.accountKind} onChange={(e) => setA('accountKind', e.target.value)}><option value="">Prospects and customers</option><option value="Prospect">Prospects</option><option value="Client">Customers</option></select></div>
          </>
        )}
        <div className="field"><label>City</label><input type="text" value={a.city} onChange={(e) => setA('city', e.target.value)} /></div>
        <div className="field"><label>Industry</label><input type="text" value={a.industry} onChange={(e) => setA('industry', e.target.value)} /></div>
        <div className="field"><label>Whose</label><select value={a.owner} onChange={(e) => setA('owner', e.target.value)}><option value="">The whole sales team</option>{me.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
      </div>
      <div className="notice" style={{ marginBottom: 6 }}>
        {pv ? <><b>{pv.reachable}</b> will get it · {pv.total} match{pv.tooMany ? ' (too many: at most 2000)' : ''} · {pv.noAddress} without {f.channel === 'email' ? 'an email' : 'a mobile number'} · {pv.optedOut} opted out</> : 'Counting…'}
      </div>
      <div className="section-label">2. The message</div>
      <div className="small-muted" style={{ marginBottom: 6 }}>Fill-ins: {FIELDS.map((x) => <code key={x} style={{ marginRight: 6 }}>{x}</code>)}</div>
      <div className="crm-two">
        <div>
          {f.channel === 'email' && <div className="field"><label>Subject *</label><input type="text" value={f.subject || ''} onChange={(e) => set('subject', e.target.value)} /></div>}
          {f.channel === 'whatsapp' && (
            <div className="grid-2">
              <div className="field"><label>Approved template name (optional)</label><input type="text" value={f.waTemplate || ''} onChange={(e) => set('waTemplate', e.target.value)} placeholder="sales_intro" /></div>
              <div className="field"><label>Template language</label><input type="text" value={f.waLanguage || 'en'} onChange={(e) => set('waLanguage', e.target.value)} /></div>
            </div>
          )}
          <div className="field"><label>Message *</label><textarea rows={10} value={f.body} onChange={(e) => set('body', e.target.value)} /></div>
          {f.channel === 'whatsapp' && <div className="small-muted">With a template, its {'{{1}}'} gets the first name and {'{{2}}'} the company. WhatsApp only lets a business start a chat with an approved template.</div>}
        </div>
        <div>
          <label>Preview (for Ravi Kumar, Acme Pvt Ltd)</label>
          <div className="card" style={{ padding: 12, fontSize: 13, whiteSpace: 'pre-wrap', minHeight: 200 }}>
            {f.channel === 'email' && <div style={{ fontWeight: 600, marginBottom: 8 }}>{show(f.subject)}</div>}
            {show(f.body)}
            {f.channel === 'email' && <div className="small-muted" style={{ marginTop: 10 }}>--{'\n'}Not interested? Unsubscribe: (a personal link)</div>}
          </div>
        </div>
      </div>
      {err && <div className="small-muted" role="alert" style={{ color: 'var(--red)' }}>{err}</div>}
    </Modal>
  );
}

function CampaignView({ id, onClose, onChanged, onEdit }) {
  const { me, toast } = useCrm();
  const [d, setD] = useState(null);
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState(false);
  const load = () => api.get(`/crm/campaigns/${id}`).then((r) => setD(r.data)).catch((e) => toast(errOf(e, 'The campaign could not be opened.')));
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!d || d.campaign.status !== 'Sending') return undefined; const t = setTimeout(load, 3000); return () => clearTimeout(t); }, [d]); // eslint-disable-line react-hooks/exhaustive-deps
  async function act(what, body) {
    setBusy(what);
    try {
      const r = await api.post(`/crm/campaigns/${id}/${what}`, body || {});
      if (what === 'test') toast(`Test sent to ${r.data.sentTo}.`);
      if (what === 'send') toast(`Sending to ${r.data.toSend} people (${r.data.skipped} skipped).`);
      if (what === 'cancel') { toast(r.data.deleted ? 'Draft deleted.' : 'Campaign stopped.'); if (r.data.deleted) { onChanged(); onClose(); return; } }
      setConfirm(false); load(); onChanged();
    } catch (e) { toast(errOf(e, 'This did not work.')); } finally { setBusy(''); }
  }
  const c = d && d.campaign;
  const done = c ? c.sent + c.failed + c.skipped : 0;
  return (
    <Modal title={c ? c.name : 'Campaign'} size="xwide" onClose={onClose}>
      {!d && <div className="small-muted">Loading…</div>}
      {d && (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
            <span className={`status ${ST_CLASS[c.status]}`}>{c.status}</span>
            <span className="small-muted">{c.channel === 'email' ? 'Email' : 'WhatsApp'} · by {c.ownerName || '—'} · {dateTimeOf(c.startedAt || c.createdAt)}</span>
            {d.canEdit && c.status === 'Draft' && <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => onEdit(c)}>Edit</button>}
          </div>
          {c.status !== 'Draft' && (
            <div className="statbar">
              <div className="statitem"><div className="n">{c.total}</div><div className="l">People</div></div>
              <div className="statitem"><div className="n" style={{ color: 'var(--teal)' }}>{c.sent}</div><div className="l">Sent</div></div>
              <div className="statitem"><div className="n" style={{ color: c.failed ? 'var(--red)' : undefined }}>{c.failed}</div><div className="l">Failed</div></div>
              <div className="statitem"><div className="n">{c.skipped}</div><div className="l">Skipped</div></div>
              {c.status === 'Sending' && <div className="statitem"><div className="n">{c.total - done}</div><div className="l">Waiting</div></div>}
            </div>
          )}
          <div className="card" style={{ padding: 12, fontSize: 13, whiteSpace: 'pre-wrap', marginBottom: 12 }}>
            {c.subject && <div style={{ fontWeight: 600, marginBottom: 6 }}>{c.subject}</div>}{c.body}
          </div>
          {d.canEdit && c.status === 'Draft' && (
            <div className="card" style={{ padding: 12, marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input type={c.channel === 'email' ? 'email' : 'tel'} placeholder={c.channel === 'email' ? 'Your email, for a test' : 'Your WhatsApp number, for a test'} value={to} onChange={(e) => setTo(e.target.value)} style={{ maxWidth: 280 }} aria-label="Test address" />
              <button type="button" className="btn btn-sm" disabled={!to || !!busy} onClick={() => act('test', { to })}>{busy === 'test' ? 'Sending…' : 'Send me a test'}</button>
              <span style={{ flex: 1 }} />
              <button type="button" className="btn btn-sm btn-danger" disabled={!!busy} onClick={() => act('cancel')}>Delete draft</button>
              <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => setConfirm(true)}>Send now…</button>
            </div>
          )}
          {d.canEdit && c.status === 'Sending' && <button type="button" className="btn btn-danger btn-sm" style={{ marginBottom: 10 }} disabled={!!busy} onClick={() => act('cancel')}>Stop sending</button>}
          {d.recipients.length > 0 && (
            <div className="tbl-wrap" style={{ maxHeight: 360, overflow: 'auto' }}>
              <table>
                <thead><tr><th>Person</th><th>Company</th><th>To</th><th>Result</th></tr></thead>
                <tbody>
                  {d.recipients.map((x) => (
                    <tr key={x.id}><td>{x.name || '—'}</td><td>{x.company || '—'}</td><td className="small-muted">{x.toAddr || '—'}</td><td><span className={`status ${R_CLASS[x.status]}`}>{x.status}</span>{x.error ? <span className="small-muted" style={{ fontSize: 11.5 }}> {x.error}</span> : null}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {confirm && (
            <Modal title="Send this campaign now?" onClose={() => setConfirm(false)} foot={<><button type="button" className="btn" onClick={() => setConfirm(false)}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy === 'send'} onClick={() => act('send')}>{busy === 'send' ? 'Starting…' : 'Yes, send'}</button></>}>
              <p style={{ marginTop: 0 }}>The {c.channel === 'email' ? 'email' : 'WhatsApp message'} goes to everybody in the audience who can be reached, a few a second. People without an address, and people who opted out, are skipped. This cannot be undone once a message has gone.</p>
            </Modal>
          )}
        </>
      )}
    </Modal>
  );
}

export default function CrmCampaigns() {
  const [d, setD] = useState(null);
  const [form, setForm] = useState(null); // { row } | {}
  const [openId, setOpenId] = useState(null);
  const load = () => api.get('/crm/campaigns').then((r) => setD(r.data)).catch(() => setD({ rows: [], canEdit: false }));
  useEffect(() => { load(); }, []);
  return (
    <div>
      <div className="filter-row">
        <span className="small-muted">Email or WhatsApp to many leads / contacts at once, with an unsubscribe link and a result for every person.</span>
        {d && d.canEdit && <button type="button" className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setForm({})}>+ Campaign</button>}
      </div>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Campaign</th><th>By</th><th>Status</th><th style={{ textAlign: 'right' }}>People</th><th style={{ textAlign: 'right' }}>Sent</th><th style={{ textAlign: 'right' }}>Failed</th><th>When</th></tr></thead>
          <tbody>
            {!d && <tr><td colSpan={7} className="small-muted">Loading…</td></tr>}
            {d && !d.rows.length && <tr><td colSpan={7}><div className="empty"><h3>No campaigns yet</h3>{d.canEdit ? 'Make one with "+ Campaign".' : 'Your sales manager sends campaigns.'}</div></td></tr>}
            {d && d.rows.map((c) => (
              <tr key={c.id} className="row-link" onClick={() => setOpenId(c.id)}>
                <td><b>{c.name}</b><div className="small-muted" style={{ fontSize: 11.5 }}>{c.channel === 'email' ? '✉️ Email' : '💬 WhatsApp'} · {c.audience.kind === 'contacts' ? 'Contacts' : 'Leads'}</div></td>
                <td>{c.ownerName || '—'}</td>
                <td><span className={`status ${ST_CLASS[c.status]}`}>{c.status}</span></td>
                <td style={{ textAlign: 'right' }}>{c.total || '—'}</td>
                <td style={{ textAlign: 'right' }}>{c.sent || '—'}</td>
                <td style={{ textAlign: 'right', color: c.failed ? 'var(--red)' : undefined }}>{c.failed || '—'}</td>
                <td className="small-muted">{dateTimeOf(c.startedAt || c.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {form && <CampaignForm row={form.row} onClose={() => setForm(null)} onDone={(c) => { setForm(null); load(); setOpenId(c.id); }} />}
      {openId && <CampaignView id={openId} onClose={() => setOpenId(null)} onChanged={load} onEdit={(c) => { setOpenId(null); setForm({ row: c }); }} />}
    </div>
  );
}
