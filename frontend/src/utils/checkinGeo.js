// ---------------------------------------------------------------------------
// Check-in location helpers: reading the device position without ever hanging,
// the distance to the nearest office (same rule as the server's
// backend/src/utils/geofence.js, so the screen can say "340 m away" at once),
// and plain words for each kind of location problem.
// ---------------------------------------------------------------------------

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// "340 m" under a kilometre, "1.2 km" above.
export function distanceText(m) {
  const d = Number(m);
  if (!Number.isFinite(d)) return '';
  if (d < 1000) return `${Math.max(0, Math.round(d))} m`;
  return `${(d / 1000).toFixed(1)} km`;
}

// geofence = { enabled, accuracyCounts, accuracyCapM, offices:[{name,latitude,longitude,radiusM}] } (from /attendance/checkin/status)
// Same rule as the server: inside when distance - (the phone's GPS accuracy, up to the cap) <= the allowed distance.
export function evaluateFence(geofence, pos) {
  if (!geofence || !geofence.enabled || !geofence.offices || !geofence.offices.length || !pos) return { known: false, inside: true };
  const counts = geofence.accuracyCounts !== false;
  const cap = Number.isFinite(Number(geofence.accuracyCapM)) ? Number(geofence.accuracyCapM) : 300;
  const slack = counts ? Math.min(Math.max(0, pos.accuracy || 0), cap) : 0;
  const list = geofence.offices
    .map((o) => ({ ...o, distance: haversine(o.latitude, o.longitude, pos.latitude, pos.longitude) }))
    .sort((a, b) => a.distance - b.distance);
  const hit = list.find((o) => o.distance - slack <= o.radiusM);
  const near = hit || list[0];
  return {
    known: true,
    inside: !!hit,
    distanceM: Math.round(near.distance),
    radiusM: near.radiusM,
    office: { name: near.name, latitude: near.latitude, longitude: near.longitude },
    others: list.filter((o) => o !== near).map((o) => ({ name: o.name, distance: Math.round(o.distance), radiusM: o.radiusM })),
    accuracyM: pos.accuracy ?? null,
    weakGps: pos.accuracy != null && pos.accuracy > near.radiusM,
    lowAccuracy: pos.accuracy != null && pos.accuracy > 100,
  };
}

export const outsideText = (f, direction = 'In') => `You are about ${distanceText(f.distanceM)} from ${f.office.name}. Allowed: ${distanceText(f.radiusM)} to ${direction === 'Out' ? 'check out' : 'check in'}.`;

// Honest words for a distance (founder, 2026-10-22): a laptop or phone without GPS gives a Wi-Fi / network position that is only good to about +-70 m, so a "4 m" next to a
// +-71 m reading is not a measurement. When the doubt is bigger than the distance the words say so.
export function distanceWords(distanceM, accuracyM) {
  if (distanceM == null) return '';
  const acc = Number(accuracyM);
  if (Number.isFinite(acc) && acc >= 20 && Number(distanceM) <= acc) return `within about ${Math.ceil(acc / 10) * 10} m of the office (this device's location is only accurate to ±${Math.round(acc)} m, so the exact distance is not known)`;
  return `${distanceText(distanceM)} from the office`;
}

export const mapsLink = (lat, lng) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;

// Reads the position, never waits forever, and keeps the BEST fix: a watch runs for up to `watchMs` (6 s) and stops
// early as soon as a fix is good (<= goodM, 30 m). A quick cached / network fix is asked for at the same time and is
// used at once when it is already good enough (<= 100 m); otherwise the best fix seen when the time is up is used.
// Rejects with { code: 'denied' | 'unavailable' | 'timeout' | 'unsupported' | 'cancelled' } only when there is NO fix at all.
export function getPosition({ watchMs = 6000, goodM = 30, hardMs = 12000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) { reject({ code: 'unsupported' }); return; }
    let done = false;
    let best = null; let denied = false; let watchId = null;
    const timers = [];
    const stop = () => { timers.forEach(clearTimeout); if (watchId != null) { try { navigator.geolocation.clearWatch(watchId); } catch { /* ignore */ } } };
    const fin = (fn, v) => { if (done) return; done = true; stop(); fn(v); };
    const shape = (pos, lowAccuracy) => ({
      latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy,
      timestamp: pos.timestamp || Date.now(), lowAccuracy,
    });
    const take = (pos, lowAccuracy) => {
      const p = shape(pos, lowAccuracy);
      if (!best || (p.accuracy ?? 1e9) < (best.accuracy ?? 1e9)) best = p;
      if (best.accuracy != null && best.accuracy <= goodM) fin(resolve, best);
    };
    const finishWithBest = () => { if (best) fin(resolve, best); else fin(reject, { code: denied ? 'denied' : 'timeout' }); };
    if (signal) {
      if (signal.aborted) { reject({ code: 'cancelled' }); return; }
      signal.addEventListener('abort', () => fin(reject, { code: 'cancelled' }), { once: true });
    }
    const onErr = (err) => { if (err && err.code === 1) { denied = true; fin(reject, { code: 'denied' }); } };
    try {
      watchId = navigator.geolocation.watchPosition((pos) => take(pos, false), onErr, { enableHighAccuracy: true, timeout: watchMs + 4000, maximumAge: 0 });
    } catch { /* the quick read below still runs */ }
    navigator.geolocation.getCurrentPosition(
      (pos) => { take(pos, true); if (!done && best && best.accuracy != null && best.accuracy <= 100) fin(resolve, best); },
      onErr,
      { enableHighAccuracy: false, timeout: watchMs, maximumAge: 120000 },
    );
    timers.push(setTimeout(finishWithBest, watchMs));
    // Browsers sometimes never call back at all: stop waiting ourselves.
    timers.push(setTimeout(() => { if (!done) fin(reject, { code: best ? 'timeout' : 'unavailable' }); }, hardMs));
  });
}

const ua = () => (typeof navigator !== 'undefined' ? navigator.userAgent || '' : '');

// Plain steps to turn location on, for the device in use.
export function locationSteps() {
  const u = ua();
  if (/iPhone|iPad|iPod/i.test(u)) {
    return ['Open the iPhone Settings app.', 'Privacy & Security > Location Services: switch it On.', 'Scroll down to Safari Websites (or your browser) and choose While Using the App.', 'Come back here and tap Try again.'];
  }
  if (/Android/i.test(u)) {
    return ['Swipe down and make sure Location (GPS) is switched On.', 'In Chrome, tap the lock icon next to the web address.', 'Tap Permissions > Location > Allow.', 'Come back here and tap Try again.'];
  }
  return ['Click the lock icon next to the web address.', 'Open Site settings and set Location to Allow.', 'Reload this page, then tap Check In again.'];
}

export function locationProblemText(code) {
  if (code === 'denied') return 'Location is switched off for this site.';
  if (code === 'timeout') return 'Your location is taking too long to read.';
  if (code === 'unsupported') return 'This browser cannot share a location.';
  return 'Your location is not available right now.';
}
