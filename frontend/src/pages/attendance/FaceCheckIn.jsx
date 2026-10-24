import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { to12h } from '../../utils/csv.js';
import { acquireCamera, releaseCamera } from '../../utils/cameraHold.js';
import { evaluateFence, getPosition, locationProblemText, locationSteps, mapsLink, outsideText, distanceText, distanceWords } from '../../utils/checkinGeo.js';
import './attendance-self.css';
import './checkin-flow.css';

// ---------------------------------------------------------------------------
// HRMS-24 §5 — WEB / MOBILE CHECK-IN WITH A LIVE FACE AND A LOCATION.
//
//   1. location, the server's one-use liveness challenge and the camera are all
//      started AT THE SAME TIME (they used to run one after the other);
//   2. if the person is outside the office area the screen says so at once, with
//      the exact distance, before the camera is even needed;
//   3. a short burst of live frames is captured while the person turns their
//      head or blinks (a LIVE STREAM ONLY — no file input anywhere);
//   4. the server decodes the frames, runs the open-source face model and
//      compares them with the registered photo. The browser never decides
//      whether the face matched; it only sends pixels. Nothing here weakens that.
//
// Never frozen: every wait has a limit (location 10 s, requests 30 s), the
// person can Cancel at any time, the state is always reset, and one tap sends
// one punch (a per-attempt idempotency key — a retry cannot create a second).
// ---------------------------------------------------------------------------

const FAILED = 'Face not matched.';
const NO_PHOTO = 'Add your photo in My Employee Profile first';
const SOFT_MS = 8000; // "still working" hint
const HARD_MS = 30000; // give up waiting for the server (strict mode, which runs the long head-turn / blink check)
const EASY_HARD_MS = 12000; // Easy / Record-anyway: the server answers within about 4 s, so do not wait longer
const TOKEN_FRESH_MS = 90000; // the server's session lasts 2 minutes
const LIGHT_KEY = 'tl_checkin_light';

const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const newKey = () => {
  try { if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID(); } catch { /* fall through */ }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
};
const readLight = () => { try { return localStorage.getItem(LIGHT_KEY) === '1'; } catch { return false; } };
const slowDevice = () => {
  try {
    const c = navigator.connection || {};
    return (navigator.deviceMemory && navigator.deviceMemory <= 2) || c.saveData || /(^|-)2g|3g/.test(c.effectiveType || '');
  } catch { return false; }
};

function Ring({ value = 0, spin = false, children }) {
  const r = 44; const c = 2 * Math.PI * r;
  return (
    <div className={`ci-ring${spin ? ' spin' : ''}`}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r={r} className="ci-ring-bg" />
        <circle cx="50" cy="50" r={r} className="ci-ring-fg" strokeDasharray={c} strokeDashoffset={spin ? c * 0.72 : c * (1 - Math.min(1, value))} />
      </svg>
      <div className="ci-ring-mid">{children}</div>
    </div>
  );
}

function Checks({ checks }) {
  const row = (k, label) => (
    <li key={k} className={`ci-check ${checks[k]}`}>
      <span className="ci-dot">{checks[k] === 'ok' ? '✓' : checks[k] === 'bad' ? '!' : ''}</span>{label}
    </li>
  );
  return <ul className="ci-checks">{row('loc', 'Your location')}{row('cam', 'Your camera')}{row('srv', 'Face check ready')}</ul>;
}

