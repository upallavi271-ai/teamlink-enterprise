import { useCallback, useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Panel, Banner, Field, Empty, GsModal, Pill, Tag, ConfirmModal, fmtDateTime } from '../ui.jsx';
import '../marketing/marketing.css';

// AI MARKETING > WORKFLOW AUTOMATION = JOURNEYS for CRM leads. An EVENT starts a journey, steps run one after another with IF / THEN / ELSE branching, and one step makes the AI WRITE a message for that lead that a PERSON
// APPROVES: nothing is ever sent without a person pressing Approve. A journey is OFF until a Sales manager or an Admin switches it on. Server: marketing/journeys.js.
const KIND_WORDS = { wait: 'Wait', if: 'IF', task: 'Make a follow-up task', notify: 'Tell somebody', assign: 'Give the lead to', rate: 'Set the rating', ai_message: 'AI writes a message, a person approves', end: 'End the journey' };
const KINDS = ['wait', 'task', 'notify', 'assign', 'rate', 'ai_message', 'if', 'end'];
const NEW = {
  wait: { kind: 'wait', hours: 24 }, task: { kind: 'task', title: 'Call {{company}}', dueDays: 0, type: 'Call', priority: 'Medium' }, notify: { kind: 'notify', to: 'owner', message: 'Please look at {{company}}.' },
  assign: { kind: 'assign', to: 'turn', onlyIfEmpty: true }, rate: { kind: 'rate', rating: 'Hot', onlyIfEmpty: true }, ai_message: { kind: 'ai_message', goal: '', channel: 'auto' },
  if: { kind: 'if', conds: [{ field: 'touched', value: 'no' }], then: [], else: [] }, end: { kind: 'end' },
};
const EXAMPLES = [
  { label: 'New website lead: give it out, first call, then a nudge', name: 'New website lead', triggerKind: 'new_lead', triggerOpt: { sources: ['website'] }, steps: [
    { kind: 'assign', to: 'turn', onlyIfEmpty: true }, { kind: 'task', title: 'First call: {{company}}', dueDays: 0, type: 'Call', priority: 'High' }, { kind: 'wait', hours: 24 },
    { kind: 'if', conds: [{ field: 'touched', value: 'no' }], then: [{ kind: 'ai_message', goal: 'Say we tried to reach them and ask for a good time to talk', channel: 'auto' }], else: [{ kind: 'end' }] },
  ] },
  { label: 'Hot lead: tell the owner, call today, check in two days later', name: 'Hot lead alert', triggerKind: 'hot_lead', triggerOpt: { sources: [] }, steps: [
    { kind: 'notify', to: 'owner', message: 'Hot lead: {{company}}. Please call within the hour.' }, { kind: 'task', title: 'Call hot lead {{company}}', dueDays: 0, type: 'Call', priority: 'High' }, { kind: 'wait', hours: 48 },
    { kind: 'if', conds: [{ field: 'touched', value: 'no' }], then: [{ kind: 'notify', to: 'owner', message: '{{company}} is a Hot lead and nothing is logged yet.' }], else: [] },
  ] },
  { label: 'Quiet lead: a polite check-in the owner approves', name: 'Quiet lead check-in', triggerKind: 'idle_lead', triggerOpt: { days: 14 }, steps: [
    { kind: 'ai_message', goal: 'Check in politely and ask whether they still need staff', channel: 'auto' }, { kind: 'wait', hours: 72 },
    { kind: 'if', conds: [{ field: 'touched', value: 'no' }], then: [{ kind: 'task', title: 'Call {{company}}: quiet for two weeks', dueDays: 1, type: 'Call', priority: 'Medium' }], else: [] },
  ] },
];

