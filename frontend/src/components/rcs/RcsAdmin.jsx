import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import Combo from '../Combo.jsx';
import '../comm/comm.css';
import '../comm/smsPlatform.css';

// ---------------------------------------------------------------------------
// RCS (Administration > Integrations > RCS). Admin / Super Admin. Server: /api/rcs (routes/rcs.js).
// Five small screens: Status, Test send, Templates, Message log, Settings.
// No password, client secret or webhook token is ever on this page: they live in backend/.env (set-rcs-credentials-on-vps.ps1).
// Words: "Sent" = rcssms.in gave a message id. "Delivered" only when its own report says so.
// ---------------------------------------------------------------------------
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const fmt = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const TYPE_WORD = { BASIC: 'Basic', RICH: 'Rich card', RICHCASOUREL: 'Carousel' };
const STATUS_PILL = { APPROVED: 'delivered', PENDING: 'queued', REJECTED: 'failed', Queued: 'queued', Sent: 'sent', Delivered: 'delivered', Failed: 'failed' };
const STATUS_WORD = { APPROVED: 'Approved', PENDING: 'Waiting for approval', REJECTED: 'Rejected' };
const Pill = ({ s }) => <span className={`cm-pill ${STATUS_PILL[s] || 'queued'}`}>{STATUS_WORD[s] || s}</span>;
const todayStr = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

function Field({ label, children, hint }) {
  return (
    <div className="sp-field">
      <label>{label}</label>
      {children}
      {hint && <div className="cm-help">{hint}</div>}
    </div>
  );
}

