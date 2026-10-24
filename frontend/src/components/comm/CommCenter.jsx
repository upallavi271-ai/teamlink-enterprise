import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import CommLog from './CommLog.jsx';
import './comm.css';
import Combo from '../Combo.jsx';
import WaNumbers, { NumbersGlance } from './WaNumbers.jsx';

// ---------------------------------------------------------------------------
// ADMINISTRATION > INTEGRATIONS > "WhatsApp & SMS" — send WhatsApp and SMS straight from TeamLink.
//   1  which one sends (Official WhatsApp / QR-linked number prototype; Android phone / paid gateway) + company switches
//   2  one health card per way: sent today / this hour vs the limits, waiting, failed, last problem
//   3  the QR-linked WhatsApp (PROTOTYPE) card: warnings, "I understand", QR picture, Start / Stop / Resume / Unlink / Kill switch
//   4  the Android phone card: the 6 setup steps, address + login, Test, "Send a test SMS to my own number", webhooks
//   5  the Communication log (second sub-tab)
// Admin / Super Admin only for changes. Plain words, one clear button per job, no menus.
// ---------------------------------------------------------------------------

const PROVIDER_TEXT = {
  'whatsapp.cloud': { title: 'Official WhatsApp (company number)', note: 'Meta WhatsApp Cloud API. Safe, needs approved templates to start a chat.' },
  'whatsapp.qr': { title: 'QR-linked number (prototype)', note: 'Unofficial. Free, but WhatsApp can ban the number. Spare number only.' },
  'sms.android': { title: 'Android phone', note: 'Your own SIM sends the SMS. Good for personal-style messages.' },
  'sms.gateway': { title: 'Paid gateway', note: 'MSG91, Fast2SMS or Twilio. Needed for bulk messages in India (DLT).' },
};

function Stat({ n, label }) { return <div className="cm-stat"><b>{n}</b><span>{label}</span></div>; }

function Usage({ u, caps }) {
  if (!u) return null;
  return (
    <div className="cm-grid">
      <Stat n={`${u.sentToday}${caps ? ` of ${caps.perDay}` : ''}`} label="sent today" />
      <Stat n={`${u.sentThisHour}${caps ? ` of ${caps.perHour}` : ''}`} label="sent this hour" />
      <Stat n={u.waiting || 0} label="waiting in line" />
      <Stat n={u.failed || 0} label="did not go" />
      <Stat n={u.replies || 0} label="replies today" />
    </div>
  );
}

