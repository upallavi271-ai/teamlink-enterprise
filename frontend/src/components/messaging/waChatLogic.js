// ---------------------------------------------------------------------------
// WhatsApp chats - the PURE logic of the chat screen (no React, no network). Tested by backend/scripts/wa-chat-ui-logic-test.js.
//   * date separators and bubble grouping       groupByDay()
//   * merging polled messages / tick changes     mergeMessages()
//   * ticks                                      tickOf()
//   * the 24-hour rule                           windowInfo(), composerMode()
//   * unread numbers                             unreadSummary(), nextUnreadAfterRead()
//   * polling pace with back-off                 pollDelay()
//   * the follow-up words                        followUpWhen()
// The SERVER decides everything that matters (who may see a chat, whether a message may go); this file only decides what the screen shows.
// ---------------------------------------------------------------------------
export const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;
const IST = 'Asia/Kolkata';

const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' });
const clock = new Intl.DateTimeFormat('en-IN', { timeZone: IST, hour: 'numeric', minute: '2-digit', hour12: true });
const dayMonth = new Intl.DateTimeFormat('en-IN', { timeZone: IST, day: 'numeric', month: 'short' });
const dayMonthYear = new Intl.DateTimeFormat('en-IN', { timeZone: IST, day: 'numeric', month: 'short', year: 'numeric' });

// "2026-10-21" in India time
export const dayKey = (ms) => ymd.format(new Date(ms));
const daysBetween = (aKey, bKey) => Math.round((Date.parse(`${aKey}T00:00:00Z`) - Date.parse(`${bKey}T00:00:00Z`)) / DAY);

// The separator line between days: Today / Yesterday / 19 Oct / 19 Oct 2025
export function dayLabel(ms, now = Date.now()) {
  const d = daysBetween(dayKey(now), dayKey(ms));
  if (d === 0) return 'Today';
  if (d === 1) return 'Yesterday';
  const sameYear = dayKey(ms).slice(0, 4) === dayKey(now).slice(0, 4);
  return (sameYear ? dayMonth : dayMonthYear).format(new Date(ms));
}
// "10:05 am"
export const timeLabel = (ms) => (ms ? clock.format(new Date(ms)).replace(/[\s ]+/g, ' ').toLowerCase() : '');
// The small time on a list row: the time today, "Yesterday", else "19 Oct"
export function listTime(ms, now = Date.now()) {
  if (!ms) return '';
  const d = daysBetween(dayKey(now), dayKey(ms));
  if (d === 0) return timeLabel(ms);
  if (d === 1) return 'Yesterday';
  return dayLabel(ms, now);
}

const byTime = (a, b) => (a.at - b.at) || String(a.id).localeCompare(String(b.id));

// Messages -> the lines to draw: [{ kind:'day', key, label } | { kind:'msg', m, tight }]. `tight` = same side, within 2 minutes of the one before
// (drawn close together, WhatsApp style).
export function groupByDay(messages, now = Date.now()) {
  const sorted = [...(messages || [])].sort(byTime);
  const out = []; let lastDay = null; let prev = null;
  sorted.forEach((m) => {
    const k = dayKey(m.at);
    if (k !== lastDay) { out.push({ kind: 'day', key: k, label: dayLabel(m.at, now) }); lastDay = k; prev = null; }
    out.push({ kind: 'msg', m, tight: !!prev && prev.direction === m.direction && m.at - prev.at < 2 * 60000 });
    prev = m;
  });
  return out;
}

// `current` + what a poll brought (`incoming`) + the tick changes (`updates`) -> the new list. The same message id is never listed twice;
// a tick that moved forward (or to failed) is applied; a tick never goes back from read / delivered to sent.
const RANK = { queued: 0, sent: 1, delivered: 2, read: 3 };
export function mergeMessages(current, incoming = [], updates = []) {
  const map = new Map();
  (current || []).forEach((m) => map.set(m.id, m));
  (incoming || []).forEach((m) => {
    const had = map.get(m.id);
    map.set(m.id, had ? { ...had, ...m } : m);
  });
  (updates || []).forEach((u) => {
    const m = map.get(u.id);
    if (!m || m.direction !== 'out') return;
    if (u.state === 'failed' || (RANK[u.state] != null && (RANK[m.state] == null || RANK[u.state] >= RANK[m.state]))) {
      map.set(u.id, { ...m, state: u.state, stateWord: u.stateWord || m.stateWord, failure: u.failure || null });
    }
  });
  return [...map.values()].sort(byTime);
}

