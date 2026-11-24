// CRM > DASHBOARD > AUTOMATION (wave A, 2026-11-24) - for Sales managers and Admins:
//   Rules        the admins' own "WHEN this happens, IF these are true, DO these" rules, made in a flow builder: drag a step from the
//                palette onto the flow (or tap it), drag steps to reorder, edit each card in place; date rules, waits with an
//                "only if still" check (SLA / escalation), approvals, scripts (Admin). "Try on a record" shows what would happen.
//   Approvals    the multi-step approvals the rules asked for; each step is decided by its approver
//   Webhooks     outside addresses told about CRM events (signed), with the delivery log
//   Slack & Teams  which events are posted where (the channel URLs live in Administration > Integrations)
//   API & AI     CRM API keys (+ OpenAPI file, Zapier / Make / n8n), the MCP token for AI tools, the calendar feed, contacts as vCard
//   Apps         what can be plugged in and whether it is on
//   Switches     everything that reaches outside or works by itself, OFF until an Admin turns it on
// The server decides who may do what (crm/automation.js, crm/connect.js).
import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { useCrm, errOf, dateTimeOf, download, istToday } from './crmShared.jsx';

const TABS = [['rules', 'Rules'], ['approvals', 'Approvals'], ['webhooks', 'Webhooks'], ['chat', 'Slack & Teams'], ['api', 'API & AI tools'], ['apps', 'Apps'], ['switches', 'Switches']];
const STEP_ICON = { update_field: '✏️', assign: '👤', create_task: '📅', add_note: '📝', notify: '🔔', email: '✉️', webhook: '🪝', chat: '💬', wait: '⏳', approval: '✅', script: '⚙️' };
const NEW_STEP = {
  update_field: { field: '', value: '' }, assign: { to: 'round_robin' }, create_task: { title: 'Follow up {name}', inDays: 1, taskType: 'Call', priority: 'Medium', to: 'owner' },
  add_note: { text: '' }, notify: { to: 'owner', title: '{name}', text: '' }, email: { to: 'owner', subject: '', body: '' }, webhook: {}, chat: { tool: 'both', text: '{name}' },
  wait: { amount: 2, unit: 'hours', onlyIf: [] }, approval: { title: 'Approval for {name}', steps: [{ approver: 'managers', label: 'Sales manager' }], holdWon: false }, script: { code: '// record, before, event, today are given. Return what to do, e.g.\n// return { set: { rating: \'Hot\' }, note: \'Big lead\', task: { title: \'Call now\', inDays: 0 } };\nreturn null;' },
};

export default function CrmAutomation() {
  const [tab, setTab] = useState('rules');
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {TABS.map(([k, l]) => <button key={k} type="button" className={`btn btn-sm${tab === k ? ' btn-primary' : ''}`} aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'rules' && <Rules />}
      {tab === 'approvals' && <Approvals />}
      {tab === 'webhooks' && <Webhooks />}
      {tab === 'chat' && <Chat />}
      {tab === 'api' && <ApiAi />}
      {tab === 'apps' && <Apps onOpen={setTab} />}
      {tab === 'switches' && <Switches />}
    </div>
  );
}

function OffNote({ on, what }) {
  if (on) return null;
  return <div className="notice" style={{ marginBottom: 10 }}>{what} is switched off: nothing happens by itself until an Admin turns it on in Switches.</div>;
}

// ---- rules --------------------------------------------------------------------------------------------------------------------
function Rules() {
  const { toast } = useCrm();
  const [meta, setMeta] = useState(null);
  const [d, setD] = useState(null);
  const [open, setOpen] = useState(null); // a rule being edited ({} = new)
  const [runsOf, setRunsOf] = useState(null);
  const load = () => api.get('/crm/a/automation/rules').then((r) => setD(r.data)).catch((e) => setD({ error: errOf(e, 'The rules could not be read.') }));
  useEffect(() => { api.get('/crm/a/automation/meta').then((r) => setMeta(r.data)).catch(() => setMeta(null)); load(); }, []);
  if (!d || !meta) return <div className="small-muted">Loading…</div>;
  if (d.error) return <div className="notice">{d.error}</div>;
  const trig = (k) => (meta.triggers.find((t) => t.key === k) || {}).label || k;
  async function flip(r) { try { await api.put(`/crm/a/automation/rules/${r.id}`, { on: !r.on }); load(); } catch (e) { toast(errOf(e, 'It could not be changed.')); } }
  async function remove(r) { if (!window.confirm(`Remove the rule "${r.name}"? Anything it is waiting on stops.`)) return; try { await api.delete(`/crm/a/automation/rules/${r.id}`); toast('Removed.'); load(); } catch (e) { toast(errOf(e, 'It could not be removed.')); } }
  async function tick() { try { const r = await api.post('/crm/a/automation/tick'); toast(r.data.off ? 'Rules are switched off.' : `Done: ${r.data.resumed} waiting step(s) went on, ${r.data.dated} date rule(s) ran.`); load(); } catch (e) { toast(errOf(e, 'It did not run.')); } }
  return (
    <>
      <OffNote on={d.on} what="Running the rules" />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen({})}>+ New rule</button>
        <select defaultValue="" onChange={(e) => { const t = meta.templates[Number(e.target.value)]; e.target.value = ''; if (t) setOpen({ ...t, on: false }); }} aria-label="Start from a ready rule" style={{ width: 'auto', maxWidth: '100%' }}>
          <option value="">Start from a ready rule…</option>{meta.templates.map((t, i) => <option key={t.name} value={i}>{t.name}</option>)}
        </select>
        <button type="button" className="btn btn-sm" onClick={tick} title="Waiting steps and date rules also run by themselves every minute">Run due steps now</button>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Rule</th><th>When</th><th>Steps</th><th style={{ textAlign: 'right' }}>Runs</th><th>On</th><th /></tr></thead>
          <tbody>
            {!d.rules.length && <tr><td colSpan={6} className="small-muted">No rules yet. Start from a ready rule above.</td></tr>}
            {d.rules.map((r) => (
              <tr key={r.id}>
                <td><button type="button" className="btn btn-sm" style={{ border: 'none', padding: 0, fontWeight: 600, textAlign: 'left' }} onClick={() => setOpen(r)}>{r.name}</button>{r.waiting ? <div className="small-muted" style={{ fontSize: 11.5 }}>{r.waiting} waiting</div> : null}</td>
                <td style={{ fontSize: 12.5 }}>{trig(r.trigger)}{r.time ? ` (${r.time.days} day(s) ${r.time.direction} ${r.time.field})` : ''}</td>
                <td>{r.actions.map((a, i) => <span key={i} title={a.type}>{STEP_ICON[a.type]}</span>)}</td>{/* eslint-disable-line react/no-array-index-key */}
                <td style={{ textAlign: 'right' }}><button type="button" className="btn btn-sm" style={{ border: 'none' }} onClick={() => setRunsOf(r)}>{r.runs}</button></td>
                <td><label className="crm-right"><input type="checkbox" checked={r.on} onChange={() => flip(r)} aria-label={`Rule ${r.name} on`} /> {r.on ? 'On' : 'Off'}</label></td>
                <td><button type="button" className="btn btn-sm" onClick={() => remove(r)}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && <RuleEditor meta={meta} rule={open} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); load(); }} />}
      {runsOf && <RunsModal rule={runsOf} onClose={() => setRunsOf(null)} />}
    </>
  );
}