export default function CommCenter() {
  const [sub, setSub] = useState(() => (typeof window !== 'undefined' && /[?&]sub=numbers/.test(window.location.search) ? 'numbers' : 'setup'));
  const [ov, setOv] = useState(null);
  const [msg, setMsg] = useState(null); // { ok, text }
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    try { const r = await api.get('/comm/overview'); setOv(r.data); } catch (e) { setMsg({ ok: false, text: e.response?.data?.error || 'Could not load.' }); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function act(key, fn, okText) {
    setBusy(key); setMsg(null);
    try { const r = await fn(); await load(); setMsg({ ok: true, text: typeof okText === 'function' ? okText(r) : okText }); return r; } catch (e) {
      setMsg({ ok: false, text: e.response?.data?.error || 'That did not work.' }); return null;
    } finally { setBusy(''); }
  }
  const save = (patch, okText = 'Saved.') => act('settings', () => api.put('/comm/settings', patch), okText);

  if (!ov) return <div className="cm-help">Loading…</div>;
  const s = ov.settings;
  return (
    <div className="cm-page">
      <div className="cm-tabs">
        <button type="button" className={sub === 'setup' ? 'on' : ''} onClick={() => setSub('setup')}>Set up</button>
        {ov.isAdmin && <button type="button" className={sub === 'numbers' ? 'on' : ''} onClick={() => setSub('numbers')}>WhatsApp numbers</button>}
        <button type="button" className={sub === 'log' ? 'on' : ''} onClick={() => setSub('log')}>Communication log</button>
      </div>
      {msg && <div className={`cm-line ${msg.ok ? 'cm-green' : 'cm-red'}`} role="status">{msg.text}</div>}
      {sub === 'log' && <CommLog />}
      {sub === 'numbers' && ov.isAdmin && <WaNumbers />}
      {sub === 'setup' && ov.isAdmin && s && (
        <>
          <p className="cm-help">Send WhatsApp and SMS straight from TeamLink, without opening another app. Every message is saved on the person&apos;s history, in the Inbox and in the Communication log.</p>
          <NumbersGlance onOpen={() => setSub('numbers')} />
          <Chooser ov={ov} s={s} save={save} busy={busy} />
          <div className="cm-section">
            <h3>How each way is doing</h3>
            {['whatsapp.cloud', 'whatsapp.qr', 'sms.android', 'sms.gateway'].map((id) => {
              const c = ov.cards[id];
              return (
                <div className="cm-card" key={id}>
                  <div className="cm-cardhead">
                    <h3>{PROVIDER_TEXT[id].title}</h3>
                    <span className={`cm-pill ${c.ready ? 'delivered' : 'queued'}`}>{c.ready ? 'Ready' : 'Not ready'}</span>
                  </div>
                  <div className="cm-sub">{c.ready ? c.detail : (c.reason || 'Not set up yet.')}</div>
                  <Usage u={c.usage} caps={c.caps} />
                  {c.usage.lastError && <div className="cm-sub cm-redtext">Last problem: {c.usage.lastError}</div>}
                  {id === 'whatsapp.cloud' && <div className="cm-sub">Set up in <b>Connections</b> &gt; WhatsApp Business. Plain text works for 24 hours after they write to you; to start a chat use an approved template.</div>}
                  {id === 'sms.gateway' && <div className="cm-sub">Set up in <b>Connections</b> &gt; SMS Gateway. India: bulk SMS must use DLT-registered templates.</div>}
                </div>
              );
            })}
          </div>
          <QrCard ov={ov} s={s} save={save} act={act} busy={busy} reload={load} />
          <AndroidCard ov={ov} s={s} save={save} act={act} busy={busy} setMsg={setMsg} reload={load} />
        </>
      )}
      {sub === 'setup' && !ov.isAdmin && (
        <div className="cm-card">
          <h3>How your WhatsApp and SMS go out</h3>
          {['WhatsApp', 'SMS'].map((c) => (
            <div key={c} className={`cm-line ${ov.channels[c].configured ? 'cm-green' : 'cm-orange'}`}>
              {ov.channels[c].configured ? <><b>{ov.channels[c].via}</b> is used for {c}.</> : <><b>{c} is not connected</b>; it opens your own app.</>}
            </div>
          ))}
          <p className="cm-help">Only an Admin changes these. Your messages are in the Communication log.</p>
        </div>
      )}
    </div>
  );
}

function Chooser({ ov, s, save, busy }) {
  const row = (channel, options, hint) => {
    const cur = s.providers[channel];
    return (
      <div className="cm-card">
        <div className="cm-cardhead">
          <h3>{channel === 'WhatsApp' ? 'WhatsApp' : 'SMS'}: which one sends?</h3>
          <button type="button" className={`btn ${s.switches[channel] ? 'btn-primary' : ''}`} disabled={busy === 'settings'}
            onClick={() => save({ switches: { [channel]: !s.switches[channel] } }, `${channel} to candidates is now ${s.switches[channel] ? 'OFF' : 'ON'} for the company.`)}>
            {s.switches[channel] ? `${channel} to candidates: ON` : `${channel} to candidates: OFF`}
          </button>
        </div>
        <div className="cm-choice">
          {options.map((id) => (
            <button key={id} type="button" className={cur.primary === id ? 'on' : ''} disabled={busy === 'settings'} onClick={() => save({ providers: { [channel]: { primary: id } } }, `${PROVIDER_TEXT[id].title} goes first now.`)}>
              {PROVIDER_TEXT[id].title}<small>{PROVIDER_TEXT[id].note}</small>
            </button>
          ))}
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5 }}>
          <input type="checkbox" checked={cur.fallback} onChange={(e) => save({ providers: { [channel]: { fallback: e.target.checked } } }, 'Saved.')} />
          If it is not available, try the other one
        </label>
        <div className="cm-sub">{hint}</div>
        {!ov.channels[channel].configured && <div className="cm-line cm-orange" style={{ marginBottom: 0 }}>Nothing is connected for {channel} yet, so people open their own app. Connect one below.</div>}
        {ov.channels[channel].configured && <div className="cm-line cm-green" style={{ marginBottom: 0 }}><b>{ov.channels[channel].via}</b> is used right now.</div>}
      </div>
    );
  };
  return (
    <div className="cm-section">
      {row('WhatsApp', ['whatsapp.cloud', 'whatsapp.qr'], 'If the first one cannot send (not connected, daily limit reached, WhatsApp refuses), the other one is tried. People who said STOP or did not agree are never messaged on either.')}
      {row('SMS', ['sms.android', 'sms.gateway'], 'If the phone is off or its limit is reached, the paid gateway is tried. India: bulk promotional SMS from a normal SIM can be blocked by the phone company (TRAI DLT rules). Keep the phone for personal-style messages (interview reminders, document requests) and use the paid DLT gateway for bulk.')}
    </div>
  );
}

