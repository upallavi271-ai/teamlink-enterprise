import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../api';
import Combo from '../Combo.jsx';
import DateRangePicker, { resolveRange } from '../DateRangePicker.jsx';
import { Marked } from './WaModal.jsx';
import { fillPlaceholders } from '../../utils/waLink';
import { refreshWaConfig, clearWaTemplateCache, errText, WA_ICON } from './waKit.js';
import './wa.css';

// ---------------------------------------------------------------------------
// ADMINISTRATION -> COMPANY SETUP -> MESSAGE TEMPLATES -> "WhatsApp quick chat" tab (free wa.me links; TeamLink sends nothing).
//   Templates  the wording (visible Edit / Delete; the five TeamLink templates can be edited, never deleted), live preview with sample values
//   Log        WhatsApp Log: when, who, number (hidden for roles that may not see it), module, template, sent by; status is always "Opened"
//   Settings   switch, default country code, per-module switches, daily bulk limit, the plain safety note
// ---------------------------------------------------------------------------
const SAMPLE = { name: 'Ravi', amount: 'Rs 11,800', invoice_no: 'INV-2026-014', due_date: '20 Oct 2026', job_title: 'Accounts Executive', interview_date: 'Mon, 19 Oct, 10:30 AM', month: 'October 2026' };
const MODS = ['HRMS', 'ATS', 'Accounts', 'General'];
const when = (t) => (t ? new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

export default function WaQuickChatTab() {
  const [sub, setSub] = useState('templates');
  const [cfg, setCfg] = useState(null);
  const loadCfg = useCallback(() => api.get('/wa/config').then((r) => setCfg(r.data)).catch(() => setCfg({ ready: false, message: 'Could not load.' })), []);
  useEffect(() => { loadCfg(); }, [loadCfg]);
  if (!cfg) return <div className="small-muted">Loading...</div>;
  if (!cfg.ready) return <div className="wa-note info">{cfg.message || 'WhatsApp quick chat is being set up.'}</div>;
  const subs = [['templates', 'Templates'], ['log', 'WhatsApp log'], ['settings', 'Settings']];
  return (
    <div>
      <div className="wa-note info">{WA_ICON} Free WhatsApp quick chat. TeamLink never sends the message: the button opens WhatsApp in a new tab and the person presses Send there.</div>
      <div className="wa-sub" role="tablist" aria-label="WhatsApp quick chat">
        {subs.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={sub === k} className={sub === k ? 'on' : ''} onClick={() => setSub(k)}>{label}</button>)}
      </div>
      {sub === 'templates' && <Templates cfg={cfg} />}
      {sub === 'log' && <LogView cfg={cfg} />}
      {sub === 'settings' && <Settings cfg={cfg} onSaved={() => { loadCfg(); refreshWaConfig(); }} />}
    </div>
  );
}

