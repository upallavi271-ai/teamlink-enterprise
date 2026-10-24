import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import Combo from '../Combo.jsx';
import MultiPick from '../MultiPick.jsx';
import { useSearchParams } from 'react-router-dom';
import StatusChip from '../ui/StatusChip.jsx';
import MessageLog from './MessageLog.jsx';
import './campaigns.css';

// ---------------------------------------------------------------------------
// OMNI-CHANNEL > CAMPAIGNS (Phase 3). A campaign = a job (or a staff message) + groups of people + Email + a message + when.
// Plain words: Job, Waiting, Sent, Late... While Email TEST MODE is on, every send is a REHEARSAL: all the rows and logs, nothing really sent.
// Server: /api/outreach/campaigns (outreach/campaigns.js). Each login sees only what the server allows; buttons are separate (no menus).
// ---------------------------------------------------------------------------
const TONE = { draft: 'yellow', preparing: 'blue', scheduled: 'yellow', running: 'blue', paused: 'yellow', done: 'green', stopped: 'grey' };
const fmt = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }) : '');
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;

// "2026-10-15T09:30" typed as INDIA time -> ISO
const istToIso = (v) => (v ? new Date(`${v}:00+05:30`).toISOString() : null);
const istMin = () => new Date(Date.now() + 5.5 * 3600000 + 5 * 60000).toISOString().slice(0, 16);

function Banner({ testMode, sendingOn, rehearsal }) {
  return (
    <>
      {rehearsal === true && <div className="occ-banner test" role="status"><b>This was a rehearsal.</b> Everything was made (the list of people, the logs, the links) but nothing was really sent.</div>}
      {rehearsal !== true && testMode && <div className="occ-banner test" role="status"><b>Test mode is ON.</b> A send now is a <b>rehearsal</b>: it makes all the rows and logs, but nothing is really sent. An Admin turns test mode off in Settings &gt; Channels.</div>}
      {sendingOn === false && <div className="occ-banner off" role="status"><b>Sending is switched OFF.</b> You can get a campaign ready, but nothing goes out (not even a rehearsal) until an Admin switches "Outreach sending" on.</div>}
    </>
  );
}

// ---- why a campaign is not going out (worked out live by the server) + the fix, in plain words ------------------------------------
const LEVEL = { stop: ['off', 'Not going out.'], wait: ['wait', 'On hold.'], info: ['info', 'Good to know.'] };
function FixButton({ fix, acc, onSettings, onClose }) {
  const [, setSp] = useSearchParams();
  if (!fix || !fix.action) return null;
  if (fix.action === 'sending_settings' && acc && acc.isAdmin && onSettings) return <button type="button" className="btn btn-sm occ-fixbtn" onClick={() => { if (onClose) onClose(); onSettings(); }}>Open the sending settings</button>;
  if (fix.action === 'channels' && acc && acc.isAdmin) return <button type="button" className="btn btn-sm occ-fixbtn" onClick={() => { if (onClose) onClose(); setSp({ mode: 'settings', tab: 'channels' }); }}>Open Settings &gt; Channels</button>;
  return null;
}
function StopBanner({ health, acc, compact, onSettings, onClose }) {
  if (!health || !health.primary) return null;
  const shown = compact ? [health.primary] : health.reasons;
  return (
    <>
      {shown.map((r) => {
        const [cls, head] = LEVEL[r.level] || LEVEL.info;
        return (
          <div className={`occ-banner ${cls}`} role="status" key={r.code}>
            <b>{head}</b> {r.words}
            {r.fix && r.fix.text && <div className="occ-fix"><b>What to do:</b> {r.fix.text}</div>}
            <FixButton fix={r.fix} acc={acc} onSettings={onSettings} onClose={onClose} />
          </div>
        );
      })}
    </>
  );
}
// ---- "Check before sending": every line green (fine), orange (look) or red (stops the Send button) --------------------------------------------
function CheckBox({ check, busy, err }) {
  if (busy && !check) return <div className="oc-note">Checking everything before you send…</div>;
  if (err) return <div className="bc-err" role="alert">{err}</div>;
  if (!check) return null;
  return (
    <div className="occ-check" aria-label="Check before sending">
      <b>Check before sending</b>
      {check.blocked ? <div className="bc-err" role="alert">Something needs fixing before you can send. You can still save it for later.</div> : <div className="bc-ok" role="status">All good. You can send.</div>}
      {check.checks.map((c, i) => (
        <div className={`occ-chk ${c.status}`} key={`${c.id}${i}`}>
          <i>{c.status === 'ok' ? '✓' : (c.status === 'warn' ? '!' : '✕')}</i><span><b>{c.label}</b></span>
          {c.detail && <small>{c.detail}</small>}
          {c.fix && c.status !== 'ok' && <small className={c.status === 'block' ? 'fix' : ''}>What to do: {c.fix}</small>}
        </div>
      ))}
    </div>
  );
}

