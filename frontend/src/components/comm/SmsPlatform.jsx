import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import Combo from '../Combo.jsx';
import './comm.css';
import './smsPlatform.css';

// ---------------------------------------------------------------------------
// SMS PUSH PLATFORM (Administration > Integrations > SMS Push Platform). Admin / Super Admin only.
// Five small screens on one page: Status, Send SMS, Templates, History, Dashboard.
// Server: /api/sms-platform (this file) and /api/messaging/templates (the templates; channel SMS).
// Words: "Submitted" means the provider took the message; "Delivered" appears only when the provider's own report says so.
// No password or secret is ever on this page: they are typed in Connections > SMS Gateway > Configure and never come back.
// ---------------------------------------------------------------------------
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const MODULES = ['HRMS', 'ATS', 'Job Portal', 'Omnichannel', 'Other'];
const fmt = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const todayStr = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const PILL = { Queued: 'queued', Submitted: 'sent', Delivered: 'delivered', Failed: 'failed', Unknown: 'unknown', Skipped: 'unknown' };
const Pill = ({ s }) => <span className={`cm-pill ${PILL[s] || 'queued'}`}>{s}</span>;
const tokensOf = (body) => [...new Set([...String(body || '').matchAll(/\{\{\s*([A-Za-z_]\w*)\s*\}\}|\{([A-Za-z_]\w*)\}/g)].map((m) => m[1] || m[2]))];
const newKey = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

function Field({ label, children, hint }) {
  return (
    <div className="sp-field">
      <label>{label}</label>
      {children}
      {hint && <div className="cm-help">{hint}</div>}
    </div>
  );
}

