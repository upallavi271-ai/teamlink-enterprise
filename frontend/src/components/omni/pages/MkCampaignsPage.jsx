import { useCallback, useEffect, useRef, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Panel, Banner, Field, Empty, GsModal, Pill, Tag, ConfirmModal, fmtDateTime } from '../ui.jsx';
import { AiBanner, aiReady, aiLabel } from '../marketing/mk.jsx';
import '../marketing/marketing.css';

// AI MARKETING > CAMPAIGN MESSAGES (WhatsApp and SMS). The AI writes the words of a job campaign; a person picks and edits them; "Make the templates" saves them in Omni-Channel > Templates (WhatsApp waits for
// Meta, SMS needs the DLT number and sender ID); "Make the campaign" saves a campaign that was NEVER SENT. Nothing is sent from this page: the campaign is sent from Campaigns, where who agreed, the STOP
// list, quiet hours, credits, Test mode and approval all apply. Server: marketing/messaging.js. RCS is not part of this page (it sends from Administration > Integrations > RCS).
const WAY = { whatsapp: 'WhatsApp', sms: 'SMS' };
const NEXT_TONE = { write: 'warn', templates: 'warn', meta: 'warn', dlt: 'warn', campaign: 'warn', send: 'live', approval: 'warn', done: 'live' };

// the checks under one text: every one, ok or not
const Checks = ({ c }) => (c ? <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'flex', gap: '2px 12px', flexWrap: 'wrap', fontSize: 10.5 }}>{c.items.map((x) => <li key={x.id} style={{ color: x.ok ? '#166534' : '#b91c1c' }}>{x.ok ? '✓' : '✗'} {x.label}</li>)}</ul> : null);