function OutsidePanel({ info, direction, busy, onRefresh, onClose }) {
  return (
    <div>
      <div className="notice red" style={{ display: 'block' }}><b>{outsideText(info, direction)}</b></div>
      <div className="ci-facts">
        <div>GPS accuracy ±{info.accuracyM != null ? Math.round(info.accuracyM) : '?'} m</div>
        {info.weakGps && (
          <div className="notice amber" style={{ marginTop: 6 }}>
            Your GPS is not accurate enough (worse than the {distanceText(info.radiusM)} allowed). Go near a window or outside, then tap Refresh my location.
          </div>
        )}
        {info.others && info.others.length > 0 && (
          <div className="small-muted" style={{ marginTop: 6 }}>Other offices: {info.others.map((o) => `${o.name} (${distanceText(o.distance)})`).join(', ')}</div>
        )}
      </div>
      <div className="small-muted" style={{ marginTop: 6 }}>No attendance was recorded. Working away from the office today? Ask your TL or HR to add it with your reason.</div>
      <div className="ci-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={onRefresh}>{busy ? 'Reading location…' : 'Refresh my location'}</button>
        <a className="btn" href={mapsLink(info.office.latitude, info.office.longitude)} target="_blank" rel="noreferrer">Open in Maps</a>
        <button type="button" className="btn" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

export default function FaceCheckIn({ direction, method, geofence, onClose, onDone }) {
  const [stage, setStage] = useState('preparing'); // preparing | ready | capturing | verifying | done | already | outside | location | error
  const [checks, setChecks] = useState({ loc: 'wait', cam: 'wait', srv: 'wait' });
  const [location, setLocation] = useState(null);
  const [challenge, setChallenge] = useState(null);
  const [count, setCount] = useState(0);
  const [shots, setShots] = useState(0);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState('');
  const [errKind, setErrKind] = useState('');
  const [needPhoto, setNeedPhoto] = useState(false);
  const [result, setResult] = useState(null);
  const [fenceInfo, setFenceInfo] = useState(null);
  const [locProblem, setLocProblem] = useState('');
  const [dark, setDark] = useState(false);
  const [camAsk, setCamAsk] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [light, setLight] = useState(readLight());
  const [canResend, setCanResend] = useState(false);
  const [manualStart, setManualStart] = useState(false);
  const noCam = useRef(false); // the camera could not start, but this mode records the check-in anyway
  const video = useRef(null);
  const [myPhoto, setMyPhoto] = useState(null);
  const stream = useRef(null);
  const alive = useRef(true);
  const run = useRef(0);
  const busy = useRef(false);
  const ctlLoc = useRef(null);
  const ctlSend = useRef(null);
  const userCancel = useRef(false);
  const pendingSend = useRef(null);
  const challengeAt = useRef(0);
  const verb = direction === 'In' ? 'Check in' : 'Check out';

  const fail = useCallback((message, more = '', kind = 'other') => {
    setError(message); setDetail(more); setErrKind(kind); setStage('error');
  }, []);

  const prepare = useCallback(async (known) => {
    run.current += 1;
    const myRun = run.current;
    const stale = () => !alive.current || run.current !== myRun;
    setError(''); setDetail(''); setErrKind(''); setNeedPhoto(false); setResult(null); setFenceInfo(null); setLocProblem('');
    setChecks({ loc: known ? 'ok' : 'wait', cam: 'wait', srv: 'wait' }); setCamAsk(false); setCanResend(false);
    pendingSend.current = null; noCam.current = false; setManualStart(false);
    setStage('preparing');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      fail('No internet connection.', 'Connect to Wi-Fi or mobile data, then tap Try again. Nothing was recorded.', 'offline');
      return;
    }
    if (ctlLoc.current) ctlLoc.current.abort();
    const ctl = new AbortController(); ctlLoc.current = ctl;

    // Location, the face session and the camera all start now, together.
    const locP = known ? Promise.resolve(known) : getPosition({ signal: ctl.signal });
    const chP = api.get('/attendance/face/challenge', { params: { direction }, timeout: 15000 });
    const camP = acquireCamera();
    let camReady = false;
    const askTimer = setTimeout(() => { if (!stale() && !camReady) setCamAsk(true); }, 2500);
    locP.then(() => { if (!stale()) setChecks((c) => ({ ...c, loc: 'ok' })); }, () => {});
    chP.then(() => { if (!stale()) setChecks((c) => ({ ...c, srv: 'ok' })); }, () => {});
    camP.then(() => { camReady = true; if (!stale()) setChecks((c) => ({ ...c, cam: 'ok' })); setCamAsk(false); }, () => {});
    // none of these may end as an unhandled rejection
    [chP, camP].forEach((p) => p.catch(() => {}));

    let pos;
    try { pos = await locP; } catch (e) {
      clearTimeout(askTimer);
      if (stale() || (e && e.code === 'cancelled')) return;
      setChecks((c) => ({ ...c, loc: 'bad' }));
      setLocProblem((e && e.code) || 'unavailable'); setStage('location');
      return;
    }
    if (stale()) { clearTimeout(askTimer); return; }
    setLocation(pos);
    const f = evaluateFence(geofence, pos);
    if (f.known && !f.inside) {
      clearTimeout(askTimer); setFenceInfo(f); setStage('outside'); releaseCamera(20000);
      // The server keeps a note of the refused try for HR (it used to be refused on this screen only).
      api.post('/attendance/checkin/location-check', { latitude: pos.latitude, longitude: pos.longitude, accuracy: pos.accuracy, direction }, { timeout: 8000 }).catch(() => {});
      return;
    }

    let ch; let cam;
    try {
      ch = await chP;
      try { cam = await camP; } catch (camErr) {
        // No camera: Easy / Record-anyway still record the check-in (flagged 'Face not checked'); Strict needs the camera.
        if (['strict', 'required'].includes(ch.data && ch.data.mode)) throw camErr;
        cam = null; noCam.current = true; setChecks((c) => ({ ...c, cam: 'bad' }));
      }
    } catch (err) {
      clearTimeout(askTimer);
      if (stale()) return;
      if (err && (err.code === 'denied' || err.code === 'unavailable' || err.code === 'unsupported')) {
        setChecks((c) => ({ ...c, cam: 'bad' }));
        fail(err.code === 'denied' ? 'Camera access was refused.' : 'The camera could not be started.',
          err.code === 'denied' ? 'Tap the lock icon next to the web address, allow the Camera, then tap Try again.' : 'Close other apps that use the camera, then tap Try again. Use a current browser over https.', 'camera');
        return;
      }
      const body = err && err.response && err.response.data;
      if (body && body.code === 'NO_PHOTO') { setNeedPhoto(true); fail(NO_PHOTO); return; }
      if (err && (!err.response || (err.response.status >= 500 && !(body && body.error)))) { fail('Could not reach the server.', 'Check your internet or wait a few seconds, then tap Try again. Nothing was recorded.', 'network'); return; }
      fail((body && body.error) || 'Could not start the check-in.', '', 'other');
      return;
    }
    clearTimeout(askTimer);
    if (stale()) return;
    stream.current = cam;
    challengeAt.current = Date.now();
    setChallenge(ch.data);
    setStage('ready');
  }, [direction, geofence, fail]);

  // THE PROFILE PHOTO (founder, 2026-10-23): the check-in shows the picture the face is compared with, so a wrong or missing photo is seen at once.
  useEffect(() => {
    let url = null; let live = true;
    api.get('/attendance/face/my-photo', { responseType: 'blob' }).then((r) => { if (live) { url = URL.createObjectURL(r.data); setMyPhoto(url); } }).catch(() => {});
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, []);

  useEffect(() => {
    alive.current = true;
    prepare();
    return () => {
      alive.current = false;
      run.current += 1;
      if (ctlLoc.current) ctlLoc.current.abort();
      if (ctlSend.current) ctlSend.current.abort();
      releaseCamera(20000); // a check-out right after reuses the open camera
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Attach the stream once the <video> is on screen.
  useEffect(() => {
    if ((stage === 'ready' || stage === 'capturing') && video.current && stream.current && video.current.srcObject !== stream.current) {
      video.current.srcObject = stream.current;
      video.current.play().catch(() => {});
    }
  }, [stage]);

  // Easy / Record-anyway: no Start button and no countdown. As soon as the picture is live the check-in begins by itself
  // (3 small pictures, about half a second). If the camera is slow to wake up the Start button appears after 2.5 s.
  useEffect(() => {
    if (stage !== 'ready' || !challenge || challenge.action !== 'look') return undefined;
    if (noCam.current) { start(); return undefined; }
    const t0 = Date.now();
    const t = setInterval(() => {
      const v = video.current;
      if (v && v.videoWidth) { clearInterval(t); start(); } else if (Date.now() - t0 > 2500) { clearInterval(t); setManualStart(true); }
    }, 120);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, challenge]);

  // Too dark? A tiny grey sample of the live picture every half second.
  useEffect(() => {
    if (stage !== 'ready') return undefined;
    const c = document.createElement('canvas'); c.width = 24; c.height = 18;
    const t = setInterval(() => {
      const v = video.current;
      if (!v || !v.videoWidth) return;
      try {
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(v, 0, 0, 24, 18);
        const d = ctx.getImageData(0, 0, 24, 18).data;
        let s = 0; for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        setDark(s / (d.length / 4) < 45);
      } catch { /* hint only */ }
    }, 600);
    return () => clearInterval(t);
  }, [stage]);

  function grab(canvas) {
    const v = video.current;
    const fast = challenge && challenge.action === 'look';
    const w = fast ? 320 : (light ? 480 : 640); // strict: the eyes are small, a blink needs pixels
    const h = Math.round((v.videoHeight / v.videoWidth) * w) || 270;
    canvas.width = w; canvas.height = h;
    // Drawn UNMIRRORED — the preview is mirrored for comfort only.
    canvas.getContext('2d').drawImage(v, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', fast ? 0.6 : (light ? 0.8 : 0.9));
  }

  function buildForm(p) {
    const form = new FormData();
    form.append('token', p.token);
    form.append('method', method);
    form.append('latitude', String(p.location.latitude));
    form.append('longitude', String(p.location.longitude));
    form.append('accuracy', String(p.location.accuracy));
    if (p.faceNote) form.append('faceNote', p.faceNote);
    form.append('locationAt', String(p.location.timestamp));
    p.frames.forEach((f, i) => form.append(`frame${i}`, f));
    return form;
  }

  async function submit(p) {
    const ctl = new AbortController(); ctlSend.current = ctl;
    userCancel.current = false;
    let timedOut = false;
    const t0 = Date.now();
    setElapsed(0); setStage('verifying'); setCanResend(false);
    const tick = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500);
    const hard = challenge && challenge.action === 'look' ? EASY_HARD_MS : HARD_MS;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, hard);
    try {
      const res = await api.post('/attendance/punches/verified', buildForm(p), {
        signal: ctl.signal, timeout: hard + 3000, headers: { 'Idempotency-Key': p.key },
      });
      if (!alive.current) return;
      setResult(res.data);
      if (res.data.duplicate) { setStage('already'); onDone && onDone(res.data); return; }
      pendingSend.current = null;
      setStage('done');
      onDone && onDone(res.data);
    } catch (err) {
      if (!alive.current) return;
      const body = (err.response && err.response.data) || {};
      const canceled = err.code === 'ERR_CANCELED' || err.name === 'CanceledError';
      const fresh = Date.now() - p.at < 100000;
      if (canceled && userCancel.current) { fail('Cancelled.', 'If it was recorded before you cancelled, you will see it in Today below.', 'cancelled'); return; }
      if (canceled || err.code === 'ECONNABORTED' || timedOut) {
        setCanResend(fresh);
        fail('This is taking too long.', 'Tap Send again: it will not check you in twice. If it keeps happening, ask your TL or HR to add today’s attendance.', 'timeout');
        if (elapsed >= SOFT_MS / 1000 || slowDevice()) setLight(true);
        return;
      }
      if (!err.response) {
        setCanResend(fresh);
        fail('Could not reach the server.', 'Check your internet. Tap Send again — it will not check you in twice.', 'network');
        return;
      }
      if (body.code === 'NO_PHOTO') { setNeedPhoto(true); fail(NO_PHOTO); return; }
      if (body.code === 'GEOFENCE' && body.geofence) {
        const g = body.geofence;
        setFenceInfo({ known: true, inside: false, distanceM: g.distanceM, radiusM: g.radiusM, office: g.office, others: g.others || [], accuracyM: g.accuracyM, weakGps: g.weakGps });
        setStage('outside'); return;
      }
      if (body.code === 'IN_FLIGHT') {
        setCanResend(fresh);
        fail('Your earlier tap is still being checked.', 'Wait a few seconds, then tap Send again.', 'busy');
        return;
      }
      if (err.response.status === 422) {
        // WHAT WENT WRONG, in plain words (it always said "Face not matched", even when the face matched but no blink was seen)
        const title = {
          LIVENESS: 'We could not see a blink or a head turn.', NO_FACE: 'We could not see your face clearly.', MULTIPLE_FACES: 'More than one face is in the picture.', INCONSISTENT: 'The pictures did not show one person.',
        }[body.code] || FAILED;
        const tips = ['LIVENESS', 'NO_FACE'].includes(body.code) ? ' Tips: face the camera straight, put the light on your face (not behind you), take glasses glare off, then blink slowly 2 or 3 times.' : '';
        fail(title, `${body.reason || ''}${tips} Try again, or ask your TL or HR to add today’s attendance with your reason.`.trim(), 'face');
        return;
      }
      if (err.response.status >= 500) {
        setCanResend(fresh);
        fail(body.error || 'The server had a problem.', 'Nothing was recorded. Tap Send again, or Try again.', 'server');
        return;
      }
      fail(body.error || 'The check-in was not recorded. Try again.', '', 'other');
    } finally {
      clearInterval(tick); clearTimeout(timer); busy.current = false;
    }
  }

  async function start() {
    if (busy.current || stage !== 'ready') return;
    const v = video.current;
    if (noCam.current) {
      busy.current = true;
      const p0 = { token: challenge.token, frames: [], location, key: newKey(), at: Date.now(), faceNote: 'camera' };
      pendingSend.current = p0;
      await submit(p0);
      return;
    }
    if (!v || !v.videoWidth) { setDetail('The camera is still starting. Try again in a moment.'); return; }
    busy.current = true;
    try {
      // The server's session is short: take a new one if this one is getting old.
      if (Date.now() - challengeAt.current > TOKEN_FRESH_MS) {
        const ch = await api.get('/attendance/face/challenge', { params: { direction }, timeout: 15000 });
        setChallenge(ch.data); challengeAt.current = Date.now();
        setDetail('The instruction changed. Read it, then tap Start again.');
        busy.current = false;
        return;
      }
      setStage('capturing'); setDetail('');
      if (!(challenge && challenge.action === 'look')) { for (let n = 2; n > 0; n -= 1) { setCount(n); await wait(500); } }
      setCount(0);
      const canvas = document.createElement('canvas');
      const frames = [];
      // Wait for the first REAL picture (a camera that has just woken sends black frames), then take each picture at its own time: picture i at
      // start + i x interval. The old loop added the time a picture took to make to every gap, so a blink fell between two pictures.
      for (let n = 0; n < 20 && !(v.readyState >= 2 && v.videoWidth > 0); n += 1) await wait(50); // eslint-disable-line no-await-in-loop
      await wait(250); // the auto-exposure settles
      const t0 = performance.now();
      for (let i = 0; i < challenge.frames; i += 1) {
        if (!alive.current) return;
        const due = t0 + i * challenge.intervalMs;
        const gap = due - performance.now();
        if (gap > 0) await wait(gap); // eslint-disable-line no-await-in-loop
        frames.push(grab(canvas));
        setShots(i + 1);
      }
      const p = { token: challenge.token, frames, location, key: newKey(), at: Date.now() };
      pendingSend.current = p;
      await submit(p);
    } catch (err) {
      if (!alive.current) return;
      busy.current = false;
      if (!err.response) fail('Could not reach the server.', 'Check your internet, then tap Try again. Nothing was recorded.', 'network');
      else fail((err.response.data && err.response.data.error) || 'Could not start the check-in.', '', 'other');
    }
  }

  async function sendAgain() {
    const p = pendingSend.current;
    if (!p || busy.current) return;
    busy.current = true;
    await submit(p); // same key + same pictures: the server never records two
  }

  function cancelWaiting() { userCancel.current = true; if (ctlSend.current) ctlSend.current.abort(); }

  async function refreshLocation() {
    setRefreshing(true);
    try {
      const pos = await getPosition({});
      setRefreshing(false);
      await prepare(pos);
    } catch (e) {
      setRefreshing(false);
      if (e && e.code === 'cancelled') return;
      setLocProblem((e && e.code) || 'unavailable'); setStage('location');
    }
  }

  function closeNow() {
    if (stage === 'verifying') { userCancel.current = true; if (ctlSend.current) ctlSend.current.abort(); }
    onClose();
  }

  function toggleLight(on) { setLight(on); try { localStorage.setItem(LIGHT_KEY, on ? '1' : '0'); } catch { /* not saved */ } }

  const locLine = location
    ? `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)} · GPS accuracy ±${Math.round(location.accuracy)} m`
    : null;

  // The one live line under the picture / ring.
  let status = '';
  if (stage === 'preparing') status = camAsk ? 'Your browser is asking to use the camera — tap Allow.' : 'Getting ready…';
  if (stage === 'ready' && challenge && challenge.action === 'look') status = 'Looking at your face…';
  else if (stage === 'ready') status = dark ? 'It is too dark. Move to a brighter place or face a window.' : 'Looking for your face… Hold still, then tap Start.';
  if (stage === 'capturing' && challenge && challenge.action === 'look') status = 'Looking at your face…';
  else if (stage === 'capturing') status = count > 0 ? 'Hold still…' : `${challenge && challenge.action === 'turn' ? 'Turn your head slowly now' : 'Blink slowly now'} — capturing ${shots}/${challenge ? challenge.frames : ''}`;
  if (stage === 'verifying') status = elapsed >= SOFT_MS / 1000 ? `Still working… ${elapsed} s. A slow connection or a busy server — you can wait or Cancel.` : (challenge && challenge.action === 'look' ? 'Looking at your face…' : `Matching your face… ${elapsed} s`);

  return (
    <Modal title={`${verb} — face & location`} onClose={closeNow}>
      <div className="att-self ci-flow">
        {stage === 'preparing' && (
          <div className="ci-center">
            <Ring spin><span className="ci-ring-txt">…</span></Ring>
            <div className="ci-status" aria-live="polite">{status}</div>
            <Checks checks={checks} />
            <div className="ci-actions"><button type="button" className="btn" onClick={closeNow}>Cancel</button></div>
          </div>
        )}

        {(stage === 'ready' || stage === 'capturing') && challenge && (
          <>
            <div className="ci-photoRow">
              <div className="att-cam">
              <video ref={video} playsInline muted autoPlay />
              {!(challenge && challenge.action === 'look') && <div className="att-cam-oval" aria-hidden="true" />}
              {stage === 'capturing' && count === 0 && challenge.action === 'blink' && <div className="att-cam-say">Blink slowly now</div>}
              {stage === 'capturing' && count === 0 && challenge.action === 'turn' && <div className="att-cam-say">Turn your head slowly</div>}
              {stage === 'capturing' && count > 0 && <div className="att-cam-count">{count}</div>}
              {stage === 'capturing' && count === 0 && <div className="att-cam-rec">● Capturing {shots}/{challenge.frames}</div>}
              </div>
              <div className="ci-mine">
                {myPhoto ? <img src={myPhoto} alt="Your profile photo" /> : <div className="ci-mine-none">No profile photo</div>}
                <span>{myPhoto ? 'Your profile photo' : 'Ask HR to add your photo'}</span>
              </div>
            </div>
            <div className="ci-row">
              <Ring value={stage === 'capturing' && challenge.frames ? shots / challenge.frames : 0} spin={false}><span className="ci-ring-txt">{stage === 'capturing' ? `${shots}` : '●'}</span></Ring>
              <div>
                <div className="ci-status" aria-live="polite">{status}</div>
                <div className="att-cam-prompt">{challenge.action === 'look' ? <b>{challenge.prompt}</b> : <><b>{challenge.action === 'turn' ? 'Turn your head' : 'Blink'}</b> — {challenge.prompt}</>}</div>
              </div>
            </div>
            <div className="small-muted">{challenge && challenge.action === 'look' ? 'Look at the camera. It takes less than a second.' : `Only you in the picture, face well lit. It takes about ${Math.round((challenge.frames * challenge.intervalMs) / 1000) || 1} seconds.`}</div>
            <div className="small-muted" style={{ marginTop: 2 }}>Your photo is used only to check your attendance.</div>
            {locLine && <div className="small-muted" style={{ marginTop: 4 }}>Location: {locLine}</div>}
            {location && location.accuracy > 100 && <div className="notice amber" style={{ marginTop: 6 }}>Your GPS is weak (±{Math.round(location.accuracy)} m). Near a window it is usually better.</div>}
            {detail && <div className="notice amber" style={{ marginTop: 8 }}>{detail}</div>}
            {!(challenge && challenge.action === 'look') && <label className="ci-light small-muted">
              <input type="checkbox" checked={light} onChange={(e) => toggleLight(e.target.checked)} /> Lighter mode (smaller pictures, for a slow phone)
            </label>}
            <div className="ci-actions">
              {(!(challenge && challenge.action === 'look') || manualStart) && (
                <button type="button" className="btn btn-primary" disabled={stage !== 'ready'} onClick={start}>
                  {stage === 'capturing' ? 'Capturing…' : `Start — ${verb.toLowerCase()}`}
                </button>
              )}
              <button type="button" className="btn" onClick={closeNow}>Cancel</button>
            </div>
          </>
        )}

        {stage === 'verifying' && (
          <div className="ci-center">
            <Ring spin><span className="ci-ring-txt">{elapsed}s</span></Ring>
            <div className="ci-status" aria-live="polite">{status}</div>
            <div className="small-muted">Only a few small pictures are sent — never a video.</div>
            <div className="ci-actions"><button type="button" className="btn" onClick={cancelWaiting}>Cancel</button></div>
          </div>
        )}

        {stage === 'done' && result && (
          <div className={`notice${result.verification && result.verification.matched ? '' : ' amber'}`} style={{ display: 'block' }}>
            <b>{direction === 'In' ? 'Checked in' : 'Checked out'} at {to12h(result.punch.time)} ✓ Done</b>
            <div style={{ marginTop: 4 }}>
              {result.verification && result.verification.matched
                ? `Face: matched (${Math.round((result.verification.score || 0) * 100)}%).`
                : `Face: ${result.verification && result.verification.status === 'Face not checked' ? 'not checked' : 'not matched'}. Your attendance is recorded; HR will take a quick look.`}
              {result.punch.distanceM != null ? ` Location: ${distanceWords(result.punch.distanceM, result.punch.accuracyM)}.` : ''}
              {result.location && result.location.lowAccuracy ? ' (Your GPS is weak, but you are counted.)' : ''}
            </div>
            <div className="ci-actions"><button type="button" className="btn btn-sm btn-primary" onClick={onClose}>Done</button></div>
          </div>
        )}

        {stage === 'already' && result && (
          <div>
            <div className="notice"><b>{result.message}</b></div>
            <div className="small-muted" style={{ marginTop: 6 }}>Nothing new was recorded — you are already counted for today.</div>
            <div className="ci-actions"><button type="button" className="btn btn-sm btn-primary" onClick={onClose}>OK</button></div>
          </div>
        )}

        {stage === 'outside' && fenceInfo && (
          <OutsidePanel info={fenceInfo} direction={direction} busy={refreshing} onRefresh={refreshLocation} onClose={onClose} />
        )}

        {stage === 'location' && (
          <div>
            <div className="notice red"><b>{locationProblemText(locProblem)}</b></div>
            {locProblem === 'denied' || locProblem === 'unsupported' ? (
              <ol className="ci-steps">{locationSteps().map((s) => <li key={s}>{s}</li>)}</ol>
            ) : (
              <div className="small-muted" style={{ marginTop: 6 }}>Make sure Location (GPS) is on and go near a window or outside. It stopped waiting after 10 seconds so you are not stuck.</div>
            )}
            <div className="small-muted" style={{ marginTop: 6 }}>No attendance was recorded.</div>
            <div className="ci-actions">
              <button type="button" className="btn btn-primary" onClick={() => prepare()}>Try again</button>
              <button type="button" className="btn" onClick={onClose}>Close</button>
            </div>
          </div>
        )}

        {stage === 'error' && (
          <div>
            <div className={`notice ${errKind === 'cancelled' ? 'amber' : 'red'}`} style={{ display: 'block' }}><b>{error}</b>{detail ? <div style={{ marginTop: 4 }}>{detail}</div> : null}</div>
            {errKind !== 'cancelled' && <div className="small-muted" style={{ marginTop: 6 }}>No attendance was recorded.</div>}
            <div className="ci-actions">
              {needPhoto
                ? <Link className="btn btn-primary" to="/my-profile" onClick={onClose}>Open My Employee Profile</Link>
                : (
                  <>
                    {canResend && pendingSend.current && <button type="button" className="btn btn-primary" onClick={sendAgain}>Send again</button>}
                    <button type="button" className={canResend ? 'btn' : 'btn btn-primary'} onClick={() => prepare()}>Try again</button>
                  </>
                )}
              <button type="button" className="btn" onClick={onClose}>Close</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
