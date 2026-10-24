// ---------------------------------------------------------------------------
// QUIET HOURS (Omni-Channel > Settings > Sending rules): never send at night. India time (IST, UTC+5:30) only.
//   setting  outreach.settings.quietHours = { enabled (DEFAULT OFF), start 'HH:MM' (default 21:00), end 'HH:MM' (default 08:00), applyInternal (default false) }
//   window   start <= time < end; when start is later than end the window runs over midnight (21:00 to 08:00). At exactly the START it is quiet,
//            at exactly the END it is not. start === end is refused (it would mean "all day" or "never").
//   who      job promotions on every channel. Internal (HR) messages are exempt unless "Apply to internal messages too" is ticked.
// Everything here is PURE (no database) so the runner, the send path, the pre-send check and the scheduled-message engine all use one decision.
// ---------------------------------------------------------------------------
const IST = 5.5 * 3600 * 1000;
const DAY = 86400000;
const DEFAULTS = { enabled: false, start: '21:00', end: '08:00', applyInternal: false };
const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const minutesOf = (hm) => { const m = HM.exec(String(hm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const istDayStart = (ms) => Math.floor((ms + IST) / DAY) * DAY - IST;
const minuteOfDayIST = (ms) => Math.floor((((ms + IST) % DAY) + DAY) % DAY / 60000);

// a safe object from whatever is stored (bad values fall back to the defaults; OFF stays OFF)
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  let start = HM.test(String(r.start || '')) ? r.start : DEFAULTS.start;
  let end = HM.test(String(r.end || '')) ? r.end : DEFAULTS.end;
  if (start === end) { start = DEFAULTS.start; end = DEFAULTS.end; }
  return { enabled: r.enabled === true, start, end, applyInternal: r.applyInternal === true };
}
// an Admin's input -> { value } | { error }
function validate(input, current) {
  const cur = normalize(current);
  const b = input && typeof input === 'object' ? input : {};
  const next = { ...cur };
  if (b.start !== undefined) { if (!HM.test(String(b.start))) return { error: 'Quiet hours start must be a time like 21:00.' }; next.start = b.start; }
  if (b.end !== undefined) { if (!HM.test(String(b.end))) return { error: 'Quiet hours end must be a time like 08:00.' }; next.end = b.end; }
  if (next.start === next.end) return { error: 'The start and the end of quiet hours cannot be the same time.' };
  if (b.enabled !== undefined) next.enabled = b.enabled === true;
  if (b.applyInternal !== undefined) next.applyInternal = b.applyInternal === true;
  return { value: next };
}

// is this minute of the day (0..1439) inside the window?
function inWindow(min, start, end) {
  const s = minutesOf(start); const e = minutesOf(end);
  if (s == null || e == null || s === e) return false;
  return s < e ? (min >= s && min < e) : (min >= s || min < e);
}
// does quiet hours apply to this kind of campaign at all?
const applies = (q, type) => { const n = normalize(q); return n.enabled && (type !== 'internal' || n.applyInternal); };

// the state at `now`: { active, resumeAt (ms, when it ends), endLabel ('08:00'), words }
function state(now, q, type = 'job_promotion') {
  const n = normalize(q);
  if (!applies(n, type)) return { active: false, applies: false, endLabel: n.end, resumeAt: null, words: '' };
  const active = inWindow(minuteOfDayIST(now), n.start, n.end);
  if (!active) return { active: false, applies: true, endLabel: n.end, resumeAt: null, words: '' };
  const endMin = minutesOf(n.end);
  let resumeAt = istDayStart(now) + endMin * 60000;
  if (resumeAt <= now) resumeAt += DAY;
  return { active: true, applies: true, endLabel: n.end, resumeAt, words: `Waiting for quiet hours to end (${n.end})` };
}
// a time a campaign was scheduled for -> the time it should really start (the end of quiet hours when it falls inside them)
function moveOutOfQuiet(at, q, type = 'job_promotion') {
  const s = state(at, q, type);
  return s.active ? { at: s.resumeAt, moved: true, endLabel: s.endLabel } : { at, moved: false, endLabel: s.endLabel };
}
// one plain sentence for the Settings screen and the pre-send check
function describe(q) {
  const n = normalize(q);
  return n.enabled ? `Quiet hours are ON: no promotion messages are sent from ${n.start} to ${n.end} (India time).${n.applyInternal ? ' Messages to staff wait too.' : ' Messages to staff are not held.'}` : 'Quiet hours are OFF: messages can go out at any hour.';
}

module.exports = { DEFAULTS, normalize, validate, inWindow, applies, state, moveOutOfQuiet, describe, minuteOfDayIST, istDayStart, minutesOf, IST, DAY };
