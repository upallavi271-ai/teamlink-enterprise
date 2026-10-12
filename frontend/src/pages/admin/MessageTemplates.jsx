import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api';
import { Modal } from '../../components/proto.jsx';
import JobProgress from '../../components/messaging/JobProgress.jsx';
import TokenPicker, { insertToken } from '../../components/messaging/TokenPicker.jsx';
import {
  useTokens, renderSample, smsInfo, unknownIn, CHANNEL_ICON, STATUS_CLASS, STATUS_WORD, WA_STATUS_CLASS, WA_STATUS_WORD,
} from '../../components/messaging/msgKit.js';
import AutomaticMessagesTab from '../../components/automsg/AutomaticMessagesTab.jsx'; // Automatic messages: a message at every step
import '../../components/messaging/messaging.css';

// ---------------------------------------------------------------------------
// ADMINISTRATION → COMPANY SETUP → MESSAGE TEMPLATES
//
//   Templates   the wording of every Email / SMS / WhatsApp message: edit with
//               a live preview, every edit is a new version (old ones kept)
//   Channels    is Email / SMS / WhatsApp really connected? what is missing?
//   Sent        every send (one person or many), with its result
//   Limits      how fast and how many per day
//
// Admin, HR and Team Leads edit; managers look. The WhatsApp name + approval
// and the SMS template id + sender id are typed in by an Admin from the Meta
// console / SMS provider. Nothing here marks a template Approved by itself.
// ---------------------------------------------------------------------------

const AUD_WORD = { candidate: 'People applying', client: 'Clients', employee: 'Our employees' };
const CHANNELS = ['Email', 'SMS', 'WhatsApp', 'Call']; // Call = the script shown while phoning (never sent)
const LANGS = ['English', 'Telugu', 'Hindi'];
const ago = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');

export default function MessageTemplates() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') || 'templates';
  const setTab = (t) => setSp(t === 'templates' ? {} : { tab: t });
  const tabs = [['templates', 'Templates'], ['automatic', 'Automatic messages'], ['channels', 'Channels'], ['sent', 'Sent messages'], ['limits', 'Limits']];
  return (
    <div className="mt-page">
      <div className="page-head">
        <div>
          <h1>Message templates</h1>
          <div className="page-sub">The words of every Email, SMS and WhatsApp message. Change them here once and every screen uses them.</div>
        </div>
      </div>
      <div className="tabs" role="tablist" style={{ marginBottom: 14 }}>
        {tabs.map(([k, label]) => <div key={k} role="tab" className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{label}</div>)}
      </div>
      {tab === 'templates' && <TemplatesTab />}
      {tab === 'automatic' && <AutomaticMessagesTab />}
      {tab === 'channels' && <ChannelsTab />}
      {tab === 'sent' && <SentTab />}
      {tab === 'limits' && <LimitsTab />}
    </div>
  );
}