// ---- the editor: job, ways, tone -> the AI writes -> pick and edit -> save --------------------------------------------------------------------------------------------------------
function Editor({ opts, set, onClose, onSaved, toast }) {
  const [f, setF] = useState(() => (set ? { jobId: set.jobId, channels: set.channels, tone: set.tone || opts.brand.tone, language: set.language || opts.brand.language, note: set.note || '', title: set.title } : { jobId: '', channels: ['whatsapp', 'sms'], tone: opts.brand.tone || opts.tones[0], language: opts.brand.language || 'English', note: '', title: '' }));
  const [texts, setTexts] = useState(set ? set.texts : {});
  const [vars, setVars] = useState(set ? (set.variants || []) : []);
  const [checks, setChecks] = useState({});
  const [jobs, setJobs] = useState(opts.jobs);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [ai, setAi] = useState(set ? set.ai : null);
  const timer = useRef(null);
  const job = jobs.find((j) => j.id === f.jobId) || (set && set.jobId === f.jobId ? { id: set.jobId, title: set.jobTitle } : null);
  useEffect(() => { if (!q) { setJobs(opts.jobs); return undefined; } const t = setTimeout(() => omni.get('/gs/marketing/campaigns/options', { q }).then((d) => setJobs(d.jobs || [])).catch(() => {}), 300); return () => clearTimeout(t); }, [q, opts.jobs]);
  // the checks of the texts as they are edited
  useEffect(() => {
    if (!f.jobId || !Object.values(texts).some(Boolean)) { setChecks({}); return undefined; }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => omni.post('/gs/marketing/campaigns/check', { jobId: f.jobId, texts }).then((d) => setChecks(d.checks || {})).catch(() => {}), 350);
    return () => clearTimeout(timer.current);
  }, [texts, f.jobId]);
  const toggle = (k) => setF((x) => ({ ...x, channels: x.channels.includes(k) ? x.channels.filter((c) => c !== k) : [...x.channels, k] }));
  const write = async () => {
    setBusy('write'); setErr('');
    try { const r = await omni.post('/gs/marketing/campaigns/write', { jobId: f.jobId, channels: f.channels, tone: f.tone, language: f.language, note: f.note, ...(set ? { id: set.id } : {}) }); setVars(r.variants); setAi(r.ai); if (!f.title) setF((x) => ({ ...x, title: `${r.job.title} · campaign messages` })); } catch (e) { setErr(errOf(e, 'The AI could not write them.')); } finally { setBusy(''); }
  };
  const use = (v, k) => setTexts((t) => ({ ...t, [k]: v.texts[k] }));
  const save = async () => {
    setBusy('save'); setErr('');
    try {
      const body = { title: f.title, jobId: f.jobId, channels: f.channels, texts, variants: vars, note: f.note, tone: f.tone, language: f.language, ai };
      const r = set ? await omni.put(`/gs/marketing/campaigns/${set.id}`, body) : await omni.post('/gs/marketing/campaigns', body);
      toast(r.ok || 'Saved'); onSaved(r.set);
    } catch (e) { setErr(errOf(e, 'It could not be saved.')); } finally { setBusy(''); }
  };
  const ready = f.jobId && f.channels.length && f.channels.every((k) => (texts[k] || '').trim());
  const badChecks = Object.values(checks).some((c) => c && !c.ok && c.items.some((x) => !x.ok && ['link', 'stop', 'words', 'size'].includes(x.id)));
  return (
    <GsModal title={set ? 'Change the campaign messages' : 'New campaign messages'} sub="Pick the open job, let the AI write, choose and edit. Nothing is sent." width={820} onClose={onClose}
      foot={<><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={!ready || badChecks || busy === 'save'} onClick={save} title={!ready ? 'Pick a job and give every way its words first' : badChecks ? 'Fix the red checks first' : ''}>{busy === 'save' ? 'Saving…' : 'Save these messages'}</Btn></>}>
      {err ? <Banner tone="error">{err}</Banner> : null}
      <div className="form-grid">
        <Field label="OPEN JOB TO PROMOTE" full hint={opts.canCampaign ? 'A campaign promotes one open job. Only jobs in your own area are listed.' : 'Only the BDE team, Team Leads and Admins can pick a job.'}>
          <input value={q} placeholder="Search by title, code, place or department" onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 6 }} />
          <select value={f.jobId} onChange={(e) => setF({ ...f, jobId: e.target.value })} disabled={!!set && set.campaign}>
            <option value="">{jobs.length ? 'Pick the job…' : 'No open job found'}</option>
            {set && set.jobId && !jobs.some((j) => j.id === set.jobId) ? <option value={set.jobId}>{set.jobTitle}</option> : null}
            {jobs.map((j) => <option key={j.id} value={j.id}>{j.title}{j.reqCode ? ` (${j.reqCode})` : ''}{j.location ? ` · ${j.location}` : ''}</option>)}
          </select>
        </Field>
        <Field label="WAYS" full>
          {opts.ways.map((w) => <label key={w.key} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, margin: '2px 0' }}><input type="checkbox" checked={f.channels.includes(w.key)} onChange={() => toggle(w.key)} />{w.label} <small style={{ color: 'var(--muted)' }}>{w.hint}</small></label>)}
        </Field>
        <Field label="TONE"><select value={f.tone} onChange={(e) => setF({ ...f, tone: e.target.value })}>{opts.tones.map((t) => <option key={t}>{t}</option>)}</select></Field>
        <Field label="LANGUAGE"><select value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })}>{opts.languages.map((t) => <option key={t}>{t}</option>)}</select></Field>
        <Field label="WHAT DO YOU WANT TO SAY? (OPTIONAL)" full hint="Facts only: the AI never invents a salary, benefit or date. For example: Freshers can apply. Walk-in on Saturday.">
          <textarea rows={2} maxLength={600} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} style={{ width: '100%' }} />
        </Field>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '4px 0 10px' }}>
        <Btn primary disabled={!f.jobId || !f.channels.length || busy === 'write' || !aiReady(opts.ai)} onClick={write}>{busy === 'write' ? 'Writing…' : vars.length ? '✦ Write again' : '✦ Write with AI'}</Btn>
        {ai ? <small style={{ color: 'var(--muted)' }}>Written by {aiLabel(ai)}</small> : null}
        {!aiReady(opts.ai) ? <small style={{ color: '#b91c1c' }}>The AI is not ready: you can still write the words yourself below.</small> : null}
      </div>
      <AiBanner ai={opts.ai} />
      {vars.length ? (
        <div style={{ display: 'grid', gap: 10, margin: '8px 0 14px' }}>
          {vars.map((v, i) => (
            <div key={`${v.angle}${i}`} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 10 }}>
              <b style={{ fontSize: 12 }}>{v.angle}</b>
              {f.channels.filter((k) => v.texts && v.texts[k]).map((k) => (
                <div key={k} style={{ marginTop: 8 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Tag green={k === 'whatsapp'}>{WAY[k]}</Tag><TinyBtn onClick={() => use(v, k)}>{texts[k] === v.texts[k] ? '✓ Chosen' : 'Use this one'}</TinyBtn></div>
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, lineHeight: 1.5, background: '#f6f8f7', borderRadius: 8, padding: '8px 10px', marginTop: 4 }}>{v.texts[k]}</div>
                  <Checks c={v.checks && v.checks[k]} />
                  {v.notes && v.notes[k] && v.notes[k].length ? <small style={{ color: 'var(--muted)', fontSize: 10 }}>{v.notes[k].join(' ')}</small> : null}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}
      <div className="form-grid">
        {f.channels.map((k) => (
          <Field key={k} label={`${WAY[k].toUpperCase()} MESSAGE (EDIT IF YOU LIKE)`} full hint="Words TeamLink fills in: {{name}} {{job_title}} {{company}} {{apply_link}}. The apply link and “Reply STOP to opt out” are needed.">
            <textarea rows={k === 'sms' ? 4 : 6} maxLength={2000} value={texts[k] || ''} onChange={(e) => setTexts({ ...texts, [k]: e.target.value })} style={{ width: '100%' }} placeholder={`Pick a version above, or write the ${WAY[k]} message here`} />
            <Checks c={checks[k]} />
          </Field>
        ))}
        <Field label="NAME IN YOUR LIST" full><input value={f.title} maxLength={80} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder={job ? `${job.title} · campaign messages` : 'For example: ICU Nurse · hiring drive'} /></Field>
      </div>
    </GsModal>
  );
}

// ---- make the campaign: who gets it ----------------------------------------------------------------------------------------------------------------------------------------
function CampaignModal({ set, opts, onClose, onDone, toast }) {
  const [sel, setSel] = useState([]);
  const [name, setName] = useState(set.title);
  const [ask, setAsk] = useState(!!(opts.approval && (opts.approval.forced || opts.approval.required)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try { const r = await omni.post(`/gs/marketing/campaigns/${set.id}/campaign`, { name, segmentIds: sel, ask }); toast(r.ok); onDone(); } catch (e) { setErr(errOf(e, 'The campaign could not be made.')); } finally { setBusy(false); }
  };
  return (
    <GsModal title="Make the campaign" sub="It is saved and NOT sent. You press Send in Campaigns, after checking it." width={560} onClose={onClose}
      foot={<><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={busy || !sel.length || name.trim().length < 2} onClick={go}>{busy ? 'Saving…' : 'Save the campaign'}</Btn></>}>
      {err ? <Banner tone="error">{err}</Banner> : null}
      <Field label="CAMPAIGN NAME" full><input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="WHO GETS IT (GROUPS OF PEOPLE)" full hint="Only people who agreed (opted in) on that way get a message, and people who said STOP are always left out. You see the exact count in Campaigns before you send.">
        {opts.segments.length === 0 ? <small style={{ color: 'var(--muted)' }}>No group of people yet. Make one in Contacts &amp; Audiences.</small> : opts.segments.map((s) => <label key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, margin: '3px 0' }}><input type="checkbox" checked={sel.includes(s.id)} onChange={() => setSel((x) => (x.includes(s.id) ? x.filter((i) => i !== s.id) : [...x, s.id]))} />{s.name} <small style={{ color: 'var(--muted)' }}>{s.total} people · {s.reachable} reachable</small></label>)}
      </Field>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, marginTop: 8 }}><input type="checkbox" checked={ask} onChange={(e) => setAsk(e.target.checked)} />Also ask a Team Lead to approve it now</label>
    </GsModal>
  );
}

