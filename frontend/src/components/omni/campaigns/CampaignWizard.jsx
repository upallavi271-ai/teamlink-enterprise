import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Combo from '../../Combo.jsx';
import MultiPick from '../../MultiPick.jsx';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { Banner, Btn, ConfirmModal, Empty, Field, GsModal, Panel, Pill } from './../ui.jsx';
import { CH_WORD, n0 } from './shared.jsx';
import { useWaSender } from '../../messaging/WaSender.jsx';

const STEPS = ['1 · Basics', '2 · Audience', '3 · Content', '4 · Channels', '5 · Review'];
const TEXT = ['whatsapp', 'sms', 'email'];
const TODAY_IST = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
const tomorrowIst = () => new Date(Date.now() + 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);
const blank = () => ({ name: '', objective: 'recruitment', tag: '', goal: '', job: null, segmentIds: [], channels: [], templates: {}, masterMessage: '', cta: '', brandVoice: 'Warm & confident', when: 'now', date: tomorrowIst(), time: '10:00', approvalMode: 'auto', perMinute: '' });

// plain fill of {{words}} with sample values for the live preview (the server does the real one)
const fill = (text, vars) => String(text || '').replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (m, v) => (v in vars ? vars[v] : m));
const varOrder = (body) => { const seen = []; [...String(body || '').matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)].forEach((m) => { if (['name', 'job_title', 'company', 'apply_link'].includes(m[1]) && !seen.includes(m[1])) seen.push(m[1]); }); return seen; };

function JobPicker({ job, onPick }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let on = true; setBusy(true);
    const t = setTimeout(() => { omni.get('/gs/campaigns/jobs', { q }).then((r) => { if (on) setList(r.jobs || []); }).catch(() => { if (on) setList([]); }).finally(() => { if (on) setBusy(false); }); }, 250);
    return () => { on = false; clearTimeout(t); };
  }, [q]);
  return (
    <div>
      {job && <div className="cmp-pick"><span className="tag green">{job.title}{job.reqCode ? ` · ${job.reqCode}` : ''}</span><button type="button" className="link-btn" onClick={() => onPick(null)}>Change</button></div>}
      {!job && (
        <>
          <input className="search" style={{ width: '100%' }} aria-label="Search requirements" placeholder="Type a requirement title, code, department or place to search" value={q} onChange={(e) => setQ(e.target.value)} />
          <div style={{ maxHeight: 170, overflow: 'auto', display: 'grid', gap: 5, marginTop: 6 }}>
            {list.map((j) => <button key={j.id} type="button" className="cmp-job" onClick={() => onPick({ id: j.id, title: j.title, reqCode: j.reqCode })}><b>{j.title}</b>{j.reqCode ? ` · ${j.reqCode}` : ''}<span className="cmp-sub">{[j.department, j.location].filter(Boolean).join(' · ')}{j.onPortal ? '' : ' · not on the Job Portal yet'}</span></button>)}
            {!busy && !list.length && <small style={{ color: 'var(--muted)' }}>No open requirement found{q ? ' for this search' : ' in your area'}.</small>}
          </div>
        </>
      )}
    </div>
  );
}