// ============================ TEMPLATES ======================================
function Templates({ cfg }) {
  const [list, setList] = useState([]);
  const [edit, setEdit] = useState(null); // null | {id?, name, module, body}
  const [msg, setMsg] = useState(null);
  const [placeholders, setPlaceholders] = useState([]);
  const load = useCallback(() => api.get('/wa/templates').then((r) => { setList(r.data.templates || []); setPlaceholders(r.data.placeholders || []); }).catch((e) => setMsg({ bad: true, text: errText(e, 'Could not load the templates.') })), []);
  useEffect(() => { load(); }, [load]);
  const may = cfg.mayEditTemplates;
  async function save() {
    setMsg(null);
    try {
      if (edit.id) await api.put(`/wa/templates/${edit.id}`, { name: edit.name, module: edit.module, body: edit.body });
      else await api.post('/wa/templates', { name: edit.name, module: edit.module, body: edit.body });
      clearWaTemplateCache(); setEdit(null); setMsg({ text: 'Saved.' }); load();
    } catch (e) { setMsg({ bad: true, text: errText(e, 'Could not save.') }); }
  }
  async function del(t) {
    if (!window.confirm(`Delete the template "${t.name}"? This cannot be undone.`)) return;
    try { await api.delete(`/wa/templates/${t.id}`); clearWaTemplateCache(); setMsg({ text: 'Deleted.' }); load(); } catch (e) { setMsg({ bad: true, text: errText(e, 'Could not delete.') }); }
  }
  const preview = edit ? fillPlaceholders(edit.body, SAMPLE).text : '';
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <div className="small-muted" style={{ flex: 1 }}>Words in curly brackets are filled in for each person: {placeholders.map((p) => `{${p}}`).join(' ')}</div>
        {may && !edit && <button type="button" className="btn btn-primary" onClick={() => setEdit({ name: '', module: 'General', body: '' })}>New template</button>}
      </div>
      {msg && <div className={`wa-note ${msg.bad ? 'bad' : 'ok'}`} role="status">{msg.text}</div>}
      {edit && (
        <div className="wa-edit">
          <div className="wa-two">
            <div className="wa-field"><label htmlFor="wat-name">Name</label><input id="wat-name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={80} /></div>
            <div className="wa-field"><label>Used in</label><Combo value={edit.module} onChange={(e) => setEdit({ ...edit, module: e.target.value })}>{MODS.map((m) => <option key={m} value={m}>{m}</option>)}</Combo></div>
          </div>
          <div className="wa-field"><label htmlFor="wat-body">Message</label><textarea id="wat-body" className="wa-msg" value={edit.body} maxLength={1200} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></div>
          <div className="wa-field"><label>Preview with sample values</label><div className="wa-preview"><Marked text={preview || 'Your message will show here.'} /></div></div>
          <div className="wa-foot">
            <button type="button" className="btn" onClick={() => setEdit(null)}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={save}>Save</button>
          </div>
        </div>
      )}
      <table className="wa-tbl">
        <thead><tr><th>Name</th><th>Used in</th><th>Message</th><th /></tr></thead>
        <tbody>
          {list.map((t) => (
            <tr key={t.id}>
              <td><b>{t.name}</b>{t.isSystem && <div className="small-muted">TeamLink template</div>}</td>
              <td>{t.module}</td>
              <td style={{ maxWidth: 420 }}>{t.body}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {may ? (
                  <>
                    <button type="button" className="btn btn-sm" onClick={() => { setMsg(null); setEdit({ id: t.id, name: t.name, module: t.module, body: t.body }); }}>Edit</button>{' '}
                    {t.isSystem ? null : <button type="button" className="btn btn-sm" onClick={() => del(t)}>Delete</button>}
                  </>
                ) : null}
              </td>
            </tr>
          ))}
          {list.length === 0 && <tr><td colSpan={4} className="small-muted">No templates yet.</td></tr>}
        </tbody>
      </table>
      {!may && <div className="small-muted" style={{ marginTop: 8 }}>Only Admin, HR and Accounts can change templates.</div>}
    </div>
  );
}