function QrCard({ ov, s, save, act, busy, reload }) {
  const [st, setSt] = useState(null);
  const [understand, setUnderstand] = useState(false);
  const [caps, setCaps] = useState(null);
  const poll = useCallback(async () => { try { const r = await api.get('/comm/qr/state'); setSt(r.data); } catch { /* shown by the page */ } }, []);
  useEffect(() => {
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, [poll]);
  useEffect(() => { if (s && !caps) setCaps({ perHour: s.qr.perHour, perDay: s.qr.perDay, gapMin: s.qr.gapMin, gapMax: s.qr.gapMax }); }, [s]); // eslint-disable-line react-hooks/exhaustive-deps
  const post = (key, path, body, ok) => act(key, async () => { const r = await api.post(path, body); setSt(r.data); return r; }, ok);
  if (!st) return null;
  const on = st.enabled;
  const tone = st.state === 'connected' ? 'cm-green' : (['banned-suspected', 'logged-out'].includes(st.state) ? 'cm-red' : 'cm-orange');
  return (
    <div className="cm-card proto" id="qr-card">
      <div className="cm-cardhead"><h3>WhatsApp QR-link <span className="cm-badge">Prototype</span></h3>
        <span className={`cm-pill ${on ? 'delivered' : 'queued'}`}>{on ? 'Switched on' : 'Switched off'}</span></div>
      <div className="cm-warn">
        <b>Prototype: unofficial, can get the number banned, use a spare number.</b>
        <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
          <li>This links a normal WhatsApp number like WhatsApp Web. WhatsApp&apos;s rules do not allow it for business messaging, so the number can be banned at any time, even with small volumes.</li>
          <li>Use a spare number you can lose. Never your main number or the company&apos;s official number.</li>
          <li>Messages go one at a time with a pause of {s.qr.gapMin}-{s.qr.gapMax} seconds, at most {st.caps.perHour} an hour and {st.caps.perDay} a day. Never use it for mass broadcasts.</li>
          <li>People who did not agree, or replied STOP, are never messaged.</li>
        </ul>
      </div>
      {!on && (
        <>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13.5, margin: '8px 0' }}>
            <input type="checkbox" checked={understand} onChange={(e) => setUnderstand(e.target.checked)} style={{ marginTop: 3 }} />
            <span>I understand: this is unofficial, the number can get banned, and I am using a spare number.</span>
          </label>
          <button type="button" className="btn btn-primary" disabled={!understand || busy === 'qr-enable'} onClick={() => post('qr-enable', '/comm/qr/enable', { understand: true }, 'The QR-link prototype is switched on. Now press Start.')}>Switch it on</button>
        </>
      )}
      {on && (
        <>
          <div className="cm-qrbox">
            {st.qrSvg && <div dangerouslySetInnerHTML={{ __html: st.qrSvg }} aria-label="QR code to scan with WhatsApp" />}
            <div style={{ flex: 1, minWidth: 220 }}>
              <div className="cm-qrstate">{st.label}</div>
              <div className={`cm-line ${tone}`}>{st.reason || (st.state === 'connected' ? 'Ready to send, one message at a time.' : 'Press Start to link the number.')}</div>
              {st.state === 'waiting-qr' && <ol className="cm-steps"><li>On the spare phone open WhatsApp.</li><li>Tap Linked devices, then Link a device.</li><li>Scan this code. It changes every 20 seconds.</li></ol>}
              {st.paused && <div className="cm-line cm-red"><b>Sending is paused</b> after repeated failures. Fix the cause, then press Resume.</div>}
              {st.killSwitch && <div className="cm-line cm-red"><b>The company kill switch is ON.</b> Nothing is sent on this number.</div>}
            </div>
          </div>
          <Usage u={st.usage} caps={st.caps} />
          <div className="cm-btnrow">
            <button type="button" className="btn btn-primary" disabled={!!busy || st.alive} onClick={() => post('qr-start', '/comm/qr/start', {}, 'Starting. The QR code shows here in a few seconds.')}>Start</button>
            <button type="button" className="btn" disabled={!!busy || !st.alive} onClick={() => post('qr-stop', '/comm/qr/stop', {}, 'Stopping.')}>Stop</button>
            <button type="button" className="btn" disabled={!!busy || !st.paused} onClick={() => post('qr-resume', '/comm/qr/resume', {}, 'Sending will continue.')}>Resume</button>
            <button type="button" className="btn" disabled={!!busy} onClick={() => post('qr-unlink', '/comm/qr/unlink', {}, 'The number is unlinked.')}>Unlink the number</button>
            <button type="button" className="btn" disabled={!!busy || !st.usage.waiting} onClick={() => post('qr-clear', '/comm/qr/clear-queue', {}, 'Waiting messages cancelled.')}>Cancel waiting messages</button>
            <button type="button" className={`btn ${st.killSwitch ? 'btn-primary' : ''}`} disabled={!!busy} onClick={() => post('qr-kill', '/comm/qr/kill', { on: !st.killSwitch }, st.killSwitch ? 'Kill switch is off.' : 'Kill switch ON: nothing more goes out on this number.')}>{st.killSwitch ? 'Turn the kill switch off' : 'Kill switch (stop everything)'}</button>
            <button type="button" className="btn" disabled={!!busy} onClick={() => post('qr-disable', '/comm/qr/disable', {}, 'The QR-link prototype is switched off.')}>Switch it off</button>
          </div>
          {caps && (
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: 'pointer', fontSize: 13.5 }}>Limits that protect the number</summary>
              <div className="cm-form" style={{ marginTop: 8 }}>
                <div><label>Most per hour</label><input type="number" min="1" max="120" value={caps.perHour} onChange={(e) => setCaps({ ...caps, perHour: e.target.value })} /></div>
                <div><label>Most per day</label><input type="number" min="1" max="1000" value={caps.perDay} onChange={(e) => setCaps({ ...caps, perDay: e.target.value })} /></div>
                <div><label>Shortest pause (seconds)</label><input type="number" min="3" max="120" value={caps.gapMin} onChange={(e) => setCaps({ ...caps, gapMin: e.target.value })} /></div>
                <div><label>Longest pause (seconds)</label><input type="number" min="3" max="300" value={caps.gapMax} onChange={(e) => setCaps({ ...caps, gapMax: e.target.value })} /></div>
              </div>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5, marginTop: 8 }}>
                <input type="checkbox" checked={!!s.qr.newNumber} onChange={(e) => save({ qr: { newNumber: e.target.checked } }, 'Saved.')} />
                This number is new (lower limits for the first days: 10 an hour, 40 a day)
              </label>
              <div className="cm-btnrow"><button type="button" className="btn btn-primary" disabled={busy === 'settings'} onClick={async () => { await save({ qr: caps }, 'Limits saved.'); poll(); reload(); }}>Save the limits</button></div>
            </details>
          )}
        </>
      )}
      <p className="cm-help" style={{ marginTop: 10 }}>The linking program runs as its own small process, never inside the main server. Worker not installed? Run <code>npm install @whiskeysockets/baileys</code> in the backend folder once. On the real server the Admin also sets <code>TL_ALLOW_REAL_WHATSAPP_QR=1</code>. Read docs/communication/WHATSAPP.md first.</p>
    </div>
  );
}