// ---- Status -----------------------------------------------------------------
function StatusTab({ onOpenSettings, onGoSend }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const load = useCallback(() => api.get('/sms-platform/overview').then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'Could not load the SMS status.'))), []);
  useEffect(() => { load(); }, [load]);
  if (err) return <div className="cm-line cm-red">{err}</div>;
  if (!d) return <div className="cm-help">Loading…</div>;
  const cls = d.state === 'Connected' ? 'cm-green' : d.state === 'Configuration Required' ? 'cm-orange' : 'cm-blue';
  const test = async () => {
    setBusy(true); setNote(null);
    try { const r = await api.post('/sms-platform/test-connection'); setNote({ ok: !!r.data.ok, text: r.data.result }); await load(); } catch (e) { setNote({ ok: false, text: errOf(e, 'The test could not run.') }); } finally { setBusy(false); }
  };
  return (
    <div>
      <div className={`cm-line ${cls}`}>
        <b>{d.state}</b>{d.provider ? ` · ${d.provider}` : ''}
        {d.stateNote && <div className="cm-sub">{d.stateNote}</div>}
        {d.problems && d.problems.length > 0 && <ul className="sp-list">{d.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      </div>
      <div className="cm-card">
        <div className="cm-cardhead"><h3>Connection</h3>
          <button type="button" className="btn" onClick={onOpenSettings}>Open settings</button>
        </div>
        <div className="cm-grid">
          <div className="cm-stat"><b>{d.provider || '—'}</b><span>Provider</span></div>
          <div className="cm-stat"><b>{d.senderId || '—'}</b><span>Sender ID</span></div>
          {d.isPush && <div className="cm-stat"><b className="sp-small">{d.peId || '—'}</b><span>DLT Principal Entity ID</span></div>}
          <div className="cm-stat"><b>{d.hasPassword ? 'Saved' : 'Missing'}</b><span>API password</span></div>
        </div>
        {d.sendAddress && <div className="cm-help">Send address: <code>{d.sendAddress}</code></div>}
        <div className="cm-help">{d.settingsHint}</div>
        <div className="cm-help">Last test: {d.lastTest ? `${fmt(d.lastTest.at)} · ${d.lastTest.ok ? 'worked' : 'not proven'} · ${d.lastTest.result}` : 'never'}</div>
        <div className="cm-help">Last SMS accepted by the provider: {d.lastAccepted ? `${fmt(d.lastAccepted.at)} (id ${d.lastAccepted.ref})` : 'none yet'}</div>
        <div className="cm-btnrow">
          <button type="button" className="btn" disabled={busy} onClick={test}>{busy ? 'Testing…' : 'Test connection'}</button>
          <button type="button" className="btn btn-primary" onClick={onGoSend}>Send test SMS</button>
        </div>
        {note && <div className={`cm-line ${note.ok ? 'cm-green' : 'cm-orange'}`}>{note.text}</div>}
      </div>
      <div className="cm-card">
        <div className="cm-cardhead"><h3>Delivery reports</h3></div>
        <div className="cm-help">Give this address to the provider as the delivery-report (DLR) address. Replace the part in angle brackets with the delivery-report secret you saved in the settings ({d.reportSecretSet ? 'it is saved' : 'it is NOT saved yet'}).</div>
        <div className="sp-code"><code>{d.reportAddress}</code>
          <button type="button" className="btn" onClick={() => navigator.clipboard && navigator.clipboard.writeText(d.reportAddress)}>Copy</button></div>
        <div className="cm-help">Until the provider sends reports, messages stay "Submitted". TeamLink never marks a message Delivered on its own.</div>
      </div>
    </div>
  );
}

// ---- Send ---------------------------------------------------------------------
function SendTab({ testFocus }) {
  const [tpls, setTpls] = useState([]);
  const [tplId, setTplId] = useState('');
  const [mode, setMode] = useState('single');
  const [mobile, setMobile] = useState('');
  const [name, setName] = useState('');
  const [list, setList] = useState('');
  const [module, setModule] = useState(testFocus ? 'Other' : 'HRMS');
  const [vars, setVars] = useState({});
  const [prev, setPrev] = useState(null);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const keyRef = useRef(newKey());
  useEffect(() => { api.get('/messaging/templates/usable', { params: { channel: 'SMS' } }).then((r) => setTpls((r.data.templates || []).filter((t) => t.dltTemplateId))).catch(() => setTpls([])); }, []);
  const tpl = useMemo(() => tpls.find((t) => t.id === tplId) || null, [tpls, tplId]);
  const extra = useMemo(() => (tpl ? tokensOf(tpl.body).filter((k) => !['name', 'candidateName', 'employeeName'].includes(k)) : []), [tpl]);
  const recipients = useMemo(() => {
    if (mode === 'single') return mobile.trim() ? [{ mobile: mobile.trim(), name: name.trim() }] : [];
    return list.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const [m, ...n] = l.split(/[,;\t]/); return { mobile: (m || '').trim(), name: n.join(' ').trim() }; });
  }, [mode, mobile, name, list]);
  const onFile = (e) => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { const lines = String(rd.result).split(/\r?\n/).filter(Boolean); const rows = /^\s*\+?\d/.test(lines[0] || '') ? lines : lines.slice(1); setList(rows.join('\n')); };
    rd.readAsText(f);
  };
  const body = () => ({ templateId: tplId, module, variables: vars, recipients, idempotencyKey: keyRef.current });
  const preview = async () => {
    setErr(''); setPrev(null);
    try { const r = await api.post('/sms-platform/preview', { templateId: tplId, recipientName: recipients[0] && recipients[0].name, variables: vars }); setPrev(r.data); } catch (e) { setErr(errOf(e, 'No preview.')); }
  };
  const send = async (confirmed) => {
    setErr(''); setBusy(true); setRes(null);
    try {
      const r = await api.post('/sms-platform/send', { ...body(), confirm: confirmed === true });
      setRes(r.data); setConfirm(null); keyRef.current = newKey();
    } catch (e) {
      if (e.response && e.response.status === 409 && e.response.data.code === 'CONFIRM_BULK') setConfirm(e.response.data.count); else setErr(errOf(e, 'The SMS could not be sent.'));
    } finally { setBusy(false); }
  };
  const clear = () => { setMobile(''); setName(''); setList(''); setVars({}); setPrev(null); setRes(null); setErr(''); setConfirm(null); keyRef.current = newKey(); };
  const noTpl = !tpls.length;
  return (
    <div className="cm-card">
      <div className="cm-cardhead"><h3>{testFocus ? 'Send a test SMS to your own number' : 'Send SMS'}</h3></div>
      {noTpl && <div className="cm-line cm-orange">There is no SMS template with a DLT Template ID yet. Add one on the <b>Templates</b> tab first: a message that is not in an approved DLT template will not be delivered in India.</div>}
      <div className="cm-choice">
        {[['single', 'One person'], ['multiple', 'Several people'], ['csv', 'Import a list (CSV)']].map(([k, l]) => (
          <button key={k} type="button" className={mode === k ? 'on' : ''} onClick={() => { setMode(k); setConfirm(null); }}>{l}</button>
        ))}
      </div>
      <div className="cm-form">
        {mode === 'single' ? (
          <>
            <Field label="Mobile number"><input value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder="98765 43210" /></Field>
            <Field label="Name (fills {{name}})"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          </>
        ) : (
          <Field label={mode === 'csv' ? 'List (one per line: mobile, name)' : 'Numbers (one per line: mobile, name)'} hint={`${recipients.length} number${recipients.length === 1 ? '' : 's'} in the list`}>
            {mode === 'csv' && <input type="file" accept=".csv,.txt" onChange={onFile} />}
            <textarea rows={6} value={list} onChange={(e) => setList(e.target.value)} placeholder={'98765 43210, Ravi\n98765 43211, Sita'} />
          </Field>
        )}
        <Field label="Where is this from?">
          <Combo value={module} onChange={(e) => setModule(e.target.value)}>
            {MODULES.map((m) => <option key={m} value={m}>{m}</option>)}
          </Combo>
        </Field>
        <Field label="Approved template" hint="Only templates that have a DLT Template ID are listed.">
          <Combo value={tplId} onChange={(e) => { setTplId(e.target.value); setVars({}); setPrev(null); }}>
            <option value="">Choose a template…</option>
            {tpls.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.dltTemplateId}</option>)}
          </Combo>
        </Field>
        {tpl && extra.map((k) => (
          <Field key={k} label={`Value for {{${k}}}`}><input value={vars[k] || ''} onChange={(e) => setVars({ ...vars, [k]: e.target.value })} /></Field>
        ))}
        {tpl && <Field label="Sender ID / DLT Template ID"><div className="cm-help sp-ro">{tpl.senderId || 'the Sender ID in the settings'} · {tpl.dltTemplateId}</div></Field>}
      </div>
      {tpl && <div className="cm-help">Template words: <i>{tpl.body}</i></div>}
      <div className="cm-help">Scheduling for later is not offered: the provider's document does not describe it. Messages go now.</div>
      {prev && (
        <div className="cm-line cm-blue"><b>This is exactly what will be sent:</b>
          <div className="sp-preview">{prev.text}</div>
          <div className="cm-sub">{prev.chars} characters · {prev.segments} SMS part{prev.segments === 1 ? '' : 's'} ({prev.encoding}){prev.missing && prev.missing.length ? ` · missing: ${prev.missing.join(', ')}` : ''}</div>
        </div>
      )}
      {err && <div className="cm-line cm-red">{err}</div>}
      {confirm && (
        <div className="cm-warn"><b>Send {confirm} SMS?</b> Each one is a real message that costs credit. Check the preview first.
          <div className="cm-btnrow"><button type="button" className="btn btn-primary" disabled={busy} onClick={() => send(true)}>Yes, send {confirm}</button>
            <button type="button" className="btn" onClick={() => setConfirm(null)}>Cancel</button></div></div>
      )}
      <div className="cm-btnrow">
        <button type="button" className="btn" disabled={!tplId || !recipients.length} onClick={preview}>Preview message</button>
        <button type="button" className="btn btn-primary" disabled={busy || !tplId || !recipients.length || !!confirm} onClick={() => send(false)}>{busy ? 'Sending…' : 'Send SMS'}</button>
        <button type="button" className="btn" onClick={clear}>Clear form</button>
      </div>
      {res && (
        <div className="sp-result">
          <div className={`cm-line ${res.counts.Failed || res.counts.Unknown ? 'cm-orange' : 'cm-green'}`}>
            {res.repeated ? 'This request was already sent: nothing was sent again. ' : ''}
            {Object.entries(res.counts).map(([k, v]) => `${v} ${k}`).join(' · ')} · template {res.template}
            <div className="cm-sub">"Submitted" means the provider accepted it. Delivery shows in History when the provider reports it.</div>
          </div>
          <table className="cm-table"><thead><tr><th>Number</th><th>Name</th><th>Status</th><th>Provider id / reason</th></tr></thead>
            <tbody>{res.results.map((r) => (
              <tr key={`${r.to}-${r.providerRef || r.error}`}><td>{r.to}</td><td>{r.name}</td><td><Pill s={r.status} /></td>
                <td>{r.providerRef || r.error}{r.sandbox ? ' (test server: not really sent)' : ''}</td></tr>
            ))}</tbody></table>
        </div>
      )}
    </div>
  );
}