// ============================ TEMPLATES ======================================
function TemplatesTab() {
  const tokens = useTokens();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [channel, setChannel] = useState('');
  const [language, setLanguage] = useState('');
  const [audience, setAudience] = useState('');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null); // id | 'new'
  const [flash, setFlash] = useState('');

  const load = useCallback(() => api.get('/messaging/templates')
    .then((r) => { setData(r.data); setError(''); })
    .catch((e) => setError(e.response?.data?.error || 'Could not load the templates.')), []);
  useEffect(() => { load(); }, [load]);

  const all = data ? data.templates : [];
  // Filters narrow each other, and show how many each would give (zero = hidden).
  const matches = (t, skip) => (skip === 'channel' || !channel || t.channel === channel)
    && (skip === 'language' || !language || t.language === language)
    && (skip === 'audience' || !audience || t.audience === audience)
    && (!q.trim() || `${t.name} ${t.purposeLabel} ${t.body}`.toLowerCase().includes(q.trim().toLowerCase()));
  const count = (key, val) => all.filter((t) => matches(t, key) && t[key] === val).length;
  const rows = all.filter((t) => matches(t));
  const groups = useMemo(() => {
    const m = new Map();
    rows.forEach((t) => { if (!m.has(t.purpose)) m.set(t.purpose, { label: t.purposeLabel, audience: t.audience, items: [] }); m.get(t.purpose).items.push(t); });
    return [...m.entries()];
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="msg-box red">{error}</div>;
  if (!data) return <div className="small-muted">Loading…</div>;

  const chip = (cur, set, val, label, n) => (n === 0 && cur !== val ? null : (
    <button key={val || 'all'} type="button" className={`msg-chip${cur === val ? ' on' : ''}`} onClick={() => set(cur === val ? '' : val)}>{label}{n != null ? ` (${n})` : ''}</button>
  ));

  return (
    <div>
      {flash && <div className="msg-box green">{flash}</div>}
      <div className="panel panel-pad" style={{ marginBottom: 12 }}>
        <div className="msg-filter">
          <span className="small-muted" style={{ alignSelf: 'center' }}>How:</span>
          {CHANNELS.map((c) => chip(channel, setChannel, c, `${CHANNEL_ICON[c]} ${c}`, count('channel', c)))}
          <span className="small-muted" style={{ alignSelf: 'center', marginLeft: 8 }}>For:</span>
          {Object.keys(AUD_WORD).map((a) => chip(audience, setAudience, a, AUD_WORD[a], count('audience', a)))}
          <span className="small-muted" style={{ alignSelf: 'center', marginLeft: 8 }}>Language:</span>
          {LANGS.map((l) => chip(language, setLanguage, l, l, count('language', l)))}
        </div>
        <div className="msg-btnrow">
          <input style={{ flex: 1, minWidth: 180 }} placeholder="Search the words or the name…" value={q} onChange={(e) => setQ(e.target.value)} />
          {data.canEdit && <button type="button" className="btn btn-primary" onClick={() => setSel('new')}>＋ New template</button>}
        </div>
        {!data.canEdit && <div className="small-muted">You can look at the templates. Only an Admin, HR or a Team Lead can change them.</div>}
      </div>

      <div className="mt-grid">
        <div className="mt-list">
          {!groups.length && <div className="small-muted" style={{ padding: 14 }}>No template matches. Clear a filter to see more.</div>}
          {groups.map(([key, g]) => (
            <div key={key} className="mt-purpose">
              <h4>{g.label} <span className="small-muted">· {AUD_WORD[g.audience] || g.audience}</span></h4>
              {g.items.map((t) => (
                <button key={t.id} type="button" className={`mt-tpl${sel === t.id ? ' on' : ''}${t.active ? '' : ' off'}`} onClick={() => setSel(t.id)}>
                  <span>{CHANNEL_ICON[t.channel]} {t.channel}</span>
                  <span className="small-muted">{t.language}</span>
                  <span className="small-muted">v{t.version}</span>
                  {!t.active && <span className="status pending">Off</span>}
                  {t.channel === 'WhatsApp' && <span className={`status ${WA_STATUS_CLASS[t.waStatus]}`}>{WA_STATUS_WORD[t.waStatus]}</span>}
                  {t.channel === 'SMS' && !t.dltTemplateId && <span className="small-muted">no DLT id</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div>
          {!sel && <div className="mt-editor small-muted">Choose a template on the left to read or change it.</div>}
          {sel && (
            <TemplateEditor
              key={sel}
              id={sel === 'new' ? null : sel}
              tokens={tokens}
              canEdit={data.canEdit}
              isAdmin={data.isAdmin}
              purposes={data.purposes}
              onSaved={(t, msg) => { setFlash(msg); load(); setSel(t ? t.id : null); }}
              onClose={() => setSel(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function TemplateEditor({ id, tokens, canEdit, isAdmin, purposes, onSaved, onClose }) {
  const isNew = !id;
  const [t, setT] = useState(null);
  const [f, setF] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef(null);

  useEffect(() => {
    if (isNew) {
      setF({
        purpose: purposes[0] ? purposes[0].purpose : 'CUSTOM', purposeLabel: '', audience: 'candidate', channel: 'Email', language: 'English', name: '', subject: '', body: '', active: true,
        waTemplateName: '', waLanguageCode: '', waStatus: 'None', waVars: [], dltTemplateId: '', senderId: '', changeNote: '',
      });
      return;
    }
    api.get(`/messaging/templates/${id}`).then((r) => {
      setT(r.data);
      setF({ ...r.data, changeNote: '' });
    }).catch((e) => setErr(e.response?.data?.error || 'Could not open this template.'));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err && !f) return <div className="mt-editor msg-box red">{err}</div>;
  if (!f) return <div className="mt-editor small-muted">Loading…</div>;
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const editable = canEdit;
  const adminFields = isAdmin;
  const channel = f.channel;
  const unknown = [...new Set([...unknownIn(f.body, tokens && tokens.tokens), ...unknownIn(f.subject, tokens && tokens.tokens)])];
  const pvBody = renderSample(f.body, tokens && tokens.tokens);
  const pvSubj = renderSample(f.subject, tokens && tokens.tokens);
  const sms = channel === 'SMS' ? smsInfo(pvBody.text) : null;
  const max = tokens ? tokens.maxBody[channel] : 4000;
  const used = [...pvBody.text].length;
  const bodyTokens = (() => { const out = []; String(f.body || '').replace(/\{\{\s*(\w+)\s*\}\}|\{(\w+)\}/g, (m, a, b) => { const k = a || b; const tk = (tokens && tokens.tokens || []).find((x) => x.key === k || (x.aliases || []).includes(k)); if (tk && !out.includes(tk.key)) out.push(tk.key); return m; }); return out; })();
  const vars = (f.waVars && f.waVars.length ? f.waVars : bodyTokens);
  const dirty = t && (['name', 'subject', 'body', 'active', 'waTemplateName', 'waLanguageCode', 'waStatus', 'dltTemplateId', 'senderId'].some((k) => (f[k] || '') !== (t[k] || '') && !(typeof f[k] === 'boolean' && f[k] === t[k])) || JSON.stringify(f.waVars || []) !== JSON.stringify(t.waVars || []));

  async function save() {
    setBusy(true); setErr('');
    try {
      if (isNew) {
        const r = await api.post('/messaging/templates', f);
        onSaved(r.data, `Saved “${r.data.name}” (${r.data.channel}).`);
      } else {
        const body = {
          name: f.name, subject: f.subject, body: f.body, active: f.active, changeNote: f.changeNote, waVars: f.waVars,
          ...(adminFields ? { waTemplateName: f.waTemplateName, waLanguageCode: f.waLanguageCode, waStatus: f.waStatus, dltTemplateId: f.dltTemplateId, senderId: f.senderId } : {}),
        };
        const r = await api.put(`/messaging/templates/${id}`, body);
        onSaved(r.data, r.data.unchanged ? 'Nothing was changed.' : `Saved as version ${r.data.version}. The old version is kept.`);
      }
    } catch (e) { setErr(e.response?.data?.error || 'Could not save.'); } finally { setBusy(false); }
  }
  async function makeDefault() {
    setBusy(true); setErr('');
    try { const r = await api.put(`/messaging/templates/${id}`, { isDefault: true }); onSaved(r.data, 'This is now the one the app uses for this message.'); } catch (e) { setErr(e.response?.data?.error || 'Could not do that.'); } finally { setBusy(false); }
  }
  async function restore(v) {
    setBusy(true); setErr('');
    try { const r = await api.post(`/messaging/templates/${id}/restore`, { version: v }); onSaved(r.data, `Version ${v}'s words are back, saved as version ${r.data.version}.`); } catch (e) { setErr(e.response?.data?.error || 'Could not do that.'); } finally { setBusy(false); }
  }
  async function remove() {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Delete this template for good? Its old versions go with it.')) return;
    try { await api.delete(`/messaging/templates/${id}`); onSaved(null, 'Template deleted.'); } catch (e) { setErr(e.response?.data?.error || 'Could not delete.'); }
  }

  return (
    <div className="mt-editor">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 15, margin: 0 }}>{isNew ? 'New template' : `${t.purposeLabel} · ${CHANNEL_ICON[t.channel]} ${t.channel} · ${t.language}`}</h3>
        <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
      </div>
      {!isNew && <div className="small-muted">Version {t.version}{t.builtIn ? ' · started as the built-in wording' : ''}{t.updatedByName ? ` · last changed by ${t.updatedByName}, ${ago(t.updatedAt)}` : ''}</div>}

      {isNew && (
        <div className="mt-row2" style={{ marginTop: 10 }}>
          <div className="field"><label>What is it for?</label>
            <select value={f.purpose} onChange={(e) => set('purpose', e.target.value)}>
              {purposes.map((p) => <option key={p.purpose} value={p.purpose}>{p.label}</option>)}
              <option value="CUSTOM">A new purpose…</option>
            </select>
            {f.purpose === 'CUSTOM' && <input style={{ marginTop: 6 }} placeholder="Name it, e.g. Salary discussion" value={f.purposeLabel} onChange={(e) => set('purposeLabel', e.target.value)} />}
          </div>
          <div className="field"><label>For whom?</label>
            <select value={f.audience} onChange={(e) => set('audience', e.target.value)}>{Object.entries(AUD_WORD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </div>
          <div className="field"><label>How?</label>
            <select value={f.channel} onChange={(e) => set('channel', e.target.value)}>{CHANNELS.map((c) => <option key={c}>{c}</option>)}</select>
          </div>
          <div className="field"><label>Language</label>
            <select value={f.language} onChange={(e) => set('language', e.target.value)}>{LANGS.map((c) => <option key={c}>{c}</option>)}</select>
          </div>
        </div>
      )}

      <div className="field" style={{ marginTop: 10 }}>
        <label>Name (only you see this)</label>
        <input value={f.name} disabled={!editable} onChange={(e) => set('name', e.target.value)} />
      </div>
      {channel === 'Email' && (
        <div className="field"><label>Subject</label>
          <input value={f.subject} disabled={!editable} onChange={(e) => set('subject', e.target.value)} />
        </div>
      )}
      <div className="field">
        <label>{channel === 'Call' ? 'The script (what to say)' : 'The words'}</label>
        <textarea ref={bodyRef} className="msg-textarea" rows={channel === 'Email' ? 8 : 5} value={f.body} disabled={!editable} onChange={(e) => set('body', e.target.value)} />
        {editable && <TokenPicker tokens={tokens && tokens.tokens} onPick={(k) => insertToken(bodyRef, f.body, (v) => set('body', v), k)} startOpen />}
        <div className={`msg-count${used > max ? ' bad' : ''}`}>
          {used} of {max} letters{sms ? ` · ${sms.segments} SMS part(s)${sms.unicode ? ' (Telugu / Hindi / emoji use more space: 70 letters per part)' : ' (160 letters per part)'}` : ''}
        </div>
        {unknown.length > 0 && <div className="msg-box red">These are not known details: {unknown.map((u) => `{{${u}}}`).join(', ')}. Use the buttons above.</div>}
      </div>

      <div className="field">
        <label>How it looks (with example details)</label>
        <div className="msg-preview">
          {channel === 'Email' && <b>{pvSubj.text}{'\n'}</b>}
          {pvBody.parts.map((p, i) => (p.filled ? <mark key={i}>{p.t}</mark> : p.unknown ? <mark key={i} className="bad">{p.t}</mark> : <span key={i}>{p.t}</span>))}
        </div>
      </div>

      {channel === 'WhatsApp' && (
        <div className="mt-card">
          <h4>WhatsApp (Meta)</h4>
          <div className="small-muted">WhatsApp can only start a chat with a template that Meta approved. Create it in the Meta console (WhatsApp Manager → Message templates) with the same words, then type its exact name here. Set <b>Approved</b> only after Meta says so.</div>
          <div className="mt-row2" style={{ marginTop: 8 }}>
            <div className="field"><label>Template name in Meta</label>
              <input value={f.waTemplateName || ''} disabled={!adminFields} placeholder="e.g. interview_scheduled" onChange={(e) => set('waTemplateName', e.target.value)} /></div>
            <div className="field"><label>Meta says</label>
              <select value={f.waStatus || 'None'} disabled={!adminFields} onChange={(e) => set('waStatus', e.target.value)}>
                {['None', 'Pending', 'Approved', 'Rejected'].map((s) => <option key={s} value={s}>{WA_STATUS_WORD[s]}</option>)}
              </select></div>
            <div className="field"><label>Language code in Meta</label>
              <input value={f.waLanguageCode || ''} disabled={!adminFields} placeholder="en, te or hi" onChange={(e) => set('waLanguageCode', e.target.value)} /></div>
          </div>
          {!adminFields && <div className="small-muted">Only an Admin can change the Meta name and status.</div>}
          <div className="field"><label>Which detail goes in each {'{{1}}'} {'{{2}}'} of the Meta template</label>
            {vars.length === 0 && <div className="small-muted">This message has no details in it.</div>}
            {vars.map((k, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                <code>{`{{${i + 1}}}`}</code> →
                <select value={k} disabled={!editable} onChange={(e) => { const v = [...vars]; v[i] = e.target.value; set('waVars', v); }}>
                  {(tokens ? tokens.tokens : []).map((tk) => <option key={tk.key} value={tk.key}>{tk.label}</option>)}
                </select>
              </div>
            ))}
            {f.waVars && f.waVars.length > 0 && editable && <button type="button" className="btn btn-sm" onClick={() => set('waVars', [])}>Use the order they appear in the words</button>}
          </div>
        </div>
      )}

      {channel === 'SMS' && (
        <div className="mt-card">
          <h4>Registered SMS (India DLT)</h4>
          <div className="small-muted">Indian operators deliver only text registered on the DLT portal. Type the template id and the sender id the SMS provider gave you. Without them, the shared bulk template from Integrations is used.</div>
          <div className="mt-row2" style={{ marginTop: 8 }}>
            <div className="field"><label>DLT template id</label><input value={f.dltTemplateId || ''} disabled={!adminFields} onChange={(e) => set('dltTemplateId', e.target.value)} /></div>
            <div className="field"><label>Sender id (6 letters)</label><input value={f.senderId || ''} disabled={!adminFields} onChange={(e) => set('senderId', e.target.value)} /></div>
          </div>
          {!adminFields && <div className="small-muted">Only an Admin can change these.</div>}
        </div>
      )}

      {editable && (
        <div className="field">
          <label><input type="checkbox" checked={!!f.active} onChange={(e) => set('active', e.target.checked)} /> This template is on</label>
          <div className="small-muted">When it is off, people cannot pick it. Messages the app sends by itself then use the built-in wording.</div>
        </div>
      )}
      {editable && !isNew && (
        <div className="field"><label>What did you change? (optional)</label><input value={f.changeNote} maxLength={200} onChange={(e) => set('changeNote', e.target.value)} /></div>
      )}
      {err && <div className="msg-box red">{err}</div>}
      {editable && (
        <div className="msg-btnrow">
          <button type="button" className="btn btn-primary" disabled={busy || (!isNew && !dirty) || unknown.length > 0 || used > max} onClick={save}>
            {isNew ? 'Save this template' : (dirty ? `Save as version ${t.version + 1}` : 'No changes yet')}
          </button>
          {!isNew && !t.isDefault && t.active && <button type="button" className="btn" disabled={busy} onClick={makeDefault}>Use this one for automatic messages</button>}
          {!isNew && t.builtIn === false && <button type="button" className="btn btn-ghost" onClick={remove}>Delete</button>}
        </div>
      )}
      {!isNew && t.isDefault && <div className="small-muted">This is the one the app uses when it sends this message by itself.</div>}

      {!isNew && t.versions && (
        <details style={{ marginTop: 10 }}>
          <summary><b>Older versions ({t.versions.length})</b></summary>
          {t.versions.map((v) => (
            <div key={v.id} className="mt-vers">
              <span><b>Version {v.version}</b> · {ago(v.createdAt)} · {v.changedByName || '—'} · <span className="small-muted">{v.changeNote}</span></span>
              <span style={{ display: 'flex', gap: 6 }}>
                {v.version !== t.version && editable && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => restore(v.version)}>Put these words back</button>}
                {v.version === t.version && <span className="status active">Now</span>}
              </span>
              <div style={{ width: '100%', whiteSpace: 'pre-wrap', fontSize: 12, color: '#555' }}>{v.subject ? `${v.subject}\n` : ''}{v.body}</div>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

// ============================ CHANNELS =======================================
function ChannelsTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [res, setRes] = useState({});
  const [busy, setBusy] = useState('');
  useEffect(() => {
    api.get('/messaging/channels/detail').then((r) => setData(r.data)).catch((e) => setError(e.response?.data?.error || 'Could not load.'));
  }, []);
  const [dns, setDns] = useState(null);
  const [copied, setCopied] = useState('');
  async function checkDomain() {
    setBusy('dns'); setDns(null);
    try { const r = await api.get('/messaging/channels/Email/domain-check'); setDns(r.data); } catch (e) { setDns({ error: e.response?.data?.error || 'The check did not run.' }); } finally { setBusy(''); }
  }
  async function copyText(label, text) {
    try { await navigator.clipboard.writeText(text); setCopied(label); setTimeout(() => setCopied(''), 2500); } catch { setCopied(''); }
  }
  async function test(ch) {
    setBusy(ch);
    try { const r = await api.post(`/messaging/channels/${ch}/test`); setRes((x) => ({ ...x, [ch]: r.data })); } catch (e) { setRes((x) => ({ ...x, [ch]: { ok: false, message: e.response?.data?.error || 'The test did not run.' } })); } finally { setBusy(''); }
  }
  if (error) return <div className="msg-box red">{error}</div>;
  if (!data) return <div className="small-muted">Loading…</div>;
  return (
    <div>
      <div className="small-muted" style={{ marginBottom: 10 }}>This is the real state of each way of sending. Nothing is shown as connected unless it is. &ldquo;Send a test to me&rdquo; goes only to your own email or number; &ldquo;Check connection&rdquo; for calls places no call.</div>
      {['Email', 'SMS', 'WhatsApp', 'Call'].map((ch) => {
        const c = data.channels[ch];
        const r = res[ch];
        return (
          <div key={ch} className="mt-card">
            <h4>{CHANNEL_ICON[ch]} {ch === 'SMS' ? 'Text (SMS)' : (ch === 'Call' ? 'Call (through TeamLink)' : ch)} <span className={`status ${c.configured && !c.problems.length ? 'active' : 'pending'}`}>{c.configured && !c.problems.length ? 'Ready' : (c.configured ? 'Connected, one thing missing' : 'Not connected')}</span></h4>
            <div>{c.summary}</div>
            {ch === 'SMS' && c.dlt && c.dlt.needed && (
              <div className="small-muted">DLT (India): sender id {c.dlt.senderId ? 'set' : 'missing'} · bulk template {c.dlt.bulkTemplate ? 'set' : 'missing'} · {c.dlt.templatesWithDlt} of {c.dlt.templatesTotal} SMS templates have their own DLT id.</div>
            )}
            {ch === 'WhatsApp' && c.templates && (
              <div className="small-muted">Templates: {c.templates.approved} approved · {c.templates.pending} waiting for Meta · {c.templates.rejected} rejected · {c.templates.none} not sent to Meta yet.</div>
            )}
            {c.problems.length > 0 && <ul className="mt-steps" style={{ color: '#8a1c14' }}>{c.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
            {c.checks && c.checks.length > 0 && (
              <ul className="mt-checks" aria-label={`${ch} set-up list`}>
                {c.checks.map((k, i) => (
                  <li key={i} className={k.ok === true ? 'is-ok' : k.ok === false ? 'is-no' : 'is-unknown'}>
                    <span className="mt-check-mark" aria-hidden="true">{k.ok === true ? '✓' : k.ok === false ? '✕' : '?'}</span>
                    <span><b>{k.label}</b>{k.how && <span className="small-muted"> — {k.how}</span>}</span>
                  </li>
                ))}
              </ul>
            )}
            {c.webhook && (
              <div className="mt-hook">
                <div className="small-muted">{c.webhook.label}</div>
                <div className="mt-hook-row"><code>{c.webhook.url}</code><button type="button" className="btn btn-sm" onClick={() => copyText(ch, c.webhook.url)}>{copied === ch ? 'Copied' : 'Copy link'}</button></div>
                <div className="small-muted">{c.webhook.note}{!data.publicAddressSet && ' This address only works once your site has its public address (APP_BASE_URL) — ask your admin.'}</div>
              </div>
            )}
            {c.windowNote && <div className="small-muted">{c.windowNote}</div>}
            {c.limits && <div className="small-muted">{c.limits}</div>}
            {c.steps.length > 0 && (
              <details open={!c.configured}>
                <summary><b>What to do to set it up</b></summary>
                <ol className="mt-steps">{c.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
              </details>
            )}
            {data.isAdmin && c.configured && <button type="button" className="btn" disabled={busy === ch} onClick={() => test(ch)}>{busy === ch ? 'Testing…' : (ch === 'Call' ? 'Check connection' : 'Send a test to me')}</button>}
            {data.isAdmin && c.canCheckDomain && <button type="button" className="btn btn-ghost" style={{ marginLeft: 8 }} disabled={busy === 'dns'} onClick={checkDomain}>{busy === 'dns' ? 'Looking…' : 'Check my email domain'}</button>}
            {ch === 'Email' && dns && (dns.error ? <div className="msg-box red">{dns.error}</div> : (
              <div className={`msg-box ${dns.allGood ? 'green' : 'orange'}`}>
                <b>{dns.domain}</b>: {dns.allGood ? 'all three records found.' : 'some records are missing.'}
                <ul className="mt-steps">{dns.items.map((k, i) => <li key={i}>{k.ok ? '✓' : '✕'} {k.label} — {k.detail}</li>)}</ul>
              </div>
            ))}
            {r && <div className={`msg-box ${r.ok ? (r.sandbox ? 'orange' : 'green') : 'red'}`}>{r.message}{r.to ? ` (${r.to})` : ''}</div>}
          </div>
        );
      })}
    </div>
  );
}

// ============================ SENT ===========================================
function SentTab() {
  const [jobs, setJobs] = useState(null);
  const [open, setOpen] = useState(null);
  const load = useCallback(() => api.get('/messaging/bulk').then((r) => setJobs(r.data)).catch(() => setJobs([])), []);
  useEffect(() => { load(); }, [load]);
  if (!jobs) return <div className="small-muted">Loading…</div>;
  return (
    <div>
      <div className="small-muted" style={{ marginBottom: 8 }}>Every message you sent from a person&apos;s page or from a list. Admins see everyone&apos;s.</div>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>When</th><th>Who sent</th><th>What</th><th>How</th><th>Result</th><th /></tr></thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td>{ago(j.createdAt)}</td>
                <td>{j.createdBy}</td>
                <td>{j.purpose}<div className="small-muted">{j.kind === 'individual' ? 'One person' : `${j.entities} ${j.audience}`}</div></td>
                <td>{j.channels.join(' + ')}</td>
                <td>
                  <span className={`status ${STATUS_CLASS[j.status === 'done' ? 'sent' : 'queued']}`}>{j.status === 'done' ? 'Finished' : j.status === 'cancelled' ? 'Stopped' : 'Going on'}</span>
                  <div className="small-muted">{j.counts.sent} sent{j.counts.failed ? ` · ${j.counts.failed} failed` : ''}{j.counts.blocked ? ` · ${j.counts.blocked} blocked` : ''}{j.counts.skipped ? ` · ${j.counts.skipped} skipped` : ''}</div>
                </td>
                <td><button type="button" className="btn btn-sm" onClick={() => setOpen(j)}>Open</button></td>
              </tr>
            ))}
            {!jobs.length && <tr><td colSpan={6} className="small-muted" style={{ padding: 14 }}>Nothing sent yet. When you send a message to one person or a list, it shows here.</td></tr>}
          </tbody>
        </table>
      </div>
      {open && (
        <Modal wide title={`${open.purpose} · ${open.channels.join(' + ')}`} onClose={() => { setOpen(null); load(); }} footer={<button type="button" className="btn btn-primary" onClick={() => { setOpen(null); load(); }}>Close</button>}>
          <JobProgress jobId={open.id} initial={open} />
        </Modal>
      )}
    </div>
  );
}

// ============================ LIMITS =========================================
function LimitsTab() {
  const [d, setD] = useState(null);
  const [f, setF] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { api.get('/messaging/limits').then((r) => { setD(r.data); setF(r.data.limits); }).catch((e) => setErr(e.response?.data?.error || 'Could not load.')); }, []);
  if (err && !d) return <div className="msg-box red">{err}</div>;
  if (!d || !f) return <div className="small-muted">Loading…</div>;
  async function save() {
    setErr(''); setMsg('');
    try { const r = await api.put('/messaging/limits', f); setF(r.data.limits); setMsg('Saved.'); } catch (e) { setErr(e.response?.data?.error || 'Could not save.'); }
  }
  return (
    <div className="mt-card">
      <h4>How fast and how many</h4>
      <div className="small-muted" style={{ marginBottom: 8 }}>This stops a mistake from messaging everyone at once, and keeps us inside what the providers allow. It counts messages sent from person pages and lists (not the ones the app sends by itself when a step changes).</div>
      <div className="mt-limits">
        <b />
        <b>Per minute</b><b>Per day</b><b>Used today</b>
        {['Email', 'SMS', 'WhatsApp'].map((c) => (
          <span key={c} style={{ display: 'contents' }}>
            <span>{CHANNEL_ICON[c]} {c}</span>
            <input type="number" min={d.bounds.perMinute[0]} max={d.bounds.perMinute[1]} disabled={!d.canEdit} value={f[c].perMinute} onChange={(e) => setF({ ...f, [c]: { ...f[c], perMinute: Number(e.target.value) } })} />
            <input type="number" min={d.bounds.perDay[0]} max={d.bounds.perDay[1]} disabled={!d.canEdit} value={f[c].perDay} onChange={(e) => setF({ ...f, [c]: { ...f[c], perDay: Number(e.target.value) } })} />
            <span>{d.usedToday[c]} of {f[c].perDay}</span>
          </span>
        ))}
      </div>
      {err && <div className="msg-box red">{err}</div>}
      {msg && <div className="msg-box green">{msg}</div>}
      {d.canEdit ? <div className="msg-btnrow"><button type="button" className="btn btn-primary" onClick={save}>Save limits</button></div> : <div className="small-muted">Only an Admin can change these.</div>}
      <QuietHours />
    </div>
  );
}

// Quiet hours: promotional messages (job alerts, new-opening blasts) wait until morning; interview reminders never wait.
function QuietHours() {
  const [q, setQ] = useState(null);
  const [can, setCan] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => { api.get('/conversations/settings').then((r) => { setQ(r.data.quiet); setCan(!!r.data.canEdit); }).catch(() => {}); }, []);
  if (!q) return null;
  async function save() {
    setMsg('');
    try { const r = await api.put('/conversations/settings', { quiet: q }); setQ(r.data.quiet); setMsg('Saved.'); } catch (e) { setMsg(e.response?.data?.error || 'Could not save.'); }
  }
  return (
    <div style={{ marginTop: 18, borderTop: '1px solid var(--line-soft, #e8edf5)', paddingTop: 12 }}>
      <h4>Quiet hours</h4>
      <div className="small-muted" style={{ marginBottom: 8 }}>Job alerts and other promotional messages are held back at night (India time). Interview reminders and messages a person writes by hand are never held.</div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" style={{ width: 'auto' }} disabled={!can} checked={q.enabled} onChange={(e) => setQ({ ...q, enabled: e.target.checked })} /> Hold promotional messages at night</label>
      <div className="msg-btnrow">
        <label>From <input type="time" disabled={!can || !q.enabled} value={q.from} onChange={(e) => setQ({ ...q, from: e.target.value })} /></label>
        <label>Until <input type="time" disabled={!can || !q.enabled} value={q.to} onChange={(e) => setQ({ ...q, to: e.target.value })} /></label>
        {can && <button type="button" className="btn btn-primary" onClick={save}>Save quiet hours</button>}
      </div>
      {msg && <div className="msg-box green">{msg}</div>}
    </div>
  );
}
