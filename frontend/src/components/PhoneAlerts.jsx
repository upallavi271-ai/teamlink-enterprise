import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { viewAsToken } from '../api';
import {
  canPromptInstall, disablePush, enablePush, isIos, isStandalone, onInstallChange, promptInstall,
  pushState, pwaAvailable, sendTestAlert,
} from '../pwa/pwa.js';
import './PhoneAlerts.css';

// ---------------------------------------------------------------------------
// "TeamLink on this phone": install the app, and switch phone alerts on or off for THIS phone.
// Used on the Notifications page. Shows nothing in a separate company's build.
//
// Never asks for the browser's permission by itself: the permission question only opens from the button tap, which is also the only
// way an iPhone allows it.
// ---------------------------------------------------------------------------
export default function PhoneAlerts() {
  const { user } = useAuth();
  const [st, setSt] = useState(null);
  const [canInstall, setCanInstall] = useState(canPromptInstall());
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null); // { tone: 'ok' | 'bad', text }

  const refresh = () => pushState().then(setSt).catch(() => setSt({ support: 'unsupported', permission: 'default', on: false }));
  useEffect(() => {
    refresh();
    return onInstallChange(() => setCanInstall(canPromptInstall()));
  }, []);

  if (!pwaAvailable) return null;

  if (viewAsToken()) {
    return (
      <section className="phalert-card" aria-label="Phone alerts">
        <h3>📱 Phone alerts</h3>
        <p className="phalert-note">Not available while you are viewing as somebody else. Phone alerts are each person&apos;s own switch.</p>
      </section>
    );
  }

  const run = async (what, fn, ok) => {
    setBusy(what); setMsg(null);
    try { await fn(); if (ok) setMsg({ tone: 'ok', text: ok }); } catch (err) { setMsg({ tone: 'bad', text: (err && err.response && err.response.data && err.response.data.error) || (err && err.message) || 'That did not work. Please try again.' }); }
    setBusy(''); refresh();
  };

  const installed = isStandalone();
  const support = st && st.support;

  return (
    <section className="phalert-card" aria-label="TeamLink on this phone">
      <h3>📱 TeamLink on this phone</h3>

      <div className="phalert-row">
        <div className="phalert-text">
          <b>The app</b>
          {installed && <span>✓ TeamLink is installed on this phone.</span>}
          {!installed && canInstall && <span>Adds a TeamLink icon to your home screen. It opens full screen, like any app.</span>}
          {!installed && !canInstall && isIos() && <span>On iPhone: tap the <b>Share</b> button (the square with an arrow), then <b>Add to Home Screen</b>.</span>}
          {!installed && !canInstall && !isIos() && <span>Open your browser&apos;s menu (⋮) and choose <b>Install app</b> or <b>Add to Home screen</b>.</span>}
        </div>
        {!installed && canInstall && (
          <button type="button" className="btn btn-primary phalert-btn" disabled={busy === 'install'} onClick={() => run('install', promptInstall)}>Install the app</button>
        )}
      </div>

      <div className="phalert-row">
        <div className="phalert-text">
          <b>Alerts</b>
          {!st && <span>Checking…</span>}
          {st && support === 'ok' && st.on && <span>✓ On for this phone. You get leave decisions, approvals and follow-ups, even with the app closed.</span>}
          {st && support === 'ok' && !st.on && st.permission === 'denied' && <span>Alerts are blocked for this site. Allow notifications for TeamLink in your browser or phone settings, then come back and switch them on.</span>}
          {st && support === 'ok' && !st.on && st.permission !== 'denied' && <span>Get leave decisions, approvals and follow-ups on this phone, even with the app closed. Nothing is sent until you switch this on.</span>}
          {st && support === 'ios-add-first' && <span>On iPhone, alerts work once TeamLink is on your Home Screen. Add it first (steps above), open it from the new icon, then switch alerts on here.</span>}
          {st && support === 'ios-too-old' && <span>This iPhone is too old for app alerts (it needs iOS 16.4 or newer). Alerts still show in the 🔔 bell inside TeamLink.</span>}
          {st && support === 'unsupported' && <span>This browser cannot send alerts to the phone. They still show in the 🔔 bell inside TeamLink.</span>}
        </div>
        {st && support === 'ok' && !st.on && st.permission !== 'denied' && (
          <button type="button" className="btn btn-primary phalert-btn" disabled={busy === 'on'} onClick={() => run('on', () => enablePush(user && user.id), 'Alerts are on for this phone.')}>{busy === 'on' ? 'Switching on…' : 'Turn on alerts'}</button>
        )}
        {st && support === 'ok' && st.on && (
          <span className="phalert-btns">
            <button type="button" className="btn phalert-btn" disabled={busy === 'test'} onClick={() => run('test', async () => { const r = await sendTestAlert(); if (!r.ok) throw new Error('The test alert could not be delivered to this phone. Try switching alerts off and on again.'); }, 'Test sent. It should arrive in a few seconds.')}>Send a test</button>
            <button type="button" className="btn phalert-btn" disabled={busy === 'off'} onClick={() => run('off', () => disablePush(user && user.id), 'Alerts are off for this phone.')}>Turn off</button>
          </span>
        )}
      </div>

      {msg && <div className={`phalert-msg ${msg.tone}`} role="status">{msg.text}</div>}
    </section>
  );
}