// ---- Templates -----------------------------------------------------------------------
function TemplateForm({ t, onClose, onSaved }) {
  const [f, setF] = useState(() => ({
    name: t ? t.name : '', purposeLabel: t ? t.purposeLabel : '', audience: t ? t.audience : 'candidate', language: t ? t.language : 'English',
    body: t ? t.body : '', dltTemplateId: t ? t.dltTemplateId || '' : '', senderId: t ? t.senderId || '' : '', active: t ? t.active : true,
  }));
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const save = async () => {
    setBusy(true); setErr('');
    try {
      if (t) await api.put(`/messaging/templates/${t.id}`, { name: f.name, body: f.body, dltTemplateId: f.dltTemplateId, senderId: f.senderId, active: f.active });
      else await api.post('/messaging/templates', { channel: 'SMS', ...f });
      onSaved();
    } catch (e) { setErr(errOf(e, 'Could not save the template.')); } finally { setBusy(false); }
  };
  return (
    <Modal title={t ? 'Edit SMS template' : 'Add SMS template'} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save template'}</button></>}
    >
      <div className="cm-form">
        <Field label="Template name"><input value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
        {!t && <Field label="Category (what it is for)"><input value={f.purposeLabel} onChange={(e) => set('purposeLabel', e.target.value)} placeholder="Interview reminder" /></Field>}
        {!t && (
          <Field label="For whom">
            <Combo value={f.audience} onChange={(e) => set('audience', e.target.value)}>
              <option value="candidate">Candidates</option><option value="client">Clients</option><option value="employee">Employees</option>
            </Combo>
          </Field>
        )}
        <Field label="Language"><input value={f.language} onChange={(e) => set('language', e.target.value)} disabled={!!t} /></Field>
        <Field label="DLT Template ID" hint="The id the DLT portal gave when the template was approved."><input value={f.dltTemplateId} onChange={(e) => set('dltTemplateId', e.target.value)} /></Field>
        <Field label="Sender ID (header)" hint="Blank = the Sender ID in the settings."><input value={f.senderId} onChange={(e) => set('senderId', e.target.value)} /></Field>
      </div>
      <Field label="Message words" hint="Use {{name}} for the person's name. The words must match the approved DLT template exactly."><textarea rows={5} value={f.body} onChange={(e) => set('body', e.target.value)} style={{ width: '100%' }} /></Field>
      <label className="sp-check"><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> Active</label>
      {err && <div className="cm-line cm-red">{err}</div>}
    </Modal>
  );
}