function Mini({ c, rehearsal }) {
  const bits = [];
  if (c.waiting) bits.push(['b', `${c.waiting} waiting`]);
  if (c.sent) bits.push(['g', `${c.sent} ${rehearsal ? 'rehearsed' : 'sent'}`]);
  if (c.delivered) bits.push(['g', `${c.delivered} delivered`]);
  if (c.clicked) bits.push(['g', `${c.clicked} clicked`]);
  if (c.applied) bits.push(['g', `${c.applied} applied`]);
  if (c.failed) bits.push(['r', `${c.failed} failed`]);
  if (c.skipped) bits.push(['o', `${c.skipped} skipped`]);
  if (c.cancelled) bits.push(['', `${c.cancelled} cancelled`]);
  if (!bits.length) return <span className="occ-meta">Nothing sent yet</span>;
  return <div className="occ-mini">{bits.map(([k, t]) => <span key={t} className={k}>{t}</span>)}</div>;
}

// ---- Pause / Resume / Stop (separate buttons) --------------------------------------------------------------
function Controls({ id, can, onDone, onMsg, onErr, extra }) {
  const [busy, setBusy] = useState('');
  const act = async (what, word) => {
    if (what === 'stop' && !window.confirm('Stop this campaign for good? People who were not messaged yet will not get it.')) return;
    setBusy(what); onErr('');
    try { const r = await api.post(`/outreach/campaigns/${id}/${what}`, {}); onMsg(r.data.ok || word); onDone(); } catch (e) { onErr(errOf(e, 'That did not work. Please try again.')); } finally { setBusy(''); }
  };
  return (
    <div className="occ-btns">
      {extra}
      {can.pause && <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => act('pause', 'Paused.')}>{busy === 'pause' ? 'Pausing…' : 'Pause'}</button>}
      {can.resume && <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => act('resume', 'Sending again.')}>{busy === 'resume' ? 'Starting…' : 'Resume'}</button>}
      {can.stop && <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => act('stop', 'Stopped.')}>{busy === 'stop' ? 'Stopping…' : 'Stop'}</button>}
    </div>
  );
}

// ---- when to send (shared by the wizard and a draft) -----------------------------------------------------------------
function When({ value, onChange }) {
  return (
    <div>
      <div className="oc-choice">
        <button type="button" className={value.when === 'now' ? 'on' : ''} onClick={() => onChange({ ...value, when: 'now' })}>Send now</button>
        <button type="button" className={value.when === 'at' ? 'on' : ''} onClick={() => onChange({ ...value, when: 'at' })}>Pick a date and time</button>
      </div>
      {value.when === 'at' && (
        <div className="occ-time">
          <input type="datetime-local" value={value.at} min={istMin()} onChange={(e) => onChange({ ...value, at: e.target.value })} aria-label="Date and time" />
          <span className="oc-note">India time (IST)</span>
        </div>
      )}
    </div>
  );
}

// ---- the plan: how many people will get it, and why the others are skipped -----------------------------------------------------
function PlanBox({ plan, loading }) {
  if (loading && !plan) return <div className="oc-note">Counting…</div>;
  if (!plan) return null;
  const groups = Object.entries(plan.skipped || {}).filter(([, n]) => n > 0);
  return (
    <div className="oc-card" style={{ marginTop: 8 }}>
      <div className="occ-big">{plan.willGet}</div>
      <div><b>{plural(plan.willGet, 'person', 'people')} will get it.</b></div>
      <div className="oc-note">{plan.people} {plan.people === 1 ? 'person is' : 'people are'} in the groups you picked{plan.duplicates > 0 ? ` (people in more than one group are counted once)` : ''}.</div>
      {groups.length === 0 ? <div className="bc-ok">Nobody is skipped.</div> : (
        <>
          <div className="oc-note" style={{ marginTop: 6 }}>Left out, and why:</div>
          <div className="occ-skips">{groups.map(([g, n]) => <span key={g}>{plan.groupWords[g] || g}: {n}</span>)}</div>
        </>
      )}
      {plan.warnings && plan.warnings.map((w) => <div className="bc-warn" key={w} role="status">{w}</div>)}
    </div>
  );
}

