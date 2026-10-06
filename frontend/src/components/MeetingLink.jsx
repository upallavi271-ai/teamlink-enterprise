// ---------------------------------------------------------------------------
// Meeting links on announcements (2026-10-03).
//
// The API returns `meetingLink` / `meetingWhen` on an announcement
// (backend/src/routes/announcements.js keeps them in the row's `delivery`
// JSON). The in-app notification has no link column, so its message ends
// with a readable line "Join meeting: https://..." — splitMeeting() pulls
// that line back out so the bell can show it as a button.
//
// Only http(s) links are ever turned into a link, and they always open in a
// new tab with rel="noopener noreferrer".
// ---------------------------------------------------------------------------
import './MeetingLink.css';

export function safeMeetingUrl(raw) {
  const v = String(raw || '').trim();
  if (!/^https?:\/\//i.test(v) || /\s/.test(v)) return null;
  try {
    const u = new URL(v);
    return ['http:', 'https:'].includes(u.protocol) && u.hostname ? u.href : null;
  } catch {
    return null;
  }
}

// The form's check — the same words the server answers with.
export function meetingLinkError(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  return safeMeetingUrl(v) ? '' : 'Meeting link must start with https://';
}

const JOIN_LINE = /(?:^|\n)Join meeting: (\S+)[ \t]*$/;
// { text, link } — text without the "Join meeting:" line, link only if safe.
export function splitMeeting(message) {
  const m = String(message || '');
  const hit = m.match(JOIN_LINE);
  if (!hit) return { text: m, link: null };
  const link = safeMeetingUrl(hit[1]);
  if (!link) return { text: m, link: null };
  return { text: m.slice(0, hit.index).replace(/\s+$/, ''), link };
}

export function JoinMeeting({ href, small = false, when }) {
  const url = safeMeetingUrl(href);
  if (!url) return null;
  return (
    <span className={`mtg-join${small ? ' mtg-small' : ''}`}>
      <a className="mtg-btn" href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
        Join meeting
      </a>
      {when && <span className="mtg-when">{when}</span>}
    </span>
  );
}