// ---- Status --------------------------------------------------------------------
function StatusTab({ d, reload, onGoTest }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  if (!d) return null;
  const c = d.config || {};
  const resume = async () => {
    setBusy(true);
    try { const r = await api.post('/rcs/queue/resume'); setNote({ ok: true, text: `Resumed: ${r.data.resumed} send(s) waiting again.` }); reload(); } catch (e) { setNote({ ok: false, text: errOf(e, 'Could not resume.') }); } finally { setBusy(false); }
  };
  return (
    <div>
      <div className="cm-card">
        <div className="cm-cardhead"><h3>RCS status</h3></div>
        <div className="cm-grid">
          <div className="cm-stat"><b>{c.configured ? 'Set up' : 'Not set up'}</b><span>Server settings</span></div>
          <div className="cm-stat"><b>{d.proven ? 'Proven' : 'Not proven yet'}</b><span>Real test send</span></div>
          <div className="cm-stat"><b>{d.may.bulk ? 'Open' : 'Locked'}</b><span>Send to many</span></div>
          <div className="cm-stat"><b>{d.queue.waiting}</b><span>Waiting in the queue</span></div>
        </div>
        {c.problems && c.problems.length > 0 && <ul className="sp-list">{c.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        {c.warnings && c.warnings.length > 0 && <div className="notice orange" style={{ marginTop: 8 }}><span>{c.warnings.join(' ')}</span></div>}
        {d.queue.paused && (
          <div className="notice red" style={{ marginTop: 8 }}>
            <span>Sending is PAUSED since {fmt(d.queue.paused.at)}: {d.queue.paused.reason}</span>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={resume}>Resume</button>
          </div>
        )}
        {note && <div className={`cm-line ${note.ok ? 'cm-green' : 'cm-orange'}`}>{note.text}</div>}
        <div className="cm-help">Last message rcssms.in accepted: {d.lastAccepted ? `${fmt(d.lastAccepted.at)} (id ${d.lastAccepted.ref})` : 'none yet'}</div>
        <div className="cm-help">Real test send: {d.proven ? `accepted ${fmt(d.proven.at)} (id ${d.proven.ref})` : 'not done yet. Sending to many people stays locked until one test RCS to your own number is accepted.'}</div>
        <div className="cm-btnrow"><button type="button" className="btn btn-primary" onClick={onGoTest}>Test send</button></div>
      </div>
      <div className="cm-card">
        <div className="cm-cardhead"><h3>Server settings (backend/.env)</h3></div>
        <div className="cm-grid">
          <div className="cm-stat"><b>{c.host || '—'}</b><span>Provider address</span></div>
          <div className="cm-stat"><b>{c.mode === 'token' ? 'Token' : 'Password'}</b><span>Login kind</span></div>
          <div className="cm-stat"><b>{c.usernameSet ? 'Saved' : 'Missing'}</b><span>Username</span></div>
          <div className="cm-stat"><b>{c.mode === 'token' ? (c.clientSecretSet ? 'Saved' : 'Missing') : (c.passwordSet ? 'Saved' : 'Missing')}</b><span>{c.mode === 'token' ? 'Client secret' : 'Password'}</span></div>
          <div className="cm-stat"><b>{c.rcsIdSet ? 'Saved' : 'Missing'}</b><span>RCS ID</span></div>
          <div className="cm-stat"><b>{c.sendApiType || 'Not set'}</b><span>apitype (same message)</span></div>
          <div className="cm-stat"><b>{c.personalApiType || 'Not set'}</b><span>apitype (per person)</span></div>
          {c.mode === 'token' && <div className="cm-stat"><b>{c.tokenMethod}</b><span>Token method</span></div>}
        </div>
        <div className="cm-help">These are typed only on the server, never here. Live site: run <code>.\set-rcs-credentials-on-vps.ps1</code> on your PC. This PC: <code>.\set-rcs-credentials-on-vps.ps1 -Local</code>.</div>
      </div>
      {d.webhook && (
        <div className="cm-card">
          <div className="cm-cardhead"><h3>Webhook (template approvals + delivery reports)</h3></div>
          <div className="cm-help">Give rcssms.in this address. The token part is in backend/.env ({d.webhook.secretSet ? 'it is saved' : 'it is NOT saved yet'}); the credentials script shows the full address once.</div>
          <div className="sp-code"><code>{d.webhook.url}</code></div>
          <div className="cm-help">Calls received: {d.webhook.calls}{d.webhook.lastAt ? ` · last ${fmt(d.webhook.lastAt)}` : ''}{d.webhook.lastRejectedAt ? ` · last call with a wrong token ${fmt(d.webhook.lastRejectedAt)}` : ''}</div>
          <WebhookRaw />
        </div>
      )}
    </div>
  );
}

function WebhookRaw() {
  const [rows, setRows] = useState(null);
  const load = () => api.get('/rcs/webhook-raw').then((r) => setRows(r.data)).catch(() => setRows([]));
  return (
    <div style={{ marginTop: 6 }}>
      <button type="button" className="btn btn-sm" onClick={load}>Show what rcssms.in sent</button>
      {rows && (rows.length === 0 ? <div className="cm-help">Nothing has come yet.</div> : (
        <div className="sp-scroll" style={{ maxHeight: 260, marginTop: 6 }}>
          {rows.map((r, i) => <div key={i} className="sp-preview sp-small"><b>{fmt(r.at)}</b> {r.contentType}<br />{r.body}</div>)}
        </div>
      ))}
    </div>
  );
}

// ---- Test send -----------------------------------------------------------------
function TestTab({ reload }) {
  const [f, setF] = useState({ number: '', templateId: '22SVkoeCBF', rcstype: 'BASIC', var1: '', var2: '', var3: '', buttonUrl: '', imageUrl: '' });
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const send = async () => {
    setBusy(true); setRes(null);
    const variables = Object.fromEntries(['var1', 'var2', 'var3'].filter((k) => f[k].trim()).map((k) => [k, f[k].trim()]));
    try {
      const r = await api.post('/rcs/test-send', { number: f.number, templateId: f.templateId, rcstype: f.rcstype, variables, buttonUrl: f.buttonUrl, imageUrl: f.imageUrl });
      setRes(r.data); reload();
    } catch (e) { setRes({ ok: false, error: errOf(e, 'Not sent.') }); } finally { setBusy(false); }
  };
  return (
    <div className="cm-card">
      <div className="cm-cardhead"><h3>Test send: ONE number</h3></div>
      <div className="cm-help">Send to your own number first. You see rcssms.in&apos;s real answer, and the message is saved in the Message log. Sending to many opens only after this is accepted.</div>
      <div className="cm-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <Field label="Mobile number"><input value={f.number} onChange={(e) => set('number', e.target.value)} placeholder="98xxxxxxxx" inputMode="tel" /></Field>
        <Field label="Template id (from rcssms.in)"><input value={f.templateId} onChange={(e) => set('templateId', e.target.value)} /></Field>
        <Field label="Template type">
          <Combo value={f.rcstype} onChange={(e) => set('rcstype', e.target.value)}>
            <option value="BASIC">Basic</option><option value="RICH">Rich card</option><option value="RICHCASOUREL">Carousel</option>
          </Combo>
        </Field>
        <Field label="Blank 1 (var1)"><input value={f.var1} onChange={(e) => set('var1', e.target.value)} /></Field>
        <Field label="Blank 2 (var2)"><input value={f.var2} onChange={(e) => set('var2', e.target.value)} /></Field>
        <Field label="Blank 3 (var3)"><input value={f.var3} onChange={(e) => set('var3', e.target.value)} /></Field>
        <Field label="Button link (if the template has one)"><input value={f.buttonUrl} onChange={(e) => set('buttonUrl', e.target.value)} placeholder="https://" /></Field>
        <Field label="Card image link (rich card only)"><input value={f.imageUrl} onChange={(e) => set('imageUrl', e.target.value)} placeholder="https://" /></Field>
      </div>
      <div className="cm-btnrow"><button type="button" className="btn btn-primary" disabled={busy || !f.number.trim() || !f.templateId.trim()} onClick={send}>{busy ? 'Sending…' : 'Send test RCS'}</button></div>
      {res && (
        <div className={`notice ${res.ok ? 'green' : 'red'}`} style={{ marginTop: 8, display: 'block' }}>
          <div>{res.ok ? `rcssms.in accepted it: message id ${res.msgId} to ${res.number}.${res.proven ? ' Sending to many is now open.' : ''}` : `Not sent: ${res.error}`}</div>
          {res.providerAnswer && <div className="sp-small" style={{ marginTop: 4 }}>rcssms.in answered: <code>{res.providerAnswer}</code></div>}
          {res.ok && <div className="cm-help">Accepted is not delivered: the Message log shows Delivered only when rcssms.in&apos;s report comes.</div>}
        </div>
      )}
    </div>
  );
}

// ---- Templates -----------------------------------------------------------------
const blankTpl = { mode: 'create', rcstype: 'BASIC', cname: '', description: '', module: '', media_url: '', mediaheight: 'Medium', cardorientation: 'Vertical', title: '', replies: '', actions: [], promotional: false, buttonLink: false, imageLink: false, varCount: '', cards: 1, templateId: '', status: 'PENDING', fbText: '', fbDlt: '' };
function TemplateForm({ edit, onClose, onSaved }) {
  const [f, setF] = useState(() => (edit ? {
    ...blankTpl, mode: 'edit', cname: edit.name, module: edit.module || '', status: edit.status, promotional: edit.promotional, buttonLink: edit.hasButtonLink, imageLink: edit.hasImageLink,
    varCount: String(edit.varCount), cards: edit.cards, fbText: edit.fallback ? edit.fallback.text : '', fbDlt: edit.fallback ? edit.fallback.dltTemplateId : '', description: edit.description || '',
  } : blankTpl));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setAct = (i, k, v) => setF((x) => ({ ...x, actions: x.actions.map((a, j) => (j === i ? { ...a, [k]: v } : a)) }));
  const save = async () => {
    setBusy(true); setErr('');
    const common = { module: f.module || null, promotional: f.promotional, buttonLink: f.buttonLink, imageLink: f.imageLink, cards: Number(f.cards) || 1, fallback: { text: f.fbText, dltTemplateId: f.fbDlt }, ...(f.varCount !== '' ? { varCount: Number(f.varCount) } : {}) };
    try {
      if (f.mode === 'edit') await api.patch(`/rcs/templates/${edit.id}`, { ...common, name: f.cname, status: f.status, description: f.description });
      else if (f.mode === 'register') await api.post('/rcs/templates/register', { ...common, templateId: f.templateId, name: f.cname, rcstype: f.rcstype, status: f.status, description: f.description });
      else {
        await api.post('/rcs/templates', {
          ...common, rcstype: f.rcstype, cname: f.cname, description: f.description, media_url: f.media_url, mediaheight: f.mediaheight, cardorientation: f.cardorientation, title: f.title,
          reply: f.replies.split('\n').map((t) => ({ text: t.trim() })).filter((r) => r.text), action: f.actions,
        });
      }
      onSaved();
    } catch (e) { setErr(errOf(e, 'Not saved.')); } finally { setBusy(false); }
  };
  const rich = f.mode === 'create' && f.rcstype === 'RICH';
  return (
    <Modal title={f.mode === 'edit' ? `Template: ${edit.name}` : 'Add an RCS template'} onClose={onClose} size="wide"
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : f.mode === 'create' ? 'Send to rcssms.in for approval' : 'Save'}</button></>}>
      {f.mode !== 'edit' && (
        <div className="cm-tabs" style={{ marginBottom: 10 }}>
          <button type="button" className={f.mode === 'create' ? 'on' : ''} onClick={() => set('mode', 'create')}>Make a new one</button>
          <button type="button" className={f.mode === 'register' ? 'on' : ''} onClick={() => set('mode', 'register')}>Add one already on rcssms.in</button>
        </div>
      )}
      <div className="cm-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        {f.mode === 'register' && <Field label="Template id (as rcssms.in shows it)"><input value={f.templateId} onChange={(e) => set('templateId', e.target.value)} /></Field>}
        {f.mode !== 'edit' && (
          <Field label="Type">
            <Combo value={f.rcstype} onChange={(e) => set('rcstype', e.target.value)}>
              <option value="BASIC">Basic (text)</option><option value="RICH">Rich card (image + title)</option>{f.mode === 'register' && <option value="RICHCASOUREL">Carousel</option>}
            </Combo>
          </Field>
        )}
        <Field label="Name"><input value={f.cname} onChange={(e) => set('cname', e.target.value)} /></Field>
        <Field label="Module">
          <Combo value={f.module} onChange={(e) => set('module', e.target.value)}>
            <option value="">Every module</option><option value="ATS">ATS</option><option value="HRMS">HRMS</option><option value="Accounts">Accounts</option>
          </Combo>
        </Field>
        {f.mode !== 'create' && (
          <Field label="Status" hint="Only if you saw it on rcssms.in. Normally rcssms.in's webhook changes it.">
            <Combo value={f.status} onChange={(e) => set('status', e.target.value)}>
              <option value="PENDING">Waiting for approval</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option>
            </Combo>
          </Field>
        )}
      </div>
      {(f.mode !== 'edit' || edit.source === 'rcssms') && <Field label="Message text" hint="Blanks as rcssms.in writes them, for example {#var1#}. The preview on the send screen fills them in."><textarea rows={4} value={f.description} onChange={(e) => set('description', e.target.value)} /></Field>}
      {rich && (
        <>
          <div className="cm-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
            <Field label="Title"><input value={f.title} onChange={(e) => set('title', e.target.value)} /></Field>
            <Field label="Image / video link"><input value={f.media_url} onChange={(e) => set('media_url', e.target.value)} placeholder="https://" /></Field>
            <Field label="Image height"><Combo value={f.mediaheight} onChange={(e) => set('mediaheight', e.target.value)}><option>Low</option><option>Medium</option><option>High</option></Combo></Field>
            <Field label="Card layout"><Combo value={f.cardorientation} onChange={(e) => set('cardorientation', e.target.value)}><option>Vertical</option><option>Horizontal</option></Combo></Field>
          </div>
          <Field label="Quick replies (one per line, up to 4 with the buttons)"><textarea rows={2} value={f.replies} onChange={(e) => set('replies', e.target.value)} /></Field>
          <h4 className="sp-h4">Buttons</h4>
          {f.actions.map((a, i) => (
            <div key={i} className="cm-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', marginBottom: 6 }}>
              <Combo value={a.type} onChange={(e) => setAct(i, 'type', e.target.value)}>
                <option value="plain_dial">Call</option><option value="plain_open_url">Open a link</option><option value="plain_create_calendar">Add to calendar</option><option value="plain_view_location">Show location</option>
              </Combo>
              <input value={a.text || ''} onChange={(e) => setAct(i, 'text', e.target.value)} placeholder="Button words" />
              {a.type === 'plain_dial' && <input value={a.phone || ''} onChange={(e) => setAct(i, 'phone', e.target.value)} placeholder="Phone number" />}
              {a.type === 'plain_open_url' && <input value={a.url || ''} onChange={(e) => setAct(i, 'url', e.target.value)} placeholder="https://" />}
              {a.type === 'plain_create_calendar' && <><input value={a.startTime || ''} onChange={(e) => setAct(i, 'startTime', e.target.value)} placeholder="Start (as rcssms.in wants)" /><input value={a.endTime || ''} onChange={(e) => setAct(i, 'endTime', e.target.value)} placeholder="End" /></>}
              {a.type === 'plain_view_location' && <><input value={a.latitude || ''} onChange={(e) => setAct(i, 'latitude', e.target.value)} placeholder="Latitude" /><input value={a.longitude || ''} onChange={(e) => setAct(i, 'longitude', e.target.value)} placeholder="Longitude" /></>}
              <button type="button" className="btn btn-sm" onClick={() => setF((x) => ({ ...x, actions: x.actions.filter((_, j) => j !== i) }))}>Remove</button>
            </div>
          ))}
          {f.actions.length < 4 && <button type="button" className="btn btn-sm" onClick={() => setF((x) => ({ ...x, actions: [...x.actions, { type: 'plain_open_url', text: '' }] }))}>+ Add a button</button>}
        </>
      )}
      <h4 className="sp-h4">How it is sent</h4>
      <div className="cm-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <Field label="Number of blanks (var1, var2 …)" hint="Empty = counted from the text."><input value={f.varCount} onChange={(e) => set('varCount', e.target.value.replace(/\D/g, ''))} inputMode="numeric" /></Field>
        {f.rcstype === 'RICHCASOUREL' && <Field label="Cards in the carousel"><input value={f.cards} onChange={(e) => set('cards', e.target.value.replace(/\D/g, ''))} inputMode="numeric" /></Field>}
      </div>
      <label className="sp-check"><input type="checkbox" checked={f.promotional} onChange={(e) => set('promotional', e.target.checked)} /> Promotional (offers, new jobs): only candidates whose consent is "Given" get it</label>
      <label className="sp-check"><input type="checkbox" checked={f.buttonLink} onChange={(e) => set('buttonLink', e.target.checked)} /> It has a link button whose address is given at sending</label>
      {(f.rcstype === 'RICH' || (edit && edit.rcsType === 'RICH')) && <label className="sp-check"><input type="checkbox" checked={f.imageLink} onChange={(e) => set('imageLink', e.target.checked)} /> The card image is given at sending</label>}
      <h4 className="sp-h4">SMS fallback (only used when the switch in Settings is on)</h4>
      <Field label="The approved SMS text" hint="Word for word as DLT approved it; {var1} {var2} are filled from the RCS blanks."><textarea rows={2} value={f.fbText} onChange={(e) => set('fbText', e.target.value)} /></Field>
      <Field label="Its DLT Template ID"><input value={f.fbDlt} onChange={(e) => set('fbDlt', e.target.value.replace(/\D/g, ''))} inputMode="numeric" /></Field>
      {err && <div className="error-text">{err}</div>}
    </Modal>
  );
}