function TemplatesTab() {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState(''); const [st, setSt] = useState('');
  const [form, setForm] = useState(null); const [view, setView] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => api.get('/messaging/templates', { params: { channel: 'SMS' } }).then((r) => { setRows(r.data.templates || []); setErr(''); }).catch((e) => setErr(errOf(e, 'Could not load the templates.'))), []);
  useEffect(() => { load(); }, [load]);
  const shown = (rows || []).filter((t) => (!q || `${t.name} ${t.purposeLabel} ${t.body} ${t.dltTemplateId || ''}`.toLowerCase().includes(q.toLowerCase()))
    && (!st || (st === 'active' ? t.active : st === 'inactive' ? !t.active : st === 'dlt' ? !!t.dltTemplateId : !t.dltTemplateId)));
  const toggle = async (t) => { try { await api.put(`/messaging/templates/${t.id}`, { active: !t.active }); load(); } catch (e) { setErr(errOf(e, 'Could not change it.')); } };
  return (
    <div className="cm-card">
      <div className="cm-cardhead"><h3>SMS templates</h3><button type="button" className="btn btn-primary" onClick={() => setForm({})}>Add template</button></div>
      <div className="cm-help">The DLT Template ID is what the provider checks. TeamLink cannot tell whether DLT approved a template: add the id only from your DLT portal. Syncing templates from the provider is not offered because the provider has no documented way to do it.</div>
      <div className="cm-filters">
        <div><label>Search</label><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="name, words or DLT id" /></div>
        <div><label>Show</label>
          <Combo value={st} onChange={(e) => setSt(e.target.value)}>
            <option value="">All</option><option value="active">Active</option><option value="inactive">Inactive</option><option value="dlt">Has a DLT id</option><option value="nodlt">No DLT id</option>
          </Combo></div>
      </div>
      {err && <div className="cm-line cm-red">{err}</div>}
      {!rows ? <div className="cm-help">Loading…</div> : !shown.length ? <div className="cm-help">No templates.</div> : (
        <div className="sp-scroll"><table className="cm-table">
          <thead><tr><th>Name</th><th>Category</th><th>Words</th><th>DLT id</th><th>Sender</th><th>Language</th><th>DLT</th><th>Status</th><th>Changed by</th><th>Created</th><th>Updated</th><th /></tr></thead>
          <tbody>{shown.map((t) => (
            <tr key={t.id}>
              <td><b>{t.name}</b></td><td>{t.purposeLabel}</td><td className="sp-words">{t.body}</td><td>{t.dltTemplateId || '—'}</td><td>{t.senderId || '—'}</td><td>{t.language}</td>
              <td><span className={`cm-pill ${t.dltTemplateId ? 'sent' : 'unknown'}`}>{t.dltTemplateId ? 'Id added' : 'No id'}</span></td>
              <td><span className={`cm-pill ${t.active ? 'delivered' : 'unknown'}`}>{t.active ? 'Active' : 'Inactive'}</span></td>
              <td>{t.updatedByName || ''}</td><td>{fmt(t.createdAt)}</td><td>{fmt(t.updatedAt)}</td>
              <td className="sp-actions"><button type="button" className="btn" onClick={() => setView(t)}>Preview</button>
                <button type="button" className="btn" onClick={() => setForm(t)}>Edit</button>
                <button type="button" className="btn" onClick={() => toggle(t)}>{t.active ? 'Switch off' : 'Switch on'}</button></td>
            </tr>
          ))}</tbody></table></div>
      )}
      {form && <TemplateForm t={form.id ? form : null} onClose={() => setForm(null)} onSaved={() => { setForm(null); load(); }} />}
      {view && <Modal title={view.name} onClose={() => setView(null)}><div className="sp-preview">{view.body}</div><div className="cm-help">DLT Template ID: {view.dltTemplateId || 'not added'} · Sender: {view.senderId || 'from the settings'} · {view.body.length} characters</div></Modal>}
    </div>
  );
}

