import { useCallback, useEffect, useRef, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Panel, Banner, Field, Empty, GsModal, Pill, Tag, ConfirmModal, fmtDateTime } from '../ui.jsx';
import { AiBanner, aiReady, aiLabel } from '../marketing/mk.jsx';
import '../marketing/marketing.css';

// AI MARKETING > EMAIL MARKETING. The AI writes 5 subject lines and 2 emails for one open job; a person picks, edits and may set up an A/B SUBJECT TEST (half get A, half get B); "Make the template" and
// "Make the campaign" hand it to Omni-Channel (the campaign is saved NOT SENT, by default asking a Team Lead to approve it). Nothing is sent from this page: the campaign is sent from Campaigns, where who agreed,
// the unsubscribe list, quiet hours, the daily limit, credits, Test mode and approval all apply. The report counts sends, clicks on the apply link and replies. Opens are NOT counted (plain-text emails).
// Server: marketing/emailmk.js.
const NEXT_TONE = { write: 'warn', template: 'warn', fix: 'red', campaign: 'warn', send: 'live', approval: 'warn', done: 'live' };
const Checks = ({ c }) => (c ? <ul style={{ listStyle: 'none', margin: '5px 0 0', padding: 0, display: 'flex', gap: '2px 12px', flexWrap: 'wrap', fontSize: 10.5 }}>{c.items.map((x) => <li key={x.id} style={{ color: x.ok ? '#166534' : (x.hard ? '#b91c1c' : '#92400e') }}>{x.ok ? '✓' : (x.hard ? '✗' : '!')} {x.label}</li>)}</ul> : null);