function RunsModal({ rule, onClose }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get('/crm/a/automation/runs', { params: { ruleId: rule.id } }).then((r) => setRows(r.data.runs)).catch(() => setRows([])); }, [rule.id]);
  return (
    <Modal title={`What "${rule.name}" did`} size="wide" onClose={onClose}>
      {!rows && <div className="small-muted">Loading…</div>}
      {rows && !rows.length && <div className="small-muted">It has not run yet.</div>}
      {(rows || []).map((x) => (
        <div key={x.id} style={{ borderBottom: '1px solid var(--line-soft)', padding: '6px 0' }}>
          <b>{x.entityName || x.entityId}</b> <span className="status review">{x.status}</span> <span className="small-muted" style={{ fontSize: 12 }}>{dateTimeOf(x.createdAt)}{x.dueAt && x.status === 'waiting' ? ` · goes on ${dateTimeOf(x.dueAt)}` : ''}</span>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11.5, margin: '4px 0 0', color: 'var(--ink-soft)' }}>{x.log}</pre>
        </div>
      ))}
    </Modal>
  );
}

function CondRow({ c, fields, ops, onChange, onRemove, allowChanged }) {
  const t = (fields.find((f) => f.key === c.field) || {}).type;
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
      <select value={c.field} onChange={(e) => onChange({ ...c, field: e.target.value })} aria-label="Field" style={{ flex: '1 1 140px' }}>{fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select>
      <select value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value })} aria-label="How" style={{ flex: '1 1 120px' }}>{ops.filter((o) => allowChanged || !['changed', 'changed_to'].includes(o.key)).map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</select>
      {!['empty', 'not_empty', 'changed'].includes(c.op) && <input type="text" value={c.value || ''} onChange={(e) => onChange({ ...c, value: e.target.value })} aria-label="Value" placeholder={t === 'd' ? 'YYYY-MM-DD or today+7' : t === 'o' ? 'a person\'s id' : ''} style={{ flex: '2 1 140px' }} />}
      <button type="button" className="btn btn-sm" onClick={onRemove} aria-label="Remove condition">✕</button>
    </div>
  );
}

