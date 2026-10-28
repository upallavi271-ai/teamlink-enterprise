import { useEffect, useRef, useState } from 'react';
import Combo from '../../Combo.jsx';
import omni, { errOf } from '../omniApi.js';
import { Btn, GsModal } from '../ui.jsx';
import { MAX_STEPS, STARTER_ITEMS, newKey, toItems, toSteps } from './workflow.js';

// ---------------------------------------------------------------------------
// The prototype's "Edit workflow" modal for an automation: reorder / retype / remove any step, add a step, save.
// The steps are the real engine's (message WhatsApp / SMS / Email with a template or the words, Wait, Call task, Follow-up task, AI call (Planned)).
// "No reply in N hours, then the next channel" is a Wait step followed by a message on another channel: the button below adds that pair.
// Nothing here sends anything: while Test mode is on, a switched-on automation only rehearses.
// ---------------------------------------------------------------------------
const TYPES = [['msg:whatsapp', 'Send WhatsApp'], ['msg:sms', 'Send SMS'], ['msg:email', 'Send Email'], ['wait', 'Wait'], ['task:call', 'Call task'], ['task:follow_up', 'Follow-up task'], ['task:ai_call', 'AI call (Planned)']];
const typeOf = (it) => (it.k === 'wait' ? 'wait' : (it.k === 'task' ? `task:${it.kind}` : `msg:${it.channel}`));

function retype(it, v) {
  const keep = { _k: it._k };
  if (v === 'wait') return { ...keep, k: 'wait', hours: it.k === 'wait' ? it.hours : 24 };
  if (v.startsWith('task:')) return { ...keep, k: 'task', kind: v.slice(5), note: it.k === 'task' ? it.note : '' };
  return { ...keep, k: 'msg', channel: v.slice(4), templateKey: '', text: it.k === 'msg' ? it.text : '', subject: it.k === 'msg' ? it.subject : '' };
}