function CondRow({ c, opts, onChange, onRemove }) {
  const set = (p) => onChange({ ...c, ...p });
  const f = c.field;
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', margin: '3px 0' }}>
      <select value={f} onChange={(e) => set({ field: e.target.value, value: e.target.value === 'band' ? 'Hot' : ['owner'].includes(e.target.value) ? 'none' : ['phone', 'email', 'touched'].includes(e.target.value) ? 'yes' : '' })}>{Object.entries(opts.fields).map(([k, w]) => <option key={k} value={k}>{w}</option>)}</select>
      {f === 'band' ? <select value={c.value} onChange={(e) => set({ value: e.target.value })}>{['Hot', 'Warm', 'Cold'].map((x) => <option key={x}>{x}</option>)}</select>
        : f === 'owner' ? <select value={c.value} onChange={(e) => set({ value: e.target.value })}><option value="has">has an owner</option><option value="none">has no owner</option></select>
          : ['phone', 'email', 'touched'].includes(f) ? <select value={c.value} onChange={(e) => set({ value: e.target.value })}><option value="yes">{f === 'touched' ? 'yes' : 'is real'}</option><option value="no">{f === 'touched' ? 'no' : 'is missing'}</option></select>
            : f === 'stage' ? <select value={c.value} onChange={(e) => set({ value: e.target.value })}><option value="">Pick…</option>{opts.stages.map((x) => <option key={x}>{x}</option>)}</select>
              : <input value={c.value} type={['score', 'age'].includes(f) ? 'number' : 'text'} maxLength={80} onChange={(e) => set({ value: e.target.value })} style={{ width: 140 }} />}
      {onRemove ? <TinyBtn onClick={onRemove} aria-label="Remove this condition">✕</TinyBtn> : null}
    </div>
  );
}