function StepFields({ s, set, kind, meta }) {
  const owners = meta.owners || [];
  const upd = (meta.updatable[kind] || []);
  const opt = (k) => (upd.find((u) => u.key === k) || {}).options;
  const fields = meta.fields[kind] || [];
  switch (s.type) {
    case 'update_field': return (
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <select value={s.field} onChange={(e) => set({ field: e.target.value, value: '' })} aria-label="Field to change">{[<option key="" value="">Pick a field…</option>, ...upd.map((u) => <option key={u.key} value={u.key}>{(fields.find((x) => x.key === u.key) || {}).label || u.key}</option>)]}</select>
        {opt(s.field) ? <select value={s.value} onChange={(e) => set({ value: e.target.value })} aria-label="New value"><option value="">Pick…</option>{opt(s.field).map((o) => <option key={o} value={o}>{o}</option>)}</select> : <input type="text" value={s.value} onChange={(e) => set({ value: e.target.value })} aria-label="New value" placeholder={s.field === 'expectedClose' ? 'today+7' : 'new value'} />}
        {!upd.length && <span className="small-muted" style={{ fontSize: 12 }}>Nothing can be changed on this kind of record.</span>}
      </div>
    );
    case 'assign': return <select value={s.to} onChange={(e) => set({ to: e.target.value })} aria-label="Give to"><option value="round_robin">The next salesperson in turn</option>{owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>;
    case 'create_task': return (
      <div className="grid-3">
        <div className="field"><label>Follow-up</label><input type="text" value={s.title} onChange={(e) => set({ title: e.target.value })} /></div>
        <div className="field"><label>In days</label><input type="number" min={0} max={365} value={s.inDays} onChange={(e) => set({ inDays: Number(e.target.value) })} /></div>
        <div className="field"><label>Time</label><input type="time" value={s.time || ''} onChange={(e) => set({ time: e.target.value })} /></div>
        <div className="field"><label>Type</label><select value={s.taskType} onChange={(e) => set({ taskType: e.target.value })}>{['Call', 'Meeting', 'WhatsApp', 'Visit', 'Email', 'Other'].map((x) => <option key={x}>{x}</option>)}</select></div>
        <div className="field"><label>Priority</label><select value={s.priority} onChange={(e) => set({ priority: e.target.value })}>{['High', 'Medium', 'Low'].map((x) => <option key={x}>{x}</option>)}</select></div>
        <div className="field"><label>For</label><select value={s.to} onChange={(e) => set({ to: e.target.value })}><option value="owner">The owner</option>{owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
      </div>
    );
    case 'add_note': return <textarea rows={2} value={s.text} onChange={(e) => set({ text: e.target.value })} aria-label="Note" placeholder="{name} and {owner} are filled in" />;
    case 'notify': return (
      <div className="grid-2">
        <div className="field"><label>To</label><select value={s.to} onChange={(e) => set({ to: e.target.value })}><option value="owner">The owner</option><option value="managers">The Sales managers</option><option value="admins">The Admins</option>{owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
        <div className="field"><label>Title</label><input type="text" value={s.title} onChange={(e) => set({ title: e.target.value })} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Words</label><input type="text" value={s.text} onChange={(e) => set({ text: e.target.value })} /></div>
      </div>
    );
    case 'email': return (
      <div>
        <div className="grid-2">
          <div className="field"><label>To</label><select value={s.to} onChange={(e) => set({ to: e.target.value })}><option value="owner">The owner</option><option value="managers">The Sales managers</option><option value="record">The lead / contact itself</option></select></div>
          <div className="field"><label>Subject</label><input type="text" value={s.subject} onChange={(e) => set({ subject: e.target.value })} /></div>
        </div>
        <textarea rows={3} value={s.body} onChange={(e) => set({ body: e.target.value })} aria-label="Mail" placeholder="{name}, {owner} …" />
        {s.to === 'record' && <div className="small-muted" style={{ fontSize: 11.5 }}>This mails the customer. Anybody who asked for no mails is skipped; it is written on the record&apos;s timeline.</div>}
      </div>
    );
    case 'webhook': return <div className="small-muted" style={{ fontSize: 12 }}>Sends &quot;rule.fired&quot; with the record to every webhook that listens to it (Webhooks tab).</div>;
    case 'chat': return (
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <select value={s.tool} onChange={(e) => set({ tool: e.target.value })} aria-label="Where" style={{ width: 'auto' }}><option value="both">Slack and Teams</option><option value="slack">Slack</option><option value="teams">Teams</option></select>
        <input type="text" value={s.text} onChange={(e) => set({ text: e.target.value })} aria-label="Text" style={{ flex: '1 1 200px' }} />
      </div>
    );
    case 'wait': return (
      <div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <input type="number" min={1} value={s.amount} onChange={(e) => set({ amount: Number(e.target.value) })} aria-label="How long" style={{ width: 90 }} />
          <select value={s.unit} onChange={(e) => set({ unit: e.target.value })} aria-label="Unit" style={{ width: 'auto' }}><option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option></select>
          <span className="small-muted" style={{ fontSize: 12 }}>then go on only if still:</span>
        </div>
        {(s.onlyIf || []).map((c, i) => <CondRow key={i} c={c} fields={fields} ops={meta.ops} allowChanged={false} onChange={(x) => set({ onlyIf: s.onlyIf.map((y, j) => (j === i ? x : y)) })} onRemove={() => set({ onlyIf: s.onlyIf.filter((_, j) => j !== i) })} />)}{/* eslint-disable-line react/no-array-index-key */}
        <button type="button" className="btn btn-sm" onClick={() => set({ onlyIf: [...(s.onlyIf || []), { field: fields[0] ? fields[0].key : '', op: 'eq', value: '' }] })}>+ Only if still…</button>
      </div>
    );
    case 'approval': return (
      <div>
        <div className="field"><label>What is approved</label><input type="text" value={s.title} onChange={(e) => set({ title: e.target.value })} /></div>
        {s.steps.map((st, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap', alignItems: 'center' }}>{/* eslint-disable-line react/no-array-index-key */}
            <span className="small-muted" style={{ fontSize: 12 }}>Step {i + 1}</span>
            <select value={st.approver} onChange={(e) => set({ steps: s.steps.map((x, j) => (j === i ? { ...x, approver: e.target.value } : x)) })} aria-label={`Approver of step ${i + 1}`} style={{ width: 'auto' }}><option value="managers">A Sales manager</option><option value="admins">An Admin</option>{owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
            <input type="text" value={st.label || ''} onChange={(e) => set({ steps: s.steps.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} placeholder="Name of the step" aria-label="Step name" style={{ flex: '1 1 140px' }} />
            <button type="button" className="btn btn-sm" disabled={s.steps.length === 1} onClick={() => set({ steps: s.steps.filter((_, j) => j !== i) })} aria-label="Remove step">✕</button>
          </div>
        ))}
        {s.steps.length < 5 && <button type="button" className="btn btn-sm" onClick={() => set({ steps: [...s.steps, { approver: 'admins', label: '' }] })}>+ Step</button>}
        {kind === 'deal' && <label className="crm-right" style={{ display: 'flex', marginTop: 6 }}><input type="checkbox" checked={!!s.holdWon} onChange={(e) => set({ holdWon: e.target.checked })} /> The deal cannot be marked Won until this is approved</label>}
        <div className="small-muted" style={{ fontSize: 11.5 }}>Each step needs a different person. Rejected: the rule stops here.</div>
      </div>
    );
    case 'script': return (
      <div>
        {!meta.canScript && <div className="small-muted" style={{ fontSize: 12 }}>Only an Admin may write or change a script.</div>}
        <textarea rows={6} value={s.code} disabled={!meta.canScript} onChange={(e) => set({ code: e.target.value })} aria-label="Script" style={{ fontFamily: 'monospace', fontSize: 12 }} />
        <div className="small-muted" style={{ fontSize: 11.5 }}>JavaScript, 200 ms at most, no network or files. Return {'{ set: {field: value}, note, task: {title, inDays}, notify, stop }'}.{meta.scriptsOn ? '' : ' Scripts are switched off (Switches).'}</div>
      </div>
    );
    default: return null;
  }
}

function RuleEditor({ meta, rule, onClose, onSaved }) {
  const { toast } = useCrm();
  const [f, setF] = useState(() => ({ name: rule.name || '', trigger: rule.trigger || 'lead.created', time: rule.time || { kind: 'deal', field: 'expectedClose', days: 3, direction: 'before' }, conditions: rule.conditions || [], matchAll: rule.matchAll !== false, actions: (rule.actions || []).map((a) => ({ ...NEW_STEP[a.type], ...a })), on: !!rule.on }));
  const [drag, setDrag] = useState(null); // { from: index } or { add: type }
  const [busy, setBusy] = useState(false);
  const [tryQ, setTryQ] = useState('');
  const [tryList, setTryList] = useState([]);
  const [tried, setTried] = useState(null);
  const kind = f.trigger === 'time' ? f.time.kind : (meta.triggers.find((t) => t.key === f.trigger) || {}).kind;
  const fields = meta.fields[kind] || [];
  const changeEvent = /\.(updated|stage_changed)$/.test(f.trigger);
  const setStep = (i, patch) => setF((x) => ({ ...x, actions: x.actions.map((a, j) => (j === i ? { ...a, ...patch } : a)) }));
  const insertAt = (i, type) => setF((x) => { const n = [...x.actions]; n.splice(i, 0, { type, ...JSON.parse(JSON.stringify(NEW_STEP[type])) }); return { ...x, actions: n }; });
  const moveTo = (from, to) => setF((x) => { const n = [...x.actions]; const [a] = n.splice(from, 1); n.splice(from < to ? to - 1 : to, 0, a); return { ...x, actions: n }; });
  function dropAt(i) { if (!drag) return; if (drag.add) insertAt(i, drag.add); else if (drag.from !== i && drag.from !== i - 1) moveTo(drag.from, i); setDrag(null); }
  async function save() {
    setBusy(true);
    try {
      const body = { ...f, graph: { layout: 'flow', steps: f.actions.map((a, i) => ({ i, type: a.type })) } };
      if (rule.id) await api.put(`/crm/a/automation/rules/${rule.id}`, body); else await api.post('/crm/a/automation/rules', body);
      toast('Rule saved.'); onSaved();
    } catch (e) { toast(errOf(e, 'The rule could not be saved.')); } finally { setBusy(false); }
  }
  const listOf = { lead: 'leads', deal: 'deals', account: 'accounts' }[kind];
  useEffect(() => {
    if (!listOf || tryQ.trim().length < 2) { setTryList([]); return undefined; }
    const t = setTimeout(() => api.get(`/crm/${listOf}`, { params: { q: tryQ } }).then((r) => setTryList((r.data.rows || []).slice(0, 8))).catch(() => setTryList([])), 300);
    return () => clearTimeout(t);
  }, [tryQ, listOf]);
  const DropZone = ({ i }) => <div className={`crm-flow-drop${drag ? ' on' : ''}`} onDragOver={(e) => e.preventDefault()} onDrop={() => dropAt(i)} aria-hidden="true"><span>↓</span></div>;
  return (
    <Modal title={rule.id ? `Rule: ${rule.name}` : 'New rule'} size="wide" onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save rule'}</button></>}>
      <div className="grid-2">
        <div className="field"><label>Name</label><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <label className="crm-right" style={{ alignSelf: 'end', marginBottom: 12 }}><input type="checkbox" checked={f.on} onChange={(e) => setF({ ...f, on: e.target.checked })} /> This rule is on</label>
      </div>
      <div className="crm-flow">
        <div className="crm-flow-card when">
          <div className="crm-flow-head">WHEN</div>
          <select value={f.trigger} onChange={(e) => setF({ ...f, trigger: e.target.value, conditions: [] })} aria-label="When">{meta.triggers.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</select>
          {f.trigger === 'time' && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
              <input type="number" min={0} max={730} value={f.time.days} onChange={(e) => setF({ ...f, time: { ...f.time, days: Number(e.target.value) } })} aria-label="Days" style={{ width: 80 }} />
              <span>days</span>
              <select value={f.time.direction} onChange={(e) => setF({ ...f, time: { ...f.time, direction: e.target.value } })} aria-label="Before or after" style={{ width: 'auto' }}><option value="before">before</option><option value="after">after</option></select>
              <select value={`${f.time.kind}:${f.time.field}`} onChange={(e) => { const [k, fl] = e.target.value.split(':'); setF({ ...f, time: { ...f.time, kind: k, field: fl }, conditions: [] }); }} aria-label="Which date" style={{ width: 'auto', maxWidth: '100%' }}>
                {Object.entries(meta.timeFields).map(([k, list]) => list.map((x) => <option key={`${k}:${x.key}`} value={`${k}:${x.key}`}>{`${k}: ${x.label}`}</option>))}
              </select>
            </div>
          )}
        </div>
        <div className="crm-flow-arrow" aria-hidden="true">↓</div>
        <div className="crm-flow-card if">
          <div className="crm-flow-head">IF {f.conditions.length > 1 && <select value={f.matchAll ? 'all' : 'any'} onChange={(e) => setF({ ...f, matchAll: e.target.value === 'all' })} aria-label="All or any" style={{ width: 'auto', marginLeft: 6 }}><option value="all">all of these</option><option value="any">any of these</option></select>}</div>
          {!f.conditions.length && <div className="small-muted" style={{ fontSize: 12, marginBottom: 6 }}>Always (no conditions).</div>}
          {f.conditions.map((c, i) => <CondRow key={i} c={c} fields={fields} ops={meta.ops} allowChanged={changeEvent} onChange={(x) => setF({ ...f, conditions: f.conditions.map((y, j) => (j === i ? x : y)) })} onRemove={() => setF({ ...f, conditions: f.conditions.filter((_, j) => j !== i) })} />)}{/* eslint-disable-line react/no-array-index-key */}
          <button type="button" className="btn btn-sm" disabled={!fields.length} onClick={() => setF({ ...f, conditions: [...f.conditions, { field: fields[0].key, op: 'eq', value: '' }] })}>+ Condition</button>
        </div>
        <div className="crm-flow-arrow" aria-hidden="true">↓</div>
        <div className="crm-flow-head" style={{ margin: '2px 0 4px' }}>DO</div>
        <div className="crm-flow-palette" aria-label="Steps you can add">
          {meta.actions.filter((a) => a.key !== 'script' || meta.canScript).map((a) => <button key={a.key} type="button" className="btn btn-sm" draggable onDragStart={() => setDrag({ add: a.key })} onDragEnd={() => setDrag(null)} onClick={() => insertAt(f.actions.length, a.key)} title="Drag onto the flow, or tap to add at the end">{STEP_ICON[a.key]} {a.label}</button>)}
        </div>
        <DropZone i={0} />
        {f.actions.map((a, i) => (
          <div key={i}>{/* eslint-disable-line react/no-array-index-key */}
            <div className={`crm-flow-card step${a.type === 'wait' || a.type === 'approval' ? ' pause' : ''}`} draggable onDragStart={(e) => { if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return; setDrag({ from: i }); }} onDragEnd={() => setDrag(null)}>
              <div className="crm-flow-head" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span aria-hidden="true" style={{ cursor: 'grab' }}>⋮⋮</span> {STEP_ICON[a.type]} {i + 1}. {(meta.actions.find((x) => x.key === a.type) || {}).label}
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                  <button type="button" className="btn btn-sm" disabled={i === 0} onClick={() => moveTo(i, i - 1)} aria-label="Move up">↑</button>
                  <button type="button" className="btn btn-sm" disabled={i === f.actions.length - 1} onClick={() => moveTo(i, i + 2)} aria-label="Move down">↓</button>
                  <button type="button" className="btn btn-sm" onClick={() => setF({ ...f, actions: f.actions.filter((_, j) => j !== i) })} aria-label="Remove step">✕</button>
                </span>
              </div>
              <StepFields s={a} set={(p) => setStep(i, p)} kind={kind} meta={meta} />
            </div>
            <DropZone i={i + 1} />
          </div>
        ))}
        {!f.actions.length && <div className="small-muted" style={{ fontSize: 12 }}>Drag a step here, or tap one above.</div>}
      </div>
      {rule.id && listOf && (
        <div className="card" style={{ marginTop: 12, padding: 10 }}>
          <div className="section-label" style={{ marginTop: 0 }}>Try it on a record (the saved rule; nothing is changed)</div>
          <input type="text" value={tryQ} onChange={(e) => setTryQ(e.target.value)} placeholder={`Type a ${kind} name`} aria-label="Find a record to try on" />
          {tryList.map((x) => <button key={x.id} type="button" className="btn btn-sm" style={{ margin: '4px 4px 0 0' }} onClick={() => api.post(`/crm/a/automation/rules/${rule.id}/try`, { recordId: x.id }).then((r) => setTried(r.data)).catch((e) => toast(errOf(e, 'It could not be tried.')))}>{x.company || x.title || x.name}</button>)}
          {tried && (
            <div style={{ marginTop: 8, fontSize: 13 }}>
              <b>{tried.record.name}: {tried.pass ? 'the rule would run' : 'the rule would NOT run'}</b>
              <ul style={{ margin: '4px 0', paddingLeft: 18 }}>{tried.conditions.map((c, i) => <li key={i}>{c.pass ? '✔' : '✘'} {c.label} <span className="small-muted">(now: {c.now || 'empty'})</span></li>)}</ul>{/* eslint-disable-line react/no-array-index-key */}
              {tried.pass && <ol style={{ margin: 0, paddingLeft: 18 }}>{tried.actions.map((a, i) => <li key={i}>{a.words}</li>)}</ol>}{/* eslint-disable-line react/no-array-index-key */}
            </div>
          )}
        </div>
      )}
      <div className="small-muted" style={{ fontSize: 11.5, marginTop: 8 }}>{'{name}'}, {'{owner}'}, {'{stage}'}, {'{value}'} and {'{field:anyField}'} are filled in. A change a rule makes never starts other rules (no loops).</div>
    </Modal>
  );
}

// ---- approvals ----------------------------------------------------------------------------------------------------------------
export function Approvals() {
  const { toast } = useCrm();
  const [all, setAll] = useState(false);
  const [d, setD] = useState(null);
  const load = () => api.get('/crm/a/automation/approvals', { params: { status: all ? 'all' : '' } }).then((r) => setD(r.data)).catch((e) => setD({ error: errOf(e, 'The approvals could not be read.') }));
  useEffect(() => { load(); }, [all]); // eslint-disable-line react-hooks/exhaustive-deps
  async function decide(a, decision) {
    const note = window.prompt(decision === 'approve' ? 'Approve. A note (optional):' : 'Reject. Why?') ;
    if (note === null) return;
    try { await api.post(`/crm/a/automation/approvals/${a.id}`, { decision, note }); toast(decision === 'approve' ? 'Approved.' : 'Rejected.'); load(); } catch (e) { toast(errOf(e, 'It could not be saved.')); }
  }
  if (!d) return <div className="small-muted">Loading…</div>;
  if (d.error) return <div className="notice">{d.error}</div>;
  const who = (s) => (s.approver === 'managers' ? 'A Sales manager' : s.approver === 'admins' ? 'An Admin' : 'A named person');
  return (
    <>
      <label className="crm-right" style={{ marginBottom: 10, display: 'inline-flex' }}><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show decided ones too</label>
      {!d.approvals.length && <div className="small-muted">Nothing is waiting for approval.</div>}
      {d.approvals.map((a) => (
        <div key={a.id} className="crm-card" style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <b>{a.title}</b> <span className="status review">{a.status}</span>{a.holdWon && a.status === 'Pending' && <span className="small-muted" style={{ fontSize: 12 }}>the deal cannot be won until approved</span>}
            <span className="small-muted" style={{ fontSize: 12, marginLeft: 'auto' }}>{a.ruleName} · {dateTimeOf(a.createdAt)}</span>
          </div>
          <ol style={{ margin: '6px 0', paddingLeft: 18, fontSize: 13 }}>
            {a.steps.map((s, i) => <li key={i} style={{ fontWeight: i === a.step && a.status === 'Pending' ? 700 : 400 }}>{s.label || who(s)}: {s.decision ? `${s.decision === 'approve' ? 'approved' : 'rejected'} by ${s.byName}${s.note ? ` (${s.note})` : ''}` : (i === a.step && a.status === 'Pending' ? 'waiting' : '—')}</li>)}{/* eslint-disable-line react/no-array-index-key */}
          </ol>
          {a.canDecide && <div style={{ display: 'flex', gap: 6 }}><button type="button" className="btn btn-primary btn-sm" onClick={() => decide(a, 'approve')}>Approve</button><button type="button" className="btn btn-sm" onClick={() => decide(a, 'reject')}>Reject</button></div>}
        </div>
      ))}
    </>
  );
}

// ---- webhooks -----------------------------------------------------------------------------------------------------------------
function Webhooks() {
  const { toast } = useCrm();
  const [d, setD] = useState(null);
  const [f, setF] = useState({ url: '', label: '', events: ['deal.won'], includeContact: false });
  const [secret, setSecret] = useState(null);
  const load = () => api.get('/crm/a/wave/webhooks').then((r) => setD(r.data)).catch((e) => setD({ error: errOf(e, 'The webhooks could not be read.') }));
  useEffect(() => { load(); }, []);
  if (!d) return <div className="small-muted">Loading…</div>;
  if (d.error) return <div className="notice">{d.error}</div>;
  async function add() {
    try { const r = await api.post('/crm/a/wave/webhooks', f); setSecret(r.data.secret); setF({ url: '', label: '', events: ['deal.won'], includeContact: false }); load(); } catch (e) { toast(errOf(e, 'It could not be added.')); }
  }
  const edit = (h, patch) => api.put(`/crm/a/wave/webhooks/${h.id}`, patch).then(load).catch((e) => toast(errOf(e, 'It could not be changed.')));
  return (
    <>
      <OffNote on={d.on} what="Sending webhooks" />
      {secret && <div className="notice" style={{ marginBottom: 10 }}>Signing secret (shown once, copy it now): <code style={{ wordBreak: 'break-all' }}>{secret}</code><div className="small-muted" style={{ fontSize: 11.5 }}>Each POST has X-TeamLink-Signature = &quot;sha256=&quot; + HMAC-SHA256 of the body with this secret.</div></div>}
      <div className="tbl-wrap" style={{ marginBottom: 12 }}>
        <table>
          <thead><tr><th>Address</th><th>Events</th><th>Phone / email</th><th>Last</th><th>On</th><th /></tr></thead>
          <tbody>
            {!d.hooks.length && <tr><td colSpan={6} className="small-muted">No webhooks yet.</td></tr>}
            {d.hooks.map((h) => (
              <tr key={h.id}>
                <td style={{ wordBreak: 'break-all' }}><b>{h.label || h.source}</b><div className="small-muted" style={{ fontSize: 11.5 }}>{h.url}</div></td>
                <td style={{ fontSize: 12 }}>{h.events.join(', ')}</td>
                <td><input type="checkbox" checked={h.includeContact} onChange={(e) => edit(h, { includeContact: e.target.checked })} aria-label="Include phone and email" /></td>
                <td style={{ fontSize: 12 }}>{h.lastStatus || '—'}{h.lastAt ? <div className="small-muted">{dateTimeOf(h.lastAt)}</div> : null}</td>
                <td><input type="checkbox" checked={h.on} onChange={(e) => edit(h, { on: e.target.checked })} aria-label="On" /></td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button type="button" className="btn btn-sm" onClick={() => api.post(`/crm/a/wave/webhooks/${h.id}/test`).then((r) => { toast(r.data.message); load(); }).catch((e) => toast(errOf(e, 'The test did not go.')))}>Test</button>
                  <button type="button" className="btn btn-sm" style={{ marginLeft: 6 }} onClick={() => window.confirm('Remove this webhook?') && api.delete(`/crm/a/wave/webhooks/${h.id}`).then(load)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="section-label">Add a webhook</div>
      <div className="grid-2">
        <div className="field"><label>Address (https)</label><input type="url" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://your-system.example.com/teamlink" /></div>
        <div className="field"><label>Name</label><input type="text" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Our ERP" /></div>
      </div>
      <div className="field"><label>Events</label><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{d.events.map((e) => <label key={e.name} className="crm-right" title={e.label}><input type="checkbox" checked={f.events.includes(e.name)} onChange={(x) => setF({ ...f, events: x.target.checked ? [...f.events, e.name] : f.events.filter((y) => y !== e.name) })} /> {e.name}</label>)}</div></div>
      <label className="crm-right" style={{ display: 'flex', marginBottom: 8 }}><input type="checkbox" checked={f.includeContact} onChange={(e) => setF({ ...f, includeContact: e.target.checked })} /> Include phone and email (only if that system may hold them)</label>
      <button type="button" className="btn btn-primary btn-sm" disabled={!f.url || !f.events.length} onClick={add}>Add webhook</button>
      {d.log.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary>Delivery log ({d.log.length})</summary>
          <div className="tbl-wrap"><table><thead><tr><th>When</th><th>Event</th><th>To</th><th>Result</th></tr></thead><tbody>{d.log.map((l) => <tr key={l.id}><td style={{ whiteSpace: 'nowrap' }}>{dateTimeOf(l.at)}</td><td>{l.event}</td><td style={{ wordBreak: 'break-all', fontSize: 12 }}>{l.target}</td><td>{l.ok ? `OK (${l.code})` : `Failed: ${l.error || l.code}`}{l.attempt > 1 ? ` · try ${l.attempt}` : ''}</td></tr>)}</tbody></table></div>
        </details>
      )}
    </>
  );
}

// ---- Slack & Teams ------------------------------------------------------------------------------------------------------------
function Chat() {
  const { toast } = useCrm();
  const [d, setD] = useState(null);
  const load = () => api.get('/crm/a/wave/chat').then((r) => setD(r.data)).catch((e) => setD({ error: errOf(e, 'This could not be read.') }));
  useEffect(() => { load(); }, []);
  if (!d) return <div className="small-muted">Loading…</div>;
  if (d.error) return <div className="notice">{d.error}</div>;
  const save = (k, list) => api.put('/crm/a/wave/switches', { [k]: list }).then(() => { toast('Saved.'); load(); }).catch((e) => toast(errOf(e, 'It could not be saved.')));
  return (
    <>
      <OffNote on={d.on} what="Posting to Slack and Teams" />
      {['slack', 'teams'].map((tool) => (
        <div key={tool} className="crm-card" style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <b>{tool === 'slack' ? 'Slack' : 'Microsoft Teams'}</b>
            <span className={`status ${d[tool].set ? 'active' : 'review'}`}>{d[tool].set ? 'Channel URL saved' : 'Not set up'}</span>
            <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} disabled={!d[tool].set} onClick={() => api.post('/crm/a/wave/chat/test', { tool }).then((r) => toast(r.data.message)).catch((e) => toast(errOf(e, 'It did not go.')))}>Send a test</button>
          </div>
          {!d[tool].set && <div className="small-muted" style={{ fontSize: 12 }}>Paste the channel&apos;s incoming-webhook URL in Administration &gt; Integrations &gt; {tool === 'slack' ? 'Slack' : 'Microsoft Teams'}.</div>}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            {d.events.filter((e) => e.name !== 'rule.fired').map((e) => <label key={e.name} className="crm-right" title={e.name}><input type="checkbox" checked={d[tool].events.includes(e.name)} onChange={(x) => save(`${tool}Events`, x.target.checked ? [...d[tool].events, e.name] : d[tool].events.filter((y) => y !== e.name))} /> {e.label}</label>)}
          </div>
        </div>
      ))}
      <div className="small-muted" style={{ fontSize: 11.5 }}>Leads that come in from an Excel import are not posted one by one. A rule can also post its own words (step &quot;Post to Slack / Teams&quot;).</div>
    </>
  );
}

// ---- API & AI tools -----------------------------------------------------------------------------------------------------------
function ApiAi() {
  const { me, toast } = useCrm();
  const [d, setD] = useState(null);
  const [mcp, setMcp] = useState(null);
  const [feed, setFeed] = useState(null);
  const [f, setF] = useState({ label: 'Zapier', userId: me.userId, scope: 'read', ips: '' });
  const [shown, setShown] = useState(null);
  const load = () => {
    api.get('/crm/a/wave/api-keys').then((r) => setD(r.data)).catch((e) => setD({ error: errOf(e, 'The keys could not be read.') }));
    api.get('/crm/a/wave/mcp').then((r) => setMcp(r.data)).catch(() => setMcp(null));
    api.get('/crm/a/wave/calendar-feed').then((r) => setFeed(r.data)).catch(() => setFeed(null));
  };
  useEffect(() => { load(); }, []);
  if (!d) return <div className="small-muted">Loading…</div>;
  if (d.error) return <div className="notice">{d.error}</div>;
  async function make() { try { const r = await api.post('/crm/a/wave/api-keys', f); setShown({ what: 'API key', value: r.data.key }); load(); } catch (e) { toast(errOf(e, 'The key could not be made.')); } }
  async function makeMcp() { try { const r = await api.post('/crm/a/wave/mcp/tokens', { label: 'CRM AI tool' }); setShown({ what: 'MCP token', value: r.data.token }); load(); } catch (e) { toast(errOf(e, 'The token could not be made.')); } }
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return (
    <>
      <OffNote on={d.on} what="The CRM API" />
      {shown && <div className="notice" style={{ marginBottom: 10 }}>{shown.what} (shown once, copy it now): <code style={{ wordBreak: 'break-all' }}>{shown.value}</code></div>}
      <div className="section-label" style={{ marginTop: 0 }}>CRM API keys</div>
      <div className="tbl-wrap" style={{ marginBottom: 10 }}>
        <table>
          <thead><tr><th>Key</th><th>Acts as</th><th>Can</th><th>Last used</th><th /></tr></thead>
          <tbody>
            {!d.keys.length && <tr><td colSpan={5} className="small-muted">No keys yet.</td></tr>}
            {d.keys.map((k) => (
              <tr key={k.id} style={k.revokedAt ? { opacity: 0.5 } : undefined}>
                <td><b>{k.label}</b> <span className="small-muted">{k.prefix}…</span></td><td>{k.userName}</td><td>{k.scope === 'write' ? 'Read and write' : 'Read'}{k.ips ? <div className="small-muted" style={{ fontSize: 11.5 }}>from {k.ips}</div> : null}</td>
                <td style={{ fontSize: 12 }}>{k.lastUsedAt ? `${dateTimeOf(k.lastUsedAt)} (${k.uses})` : '—'}</td>
                <td>{k.revokedAt ? 'Revoked' : <button type="button" className="btn btn-sm" onClick={() => window.confirm('Revoke this key? Systems using it stop at once.') && api.delete(`/crm/a/wave/api-keys/${k.id}`).then(load)}>Revoke</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid-3">
        <div className="field"><label>Name</label><input type="text" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></div>
        <div className="field"><label>Acts as</label><select value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}><option value={me.userId}>Me</option>{me.owners.filter((o) => o.id !== me.userId).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
        <div className="field"><label>Can</label><select value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}><option value="read">Read only</option><option value="write">Read and write</option></select></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Only from these addresses (optional)</label><input type="text" value={f.ips} onChange={(e) => setF({ ...f, ips: e.target.value })} placeholder="203.0.113.7, 198.51.100.0/24" /></div>
      </div>
      <button type="button" className="btn btn-primary btn-sm" onClick={make}>Make a key</button>
      <div className="small-muted" style={{ fontSize: 12, margin: '8px 0 14px' }}>
        A key does what its person may do in the CRM. The API is <code>{origin}/api/crm-api/v1</code> (<a href={`${origin}/api/crm-api/v1/openapi.json`} target="_blank" rel="noopener noreferrer">OpenAPI file</a>). Zapier / Make / n8n: use a Sales manager&apos;s key; triggers subscribe with <code>POST /v1/hooks {'{url, event}'}</code> (or poll <code>GET /v1/leads?since=</code>), actions use <code>POST /v1/leads</code>, <code>/v1/deals</code>, <code>/v1/activities</code>, <code>/v1/tasks</code>.
      </div>
      <div className="section-label">AI tools (MCP)</div>
      {mcp ? (
        <div className="crm-card" style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 13 }}>Server: <b>{mcp.serverOn ? 'on' : 'off'}</b> (Administration &gt; AI governance) · CRM tools for you: <b>{mcp.tools.filter((t) => t.name.startsWith('crm_')).length}</b>{!mcp.tools.some((t) => t.name.startsWith('crm_')) ? ' (an Admin turns them on in Switches)' : ''}</div>
          <div className="small-muted" style={{ fontSize: 12 }}>Point Claude Desktop or another MCP client at <code>{origin}{mcp.endpoint}</code> with your token. It reads only what you may see; phone numbers and emails are never given out.</div>
          <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <button type="button" className="btn btn-sm" disabled={!mcp.serverOn} onClick={makeMcp}>Make my MCP token</button>
            {(mcp.tokens || []).filter((t) => !t.revokedAt).map((t) => <span key={t.id} className="status review">{t.label} <button type="button" className="btn btn-sm" style={{ border: 'none', padding: '0 4px' }} onClick={() => api.delete(`/crm/a/wave/mcp/tokens/${t.id}`).then(load)} aria-label={`Revoke ${t.label}`}>✕</button></span>)}
          </div>
        </div>
      ) : <div className="small-muted">The MCP details could not be read.</div>}
      <div className="section-label">Google / Outlook</div>
      <div className="crm-card">
        {feed && <div style={{ fontSize: 13 }}>Your follow-ups as a calendar: {feed.on ? <><code style={{ wordBreak: 'break-all' }}>{feed.url.startsWith('http') ? feed.url : `${origin}${feed.url}`}</code> <button type="button" className="btn btn-sm" onClick={() => navigator.clipboard && navigator.clipboard.writeText(feed.url.startsWith('http') ? feed.url : `${origin}${feed.url}`).then(() => toast('Link copied.'))}>Copy</button><div className="small-muted" style={{ fontSize: 12 }}>Google Calendar: Other calendars &gt; From URL. Outlook: Add calendar &gt; Subscribe from web. Keep the link private.</div></> : <span className="small-muted">switched off (Switches: &quot;Calendar feed&quot;).</span>}</div>}
        {me.rights && me.rights.export && <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => download('/crm/a/wave/contacts.vcf', `crm-contacts-${istToday()}.vcf`).catch(() => toast('The download did not work.'))}>Download contacts (vCard, for Google / Outlook contacts)</button>}
        <div className="small-muted" style={{ fontSize: 11.5, marginTop: 6 }}>Meeting invites already open in Google and Outlook (.ics). Two-way mail and calendar sync need the founder&apos;s Google / Microsoft app keys.</div>
      </div>
    </>
  );
}

// ---- apps ---------------------------------------------------------------------------------------------------------------------
function Apps({ onOpen }) {
  const [d, setD] = useState(null);
  useEffect(() => { api.get('/crm/a/wave/apps').then((r) => setD(r.data)).catch((e) => setD({ error: errOf(e, 'The apps could not be read.') })); }, []);
  if (!d) return <div className="small-muted">Loading…</div>;
  if (d.error) return <div className="notice">{d.error}</div>;
  const cls = (s) => (s === 'On' ? 'active' : /Needs/.test(s) ? 'hold' : 'review');
  return (
    <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 240px), 1fr))' }}>
      {d.apps.map((a) => (
        <div key={a.key} className="crm-card">
          <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}><b>{a.name}</b><span className="small-muted" style={{ fontSize: 11.5 }}>{a.group}</span><span className={`status ${cls(a.status)}`} style={{ marginLeft: 'auto' }}>{a.status}</span></div>
          <div className="small-muted" style={{ fontSize: 12, margin: '6px 0' }}>{a.about}</div>
          {a.needs && <div style={{ fontSize: 11.5 }}>Needs: {a.needs}</div>}
          {a.open && a.open !== 'reports' && <button type="button" className="btn btn-sm" onClick={() => onOpen(a.open)}>Set up</button>}
        </div>
      ))}
    </div>
  );
}

// ---- switches -----------------------------------------------------------------------------------------------------------------
const SWITCHES = [
  ['rulesOn', 'Rules run by themselves', 'The rules in the Rules tab act on new and changed records, dates and waits.'],
  ['scriptsOn', 'Rules may run scripts', 'The Admin\'s script steps run (200 ms, no network or files).'],
  ['webhooksOn', 'Webhooks', 'CRM events are sent to the addresses in the Webhooks tab.'],
  ['chatOn', 'Slack / Teams posts', 'The ticked events are posted to the channels.'],
  ['apiOn', 'CRM API', 'API keys work (Zapier / Make / n8n and your own systems).'],
  ['mcpCrm', 'Outside AI tools read the CRM', 'MCP clients get the CRM tools (only what the token\'s person may see; never phone or email).'],
  ['mcpWrite', 'Outside AI tools add notes and follow-ups', 'Two MCP tools may write a note or a follow-up on records the person may change.'],
  ['schedulesOn', 'Scheduled report mails', 'Saved reports are mailed by themselves on their schedule.'],
  ['repsSeeBoard', 'Salespeople see the whole leaderboard', 'Names, points and badges of everyone; never others\' money.'],
  ['calendarFeed', 'Calendar feed of follow-ups', 'Each person\'s private link for Google Calendar / Outlook.'],
];
function Switches() {
  const { toast } = useCrm();
  const [d, setD] = useState(null);
  const load = () => api.get('/crm/a/wave/switches').then((r) => setD(r.data)).catch((e) => setD({ error: errOf(e, 'The switches could not be read.') }));
  useEffect(() => { load(); }, []);
  if (!d) return <div className="small-muted">Loading…</div>;
  if (d.error) return <div className="notice">{d.error}</div>;
  async function flip(k) {
    const on = !d.switches[k];
    if (on && !window.confirm(`Turn on "${SWITCHES.find((s) => s[0] === k)[1]}"?`)) return;
    try { await api.put('/crm/a/wave/switches', { [k]: on }); toast(on ? 'Turned on.' : 'Turned off.'); load(); } catch (e) { toast(errOf(e, 'It could not be changed.')); }
  }
  return (
    <>
      {!d.canChange && <div className="notice" style={{ marginBottom: 10 }}>Only an Admin turns these on or off.</div>}
      {SWITCHES.map(([k, label, why]) => (
        <div key={k} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--line-soft)', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 260px' }}><b>{label}</b><div className="small-muted" style={{ fontSize: 12 }}>{why}</div></div>
          <button type="button" className={`btn btn-sm${d.switches[k] ? '' : ' btn-primary'}`} disabled={!d.canChange} onClick={() => flip(k)} aria-pressed={!!d.switches[k]} aria-label={`${label}: ${d.switches[k] ? 'on' : 'off'}`}>{d.switches[k] ? 'On · turn off' : 'Off · turn on'}</button>
        </div>
      ))}
    </>
  );
}
