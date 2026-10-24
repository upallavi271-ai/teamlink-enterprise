// ---------------------------------------------------------------------------
// Check-in geofence: one MAIN office (HrConfig: officeLatitude / officeLongitude
// / geofenceRadiusM, named by AppSetting "attendance.officeName" or the company
// name) plus any number of OTHER offices (AppSetting "attendance.offices", a
// JSON list of { name, latitude, longitude, radiusM }). A reading is inside when
// it is inside ANY of them. When it is outside everywhere, the NEAREST office
// is the one named to the person, with the exact distance in plain words.
//
// Pure functions at the bottom (haversine, check, distanceText, outsideMessage)
// are unit-tested; loadOffices() is the only part that touches the database.
// ---------------------------------------------------------------------------

const prisma = require('../db');

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// "340 m" under a kilometre, "1.2 km" above.
function distanceText(m) {
  const d = Number(m);
  if (!Number.isFinite(d)) return '';
  if (d < 1000) return `${Math.max(0, Math.round(d))} m`;
  return `${(d / 1000).toFixed(1)} km`;
}

async function setting(key) {
  const row = await prisma.appSetting.findUnique({ where: { key } }).catch(() => null);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

const validOffice = (o) => o && Number.isFinite(Number(o.latitude)) && Number.isFinite(Number(o.longitude))
  && Math.abs(Number(o.latitude)) <= 90 && Math.abs(Number(o.longitude)) <= 180;

function cleanOffices(list) {
  return (Array.isArray(list) ? list : []).filter(validOffice).slice(0, 20).map((o) => ({
    name: String(o.name || 'Office').trim().slice(0, 60) || 'Office',
    latitude: Number(o.latitude),
    longitude: Number(o.longitude),
    radiusM: Math.max(20, Math.min(100000, Math.round(Number(o.radiusM) || 200))),
  }));
}

// { enabled, offices:[{name,latitude,longitude,radiusM,main}], mainName }
async function loadOffices(cfg) {
  const enabled = !!cfg.geofenceEnabled;
  const extra = cleanOffices(await setting('attendance.offices'));
  let mainName = await setting('attendance.officeName');
  if (typeof mainName !== 'string' || !mainName.trim()) {
    const company = await prisma.company.findFirst({ select: { name: true } }).catch(() => null);
    mainName = company && company.name ? company.name : 'the office';
  }
  const offices = [];
  if (cfg.officeLatitude != null && cfg.officeLongitude != null) {
    offices.push({ name: String(mainName), latitude: cfg.officeLatitude, longitude: cfg.officeLongitude, radiusM: cfg.geofenceRadiusM, main: true });
  }
  extra.forEach((o) => offices.push({ ...o, main: false }));
  return { enabled, offices, mainName: String(mainName) };
}

// A reading counts as inside an office when, allowing for the phone's own stated
// GPS accuracy (the circle of doubt around the reading), that circle touches the
// office's allowed circle: distance - accuracy <= allowed distance.
//   opts.accuracyCounts (default true)  - switch the allowance off to judge the dot alone
//   opts.accuracyCapM   (default 300)   - the most accuracy that is ever allowed for (was a fixed 100)
// The dot itself inside the allowed distance is ALWAYS accepted, however poor the accuracy.
function check({ enabled, offices }, lat, lng, accuracy, opts = {}) {
  if (!enabled || !offices || !offices.length) {
    return { inside: true, status: 'No geofence configured', distance: null, office: null, radiusM: null, others: [], accuracyM: accuracy ?? null, weakGps: false, lowAccuracy: false, swapped: false };
  }
  const counts = opts.accuracyCounts !== false;
  const cap = Math.max(0, Number(opts.accuracyCapM ?? 300));
  const slack = counts ? Math.min(Math.max(0, accuracy || 0), cap) : 0;
  const list = offices
    .map((o) => ({ ...o, distance: haversine(o.latitude, o.longitude, lat, lng) }))
    .sort((a, b) => a.distance - b.distance);
  const hit = list.find((o) => o.distance - slack <= o.radiusM);
  const near = hit || list[0];
  const others = list.filter((o) => o !== near).map((o) => ({ name: o.name, distance: Math.round(o.distance), radiusM: o.radiusM, latitude: o.latitude, longitude: o.longitude }));
  // Office latitude / longitude typed the wrong way round: the reading would be inside with them swapped.
  const swapped = !hit && list.some((o) => Math.abs(o.longitude) <= 90 && Math.abs(o.latitude) <= 180
    && haversine(o.longitude, o.latitude, lat, lng) <= o.radiusM);
  return {
    inside: !!hit,
    status: hit ? 'Inside geofence' : 'Outside geofence',
    distance: Math.round(near.distance),
    office: { name: near.name, latitude: near.latitude, longitude: near.longitude },
    radiusM: near.radiusM,
    others,
    accuracyM: accuracy ?? null,
    // A GPS reading worse than the allowed radius cannot prove much: a warning only, never a refusal on its own.
    weakGps: accuracy != null && accuracy > near.radiusM,
    lowAccuracy: accuracy != null && accuracy > 100,
    swapped,
  };
}

function outsideMessage(fence, direction = 'In') {
  const verb = direction === 'Out' ? 'check out' : 'check in';
  return `You are about ${distanceText(fence.distance)} from ${fence.office.name}. Allowed: ${distanceText(fence.radiusM)} to ${verb}.${fence.swapped ? ' (The office latitude and longitude may be typed the wrong way round - ask Admin to check.)' : ''}`;
}

// Basic sanity flags, never a refusal: a GPS that claims to be perfect (a spoofing app often says 0-1 m) or a jump that
// is faster than any vehicle since this person's previous web punch. prev = { latitude, longitude, at:Date|ms } or null.
function spoofFlags({ accuracy, lat, lng, prev, now = Date.now() }) {
  const flags = [];
  if (accuracy != null && accuracy >= 0 && accuracy < 1) flags.push('GPS accuracy looks too perfect');
  if (prev && Number.isFinite(prev.latitude) && Number.isFinite(prev.longitude)) {
    const secs = Math.max(1, (now - new Date(prev.at).getTime()) / 1000);
    const m = haversine(prev.latitude, prev.longitude, lat, lng);
    if (m > 2000 && m / secs > 70) flags.push(`Location jumped ${distanceText(m)} in ${Math.round(secs / 60)} min`);
  }
  return flags;
}

// What the screen needs: where the offices are (so it can show the distance at
// once, before the camera opens). Names + coordinates + radius only.
function publicOffices({ enabled, offices }) {
  return { enabled, offices: (offices || []).map((o) => ({ name: o.name, latitude: o.latitude, longitude: o.longitude, radiusM: o.radiusM })) };
}

module.exports = { haversine, distanceText, loadOffices, cleanOffices, check, outsideMessage, spoofFlags, publicOffices, setting };