function StepRow({ s, opts, onChange, onRemove, inBranch }) {
  const set = (p) => onChange({ ...s, ...p });
  const box = { border: '1px solid var(--line)', borderRadius: 10, padding: '8px 10px', margin: '6px 0', background: '#fff' };
  const days = s.kind === 'wait' && s.hours >= 24 && s.hours % 24 === 0;
  return (
    <div style={box}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}><b style={{ fontSize: 12 }}>{KIND_WORDS[s.kind]}</b><TinyBtn onClick={onRemove} aria-label="Remove this step">Remove</TinyBtn></div>
      {s.kind === 'wait' ? (
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <input type="number" min={1} value={days ? s.hours / 24 : s.hours} onChange={(e) => set({ hours: Number(e.target.value) * (days ? 24 : 1) })} style={{ width: 80 }} />
          <select value={days ? 'd' : 'h'} onChange={(e) => set({ hours: e.target.value === 'd' ? Math.max(1, Math.round(s.hours / 24)) * 24 : Math.max(1, s.hours) })}><option value="h">hours</option><option value="d">days</option></select>
        </div>
      ) : null}
      {s.kind === 'task' ? (
        <div className="form-grid" style={{ marginTop: 6 }}>
          <Field label="TITLE" full><input value={s.title} maxLength={120} onChange={(e) => set({ title: e.target.value })} /></Field>
          <Field label="DUE IN (DAYS)"><input type="number" min={0} max={30} value={s.dueDays} onChange={(e) => set({ dueDays: Number(e.target.value) })} /></Field>
          <Field label="TYPE"><select value={s.type} onChange={(e) => set({ type: e.target.value })}>{['Call', 'WhatsApp', 'Email', 'Meeting', 'Visit', 'Other'].map((x) => <option key={x}>{x}</option>)}</select></Field>
          <Field label="PRIORITY"><select value={s.priority} onChange={(e) => set({ priority: e.target.value })}>{['High', 'Medium', 'Low'].map((x) => <option key={x}>{x}</option>)}</select></Field>
        </div>
      ) : null}
      {s.kind === 'notify' ? (
        <div className="form-grid" style={{ marginTop: 6 }}>
          <Field label="TELL"><select value={s.to} onChange={(e) => set({ to: e.target.value })}><option value="owner">The lead's owner</option>{opts.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></Field>
          <Field label="WORDS" full><input value={s.message} maxLength={300} onChange={(e) => set({ message: e.target.value })} /></Field>
        </div>
      ) : null}
      {s.kind === 'assign' ? (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
          <select value={s.to} onChange={(e) => set({ to: e.target.value })}><option value="turn">The next salesperson in turn</option>{opts.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
          <label style={{ fontSize: 12, display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={s.onlyIfEmpty} onChange={(e) => set({ onlyIfEmpty: e.target.checked })} />only if nobody owns it</label>
        </div>
      ) : null}
      {s.kind === 'rate' ? (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6 }}>
          <select value={s.rating} onChange={(e) => set({ rating: e.target.value })}>{['Hot', 'Warm', 'Cold'].map((x) => <option key={x}>{x}</option>)}</select>
          <label style={{ fontSize: 12, display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={s.onlyIfEmpty} onChange={(e) => set({ onlyIfEmpty: e.target.checked })} />only if there is no rating yet</label>
        </div>
      ) : null}
      {s.kind === 'ai_message' ? (
        <div style={{ marginTop: 6 }}>
          <Field label="WHAT SHOULD THE MESSAGE DO?" full hint="For example: say we tried to reach them and ask for a good time to talk. The AI writes it for each lead; the owner approves or edits it before it is sent.">
            <textarea rows={2} maxLength={300} value={s.goal} onChange={(e) => set({ goal: e.target.value })} style={{ width: '100%' }} />
          </Field>
          <Field label="WAY"><select value={s.channel} onChange={(e) => set({ channel: e.target.value })}><option value="auto">WhatsApp, or email if there is no real phone</option><option value="whatsapp">WhatsApp only</option><option value="email">Email only</option></select></Field>
        </div>
      ) : null}
      {s.kind === 'if' ? (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>All of these must hold:</div>
          {s.conds.map((c, i) => <CondRow key={i} c={c} opts={opts} onChange={(n) => set({ conds: s.conds.map((x, j) => (j === i ? n : x)) })} onRemove={s.conds.length > 1 ? () => set({ conds: s.conds.filter((_, j) => j !== i) }) : null} />)}
          {s.conds.length < 3 ? <TinyBtn onClick={() => set({ conds: [...s.conds, { field: 'band', value: 'Hot' }] })}>+ another condition</TinyBtn> : null}
          <div style={{ borderLeft: '3px solid #86efac', paddingLeft: 10, marginTop: 8 }}><b style={{ fontSize: 11.5, color: '#166534' }}>THEN</b><StepList steps={s.then} opts={opts} onChange={(a) => set({ then: a })} inBranch /></div>
          <div style={{ borderLeft: '3px solid #fcd34d', paddingLeft: 10, marginTop: 8 }}><b style={{ fontSize: 11.5, color: '#92400e' }}>ELSE</b><StepList steps={s.else} opts={opts} onChange={(a) => set({ else: a })} inBranch /></div>
        </div>
      ) : null}
      {inBranch ? null : null}
    </div>
  );
}

function StepList({ steps, opts, onChange, inBranch }) {
  const [add, setAdd] = useState('');
  return (
    <div>
      {steps.map((s, i) => <StepRow key={i} s={s} opts={opts} inBranch={inBranch} onChange={(n) => onChange(steps.map((x, j) => (j === i ? n : x)))} onRemove={() => onChange(steps.filter((_, j) => j !== i))} />)}
      <select value={add} onChange={(e) => { if (e.target.value) { onChange([...steps, JSON.parse(JSON.stringify(NEW[e.target.value]))]); setAdd(''); } }} aria-label="Add a step" style={{ marginTop: 4 }}>
        <option value="">+ Add a step…</option>{KINDS.filter((k) => !(inBranch && k === 'if')).map((k) => <option key={k} value={k}>{KIND_WORDS[k]}</option>)}
      </select>
    </div>
  );
}

function Editor({ opts, j, onClose, onSaved, toast }) {
  const [f, setF] = useState(() => (j ? { id: j.id, name: j.name, triggerKind: j.trigger.kind, triggerOpt: j.trigger.opt, steps: j.steps } : { name: '', triggerKind: 'new_lead', triggerOpt: { sources: [] }, steps: [] }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const setOpt = (p) => setF((x) => ({ ...x, triggerOpt: { ...x.triggerOpt, ...p } }));
  const save = async () => {
    setBusy(true); setErr('');
    try { const body = { name: f.name, triggerKind: f.triggerKind, triggerOpt: f.triggerOpt, steps: f.steps }; const r = f.id ? await omni.put(`/gs/marketing/journeys/${f.id}`, body) : await omni.post('/gs/marketing/journeys', body); toast(r.ok); onSaved(); } catch (e) { setErr(errOf(e, 'It could not be saved.')); } finally { setBusy(false); }
  };
  return (
    <GsModal title={f.id ? 'Change the journey' : 'New journey'} sub="An event starts it, then the steps run for each lead. Nothing is sent unless a person approves an AI message." width={780} onClose={onClose}
      foot={<><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={busy || f.name.trim().length < 3 || !f.steps.length} onClick={save}>{busy ? 'Saving…' : 'Save the journey'}</Btn></>}>
      {err ? <Banner tone="error">{err}</Banner> : null}
      {!f.id ? <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}><small style={{ color: 'var(--muted)' }}>Start from an example:</small>{EXAMPLES.map((x) => <TinyBtn key={x.name} onClick={() => setF({ name: x.name, triggerKind: x.triggerKind, triggerOpt: x.triggerOpt, steps: JSON.parse(JSON.stringify(x.steps)) })}>{x.label}</TinyBtn>)}</div> : null}
      <div className="form-grid">
        <Field label="NAME" full><input value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="For example: New website lead" /></Field>
        <Field label="WHAT STARTS IT" full>
          <select value={f.triggerKind} onChange={(e) => setF({ ...f, triggerKind: e.target.value, triggerOpt: e.target.value === 'idle_lead' ? { days: 14 } : e.target.value === 'stage_change' ? { stage: opts.stages[1] || '' } : { sources: [] } })}>{Object.entries(opts.triggers).map(([k, w]) => <option key={k} value={k}>{w}</option>)}</select>
        </Field>
        {['new_lead', 'hot_lead'].includes(f.triggerKind) ? <Field label="ONLY FROM THESE SOURCES (OPTIONAL)" full hint="Words in the lead's source, separated by commas, for example: website, facebook. Empty = every source."><input value={(f.triggerOpt.sources || []).join(', ')} onChange={(e) => setOpt({ sources: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} placeholder="website, facebook ads" /></Field> : null}
        {f.triggerKind === 'stage_change' ? <Field label="WHEN A LEAD MOVES TO"><select value={f.triggerOpt.stage || ''} onChange={(e) => setOpt({ stage: e.target.value })}>{opts.stages.map((x) => <option key={x}>{x}</option>)}</select></Field> : null}
        {f.triggerKind === 'idle_lead' ? <Field label="QUIET FOR (DAYS)" hint="Open leads with an owner and nothing logged for this long. At most 30 leads a day are taken in."><input type="number" min={1} max={90} value={f.triggerOpt.days || 14} onChange={(e) => setOpt({ days: Number(e.target.value) })} /></Field> : null}
      </div>
      <div style={{ margin: '10px 0 4px', fontWeight: 700, fontSize: 12.5 }}>Steps <small style={{ color: 'var(--muted)', fontWeight: 400 }}>(up to {opts.limits.maxSteps} in all, including the ones inside IF)</small></div>
      <StepList steps={f.steps} opts={opts} onChange={(a) => setF({ ...f, steps: a })} />
    </GsModal>
  );
}

export default function MkJourneysPage() {
  const { toast } = useOmni();
  const [d, setD] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState(null);
  const [del, setDel] = useState(null);
  const [runs, setRuns] = useState(null); // { id, name, runs }
  const [busy, setBusy] = useState('');
  const [mine, setMine] = useState({}); // draft id -> { subject, body } being edited
  const load = useCallback(() => Promise.all([omni.get('/gs/marketing/journeys'), omni.get('/gs/marketing/journeys/drafts')]).then(([a, b]) => { setD(a); setDrafts(b.drafts || []); setErr(''); }).catch((e) => setErr(errOf(e, 'Journeys could not be opened.'))), []);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);
  if (err && !d) return <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={load}>Try again</button></Banner>;
  if (!d) return <div className="card panel">Loading…</div>;
  const flip = async (j, on) => { setBusy(j.id); setErr(''); try { const r = await omni.post(`/gs/marketing/journeys/${j.id}/${on ? 'on' : 'off'}`); toast(r.ok); await load(); } catch (e) { const m = errOf(e, 'That did not work.'); setErr(m); toast(m); } finally { setBusy(''); } };
  const remove = async () => { const j = del; setDel(null); try { const r = await omni.del(`/gs/marketing/journeys/${j.id}`); toast(r.ok); await load(); } catch (e) { setErr(errOf(e, 'It could not be removed.')); } };
  const showRuns = async (j) => { try { const r = await omni.get(`/gs/marketing/journeys/${j.id}/runs`); setRuns({ id: j.id, ...r }); } catch (e) { setErr(errOf(e, 'The leads could not be read.')); } };
  const decide = async (x, approve) => {
    setBusy(x.id); setErr('');
    try { const r = await omni.post(`/gs/marketing/journeys/drafts/${x.id}/decide`, { approve, ...(approve && mine[x.id] ? mine[x.id] : {}) }); toast(r.ok); await load(); } catch (e) { const m = errOf(e, 'That did not work.'); setErr(m); toast(m); await load(); } finally { setBusy(''); }
  };
  const draftOf = (x) => ({ subject: x.subject, body: x.body, ...(mine[x.id] || {}) });
  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="Workflow automation" lead="Journeys for your CRM leads: an event starts one (a new lead, a Hot lead, a stage, a lead gone quiet), steps run with IF / THEN / ELSE, and the AI writes a message that a person approves. Nothing is sent without a person pressing Approve.">
        <Btn primary disabled={!d.canManage} onClick={() => setEdit({ j: null })} title={d.canManage ? '' : 'Only a Sales manager or an Admin can make journeys'}>✦ New journey</Btn>
      </PageHead>
      {err ? <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={() => setErr('')}>Close</button></Banner> : null}
      {!d.canManage ? <Banner tone="warn">You can see journeys and approve the messages for your own leads. Only a Sales manager or an Admin can make, change or switch on a journey.</Banner> : null}
      {drafts.length ? (
        <Panel title="Messages waiting for your approval" sub="The AI wrote these. Nothing is sent until you press Approve. You can edit the words first." right={<span className="pill warn">{drafts.length}</span>}>
          {drafts.map((x) => { const v = draftOf(x); return (
            <div className="mk-row" key={x.id} style={{ alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{x.lead ? x.lead.company : 'A lead'}</b> {x.lead && x.lead.band ? <Pill tone={x.lead.band === 'Hot' ? 'red' : x.lead.band === 'Warm' ? 'warn' : 'draft'} dot>{x.lead.band}</Pill> : null} <Tag green={x.channel === 'whatsapp'}>{x.channel === 'email' ? 'Email' : 'WhatsApp'}</Tag>
                <small>{x.lead ? [x.lead.contactName, x.lead.ownerName && `owner ${x.lead.ownerName}`, x.lead.source].filter(Boolean).join(' · ') : ''} · journey “{x.journeyName}” · written by {x.aiNote || 'the AI'} · {fmtDateTime(x.createdAt)}</small>
                <small>It should: {x.goal}</small>
                {x.channel === 'email' ? <input value={v.subject} maxLength={120} onChange={(e) => setMine({ ...mine, [x.id]: { ...v, subject: e.target.value } })} aria-label="Subject" style={{ width: '100%', margin: '6px 0 0' }} /> : null}
                <textarea rows={4} value={v.body} maxLength={1500} onChange={(e) => setMine({ ...mine, [x.id]: { ...v, body: e.target.value } })} aria-label="The message" style={{ width: '100%', marginTop: 6 }} />
                <small>“Reply STOP to stop these messages” is added at the end.</small>
              </div>
              <div className="mk-acts" style={{ flexDirection: 'column', alignItems: 'stretch', minWidth: 150 }}>
                <Btn small primary disabled={busy === x.id} onClick={() => decide(x, true)}>{busy === x.id ? 'Sending…' : '✔ Approve and send'}</Btn>
                <Btn small disabled={busy === x.id} onClick={() => decide(x, false)}>Do not send</Btn>
                {x.lead ? <TinyBtn onClick={() => window.open(`/crm/leads?open=lead:${x.lead.id}`, '_blank', 'noopener')}>Open the lead ↗</TinyBtn> : null}
              </div>
            </div>
          ); })}
        </Panel>
      ) : null}
      <Panel title="Your journeys" sub={`A journey is OFF until a manager switches it on, and only takes leads that match after that. At most ${d.limits.perDay} new leads a day go into one journey. A closed lead leaves every journey.`} style={{ marginTop: drafts.length ? 14 : 0 }} right={<span className="pill live">{d.journeys.length}</span>}>
        {d.journeys.length === 0 ? <Empty title="No journeys yet" action={d.canManage ? <Btn primary onClick={() => setEdit({ j: null })}>✦ New journey</Btn> : null}>Start from an example: a new website lead gets an owner and a first call; a Hot lead alerts its owner; a quiet lead gets a polite check-in the owner approves.</Empty> : d.journeys.map((j) => (
          <div key={j.id} className="mk-row" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <b>{j.name}</b> {j.status === 'on' ? <Pill tone="live" dot>On</Pill> : <Pill tone="draft" dot>Off</Pill>} <Tag>{j.trigger.words}{j.trigger.kind === 'idle_lead' ? ` (${j.trigger.opt.days} days)` : j.trigger.kind === 'stage_change' ? ` (${j.trigger.opt.stage})` : (j.trigger.opt.sources || []).length ? ` (${j.trigger.opt.sources.join(', ')})` : ''}</Tag>
              <small>{j.summary}</small>
              <small>{j.counts.running} in progress · {j.counts.waiting} waiting for approval · {j.counts.done} finished · {j.counts.stopped} left{j.armedAt && j.status === 'on' ? ` · on since ${fmtDateTime(j.armedAt)}` : ''}</small>
              {runs && runs.id === j.id ? (
                <div style={{ marginTop: 8, background: '#f6f8f7', borderRadius: 8, padding: '8px 10px', fontSize: 12 }}>
                  {runs.runs.length === 0 ? <span style={{ color: 'var(--muted)' }}>No lead has been in this journey yet.</span> : runs.runs.map((r) => (
                    <details key={r.id} style={{ margin: '4px 0' }}><summary style={{ cursor: 'pointer' }}><b>{r.company}</b> · {r.status === 'running' ? 'in progress' : r.status === 'waiting' ? 'waiting for approval' : r.status === 'done' ? 'finished' : 'left'}{r.ownerName ? ` · ${r.ownerName}` : ''}</summary>
                      <ul style={{ margin: '4px 0 0', paddingLeft: 18, color: '#3d4f46' }}>{r.log.map((l, i) => <li key={i}>{fmtDateTime(l.at)}: {l.text}</li>)}</ul></details>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="mk-acts" style={{ flexDirection: 'column', alignItems: 'stretch', minWidth: 150 }}>
              {d.canManage ? (j.status === 'on' ? <Btn small disabled={busy === j.id} onClick={() => flip(j, false)}>Switch off</Btn> : <Btn small primary disabled={busy === j.id} onClick={() => flip(j, true)}>Switch on</Btn>) : null}
              <TinyBtn onClick={() => (runs && runs.id === j.id ? setRuns(null) : showRuns(j))}>{runs && runs.id === j.id ? 'Hide the leads' : 'See the leads'}</TinyBtn>
              {d.canManage ? <TinyBtn onClick={() => setEdit({ j })}>Change</TinyBtn> : null}
              {d.canManage ? <TinyBtn onClick={() => setDel(j)}>Remove</TinyBtn> : null}
            </div>
          </div>
        ))}
      </Panel>
      {edit ? <Editor opts={d} j={edit.j} toast={toast} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} /> : null}
      {del ? <ConfirmModal title={`Remove “${del.name}”?`} text="Leads in it leave it, and nothing waiting for approval will be sent." yes="Remove" danger onNo={() => setDel(null)} onYes={remove} /> : null}
    </div>
  );
}