function Editor({ opts, set, onClose, onSaved, toast }) {
  const [f, setF] = useState(() => (set ? { jobId: set.jobId, tone: set.tone || opts.brand.tone, language: set.language || opts.brand.language, note: set.note || '', title: set.title } : { jobId: '', tone: opts.brand.tone || opts.tones[0], language: opts.brand.language || 'English', note: '', title: '' }));
  const [subjectA, setA] = useState(set ? set.subjectA : '');
  const [subjectB, setB] = useState(set ? set.subjectB : '');
  const [ab, setAb] = useState(!!(set && set.subjectB));
  const [body, setBody] = useState(set ? set.body : '');
  const [drafts, setDrafts] = useState(set && set.variants && set.variants.subjects ? set.variants : null);
  const [checks, setChecks] = useState({});
  const [jobs, setJobs] = useState(opts.jobs);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [ai, setAi] = useState(set ? set.ai : null);
  const timer = useRef(null);
  useEffect(() => { if (!q) { setJobs(opts.jobs); return undefined; } const t = setTimeout(() => omni.get('/gs/marketing/email/options', { q }).then((d) => setJobs(d.jobs || [])).catch(() => {}), 300); return () => clearTimeout(t); }, [q, opts.jobs]);
  useEffect(() => {
    if (!f.jobId || !(subjectA || subjectB || body)) { setChecks({}); return undefined; }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => omni.post('/gs/marketing/email/check', { jobId: f.jobId, subjectA, subjectB: ab ? subjectB : '', body }).then((d) => setChecks(d.checks || {})).catch(() => {}), 350);
    return () => clearTimeout(timer.current);
  }, [subjectA, subjectB, body, ab, f.jobId]);
  const write = async () => {
    setBusy('write'); setErr('');
    try { const r = await omni.post('/gs/marketing/email/write', { jobId: f.jobId, tone: f.tone, language: f.language, note: f.note, ...(set ? { id: set.id } : {}) }); setDrafts({ subjects: r.subjects, bodies: r.bodies }); setAi(r.ai); if (!f.title) setF((x) => ({ ...x, title: `${r.job.title} · email` })); } catch (e) { setErr(errOf(e, 'The AI could not write it.')); } finally { setBusy(''); }
  };
  const save = async () => {
    setBusy('save'); setErr('');
    try {
      const payload = { title: f.title, jobId: f.jobId, subjectA, subjectB: ab ? subjectB : '', body, note: f.note, tone: f.tone, language: f.language, variants: drafts ? { subjects: drafts.subjects.map(({ angle, text }) => ({ angle, text })), bodies: drafts.bodies.map(({ angle, text }) => ({ angle, text })) } : undefined, ai };
      const r = set ? await omni.put(`/gs/marketing/email/${set.id}`, payload) : await omni.post('/gs/marketing/email', payload);
      toast(r.ok || 'Saved'); onSaved(r.set);
    } catch (e) { setErr(errOf(e, 'It could not be saved.')); } finally { setBusy(''); }
  };
  const hardBad = ['subjectA', ...(ab ? ['subjectB'] : []), 'body'].some((k) => checks[k] && checks[k].blocked);
  const ready = f.jobId && subjectA.trim() && body.trim() && (!ab || subjectB.trim());
  return (
    <GsModal title={set ? 'Change the email' : 'New email'} sub="Pick the open job, let the AI write, choose and edit. Nothing is sent." width={840} onClose={onClose}
      foot={<><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={!ready || hardBad || busy === 'save'} onClick={save} title={!ready ? 'Pick a job, then give it a subject and the email words' : hardBad ? 'Fix the red checks first' : ''}>{busy === 'save' ? 'Saving…' : 'Save this email'}</Btn></>}>
      {err ? <Banner tone="error">{err}</Banner> : null}
      <div className="form-grid">
        <Field label="OPEN JOB TO PROMOTE" full hint={opts.canCampaign ? 'A campaign promotes one open job. Only jobs in your own area are listed.' : 'Only the BDE team, Team Leads and Admins can pick a job.'}>
          <input value={q} placeholder="Search by title, code, place or department" onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 6 }} />
          <select value={f.jobId} onChange={(e) => setF({ ...f, jobId: e.target.value })}>
            <option value="">{jobs.length ? 'Pick the job…' : 'No open job found'}</option>
            {set && set.jobId && !jobs.some((j) => j.id === set.jobId) ? <option value={set.jobId}>{set.jobTitle}</option> : null}
            {jobs.map((j) => <option key={j.id} value={j.id}>{j.title}{j.reqCode ? ` (${j.reqCode})` : ''}{j.location ? ` · ${j.location}` : ''}</option>)}
          </select>
        </Field>
        <Field label="TONE"><select value={f.tone} onChange={(e) => setF({ ...f, tone: e.target.value })}>{opts.tones.map((t) => <option key={t}>{t}</option>)}</select></Field>
        <Field label="LANGUAGE"><select value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })}>{opts.languages.map((t) => <option key={t}>{t}</option>)}</select></Field>
        <Field label="WHAT DO YOU WANT TO SAY? (OPTIONAL)" full hint="Facts only: the AI never invents a salary, benefit or date. For example: Freshers can apply. Walk-in on Saturday.">
          <textarea rows={2} maxLength={600} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} style={{ width: '100%' }} />
        </Field>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '4px 0 10px' }}>
        <Btn primary disabled={!f.jobId || busy === 'write' || !aiReady(opts.ai)} onClick={write}>{busy === 'write' ? 'Writing…' : drafts ? '✦ Write again' : '✦ Write with AI'}</Btn>
        {ai ? <small style={{ color: 'var(--muted)' }}>Written by {aiLabel(ai)}</small> : null}
        {!aiReady(opts.ai) ? <small style={{ color: '#b91c1c' }}>The AI is not ready: you can still write it yourself below.</small> : null}
      </div>
      <AiBanner ai={opts.ai} />
      {drafts ? (
        <div style={{ display: 'grid', gap: 12, margin: '8px 0 14px' }}>
          <div>
            <b style={{ fontSize: 12 }}>Subject lines</b>
            {drafts.subjects.map((s, i) => (
              <div key={`${s.text}${i}`} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '7px 10px', margin: '6px 0' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><Tag>{s.angle}</Tag><span style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 180 }}>{s.text}</span><TinyBtn onClick={() => setA(s.text)}>{subjectA === s.text ? '✓ Subject A' : 'Use as A'}</TinyBtn><TinyBtn onClick={() => { setAb(true); setB(s.text); }}>{ab && subjectB === s.text ? '✓ Subject B' : 'Use as B (A/B test)'}</TinyBtn></div>
                {s.checks ? <Checks c={s.checks} /> : null}
              </div>
            ))}
          </div>
          <div>
            <b style={{ fontSize: 12 }}>Emails</b>
            {drafts.bodies.map((x, i) => (
              <div key={`${x.angle}${i}`} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 10, margin: '6px 0' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Tag green>{x.angle}</Tag><TinyBtn onClick={() => setBody(x.text)}>{body === x.text ? '✓ Chosen' : 'Use this one'}</TinyBtn></div>
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, lineHeight: 1.5, background: '#f6f8f7', borderRadius: 8, padding: '8px 10px', marginTop: 5 }}>{x.text}</div>
                {x.checks ? <Checks c={x.checks} /> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div className="form-grid">
        <Field label="SUBJECT A" full><input value={subjectA} maxLength={160} onChange={(e) => setA(e.target.value)} placeholder="Pick one above, or write the subject line here" /><Checks c={checks.subjectA} /></Field>
        <label style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}><input type="checkbox" checked={ab} onChange={(e) => setAb(e.target.checked)} />A/B subject test: half of the people get subject A, half get subject B, and the report shows which got more clicks</label>
        {ab ? <Field label="SUBJECT B" full><input value={subjectB} maxLength={160} onChange={(e) => setB(e.target.value)} placeholder="A different subject line" /><Checks c={checks.subjectB} /></Field> : null}
        <Field label="THE EMAIL (EDIT IF YOU LIKE)" full hint="Words TeamLink fills in: {{name}} {{job_title}} {{company}} {{apply_link}}. The apply link and the unsubscribe line {{unsubscribe}} are needed (the unsubscribe line becomes a link).">
          <textarea rows={11} maxLength={6000} value={body} onChange={(e) => setBody(e.target.value)} style={{ width: '100%' }} placeholder="Pick a version above, or write the email here" />
          <Checks c={checks.body} />
        </Field>
        <Field label="NAME IN YOUR LIST" full><input value={f.title} maxLength={80} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="For example: ICU Nurse · hiring email" /></Field>
      </div>
    </GsModal>
  );
}

