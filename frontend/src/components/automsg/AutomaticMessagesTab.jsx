import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { Modal } from '../proto.jsx';
import ScheduledMessages, { clock } from './ScheduledMessages.jsx';
import './autoMsg.css';
import Combo from '../Combo.jsx';

// ---------------------------------------------------------------------------
// ADMINISTRATION -> COMPANY SETUP -> MESSAGE TEMPLATES -> AUTOMATIC MESSAGES
//
// "Every time a candidate moves to the next step, send them a message by itself."
//   one row per step: ON / OFF, how it is sent, when, and in whose words
//   (the template, or AI). A live example with a REAL person before you save.
//   Below: every message the app planned (see it before it goes), the jobs and
//   people with their own setting, and who changed what.
//
// Nothing changes until someone saves: the steps start as they always worked.
// Super Admin, Admin and HR change things; everybody else looks.
// ---------------------------------------------------------------------------

const WHEN_LABEL = { now: 'Right away', delay: 'After some minutes', working: 'Next working hour (09:00 IST)', approval: 'Wait for the recruiter to say OK first' };
const WHEN_HELP = {
  now: 'The moment the person moves.',
  delay: 'Gives you time to move them back if it was a slip.',
  working: 'Inside working time (09:00 to 21:00, Monday to Saturday) it goes at once. At night or on Sunday it waits for 09:00.',
  approval: 'The message waits on the person\'s page. The recruiter reads it and presses Approve & send.',
};
const LANG_LABEL = { Auto: 'The person\'s own language', English: 'English', Telugu: 'Telugu', Hindi: 'Hindi' };
const cap = (s) => s;

function whenText(w) {
  if (!w) return '';
  if (w.mode === 'delay') return `After ${w.minutes} minute${w.minutes === 1 ? '' : 's'}`;
  return WHEN_LABEL[w.mode] || '';
}
function summary(rule) {
  if (!rule.on) return <span className="am-dim">Off: nothing is sent when someone reaches this step.</span>;
  const ch = rule.channels.length ? rule.channels.join(rule.strategy === 'all' ? ' + ' : ' then ') : 'no way to send';
  return (
    <>
      <b>{ch}</b>
      {rule.strategy === 'first' && rule.channels.length > 1 ? <span className="am-dim"> (the first that works)</span> : null}
      {' · '}{whenText(rule.when)}{' · '}{rule.wording === 'AI' ? 'AI writes it' : 'Template words'}
    </>
  );
}