// The tick of an outgoing message.
export function tickOf(state) {
  switch (state) {
    case 'queued': return { glyph: '🕓', tone: 'grey', word: 'Waiting to send' };
    case 'sent': return { glyph: '✓', tone: 'grey', word: 'Sent' };
    case 'delivered': return { glyph: '✓✓', tone: 'grey', word: 'Delivered' };
    case 'read': return { glyph: '✓✓', tone: 'blue', word: 'Read' };
    case 'failed': return { glyph: '!', tone: 'red', word: 'Not delivered' };
    default: return { glyph: '', tone: 'grey', word: '' };
  }
}

// The 24-hour rule, in words. win = { open, until, lastInboundAt } from the server.
export function windowInfo(win, now = Date.now()) {
  if (!win) return { open: false, known: false, msLeft: 0, short: '', banner: '' };
  const until = win.until ? Number(win.until) : 0;
  const open = !!win.open && (!until || until > now);
  if (!open) {
    return {
      open: false, known: true, msLeft: 0, short: win.lastInboundAt ? 'Window closed' : 'They have not written yet',
      banner: win.lastInboundAt ? 'More than 24 hours since they wrote: you can send only an approved template.' : 'They have not written to this number yet: you can start only with an approved template.',
    };
  }
  const left = Math.max(0, until - now);
  const h = Math.floor(left / HOUR); const m = Math.floor((left % HOUR) / 60000);
  return { open: true, known: true, msLeft: left, short: h > 0 ? `${h} h ${m} min left to write freely` : `${m} min left to write freely`, banner: '' };
}

// What the composer shows: text (free words) | template (only an approved template) | blocked (nothing can be sent, with the reason) | loading.
export function composerMode(chat, now = Date.now()) {
  if (!chat) return { mode: 'loading', reason: '' };
  if (!chat.canSend && chat.blockedCode && chat.blockedCode !== 'OUTSIDE_24H') return { mode: 'blocked', reason: chat.blocked || 'Nothing can be sent to this person.' };
  const w = windowInfo(chat.window, now);
  if (!w.open) return { mode: 'template', reason: w.banner };
  return { mode: 'text', reason: '' };
}

// Chats with an unread reply, and how many replies: { chats, messages }
export function unreadSummary(rows) {
  const list = (rows || []).filter((r) => r.unread > 0);
  return { chats: list.length, messages: list.reduce((n, r) => n + r.unread, 0) };
}
// After a chat was read, the same list without its unread
export const markRowRead = (rows, key) => (rows || []).map((r) => (r.key === key ? { ...r, unread: 0 } : r));
// Opening a chat marks it read only while the screen is really being looked at and something unread is there
export const shouldMarkRead = ({ visible, unread, newIncoming }) => !!visible && (Number(unread) > 0 || !!newIncoming);

// Polling pace: the base time, doubled after each failed try (at most 8x), never more than max.
export function pollDelay(baseMs, failures = 0, maxMs = 240000) {
  const f = Math.max(0, Math.min(3, Number(failures) || 0));
  return Math.min(maxMs, baseMs * (2 ** f));
}

// "Tomorrow 10:00", "Today 16:30", "21 Oct 10:00", "Late: 2 days" for a follow-up due date (YYYY-MM-DD) and time (HH:MM)
export function followUpWhen(dueDate, dueTime, now = Date.now()) {
  if (!dueDate) return 'No date yet';
  const d = daysBetween(dueDate, dayKey(now));
  const t = dueTime ? ` ${dueTime}` : '';
  if (d < 0) return `Late: ${-d} ${-d === 1 ? 'day' : 'days'}${t}`;
  if (d === 0) return `Today${t}`;
  if (d === 1) return `Tomorrow${t}`;
  const dt = new Date(`${dueDate}T00:00:00Z`);
  const label = new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(dt);
  return `${label}${t}`;
}

export function sizeLabel(bytes) {
  const n = Number(bytes);
  if (!n || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Which words go under a list row's name for the "Sending from" line.
export const sendingFromWords = (row) => (row && row.sendingFrom ? `Sending from ${row.sendingFrom}` : '');

// A new key for one send: the same key is reused until it worked, so a double click is one message.
export function newSendKey() {
  const r = Math.random().toString(36).slice(2, 12);
  return `wc${Date.now().toString(36)}${r}`;
}
