// ---------------------------------------------------------------------------
// ONE camera stream shared by Check In and Check Out. Opening the camera is
// slow on a phone, so after the check-in window closes the stream is kept for a
// few seconds (a check-out right after reuses it); then it is switched off, and
// it is always switched off when the person leaves the page or hides the tab.
// ---------------------------------------------------------------------------
let stream = null;
let stopTimer = null;
let pending = null;

const live = (s) => !!s && s.getTracks().some((t) => t.readyState === 'live');

export function stopCamera() {
  if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
}

// Switch off after `delayMs` unless it is acquired again before.
export function releaseCamera(delayMs = 20000) {
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = setTimeout(stopCamera, delayMs);
}

export function acquireCamera() {
  if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
  if (live(stream)) return Promise.resolve(stream);
  if (pending) return pending;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return Promise.reject(Object.assign(new Error('no camera api'), { code: 'unsupported' }));
  }
  pending = navigator.mediaDevices
    // sharper eyes: a blink is a few pixels (the browser gives what the camera can)
    .getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
    .then((s) => { stream = s; return s; })
    .catch((e) => { throw Object.assign(new Error('camera refused'), { code: e && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'denied' : 'unavailable' }); })
    .finally(() => { pending = null; });
  return pending;
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });
  window.addEventListener('pagehide', stopCamera);
}
