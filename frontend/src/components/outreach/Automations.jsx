import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import Combo from '../Combo.jsx';
import './omni2.css';

// ---------------------------------------------------------------------------
// OMNI-CHANNEL > CAMPAIGNS > AUTOMATIONS: a short list of steps for each person ("sequences"): Applied -> WhatsApp -> (no reply in a day) SMS ->
// Call task -> Follow-up task. Workflows, Auto follow-ups, Auto responses and Drip campaigns are the same engine with different starting examples.
// SAFE by default: switched on, an automation only REHEARSES while Test mode is on; it stops when the person replies or says stop; quiet hours
// are kept; only people who agreed to a way get a message there. AI calling is planned, not built (the step is a normal call task for now).
// Server: /api/outreach/automations (outreach/sequences.js).
// ---------------------------------------------------------------------------
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const fmt = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }) : '');
const KIND_TABS = [['', 'All'], ['workflow', 'Workflows'], ['followup', 'Auto follow-ups'], ['response', 'Auto responses'], ['drip', 'Drip campaigns']];
const EXAMPLES = {
  workflow: [{ type: 'message', channel: 'whatsapp', text: 'Hi {{first_name}}, thank you for your interest. We will call you soon. {{unsubscribe}}', waitHours: 0 }, { type: 'message', channel: 'sms', text: 'Hi {{first_name}}, we tried to reach you about the job. Please reply YES to talk. {{unsubscribe}}', waitHours: 24 }, { type: 'task', kind: 'call', note: 'Call the person', waitHours: 24 }, { type: 'task', kind: 'follow_up', note: 'Follow up again', waitHours: 48 }],
  followup: [{ type: 'message', channel: 'whatsapp', text: 'Hi {{first_name}}, a small reminder about your application. {{unsubscribe}}', waitHours: 24 }, { type: 'task', kind: 'call', note: 'Call about the reminder', waitHours: 24 }],
  response: [{ type: 'message', channel: 'whatsapp', text: 'Hi {{first_name}}, thank you for applying. Our team will contact you. {{unsubscribe}}', waitHours: 0 }],
  drip: [{ type: 'message', channel: 'email', subject: 'A job for you', text: 'Hi {{first_name}}, we have a job that may suit you. {{unsubscribe}}', waitHours: 0 }, { type: 'message', channel: 'email', subject: 'Still looking?', text: 'Hi {{first_name}}, are you still looking for a job? {{unsubscribe}}', waitHours: 72 }, { type: 'message', channel: 'whatsapp', text: 'Hi {{first_name}}, one more job for you. {{unsubscribe}}', waitHours: 72 }],
};
const waitWords = (h) => (!h ? 'right away' : (h % 24 === 0 ? `after ${h / 24} day${h / 24 === 1 ? '' : 's'}` : `after ${h} hour${h === 1 ? '' : 's'}`));
const stepWords = (s) => (s.type === 'task' ? `${s.kind === 'call' ? 'Call task' : (s.kind === 'ai_call' ? 'AI call (planned: a call task for now)' : 'Follow-up task')}${s.note ? `: ${s.note}` : ''}` : `${{ whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email' }[s.channel]} message`);