// ============================ LOG ===========================================
function LogView({ cfg }) {
  const [range, setRange] = useState({ range: 'this_month', from: '', to: '' });
  const [module, setModule] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [templates, setTemplates] = useState([]);
  const [data, setData] = useState({ rows: [], total: 0, note: '' });
  const [page, setPage] = useState(0);
  const [err, setErr] = useState('');
  const r = useMemo(() => resolveRange(range), [range]);
  const params = useMemo(() => ({ from: r.from, to: r.to, module: module || undefined, templateId: templateId || undefined }), [r.from, r.to, module, templateId]);
  useEffect(() => { api.get('/wa/templates').then((x) => setTemplates(x.data.templates || [])).catch(() => {}); }, []);
  useEffect(() => { setPage(0); }, [params]);
  useEffect(() => {
    let live = true;
    api.get('/wa/log', { params: { ...params, limit: 50, offset: page * 50 } }).then((x) => { if (live) { setData(x.data); setErr(''); } }).catch((e) => { if (live) setErr(errText(e, 'Could not load the log.')); });
    return () => { live = false; };
  }, [params, page]);
  async function exportCsv() {
    try {
      const x = await api.get('/wa/log/export.csv', { params, responseType: 'blob' });
      const url = URL.createObjectURL(x.data);
      const a = document.createElement('a'); a.href = url; a.download = 'whatsapp-log.csv'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { setErr('Could not export the log.'); }
  }
  const pages = Math.max(1, Math.ceil(data.total / 50));
  return (
    <div>
      <div className="small-muted" style={{ marginBottom: 8 }}>{data.note || 'WhatsApp does not tell us whether a message was delivered or read. "Opened" means the person opened WhatsApp from TeamLink.'}</div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 }}>
        <DateRangePicker value={range} onChange={setRange} />
        <div className="wa-field" style={{ minWidth: 150, margin: 0 }}><label>Module</label>
          <Combo value={module} onChange={(e) => setModule(e.target.value)}><option value="">All modules</option>{MODS.map((m) => <option key={m} value={m}>{m}</option>)}</Combo>
        </div>
        <div className="wa-field" style={{ minWidth: 200, margin: 0 }}><label>Template</label>
          <Combo value={templateId} onChange={(e) => setTemplateId(e.target.value)}><option value="">All templates</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Combo>
        </div>
        {cfg.mayExport && <button type="button" className="btn" onClick={exportCsv}>Export (CSV)</button>}
      </div>
      {err && <div className="wa-note bad">{err}</div>}
      <table className="wa-tbl">
        <thead><tr><th>Date and time</th><th>Who</th><th>Number</th><th>Module</th><th>Template</th><th>Sent by</th><th>Status</th></tr></thead>
        <tbody>
          {data.rows.map((x) => (
            <tr key={x.id}>
              <td>{when(x.at)}</td><td>{x.recipient}</td><td>{x.number}</td><td>{x.module}</td><td>{x.template}</td><td>{x.sentBy}</td>
              <td><span className="status">{x.status}</span></td>
            </tr>
          ))}
          {data.rows.length === 0 && <tr><td colSpan={7} className="small-muted">No WhatsApp chats opened in {r.label}. Open one from a candidate, employee, vendor or invoice row.</td></tr>}
        </tbody>
      </table>
      {pages > 1 && (
        <div className="wa-foot" style={{ justifyContent: 'center', marginTop: 10 }}>
          <button type="button" className="btn btn-sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Back</button>
          <span className="small-muted">Page {page + 1} of {pages} ({data.total} chats)</span>
          <button type="button" className="btn btn-sm" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}

// ============================ SETTINGS ======================================
function Settings({ cfg, onSaved }) {
  const [s, setS] = useState(cfg.settings);
  const [msg, setMsg] = useState(null);
  const may = cfg.mayEditSettings;
  async function save() {
    setMsg(null);
    try {
      const r = await api.put('/wa/settings', { enabled: s.enabled, defaultCountryCode: s.defaultCountryCode, modules: s.modules, dailyBulkLimit: Number(s.dailyBulkLimit) });
      setS(r.data.settings); setMsg({ text: 'Saved.' }); onSaved();
    } catch (e) { setMsg({ bad: true, text: errText(e, 'Could not save.') }); }
  }
  const sw = (label, checked, onChange) => (
    <label className="wa-switch"><input type="checkbox" role="switch" checked={!!checked} disabled={!may} onChange={(e) => onChange(e.target.checked)} /> <span>{label}</span></label>
  );
  return (
    <div style={{ maxWidth: 560 }}>
      {sw('Allow WhatsApp quick chat (the master switch)', s.enabled, (v) => setS({ ...s, enabled: v }))}
      <div className="wa-field"><label>Switch on or off per area</label>
        {sw('HRMS (employees)', s.modules.hrms, (v) => setS({ ...s, modules: { ...s.modules, hrms: v } }))}
        {sw('ATS (candidates and clients)', s.modules.ats, (v) => setS({ ...s, modules: { ...s.modules, ats: v } }))}
        {sw('Accounts (vendors and invoices)', s.modules.accounts, (v) => setS({ ...s, modules: { ...s.modules, accounts: v } }))}
      </div>
      <div className="wa-two">
        <div className="wa-field"><label htmlFor="wa-cc">Default country code</label><input id="wa-cc" inputMode="numeric" value={s.defaultCountryCode} disabled={!may} onChange={(e) => setS({ ...s, defaultCountryCode: e.target.value })} maxLength={3} />
          <div className="small-muted">Added to numbers with 10 digits. India is 91.</div></div>
        <div className="wa-field"><label htmlFor="wa-lim">Daily limit when sending to many (per person)</label><input id="wa-lim" inputMode="numeric" value={s.dailyBulkLimit} disabled={!may} onChange={(e) => setS({ ...s, dailyBulkLimit: e.target.value })} />
          <div className="small-muted">A gentle warning only. It does not stop anyone.</div></div>
      </div>
      <div className="wa-note warn">{cfg.safetyNote}</div>
      {msg && <div className={`wa-note ${msg.bad ? 'bad' : 'ok'}`} role="status">{msg.text}</div>}
      {may ? <button type="button" className="btn btn-primary" onClick={save}>Save</button> : <div className="small-muted">Only Admin, HR and Accounts can change these settings.</div>}
    </div>
  );
}