export default function WorkflowEditor({ seq, templates, deptNames, isAdmin, focus, onClose, onSaved, toast }) {
  const [name, setName] = useState(seq ? seq.name : '');
  const [trigger, setTrigger] = useState(seq ? seq.trigger : 'manual');
  const [department, setDepartment] = useState(seq ? seq.department : '');
  const [stopOnReply, setStop] = useState(seq ? seq.stopOnReply : true);
  const [quiet, setQuiet] = useState(seq ? seq.quiet : true);
  const [items, setItems] = useState(() => (seq ? toItems(seq.steps) : STARTER_ITEMS()));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const body = useRef(null);

  useEffect(() => {
    if (focus === undefined || focus === null || focus < 0) return;
    const t = setTimeout(() => {
      const el = body.current && body.current.querySelectorAll('.wf-step')[focus];
      if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('wf-focus'); const i = el.querySelector('input,textarea'); if (i) i.focus(); }
    }, 90);
    return () => clearTimeout(t);
  }, [focus]);

  const real = items.filter((i) => i.k !== 'wait').length;
  const set = (i, patch) => setItems((a) => a.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (i, d) => setItems((a) => { const b = [...a]; const [x] = b.splice(i, 1); b.splice(i + d, 0, x); return b; });
  const remove = (i) => { if (items[i].k !== 'wait' && real <= 1) { toast('An automation needs at least one step'); return; } setItems((a) => a.filter((_, j) => j !== i)); };
  const add = (it) => { if (it.k !== 'wait' && real >= MAX_STEPS) { toast(`An automation can have at most ${MAX_STEPS} steps`); return; } setItems((a) => [...a, { _k: newKey(), ...it }]); };

  const save = async () => {
    setErr('');
    if (!name.trim()) { toast('Give the automation a name'); setErr('Give the automation a name.'); return; }
    const { steps, trailingWait } = toSteps(items);
    if (!steps.length) { setErr('Add at least one step.'); return; }
    if (trailingWait) { setErr('A wait needs a step after it. Move the wait up or add a step after it.'); return; }
    for (let i = 0; i < steps.length; i += 1) {
      const s = steps[i];
      if (s.type === 'message' && !s.templateKey && !String(s.text).trim()) { setErr(`Step ${i + 1}: pick a template or type the message.`); return; }
    }
    setBusy(true);
    try {
      const payload = { name: name.trim(), trigger, department, stopOnReply, quiet, steps, kind: seq ? seq.kind : 'workflow' };
      const r = seq ? await omni.put(`/gs/automation/${seq.id}`, payload) : await omni.post('/gs/automation', payload);
      onSaved(r.sequence, !seq);
      onClose();
    } catch (e) { setErr(errOf(e, 'It could not be saved.')); } finally { setBusy(false); }
  };

  const tplFor = (ch) => templates.filter((t) => t.channel === ch);
  return (
    <GsModal title={seq ? 'Edit workflow' : 'Create automation'} sub="Reorder, retype or remove any step. Changes apply to the live journey when you save." width={660} onClose={onClose}
      foot={<><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={busy} onClick={save}>{busy ? 'Saving…' : '💾 Save workflow'}</Btn></>}>
      <div ref={body}>
        <div className="field"><label>AUTOMATION NAME</label><input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Applied: WhatsApp, then SMS, then a call" /></div>
        <div className="form-grid" style={{ marginTop: 13 }}>
          <div className="field"><label>IT STARTS</label>
            <Combo value={trigger} onChange={(e) => setTrigger(e.target.value)}>
              <option value="manual">When I add people to it</option>
              <option value="applied">When a person applies</option>
            </Combo>
          </div>
          <div className="field"><label>DEPARTMENT</label>
            <Combo departments value={department} onChange={(e) => setDepartment(e.target.value)}>
              <option value="">{isAdmin ? 'All departments' : 'No department'}</option>
              {deptNames.map((d) => <option key={d} value={d}>{d}</option>)}
            </Combo>
          </div>
        </div>
        <div className="wf-list">
          {items.map((it, i) => (
            <div className="wf-step" key={it._k}>
              <div className="wf-step-head">STEP {i + 1}
                <button type="button" className="rcsa-del" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button type="button" className="rcsa-del" title="Move down" disabled={i === items.length - 1} onClick={() => move(i, 1)}>↓</button>
                <button type="button" className="rcsa-del" title="Remove step" onClick={() => remove(i)}>🗑</button>
              </div>
              <div className="rcsa-grid">
                <div className="rcsa-f"><label>Step type</label>
                  <Combo value={typeOf(it)} onChange={(e) => setItems((a) => a.map((x, j) => (j === i ? retype(x, e.target.value) : x)))}>
                    {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </Combo>
                </div>
                {it.k === 'wait' && (
                  <div className="rcsa-f"><label>Wait for</label>
                    <div className="au-row">
                      <input style={{ width: 80 }} inputMode="numeric" aria-label="How long" value={it.hours % 24 === 0 && it.hours > 0 ? it.hours / 24 : it.hours}
                        onChange={(e) => { const n = Number(e.target.value.replace(/[^\d]/g, '')) || 0; set(i, { hours: it.hours % 24 === 0 && it.hours > 0 ? n * 24 : n }); }} />
                      <Combo value={it.hours % 24 === 0 && it.hours > 0 ? 'd' : 'h'} onChange={(e) => set(i, { hours: e.target.value === 'd' ? Math.max(1, Math.round(it.hours / 24)) * 24 : it.hours })}>
                        <option value="h">hours</option><option value="d">days</option>
                      </Combo>
                    </div>
                  </div>
                )}
                {it.k === 'task' && (
                  <div className="rcsa-f"><label>What should the person do</label><input value={it.note} maxLength={200} onChange={(e) => set(i, { note: e.target.value })} placeholder="Call and ask about the interview" /></div>
                )}
                {it.k === 'msg' && (
                  <div className="rcsa-f"><label>Message from</label>
                    <Combo value={it.templateKey} onChange={(e) => set(i, { templateKey: e.target.value })}>
                      <option value="">I will type the message</option>
                      {tplFor(it.channel).map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
                    </Combo>
                  </div>
                )}
                {it.k === 'msg' && it.channel === 'email' && <div className="rcsa-f full"><label>Subject</label><input value={it.subject} maxLength={200} onChange={(e) => set(i, { subject: e.target.value })} /></div>}
                {it.k === 'msg' && !it.templateKey && (
                  <div className="rcsa-f full"><label>Message ({'{{first_name}}'} puts the name in)</label>
                    <textarea className="au-textarea" maxLength={1000} value={it.text} onChange={(e) => set(i, { text: e.target.value })} />
                  </div>
                )}
              </div>
              {it.k === 'task' && it.kind === 'ai_call' && <div className="au-sub" style={{ marginTop: 8 }}>Planned: no AI call is made. For now this becomes a normal call task for the owner.</div>}
            </div>
          ))}
        </div>
        <div className="au-row" style={{ marginBottom: 6 }}>
          <button type="button" className="rcs-addcard" style={{ flex: 1, minWidth: 140 }} onClick={() => add({ k: 'msg', channel: 'whatsapp', templateKey: '', text: '', subject: '' })}>＋ Add a step</button>
          <button type="button" className="rcs-addcard" style={{ flex: 1, minWidth: 140 }} onClick={() => add({ k: 'wait', hours: 24 })}>＋ Add a wait</button>
        </div>
        <div className="au-box">
          <b>No reply in a day? Try the next way.</b> Put a <b>Wait</b> between two messages on different ways, for example WhatsApp, wait 24 hours, SMS. If the person replies in that time, the automation stops.
          <div style={{ marginTop: 8 }}>
            <TinyAdd onClick={() => { if (real >= MAX_STEPS) { toast(`An automation can have at most ${MAX_STEPS} steps`); return; } setItems((a) => [...a, { _k: newKey(), k: 'wait', hours: 24 }, { _k: newKey(), k: 'msg', channel: 'sms', templateKey: '', text: 'Hi {{first_name}}, we tried to reach you on WhatsApp about the job. Please reply YES to talk. {{unsubscribe}}', subject: '' }]); }}>＋ If no reply in 24 hours, send an SMS</TinyAdd>
          </div>
        </div>
        <label className="au-check"><input type="checkbox" checked={stopOnReply} onChange={(e) => setStop(e.target.checked)} /> Stop when the person replies or says stop</label>
        <label className="au-check"><input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} /> Keep quiet hours (no messages at night)</label>
        <div className="au-sub">While Test mode is on, messages are only rehearsed. A message goes only to a person who agreed to that way.</div>
        {err && <div className="au-err" role="alert">{err}</div>}
      </div>
    </GsModal>
  );
}

function TinyAdd({ onClick, children }) { return <button type="button" className="tiny-btn" onClick={onClick}>{children}</button>; }