function CampaignModal({ set, opts, onClose, onDone, toast }) {
  const [sel, setSel] = useState([]);
  const [name, setName] = useState(set.title);
  const [ask, setAsk] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try { const r = await omni.post(`/gs/marketing/email/${set.id}/campaign`, { name, segmentIds: sel, ask }); toast(r.ok); onDone(); } catch (e) { setErr(errOf(e, 'The campaign could not be made.')); } finally { setBusy(false); }
  };
  return (
    <GsModal title="Make the campaign" sub="It is saved and NOT sent. You press Send in Campaigns, after checking it." width={560} onClose={onClose}
      foot={<><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={busy || !sel.length || name.trim().length < 2} onClick={go}>{busy ? 'Saving…' : 'Save the campaign'}</Btn></>}>
      {err ? <Banner tone="error">{err}</Banner> : null}
      <Field label="CAMPAIGN NAME" full><input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="WHO GETS IT (GROUPS OF PEOPLE)" full hint="Only people who agreed (opted in) to email get it, and people who unsubscribed are always left out. You see the exact count in Campaigns before you send.">
        {opts.segments.length === 0 ? <small style={{ color: 'var(--muted)' }}>No group of people yet. Make one in Contacts &amp; Audiences.</small> : opts.segments.map((s) => <label key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, margin: '3px 0' }}><input type="checkbox" checked={sel.includes(s.id)} onChange={() => setSel((x) => (x.includes(s.id) ? x.filter((i) => i !== s.id) : [...x, s.id]))} />{s.name} <small style={{ color: 'var(--muted)' }}>{s.total} people · {s.reachable} reachable</small></label>)}
      </Field>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, marginTop: 8 }}><input type="checkbox" checked={ask} onChange={(e) => setAsk(e.target.checked)} />Ask a Team Lead to approve it before it can go out (recommended for a mass email)</label>
      {set.subjectB ? <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8, lineHeight: 1.5 }}>A/B test: half get “{set.subjectA}”, half get “{set.subjectB}”.</div> : null}
    </GsModal>
  );
}