// ---- History ------------------------------------------------------------------------------
function HistoryTab() {
  const [f, setF] = useState({ from: daysAgo(6), to: todayStr(), q: '', module: '', template: '', submission: '', status: '' });
  const [page, setPage] = useState(1);
  const [d, setD] = useState(null); const [err, setErr] = useState(''); const [detail, setDetail] = useState(null);
  const params = useMemo(() => ({ ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), page, size: 25 }), [f, page]);
  useEffect(() => { api.get('/sms-platform/history', { params }).then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'Could not load the history.'))); }, [params]);
  const set = (k, v) => { setPage(1); setF((p) => ({ ...p, [k]: v })); };
  const exportCsv = async () => {
    try {
      const r = await api.get('/sms-platform/history.csv', { params: Object.fromEntries(Object.entries(f).filter(([, v]) => v)), responseType: 'blob' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(r.data); a.download = 'sms-history.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { setErr(errOf(e, 'The export failed.')); }
  };
  const open = async (r) => { try { const x = await api.get('/sms-platform/history/detail', { params: r.providerRef ? { ref: r.providerRef } : { id: r.id } }); setDetail(x.data); } catch (e) { setErr(errOf(e, 'No detail.')); } };
  const pages = d ? Math.max(1, Math.ceil(d.total / d.size)) : 1;
  return (
    <div className="cm-card">
      <div className="cm-cardhead"><h3>SMS history</h3><button type="button" className="btn" onClick={exportCsv}>Export CSV</button></div>
      <div className="cm-filters">
        <div><label>From</label><input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} /></div>
        <div><label>To</label><input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} /></div>
        <div><label>Number</label><input value={f.q} onChange={(e) => set('q', e.target.value)} placeholder="digits" /></div>
        <div><label>Source</label><Combo value={f.module} onChange={(e) => set('module', e.target.value)}><option value="">All</option>{MODULES.map((m) => <option key={m} value={m}>{m}</option>)}</Combo></div>
        <div><label>Template</label><input value={f.template} onChange={(e) => set('template', e.target.value)} placeholder="exact name" /></div>
        <div><label>Submission</label><Combo value={f.submission} onChange={(e) => set('submission', e.target.value)}><option value="">All</option><option>Submitted</option><option>Failed</option><option>Unknown</option></Combo></div>
        <div><label>Delivery</label><Combo value={f.status} onChange={(e) => set('status', e.target.value)}><option value="">All</option><option>Queued</option><option>Submitted</option><option>Delivered</option><option>Failed</option><option>Unknown</option></Combo></div>
      </div>
      {err && <div className="cm-line cm-red">{err}</div>}
      {!d ? <div className="cm-help">Loading…</div> : !d.rows.length ? <div className="cm-help">No SMS in this range.</div> : (
        <div className="sp-scroll"><table className="cm-table">
          <thead><tr><th>When</th><th>To</th><th>From</th><th>Template</th><th>Message</th><th>Sender</th><th>Provider id</th><th>Submission</th><th>Delivery</th><th>Why not</th><th>Retries</th><th>By</th></tr></thead>
          <tbody>{d.rows.map((r) => (
            <tr key={r.id} className="sp-click" onClick={() => open(r)}>
              <td>{fmt(r.at)}</td><td>{r.recipient}</td><td>{r.module}</td><td>{r.template || '—'}</td><td className="sp-words">{r.preview || '—'}</td><td>{r.senderId || '—'}</td>
              <td>{r.providerRef || '—'}</td><td><Pill s={r.submission} /></td><td><Pill s={r.delivery} /></td><td className="sp-words">{r.error || ''}</td><td>{r.retries}</td><td>{r.by || ''}</td>
            </tr>
          ))}</tbody></table></div>
      )}
      {d && d.total > d.size && (
        <div className="cm-btnrow"><button type="button" className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="cm-help">Page {page} of {pages} · {d.total} SMS</span>
          <button type="button" className="btn" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button></div>
      )}
      {detail && (
        <Modal title={`SMS to ${detail.recipient}`} onClose={() => setDetail(null)}>
          <div className="cm-grid">
            <div className="cm-stat"><b><Pill s={detail.submission} /></b><span>Submission</span></div>
            <div className="cm-stat"><b><Pill s={detail.delivery} /></b><span>Delivery</span></div>
            <div className="cm-stat"><b className="sp-small">{detail.providerRef || '—'}</b><span>Provider id</span></div>
          </div>
          <div className="sp-preview">{detail.preview || '(words not kept)'}</div>
          <div className="cm-help">{detail.module} · {detail.template || 'no template'} · sender {detail.senderId || '—'} · DLT {detail.dltTemplateId || '—'} · by {detail.by || '—'}</div>
          {detail.error && <div className="cm-line cm-orange">{detail.error}</div>}
          <h4 className="sp-h4">What happened</h4>
          <ul className="sp-list">{(detail.history || []).map((h) => <li key={`${h.at}-${h.status}`}>{fmt(h.at)} · <b>{h.status}</b>{h.detail ? ` · ${h.detail}` : ''}</li>)}</ul>
        </Modal>
      )}
    </div>
  );
}