function StepRow({ i, s, last, tpls, onChange, onMove, onDelete }) {
  const set = (k) => (e) => onChange({ ...s, [k]: e.target.value });
  const days = s.waitHours % 24 === 0 && s.waitHours > 0;
  return (
    <div className="oc2-step">
      <div className="oc2-step-n">{i + 1}</div>
      <div className="oc2-step-b">
        <div className="oc2-rule">
          <label className="field"><span>{i === 0 ? 'Start' : 'Wait before this step'}</span>
            <span style={{ display: 'flex', gap: 6 }}>
              <input inputMode="numeric" style={{ width: 80 }} value={days ? s.waitHours / 24 : s.waitHours} onChange={(e) => { const n = Number(e.target.value.replace(/[^\d]/g, '')) || 0; onChange({ ...s, waitHours: days ? n * 24 : n }); }} aria-label="Wait" />
              <Combo value={days ? 'd' : 'h'} onChange={(e) => onChange({ ...s, waitHours: e.target.value === 'd' ? Math.max(1, Math.round(s.waitHours / 24)) * 24 : (s.waitHours || 0) })}><option value="h">hours</option><option value="d">days</option></Combo>
            </span>
          </label>
          <div className="field"><span>What happens</span>
            <Combo value={s.type === 'task' ? `task:${s.kind}` : `message:${s.channel}`} onChange={(e) => { const [t, v] = e.target.value.split(':'); onChange(t === 'task' ? { type: 'task', kind: v, note: s.note || '', waitHours: s.waitHours } : { type: 'message', channel: v, templateKey: s.templateKey || '', text: s.text || '', subject: s.subject || '', waitHours: s.waitHours }); }}>
              <option value="message:whatsapp">Send a WhatsApp message</option><option value="message:sms">Send an SMS</option><option value="message:email">Send an Email</option>
              <option value="task:call">Call task for the owner</option><option value="task:follow_up">Follow-up task for the owner</option><option value="task:ai_call">AI call (planned: becomes a call task)</option>
            </Combo>
          </div>
        </div>
        {s.type === 'message' && (
          <>
            <div className="field"><span>Template (or type the words below)</span>
              <Combo value={s.templateKey || ''} onChange={set('templateKey')}><option value="">I will type the message</option>{tpls.filter((t) => t.channel.toLowerCase() === s.channel).map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</Combo>
            </div>
            {s.channel === 'email' && <label className="field"><span>Subject</span><input value={s.subject || ''} maxLength={200} onChange={set('subject')} /></label>}
            {!s.templateKey && <label className="field"><span>Message ({'{{first_name}}'} puts the name in)</span><textarea className="oc-text" rows={3} maxLength={1000} value={s.text || ''} onChange={set('text')} /></label>}
          </>
        )}
        {s.type === 'task' && <label className="field"><span>What should the person do</span><input value={s.note || ''} maxLength={200} onChange={set('note')} placeholder="Call and ask about the interview" /></label>}
      </div>
      <div className="oc2-step-a">
        <button type="button" className="btn btn-sm" disabled={i === 0} onClick={() => onMove(-1)} aria-label="Move up">Up</button>
        <button type="button" className="btn btn-sm" disabled={last} onClick={() => onMove(1)} aria-label="Move down">Down</button>
        <button type="button" className="btn btn-sm" onClick={onDelete}>Remove</button>
      </div>
    </div>
  );
}

function Editor({ acc, seq, kind, tpls, onClose, onSaved }) {
  const [f, setF] = useState(seq ? { name: seq.name, kind: seq.kind, trigger: seq.trigger, steps: seq.steps, stopOnReply: seq.stopOnReply, quiet: seq.quiet, department: seq.department } : { name: '', kind: kind || 'workflow', trigger: 'manual', steps: EXAMPLES[kind || 'workflow'], stopOnReply: true, quiet: true, department: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const setStep = (i, s) => setF({ ...f, steps: f.steps.map((x, j) => (j === i ? s : x)) });
  const move = (i, d) => { const a = [...f.steps]; const [x] = a.splice(i, 1); a.splice(i + d, 0, x); setF({ ...f, steps: a }); };
  const save = async () => {
    setBusy(true); setErr('');
    try { if (seq) await api.put(`/outreach/automations/${seq.id}`, f); else await api.post('/outreach/automations', f); onSaved(); onClose(); } catch (e) { setErr(errOf(e, 'It could not be saved.')); } finally { setBusy(false); }
  };
  return (
    <Modal title={seq ? `Edit: ${seq.name}` : 'New automation'} size="xwide" onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <div className="oc2-rule">
        <label className="field"><span>Name</span><input value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Applied: WhatsApp, then SMS, then call" /></label>
        <div className="field"><span>Kind</span><Combo value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{KIND_TABS.filter((k) => k[0]).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Combo></div>
        <div className="field"><span>It starts</span><Combo value={f.trigger} onChange={(e) => setF({ ...f, trigger: e.target.value })}><option value="manual">When I add people to it</option><option value="applied">When a person applies</option></Combo></div>
        {acc.departments && acc.departments.length > 0 && <div className="field"><span>Department</span><Combo value={f.department || ''} onChange={(e) => setF({ ...f, department: e.target.value })}><option value="">No department</option>{acc.departments.map((d) => <option key={d} value={d}>{d}</option>)}</Combo></div>}
      </div>
      <h4 style={{ margin: '12px 0 6px' }}>Steps</h4>
      {f.steps.map((s, i) => <StepRow key={i} i={i} s={s} last={i === f.steps.length - 1} tpls={tpls} onChange={(x) => setStep(i, x)} onMove={(d) => move(i, d)} onDelete={() => setF({ ...f, steps: f.steps.filter((_, j) => j !== i) })} />)}
      <div className="oc-row2"><button type="button" className="btn btn-sm" disabled={f.steps.length >= 8} onClick={() => setF({ ...f, steps: [...f.steps, { type: 'message', channel: 'whatsapp', text: '', templateKey: '', waitHours: 24 }] })}>Add a step</button><span className="oc-note">Up to 8 steps. Each step waits after the one before it.</span></div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '6px 0' }}><input type="checkbox" checked={f.stopOnReply} onChange={(e) => setF({ ...f, stopOnReply: e.target.checked })} /> Stop when the person replies or says stop</label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '6px 0' }}><input type="checkbox" checked={f.quiet} onChange={(e) => setF({ ...f, quiet: e.target.checked })} /> Keep quiet hours (no messages at night)</label>
      <div className="oc-note">While Test mode is on, messages are only rehearsed. A message goes only to a person who agreed to that way.</div>
      {err && <div className="bc-err" role="alert">{err}</div>}
    </Modal>
  );
}