// ============================ the rule editor ================================
function RuleEditor({ item, data, canManage, onClose, onSaved }) {
  const stage = item.stage;
  const [d, setD] = useState(() => JSON.parse(JSON.stringify(item.rule)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [people, setPeople] = useState([]);
  const [sample, setSample] = useState('');
  const [pv, setPv] = useState(null);
  const [pvBusy, setPvBusy] = useState(false);
  const [aiShow, setAiShow] = useState(false);
  const timer = useRef(null);
  const chanInfo = useMemo(() => Object.fromEntries(data.channels.map((c) => [c.channel, c])), [data.channels]);
  const upd = (patch) => setD((x) => ({ ...x, ...patch }));
  const dis = !canManage;

  useEffect(() => {
    api.get('/auto-messages/samples', { params: { stage } }).then((r) => { setPeople(r.data.rows); if (r.data.rows[0]) setSample(r.data.rows[0].applicationId); }).catch(() => {});
  }, [stage]);

  const runPreview = useCallback((useAi) => {
    setPvBusy(true);
    api.post('/auto-messages/preview', {
      stage, applicationId: sample || undefined, useAi: !!useAi,
      rule: {
        channels: d.channels, wording: d.wording, instruction: d.instruction, templatePurpose: d.templatePurpose, language: d.language,
      },
    }).then((r) => setPv(r.data)).catch((e) => setPv({ error: e.response?.data?.error || 'Could not show an example.' })).finally(() => setPvBusy(false));
  }, [stage, sample, d.channels, d.wording, d.instruction, d.templatePurpose, d.language]);
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => runPreview(aiShow), 350);
    return () => clearTimeout(timer.current);
  }, [runPreview, aiShow]);

  const ticked = d.channels;
  const order = [...ticked, ...['Email', 'WhatsApp', 'SMS'].filter((c) => !ticked.includes(c))];
  const toggleChan = (c) => {
    if (ticked.includes(c)) upd({ channels: ticked.filter((x) => x !== c) });
    else upd({ channels: [...ticked, c] });
  };
  const move = (c, dir) => {
    const i = ticked.indexOf(c); const j = i + dir;
    if (i < 0 || j < 0 || j >= ticked.length) return;
    const n = [...ticked]; [n[i], n[j]] = [n[j], n[i]]; upd({ channels: n });
  };
  const aiOk = data.ai.available;

  async function save() {
    setBusy(true); setErr('');
    try {
      const body = { rules: { [stage]: d } };
      const r = await api.put('/auto-messages/rules', body);
      onSaved(r.data.message || 'Saved.');
    } catch (e) { setErr(e.response?.data?.error || 'Could not save.'); } finally { setBusy(false); }
  }

  return (
    <Modal
      wide
      title={`When someone reaches: ${item.label}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>{canManage ? 'Close without saving' : 'Close'}</button>
          {canManage && <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save this step'}</button>}
        </>
      )}
    >
      {!canManage && <div className="msg-box blue">You can look at this step. A Super Admin, Admin or HR changes it.</div>}
      {err && <div className="msg-box red" role="alert">{err}</div>}

      <div className="am-card">
        <h3>1. Send a message at this step?</h3>
        <div className="am-choices">
          <button type="button" disabled={dis} className={`am-choice${d.on ? ' on' : ''}`} onClick={() => upd({ on: true })}><span className="am-dot" /><span><b>Yes, send one</b></span></button>
          <button type="button" disabled={dis} className={`am-choice${!d.on ? ' on' : ''}`} onClick={() => upd({ on: false })}><span className="am-dot" /><span><b>No, send nothing</b></span></button>
        </div>
      </div>

      {d.on && (
        <>
          <div className="am-card">
            <h3>2. How should it be sent?</h3>
            {order.map((c) => {
              const info = chanInfo[c] || {};
              const on = ticked.includes(c);
              const i = ticked.indexOf(c);
              return (
                <div key={c} className={`am-chan${on ? '' : ' off'}`}>
                  <button type="button" disabled={dis || (!on && !info.connected)} className={`am-switch${on ? ' on' : ''}`} onClick={() => toggleChan(c)} aria-pressed={on} aria-label={`Send by ${c}`}>
                    <span className="am-track" />
                  </button>
                  <span className="am-cname">{on ? `${i + 1}. ` : ''}{c}</span>
                  <span className="am-cnote">
                    {info.connected ? `Connected. ${info.freeText || ''}` : (info.todo || 'Not connected.')}
                    {!info.connected && on ? ' It stays ticked, but nothing can go this way until it is connected.' : ''}
                  </span>
                  {on && canManage && ticked.length > 1 && (
                    <span style={{ display: 'flex', gap: 6 }}>
                      <button type="button" className="btn btn-sm" disabled={i === 0} onClick={() => move(c, -1)} aria-label={`Move ${c} earlier`}>Earlier</button>
                      <button type="button" className="btn btn-sm" disabled={i === ticked.length - 1} onClick={() => move(c, 1)} aria-label={`Move ${c} later`}>Later</button>
                    </span>
                  )}
                </div>
              );
            })}
            {ticked.length > 1 && (
              <div className="am-choices" style={{ marginTop: 8 }}>
                <button type="button" disabled={dis} className={`am-choice${d.strategy === 'all' ? ' on' : ''}`} onClick={() => upd({ strategy: 'all' })}><span className="am-dot" /><span><b>Send on every ticked way</b><small>This is how it works today.</small></span></button>
                <button type="button" disabled={dis} className={`am-choice${d.strategy === 'first' ? ' on' : ''}`} onClick={() => upd({ strategy: 'first' })}><span className="am-dot" /><span><b>Try them in this order, stop at the first that works</b><small>If the first way is not possible (not connected, no number, they said STOP), the next one is used. The log says why.</small></span></button>
              </div>
            )}
          </div>

          <div className="am-card">
            <h3>3. When should it go?</h3>
            <div className="am-choices">
              {['now', 'delay', 'working', 'approval'].map((m) => (
                <button key={m} type="button" disabled={dis} className={`am-choice${d.when.mode === m ? ' on' : ''}`} onClick={() => upd({ when: { mode: m, minutes: m === 'delay' ? (d.when.minutes || 30) : 0 } })}>
                  <span className="am-dot" />
                  <span><b>{WHEN_LABEL[m]}</b><small>{WHEN_HELP[m]}</small></span>
                </button>
              ))}
            </div>
            {d.when.mode === 'delay' && (
              <div className="am-field" style={{ marginTop: 8, maxWidth: 220 }}>
                <label htmlFor="am-min">Wait how many minutes?</label>
                <input id="am-min" type="number" min={1} max={10080} disabled={dis} value={d.when.minutes} onChange={(e) => upd({ when: { mode: 'delay', minutes: Number(e.target.value) || 0 } })} />
              </div>
            )}
            <div className="am-help" style={{ marginTop: 8 }}>
              Quiet hours ({data.settings.quiet.enabled ? `${data.settings.quiet.from} to ${data.settings.quiet.to}` : 'switched off'}) hold a message until morning, except time-critical ones.
            </div>
            <label className="am-help" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
              <input type="checkbox" disabled={dis} checked={!!d.urgent} onChange={(e) => upd({ urgent: e.target.checked })} />
              This message cannot wait: send it even in quiet hours (for example an interview time).
            </label>
          </div>

          <div className="am-card">
            <h3>4. Whose words?</h3>
            <div className="am-choices">
              <button type="button" disabled={dis} className={`am-choice${d.wording === 'TEMPLATE' ? ' on' : ''}`} onClick={() => upd({ wording: 'TEMPLATE' })}>
                <span className="am-dot" />
                <span><b>Use the template</b><small>The words you wrote in the Templates tab. Same words for everyone, with the name, job and time filled in.</small></span>
              </button>
              <button type="button" disabled={dis || !aiOk} className={`am-choice${d.wording === 'AI' ? ' on' : ''}`} onClick={() => upd({ wording: 'AI' })}>
                <span className="am-dot" />
                <span>
                  <b>AI writes it</b>
                  <small>
                    {aiOk
                      ? 'The AI writes each message from the real facts only (name, job, time, recruiter). A safety check removes anything invented. Email only; WhatsApp and SMS keep their approved templates. If the AI fails, the template is used.'
                      : `Not available yet: ${String(data.ai.reason || 'no AI is connected').replace(/[.s]+$/, '')}. An Admin connects an AI in Administration > Integrations. Until then the template is used.`}
                  </small>
                </span>
              </button>
            </div>
            {d.wording === 'AI' && (
              <div className="am-field" style={{ marginTop: 8 }}>
                <label htmlFor="am-ins">A short instruction for the AI (optional)</label>
                <textarea id="am-ins" rows={2} maxLength={300} disabled={dis} value={d.instruction} onChange={(e) => upd({ instruction: e.target.value })} placeholder="For example: tone: friendly, short, include the interview time" />
                <div className="am-help">It can never make the AI invent facts, promise pay, or name the client.</div>
              </div>
            )}
            <div className="am-grid2" style={{ marginTop: 10 }}>
              <div className="am-field">
                <label htmlFor="am-tpl">Which template</label>
                <Combo id="am-tpl" disabled={dis} value={d.templatePurpose || ''} onChange={(e) => upd({ templatePurpose: e.target.value || null })}>
                  <option value="">None yet: write one in the Templates tab</option>
                  {data.templates.map((t) => <option key={t.purpose} value={t.purpose}>{t.label}</option>)}
                </Combo>
                <div className="am-help">{d.templatePurpose ? <Link to="/admin/message-templates">Change the template words</Link> : 'This step has no template yet, so nothing can be sent until you pick or write one.'}</div>
              </div>
              <div className="am-field">
                <label>Language</label>
                <div className="am-choices">
                  {Object.keys(LANG_LABEL).map((l) => (
                    <button key={l} type="button" disabled={dis} className={`am-choice${d.language === l ? ' on' : ''}`} onClick={() => upd({ language: l })}><span className="am-dot" /><span>{LANG_LABEL[l]}</span></button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      <div className="am-card">
        <h3>See it before you save</h3>
        {people.length > 0 && (
          <div className="am-people" role="group" aria-label="Pick a real example">
            {people.map((p) => (
              <button key={p.applicationId} type="button" className={`am-fchip${sample === p.applicationId ? ' on' : ''}`} onClick={() => setSample(p.applicationId)}>
                {p.candidateName}<small>{p.stageLabel}</small>
              </button>
            ))}
          </div>
        )}
        {pvBusy && !pv && <div className="small-muted">Loading an example…</div>}
        {pv && pv.error && <div className="msg-box red">{pv.error}</div>}
        {pv && pv.empty && <div className="small-muted">{pv.note}</div>}
        {pv && pv.channels && (
          <>
            <div className="small-muted">A real example: {pv.candidateName}{pv.jobTitle ? `, ${pv.jobTitle}` : ''}. Nothing is sent from here.</div>
            {pv.channels.map((c) => (
              <div key={c.channel} className="am-preview">
                <div className="am-ptitle">{c.channel}{c.ready ? '' : ` · cannot go now: ${c.why}`}{c.aiWritten ? ' · AI-written' : ''}</div>
                {c.missing ? 'There is no template for this step yet.' : (
                  <>
                    {c.subject ? <b>{c.subject}{'\n'}</b> : null}
                    {c.body}
                  </>
                )}
                {c.aiNote ? <div className="am-help">{c.aiNote}</div> : null}
              </div>
            ))}
            {d.wording === 'AI' && aiOk && (
              <button type="button" className="btn btn-sm" onClick={() => { setAiShow(true); runPreview(true); }}>{aiShow ? 'Write it again with the AI' : 'Show how the AI would write it'}</button>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

// ============================ settings card ==================================
function SettingsCard({ data, canManage, onSaved }) {
  const s = data.settings;
  const [v, setV] = useState(() => JSON.parse(JSON.stringify({
    quiet: s.quiet, workStart: s.workStart, caps: s.caps, ai: s.ai, supersedeMinutes: s.supersedeMinutes, dupHours: s.dupHours, maxAgeHours: s.maxAgeHours, skipIfCalledToday: s.skipIfCalledToday,
  })));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const dis = !canManage;
  async function save() {
    setBusy(true); setErr('');
    try { const r = await api.put('/auto-messages/rules', v); onSaved(r.data.message); } catch (e) { setErr(e.response?.data?.error || 'Could not save.'); } finally { setBusy(false); }
  }
  const num = (path, label, help, min = 0, max = 100000) => {
    const get = path.split('.').reduce((o, k) => o[k], v);
    return (
      <div className="am-field">
        <label htmlFor={`am-${path}`}>{label}</label>
        <input id={`am-${path}`} type="number" min={min} max={max} disabled={dis} value={get} onChange={(e) => {
          const n = Number(e.target.value); setV((x) => { const y = JSON.parse(JSON.stringify(x)); const ks = path.split('.'); let o = y; ks.slice(0, -1).forEach((k) => { o = o[k]; }); o[ks[ks.length - 1]] = n; return y; });
        }}
        />
        {help && <div className="am-help">{help}</div>}
      </div>
    );
  };
  return (
    <details className="am-card">
      <summary><b>Safety limits</b> <span className="small-muted">quiet hours, daily limits, AI limit</span></summary>
      <div className="am-grid2" style={{ marginTop: 10 }}>
        <div className="am-field">
          <label>Quiet hours (India time)</label>
          <label className="am-help" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" disabled={dis} checked={v.quiet.enabled} onChange={(e) => setV({ ...v, quiet: { ...v.quiet, enabled: e.target.checked } })} /> Hold messages at night
          </label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="time" aria-label="Quiet hours start" disabled={dis || !v.quiet.enabled} value={v.quiet.from} onChange={(e) => setV({ ...v, quiet: { ...v.quiet, from: e.target.value } })} />
            <span>to</span>
            <input type="time" aria-label="Quiet hours end" disabled={dis || !v.quiet.enabled} value={v.quiet.to} onChange={(e) => setV({ ...v, quiet: { ...v.quiet, to: e.target.value } })} />
          </div>
          <div className="am-help">A message made at night waits and goes when quiet hours end. Time-critical steps are not held.</div>
        </div>
        <div className="am-field">
          <label htmlFor="am-ws">Working day starts</label>
          <input id="am-ws" type="time" disabled={dis} value={v.workStart} onChange={(e) => setV({ ...v, workStart: e.target.value })} />
          <div className="am-help">Used by &quot;Next working hour&quot;. Sunday is off.</div>
        </div>
        {num('caps.perCandidatePerDay', 'Most automatic messages one person gets in a day', 'More than this wait for tomorrow.', 1, 50)}
        {num('caps.perChannelPerDay.Email', 'Emails a day (automatic ones)', null, 1, 20000)}
        {num('caps.perChannelPerDay.WhatsApp', 'WhatsApp a day (automatic ones)', null, 1, 20000)}
        {num('caps.perChannelPerDay.SMS', 'SMS a day (automatic ones)', null, 1, 20000)}
        {num('ai.perDay', 'Messages the AI may write in a day', 'After this the template is used. 0 = the AI writes none.', 0, 5000)}
        {num('ai.timeoutSeconds', 'How long to wait for the AI (seconds)', 'If it is slower, the template is used.', 5, 120)}
        {num('supersedeMinutes', 'Cancel a waiting message if they move again within (minutes)', 'Protects against a slip of the mouse.', 0, 1440)}
        {num('dupHours', 'Do not send the same message twice within (hours)', null, 0, 720)}
        {num('maxAgeHours', 'Drop a message that could not go within (hours)', 'Late news is worse than none.', 1, 720)}
        <div className="am-field">
          <label className="am-help" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" disabled={dis} checked={v.skipIfCalledToday} onChange={(e) => setV({ ...v, skipIfCalledToday: e.target.checked })} />
            Skip the message if a recruiter already phoned the person today
          </label>
        </div>
      </div>
      {err && <div className="msg-box red">{err}</div>}
      {canManage && <button type="button" className="btn btn-primary" style={{ marginTop: 10 }} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save the limits'}</button>}
    </details>
  );
}

// ============================ the tab ========================================
export default function AutomaticMessagesTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [edit, setEdit] = useState(null);
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState('');
  const [hist, setHist] = useState([]);
  const [listKey, setListKey] = useState(0);

  const load = useCallback(() => api.get('/auto-messages/rules').then((r) => { setData(r.data); setError(''); }).catch((e) => setError(e.response?.data?.error || 'Could not load the automatic messages.')), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/auto-messages/history').then((r) => setHist(r.data.rows)).catch(() => {}); }, [data]);

  if (error) return <div className="msg-box red">{error}</div>;
  if (!data) return <div className="small-muted">Loading…</div>;
  const { canManage, settings } = data;

  async function put(body, key, okText) {
    setBusy(key); setFlash('');
    try {
      const r = await api.put('/auto-messages/rules', body);
      setFlash(okText || r.data.message || 'Saved.');
      await load(); setListKey((k) => k + 1);
    } catch (e) { setFlash(e.response?.data?.error || 'Could not save.'); } finally { setBusy(''); }
  }
  const toggle = (it) => put({ rules: { [it.stage]: { on: !it.rule.on } } }, it.stage);
  const started = data.started;

  return (
    <div className="am-tab">
      {!data.ready && <div className="msg-box orange">Automatic messages are being set up on this server. Messages keep going the old way until then.</div>}

      {data.ready && settings.killSwitch && (
        <div className="am-banner red" role="status">
          <div className="am-grow"><b>All automatic messages are stopped.</b> Nothing goes by itself. People who move now are listed below as &quot;not sent&quot;.</div>
          {canManage && <button type="button" className="btn btn-primary" disabled={busy === 'kill'} onClick={() => put({ killSwitch: false }, 'kill', 'Automatic messages are on again.')}>Turn them back on</button>}
        </div>
      )}
      {data.ready && !settings.killSwitch && !started && (
        <div className="am-banner blue">
          <div className="am-grow">
            <b>Not started yet.</b> Messages still go the old way: the moment someone moves, with the words from the Templates tab. The first time you save here, the new scheduler starts from that moment.
            <b> Nobody who moved earlier is ever messaged.</b>
          </div>
          {canManage && <button type="button" className="btn btn-primary" disabled={busy === 'start'} onClick={() => put({}, 'start')}>{busy === 'start' ? 'Starting…' : 'Start with today\'s settings'}</button>}
        </div>
      )}
      {data.ready && !settings.killSwitch && started && (
        <div className="am-banner green">
          <div className="am-grow"><b>Running</b> since {clock(settings.goLiveAt)}. Only people who move after that are messaged.</div>
          {canManage && <button type="button" className="btn" disabled={busy === 'kill'} onClick={() => { if (window.confirm('Stop ALL automatic messages for the whole company?')) put({ killSwitch: true }, 'kill', 'All automatic messages are stopped.'); }}>Stop all automatic messages</button>}
        </div>
      )}
      {flash && <div className="msg-box blue" role="status">{flash}</div>}
      {!canManage && <div className="small-muted" style={{ marginBottom: 8 }}>You can look at the steps. A Super Admin, Admin or HR changes them.</div>}

      <div className="section-label">Each step: should a message go, and how?</div>
      <div className="am-steps">
        {data.rules.map((it) => (
          <div key={it.stage} className={`am-step${it.rule.on ? '' : ' off'}`}>
            <div className="am-name">
              <b>{it.label}</b>
              {it.edited ? <span className="am-chip warn">Changed</span> : (it.sendsToday ? <span className="am-chip">As today</span> : null)}
              {it.rule.wording === 'AI' && it.rule.on ? <span className="am-chip ai">AI</span> : null}
            </div>
            <button type="button" className={`am-switch${it.rule.on ? ' on' : ''}`} disabled={!canManage || busy === it.stage} onClick={() => toggle(it)} aria-pressed={it.rule.on} aria-label={`Message at ${it.label}`}>
              <span className="am-track" /><span>{it.rule.on ? 'On' : 'Off'}</span>
            </button>
            <div className="am-sum">{summary(it.rule)}</div>
            <button type="button" className="btn btn-sm" onClick={() => setEdit(it)}>{canManage ? 'Edit' : 'Look'}</button>
          </div>
        ))}
      </div>

      <SettingsCard key={JSON.stringify(settings)} data={data} canManage={canManage} onSaved={(m) => { setFlash(m); load(); }} />

      <div className="section-label" style={{ marginTop: 18 }}>Messages planned and sent</div>
      <ScheduledMessages key={listKey} onChanged={load} />

      {(data.jobs.length > 0 || data.pausedPeople.length > 0) && (
        <>
          <div className="section-label" style={{ marginTop: 18 }}>Requirements and people with their own setting</div>
          <div className="am-card">
            {data.jobs.map((j) => (
              <div key={j.id} className="am-rmeta"><b>{j.title}</b>: {j.mode === 'off' ? 'no automatic messages' : 'the recruiter approves each message first'}{j.by ? ` (set by ${j.by})` : ''}</div>
            ))}
            {data.pausedPeople.map((p) => (
              <div key={p.id} className="am-rmeta"><b>{p.name}</b>: paused, no automatic messages</div>
            ))}
            <div className="am-help">A requirement&apos;s setting is on the requirement&apos;s page. A person is paused or resumed on their page, or with the buttons above.</div>
          </div>
        </>
      )}

      <div className="section-label" style={{ marginTop: 18 }}>Who changed what</div>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Was</th><th>Now</th></tr></thead>
          <tbody>
            {hist.map((h) => (
              <tr key={h.id}><td>{clock(h.at)}</td><td>{h.by || '—'}</td><td>{h.what}</td><td className="cell-muted">{cap(h.from) || '—'}</td><td>{cap(h.to) || '—'}</td></tr>
            ))}
            {!hist.length && <tr><td colSpan={5} className="small-muted" style={{ padding: 12 }}>Nobody has changed anything yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {edit && (
        <RuleEditor
          item={edit}
          data={data}
          canManage={canManage}
          onClose={() => setEdit(null)}
          onSaved={(m) => { setEdit(null); setFlash(m); load(); setListKey((k) => k + 1); }}
        />
      )}
    </div>
  );
}
