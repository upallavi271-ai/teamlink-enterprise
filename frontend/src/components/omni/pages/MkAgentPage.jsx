import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Panel, Pill, Tag, Banner, Field, Tabs, Empty, Kpi, Kpis, GsModal, ConfirmModal, fmtNum, fmtDateTime } from '../ui.jsx';

// AI MARKETING > AI AGENT (2026-11-25). A goal in plain words -> the agent asks for what it does not know (and saves it once) -> a day-by-day PLAN and PREVIEW -> you press "Approve and run" ->
// the steps run in the background through AI Content, AI Images, Approvals and SEO as you -> the results are counted from what really happened. It is not a chatbot: typed words never approve,
// nothing is posted, sent or spent by the agent on the plan's approval, and every number on this screen comes from the saved work. A post or a message to the client is a
// step of its own (Phase 2): you see exactly what goes out, pick the accounts or confirm the recipient, and approve it; a post goes out only when the picture is approved, at its scheduled time.
const API = '/gs/marketing/agent';
const TONE = { done: 'live', running: 'scheduled', queued: 'scheduled', failed: 'red', waiting: 'warn', awaiting_approval: 'warn', cancelled: 'draft', skipped: 'draft', planned: 'draft' };
const RUN_TONE = { running: 'scheduled', attention: 'warn', done: 'live', preview: 'warn', needs_info: 'warn', cancelled: 'draft' };
const LIVE_WORDS = { true: ['live', 'counted by TeamLink'], manual: ['warn', 'typed in by a person'], false: ['draft', 'not connected yet'] };
const rs = (n) => `₹${fmtNum(n)}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const listText = (a) => (a.length <= 1 ? (a[0] || '') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

export default function MkAgentPage() {
  const [tab, setTab] = useState('agent');
  const [meta, setMeta] = useState(null); const [err, setErr] = useState('');
  const [runId, setRunId] = useState('');
  useEffect(() => { omni.get(`${API}/meta`).then(setMeta).catch((e) => setErr(errOf(e, 'The AI Agent could not be opened.'))); }, []);
  if (err && !meta) return <Banner tone="error">{err}</Banner>;
  if (!meta) return <div className="card panel">Loading…</div>;
  const open = (id) => { setRunId(id); setTab('agent'); };
  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="AI Agent" lead="Tell it a goal. It plans, shows you a preview, and after your approval does the steps in the modules you already use. It never posts, sends or spends by itself." />
      <Tabs value={tab} onChange={setTab} tabs={[['agent', 'Agent'], ['runs', 'Goals and steps'], ['business', 'Business'], ['dashboard', 'Dashboard']]} />
      <div style={{ marginTop: 14 }}>
        {tab === 'agent' ? <AgentTab meta={meta} runId={runId} setRunId={setRunId} /> : null}
        {tab === 'runs' ? <RunsTab onOpen={open} /> : null}
        {tab === 'business' ? <BusinessTab onOpen={open} /> : null}
        {tab === 'dashboard' ? <DashboardTab onOpen={open} /> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------- the conversation
function AgentTab({ meta, runId, setRunId }) {
  const [biz, setBiz] = useState([]); const [key, setKey] = useState('own'); const [newName, setNewName] = useState(''); const [goal, setGoal] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  useEffect(() => { omni.get(`${API}/businesses`).then((r) => setBiz(r.businesses || [])).catch(() => setBiz([])); }, []);
  const start = async () => {
    setBusy(true); setErr('');
    try {
      const picked = biz.find((b) => b.key === key);
      const r = await omni.post(`${API}/runs`, { goal, business: key === '__new' ? newName : key, businessName: key === '__new' ? newName : (picked ? picked.name : '') });
      setGoal(''); setRunId(r.run.id);
    } catch (e) { setErr(errOf(e, 'The agent could not take this goal.')); } finally { setBusy(false); }
  };
  if (runId) return <RunView id={runId} onBack={() => setRunId('')} meta={meta} />;
  return (
    <div>
      <Panel title="What do you want to achieve?" sub="In your own words. The agent reads it, uses what it already knows about the business, and asks only for what is missing.">
        {err ? <Banner tone="error">{err}</Banner> : null}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end', marginBottom: 10 }}>
          <Field label="MARKETING FOR">
            <select value={key} onChange={(e) => setKey(e.target.value)}>
              {biz.map((b) => <option key={b.key} value={b.key}>{b.own ? `${b.name} (our own company)` : b.name}</option>)}
              <option value="__new">A client not in the list…</option>
            </select>
          </Field>
          {key === '__new' ? <Field label="CLIENT NAME"><input value={newName} maxLength={80} onChange={(e) => setNewName(e.target.value)} placeholder="For example: Sri Care Clinic" /></Field> : null}
        </div>
        <Field label="YOUR GOAL" full><textarea style={{ minHeight: 70 }} value={goal} maxLength={400} onChange={(e) => setGoal(e.target.value)} placeholder="For example: Promote TeamLink Consultants for seven days" /></Field>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0' }}>
          {meta.examples.map((x) => <TinyBtn key={x} onClick={() => setGoal(x)}>{x}</TinyBtn>)}
        </div>
        <Btn primary disabled={busy || goal.trim().length < 6 || (key === '__new' && newName.trim().length < 2)} onClick={start}>{busy ? 'Reading your goal…' : 'Plan it'}</Btn>
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '10px 0 0' }}>Planning is free and takes no AI model: it is built from the facts saved for the business. Nothing happens until you approve the plan.</p>
      </Panel>
    </div>
  );
}

function RunView({ id, onBack, meta }) {
  const { toast, go } = useOmni();
  const [d, setD] = useState(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const timer = useRef(null);
  const load = useCallback(() => omni.get(`${API}/runs/${id}`).then((r) => { setD(r); setErr(''); return r; }).catch((e) => { setErr(errOf(e, 'This goal could not be opened.')); return null; }), [id]);
  useEffect(() => { load(); }, [load]);
  const status = d && d.run ? d.run.status : '';
  useEffect(() => {
    clearInterval(timer.current);
    if (status === 'running') timer.current = setInterval(load, 3000);
    return () => clearInterval(timer.current);
  }, [status, load]);
  const act = async (fn, okText) => { setBusy(true); try { const r = await fn(); if (r && r.run) setD(r); if (okText) toast(okText); await load(); return r; } catch (e) { toast(errOf(e, 'That did not work.')); return null; } finally { setBusy(false); } };
  if (err && !d) return <div><Banner tone="error">{err}</Banner><Btn onClick={onBack}>Back</Btn></div>;
  if (!d) return <div className="card panel">Loading…</div>;
  const run = d.run; const plan = run.plan;
  const talk = (text) => act(() => omni.post(`${API}/runs/${id}/talk`, { text }));
  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <Btn small onClick={onBack}>← New goal</Btn>
        <b style={{ fontSize: 14 }}>{run.goal}</b>
        <Pill tone={RUN_TONE[run.status] || 'draft'} dot>{run.statusWords}</Pill>
        <Tag>{run.businessName}</Tag>
      </div>
      <Thread messages={d.messages} onSend={run.canAct ? talk : null} />
      {run.status === 'needs_info' ? <Questions run={run} act={act} id={id} /> : null}
      {run.status === 'preview' ? <Preview d={d} act={act} id={id} busy={busy} meta={meta} onBack={onBack} /> : null}
      {['running', 'attention', 'done', 'cancelled'].includes(run.status) ? <Execution d={d} act={act} id={id} go={go} busy={busy} /> : null}
    </div>
  );
}

function Thread({ messages, onSend }) {
  const [text, setText] = useState(''); const end = useRef(null);
  useEffect(() => { if (end.current && end.current.scrollIntoView) end.current.scrollIntoView({ block: 'nearest' }); }, [messages.length]);
  return (
    <div className="card panel" style={{ marginBottom: 12 }}>
      <div style={{ maxHeight: 320, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {messages.map((m) => (
          <div key={m.id} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '86%', background: m.role === 'user' ? '#e9f3ff' : '#f3f6fa', borderRadius: 12, padding: '8px 12px', fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
            <div style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--muted)', marginBottom: 2 }}>{m.role === 'user' ? 'YOU' : 'AGENT'}</div>{m.text}
          </div>
        ))}
        <div ref={end} />
      </div>
      {onSend ? (
        <form style={{ display: 'flex', gap: 8, marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onSend(text.trim()); setText(''); } }}>
          <input style={{ flex: 1 }} value={text} maxLength={600} onChange={(e) => setText(e.target.value)} placeholder='Add a note or a plain change, for example "make it 5 days" or "only Instagram"' />
          <Btn type="submit" disabled={!text.trim()}>Send</Btn>
        </form>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------- the questions
function Questions({ run, act, id }) {
  const qs = run.questions || []; const [vals, setVals] = useState({}); const [skip, setSkip] = useState({});
  const required = qs.filter((q) => q.required); const optional = qs.filter((q) => !q.required);
  const ready = required.every((q) => skip[q.key] || String(vals[q.key] || '').trim());
  const send = () => act(() => omni.post(`${API}/runs/${id}/answer`, { answers: Object.fromEntries(Object.entries(vals).filter(([k, v]) => String(v).trim() && !skip[k])), skip: Object.keys(skip).filter((k) => skip[k]) }), 'Saved. The agent will not ask this again.');
  const one = (q) => (
    <div key={q.key} style={{ marginBottom: 12 }}>
      <Field label={q.label.toUpperCase()} full hint={q.hint}>
        {skip[q.key] ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>Skipped: the plan will not use it and will say so.</div>
          : q.kind === 'list' || q.key === 'about' ? <textarea style={{ minHeight: 70 }} value={vals[q.key] || ''} onChange={(e) => setVals({ ...vals, [q.key]: e.target.value })} placeholder={q.suggest || ''} />
            : <input value={vals[q.key] || ''} onChange={(e) => setVals({ ...vals, [q.key]: e.target.value })} placeholder={q.suggest || q.hint || ''} />}
      </Field>
      <div style={{ fontSize: 12, margin: '2px 0 0' }}>{q.ask}{q.skippable ? <> <button type="button" className="link-btn" onClick={() => setSkip({ ...skip, [q.key]: !skip[q.key] })}>{skip[q.key] ? 'Answer it instead' : 'Skip this'}</button></> : null}</div>
    </div>
  );
  return (
    <Panel title={`I need ${plural(required.length, 'thing')} from you`} sub="Each answer is saved for this business, so you never explain twice. Nothing is guessed.">
      {required.map(one)}
      {optional.length ? <details style={{ margin: '8px 0' }}><summary style={{ cursor: 'pointer', fontSize: 13 }}>Optional: {plural(optional.length, 'more fact')} that make the plan better</summary><div style={{ marginTop: 10 }}>{optional.map(one)}</div></details> : null}
      <Btn primary disabled={!ready} onClick={send}>Save and plan</Btn>
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------------------------- the plan and preview
function Preview({ d, act, id, busy, meta, onBack }) {
  const { run, tasks, preflight } = d; const plan = run.plan; const p = plan.params;
  const [form, setForm] = useState({ days: p.days, platforms: p.platforms, creative: p.creative, startDate: p.startDate, time: p.time, publish: p.publish || 'manual', approver: p.approver || 'team' });
  const [confirm, setConfirm] = useState(false);
  const optional = (run.questions || []).filter((q) => !q.required);
  const changed = form.publish !== (p.publish || 'manual') || form.approver !== (p.approver || 'team') || form.days !== p.days || form.creative !== p.creative || form.startDate !== p.startDate || form.time !== p.time || form.platforms.join() !== p.platforms.join();
  const toggle = (k) => setForm({ ...form, platforms: form.platforms.includes(k) ? form.platforms.filter((x) => x !== k) : [...form.platforms, k] });
  const counts = useMemo(() => { const c = {}; tasks.forEach((t) => { c[t.tool] = (c[t.tool] || 0) + 1; }); return c; }, [tasks]);
  const isSeo = plan.intent === 'seo';
  const willDo = [
    counts['content.draft'] && `${plural(counts['content.draft'], 'draft')} saved in AI Content and sent for approval to your approvers (a bell notice inside TeamLink)`,
    counts['image.banner'] && `${plural(counts['image.banner'], 'banner')} designed in AI Images (free)`,
    counts['image.ai'] && `${plural(counts['image.ai'], 'picture')} made with the AI picture service (free tier, counts against your daily picture limit)`,
    counts['seo.sitecheck'] && `the website ${plan.seo ? plan.seo.url : ''} read once (up to ${plan.seo ? plan.seo.pages : 5} public pages) and scored`,
    counts['seo.blogplan'] && 'a blog plan saved (briefs only)',
    counts['social.post'] && `${plural(counts['social.post'], 'post')} prepared to go public: nothing is posted until you approve each one, pick its accounts and the picture is approved; it then goes out at its scheduled time`,
    counts['client.review'] && `${plural(counts['client.review'], 'picture')} prepared to send to the client on WhatsApp: nothing is sent until you approve each one and confirm who it goes to`,
  ].filter(Boolean);
  const outward = (counts['social.post'] || 0) + (counts['client.review'] || 0) > 0;
  const forYou = tasks.filter((t) => t.manual).length;
  return (
    <div>
      {(preflight.blockers || []).map((b) => <Banner key={b} tone="error">{b}</Banner>)}
      {(preflight.warnings || []).map((b) => <Banner key={b} tone="warn">{b}</Banner>)}
      <Panel title={plan.title} sub={plan.objective}>
        {!isSeo ? (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end', marginBottom: 8 }}>
            {plan.intent !== 'videos' ? <Field label="DAYS"><input type="number" min={1} max={meta.maxDays} style={{ width: 70 }} value={form.days} onChange={(e) => setForm({ ...form, days: Number(e.target.value) })} /></Field> : null}
            <Field label="PLATFORMS"><span style={{ display: 'flex', gap: 10 }}>{Object.entries(meta.platforms).map(([k, w]) => <label key={k} style={{ fontSize: 13 }}><input type="checkbox" checked={form.platforms.includes(k)} onChange={() => toggle(k)} /> {w}</label>)}</span></Field>
            <Field label="PICTURES"><select value={form.creative} onChange={(e) => setForm({ ...form, creative: e.target.value })}><option value="banner">Designed banners (free)</option><option value="ai">AI pictures (free tier)</option><option value="none">No pictures</option></select></Field>
            <Field label="POSTING"><select value={form.publish} onChange={(e) => setForm({ ...form, publish: e.target.value })}><option value="manual">I post by hand</option><option value="agent">The agent posts after I approve each post</option></select></Field>
            {run.businessKey !== 'own' ? <Field label="WHO APPROVES THE PICTURES"><select value={form.approver} onChange={(e) => setForm({ ...form, approver: e.target.value })}><option value="team">Our team</option><option value="client">The client (on WhatsApp, after I approve each send)</option></select></Field> : null}
            <Field label="STARTS"><input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></Field>
            <Field label="POST TIME (IST)"><input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} /></Field>
            <Btn disabled={busy || !changed || !form.platforms.length} onClick={() => act(() => omni.post(`${API}/runs/${id}/plan`, { params: form }), 'Plan made again.')}>Update the plan</Btn>
          </div>
        ) : null}
        {!isSeo ? <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '0 0 8px' }}>Changing the days, platforms, pictures or time builds the plan again and drops edits you made to single days.</p> : null}
        {plan.gaps.length ? <div style={{ margin: '8px 0' }}><b style={{ fontSize: 12.5 }}>What I did not know</b><ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 12.5 }}>{plan.gaps.map((g) => <li key={g}>{g}</li>)}</ul></div> : null}
        <details style={{ margin: '6px 0' }}><summary style={{ cursor: 'pointer', fontSize: 12.5 }}>How this plan was made ({plan.assumptions.length} notes)</summary><ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 12.5 }}>{plan.assumptions.map((g) => <li key={g}>{g}</li>)}</ul></details>
        {plan.strategy ? plan.strategy.map((s) => <div key={s.title} style={{ margin: '8px 0' }}><b style={{ fontSize: 12.5 }}>{s.title}</b><ul style={{ margin: '3px 0', paddingLeft: 18, fontSize: 12.5 }}>{s.points.map((x) => <li key={x}>{x}</li>)}</ul></div>) : null}
      </Panel>
      {optional.length ? <OptionalFacts run={run} act={act} id={id} /> : null}
      {plan.days.map((day) => <DayCard key={day.n} day={day} id={id} act={act} />)}
      <Panel title="What will really happen when you approve" sub="Read this once. The approval below is the only thing that starts it.">
        <ul style={{ margin: '0 0 8px', paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>{willDo.map((x) => <li key={x}>{x}</li>)}{forYou ? <li>{plural(forYou, 'step')} wait for you (post it by hand, make the video, talk to the website owner)</li> : null}</ul>
        <p style={{ fontSize: 13, margin: '0 0 10px' }}><b>What will NOT happen:</b> {outward ? 'this approval posts nothing and messages nobody: every post and every message to the client waits for its own approval below. ' : ''}nothing is posted, no message is sent, no call is made, no money is spent and nothing on a website is changed{outward ? ' by this approval' : ''}.</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Btn primary disabled={busy || (preflight.blockers || []).length > 0} onClick={() => setConfirm(true)}>Approve and run</Btn>
          <Btn onClick={() => act(async () => { await omni.del(`${API}/runs/${id}`); onBack(); return null; }, 'Removed from the list.')}>Discard this plan</Btn>
        </div>
      </Panel>
      {confirm ? <ConfirmModal title="Approve and run this plan?" yes="Approve and run" text={`${willDo.join('; ')}. ${forYou ? `${plural(forYou, 'step')} stay for you. ` : ''}Nothing is posted, sent, called or spent by this approval${outward ? ': each post and each client message waits for its own approval' : ''}. Your name goes into the history as the approver.`} onNo={() => setConfirm(false)} onYes={() => { setConfirm(false); act(() => omni.post(`${API}/runs/${id}/approve`, {}), 'Approved. The steps are running.'); }} /> : null}
    </div>
  );
}

function OptionalFacts({ run, act, id }) {
  const qs = (run.questions || []).filter((q) => !q.required); const [vals, setVals] = useState({}); const [open, setOpen] = useState(false);
  if (!open) return <div style={{ margin: '0 0 12px' }}><Btn small onClick={() => setOpen(true)}>Add {plural(qs.length, 'more fact')} to make the plan better</Btn></div>;
  return (
    <Panel title="Optional facts" sub="Saved for this business. Leave out what you do not want to say.">
      {qs.map((q) => <Field key={q.key} label={q.label.toUpperCase()} full hint={q.hint}>{q.kind === 'list' || q.key === 'about' ? <textarea style={{ minHeight: 60 }} value={vals[q.key] || ''} onChange={(e) => setVals({ ...vals, [q.key]: e.target.value })} /> : <input value={vals[q.key] || ''} onChange={(e) => setVals({ ...vals, [q.key]: e.target.value })} placeholder={q.suggest || ''} />}</Field>)}
      <Btn primary onClick={() => act(() => omni.post(`${API}/runs/${id}/answer`, { answers: Object.fromEntries(Object.entries(vals).filter(([, v]) => String(v).trim())) }), 'Saved.')}>Save and plan again</Btn>
    </Panel>
  );
}

function DayCard({ day, id, act }) {
  const [edit, setEdit] = useState(false); const [texts, setTexts] = useState(day.texts); const [date, setDate] = useState(day.date); const [time, setTime] = useState(day.time); const [headline, setHeadline] = useState(day.headline);
  return (
    <Panel title={day.title} sub={`${day.label} · ${day.contentType}`} right={<TinyBtn onClick={() => setEdit(!edit)}>{edit ? 'Close' : 'Edit'}</TinyBtn>}>
      <div style={{ fontSize: 13, lineHeight: 1.6 }}>
        <div><b>Objective:</b> {day.objective}</div>
        <div><b>Target audience:</b> {day.audience}</div>
        {day.flags.length ? <div style={{ margin: '6px 0' }}>{day.flags.map((f) => <Banner key={f.id + f.match} tone={f.level === 'stop' ? 'error' : 'warn'}><b>{f.level === 'stop' ? 'Change before posting:' : 'Check before posting:'}</b> "{f.match}": {f.why}</Banner>)}</div> : null}
        {day.platforms.map((pl) => (
          <div key={pl} style={{ margin: '8px 0' }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--muted)' }}>{pl.toUpperCase()} CAPTION</div>
            {edit ? <textarea style={{ minHeight: 100, width: '100%' }} value={texts[pl] || ''} onChange={(e) => setTexts({ ...texts, [pl]: e.target.value })} /> : <div style={{ whiteSpace: 'pre-wrap', background: '#f6f8fb', borderRadius: 8, padding: '8px 10px', fontSize: 12.5 }}>{day.texts[pl]}</div>}
          </div>
        ))}
        {edit ? (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
            <Field label="HEADLINE ON THE PICTURE"><input value={headline} maxLength={90} onChange={(e) => setHeadline(e.target.value)} /></Field>
            <Field label="DATE"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="TIME (IST)"><input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
            <Btn primary onClick={() => act(() => omni.put(`${API}/runs/${id}/days/${day.n}`, { texts, headline, date, time }), 'Day saved.').then(() => setEdit(false))}>Save this day</Btn>
          </div>
        ) : null}
        <div><b>Hashtags:</b> {day.hashtags.join(' ') || 'none'}</div>
        <div><b>{day.kind === 'video' ? 'Video scenes' : 'Picture prompt'}:</b> <span style={{ color: 'var(--muted)' }}>{day.mediaPrompt}</span></div>
        <div style={{ marginTop: 6 }}><b>Success metrics:</b> {day.metrics.map((m) => <span key={m.key} title={m.how} style={{ marginRight: 8 }}><Pill tone={LIVE_WORDS[String(m.live)][0]}>{m.label}: {LIVE_WORDS[String(m.live)][1]}</Pill></span>)}</div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------------------------- running and results
function Execution({ d, act, id, go, busy }) {
  const { run, tasks, events, live } = d; const [res, setRes] = useState({ label: 'Enquiries received', value: '', note: '' }); const [confirm, setConfirm] = useState(false); const [done, setDone] = useState(null); const [out, setOut] = useState(null);
  const byDay = useMemo(() => { const m = new Map(); tasks.forEach((t) => { const k = t.day || 0; if (!m.has(k)) m.set(k, []); m.get(k).push(t); }); return [...m.entries()]; }, [tasks]);
  const dayOf = (n) => (run.plan && run.plan.days || []).find((x) => x.n === n);
  const canAct = run.canAct && run.status !== 'cancelled';
  return (
    <div>
      {live ? (
        <Panel title="What really happened" sub="Counted from the saved work, right now. The agent writes nothing here that did not happen.">
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7 }}>{live.lines.map((l) => <li key={l}>{l}</li>)}</ul>
          {live.numbers.results.length ? <div style={{ marginTop: 8, fontSize: 12.5 }}><b>Results typed in:</b> {live.numbers.results.map((x, i) => <span key={i} style={{ marginRight: 10 }}>{x.label}: <b>{x.value}</b> ({x.by})</span>)}</div> : null}
        </Panel>
      ) : null}
      <Panel title="Steps" sub={`${plural(tasks.length, 'step')}${run.approvedByName ? ` · approved by ${run.approvedByName}` : ''}`} right={canAct && ['running', 'attention'].includes(run.status) ? <Btn small danger onClick={() => setConfirm(true)}>Cancel the run</Btn> : null}>
        {byDay.map(([n, list]) => (
          <div key={n} style={{ margin: '0 0 10px' }}>
            <div style={{ fontWeight: 800, fontSize: 13, margin: '4px 0' }}>{n ? (dayOf(n) ? `${dayOf(n).title} · ${dayOf(n).label}` : `Day ${n}`) : 'Steps'}</div>
            {list.map((t) => (
              <div key={t.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 0', borderTop: '1px solid #eef1f5', flexWrap: 'wrap' }}>
                <div style={{ width: 150 }}><Pill tone={TONE[t.status] || 'draft'} dot>{t.statusWords}</Pill></div>
                <div style={{ flex: 1, minWidth: 220, fontSize: 13 }}>
                  <div>{t.title}{t.attempts > 1 ? <span style={{ color: 'var(--muted)' }}> · {t.attempts} tries</span> : null}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t.does}</div>
                  {t.summary ? <div style={{ fontSize: 12.5 }}>{t.summary}</div> : null}
                  {t.outward && t.note && ['queued', 'running', 'done'].includes(t.status) ? <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Approved by {run.approvedByName || 'you'} to {t.note}{t.status === 'queued' && t.scheduled && t.scheduledAt ? `. Goes out at ${fmtDateTime(t.scheduledAt)} (checked every few minutes).` : '.'}</div> : null}
                  {t.error ? <div style={{ fontSize: 12.5, color: '#9b1c1c' }}>{t.error}</div> : null}
                  {t.data && t.data.top && t.data.top.length ? <ul style={{ margin: '3px 0', paddingLeft: 18, fontSize: 12 }}>{t.data.top.map((x) => <li key={x}>{x}</li>)}</ul> : null}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 3 }}>{t.refs.filter((x) => x.page).map((x) => <TinyBtn key={x.id} onClick={() => go(x.page)}>Open {x.label}{x.status ? ` (${x.status})` : ''}</TinyBtn>)}{t.refs.filter((x) => x.kind === 'link').map((x) => <a key={x.id} href={x.id} target="_blank" rel="noreferrer noopener" style={{ fontSize: 12 }}>{x.label}</a>)}</div>
                </div>
                {canAct ? (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {t.status === 'failed' || t.status === 'skipped' ? <TinyBtn disabled={busy} onClick={() => act(() => omni.post(`${API}/tasks/${t.id}/retry`, {}), 'Trying again.')}>Retry</TinyBtn> : null}
                    {t.status === 'waiting' && t.manual ? <TinyBtn disabled={busy} onClick={() => setDone(t)}>Mark done</TinyBtn> : null}
                    {t.status === 'waiting' && t.manual ? <TinyBtn disabled={busy} onClick={() => act(() => omni.post(`${API}/tasks/${t.id}/done`, { action: 'skip' }), 'Skipped.')}>Skip</TinyBtn> : null}
                    {t.status === 'awaiting_approval' && t.needsDetails ? <TinyBtn disabled={busy} onClick={() => setOut(t)}>Review and approve</TinyBtn> : null}
                    {t.status === 'awaiting_approval' && !t.needsDetails ? <TinyBtn disabled={busy} onClick={() => act(() => omni.post(`${API}/tasks/${t.id}/approve`, {}), 'Approved.')}>Approve this step</TinyBtn> : null}
                    {['planned', 'queued', 'waiting', 'awaiting_approval', 'running'].includes(t.status) ? <TinyBtn disabled={busy} onClick={() => act(() => omni.post(`${API}/tasks/${t.id}/cancel`, {}), 'Cancel requested.')}>Cancel</TinyBtn> : null}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ))}
      </Panel>
      {canAct ? (
        <Panel title="Add a result" sub="TeamLink cannot read enquiries or reach by campaign yet. Type in a real number you counted: it is kept with your name and shown in the summary.">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
            <Field label="WHAT"><input value={res.label} maxLength={60} onChange={(e) => setRes({ ...res, label: e.target.value })} /></Field>
            <Field label="NUMBER"><input style={{ width: 90 }} value={res.value} onChange={(e) => setRes({ ...res, value: e.target.value })} /></Field>
            <Field label="NOTE (OPTIONAL)"><input value={res.note} maxLength={200} onChange={(e) => setRes({ ...res, note: e.target.value })} /></Field>
            <Btn disabled={busy || !res.value.trim()} onClick={() => act(() => omni.post(`${API}/runs/${id}/results`, res), 'Result added.').then(() => setRes({ ...res, value: '', note: '' }))}>Add</Btn>
          </div>
        </Panel>
      ) : null}
      <details className="card panel"><summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>History ({events.length})</summary>
        <table className="mk-table"><tbody>{events.map((e) => <tr key={e.id}><td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fmtDateTime(e.at)}</td><td style={{ fontSize: 12.5 }}>{e.text}{e.byName ? <span style={{ color: 'var(--muted)' }}> · {e.byName}</span> : null}</td></tr>)}</tbody></table>
      </details>
      {confirm ? <ConfirmModal danger title="Cancel this run?" yes="Cancel the run" text="Steps that are waiting will not run. A step that has already started finishes and its result is kept. Drafts and pictures already made stay in AI Content and AI Images." onNo={() => setConfirm(false)} onYes={() => { setConfirm(false); act(() => omni.post(`${API}/runs/${id}/cancel`, { reason: 'Cancelled from the AI Agent screen' }), 'Run cancelled.'); }} /> : null}
      {out ? <OutwardModal task={out} tasks={tasks} runId={id} onClose={() => setOut(null)} reload={() => act(async () => null)} /> : null}
      {done ? <DoneModal task={done} onNo={() => setDone(null)} onYes={(b) => { const t = done; setDone(null); act(() => omni.post(`${API}/tasks/${t.id}/done`, { action: 'done', ...b }), 'Marked done.'); }} /> : null}
    </div>
  );
}
// an outward step: what would go out, exactly, and the person's own choices. Nothing leaves TeamLink before "Approve" here (and a post waits for its scheduled time).
function OutwardModal({ task, tasks, runId, onClose, reload }) {
  const { toast } = useOmni();
  const [prep, setPrep] = useState(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [form, setForm] = useState({ accountIds: [] });
  useEffect(() => {
    omni.get(`${API}/tasks/${task.id}/prepare`).then((r) => { setPrep(r); setForm(task.tool === 'social.post' ? { accountIds: [] } : { clientName: r.defaults.clientName, contactName: r.defaults.contactName, contactPhone: r.defaults.contactPhone, contactEmail: r.defaults.contactEmail, email: false, message: r.message }); }).catch((e) => setErr(errOf(e, 'This step could not be opened.')));
  }, [task.id, task.tool]);
  const isPost = task.tool === 'social.post';
  const waiting = tasks.filter((x) => x.tool === task.tool && x.status === 'awaiting_approval').length;
  const go = async (all) => {
    setBusy(true); setErr('');
    try {
      const body = isPost ? { accountIds: form.accountIds } : { ...form };
      if (all && !isPost) delete body.message; // each day keeps its own caption in its message
      await (all ? omni.post(`${API}/runs/${runId}/approve-steps`, { tool: task.tool, ...body }) : omni.post(`${API}/tasks/${task.id}/approve`, body));
      toast(isPost ? 'Approved. It goes out at its scheduled time.' : 'Approved. It is being sent.'); onClose(); await reload();
    } catch (e) { setErr(errOf(e, 'It could not be approved.')); } finally { setBusy(false); }
  };
  const ok = prep && prep.ready && (isPost ? form.accountIds.length > 0 : String(form.contactPhone || '').trim() && String(form.clientName || '').trim().length > 1);
  const tick = (id) => setForm({ ...form, accountIds: form.accountIds.includes(id) ? form.accountIds.filter((x) => x !== id) : [...form.accountIds, id] });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <GsModal title={isPost ? 'Approve this post' : 'Send this picture to the client'} sub={task.title} width={620} onClose={onClose}
      foot={<><Btn onClick={onClose}>Cancel</Btn>{waiting > 1 ? <Btn disabled={busy || !ok} onClick={() => go(true)}>{isPost ? `Approve all ${waiting} posts with these accounts` : `Send all ${waiting} to this client (each with its own caption)`}</Btn> : null}<Btn primary disabled={busy || !ok} onClick={() => go(false)}>{isPost ? 'Approve this post' : 'Send to the client'}</Btn></>}>
      {err ? <Banner tone="error">{err}</Banner> : null}
      {!prep && !err ? <div>Loading…</div> : null}
      {prep && !prep.ready && prep.reason ? <Banner tone="warn">{prep.reason}</Banner> : null}
      {prep && prep.media ? <p style={{ fontSize: 13, margin: '4px 0' }}><b>Picture:</b> {prep.media.title} ({prep.media.status})</p> : null}
      {prep && isPost ? (
        <div>
          <p style={{ fontSize: 13, margin: '4px 0' }}><b>Goes out:</b> {prep.scheduledLabel}. TeamLink posts it at that time (it checks every few minutes); if the time has passed it posts within a few minutes of your approval.</p>
          {Object.entries(prep.captions || {}).filter(([k]) => prep.accounts.some((a) => a.platform === k)).map(([k, v]) => <div key={k} style={{ margin: '6px 0' }}><div style={{ fontSize: 11, fontWeight: 800, color: 'var(--muted)' }}>{k.toUpperCase()} WORDS</div><div style={{ whiteSpace: 'pre-wrap', background: '#f6f8fb', borderRadius: 8, padding: '8px 10px', fontSize: 12.5 }}>{v}</div></div>)}
          <div style={{ fontWeight: 800, fontSize: 12, margin: '8px 0 4px' }}>POST ON</div>
          {prep.accounts.length ? prep.accounts.map((a) => <label key={a.id} style={{ display: 'block', fontSize: 13, margin: '3px 0' }}><input type="checkbox" checked={form.accountIds.includes(a.id)} onChange={() => tick(a.id)} /> {a.platform === 'x' ? 'X' : a.platform[0].toUpperCase() + a.platform.slice(1)}: {a.name}{a.username ? ` (@${a.username})` : ''}{a.parentName ? ` · ${a.parentName}` : ''}</label>) : <div style={{ fontSize: 13, color: 'var(--muted)' }}>No connected account for these platforms.</div>}
          <p style={{ fontSize: 12.5, margin: '10px 0 0' }}><b>It goes public.</b> You are approving this exact picture and these words on the accounts you ticked. Only an approved picture is posted.</p>
        </div>
      ) : null}
      {prep && !isPost ? (
        <div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Field label="CLIENT (COMPANY)"><input value={form.clientName || ''} maxLength={120} onChange={set('clientName')} /></Field>
            <Field label="CONTACT NAME"><input value={form.contactName || ''} maxLength={120} onChange={set('contactName')} /></Field>
            <Field label="CLIENT'S WHATSAPP NUMBER"><input value={form.contactPhone || ''} maxLength={30} onChange={set('contactPhone')} placeholder="For example 98765 43210" /></Field>
            <Field label="CLIENT'S EMAIL (OPTIONAL)"><input value={form.contactEmail || ''} maxLength={160} onChange={set('contactEmail')} /></Field>
          </div>
          <label style={{ fontSize: 13 }}><input type="checkbox" checked={!!form.email} onChange={(e) => setForm({ ...form, email: e.target.checked })} /> Also send the link by email</label>
          <Field label="MESSAGE THE CLIENT SEES" full><textarea style={{ minHeight: 80 }} value={form.message || ''} maxLength={400} onChange={set('message')} /></Field>
          <p style={{ fontSize: 12.5, margin: '10px 0 0' }}><b>The client is messaged.</b> TeamLink sends the picture and this message on WhatsApp from the company's Digital Marketing number; the client approves it or asks for changes on a private link. Check the number: this is the person who receives it.</p>
        </div>
      ) : null}
    </GsModal>
  );
}

function DoneModal({ task, onYes, onNo }) {
  const [url, setUrl] = useState(''); const [note, setNote] = useState('');
  return (
    <GsModal title="Mark this step done" onClose={onNo} width={460} foot={<><Btn onClick={onNo}>Cancel</Btn><Btn primary onClick={() => onYes({ url, note })}>Mark done</Btn></>}>
      <p style={{ fontSize: 13, margin: '0 0 8px' }}>{task.title}</p>
      <Field label="LINK TO THE LIVE POST (OPTIONAL)"><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" /></Field>
      <Field label="NOTE (OPTIONAL)"><input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></Field>
      <p style={{ fontSize: 12, color: 'var(--muted)', margin: '8px 0 0' }}>Only content that has been approved can be marked as posted.</p>
    </GsModal>
  );
}

// ---------------------------------------------------------------------------------------------------------------- goals and steps
function RunsTab({ onOpen }) {
  const { toast } = useOmni();
  const [list, setList] = useState(null); const [err, setErr] = useState('');
  const load = useCallback(() => omni.get(`${API}/runs`).then((r) => setList(r.runs)).catch((e) => setErr(errOf(e, 'The goals could not be read.'))), []);
  useEffect(() => { load(); }, [load]);
  if (err) return <Banner tone="error">{err}</Banner>;
  if (!list) return <div className="card panel">Loading…</div>;
  if (!list.length) return <Empty title="No goals yet">Give the agent a goal on the Agent tab. Every goal, plan and step is kept here.</Empty>;
  return (
    <Panel title="Your goals" sub="Open one to see its plan, steps, history and results. Pending steps can be cancelled there.">
      <table className="mk-table"><tbody>
        {list.map((r) => (
          <tr key={r.id}>
            <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fmtDateTime(r.createdAt)}</td>
            <td><b style={{ fontSize: 13 }}>{r.title}</b><div style={{ fontSize: 12, color: 'var(--muted)' }}>{r.goal} · {r.businessName}{r.createdByName && !r.mine ? ` · ${r.createdByName}` : ''}</div></td>
            <td><Pill tone={RUN_TONE[r.status] || 'draft'} dot>{r.statusWords}</Pill></td>
            <td style={{ fontSize: 12 }}>{r.counts.total ? `${r.counts.done}/${r.counts.total} done${r.counts.failed ? `, ${r.counts.failed} failed` : ''}${r.counts.waiting ? `, ${r.counts.waiting} for you` : ''}` : ''}</td>
            <td style={{ whiteSpace: 'nowrap' }}><TinyBtn onClick={() => onOpen(r.id)}>Open</TinyBtn>{r.canAct && ['needs_info', 'preview', 'cancelled', 'done'].includes(r.status) ? <TinyBtn onClick={() => omni.del(`${API}/runs/${r.id}`).then(() => { toast('Removed from the list.'); load(); }).catch((e) => toast(errOf(e, 'Could not remove it.')))}>Remove</TinyBtn> : null}</td>
          </tr>
        ))}
      </tbody></table>
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------------------------- the business
function BusinessTab({ onOpen }) {
  const { toast } = useOmni();
  const [list, setList] = useState([]); const [key, setKey] = useState('own'); const [b, setB] = useState(null); const [form, setForm] = useState({}); const [err, setErr] = useState('');
  const listRef = useRef([]);
  useEffect(() => { omni.get(`${API}/businesses`).then((r) => { listRef.current = r.businesses || []; setList(listRef.current); }).catch(() => setList([])); }, []);
  // the list arriving must not reload (and empty) what the person is typing: only picking another business reloads
  const load = useCallback(() => omni.get(`${API}/business`, { business: key, name: (listRef.current.find((x) => x.key === key) || {}).name || '' }).then((r) => { setB(r); setForm({}); setErr(''); }).catch((e) => setErr(errOf(e, 'The business could not be read.'))), [key]);
  useEffect(() => { load(); }, [load]);
  if (err && !b) return <Banner tone="error">{err}</Banner>;
  if (!b) return <div className="card panel">Loading…</div>;
  const val = (f) => (form[f.key] !== undefined ? form[f.key] : (Array.isArray(b.context[f.key]) ? b.context[f.key].join('\n') : (b.context[f.key] || '')));
  const save = () => omni.put(`${API}/business`, { business: key, fields: form }).then((r) => { toast(r.ok); setB(r.business); setForm({}); }).catch((e) => toast(errOf(e, 'It could not be saved.')));
  return (
    <div>
      <Panel title="What the agent knows" sub="Saved once, used by every goal for this business. A fact says where it came from; what you type wins.">
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end', marginBottom: 10 }}>
          <Field label="BUSINESS"><select value={key} onChange={(e) => setKey(e.target.value)}>{list.map((x) => <option key={x.key} value={x.key}>{x.own ? `${x.name} (our own company)` : x.name}</option>)}</select></Field>
        </div>
        {b.info && (b.info.plan || b.info.siteCheck || b.info.gbp) ? <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>Already on file: {[b.info.plan && `${b.info.plan.label} plan (${b.info.plan.status})`, b.info.siteCheck && `website check ${b.info.siteCheck.score}/100`, b.info.gbp && `Google profile audit ${b.info.gbp.score}/100`].filter(Boolean).join(' · ')}.</p> : null}
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 12 }}>
          {b.fields.map((f) => (
            <Field key={f.key} label={f.label.toUpperCase()} hint={b.sources[f.key] ? `From ${b.sources[f.key]}` : f.hint}>
              {f.kind === 'list' || f.key === 'about' || f.key === 'notes' ? <textarea style={{ minHeight: 64 }} value={val(f)} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} /> : <input value={val(f)} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} disabled={!b.canEdit} />}
            </Field>
          ))}
        </div>
        <Btn primary disabled={!b.canEdit || !Object.keys(form).length} onClick={save}>Save what I changed</Btn>
        {b.context.skips && b.context.skips.length ? <p style={{ fontSize: 12, color: 'var(--muted)', margin: '10px 0 0' }}>You chose to skip: {b.context.skips.join(', ')}. Type them above and save if you want the agent to use them.</p> : null}
      </Panel>
      <Panel title="Previous goals for this business">
        {b.history.length ? <table className="mk-table"><tbody>{b.history.map((h) => <tr key={h.id}><td style={{ fontSize: 12 }}>{fmtDateTime(h.at)}</td><td style={{ fontSize: 13 }}>{h.goal}</td><td><Pill tone={RUN_TONE[h.status] || 'draft'} dot>{h.statusWords}</Pill></td><td><TinyBtn onClick={() => onOpen(h.id)}>Open</TinyBtn></td></tr>)}</tbody></table> : <div style={{ fontSize: 13, color: 'var(--muted)' }}>No goals yet.</div>}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------- the dashboard
function DashboardTab({ onOpen }) {
  const { go } = useOmni();
  const [d, setD] = useState(null); const [err, setErr] = useState('');
  useEffect(() => { omni.get(`${API}/dashboard`).then(setD).catch((e) => setErr(errOf(e, 'The dashboard could not be read.'))); }, []);
  if (err) return <Banner tone="error">{err}</Banner>;
  if (!d) return <div className="card panel">Loading…</div>;
  const c = d.counts; const pa = d.pendingApprovals;
  return (
    <div>
      <Kpis>
        <Kpi label="Runs working" icon="⟳" value={fmtNum(c.activeRuns)} meta={`${fmtNum(c.tasksRunning + c.tasksQueued)} steps running or queued`} />
        <Kpi label="Need you" icon="✋" value={fmtNum(c.needYou)} meta={`${fmtNum(c.tasksWaiting)} steps wait for a person`} tone={c.needYou ? 'warn' : ''} />
        <Kpi label="Plans waiting for approval" icon="✔" value={fmtNum(c.awaitingPlan)} meta={`${fmtNum(c.needAnswers)} waiting for answers`} />
        <Kpi label="Failed steps" icon="⚠" value={fmtNum(c.tasksFailed)} tone={c.tasksFailed ? 'down' : ''} meta="Open the goal and press Retry" />
        <Kpi label="Done this month" icon="✓" value={fmtNum(c.doneMonth)} meta={`${fmtNum(c.doneToday)} today`} />
      </Kpis>
      <Panel title="Estimated usage and cost this month" sub={d.usage.note}>
        {d.usage.month.length ? <table className="mk-table"><tbody>{d.usage.month.map((u) => <tr key={u.tool}><td><b>{u.label}</b></td><td style={{ fontSize: 12.5 }}>{plural(u.count, u.unit)}</td><td><Pill tone={u.kind === 'paid' ? 'red' : u.kind === 'free-tier' ? 'warn' : 'live'}>{u.kind === 'paid' ? 'Paid' : u.kind === 'free-tier' ? 'Free tier' : 'Free'}</Pill></td><td style={{ fontSize: 12.5 }}>{rs(u.total)}</td><td style={{ fontSize: 11.5, color: 'var(--muted)' }}>{u.note}</td></tr>)}</tbody></table> : <div style={{ fontSize: 13, color: 'var(--muted)' }}>No steps have run this month.</div>}
        <p style={{ fontSize: 13, margin: '8px 0 0' }}><b>Estimated total: {rs(d.usage.totalRupees)}</b> · AI model calls by the agent: {fmtNum(d.usage.aiModelCalls)} (the planner uses none).</p>
      </Panel>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))', gap: 12 }}>
        <Panel title="Active goals">{d.active.length ? d.active.map((r) => <div key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 0', borderTop: '1px solid #eef1f5' }}><Pill tone={RUN_TONE[r.status] || 'draft'} dot>{r.statusWords}</Pill><span style={{ flex: 1, fontSize: 13 }}>{r.title}</span><TinyBtn onClick={() => onOpen(r.id)}>Open</TinyBtn></div>) : <div style={{ fontSize: 13, color: 'var(--muted)' }}>Nothing is active.</div>}</Panel>
        <Panel title="Waiting for approval" sub="Plans you have not approved, and drafts and pictures the agent asked the team to approve.">
          {pa.plans.map((r) => <div key={r.id} style={{ fontSize: 13, padding: '4px 0' }}>Plan: {r.title} <TinyBtn onClick={() => onOpen(r.id)}>Open</TinyBtn></div>)}
          {pa.outward.map((t) => <div key={t.taskId} style={{ fontSize: 13, padding: '4px 0' }}>Step that reaches outside TeamLink: {t.title} <TinyBtn onClick={() => onOpen(t.runId)}>Open</TinyBtn></div>)}
          {pa.items.map((x) => <div key={x.id} style={{ fontSize: 13, padding: '4px 0' }}>{x.kind === 'content' ? 'Draft' : 'Picture'}: {x.label} <TinyBtn onClick={() => go(x.page || 'mkapprove')}>Open approvals</TinyBtn></div>)}
          {!pa.plans.length && !pa.items.length && !pa.outward.length ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>Nothing is waiting.</div> : null}
        </Panel>
        <Panel title="Failed steps">{d.failures.length ? d.failures.map((f) => <div key={f.taskId} style={{ fontSize: 13, padding: '5px 0', borderTop: '1px solid #eef1f5' }}><b>{f.title}</b><div style={{ fontSize: 12, color: '#9b1c1c' }}>{f.error}</div><TinyBtn onClick={() => onOpen(f.runId)}>Open the goal</TinyBtn></div>) : <div style={{ fontSize: 13, color: 'var(--muted)' }}>No failed steps.</div>}</Panel>
        <Panel title="Recent activity">{d.recent.length ? d.recent.map((e, i) => <div key={i} style={{ fontSize: 12.5, padding: '4px 0', borderTop: '1px solid #eef1f5' }}><span style={{ color: 'var(--muted)' }}>{fmtDateTime(e.at)}</span> {e.text}</div>) : <div style={{ fontSize: 13, color: 'var(--muted)' }}>Nothing yet.</div>}</Panel>
      </div>
      <Panel title="Campaign performance" sub="What really happened per goal. Reach and engagement are not connected yet; enquiries are typed in by a person.">
        {d.performance.length ? d.performance.map((p) => <div key={p.runId} style={{ padding: '6px 0', borderTop: '1px solid #eef1f5' }}><b style={{ fontSize: 13 }}>{p.goal}</b> <Tag>{p.businessName}</Tag><ul style={{ margin: '3px 0', paddingLeft: 18, fontSize: 12.5 }}>{p.lines.map((l) => <li key={l}>{l}</li>)}</ul><TinyBtn onClick={() => onOpen(p.runId)}>Open</TinyBtn></div>) : <div style={{ fontSize: 13, color: 'var(--muted)' }}>No goal has run yet.</div>}
      </Panel>
    </div>
  );
}