function AddPeople({ seq, onClose, onDone }) {
  const [q, setQ] = useState('');
  const [people, setPeople] = useState([]);
  const [chosen, setChosen] = useState({});
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { const t = setTimeout(() => { if (q.trim().length < 2) { setPeople([]); return; } api.get('/outreach/contacts', { params: { q, pageSize: 30, type: 'candidate_lead' } }).then((r) => setPeople(r.data.contacts || [])).catch(() => setPeople([])); }, 250); return () => clearTimeout(t); }, [q]);
  const ids = Object.keys(chosen).filter((k) => chosen[k]);
  const go = async () => { setErr(''); try { const r = await api.post(`/outreach/automations/${seq.id}/enrol`, { contactIds: ids }); setMsg(r.data.ok); onDone(); } catch (e) { setErr(errOf(e, 'They could not be added.')); } };
  return (
    <Modal title={`Add people to: ${seq.name}`} onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Close</button><button type="button" className="btn btn-primary" disabled={!ids.length} onClick={go}>Add {ids.length || ''} {ids.length === 1 ? 'person' : 'people'}</button></>}>
      <label className="field"><span>Find people (type 2 letters of a name, city or skill)</span><input value={q} onChange={(e) => setQ(e.target.value)} /></label>
      <div className="oc2-pickrows">{people.map((p) => <label key={p.id}><input type="checkbox" checked={!!chosen[p.id]} onChange={(e) => setChosen({ ...chosen, [p.id]: e.target.checked })} /> {p.name || 'No name'}{p.city ? `, ${p.city}` : ''}</label>)}</div>
      {msg && <div className="bc-ok" role="status">{msg}</div>}
      {err && <div className="bc-err" role="alert">{err}</div>}
    </Modal>
  );
}