// ---- the wizard ----------------------------------------------------------------------------------------------------------------------------
const STEPS = ['What for', 'Who', 'Which way', 'Message', 'When', 'Review'];
// campaign types and promotion types: LABELS on the one campaign engine (the server keeps them in OutreachCampaign.kind)
export const CAMPAIGN_KINDS = [['recruitment', 'Recruitment campaign'], ['job', 'Requirement campaign'], ['client', 'Client campaign'], ['referral', 'Referral campaign']];
export const PROMOTION_KINDS = [['job_promotion', 'Job promotion'], ['walkin', 'Walk-in drive'], ['hiring_event', 'Hiring event'], ['candidate_promotion', 'Candidate promotion'], ['referral_promotion', 'Referral promotion']];
function Wizard({ type, acc, group, onClose, onDone }) {
  const internal = type === 'internal';
  const [step, setStep] = useState(0);
  const [f, setF] = useState({ requirementId: '', jobTitle: '', segmentIds: [], templateId: '', when: 'now', at: '', name: '', kind: group === 'promotion' ? 'job_promotion' : 'job' });
  const [jobs, setJobs] = useState(null);
  const [jq, setJq] = useState('');
  const [groups, setGroups] = useState(null);
  const [tpls, setTpls] = useState(null);
  const [plan, setPlan] = useState(null);
  const [planErr, setPlanErr] = useState('');
  const [planBusy, setPlanBusy] = useState(false);
  const [test, setTest] = useState(null);
  const [testBusy, setTestBusy] = useState(false);
  const [check, setCheck] = useState(null);
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkErr, setCheckErr] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const kind = internal ? 'internal' : 'job_promotion';
  const base = useMemo(() => ({ type: kind, requirementId: internal ? undefined : f.requirementId, segmentIds: f.segmentIds, templateId: f.templateId || undefined, channel: 'email' }), [kind, internal, f.requirementId, f.segmentIds, f.templateId]);

  useEffect(() => {
    api.get('/outreach/segments', { params: { type: internal ? 'internal' : 'candidate_lead' } }).then((r) => setGroups(r.data.segments)).catch(() => setGroups([]));
    api.get('/outreach/templates', { params: { type: internal ? 'internal' : 'candidate_lead' } }).then((r) => setTpls(r.data.templates.filter((t) => t.channel === 'email'))).catch(() => setTpls([]));
  }, [internal]);
  useEffect(() => {
    if (internal) return undefined;
    const t = setTimeout(() => { api.get('/outreach/campaigns/jobs', { params: { q: jq || undefined } }).then((r) => setJobs(r.data.jobs)).catch((e) => { setJobs([]); setErr(errOf(e, 'The jobs could not be loaded.')); }); }, 250);
    return () => clearTimeout(t);
  }, [jq, internal]);
  // the live count (needs a job and groups; the message is added from step 4)
  useEffect(() => {
    if (step < 1 || !f.segmentIds.length || (!internal && !f.requirementId)) { setPlan(null); return undefined; }
    setPlanBusy(true);
    const t = setTimeout(() => { api.post('/outreach/campaigns/plan', base).then((r) => { setPlan(r.data); setPlanErr(''); }).catch((e) => { setPlan(null); setPlanErr(errOf(e, 'We could not count the people.')); }).finally(() => setPlanBusy(false)); }, 250);
    return () => clearTimeout(t);
  }, [step, base, f.segmentIds.length, f.requirementId, internal]);

  // the review step runs the check (and again whenever something it depends on changes)
  const whenKey = f.when === 'at' ? istToIso(f.at) : 'now';
  useEffect(() => {
    if (step !== 5 || !f.segmentIds.length || (!internal && !f.requirementId) || !f.templateId) { setCheck(null); return undefined; }
    setCheckBusy(true);
    const t = setTimeout(() => { api.post('/outreach/campaigns/check', { ...base, when: f.when, at: f.when === 'at' ? istToIso(f.at) : undefined }).then((r) => { setCheck(r.data); setCheckErr(''); }).catch((e) => { setCheck(null); setCheckErr(errOf(e, 'We could not check this campaign. Please try again.')); }).finally(() => setCheckBusy(false)); }, 200);
    return () => clearTimeout(t);
  }, [step, base, f.when, whenKey, f.segmentIds.length, f.requirementId, f.templateId, internal]); // eslint-disable-line react-hooks/exhaustive-deps
  const canNext = [
    internal ? true : !!f.requirementId,
    f.segmentIds.length > 0,
    true,
    !!f.templateId && !planErr,
    f.when === 'now' || (f.when === 'at' && !!f.at),
  ][step];
  const atIso = f.when === 'at' ? istToIso(f.at) : null;
  const payload = { ...base, name: f.name.trim() || undefined, kind: internal ? undefined : f.kind };
  const sendTest = async () => {
    setTestBusy(true); setTest(null);
    try { const r = await api.post('/outreach/campaigns/test-send', { type: kind, requirementId: base.requirementId, templateId: f.templateId }); setTest({ ok: true, text: r.data.words }); } catch (e) { setTest({ ok: false, text: errOf(e, 'The test could not be sent.') }); } finally { setTestBusy(false); }
  };
  const create = async (andSend) => {
    setBusy(true); setErr('');
    let id = null;
    try {
      const c = await api.post('/outreach/campaigns', payload); id = c.data.id;
      if (!andSend) { onDone(id, 'Saved for later. Open it any time to send.'); return; }
      const s = await api.post(`/outreach/campaigns/${id}/send`, f.when === 'at' ? { when: 'at', at: atIso } : { when: 'now' });
      onDone(id, (s.data.quietNote ? s.data.quietNote + ' ' : '') + (s.data.mode === 'rehearsal' ? `Rehearsal started: ${plural(s.data.queued, 'person', 'people')} in the queue, nothing will really be sent.` : (f.when === 'at' ? `Scheduled. ${plural(s.data.queued, 'person', 'people')} will get it.` : `Sending started for ${plural(s.data.queued, 'person', 'people')}.`)));
    } catch (e) {
      if (id) onDone(id, `Saved for later, but it was not sent: ${errOf(e, 'please try again')}`);
      else setErr(errOf(e, 'The campaign could not be saved.'));
    } finally { setBusy(false); }
  };
  const tpl = (tpls || []).find((t) => t.id === f.templateId);
  const grpNames = (groups || []).filter((g) => f.segmentIds.includes(g.id)).map((g) => g.name);
  const goText = plan && plan.testMode ? 'Start the rehearsal' : (f.when === 'at' ? 'Schedule it' : 'Send now');

  return (
    <Modal title={internal ? 'New message to staff' : 'New campaign'} size="xwide" onClose={onClose}
      foot={(
        <>
          {step > 0 && <button type="button" className="btn" onClick={() => setStep(step - 1)}>Back</button>}
          {step === 5 && <button type="button" className="btn" disabled={busy} onClick={() => create(false)}>Save for later</button>}
          {step < 5 ? <button type="button" className="btn btn-primary" disabled={!canNext} onClick={() => setStep(step + 1)}>Next</button>
            : <button type="button" className="btn btn-primary" disabled={busy || !plan || plan.willGet < 1 || checkBusy || !check || check.blocked} title={check && check.blocked ? 'Fix the red lines in "Check before sending" first' : undefined} onClick={() => create(true)}>{busy ? 'Working…' : goText}</button>}
        </>
      )}>
      <div className="occ-steps" aria-label="Steps">{STEPS.map((s, i) => <div key={s} className={i === step ? 'on' : (i < step ? 'done' : '')}>{i + 1}. {s}</div>)}</div>

      {step === 0 && (internal ? (
        <div>
          <p>This is a message to your own staff. It never has an apply link and is never counted in requirement reports.</p>
          <label className="field"><span>Name (so you can find it later)</span><input value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Reminder for the team" /></label>
        </div>
      ) : (
        <div>
          <div className="field"><span>{group === 'promotion' ? 'What kind of promotion' : 'What kind of campaign'}</span><Combo value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{(group === 'promotion' ? PROMOTION_KINDS : CAMPAIGN_KINDS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Combo></div>
          <b>Which requirement do you want to promote?</b>
          <div className="oc-bar"><input type="search" value={jq} onChange={(e) => setJq(e.target.value)} placeholder="Type to search your requirements" aria-label="Search requirements" /></div>
          {!jobs && <div className="oc-note">Loading…</div>}
          {jobs && jobs.length === 0 && <div className="oc-empty"><b>No open requirements found.</b><div>Only open requirements in your own area can be promoted.</div></div>}
          <div className="occ-pick">
            {(jobs || []).map((j) => (
              <button type="button" key={j.id} className={f.requirementId === j.id ? 'on' : ''} onClick={() => setF({ ...f, requirementId: j.id, jobTitle: j.title })}>
                {j.title}
                <small>{[j.reqCode, j.department, j.location].filter(Boolean).join(' · ')}{!j.onPortal ? ' · not on the Job Portal yet' : ''}</small>
              </button>
            ))}
          </div>
          <div className="oc-note">The message never shows the client's name.</div>
        </div>
      ))}

      {step === 1 && (
        <div>
          <b>Who should get it?</b>
          <div className="field" style={{ marginTop: 6 }}>
            <MultiPick options={(groups || []).map((g) => ({ value: g.id, label: g.name, sub: g.counts && g.counts.emptyRule ? 'No rule, so nobody is in it' : `${g.counts ? g.counts.total : 0} people · ${g.counts ? g.counts.reachable.email : 0} can get email` }))} value={f.segmentIds} onChange={(v) => setF({ ...f, segmentIds: v })}
              placeholder="Pick one or more groups" emptyText={groups ? (internal ? 'You have no groups yet. Make one in the Groups tab.' : 'You have no audiences yet. Make one in the Audiences tab.') : 'Loading…'} loading={!groups} />
          </div>
          {planErr && <div className="bc-err" role="alert">{planErr}</div>}
          {f.segmentIds.length > 0 && <PlanBox plan={plan} loading={planBusy} />}
        </div>
      )}

      {step === 2 && (
        <div>
          <b>Which way?</b>
          <div className="occ-way">
            <button type="button" className="on">Email<small>Ready now</small></button>
            <button type="button" disabled>WhatsApp<small>Coming later</small></button>
            <button type="button" disabled>SMS<small>Coming later</small></button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="oc-split">
          <div>
            <b>Which message?</b>
            <div className="field" style={{ marginTop: 6 }}>
              <Combo value={f.templateId} onChange={(e) => setF({ ...f, templateId: e.target.value })}>
                <option value="">Pick a message</option>
                {(tpls || []).filter((t) => t.ready).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Combo>
            </div>
            {tpls && tpls.length === 0 && <div className="bc-warn" role="status">You have no email messages yet. Write one in the Templates tab first.</div>}
            <div className="oc-note">{internal ? 'It must have {{unsubscribe}} so people can stop it.' : 'It must have {{apply_link}} (their own tracked link) and {{unsubscribe}} (how to stop it).'}</div>
            {planErr && <div className="bc-err" role="alert">{planErr}</div>}
          </div>
          <div>
            <b>How it looks (a sample person)</b>
            <div className="oc-prev" style={{ marginTop: 6 }}>
              {plan && plan.preview && f.templateId ? <><div style={{ fontWeight: 700, marginBottom: 6 }}>{plan.preview.subject}</div>{plan.preview.body}</> : 'Pick a message to see it.'}
            </div>
          </div>
        </div>
      )}

      {step === 4 && (
        <div>
          <b>When?</b>
          <When value={f} onChange={(v) => setF({ ...f, when: v.when, at: v.at })} />
          <div className="oc-card" style={{ marginTop: 10 }}>
            <b>Send a small test to myself first</b>
            <div className="oc-note">One test email goes to your own address only, never to anyone on the list.</div>
            <div className="oc-row2"><button type="button" className="btn btn-sm" disabled={testBusy} onClick={sendTest}>{testBusy ? 'Sending…' : 'Send a test to me'}</button></div>
            {test && <div className={test.ok ? 'bc-ok' : 'bc-err'} role="status">{test.text}</div>}
          </div>
        </div>
      )}

      {step === 5 && (
        <div>
          <Banner testMode={plan ? plan.testMode : null} sendingOn={plan ? plan.sendingOn : null} />
          <div className="occ-sum">
            <b>What for</b><span>{internal ? 'A message to staff' : `Promote the requirement "${f.jobTitle}"`}</span>
            <b>Who</b><span>{grpNames.join(', ') || '-'}</span>
            <b>Which way</b><span>Email</span>
            <b>Message</b><span>{tpl ? tpl.name : '-'}</span>
            <b>When</b><span>{f.when === 'now' ? 'Right away' : `${fmt(atIso)} (India time)`}</span>
          </div>
          <PlanBox plan={plan} loading={planBusy} />
          <CheckBox check={check} busy={checkBusy} err={checkErr} />
          {!internal && <label className="field"><span>Name (so you can find it later)</span><input value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={f.jobTitle} /></label>}
          {plan && plan.willGet < 1 && <div className="bc-warn" role="status">Nobody would get this message, so there is nothing to send. Go back and pick other groups.</div>}
        </div>
      )}
      {err && <div className="bc-err" role="alert">{err}</div>}
    </Modal>
  );
}

// ---- one campaign ----------------------------------------------------------------------------------------------------------------------------
function Detail({ id, acc, onClose, onChanged }) {
  const [d, setD] = useState(null);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [when, setWhen] = useState({ when: 'now', at: '' });
  const [sending, setSending] = useState(false);
  const timer = useRef(null);
  const load = useCallback(() => {
    api.get(`/outreach/campaigns/${id}`).then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'The campaign could not be opened.')));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  const live = d && ['running', 'scheduled', 'preparing'].includes(d.campaign.status);
  useEffect(() => { if (!live) return undefined; timer.current = setTimeout(load, 5000); return () => clearTimeout(timer.current); }, [d, live]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = () => { load(); if (onChanged) onChanged(); };
  const sendDraft = async () => {
    setSending(true); setErr('');
    try { const r = await api.post(`/outreach/campaigns/${id}/send`, when.when === 'at' ? { when: 'at', at: istToIso(when.at) } : { when: 'now' }); setMsg((r.data.quietNote ? r.data.quietNote + ' ' : '') + (r.data.mode === 'rehearsal' ? 'Rehearsal started. Nothing will really be sent.' : 'Sending started.')); changed(); } catch (e) { setErr(errOf(e, 'It could not be sent.')); } finally { setSending(false); }
  };
  const delDraft = async () => { if (!window.confirm('Delete this campaign? It was never sent.')) return; try { await api.delete(`/outreach/campaigns/${id}`); if (onChanged) onChanged(); onClose(); } catch (e) { setErr(errOf(e, 'It could not be deleted.')); } };
  if (!d) return <Modal title="Campaign" size="xwide" onClose={onClose}>{err ? <div className="bc-err" role="alert">{err}</div> : <div className="oc-note">Loading…</div>}</Modal>;
  const c = d.campaign; const k = d.counts; const fn = d.funnel; const rehearsal = c.mode === 'rehearsal';
  const hasButtons = d.can.pause || d.can.resume || d.can.stop || d.can.send || d.can.remove;
  return (
    <Modal title={c.name} size="xwide" onClose={onClose}>
      <div className="occ-top">
        <div><StatusChip tone={TONE[c.status]}>{c.statusWords}</StatusChip> {c.job && <span className="occ-meta">Requirement: {c.job.title}</span>} {c.type === 'internal' && <span className="occ-meta">Message to staff</span>}</div>
        <div className="occ-meta">{c.scheduledAt && c.status === 'scheduled' ? `Starts ${fmt(c.scheduledAt)}` : (c.startedAt ? `Started ${fmt(c.startedAt)}` : `Made by ${c.createdByName || 'someone'}`)}{c.completedAt ? ` · finished ${fmt(c.completedAt)}` : ''}</div>
      </div>
      <Banner rehearsal={c.mode ? rehearsal : null} testMode={!c.mode ? d.notes.testMode : false} sendingOn={null} />
      <StopBanner health={d.health} acc={acc} onClose={onClose} />
      {msg && <div className="bc-ok" role="status">{msg}</div>}
      {err && <div className="bc-err" role="alert">{err}</div>}
      {hasButtons && (
        <div style={{ margin: '8px 0' }}>
          {d.can.send && (
            <div className="oc-card">
              <b>This one is not sent yet. When should it go?</b>
              <When value={when} onChange={setWhen} />
              <div className="occ-btns"><button type="button" className="btn btn-primary" disabled={sending || (when.when === 'at' && !when.at)} onClick={sendDraft}>{sending ? 'Working…' : (d.notes.testMode ? 'Start the rehearsal' : (when.when === 'at' ? 'Schedule it' : 'Send now'))}</button>{d.can.remove && <button type="button" className="btn" onClick={delDraft}>Delete</button>}</div>
            </div>
          )}
          {!d.can.send && <Controls id={id} can={d.can} onDone={changed} onMsg={setMsg} onErr={setErr} />}
        </div>
      )}
      {!hasButtons && <div className="oc-note">You can look at this campaign. Only the person who runs it can pause or stop it.</div>}

      <div className="bc-tiles" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
        <div className="bc-tile blue"><div className="n">{k.waiting}</div><div className="l">Waiting to send</div></div>
        <div className="bc-tile green"><div className="n">{k.sent}</div><div className="l">{rehearsal ? 'Rehearsed' : 'Sent'}</div></div>
        <div className="bc-tile green"><div className="n">{k.delivered}</div><div className="l">Delivered</div></div>
        <div className="bc-tile green"><div className="n">{k.clicked}</div><div className="l">Opened the link</div></div>
        <div className="bc-tile green"><div className="n">{k.applied}</div><div className="l">Applied</div>{!k.applied && <div className="p">after Phase 4</div>}</div>
        <div className="bc-tile red"><div className="n">{k.failed}</div><div className="l">Failed</div></div>
        <div className="bc-tile orange"><div className="n">{k.skipped}</div><div className="l">Skipped</div></div>
        <div className="bc-tile"><div className="n">{k.total}</div><div className="l">People in total</div></div>
      </div>
      {k.total === 0 && <div className="oc-note">Nobody is in this campaign yet. People are added when you press Send.</div>}

      {c.type !== 'internal' && (
        <div>
          <div className="oc-note">How far people got</div>
          <div className="occ-funnel">
            <div className="occ-fn"><div className="n">{fn.sent}</div><div className="l">{rehearsal ? 'Rehearsed' : 'Sent'}</div></div><span className="occ-arrow">›</span>
            <div className="occ-fn"><div className="n">{fn.delivered}</div><div className="l">Delivered</div></div><span className="occ-arrow">›</span>
            <div className="occ-fn"><div className="n">{fn.clicked}</div><div className="l">Clicked</div></div><span className="occ-arrow">›</span>
            <div className="occ-fn later"><div className="n">{fn.applied || 'after Phase 4'}</div><div className="l">Applied</div></div>
            <div className="occ-fn later"><div className="n">after Phase 4</div><div className="l">AI interview</div></div>
            <div className="occ-fn later"><div className="n">after Phase 4</div><div className="l">Qualified</div></div>
          </div>
          {!rehearsal && !fn.delivered && fn.sent > 0 && <div className="oc-note">"Delivered" appears when the mail provider tells us (the delivery report).</div>}
        </div>
      )}

      {d.reasons.length > 0 && (
        <div>
          <div className="oc-note" style={{ marginTop: 8 }}>Why some people were left out (press one to see who)</div>
          <div className="oc-choice">
            {d.reasons.map((r) => <button type="button" key={r.reason} className={reason === r.reason ? 'on' : ''} onClick={() => setReason(reason === r.reason ? '' : r.reason)}>{r.words}: {r.n}</button>)}
          </div>
        </div>
      )}

      <div className="oc-note" style={{ marginTop: 10 }}><b>Every message of this campaign</b></div>
      <MessageLog campaignId={id} reason={reason} onClearReason={() => setReason('')} refreshMs={live ? 5000 : 0} />
    </Modal>
  );
}

// ---- Admin: sending settings ----------------------------------------------------------------------------------------------------------------
export function SendingSettings({ onChanged }) {
  const [s, setS] = useState(null);
  const [days, setDays] = useState('');
  const [perMin, setPerMin] = useState('');
  const [show, setShow] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(() => api.get('/outreach/sending').then((r) => { setS(r.data); setDays(String(r.data.settings.suppressDays)); setPerMin(String(r.data.settings.emailPerMinute)); }).catch((e) => setErr(errOf(e, 'The settings could not be loaded.'))), []);
  useEffect(() => { load(); }, [load]);
  const save = async (patch, word) => { setErr(''); setMsg(''); try { await api.put('/outreach/settings', patch); setMsg(word || 'Saved.'); await load(); if (onChanged) onChanged(); } catch (e) { setErr(errOf(e, 'It was not saved.')); } };
  const tick = async () => { setErr(''); setMsg(''); try { const r = await api.post('/outreach/runner/tick', {}); const x = r.data.result; if (x.quiet) { setMsg(`Nothing was sent: waiting for quiet hours to end (${x.quiet.endLabel}).`); if (onChanged) onChanged(); return; } setMsg(`Done. ${(x.sent || 0) + (x.test_captured || 0)} handled, ${x.skipped || 0} skipped, ${x.failed || 0} failed.`); if (onChanged) onChanged(); } catch (e) { setErr(errOf(e, 'It did not run.')); } };
  if (!s) return <div className="occ-set">{err ? <div className="bc-err" role="alert">{err}</div> : 'Loading…'}</div>;
  const st = s.settings;
  return (
    <div className="occ-set">
      <b>Sending settings (Admin)</b>
      <div className="oc-row2">
        <StatusChip tone={st.master ? 'green' : 'grey'}>{st.master ? 'Outreach sending is ON' : 'Outreach sending is OFF'}</StatusChip>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => save({ master: !st.master }, st.master ? 'Sending is OFF. Nothing will go out.' : 'Sending is ON.')}>{st.master ? 'Switch OFF' : 'Switch ON'}</button>
        <button type="button" className="btn btn-sm" disabled={!st.master} onClick={tick}>Send now (one round)</button>
      </div>
      <div className="oc-note">{st.emailTestMode ? 'Email is in TEST MODE: every send is a rehearsal. Change it in Settings > Channels.' : 'Email is LIVE: real people get real emails.'} The daily limit is {st.emailDailyCap} emails (Settings > Channels).</div>
      <div className="oc-row2">
        <label className="field" style={{ margin: 0 }}><span>Do not message the same person about the same requirement again for (days)</span><input type="number" min="0" max="365" value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 90 }} /></label>
        <button type="button" className="btn btn-sm" onClick={() => save({ suppressDays: Number(days) })}>Save</button>
      </div>
      <div className="oc-row2">
        <label className="field" style={{ margin: 0 }}><span>Emails per minute</span><input type="number" min="1" max="600" value={perMin} onChange={(e) => setPerMin(e.target.value)} style={{ width: 90 }} /></label>
        <button type="button" className="btn btn-sm" onClick={() => save({ emailPerMinute: Number(perMin) })}>Save</button>
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={st.internalHrMaySend} onChange={(e) => save({ internalHrMaySend: e.target.checked })} /> Internal HR may send messages to staff</label>
      <div>
        <button type="button" className="btn btn-sm" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'} the delivery-report address</button>
        {show && <div style={{ marginTop: 6 }}><div className="oc-note">The mail provider posts delivery, bounce and spam reports here (signed):</div><div className="occ-code">POST {s.webhook.path}</div><div className="oc-note">{s.webhook.note}</div><div className="oc-note">Secret:</div><div className="occ-code">{s.webhook.secret}</div></div>}
      </div>
      {msg && <div className="bc-ok" role="status">{msg}</div>}
      {err && <div className="bc-err" role="alert">{err}</div>}
    </div>
  );
}

