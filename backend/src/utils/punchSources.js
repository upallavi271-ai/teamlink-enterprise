'use strict';
// ONE place that says where a punch came from, for every attendance screen
// (user, 2026-10-13: "web check-in data kuda kanipinchali, and biometric import data kuda kanipinchali").
// Display only: nothing here changes a stored row or the day-status rules.
//
//   web        Web check-in      - the app (browser / phone / face / GPS)
//   biometric  Biometric device  - a live fingerprint / face device
//   bioimport  Biometric import  - a device punch that came in with the old HRMS (PulseHRM) log
//   pulse      Pulse import      - a first-in / last-out typed in the old HRMS report
//   hr         Typed by HR       - entered by HR in the app
// FILTER groups (what the Source filter offers): web | biometric (device + import) | pulse | hr.
const { dayCheckIn, dayCheckOut } = require('./attendanceMath');

const PULSE = 'PulseHRM import';
const LABEL = { web: 'Web check-in', biometric: 'Biometric device', bioimport: 'Biometric import', pulse: 'Pulse import', hr: 'Typed by HR' };
const GROUP = { web: 'web', biometric: 'biometric', bioimport: 'biometric', pulse: 'pulse', hr: 'hr' };
const GROUP_LABEL = { web: 'Web check-in', biometric: 'Biometric', pulse: 'Pulse import', hr: 'Typed by HR' };
const GROUPS = ['web', 'biometric', 'pulse', 'hr'];

const clockOf = (p) => p.clockTime || p.time || '';
const norm = (t) => (String(t).length === 5 ? `${t}:00` : String(t));

// One stored punch row -> a source key.
function sourceKeyOf(p) {
  const m = String(p.method || '');
  const src = String(p.source || '');
  if (src === PULSE || /import/i.test(m) || p.imputed) return /biometric/i.test(m) ? 'bioimport' : (p.imputed ? 'bioimport' : 'pulse');
  if (/manual/i.test(src)) return 'hr';
  if (/biometric|finger/i.test(m) || p.deviceVerify != null) return 'biometric';
  return 'web';
}

// How a web check-in was made, in plain words (Face / GPS / Web / Mobile).
function webMethodOf(p) {
  const m = String(p.method || '');
  if (/face/i.test(m) || p.verificationStatus === 'Verified') return 'Face';
  if (/mobile/i.test(m) || /mobile/i.test(String(p.source || ''))) return 'Mobile';
  if (/gps|location/i.test(m) || p.latitude != null) return 'GPS';
  return 'Web';
}

// The face result of a web check-in in plain words (null when the punch has none: biometric / typed / imported).
function faceTextOf(p) {
  const v = String(p.verificationStatus || '');
  if (v === 'Verified' || v === 'Face OK (HR)') return 'matched';
  if (v === 'Face not matched') return 'not matched';
  if (v === 'Face not checked') return 'not checked';
  if (v === 'Not this person (HR)') return 'not this person (HR)';
  return null;
}

// Every raw punch of one person-day, ALL sources, in time order. `history` = AttendanceHistory.punchTimes ('|' joined) when
// the old log was imported for the day; its times that no stored import row already carries are listed as Biometric import.
// firstIn / lastOut mark the punches the day engine used (dayCheckIn / dayCheckOut) — by the same rule it uses.
function rawPunchList(punches, historyTimes, lastCheckOut) {
  const ps = punches || [];
  const fin = dayCheckIn(ps);
  const lout = dayCheckOut(ps);
  const list = [];
  const importedClocks = new Set();
  ps.forEach((p) => {
    const t = clockOf(p);
    if (!t) return;
    let key = sourceKeyOf(p);
    const log = historyTimes ? String(historyTimes).split('|') : [];
    if (key === 'pulse' && log.map(norm).includes(norm(t))) key = 'bioimport'; // the same time is in the exported device log
    if (key === 'bioimport' || key === 'pulse') importedClocks.add(norm(t));
    list.push({
      id: p.id || null, time: t.slice(0, 8), direction: p.direction === 'Out' ? 'Out' : 'In',
      source: key, sourceLabel: LABEL[key], group: GROUP[key],
      method: key === 'web' ? webMethodOf(p) : (key === 'biometric' ? 'Fingerprint / face device' : (p.method || '')),
      distanceM: p.distanceM != null ? Math.round(p.distanceM) : null,
      accuracyM: p.accuracyM != null ? Math.round(p.accuracyM) : null,
      face: key === 'web' ? faceTextOf(p) : null, faceReason: key === 'web' && faceTextOf(p) !== 'matched' ? (p.livenessStatus || null) : null,
      location: p.location || null, locationStatus: p.locationStatus || null,
      usedAs: p === fin ? 'first-in' : (p === lout ? 'last-out' : ''),
    });
  });
  const log = historyTimes ? [...new Set(String(historyTimes).split('|').filter(Boolean))].sort() : [];
  log.forEach((t, i) => {
    if (importedClocks.has(norm(t))) return;
    let dir;
    if (i === 0) dir = 'In';
    else if (i === log.length - 1) dir = lastCheckOut ? 'Out' : 'In';
    else dir = (i - 1) % 2 === 0 ? 'Out' : 'In';
    list.push({ id: null, time: t.slice(0, 8), direction: dir, source: 'bioimport', sourceLabel: LABEL.bioimport, group: 'biometric',
      method: 'Imported device log', distanceM: null, location: null, locationStatus: null, usedAs: '' });
  });
  list.sort((a, b) => norm(a.time).localeCompare(norm(b.time)) || a.source.localeCompare(b.source));
  return list;
}

// { web, biometric, pulse, hr } = number of punches of each group in the list.
function countsOf(list) {
  const c = { web: 0, biometric: 0, pulse: 0, hr: 0 };
  (list || []).forEach((x) => { c[x.group] += 1; });
  return c;
}

module.exports = { LABEL, GROUP, GROUP_LABEL, GROUPS, sourceKeyOf, webMethodOf, rawPunchList, countsOf, faceTextOf };