function Happened({ seq, onClose }) {
  const [d, setD] = useState(null);
  useEffect(() => { api.get(`/outreach/automations/${seq.id}/runs`).then((r) => setD(r.data)).catch(() => setD({ runs: [], log: [] })); }, [seq.id]);
  const OUT = { rehearsed: 'Rehearsed (nothing sent)', sent: 'Sent', skipped: 'Skipped', blocked: 'Not sent: no credits', failed: 'Did not go', task: 'Task made', stopped: 'Stopped' };
  return (
    <Modal title={`What happened: ${seq.name}`} size="wide" onClose={onClose} foot={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      {!d && <div className="oc-note">Loading…</div>}
      {d && <>
        <h4 style={{ margin: '0 0 6px' }}>People in it</h4>
        {d.runs.length === 0 ? <div className="oc-note">Nobody yet.</div> : <div className="oc-scroll" style={{ maxHeight: 200 }}><table className="oc2-table"><thead><tr><th>Name</th><th>Now at step</th><th>State</th><th>Next</th></tr></thead><tbody>{d.runs.map((r) => <tr key={r.id}><td className="name">{r.name}</td><td>{r.step}</td><td>{r.status === 'running' ? 'Running' : (r.status === 'done' ? 'Finished' : `Stopped${r.stopReason ? ` (${r.stopReason})` : ''}`)}</td><td>{fmt(r.nextAt)}</td></tr>)}</tbody></table></div>}
        <h4 style={{ margin: '12px 0 6px' }}>Steps done</h4>
        {d.log.length === 0 ? <div className="oc-note">Nothing yet.</div> : <div className="oc-scroll" style={{ maxHeight: 240 }}><table className="oc2-table"><thead><tr><th>When</th><th>Name</th><th>Step</th><th>Result</th></tr></thead><tbody>{d.log.map((l, i) => <tr key={i}><td>{fmt(l.at)}</td><td className="name">{l.name}</td><td>{l.step}</td><td>{OUT[l.outcome] || l.outcome}{l.note ? `: ${l.note}` : ''}</td></tr>)}</tbody></table></div>}
      </>}
    </Modal>
  );
}

export default function Automations({ acc }) {
  const [data, setData] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [tpls, setTpls] = useState([]);
  const [kind, setKind] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [edit, setEdit] = useState(null);
  const [adding, setAdding] = useState(null);
  const [seen, setSeen] = useState(null);
  const load = useCallback(() => {
    api.get('/outreach/automations').then((r) => { setData(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'The automations could not be loaded.')));
    api.get('/outreach/automations/tasks').then((r) => setTasks(r.data.tasks)).catch(() => setTasks([]));
  }, []);
  useEffect(() => { load(); api.get('/outreach/hub/templates').then((r) => setTpls((r.data.items || []).filter((i) => ['message', 'outreach'].includes(i.source) && ['Email', 'WhatsApp', 'SMS'].includes(i.channel)))).catch(() => setTpls([])); }, [load]);
  const flip = async (s) => { setErr(''); setMsg(''); try { const r = await api.post(`/outreach/automations/${s.id}/${s.status === 'on' ? 'off' : 'on'}`); setMsg(r.data.ok); load(); } catch (e) { setErr(errOf(e, 'That did not work.')); } };
  const del = async (s) => { if (!window.confirm(`Remove "${s.name}"? People still in it are stopped.`)) return; try { await api.delete(`/outreach/automations/${s.id}`); load(); } catch (e) { setErr(errOf(e, 'It could not be removed.')); } };
  const done = async (t) => { try { await api.post(`/outreach/automations/tasks/${t.id}/done`); load(); } catch (e) { setErr(errOf(e, 'That did not work.')); } };
  const list = (data ? data.sequences : []).filter((s) => !kind || s.kind === kind);
  return (
    <div>
      <div className="oc-note">Automatic follow-ups for each person: a short list of steps with waiting time between them. While Test mode is on, nothing is really sent.</div>
      <div className="oc2-chips" role="group" aria-label="Kind">{KIND_TABS.map(([v, l]) => <button type="button" key={v || 'all'} className={`oc2-chip${kind === v ? ' on' : ''}`} aria-pressed={kind === v} onClick={() => setKind(v)}>{l}</button>)}</div>
      <div className="oc-bar">{data && data.canManage && <button type="button" className="btn btn-primary" onClick={() => setEdit({ kind })}>New automation</button>}</div>
      {msg && <div className="bc-ok" role="status">{msg}</div>}
      {err && <div className="bc-err" role="alert">{err}</div>}
      {!data && !err && <div className="oc-note">Loading…</div>}
      {data && list.length === 0 && <div className="oc-empty"><b>No automations here yet.</b><div>{data.canManage ? 'Press "New automation". It starts with an example you can change.' : 'They will show here.'}</div></div>}
      <div className="oc-cards">
        {list.map((s) => (
          <div className="oc-card" key={s.id}>
            <h4>{s.name}</h4>
            <div><span className="oc-pill kind">{s.kindWords}</span><span className={`oc-pill ${s.status === 'on' ? 'in' : ''}`}>{s.statusWords}</span>{s.department && <span className="oc-pill">{s.department}</span>}</div>
            <div className="oc-note">{s.triggerWords}</div>
            <ol className="oc2-steps">{s.steps.map((st, i) => <li key={i}>{stepWords(st)} <span className="oc-note">({waitWords(st.waitHours)})</span></li>)}</ol>
            <div className="oc-note">{s.counts.running} running, {s.counts.done} finished, {s.counts.stopped} stopped{s.stopOnReply ? '. Stops on reply' : ''}</div>
            <div className="oc-row2">
              {data.canManage && <button type="button" className="btn btn-sm btn-primary" onClick={() => flip(s)}>{s.status === 'on' ? 'Switch off' : 'Switch on'}</button>}
              {data.canManage && <button type="button" className="btn btn-sm" onClick={() => setEdit(s)}>Edit</button>}
              {data.canManage && <button type="button" className="btn btn-sm" onClick={() => setAdding(s)}>Add people</button>}
              <button type="button" className="btn btn-sm" onClick={() => setSeen(s)}>What happened</button>
              {data.canManage && <button type="button" className="btn btn-sm" onClick={() => del(s)}>Remove</button>}
            </div>
          </div>
        ))}
      </div>
      <h3 className="oc2-h" style={{ marginTop: 16 }}>Tasks for you</h3>
      {tasks.length === 0 ? <div className="oc-note">No tasks from automations.</div> : (
        <div className="oc-scroll oc2-act"><table className="oc2-table"><thead><tr><th>When</th><th>Person</th><th>Task</th><th>State</th></tr></thead>
          <tbody>{tasks.map((t) => <tr key={t.id}><td>{fmt(t.at)}</td><td className="name">{t.name}</td><td>{t.note}</td><td>{t.done ? 'Done' : <button type="button" className="btn btn-sm" onClick={() => done(t)}>Mark done</button>}</td></tr>)}</tbody></table></div>
      )}
      <div className="oc-note" style={{ marginTop: 10 }}>Planned, not built: AI calls, an AI reply bot and AI suggestions for campaigns.</div>
      {edit && <Editor acc={acc} seq={edit.id ? edit : null} kind={edit.kind} tpls={tpls} onClose={() => setEdit(null)} onSaved={load} />}
      {adding && <AddPeople seq={adding} onClose={() => setAdding(null)} onDone={load} />}
      {seen && <Happened seq={seen} onClose={() => setSeen(null)} />}
    </div>
  );
}