function SetCard({ s, busy, act, onEdit, onRemove, onCampaign, go }) {
  const n = s.next; const c = s.campaign; const t = s.template;
  const ab = c && c.ab;
  return (
    <div className="mk-row" style={{ alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <b>{s.title}</b> {s.subjectB ? <Tag green>A/B subject test</Tag> : null}
        <small>For the job “{s.jobTitle}” · {s.createdByName} · {fmtDateTime(s.updatedAt)}{s.ai ? ` · written by ${s.ai.demo ? 'the sample writer' : (s.ai.provider || 'AI')}` : ''}</small>
        <div style={{ fontSize: 12.5, margin: '5px 0' }}><b>A:</b> {s.subjectA}{s.subjectB ? <><br /><b>B:</b> {s.subjectB}</> : null}</div>
        <div style={{ margin: '6px 0' }}><Pill tone={NEXT_TONE[n.id] || 'draft'} dot>{n.words}</Pill></div>
        <details><summary style={{ fontSize: 11.5, cursor: 'pointer' }}>The email{t ? (t.gone ? ' · template removed' : t.ready ? ' · template ready' : ' · template not ready') : ''}</summary><div style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: '#f6f8f7', borderRadius: 8, padding: '7px 9px', marginTop: 4 }}>{s.body}</div></details>
        {c && !c.gone ? (
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8, lineHeight: 1.6 }}>
            Campaign: {c.words}{c.sent || c.rehearsed ? ` · ${c.sent} sent${c.rehearsed ? ` (${c.rehearsed} rehearsed: nothing really sent)` : ''} · ${c.clicked} clicked the apply link · ${c.replied} replied${c.failed ? ` · ${c.failed} failed` : ''}` : ''}
            <div>Opens are not counted: these are plain-text emails with no tracking picture, and mail apps hide opens anyway.</div>
            {ab ? (
              <table className="mk-table" style={{ marginTop: 6 }}>
                <thead><tr><th>SUBJECT</th><th className="num">SENT</th><th className="num">CLICKED</th><th className="num">CLICK RATE</th></tr></thead>
                <tbody>{['A', 'B'].map((k) => <tr key={k}><td>{k}: {ab[k].subject}{ab.leader === k ? <> <Pill tone="live">Ahead</Pill></> : null}</td><td className="num">{ab[k].sent}</td><td className="num">{ab[k].clicked}</td><td className="num">{ab[k].rate == null ? '—' : `${ab[k].rate}%`}</td></tr>)}</tbody>
              </table>
            ) : null}
            {ab ? <div style={{ marginTop: 4 }}>{ab.why}</div> : null}
          </div>
        ) : null}
      </div>
      <div className="mk-acts" style={{ flexDirection: 'column', alignItems: 'stretch', minWidth: 170 }}>
        {n.id === 'template' ? <Btn small primary disabled={busy === 'template'} onClick={() => act(s.id, 'template')}>{busy === 'template' ? 'Making…' : (t && !t.gone ? 'Update the template' : 'Make the template')}</Btn> : null}
        {n.id === 'campaign' ? <Btn small primary onClick={() => onCampaign(s)}>Make the campaign</Btn> : null}
        {['send', 'approval', 'done'].includes(n.id) && c && !c.gone ? <Btn small primary={n.id === 'send'} onClick={() => go('campaigns')}>Open Campaigns</Btn> : null}
        {t && !t.gone ? <TinyBtn onClick={() => go('templates')}>Open Templates</TinyBtn> : null}
        {!s.campaign ? <TinyBtn onClick={() => onEdit(s)}>Change the words</TinyBtn> : null}
        {!s.campaign ? <TinyBtn onClick={() => onRemove(s)}>Remove</TinyBtn> : null}
      </div>
    </div>
  );
}

