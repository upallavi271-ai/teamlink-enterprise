import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { to12h } from '../../utils/csv.js';
import './attendance-self.css';

// ---------------------------------------------------------------------------
// HRMS-24 §5 — WEB / MOBILE CHECK-IN WITH A LIVE FACE AND A LOCATION.
//
//   1. the browser's location (latitude, longitude, accuracy, timestamp);
//   2. a one-use liveness challenge from the server (turn the head / blink);
//   3. the camera — a LIVE STREAM ONLY. There is no file input anywhere in
//      this flow, so an old photo cannot be uploaded instead;
//   4. a burst of frames captured while the person does the action;
//   5. the server decodes the frames, runs the open-source face model and
//      compares them with the registered photo. Match + liveness + location
//      = the punch is recorded. Anything else = nothing is recorded.
//
// The browser never decides whether the face matched; it only sends pixels.
// ---------------------------------------------------------------------------

const FAILED = 'Face verification failed. Please try again.';
const NO_PHOTO = 'Add your photo in My Employee Profile first';

function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('This browser cannot share a location.')); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        timestamp: pos.timestamp || Date.now(),
      }),
      (err) => reject(new Error(err && err.code === 1
        ? 'Location access was refused. Allow location for this site and try again.'
        : 'Your location could not be read. Check that location is on and try again.')),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  });
}

const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