// ---- one saved set: what is done and the next step ------------------------------------------------------------------------------------------------------------------------
function SetCard({ s, opts, busy, act, onEdit, onRemove, onCampaign, go, reload, toast }) {
  const wa = s.templates.whatsapp; const sm = s.templates.sms;
  const [ids, setIds] = useState({ dlt: (sm && sm.dltTemplateId) || '', sender: (sm && sm.senderId) || '' });
  const [meta, setMeta] = useState('');
  const submitMeta = async () => {
    setMeta('Sending to Meta…');
    try { const r = await omni.post(`/gs/templates/outreach/${wa.id}/submit`, {}); toast(r.ok || 'Sent to Meta'); setMeta(r.ok || 'Sent to Meta. It usually takes a few minutes to a day.'); reload(); } catch (e) { setMeta(errOf(e, 'It could not be sent to Meta.')); }
  };
  const syncMeta = async () => {
    setMeta('Asking Meta…');
    try { const r = await omni.post(`/gs/templates/outreach/${wa.id}/sync`, {}); setMeta(r.ok || r.message || 'Checked.'); reload(); } catch (e) { setMeta(errOf(e, 'Meta could not be asked just now.')); }
  };
  const n = s.next; const c = s.campaign;
  return (
    <div className="mk-row" style={{ alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <b>{s.title}</b> {s.channels.map((k) => <Tag key={k} green={k === 'whatsapp'}>{WAY[k]}</Tag>)}
        <small>For the job “{s.jobTitle}” · {s.createdByName} · {fmtDateTime(s.updatedAt)}{s.ai ? ` · written by ${s.ai.demo ? 'the sample writer' : (s.ai.provider || 'AI')}` : ''}</small>
        <div style={{ margin: '6px 0' }}><Pill tone={NEXT_TONE[n.id] || 'draft'} dot>{n.words}</Pill></div>
        {s.channels.map((k) => (s.texts[k] ? <details key={k} style={{ margin: '3px 0' }}><summary style={{ fontSize: 11.5, cursor: 'pointer' }}>{WAY[k]} words{s.templates[k] ? ` · ${s.templates[k].gone ? 'template removed' : s.templates[k].ready ? 'template ready' : 'template not ready yet'}` : ''}</summary><div style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: '#f6f8f7', borderRadius: 8, padding: '7px 9px', marginTop: 4 }}>{s.texts[k]}</div></details> : null))}
        {n.id === 'meta' ? <div style={{ fontSize: 11.5, margin: '6px 0' }}>{meta || (wa && wa.waApprovalStatus === 'rejected' ? 'Meta rejected it. Change the words, press “Make the templates” to update, and send it again.' : '')}</div> : null}
        {n.id === 'dlt' ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 6 }}>
            <Field label="DLT TEMPLATE NUMBER"><input value={ids.dlt} maxLength={25} inputMode="numeric" onChange={(e) => setIds({ ...ids, dlt: e.target.value })} placeholder="10 to 25 digits" /></Field>
            <Field label="SENDER ID"><input value={ids.sender} maxLength={11} onChange={(e) => setIds({ ...ids, sender: e.target.value })} placeholder="For example GRNSRT" /></Field>
            <Btn small primary disabled={busy === 'sms-ids'} onClick={() => act(s.id, 'sms-ids', { dltTemplateId: ids.dlt, senderId: ids.sender })}>Save</Btn>
          </div>
        ) : null}
        {c && !c.gone ? <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>Campaign: {c.words}{c.sent || c.rehearsed ? ` · ${c.sent} sent${c.rehearsed ? ` (${c.rehearsed} rehearsed)` : ''} · ${c.delivered} delivered · ${c.read} read · ${c.replied} replied${c.failed ? ` · ${c.failed} failed` : ''}` : ''}</div> : null}
      </div>
      <div className="mk-acts" style={{ flexDirection: 'column', alignItems: 'stretch', minWidth: 170 }}>
        {n.id === 'templates' ? <Btn small primary disabled={busy === 'templates'} onClick={() => act(s.id, 'templates')}>{busy === 'templates' ? 'Making…' : 'Make the templates'}</Btn> : null}
        {n.id === 'meta' && wa ? <><Btn small primary disabled={wa.waApprovalStatus === 'pending'} onClick={submitMeta}>{wa.waApprovalStatus === 'rejected' ? 'Send to Meta again' : 'Send to Meta for approval'}</Btn><Btn small onClick={syncMeta}>Check Meta’s answer</Btn></> : null}
        {n.id === 'campaign' ? <Btn small primary onClick={() => onCampaign(s)}>Make the campaign</Btn> : null}
        {['send', 'approval', 'done'].includes(n.id) && c && !c.gone ? <Btn small primary={n.id === 'send'} onClick={() => go('campaigns')}>Open Campaigns</Btn> : null}
        {s.templates.whatsapp || s.templates.sms ? <TinyBtn onClick={() => go('templates')}>Open Templates</TinyBtn> : null}
        <TinyBtn onClick={() => onEdit(s)}>Change the words</TinyBtn>
        <TinyBtn onClick={() => onRemove(s)}>Remove</TinyBtn>
      </div>
    </div>
  );
}