// ---- the tab ----------------------------------------------------------------------------------------------------------------------------------------
export default function Campaigns({ acc, type = 'candidate_lead', group = '' }) {
  const internal = type === 'internal';
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [status, setStatus] = useState('');
  const [tab, setTab] = useState(''); // Active / Scheduled / Not sent yet / Completed
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [wiz, setWiz] = useState(false);
  const [open, setOpen] = useState(null);
  const [settings, setSettings] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const timer = useRef(null);
  const canCreate = internal ? acc.canCampaignInternal : acc.canCampaign;
  const load = useCallback(() => api.get('/outreach/campaigns', { params: { type: internal ? 'internal' : 'job_promotion', group: !internal && group ? group : undefined, tab: tab || undefined, status: status || undefined, q: q || undefined, page, pageSize: 20 } })
    .then((r) => { setData(r.data); setErr(''); }).catch((e) => { setErr(errOf(e, 'The campaigns could not be loaded.')); setData((d) => d || { campaigns: [], total: 0, facets: {} }); }), [internal, status, tab, group, q, page]);
  useEffect(() => { load(); }, [load]);
  const live = data && data.campaigns.some((c) => ['running', 'scheduled', 'preparing'].includes(c.status));
  useEffect(() => { if (!live) return undefined; timer.current = setTimeout(load, 5000); return () => clearTimeout(timer.current); }, [data, live]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!acc.campaignsReady) return <div className="bc-warn" role="status">Campaigns are being set up. They will open in a little while.</div>;
  const facets = data ? data.facets : {};
  const pages = data ? Math.max(1, Math.ceil(data.total / (data.pageSize || 20))) : 1;
  const done = (id, text) => { setWiz(false); if (text) setMsg(text); load(); if (id) setOpen(id); };
  return (
    <div>
      <div className="oc-bar">
        {canCreate && <button type="button" className="btn btn-primary" onClick={() => { setMsg(''); setWiz(true); }}>{internal ? 'New message to staff' : 'New campaign'}</button>}
        <button type="button" className="btn" onClick={() => setShowLog(!showLog)}>{showLog ? 'Hide the message log' : 'Message log'}</button>
        {acc.isAdmin && !internal && <button type="button" className="btn" onClick={() => setSettings(!settings)}>{settings ? 'Hide sending settings' : 'Sending settings'}</button>}
        <span className="oc-note">{internal ? 'Messages to your own staff. No apply links, never counted in requirement reports.' : 'Promote a requirement to your groups by email. Every message has its own apply link and a way to stop.'}</span>
      </div>
      {settings && acc.isAdmin && <SendingSettings onChanged={load} />}
      {data && <Banner testMode={data.testMode} sendingOn={data.campaigns.length === 0 ? data.sendingOn : null} />}
      {showLog && <div className="occ-logpanel"><b>Message log: every message of every campaign you may see</b><MessageLog refreshMs={0} /></div>}
      {msg && <div className="bc-ok" role="status">{msg}</div>}
      {err && <div className="bc-err" role="alert">{err}</div>}
      <div className="oc-bar">
        <input type="search" value={q} onChange={(e) => { setPage(1); setQ(e.target.value); }} placeholder="Search by campaign or requirement name" aria-label="Search campaigns" />
      </div>
      <div className="oc-choice" role="group" aria-label="Show">
        {[['', 'All'], ['active', 'Active'], ['scheduled', 'Scheduled'], ['notsent', 'Not sent yet'], ['completed', 'Completed']].map(([v, l]) => <button type="button" key={v || 'all'} className={tab === v ? 'on' : ''} aria-pressed={tab === v} onClick={() => { setPage(1); setTab(v); }}>{l}{v && data && data.tabs ? ` (${data.tabs[v] || 0})` : ''}</button>)}
      </div>
      {!data && <div className="oc-note">Loading…</div>}
      {data && data.campaigns.length === 0 && !err && (
        <div className="oc-empty"><b>{status || q ? 'No campaigns match.' : 'No campaigns yet.'}</b><div>{canCreate && !status && !q ? `Press "${internal ? 'New message to staff' : 'New campaign'}" to make the first one.` : 'Campaigns will show here.'}</div></div>
      )}
      <div className="occ-list">
        {(data ? data.campaigns : []).map((c) => (
          <div className="occ-card" key={c.id}>
            <div className="occ-top">
              <h4>{c.name}</h4>
              <StatusChip tone={TONE[c.status]}>{c.statusWords}</StatusChip>
            </div>
            <div className="occ-meta">{c.kindWords} · {c.job ? `Requirement: ${c.job.title}` : 'Message to staff'} · by {c.createdByName || 'someone'} · {fmt(c.scheduledAt && c.status === 'scheduled' ? c.scheduledAt : c.createdAt)}{c.mode === 'rehearsal' ? ' · rehearsal' : ''}</div>
            <Mini c={c.counts} rehearsal={c.mode === 'rehearsal'} />
            <StopBanner health={c.health} acc={acc} compact onSettings={() => setSettings(true)} />
            <div className="occ-btns">
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setOpen(c.id)}>{c.can.send ? 'Open and send' : 'See who got it'}</button>
              <Controls id={c.id} can={c.can} onDone={load} onMsg={setMsg} onErr={setErr} />
            </div>
          </div>
        ))}
      </div>
      {data && pages > 1 && <div className="oc-bar"><button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Back</button><span className="oc-note">Page {page} of {pages}</span><button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button></div>}
      {wiz && <Wizard type={type} acc={acc} group={group} onClose={() => setWiz(false)} onDone={done} />}
      {open && <Detail id={open} acc={acc} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}
