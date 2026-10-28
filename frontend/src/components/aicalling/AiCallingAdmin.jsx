import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../api';
import Combo from '../Combo.jsx';
import { errorOf, when } from './aiCallingShared.js';

// Administration > Integrations > AI Calling : the Exotel AI Calling settings.
//
// SECRETS: the API key, API token and webhook secret are typed here once and sent to the server, which stores them encrypted. This page
// never receives them back: it only learns "set" and a masked hint. Leave a secret box empty to keep the saved one.
const STATE_CLASS = { Connected: 'active', 'Not configured': 'new', 'Configuration required': 'pending', Error: 'rejected' };
const ROLE_WORDS = {
  SUPER_ADMIN: 'Super Admin', ADMIN: 'Admin', MANAGER: 'Manager', ASSISTANT_MANAGER: 'Assistant Manager', STL: 'Senior Team Lead', TL: 'Team Lead', RECRUITER: 'Recruiter', BDE: 'Client manager (BDE)', HR: 'HR', ACCOUNTANT: 'Accountant',
};
const csv = (v) => String(v || '').split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);

function Section({ title, hint, children }) {
  return (
    <div className="panel panel-pad">
      <h3 style={{ fontSize: 14, margin: '0 0 2px' }}>{title}</h3>
      {hint && <div className="small-muted" style={{ marginBottom: 10 }}>{hint}</div>}
      {children}
    </div>
  );
}
function CheckList({ options, value, onChange }) {
  const have = new Set(csv(value));
  const flip = (k) => { const s = new Set(have); if (s.has(k)) s.delete(k); else s.add(k); onChange([...s].join(', ')); };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
      {options.map(([k, label]) => (
        <label key={k} style={{ fontSize: 13, whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={have.has(k) || have.has(label)} onChange={() => flip(k)} /> {label}
        </label>
      ))}
    </div>
  );
}

export default function AiCallingAdmin() {
  const [cfg, setCfg] = useState(null);
  const [v, setV] = useState({});
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState(null);
  const [showAssume, setShowAssume] = useState(false);

  const load = useCallback(() => {
    api.get('/ai-calling/admin/config').then((r) => {
      setCfg(r.data);
      setV(Object.fromEntries(r.data.fields.map((f) => [f.k, f.secret ? '' : (f.value || '')])));
    }).catch((e) => setErr(errorOf(e, 'Could not load the AI Calling settings.')));
  }, []);
  useEffect(load, [load]);

  const byKey = useMemo(() => Object.fromEntries((cfg ? cfg.fields : []).map((f) => [f.k, f])), [cfg]);
  const set = (k, val) => setV((o) => ({ ...o, [k]: val }));

  function payload() {
    const values = {};
    (cfg.fields || []).forEach((f) => { values[f.label] = v[f.k] == null ? '' : v[f.k]; });
    return values;
  }
  async function save() {
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await api.put('/ai-calling/admin/config', { values: payload() });
      setCfg(r.data);
      setV(Object.fromEntries(r.data.fields.map((f) => [f.k, f.secret ? '' : (f.value || '')])));
      setMsg('Saved. Secrets are stored encrypted and are never shown again.');
    } catch (e) { setErr(errorOf(e, 'Could not save.')); } finally { setBusy(false); }
  }
  async function runTest() {
    setBusy(true); setErr(''); setMsg(''); setTest(null);
    try {
      const r = await api.post('/ai-calling/admin/test-connection');
      setTest(r.data);
      load();
    } catch (e) { setErr(errorOf(e, 'The test could not run.')); } finally { setBusy(false); }
  }

  if (!cfg) return <div className="panel panel-pad">{err ? <div className="error-text">{err}</div> : 'Loading…'}</div>;
  const st = cfg.status;
  const field = (k, props = {}) => {
    const f = byKey[k];
    if (!f) return null;
    return (
      <div className="field" key={k}>
        <label>{props.label || f.label}{f.secret && <span className="small-muted"> · stored encrypted, never shown again{cfg.secretSet[k === 'hook' ? 'hook' : k] ? ' · saved' : ''}</span>}</label>
        <input
          type={f.secret ? 'password' : 'text'}
          autoComplete={f.secret ? 'new-password' : 'off'}
          value={v[k] || ''}
          placeholder={f.secret ? (f.hint ? `${f.hint}: leave empty to keep it` : f.placeholder) : f.placeholder}
          onChange={(e) => set(k, e.target.value)}
        />
        {props.hint && <div className="small-muted">{props.hint}</div>}
      </div>
    );
  };
  const yesNo = (k, label, hint) => (
    <div className="field" key={k}>
      <label>{label}</label>
      <Combo value={/^y/i.test(v[k] || '') ? 'Yes' : 'No'} onChange={(e) => set(k, e.target.value)}><option>No</option><option>Yes</option></Combo>
      {hint && <div className="small-muted">{hint}</div>}
    </div>
  );

  // 2026-10-28: Exotel (cloud) or Self-hosted (Synway): our Asterisk dials through the office Synway gateway (Ollama + Vexyl AI).
  const synway = /synway|self/i.test(v.provider || cfg.provider || '');
  const who = synway ? 'The Asterisk server' : 'Exotel';
  return (
    <div>
      <div className="panel panel-pad">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>AI Calling · {synway ? 'Self-hosted (Synway)' : 'Exotel'}</h3>
          <span className={`status ${STATE_CLASS[st.state] || 'new'}`}>{st.state}</span>
          <span className="status pending">Switch: {cfg.mode}</span>
        </div>
        <p className="small-muted" style={{ margin: '6px 0' }}>{st.detail}</p>
        {(st.steps || []).length > 0 && st.state !== 'Connected' && <ul style={{ margin: '4px 0 0 18px', fontSize: 12.5 }}>{st.steps.map((s) => <li key={s}>{s}</li>)}</ul>}
        {err && <div className="error-text">{err}</div>}
        {msg && <div className="notice" style={{ marginTop: 8 }}>{msg}</div>}
        {test && (
          <div className={`notice${test.ok ? '' : ' red'}`} style={{ marginTop: 8, display: 'block' }}>
            <b>{test.ok ? `${who} answered.` : 'Not connected.'}</b> {test.message}
            <ul style={{ margin: '6px 0 0 18px' }}>{(test.checks || []).map((c) => <li key={c.name}>{`${c.name}: ${c.note}`}</li>)}</ul>
          </div>
        )}
        <div className="row-actions" style={{ marginTop: 10 }}>
          <button className="btn btn-primary" disabled={busy} onClick={save}>Save settings</button>
          <button className="btn" disabled={busy} onClick={runTest}>Test connection</button>
          <span className="small-muted">{synway ? 'The test only logs in to Asterisk and reads its setup (trunk, dialplan, AudioSocket). It never phones anybody.' : 'The test only asks Exotel about your account. It never phones anybody.'}</span>
        </div>
      </div>

      <Section title="1. Calling switch" hint="Off = nothing is called. Test = real calls, but only to the test phone numbers below (your own phones). Live = any eligible candidate. Live needs a successful connection test first.">
        <div className="field" style={{ maxWidth: 320 }}>
          <label>Calling switch</label>
          <Combo value={v.mode || 'Off'} onChange={(e) => set('mode', e.target.value)}><option>Off</option><option>Test</option><option>Live</option></Combo>
        </div>
        {field('testNumbers', { hint: 'Phone numbers you own. In Test mode only these can be called.' })}
        <div className="field" style={{ maxWidth: 320 }}>
          <label>Calling provider</label>
          <Combo value={synway ? 'Self-hosted (Synway)' : 'Exotel'} onChange={(e) => set('provider', e.target.value)}><option>Exotel</option><option>Self-hosted (Synway)</option></Combo>
          <div className="small-muted">Self-hosted: TeamLink&apos;s own Asterisk server dials out through the office Synway SIM gateway; the AI runs on Ollama + Vexyl (no paid AI service). Changing it needs a new connection test before Live.</div>
        </div>
      </Section>

      {synway && (
        <Section title="2. Self-hosted (Synway)" hint="The Asterisk server and the Synway gateway must be on this server or the office network: call audio never goes over the internet. Set them up with deploy/ai-calling/install.sh.">
          <div className="grid-2">
            {field('amiHost')}
            {field('amiPort')}
            {field('amiUser', { hint: 'The [teamlink] user in /etc/asterisk/manager.conf.' })}
            {field('amiSecret')}
            {field('trunk', { hint: 'The PJSIP endpoint of the gateway (pjsip_synway.conf: [synway]).' })}
            {field('gatewayIp', { hint: 'Synway admin page > Network. The trunk must point at this address.' })}
            <div className="field">
              <label>Number format the gateway dials</label>
              <Combo value={/^0|zero/i.test(v.dialFormat || '') ? '0 + 10 digits' : (/^\+|^91|e\.?164/i.test(v.dialFormat || '') ? '+91 and the number' : '10 digits')} onChange={(e) => set('dialFormat', e.target.value)}>
                <option>10 digits</option><option>0 + 10 digits</option><option>+91 and the number</option>
              </Combo>
              <div className="small-muted">Most Synway GSM gateways dial the 10-digit mobile number. Check the gateway&apos;s routing rules.</div>
            </div>
            {field('dialContext', { hint: 'extensions_teamlink.conf: [teamlink-ai] (it connects answered calls to AudioSocket).' })}
            {field('ringSeconds')}
          </div>
          <div className="small-muted" style={{ marginTop: 6 }}>
            Ollama (yes / no / later), Vexyl speech to text and text to speech and the AudioSocket bridge port are set in the TeamLink backend .env (AI_CALL_*), not here: install.sh writes them. {cfg.voicebot.speechService ? 'Speech is plugged in on this server.' : 'Speech is NOT plugged in on this server yet (no AI_CALL_STT_URL / AI_CALL_TTS_URL).'}
          </div>
        </Section>
      )}

      {!synway && <Section title="2. Exotel account" hint="From the Exotel dashboard. Ask Exotel to enable Voicebot and to approve your caller ID.">
        <div className="grid-2">
          {field('sid')}
          {field('callerId')}
          {field('key')}
          {field('token')}
          <div className="field">
            <label>Region</label>
            <Combo value={/sing/i.test(v.region || '') ? 'Singapore' : 'Mumbai'} onChange={(e) => set('region', e.target.value)}><option>Mumbai</option><option>Singapore</option></Combo>
            <div className="small-muted">Mumbai accounts use api.in.exotel.com, Singapore accounts api.exotel.com.</div>
          </div>
          {field('host')}
          {field('appId', { hint: 'The Exotel Flow that has the Voicebot applet.' })}
          {field('flowUrl')}
        </div>
      </Section>}

      {!synway && <Section title="3. Addresses Exotel calls back" hint="Exotel must reach this TeamLink over the internet with https. Paste these addresses in the Exotel dashboard.">
        <div className="grid-2">
          {field('publicBase')}
          {field('hook', { hint: 'Type any long text. It is added to the call-back address, shown below with dots.' })}
        </div>
        {field('hookIps', { hint: 'Optional. If you fill this, only these Exotel addresses are accepted.' })}
        <table>
          <tbody>
            <tr><td className="small-muted" style={{ whiteSpace: 'nowrap' }}>Call result address</td><td style={{ wordBreak: 'break-all' }}><code>{cfg.urls.statusCallback}</code></td></tr>
            <tr><td className="small-muted" style={{ whiteSpace: 'nowrap' }}>Voicebot address</td><td style={{ wordBreak: 'break-all' }}><code>{cfg.urls.voicebotWebSocket}</code></td></tr>
          </tbody>
        </table>
        <div className="small-muted" style={{ marginTop: 6 }}>
          {cfg.voicebot.speechService ? 'A speech service is plugged in for the Voicebot audio.' : 'The Voicebot audio needs a speech-to-text and text-to-speech service. None is plugged in yet, so real phone audio cannot be handled until one is. The conversation logic itself is ready.'}
        </div>
      </Section>}

      <Section title="4. Calling hours and limits">
        <div className="grid-2">
          {field('hoursFrom')}
          {field('hoursTo')}
          <div className="field">
            <label>Outside calling hours</label>
            <Combo value={/ref/i.test(v.outside || '') ? 'Refuse' : 'Queue'} onChange={(e) => set('outside', e.target.value)}><option value="Queue">Wait for the next opening</option><option value="Refuse">Refuse the call</option></Combo>
          </div>
          {field('dailyLimit')}
          {field('userLimit')}
          {field('attempts')}
          {field('gaps', { hint: 'Example: 30,120 = first retry after 30 minutes, then after 2 hours.' })}
          {field('reminders', { hint: 'Example: 24,2 = a reminder 24 hours and 2 hours before the interview. Only for requirements where you tick automatic reminders.' })}
          {field('maxBulk')}
        </div>
      </Section>

      <Section title="5. Languages and voice">
        <div className="field"><label>Languages offered</label><CheckList options={[['English', 'English'], ['Telugu', 'Telugu'], ['Hindi', 'Hindi']]} value={v.languages} onChange={(x) => set('languages', x)} /></div>
        <div className="grid-2">
          <div className="field">
            <label>Language when the candidate has none saved</label>
            <Combo value={v.fallbackLanguage || 'English'} onChange={(e) => set('fallbackLanguage', e.target.value)}><option>English</option><option>Telugu</option><option>Hindi</option></Combo>
          </div>
          {field('voice')}
        </div>
      </Section>

      <Section title="6. Who can place AI calls" hint="Tick the roles. Roles that cannot see candidate phone numbers (the client managers) can never place calls, whatever is ticked.">
        <div className="field"><label>One call at a time</label><CheckList options={cfg.roleWords.map((r) => [r, ROLE_WORDS[r] || r])} value={v.callRoles} onChange={(x) => set('callRoles', x)} /></div>
        <div className="field"><label>Campaigns (many candidates at once)</label><CheckList options={cfg.roleWords.map((r) => [r, ROLE_WORDS[r] || r])} value={v.bulkRoles} onChange={(x) => set('bulkRoles', x)} /></div>
        {field('shortlistStages', { hint: 'The step code that counts as Shortlisted. Default CLIENT_SHORTLISTED ("Client shortlisted").' })}
      </Section>

      <Section title="7. Consent, opt-out and Do Not Disturb" hint="A candidate who said no, or whose number is on the do-not-call list, is never called. You must also check the legal rules yourself (see the report).">
        {yesNo('consentApplied', 'Allow interview and shortlist calls to people who applied but have no consent record', 'Screening calls always need a recorded consent.')}
        {yesNo('dndService', 'Allow interview and shortlist calls to numbers marked Do Not Disturb', 'Screening calls to such numbers are never allowed.')}
      </Section>

      <Section title="8. Recordings, transcripts and written follow-ups" hint="When recording or transcripts are on, the assistant says so at the start of the call.">
        <div className="grid-2">
          {yesNo('recording', 'Record calls')}
          {yesNo('keepTranscripts', 'Keep what was said (transcript)')}
          {field('transcriptDays')}
          {field('recordingDays')}
          {yesNo('writtenEmail', 'Send a written follow-up by email after a shortlist or interview call')}
          {yesNo('writtenWhatsapp', 'Send a written follow-up on WhatsApp (only if WhatsApp is connected)')}
        </div>
        <div className="row-actions">
          <button className="btn btn-sm" onClick={() => api.post('/ai-calling/admin/purge').then((r) => setMsg(`Deleted old transcripts / recordings of ${r.data.purged} call(s).`)).catch((e) => setErr(errorOf(e, 'Could not delete.')))}>Delete old transcripts and recordings now</button>
        </div>
      </Section>

      <JobSwitches />
      <Suppressions />

      <Section title="First safe test call" hint="Do these in this order.">
        <ol style={{ margin: '0 0 0 18px', fontSize: 13, lineHeight: 1.7 }}>
          <li>{synway ? 'Fill section 2 (Asterisk + Synway), press Save, then Test connection. It must say Connected (trunk, dialplan and AudioSocket all found).' : 'Fill sections 2 and 3, press Save, then Test connection. It must say Connected.'}</li>
          <li>Put the switch on <b>Test</b> and add your own phone number as a test phone number.</li>
          <li>Add a test candidate in the ATS with your own number and a recorded consent, on a test requirement.</li>
          <li>Open AI Calling, pick that requirement, tick only that candidate, press Call, read the script, press Yes, call now.</li>
          <li>Answer your phone. When it ends, check that the call shows Done and that the result is on the candidate&apos;s History.</li>
          <li>Only then switch to <b>Live</b>.</li>
        </ol>
      </Section>

      <Section title="What must be checked with Exotel">
        <button className="btn btn-sm" onClick={() => setShowAssume(!showAssume)}>{showAssume ? 'Hide' : 'Show'} the list</button>
        {showAssume && (
          <div className="tbl-wrap" style={{ marginTop: 8 }}>
            <table>
              <thead><tr><th>#</th><th>What</th><th>What TeamLink assumes</th><th>Check this in the Exotel dashboard</th></tr></thead>
              <tbody>{cfg.assumptions.map((a) => <tr key={a.n}><td>{a.n}</td><td style={{ whiteSpace: 'normal' }}>{a.what}</td><td style={{ whiteSpace: 'normal' }}>{a.assumed}</td><td style={{ whiteSpace: 'normal' }}>{a.confirm}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

// Automatic calling is decided per requirement, by an Admin.
function JobSwitches() {
  const [rows, setRows] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [pick, setPick] = useState('');
  const [cur, setCur] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    api.get('/ai-calling/admin/job-settings').then((r) => setRows(r.data.rows || [])).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    api.get('/requirements/picker', { params: { limit: 100 } }).then((r) => setJobs(r.data.rows || [])).catch(() => {});
  }, [load]);
  useEffect(() => {
    if (!pick) { setCur(null); return; }
    api.get(`/ai-calling/admin/job-settings/${pick}`).then((r) => setCur(r.data)).catch(() => setCur(null));
  }, [pick]);
  async function put(patch) {
    setErr('');
    try { const r = await api.put(`/ai-calling/admin/job-settings/${pick}`, patch); setCur(r.data); load(); } catch (e) { setErr(errorOf(e, 'Could not save.')); }
  }
  const sw = (k, label) => cur && (
    <label style={{ display: 'block', fontSize: 13, margin: '4px 0' }}>
      <input type="checkbox" checked={!!cur[k]} onChange={(e) => put({ [k]: e.target.checked })} /> {label}
    </label>
  );
  return (
    <Section title="Automatic calls, requirement by requirement" hint="Without a tick here, every call needs a person to press Confirm. A tick lets the system place that kind of call by itself for that requirement only.">
      {err && <div className="error-text">{err}</div>}
      <div className="field" style={{ maxWidth: 480 }}>
        <label>Requirement</label>
        <Combo value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">Pick a requirement</option>
          {jobs.map((j) => <option key={j.id} value={j.id}>{j.title}</option>)}
        </Combo>
      </div>
      {cur && (
        <div>
          {sw('enabled', 'AI calling allowed for this requirement')}
          {sw('autoShortlist', 'Call by itself when a candidate is moved to the shortlisted step')}
          {sw('autoInterview', 'Call by itself when an interview is booked or changed')}
          {sw('autoReminders', 'Call by itself before the interview (reminders)')}
        </div>
      )}
      {rows.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="section-label">Requirements with their own settings</div>
          {rows.map((r) => (
            <div key={r.requirementId} className="assign-row">
              <b>{r.title || r.requirementId}</b>
              <span className="small-muted">{[r.enabled ? 'allowed' : 'switched off', r.autoShortlist && 'auto shortlist', r.autoInterview && 'auto interview', r.autoReminders && 'auto reminders'].filter(Boolean).join(' · ')}{r.updatedByName ? ` · ${r.updatedByName}, ${when(r.updatedAt)}` : ''}</span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function Suppressions() {
  const [rows, setRows] = useState([]);
  const [phone, setPhone] = useState('');
  const [kind, setKind] = useState('dnd');
  const [err, setErr] = useState('');
  const load = useCallback(() => { api.get('/ai-calling/admin/suppressions').then((r) => setRows(r.data.rows || [])).catch(() => {}); }, []);
  useEffect(load, [load]);
  async function add() {
    setErr('');
    try { await api.post('/ai-calling/admin/suppressions', { phone, kind }); setPhone(''); load(); } catch (e) { setErr(errorOf(e, 'Could not add.')); }
  }
  return (
    <Section title="Numbers the AI must not call" hint="Do Not Disturb numbers and people who asked not to be called. A person who says &quot;do not call me&quot; on a call is added here by itself.">
      {err && <div className="error-text">{err}</div>}
      <div className="row-actions" style={{ marginBottom: 8 }}>
        <input placeholder="Phone number" value={phone} onChange={(e) => setPhone(e.target.value)} style={{ maxWidth: 200 }} />
        <Combo value={kind} onChange={(e) => setKind(e.target.value)}><option value="dnd">Do Not Disturb (DND)</option><option value="optout">Asked not to be called</option></Combo>
        <button className="btn btn-sm btn-primary" disabled={!phone.trim()} onClick={add}>Add</button>
      </div>
      {rows.map((r) => (
        <div key={r.id} className="assign-row">
          <span>{r.phoneMask} <span className="small-muted">{`· ${r.kind === 'dnd' ? 'DND' : 'asked not to be called'} · ${r.source || ''} · ${when(r.createdAt)}`}</span></span>
          <button className="btn btn-sm btn-ghost" onClick={() => api.delete(`/ai-calling/admin/suppressions/${r.id}`).then(load)}>Remove</button>
        </div>
      ))}
      {!rows.length && <div className="small-muted">No numbers yet.</div>}
    </Section>
  );
}