// ---- Dashboard -----------------------------------------------------------------------------------
function DashboardTab() {
  const [from, setFrom] = useState(daysAgo(29)); const [to, setTo] = useState(todayStr()); const [module, setModule] = useState('');
  const [d, setD] = useState(null); const [err, setErr] = useState('');
  useEffect(() => { api.get('/sms-platform/dashboard', { params: { from, to, ...(module ? { module } : {}) } }).then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'Could not load the dashboard.'))); }, [from, to, module]);
  const max = d ? Math.max(1, ...d.byModule.map((m) => m.count)) : 1;
  const C = d && d.counts;
  return (
    <div className="cm-card">
      <div className="cm-cardhead"><h3>SMS dashboard</h3></div>
      <div className="cm-filters">
        <div><label>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <div><label>Source</label><Combo value={module} onChange={(e) => setModule(e.target.value)}><option value="">All</option>{MODULES.map((m) => <option key={m} value={m}>{m}</option>)}</Combo></div>
      </div>
      {err && <div className="cm-line cm-red">{err}</div>}
      {!d ? <div className="cm-help">Loading…</div> : (
        <>
          <div className="cm-grid">
            <div className="cm-stat"><b>{C.requests}</b><span>SMS requests</span></div>
            <div className="cm-stat"><b>{C.submitted}</b><span>Submitted (accepted)</span></div>
            <div className="cm-stat"><b>{C.delivered}</b><span>Delivered (provider said so)</span></div>
            <div className="cm-stat"><b>{C.failed}</b><span>Failed</span></div>
            <div className="cm-stat"><b>{C.unknown}</b><span>Unknown answer</span></div>
            <div className="cm-stat"><b>{C.pendingReports}</b><span>Waiting for a delivery report</span></div>
            <div className="cm-stat"><b>{d.successRate == null ? '—' : `${d.successRate}%`}</b><span>Delivered of submitted</span></div>
          </div>
          <div className="cm-help">{d.note}</div>
          <div className="cm-help"><b>Credit balance:</b> {d.credits == null ? d.creditsNote : d.credits}</div>
          <h4 className="sp-h4">By source</h4>
          {!d.byModule.length ? <div className="cm-help">Nothing sent in this range.</div> : d.byModule.map((m) => (
            <div key={m.module} className="sp-bar"><span>{m.module}</span><div><i style={{ width: `${(m.count / max) * 100}%` }} /></div><b>{m.count}</b></div>
          ))}
          <h4 className="sp-h4">Latest</h4>
          {!d.recent.length ? <div className="cm-help">No SMS yet.</div> : (
            <table className="cm-table"><thead><tr><th>When</th><th>To</th><th>From</th><th>Delivery</th></tr></thead>
              <tbody>{d.recent.map((r) => <tr key={r.id}><td>{fmt(r.at)}</td><td>{r.recipient}</td><td>{r.module}</td><td><Pill s={r.delivery} /></td></tr>)}</tbody></table>
          )}
        </>
      )}
    </div>
  );
}

export default function SmsPlatform({ onOpenSettings }) {
  const [sub, setSub] = useState('status');
  const [testFocus, setTestFocus] = useState(false);
  const tabs = [['status', 'Status'], ['send', 'Send SMS'], ['templates', 'Templates'], ['history', 'History'], ['dashboard', 'Dashboard']];
  return (
    <div className="cm-page" data-sms-platform>
      <div className="cm-tabs">{tabs.map(([k, l]) => <button key={k} type="button" className={sub === k ? 'on' : ''} onClick={() => { setSub(k); setTestFocus(false); }}>{l}</button>)}</div>
      {sub === 'status' && <StatusTab onOpenSettings={onOpenSettings} onGoSend={() => { setTestFocus(true); setSub('send'); }} />}
      {sub === 'send' && <SendTab testFocus={testFocus} />}
      {sub === 'templates' && <TemplatesTab />}
      {sub === 'history' && <HistoryTab />}
      {sub === 'dashboard' && <DashboardTab />}
    </div>
  );
}