export default function FaceCheckIn({ direction, method, onClose, onDone }) {
  const [stage, setStage] = useState('locating'); // locating | camera | capturing | verifying | done | error
  const [location, setLocation] = useState(null);
  const [challenge, setChallenge] = useState(null);
  const [count, setCount] = useState(0);
  const [shots, setShots] = useState(0);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState('');
  const [needPhoto, setNeedPhoto] = useState(false);
  const [result, setResult] = useState(null);
  const video = useRef(null);
  const stream = useRef(null);
  const alive = useRef(true);
  const verb = direction === 'In' ? 'Check in' : 'Check out';

  function stopCamera() {
    if (stream.current) { stream.current.getTracks().forEach((t) => t.stop()); stream.current = null; }
  }

  function fail(message, more = '') {
    stopCamera();
    setError(message); setDetail(more); setStage('error');
  }

  async function prepare() {
    setError(''); setDetail(''); setNeedPhoto(false); setResult(null);
    try {
      setStage('locating');
      const loc = await getLocation();
      if (!alive.current) return;
      setLocation(loc);
      const ch = await api.get('/attendance/face/challenge', { params: { direction } });
      if (!alive.current) return;
      setChallenge(ch.data);
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser has no camera access. Use a current browser over https.');
      let s;
      try {
        s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      } catch {
        throw new Error('Camera access was refused. Allow the camera for this site and try again.');
      }
      if (!alive.current) { s.getTracks().forEach((t) => t.stop()); return; }
      stream.current = s;
      setStage('camera');
    } catch (err) {
      const body = err.response && err.response.data;
      if (body && body.code === 'NO_PHOTO') { setNeedPhoto(true); fail(NO_PHOTO); return; }
      fail((body && body.error) || err.message || 'Could not start the check-in.');
    }
  }

  useEffect(() => {
    alive.current = true;
    prepare();
    return () => { alive.current = false; stopCamera(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Attach the stream once the <video> is on screen.
  useEffect(() => {
    if (stage === 'camera' && video.current && stream.current && video.current.srcObject !== stream.current) {
      video.current.srcObject = stream.current;
      video.current.play().catch(() => {});
    }
  }, [stage]);

  function grab(canvas) {
    const v = video.current;
    const w = 480;
    const h = Math.round((v.videoHeight / v.videoWidth) * w) || 360;
    canvas.width = w; canvas.height = h;
    // Drawn UNMIRRORED — the preview is mirrored for comfort only.
    canvas.getContext('2d').drawImage(v, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.85);
  }

  async function start() {
    const v = video.current;
    if (!v || !v.videoWidth) { setDetail('The camera is still starting. Try again in a moment.'); return; }
    setStage('capturing'); setDetail('');
    for (let n = 3; n > 0; n -= 1) { setCount(n); await wait(700); }
    setCount(0);
    const canvas = document.createElement('canvas');
    const frames = [];
    for (let i = 0; i < challenge.frames; i += 1) {
      if (!alive.current) return;
      frames.push(grab(canvas));
      setShots(i + 1);
      if (i < challenge.frames - 1) await wait(challenge.intervalMs);
    }
    stopCamera();
    setStage('verifying');
    const form = new FormData();
    form.append('token', challenge.token);
    form.append('method', method);
    form.append('latitude', String(location.latitude));
    form.append('longitude', String(location.longitude));
    form.append('accuracy', String(location.accuracy));
    form.append('locationAt', String(location.timestamp));
    frames.forEach((f, i) => form.append(`frame${i}`, f));
    try {
      const res = await api.post('/attendance/punches/verified', form, { timeout: 120000 });
      if (!alive.current) return;
      setResult(res.data);
      setStage('done');
      onDone && onDone(res.data);
    } catch (err) {
      const body = (err.response && err.response.data) || {};
      if (body.code === 'NO_PHOTO') { setNeedPhoto(true); fail(NO_PHOTO); return; }
      if (err.response && err.response.status === 422) { fail(FAILED, body.reason || ''); return; }
      fail(body.error || 'The check-in was not recorded. Try again.');
    }
  }

  const locLine = location
    ? `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)} · ±${Math.round(location.accuracy)} m`
    : null;

  return (
    <Modal title={`${verb} — face & location`} onClose={onClose}>
      <div className="att-self">
        {stage === 'locating' && <div className="small-muted">Reading your location and preparing the camera…</div>}

        {(stage === 'camera' || stage === 'capturing') && challenge && (
          <>
            <div className="att-cam">
              <video ref={video} playsInline muted autoPlay />
              {stage === 'capturing' && count > 0 && <div className="att-cam-count">{count}</div>}
              {stage === 'capturing' && count === 0 && <div className="att-cam-rec">● Capturing {shots}/{challenge.frames}</div>}
            </div>
            <div className="att-cam-prompt"><b>{challenge.action === 'turn' ? 'Turn your head' : 'Blink'}</b> — {challenge.prompt}</div>
            <div className="small-muted">Only you in the frame, face well lit. The capture takes about {Math.round((challenge.frames * challenge.intervalMs) / 1000) || 1} seconds.</div>
            {locLine && <div className="small-muted" style={{ marginTop: 4 }}>Location: {locLine}</div>}
            {detail && <div className="notice amber" style={{ marginTop: 8 }}>{detail}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button type="button" className="btn btn-primary" disabled={stage !== 'camera'} onClick={start}>
                {stage === 'capturing' ? 'Capturing…' : `Start — ${verb.toLowerCase()}`}
              </button>
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}

        {stage === 'verifying' && <div className="small-muted">Verifying your face against your registered photo… this can take a few seconds.</div>}

        {stage === 'done' && result && (
          <div className="notice">
            <b>{direction === 'In' ? 'Checked in' : 'Checked out'} at {to12h(result.punch.time)}</b> — face verified
            (score {Math.round((result.verification.score || 0) * 100)}%), {result.punch.locationStatus}.
            <div style={{ marginTop: 10 }}><button type="button" className="btn btn-sm" onClick={onClose}>Close</button></div>
          </div>
        )}

        {stage === 'error' && (
          <div>
            <div className="notice red"><b>{error}</b>{detail ? <div style={{ marginTop: 4 }}>{detail}</div> : null}</div>
            <div className="small-muted" style={{ marginTop: 6 }}>No attendance was recorded.</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              {needPhoto
                ? <Link className="btn btn-primary" to="/my-profile" onClick={onClose}>Open My Employee Profile</Link>
                : <button type="button" className="btn btn-primary" onClick={prepare}>Try again</button>}
              <button type="button" className="btn" onClick={onClose}>Close</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