const STEPS = [
  'Install the free app "SMS Gateway for Android" on the Android phone that has the SIM (from sms-gate.app or its Play Store page).',
  'In the app, start the Local server and note the Username and Password it shows. (Or choose Cloud server mode if the phone and this computer are on different networks.)',
  'Keep the phone on the same Wi-Fi as this computer (Local mode) and switch off battery saving for the app.',
  'Copy the address the app shows, for example http://192.168.1.20:8080.',
  'Paste the address, username and password below and press Save and connect.',
  'Press Test, then type your own number and press Send a test SMS. Watch it reach your phone.',
];

function AndroidCard({ ov, s, save, act, busy, setMsg, reload }) {
  const [cfg, setCfg] = useState(null);
  const [vals, setVals] = useState({});
  const [to, setTo] = useState('');
  const [more, setMore] = useState(false);
  const [caps, setCaps] = useState(null);
  const load = useCallback(async () => { const r = await api.get('/comm/android/config'); setCfg(r.data); setVals(Object.fromEntries(r.data.fields.map(([l, ph]) => [l, r.data.secretFields.includes(l) ? '' : (r.data.values[l] || '')]))); }, []);
  useEffect(() => { load().catch(() => {}); }, [load]);
  useEffect(() => { if (s && !caps) setCaps({ perHour: s.android.perHour, perDay: s.android.perDay, gapMin: s.android.gapMin, gapMax: s.android.gapMax }); }, [s]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!cfg) return null;
  const label = (l) => l;
  const f = (l) => cfg.fields.find(([x]) => x === l);
  const modeKey = cfg.fields[0][0];
  const baseKey = cfg.fields[1][0];
  const basic = [cfg.fields[0], cfg.fields[1], cfg.fields[3], cfg.fields[4]];
  const adv = cfg.fields.filter((x, i) => ![0, 1, 3, 4].includes(i));
  const field = ([l, ph]) => (
    <div key={l}>
      <label>{label(l)}</label>
      {l === modeKey ? (
        <Combo value={vals[l] || 'Local'} onChange={(e) => setVals({ ...vals, [l]: e.target.value })}><option>Local</option><option>Cloud</option><option>Custom</option></Combo>
      ) : (
        <input type={cfg.secretFields.includes(l) ? 'password' : 'text'} autoComplete="off" value={vals[l] || ''} placeholder={cfg.secretFields.includes(l) ? (cfg.secretHints[l] ? `${cfg.secretHints[l]} (leave empty to keep)` : '') : ph}
          onChange={(e) => setVals({ ...vals, [l]: e.target.value })} />
      )}
    </div>
  );
  const stateTone = cfg.configured ? 'cm-green' : 'cm-orange';
  return (
    <div className="cm-card" id="android-card">
      <div className="cm-cardhead"><h3>SMS through an Android phone</h3>
        <span className={`cm-pill ${cfg.configured ? 'delivered' : 'queued'}`}>{cfg.configured ? 'Connected' : 'Not connected'}</span></div>
      <p className="cm-help">Your own SIM sends the SMS, so it costs what your plan costs. The open-source app on the phone receives the message from TeamLink and sends it.</p>
      <ol className="cm-steps">{STEPS.map((x) => <li key={x}>{x}</li>)}</ol>
      <div className="cm-line cm-orange"><b>India:</b> promotional bulk SMS from a normal SIM can be blocked by the phone company (TRAI DLT rules), and too many messages can get the SIM blocked. Use the phone for personal-style messages like interview reminders and document requests, and the paid DLT gateway for bulk.</div>
      <div className="cm-form">{basic.map(field)}</div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5, margin: '10px 0 0' }}><input type="checkbox" checked={more} onChange={(e) => setMore(e.target.checked)} /> More settings (other apps, SIM, webhook word)</label>
      {more && <div className="cm-form" style={{ marginTop: 8 }}>{adv.map(field)}</div>}
      {cfg.problems.length > 0 && <div className={`cm-line ${stateTone}`} style={{ marginTop: 10 }}>{cfg.problems.join(' ')}</div>}
      {cfg.health && <div className={`cm-sub ${cfg.health.ok ? '' : 'cm-redtext'}`}>Last check: {cfg.health.ok ? 'the phone answered' : (cfg.health.error || 'the phone did not answer')} ({new Date(cfg.health.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })})</div>}
      {cfg.lastTestResult && <div className="cm-sub">Last test: {cfg.lastTestResult}</div>}
      <div className="cm-btnrow">
        <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => act('and-save', async () => { const r = await api.put('/comm/android/config', { values: vals }); setCfg(r.data); await load(); }, 'Saved and connected.')}>Save and connect</button>
        <button type="button" className="btn" disabled={!!busy} onClick={async () => { setMsg(null); try { const r = await api.post('/comm/android/test'); setMsg({ ok: true, text: r.data.result }); } catch (e) { setMsg({ ok: false, text: e.response?.data?.result || e.response?.data?.error || 'The phone did not answer.' }); } load(); reload(); }}>Test</button>
        <button type="button" className="btn" disabled={!!busy || !cfg.enabled} onClick={() => act('and-off', async () => { await api.post('/comm/android/disconnect'); await load(); }, 'Disconnected.')}>Disconnect</button>
      </div>
      <div className="cm-form" style={{ marginTop: 12 }}>
        <div><label>Send a test SMS to my own number</label><input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Your own mobile number" inputMode="tel" /></div>
      </div>
      <div className="cm-btnrow">
        <button type="button" className="btn btn-primary" disabled={!!busy || !to.trim()} onClick={() => act('and-sms', async () => (await api.post('/comm/android/test-sms', { to })).data, (r) => r.note || 'The test SMS was sent.')}>Send the test SMS</button>
      </div>
      <div className="cm-section" style={{ marginTop: 14 }}>
        <h3>So the phone can tell TeamLink what happened</h3>
        <p className="cm-help">The phone calls TeamLink when a message is sent, delivered or failed, and when someone replies. In the app open Webhooks and add: <code>{cfg.webhook.url}</code> with the same signing key or word you typed above (or add <code>?key=your word</code> to the address).{!cfg.webhook.publicAddressSet && ' This server has no public address set (APP_BASE_URL), so the phone needs the address of this computer on your Wi-Fi.'}</p>
        <div className="cm-btnrow"><button type="button" className="btn" disabled={!!busy || !cfg.configured} onClick={() => act('and-hook', async () => (await api.post('/comm/android/register-webhooks')).data, (r) => `Told the phone: ${r.results.filter((x) => x.ok).length} of ${r.results.length} webhooks set.`)}>Set the webhooks on the phone for me</button></div>
      </div>
      {caps && (
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13.5 }}>Limits that protect the SIM</summary>
          <Usage u={cfg.usage} caps={s.android} />
          <div className="cm-form">
            <div><label>Most per hour</label><input type="number" min="1" value={caps.perHour} onChange={(e) => setCaps({ ...caps, perHour: e.target.value })} /></div>
            <div><label>Most per day</label><input type="number" min="1" value={caps.perDay} onChange={(e) => setCaps({ ...caps, perDay: e.target.value })} /></div>
            <div><label>Shortest pause (seconds)</label><input type="number" min="1" value={caps.gapMin} onChange={(e) => setCaps({ ...caps, gapMin: e.target.value })} /></div>
            <div><label>Longest pause (seconds)</label><input type="number" min="1" value={caps.gapMax} onChange={(e) => setCaps({ ...caps, gapMax: e.target.value })} /></div>
          </div>
          <div className="cm-btnrow"><button type="button" className="btn btn-primary" disabled={busy === 'settings'} onClick={async () => { await save({ android: caps }, 'Limits saved.'); load(); }}>Save the limits</button></div>
        </details>
      )}
      <p className="cm-help" style={{ marginTop: 10 }}>Full steps: docs/communication/SMS.md. Also see <Link to="/admin/message-templates">Message templates</Link> for wording.</p>
    </div>
  );
}