// the Create campaign wizard: Basics, Audience, Content, Channels, Review. editKey = change a campaign that was not sent yet.
export default function CampaignWizard({ editKey, initialSegment, onClose, onDone }) {
  const { go, toast } = useOmni();
  const [step, setStep] = useState(1);
  const [f, setF] = useState(() => ({ ...blank(), segmentIds: initialSegment ? [initialSegment] : [] }));
  const [init, setInit] = useState(JSON.stringify(blank()));
  const [opts, setOpts] = useState(null);
  const [plan, setPlan] = useState(null);
  const [planErr, setPlanErr] = useState('');
  const [rev, setRev] = useState(null);
  const [revBusy, setRevBusy] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(!!editKey);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const internal = f.objective === 'staff';

  // the picks (objectives, groups with counts, channel readiness, messages, credits); asked again when the kind of audience changes
  const loadOpts = useCallback(async () => { try { setOpts(await omni.get('/gs/campaigns/options', { audience: internal ? 'internal' : 'candidate_lead' })); } catch (e) { setErr(errOf(e, 'The wizard could not be opened.')); } }, [internal]);
  useEffect(() => { loadOpts(); }, [loadOpts]);
  useEffect(() => {
    if (!editKey) return;
    omni.get(`/gs/campaigns/campaign/${editKey}/edit`).then((e) => {
      const next = { ...blank(), name: e.name, objective: e.objective, tag: e.tag, goal: e.goal, job: e.job, segmentIds: e.segmentIds, channels: e.channels, templates: e.templates || {}, masterMessage: e.masterMessage, cta: e.cta, brandVoice: e.brandVoice || 'Warm & confident', approvalMode: e.approvalMode || 'auto', perMinute: e.perMinute || '' };
      if (e.when === 'at' && e.at) { const ms = Date.parse(e.at); if (Number.isFinite(ms)) { next.when = 'at'; next.date = new Date(ms + 5.5 * 3600000).toISOString().slice(0, 10); next.time = new Date(ms + 5.5 * 3600000).toISOString().slice(11, 16); } }
      setF(next); setInit(JSON.stringify(next));
    }).catch((e) => setErr(errOf(e, 'This campaign cannot be changed.'))).finally(() => setLoadingEdit(false));
  }, [editKey]);

  const dirty = JSON.stringify(f) !== init;
  const close = () => { if (dirty) setConfirmClose(true); else onClose(); };
  const atIso = f.when === 'at' ? `${f.date}T${f.time}:00+05:30` : undefined;
  // WhatsApp: the company number this campaign leaves from (kept on the campaign; only numbers the Admin gave this login)
  const wa = useWaSender(f.channels.includes('whatsapp'));
  const body = useMemo(() => ({ objective: f.objective, requirementId: f.job ? f.job.id : undefined, segmentIds: f.segmentIds, channels: f.channels, templates: f.templates, masterMessage: f.masterMessage, cta: f.cta, when: f.when, at: atIso, perMinute: f.perMinute ? Number(f.perMinute) : undefined, waNumberId: f.channels.includes('whatsapp') ? wa.numberId : undefined }), [f, atIso, wa.numberId]);

  // step 2: the live plan (who would get it)
  const planSeq = useRef(0);
  useEffect(() => {
    if (step < 2 || !f.segmentIds.length || (!internal && !f.job)) { setPlan(null); return undefined; }
    const my = ++planSeq.current;
    const t = setTimeout(() => { omni.post('/gs/campaigns/plan', { objective: f.objective, requirementId: f.job ? f.job.id : undefined, segmentIds: f.segmentIds, channels: f.channels }).then((p) => { if (my === planSeq.current) { setPlan(p); setPlanErr(''); } }).catch((e) => { if (my === planSeq.current) { setPlan(null); setPlanErr(errOf(e, 'The audience could not be counted.')); } }); }, 250);
    return () => clearTimeout(t);
  }, [step, f.segmentIds, f.job, f.channels, f.objective, internal]);
  // step 5: the review
  useEffect(() => {
    if (step !== 5) return undefined;
    setRevBusy(true); setRev(null);
    const t = setTimeout(() => { omni.post('/gs/campaigns/review', body).then(setRev).catch((e) => setRev({ error: errOf(e, 'The check could not be made.') })).finally(() => setRevBusy(false)); }, 150);
    return () => clearTimeout(t);
  }, [step, body]);

  const chOpt = (id) => (opts ? opts.channels.find((c) => c.channel === id) : null);
  const tplList = (ch) => (opts ? opts.templates.filter((t) => t.channel === ch) : []);
  const tplOf = (ch) => tplList(ch).find((t) => t.id === f.templates[ch]) || null;
  const job = f.job;
  const sampleVars = { name: 'Anita', job_title: job ? job.title : 'the requirement', company: 'TeamLink', apply_link: 'https://…/r/sample', unsubscribe: 'Reply STOP to opt out' };

  const checkStep = (n) => {
    if (n === 1) { if (f.name.trim().length < 2) return 'Give the campaign a name.'; if (!internal && !f.job) return 'Pick the requirement this campaign is about.'; }
    if (n === 2 && !f.segmentIds.length) return 'Pick at least one group of people.';
    if (n === 4) {
      if (!f.channels.length) return 'Select at least one channel to publish this campaign.';
      if (f.channels.includes('whatsapp') && !wa.canSend) return wa.blockedMessage;
      const miss = f.channels.find((c) => TEXT.includes(c) && !f.templates[c]);
      if (miss) return `Pick the ${CH_WORD[miss]} message in step 3 (Content).`;
    }
    return '';
  };
  const next = () => { const e = checkStep(step); if (e) { setErr(e); return; } setErr(''); if (step === 5) { create(false); return; } setStep(step + 1); };
  const back = () => { setErr(''); setStep(Math.max(1, step - 1)); };
  const payload = (saveOnly) => ({ ...body, name: f.name.trim(), tag: f.tag, goal: f.goal, cta: f.cta, brandVoice: f.brandVoice, approvalMode: f.approvalMode, saveOnly });
  const create = async (saveOnly) => {
    if (saveOnly) { if (f.name.trim().length < 2) { setErr('To save for later, give the campaign a name first.'); return; } if (!internal && !f.job) { setErr('To save for later, pick the requirement first (step 1).'); return; } if (!f.segmentIds.length) { setErr('To save for later, pick a group (step 2).'); return; } if (!f.channels.length) { setErr('To save for later, pick at least one channel (step 4).'); return; } } else if (rev && rev.blocked) { setErr('Something must be fixed before this can go out. See the red lines above.'); return; }
    setBusy(true); setErr('');
    try {
      const r = editKey ? await omni.put(`/gs/campaigns/campaign/${editKey}`, payload(saveOnly)) : await omni.post('/gs/campaigns/create', payload(saveOnly));
      toast(saveOnly ? `"${f.name.trim()}" is saved as not sent yet.` : r.message);
      onDone(r);
    } catch (e) { setErr(errOf(e, 'The campaign could not be made.')); } finally { setBusy(false); }
  };

  const toggleChannel = (c) => { const sel = f.channels.includes(c); set('channels', sel ? f.channels.filter((x) => x !== c) : [...f.channels, c]); };
  const credits = rev && rev.credits;
  const canApprove = opts && opts.approval;
  const forced = canApprove && canApprove.forced;

  return (
    <>
      <GsModal title={editKey ? 'Edit campaign' : 'Create campaign'} sub="Create one master campaign and publish channel-specific versions." width={760} onClose={close} bodyStyle={{ maxHeight: '66vh' }}
        foot={(
          <>
            <Btn disabled={busy || loadingEdit} onClick={() => create(true)}>Save for later</Btn>
            <Btn disabled={step === 1 || busy} onClick={back}>Back</Btn>
            <Btn primary disabled={busy || loadingEdit || (step === 5 && (revBusy || !rev || !!rev.error))} onClick={next}>{step === 5 ? (editKey ? 'Save and publish' : 'Create campaign') : 'Continue'}</Btn>
          </>
        )}>
        <div className="wizard-steps">{STEPS.map((s, i) => <div key={s} className={`wizard-step${step === i + 1 ? ' active' : ''}${step > i + 1 ? ' done' : ''}`}>{s}</div>)}</div>
        {!opts && !err && <div style={{ fontSize: 11 }}>Loading…</div>}
        {opts && !opts.canCreate && <Banner tone="warn">You can look at campaigns, but only the BDE team, Team Leads and Admins can make them.</Banner>}
        {opts && (
          <div className="cmp-wiz-body">
            {step === 1 && (
              <div className="form-grid">
                <Field label="CAMPAIGN NAME" full><input value={f.name} maxLength={80} placeholder="For example: Staff Nurse hiring drive" onChange={(e) => set('name', e.target.value)} /></Field>
                <Field label="OBJECTIVE">
                  <Combo value={f.objective} onChange={(e) => { set('objective', e.target.value); if (e.target.value === 'staff') { set('job', null); set('segmentIds', []); set('templates', {}); } else if (internal) { set('segmentIds', []); set('templates', {}); } }}>
                    {opts.objectives.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </Combo>
                </Field>
                <Field label="CAMPAIGN TAG"><input value={f.tag} maxLength={60} placeholder="For example: Hospital hiring" onChange={(e) => set('tag', e.target.value)} /></Field>
                {!internal && <Field label="REQUIREMENT" full hint="Every message to candidates and clients is about one open requirement, so pick the requirement. The apply link opens it."><JobPicker job={f.job} onPick={(j) => set('job', j)} /></Field>}
                <Field label="NOTES (WHAT IS THE GOAL?)" full><textarea rows={3} value={f.goal} maxLength={600} placeholder="For example: Fill 5 ICU nurse openings this month." onChange={(e) => set('goal', e.target.value)} /></Field>
              </div>
            )}

            {step === 2 && (
              <div>
                <Field label="AUDIENCE (GROUPS OF PEOPLE)" hint="Groups are made on the Segments page. A person in two groups is counted once.">
                  <MultiPick options={opts.segments.map((s) => ({ value: s.id, label: s.name, sub: `${n0(s.total)} people${s.emptyRule ? ' · no rule yet' : ''}` }))} value={f.segmentIds} onChange={(v) => set('segmentIds', v)} placeholder="Pick one or more groups" emptyText="There is no group yet." />
                </Field>
                {!opts.segments.length && <Empty title="No group yet" action={<Btn onClick={() => go('segments')}>Make a group on the Segments page</Btn>}>A campaign needs a group of people to message.</Empty>}
                {opts.segments.length > 0 && <div style={{ marginTop: 6 }}><button type="button" className="link-btn" onClick={() => go('segments')}>Edit groups →</button></div>}
                <div className="card panel" style={{ marginTop: 13, background: '#fbfdfc' }}>
                  <div className="panel-title">Estimated audience</div>
                  {!f.segmentIds.length && <div className="lead" style={{ marginTop: 6 }}>Pick a group to see how many people it holds and how many can really be messaged.</div>}
                  {planErr && <div className="cmp-err">{planErr}</div>}
                  {plan && (
                    <>
                      <div className="cmp-big" style={{ marginTop: 5 }}>{n0(plan.people)}</div>
                      <div className="lead">{n0(plan.reach)} expected reach after consent and channel eligibility checks.{plan.excluded > 0 ? ` ${n0(plan.excluded)} will be left out.` : ''}</div>
                      {plan.excludedReasons.length > 0 && <div style={{ fontSize: 10.5, margin: '6px 0' }}>Left out because: {plan.excludedReasons.map((r) => `${r.words} (${r.n})`).join(' · ')}</div>}
                      <div className="table-scroll" style={{ marginTop: 8 }}>
                        <table className="table cmp-table-small"><thead><tr><th>Channel</th><th>Will get it</th><th>Left out</th><th>Why</th></tr></thead>
                          <tbody>{plan.perChannel.map((p) => <tr key={p.channel}><td><b>{p.label}</b></td><td>{n0(p.willGet)}</td><td>{n0(p.skippedTotal)}</td><td style={{ overflowWrap: 'anywhere' }}>{p.reasons.length ? p.reasons.map((r) => `${r.words} (${r.n})`).join(' · ') : '—'}</td></tr>)}</tbody></table>
                      </div>
                      <p style={{ fontSize: 10, color: 'var(--muted)', marginTop: 8 }}>{plan.consentNote}</p>
                    </>
                  )}
                </div>
              </div>
            )}

            {step === 3 && (
              <div>
                <div className="form-grid">
                  <Field label="MASTER MESSAGE" full hint="The main words of the campaign. It is the call script for Voice and the starting point for your team; each channel sends its own message below."><textarea rows={5} value={f.masterMessage} maxLength={2000} placeholder="Write the message in your own words" onChange={(e) => set('masterMessage', e.target.value)} /></Field>
                  <Field label="CTA"><input value={f.cta} maxLength={80} placeholder="For example: Apply now" onChange={(e) => set('cta', e.target.value)} /></Field>
                  <Field label="BRAND VOICE"><select value={f.brandVoice} onChange={(e) => set('brandVoice', e.target.value)}>{opts.brandVoices.map((v) => <option key={v}>{v}</option>)}</select></Field>
                </div>
                <div className="panel-title" style={{ margin: '16px 0 8px' }}>Message for each channel</div>
                {TEXT.map((ch) => {
                  const t = tplOf(ch); const list = tplList(ch);
                  return (
                    <div key={ch}>
                      <div className="cmp-tpl-row">
                        <Field label={`${CH_WORD[ch].toUpperCase()} MESSAGE`} hint={ch === 'whatsapp' ? 'WhatsApp can only send a message Meta has approved.' : (ch === 'sms' ? 'SMS needs the DLT template number and the sender ID.' : '')}>
                          <Combo value={f.templates[ch] || ''} onChange={(e) => set('templates', { ...f.templates, [ch]: e.target.value || undefined })}>
                            <option value="">No {CH_WORD[ch]} message</option>
                            {list.map((x) => <option key={x.id} value={x.id}>{x.name}{x.ready ? '' : ` (not ready: ${x.why})`}</option>)}
                          </Combo>
                        </Field>
                        <Btn small onClick={() => go('templates')}>Edit messages</Btn>
                      </div>
                      {t && (
                        <div className="preview" style={{ marginBottom: 12 }}>
                          <div className="preview-head">{CH_WORD[ch]} preview {t.ready ? <Pill tone="live">Ready</Pill> : <Pill tone="warn">Needs setup</Pill>}</div>
                          <div className="preview-body"><div className="cmp-msg">{t.subject ? <b>{fill(t.subject, sampleVars)}{'\n\n'}</b> : null}{fill(t.body, sampleVars)}</div>
                            {ch === 'whatsapp' && <span className="cmp-sub" style={{ marginTop: 8 }}>Meta template {t.waTemplateName || '(no name yet)'} · variables go in this order: {varOrder(t.body).map((v, i) => `${i + 1} = ${v}`).join(', ') || 'none'}</span>}
                            {ch === 'sms' && <span className="cmp-sub" style={{ marginTop: 8 }}>DLT template {t.dltTemplateId || '(missing)'} · sender {t.senderId || '(missing)'}</span>}
                            {!t.ready && <span className="cmp-sub" style={{ color: '#9b6d12' }}>{t.why}</span>}
                          </div>
                        </div>
                      )}
                      {!list.length && <p style={{ fontSize: 10, color: 'var(--muted)', margin: '0 0 10px' }}>No {CH_WORD[ch]} message exists yet. Make one in Manage Templates.</p>}
                    </div>
                  );
                })}
                <div className="card panel" style={{ background: '#fbfdfc' }}>
                  <div className="panel-title">Voice (calls)</div>
                  <p style={{ fontSize: 10.5, color: 'var(--muted)', margin: '4px 0 0' }}>A Voice campaign has no message. Each person becomes a call task and your team rings them with the master message as the script.</p>
                  {f.masterMessage && <div className="cmp-msg" style={{ marginTop: 8 }}>{f.masterMessage}</div>}
                </div>
              </div>
            )}

            {step === 4 && (
              <div>
                <Field label="PUBLISH TO">
                  <div className="checks" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {opts.channels.map((c) => {
                      const on = f.channels.includes(c.channel);
                      return <button key={c.channel} type="button" className={`check${on ? ' on' : ''}`} disabled={!c.selectable} title={c.selectable ? '' : c.note} aria-pressed={on} onClick={() => toggleChannel(c.channel)} style={!c.selectable ? { opacity: 0.55 } : undefined}>{on ? '✓ ' : ''}{c.label}{c.planned ? ' (planned)' : (!c.selectable ? ' (not connected)' : '')}</button>;
                    })}
                  </div>
                </Field>
                {f.channels.includes('whatsapp') && wa.node && <div style={{ marginTop: 12 }}>{wa.node}</div>}
                <div className="card panel" style={{ marginTop: 14 }}>
                  <div className="panel-title">Channel readiness</div>
                  <div className="settings-list">
                    {!f.channels.length && <p style={{ fontSize: 11, color: 'var(--muted)', padding: '4px 2px' }}>Select at least one channel to publish this campaign.</p>}
                    {opts.channels.filter((c) => f.channels.includes(c.channel)).map((c) => {
                      const needsMsg = TEXT.includes(c.channel) && !f.templates[c.channel];
                      return (
                        <div key={c.channel} className="settings-item">
                          <div><strong>{c.label}</strong><small>{c.note}{needsMsg ? ' · Pick its message in step 3.' : ''}</small></div>
                          <span className={`pill ${c.ready && !needsMsg ? 'live' : 'warn'}`}>{c.ready && !needsMsg ? 'Ready' : 'Needs setup'}</span>
                        </div>
                      );
                    })}
                    {opts.channels.filter((c) => !c.selectable).map((c) => <div key={c.channel} className="settings-item"><div><strong>{c.label}</strong><small>{c.note}</small></div><span className="pill draft">{c.planned ? 'Planned' : 'Not connected'}</span></div>)}
                  </div>
                </div>
              </div>
            )}

            {step === 5 && (
              <div>
                <Panel title="Campaign summary" style={{ background: '#fbfdfc' }}>
                  <div className="kv-grid">
                    <div className="kv-item"><small>Name</small><b>{f.name.trim() || 'Untitled campaign'}</b></div>
                    <div className="kv-item"><small>Objective</small><b>{(opts.objectives.find((o) => o.id === f.objective) || {}).label}</b></div>
                    <div className="kv-item"><small>Requirement</small><b>{job ? job.title : '—'}</b></div>
                    <div className="kv-item"><small>Audience</small><b>{plan ? `${n0(plan.people)} people` : `${f.segmentIds.length} group(s)`}</b></div>
                    <div className="kv-item"><small>Channels</small><b>{f.channels.map((c) => CH_WORD[c]).join(' · ') || 'No channels selected'}</b></div>
                  </div>
                </Panel>
                {revBusy && <p style={{ fontSize: 11 }}>Checking everything…</p>}
                {rev && rev.error && <Banner tone="error">{rev.error}</Banner>}
                {rev && !rev.error && (
                  <>
                    {rev.testMode && <Banner tone="test"><b>Test mode is ON.</b> This will be a rehearsal: the list, the logs and the links are made, but nothing is really sent. Calls are the exception: they are tasks for a person.</Banner>}
                    {rev.channels.map((c) => (
                      <Panel key={c.channel} title={c.label} sub={c.plan && c.plan.willGet != null ? `${n0(c.plan.willGet)} will get it · ${n0(c.plan.skippedTotal)} left out` : ''} style={{ marginTop: 10 }}>
                        <div>{c.check.checks.map((k) => <div key={k.id} className={`cmp-check ${k.status}`}><b>{k.status === 'ok' ? 'OK' : (k.status === 'warn' ? 'Note' : 'Fix')}</b><span>{k.label}{k.detail ? <small>{k.detail}{k.status === 'block' && k.fix ? ` ${k.fix}` : ''}</small> : null}</span></div>)}</div>
                        {c.plan && c.plan.preview && c.plan.preview.body && <div style={{ marginTop: 8, background: '#fbfdfc', border: '1px solid var(--line)', borderRadius: 10, padding: '8px 11px' }}><small style={{ color: 'var(--muted)', fontSize: 9, fontWeight: 800 }}>SAMPLE MESSAGE (to {c.plan.preview.sampleName})</small><div className="cmp-msg">{c.plan.preview.subject ? <b>{c.plan.preview.subject}{'\n\n'}</b> : null}{c.plan.preview.body}</div></div>}
                      </Panel>
                    ))}
                    <Panel title="Credits" style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 11 }}>{credits.needed ? `Needs ${n0(credits.needed)} credits` : (rev.testMode ? 'A rehearsal costs no credits.' : 'No credits needed.')}{credits.exempt ? ' · your login has no credit limit' : (credits.left != null ? ` · you have ${n0(credits.left)} left this month` : '')}{!credits.enough && <b style={{ color: '#b3261e' }}> · not enough credits, a live send is blocked</b>}</div>
                    </Panel>
                  </>
                )}
                <Panel title="Publishing" style={{ marginTop: 12 }}>
                  <div className="form-grid" style={{ marginTop: 11 }}>
                    <Field label="SCHEDULE"><select value={f.when} onChange={(e) => set('when', e.target.value)}><option value="now">Publish now</option><option value="at">Schedule for later</option></select></Field>
                    <Field label="APPROVAL" hint={forced ? 'The Admin has switched approval on: a campaign made by the BDE team waits for a Team Lead.' : ''}>
                      <select value={forced ? 'approval' : f.approvalMode} disabled={forced} onChange={(e) => set('approvalMode', e.target.value)}><option value="approval">Publish after approval</option><option value="auto">Auto-publish</option></select>
                    </Field>
                    {f.when === 'at' && <><Field label="DATE"><input type="date" min={TODAY_IST()} value={f.date} onChange={(e) => set('date', e.target.value)} /></Field><Field label="TIME (IST)"><input type="time" value={f.time} onChange={(e) => set('time', e.target.value)} /></Field></>}
                    <Field label="SPEED (MESSAGES A MINUTE, OPTIONAL)" hint={`Never above the channel's own limit: WhatsApp ${opts.settings.perMinute.whatsapp}, SMS ${opts.settings.perMinute.sms}, Email ${opts.settings.perMinute.email}. Empty = the channel's speed.`}><input type="number" min="1" value={f.perMinute} onChange={(e) => set('perMinute', e.target.value)} /></Field>
                  </div>
                  <p style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 6 }}>{f.when === 'at' ? 'All times are India Standard Time (Asia/Kolkata). Voice call tasks appear straight away.' : 'Voice call tasks appear straight away.'} {opts.settings.quietWords}</p>
                  {rev && rev.quietNote && <Banner tone="warn">{rev.quietNote}</Banner>}
                  {!rev || !rev.approval ? null : (rev.approval.forced || f.approvalMode === 'approval') && <Banner tone="info">After you press the button this waits for approval. A Team Lead (or an Admin) approves it, then you press Send. Nothing goes out before that.</Banner>}
                </Panel>
              </div>
            )}
            {err && <div className="cmp-err" role="alert">{err}</div>}
          </div>
        )}
        {err && !opts && <div className="cmp-err" role="alert">{err}</div>}
      </GsModal>
      {confirmClose && <ConfirmModal title="Discard this?" text="Everything you have entered here will be lost." yes="Discard" danger onNo={() => setConfirmClose(false)} onYes={onClose} />}
    </>
  );
}