export default function MkCampaignsPage() {
  const { toast, go } = useOmni();
  const [opts, setOpts] = useState(null);
  const [sets, setSets] = useState(null);
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState(null); // { set } (set null = a new one)
  const [camp, setCamp] = useState(null);
  const [del, setDel] = useState(null);
  const [busy, setBusy] = useState('');
  const loadSets = useCallback(() => omni.get('/gs/marketing/campaigns').then((d) => { setSets(d.sets || []); setErr(''); }).catch((e) => setErr(errOf(e, 'Your campaign messages could not be read.'))), []);
  useEffect(() => { omni.get('/gs/marketing/campaigns/options').then(setOpts).catch((e) => setErr(errOf(e, 'Campaign messages could not be opened.'))); loadSets(); }, [loadSets]);
  if (err && (!opts || !sets)) return <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={() => window.location.reload()}>Try again</button></Banner>;
  if (!opts || !sets) return <div className="card panel">Loading…</div>;
  const act = async (id, what, body) => {
    setBusy(what); setErr('');
    try { const r = await omni.post(`/gs/marketing/campaigns/${id}/${what}`, body || {}); toast(r.ok || 'Done'); await loadSets(); } catch (e) { const m = errOf(e, 'That did not work.'); setErr(m); toast(m); } finally { setBusy(''); }
  };
  const remove = async () => { const s = del; setDel(null); try { const r = await omni.del(`/gs/marketing/campaigns/${s.id}`); toast(r.ok); await loadSets(); } catch (e) { setErr(errOf(e, 'It could not be removed.')); } };
  const openEdit = async (s) => { try { const r = await omni.get(`/gs/marketing/campaigns/${s.id}`); setEdit({ set: r.set }); } catch (e) { setErr(errOf(e, 'It could not be opened.')); } };
  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="Campaign messages" lead="The AI writes the WhatsApp and SMS words for one open job in your brand voice. You pick and edit them, make the templates, and save the campaign. Nothing is sent from here: you press Send in Campaigns.">
        <Btn primary onClick={() => setEdit({ set: null })} disabled={!opts.canCampaign} title={opts.canCampaign ? '' : 'Only the BDE team, Team Leads and Admins can make job campaigns'}>✦ New campaign messages</Btn>
      </PageHead>
      {err ? <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={() => setErr('')}>Close</button></Banner> : null}
      {!opts.canCampaign ? <Banner tone="warn">Your login can look at this page, but only the BDE team, Team Leads and Admins can make job campaigns.</Banner> : null}
      {opts.testMode ? <Banner tone="test"><b>Test mode is ON.</b> Campaigns made here run as a rehearsal: every message is logged and counted, and nothing is handed to WhatsApp or the SMS provider until an Admin switches Test mode off.</Banner> : null}
      <Panel title="Is it ready to go out?" sub="What is connected, and how many messages are approved and ready. Set up in Administration > Integrations and Omni-Channel > Templates.">
        <div className="mk-prov">
          {opts.ways.map((w) => (
            <div key={w.key}><b>{w.label} {w.connected ? <Pill tone="live" dot>Connected</Pill> : <Pill tone="warn" dot>Not connected</Pill>} {w.ready ? <Pill tone="live" dot>Message ready</Pill> : <Pill tone="draft">No message ready yet</Pill>}</b><span>{w.note || w.hint}</span></div>
          ))}
          <div><b>RCS <Pill tone="draft">Later</Pill></b><span>RCS sends from Administration &gt; Integrations &gt; RCS with templates approved at rcssms.in. It is not in the campaign sender yet, so it is not part of this page.</span></div>
        </div>
      </Panel>
      <Panel title="Your campaign messages" sub="Each one is for one open job. Follow the next step shown on it." style={{ marginTop: 14 }} right={<span className="pill live">{sets.length}</span>}>
        {sets.length === 0 ? <Empty title="No campaign messages yet" action={opts.canCampaign ? <Btn primary onClick={() => setEdit({ set: null })}>✦ New campaign messages</Btn> : null}>Pick an open job and the AI writes the WhatsApp and SMS words for it. You choose, edit and save.</Empty> : sets.map((s) => <SetCard key={s.id} s={s} opts={opts} busy={busy} act={act} onEdit={openEdit} onRemove={setDel} onCampaign={setCamp} go={go} reload={loadSets} toast={toast} />)}
      </Panel>
      {edit ? <Editor opts={opts} set={edit.set} toast={toast} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); loadSets(); }} /> : null}
      {camp ? <CampaignModal set={camp} opts={opts} toast={toast} onClose={() => setCamp(null)} onDone={() => { setCamp(null); loadSets(); }} /> : null}
      {del ? <ConfirmModal title={`Remove “${del.title}”?`} text="The templates made from it stay in Templates." yes="Remove" danger onNo={() => setDel(null)} onYes={remove} /> : null}
    </div>
  );
}