export default function MkEmailPage() {
  const { toast, go } = useOmni();
  const [opts, setOpts] = useState(null);
  const [sets, setSets] = useState(null);
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState(null);
  const [camp, setCamp] = useState(null);
  const [del, setDel] = useState(null);
  const [busy, setBusy] = useState('');
  const loadSets = useCallback(() => omni.get('/gs/marketing/email').then((d) => { setSets(d.sets || []); setErr(''); }).catch((e) => setErr(errOf(e, 'Your emails could not be read.'))), []);
  useEffect(() => { omni.get('/gs/marketing/email/options').then(setOpts).catch((e) => setErr(errOf(e, 'Email marketing could not be opened.'))); loadSets(); }, [loadSets]);
  if (err && (!opts || !sets)) return <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={() => window.location.reload()}>Try again</button></Banner>;
  if (!opts || !sets) return <div className="card panel">Loading…</div>;
  const act = async (id, what, body) => {
    setBusy(what); setErr('');
    try { const r = await omni.post(`/gs/marketing/email/${id}/${what}`, body || {}); toast(r.ok || 'Done'); await loadSets(); } catch (e) { const m = errOf(e, 'That did not work.'); setErr(m); toast(m); } finally { setBusy(''); }
  };
  const remove = async () => { const s = del; setDel(null); try { const r = await omni.del(`/gs/marketing/email/${s.id}`); toast(r.ok); await loadSets(); } catch (e) { setErr(errOf(e, 'It could not be removed.')); } };
  const openEdit = async (s) => { try { const r = await omni.get(`/gs/marketing/email/${s.id}`); setEdit({ set: r.set }); } catch (e) { setErr(errOf(e, 'It could not be opened.')); } };
  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="Email marketing" lead="The AI writes subject lines and the email for one open job in your brand voice. Try two subjects against each other (A/B), make the template, and save the campaign for approval. Nothing is sent from here: you press Send in Campaigns.">
        <Btn primary onClick={() => setEdit({ set: null })} disabled={!opts.canCampaign} title={opts.canCampaign ? '' : 'Only the BDE team, Team Leads and Admins can make job campaigns'}>✦ New email</Btn>
      </PageHead>
      {err ? <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={() => setErr('')}>Close</button></Banner> : null}
      {!opts.canCampaign ? <Banner tone="warn">Your login can look at this page, but only the BDE team, Team Leads and Admins can make job campaigns.</Banner> : null}
      {opts.testMode ? <Banner tone="test"><b>Test mode is ON.</b> Campaigns made here run as a rehearsal: every email is built and logged, and nothing is handed to the mail server until an Admin switches Test mode off.</Banner> : null}
      <Panel title="Is email ready to go out?" sub="Set up in Administration > Integrations (the mail server) and Omni-Channel > Settings.">
        <div className="mk-prov">
          <div><b>Email {opts.email.connected ? <Pill tone="live" dot>Mail server set up</Pill> : <Pill tone="warn" dot>Mail server not set up</Pill>} {opts.email.ready ? <Pill tone="live" dot>Message ready</Pill> : <Pill tone="draft">No message ready yet</Pill>}</b><span>{opts.email.note}</span></div>
          <div><b>What the report counts</b><span>Emails sent, clicks on the apply link and replies. Opens are not counted: the emails are plain text with no tracking picture, and mail apps hide opens anyway.</span></div>
        </div>
      </Panel>
      <Panel title="Your emails" sub="Each one is for one open job. Follow the next step shown on it." style={{ marginTop: 14 }} right={<span className="pill live">{sets.length}</span>}>
        {sets.length === 0 ? <Empty title="No emails yet" action={opts.canCampaign ? <Btn primary onClick={() => setEdit({ set: null })}>✦ New email</Btn> : null}>Pick an open job and the AI writes five subject lines and two emails for it. You choose, edit and save.</Empty> : sets.map((s) => <SetCard key={s.id} s={s} busy={busy} act={act} onEdit={openEdit} onRemove={setDel} onCampaign={setCamp} go={go} />)}
      </Panel>
      {edit ? <Editor opts={opts} set={edit.set} toast={toast} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); loadSets(); }} /> : null}
      {camp ? <CampaignModal set={camp} opts={opts} toast={toast} onClose={() => setCamp(null)} onDone={() => { setCamp(null); loadSets(); }} /> : null}
      {del ? <ConfirmModal title={`Remove “${del.title}”?`} text="The template made from it stays in Templates." yes="Remove" danger onNo={() => setDel(null)} onYes={remove} /> : null}
    </div>
  );
}