function TemplatesTab() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [form, setForm] = useState(null); // 'new' | template
  const [q, setQ] = useState('');
  const load = useCallback(() => api.get('/rcs/templates').then((r) => { setRows(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'Could not load the templates.'))), []);
  useEffect(() => { load(); }, [load]);
  const remove = async (t) => {
    if (!window.confirm(`Remove "${t.name}" from TeamLink? It stays on rcssms.in.`)) return;
    try { await api.delete(`/rcs/templates/${t.id}`); load(); } catch (e) { setErr(errOf(e, 'Not removed.')); }
  };
  const shown = (rows || []).filter((t) => !q || `${t.name} ${t.templateId} ${t.module || ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="cm-card">
      <div className="cm-cardhead"><h3>RCS templates</h3><button type="button" className="btn btn-primary" onClick={() => setForm('new')}>New template</button></div>
      <div className="cm-help">Only <b>Approved</b> templates can be sent. A new one is sent to rcssms.in and waits for their approval.</div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or template id…" style={{ maxWidth: 320, margin: '6px 0' }} />
      {err && <div className="error-text">{err}</div>}
      {!rows ? <div className="cm-help">Loading…</div> : shown.length === 0 ? <div className="cm-help">No templates yet. Add 22SVkoeCBF with &quot;New template&quot; &gt; &quot;Add one already on rcssms.in&quot;.</div> : (
        <div className="sp-scroll"><table>
          <thead><tr><th>Name</th><th>Template id</th><th>Type</th><th>Module</th><th>Status</th><th>Blanks</th><th>SMS fallback</th><th>Added</th><th /></tr></thead>
          <tbody>{shown.map((t) => (
            <tr key={t.id}>
              <td>{t.name}{t.promotional && <span className="cell-muted"> · promotional</span>}</td><td><code>{t.templateId}</code></td><td>{TYPE_WORD[t.rcsType] || t.rcsType}</td><td>{t.module || 'Every module'}</td>
              <td><Pill s={t.status} /></td><td>{t.varCount}{t.rcsType === 'RICHCASOUREL' ? ` × ${t.cards} cards` : ''}</td><td>{t.fallback ? 'Yes' : '—'}</td><td>{fmt(t.createdAt)}</td>
              <td className="sp-actions"><button type="button" className="btn btn-sm" onClick={() => setForm(t)}>Edit</button><button type="button" className="btn btn-sm" onClick={() => remove(t)}>Remove</button></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {form && <TemplateForm edit={form === 'new' ? null : form} onClose={() => setForm(null)} onSaved={() => { setForm(null); load(); }} />}
    </div>
  );
}

// ---- Message log ---------------------------------------------------------------
function LogTab() {
  const [f, setF] = useState({ module: '', status: '', from: daysAgo(6), to: todayStr(), q: '' });
  const [page, setPage] = useState(1);
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const params = useMemo(() => Object.fromEntries(Object.entries(f).filter(([, v]) => v)), [f]);
  useEffect(() => {
    const t = setTimeout(() => api.get('/rcs/logs', { params: { ...params, page } }).then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'Could not load the log.'))), 250);
    return () => clearTimeout(t);
  }, [params, page]);
  const set = (k, v) => { setF((x) => ({ ...x, [k]: v })); setPage(1); };
  const exportCsv = async () => {
    try {
      const r = await api.get('/rcs/logs.csv', { params, responseType: 'blob' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(r.data); a.download = 'rcs-message-log.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { setErr(errOf(e, 'Could not export.')); }
  };
  const pages = d ? Math.max(1, Math.ceil(d.total / d.size)) : 1;
  return (
    <div className="cm-card">
      <div className="cm-cardhead"><h3>RCS message log</h3><button type="button" className="btn" onClick={exportCsv}>Export</button></div>
      <div className="cm-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <Field label="Module"><Combo value={f.module} onChange={(e) => set('module', e.target.value)}><option value="">All modules</option><option>ATS</option><option>HRMS</option><option>Accounts</option><option>Test</option></Combo></Field>
        <Field label="Status"><Combo value={f.status} onChange={(e) => set('status', e.target.value)}><option value="">All</option><option value="queued">Queued</option><option value="sent">Sent</option><option value="delivered">Delivered</option><option value="failed">Failed</option></Combo></Field>
        <Field label="From"><input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} /></Field>
        <Field label="To"><input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} /></Field>
        <Field label="Number"><input value={f.q} onChange={(e) => set('q', e.target.value)} placeholder="Search by number…" inputMode="tel" /></Field>
      </div>
      {d && <div className="cm-help">{d.total} message{d.total === 1 ? '' : 's'}{Object.keys(d.counts).length ? ` · ${Object.entries(d.counts).map(([k, v]) => `${v} ${k}`).join(' · ')}` : ''}</div>}
      {err && <div className="error-text">{err}</div>}
      {d && d.rows.length > 0 && (
        <div className="sp-scroll"><table>
          <thead><tr><th>When</th><th>Module</th><th>Person</th><th>Number</th><th>Template</th><th>Status</th><th>Message id</th><th>Problem</th><th>SMS fallback</th><th>By</th></tr></thead>
          <tbody>{d.rows.map((r) => (
            <tr key={r.id}>
              <td>{fmt(r.at)}</td><td>{r.module}</td><td>{r.person || '—'}</td><td>{r.number}</td><td><code>{r.templateId}</code></td><td><Pill s={r.status} /></td>
              <td className="sp-small">{r.msgId || '—'}</td><td className="sp-words">{r.error ? `${r.errorCode ? `[${r.errorCode}] ` : ''}${r.error}` : '—'}</td>
              <td className="sp-words">{r.sms ? `${r.sms.status}${r.sms.error ? `: ${r.sms.error}` : ''}` : '—'}</td><td>{r.by || '—'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {d && pages > 1 && <div className="cm-btnrow"><button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><span className="cm-help">Page {page} of {pages}</span><button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button></div>}
    </div>
  );
}

// ---- Settings ------------------------------------------------------------------
function SettingsTab({ reload }) {
  const [s, setS] = useState(null);
  const [people, setPeople] = useState([]);
  const [q, setQ] = useState('');
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get('/rcs/settings').then((r) => setS(r.data)).catch(() => setS(null));
    api.get('/rcs/people').then((r) => setPeople(r.data)).catch(() => setPeople([]));
  }, []);
  if (!s) return <div className="cm-help">Loading…</div>;
  const toggle = (id) => setS((x) => ({ ...x, allowedUserIds: x.allowedUserIds.includes(id) ? x.allowedUserIds.filter((y) => y !== id) : [...x.allowedUserIds, id] }));
  const save = async () => {
    setBusy(true);
    try { const r = await api.put('/rcs/settings', s); setS(r.data); setNote({ ok: true, text: 'Saved.' }); reload(); } catch (e) { setNote({ ok: false, text: errOf(e, 'Not saved.') }); } finally { setBusy(false); }
  };
  const shown = people.filter((p) => !q || `${p.name} ${p.role} ${p.department}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="cm-card">
      <div className="cm-cardhead"><h3>RCS settings</h3><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></div>
      <label className="sp-check"><input type="checkbox" checked={s.smsFallback} onChange={(e) => setS({ ...s, smsFallback: e.target.checked })} /> SMS fallback: when an RCS fails, or is not delivered in time, send the template&apos;s SMS through the SMS gateway</label>
      <Field label="Hours to wait for delivery before the SMS"><input value={s.fallbackHours} onChange={(e) => setS({ ...s, fallbackHours: e.target.value.replace(/\D/g, '') })} inputMode="numeric" style={{ maxWidth: 100 }} /></Field>
      <div className="cm-help">Off by default. While rcssms.in&apos;s delivery report format is unconfirmed, every RCS may look &quot;not delivered&quot; and get an SMS too.</div>
      <h4 className="sp-h4">Who may send RCS ({s.allowedUserIds.length} ticked; Admins always may)</h4>
      <div className="cm-help">They still reach only the people their own role may contact, and many at once only with their bulk right.</div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a person…" style={{ maxWidth: 320, margin: '6px 0' }} />
      <div className="sp-scroll" style={{ maxHeight: 320 }}>
        {shown.map((p) => <label key={p.id} className="sp-check"><input type="checkbox" checked={s.allowedUserIds.includes(p.id)} onChange={() => toggle(p.id)} /> {p.name} <span className="cell-muted">{[p.role, p.department].filter(Boolean).join(' · ')}</span></label>)}
      </div>
      {note && <div className={`cm-line ${note.ok ? 'cm-green' : 'cm-orange'}`}>{note.text}</div>}
    </div>
  );
}

export default function RcsAdmin() {
  const [sub, setSub] = useState('status');
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => api.get('/rcs/status').then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'Could not load RCS.'))), []);
  useEffect(() => { load(); }, [load]);
  const tabs = [['status', 'Status'], ['test', 'Test send'], ['templates', 'Templates'], ['log', 'Message log'], ['settings', 'Settings']];
  return (
    <div className="cm-page" data-rcs>
      <div className="cm-tabs">{tabs.map(([k, l]) => <button key={k} type="button" className={sub === k ? 'on' : ''} onClick={() => setSub(k)}>{l}</button>)}</div>
      {err && <div className="error-text">{err}</div>}
      {sub === 'status' && <StatusTab d={d} reload={load} onGoTest={() => setSub('test')} />}
      {sub === 'test' && <TestTab reload={load} />}
      {sub === 'templates' && <TemplatesTab />}
      {sub === 'log' && <LogTab />}
      {sub === 'settings' && <SettingsTab reload={load} />}
    </div>
  );
}
