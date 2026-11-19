// ---------------------------------------------------------------------------
// WHERE A NOTIFICATION LEADS (founder 2026-11-18: "click a notification and it must go straight to where it belongs").
//
// ONE place decides, so the bell, Mobile Home, the Dashboard list, the Organization Chart list and the Notifications page all open the same screen:
//   1. an announcement            opens that announcement (Employee Services)
//   2. a last line "Open: /path"  opens that screen (written by utils/notify.js `open`, by the CRM, Join & Drop, journeys ...); the line is hidden from the text
//   3. an older line that has no such line: the screen its TITLE is about (a short, careful list below - a missing check-in opens Attendance,
//      a late task opens the Timesheet ...). A title the list does not know leads nowhere (the caller then opens the full Notifications list).
// Never a link to another site: only paths of this app (starting with one "/").
// ---------------------------------------------------------------------------
const ANN_PREFIX = 'Announcement: ';
// "Open: /path" as the last line, or inline at the end of a sentence ("... Open: /crm/leads?open=lead:1")
const OPEN_RE = /(?:^|\s)Open: (\/(?!\/)[^\s]+)\s*$/;

const labelOfPath = (to) => {
  const p = String(to || '').split('?')[0];
  const rules = [
    [/^\/open\/chat\//, 'Open the chat'], [/^\/admin\/org-chart/, 'Open the chat'], [/^\/candidates\/[^/]+/, 'Open the candidate'], [/^\/candidates/, 'Open candidates'],
    [/^\/requirements\/[^/]+/, 'Open the requirement'], [/^\/requirements/, 'Open requirements'], [/^\/clients\/[^/]+/, 'Open the client'], [/^\/clients/, 'Open clients'],
    [/^\/invoices\/[^/]+/, 'Open the invoice'], [/^\/invoices/, 'Open invoices'], [/^\/crm\//, 'Open in CRM'], [/^\/ats\/followups|view=followups/, 'Open follow-ups'],
    [/^\/ats\/calendar/, 'Open interviews'], [/^\/ats\/offers/, 'Open offers'], [/^\/ats\/joining/, 'Open joining'], [/^\/timesheet/, 'Open my tasks'],
    [/^\/attendance/, 'Open attendance'], [/^\/leave/, 'Open leave'], [/^\/payroll/, 'Open payroll'], [/^\/employee-services/, 'Open announcements'],
    [/^\/agreements/, 'Open agreements'], [/^\/admin\/notifications/, 'Open notifications'],
  ];
  const hit = rules.find(([re]) => re.test(p) || re.test(String(to)));
  return hit ? hit[1] : 'Open';
};

// the title -> screen list for notifications written before they carried a destination. Careful: a wrong guess is worse than none.
const BY_TITLE = [
  [/missing check-?(in|out)|early logout|\blate (check-?in|arrival)\b|^late\b/i, '/attendance'],
  [/task (overdue|due today)|tasks? (is|are) late|tasks? you gave|new task from|of your tasks/i, '/timesheet'],
  [/\bcrm\b.*follow-?ups?|follow-?ups?.*\bcrm\b/i, '/crm/followups'],
  [/whatsapp reply/i, '/ats/followups?sub=chats'],
  [/follow-?up/i, '/ats/followups'],
  [/interview/i, '/ats/calendar'],
  [/\boffer\b/i, '/ats/offers'],
  [/\bjoining\b|\bdropped\b|\breplacement\b/i, '/ats/joining'],
  [/\bleave\b/i, '/leave'],
  [/payslip|payroll|salary/i, '/payroll'],
  [/invoice|payment proofs?/i, '/invoices'],
  [/agreement/i, '/agreements'],
  [/requirement|\bREQ-\d/i, '/requirements'],
  [/application from the job portal|\bcandidate\b/i, '/candidates'],
];

export function noteTarget(n) {
  if (!n) return null;
  const title = String(n.title || '');
  if (title.startsWith(ANN_PREFIX)) {
    const to = `/employee-services?tab=announcements&open=${encodeURIComponent(title.slice(ANN_PREFIX.length))}&at=${encodeURIComponent(n.createdAt || '')}`;
    return { to, label: 'Open the announcement', exact: true };
  }
  const open = (String(n.message || '').match(OPEN_RE) || [])[1];
  if (open) return { to: open, label: labelOfPath(open), exact: true };
  const guess = BY_TITLE.find(([re]) => re.test(title));
  return guess ? { to: guess[1], label: labelOfPath(guess[1]), exact: false } : null;
}

// the words of a notification without its "Open: /path" tail
export const noteText = (m) => String(m || '').replace(OPEN_RE, '');
export const noteLink = (n) => { const t = noteTarget(n); return t ? t.to : null; };

// "5 min ago", "2 h ago", "Yesterday", "12 Nov"
export function ago(d, now = Date.now()) {
  const t = new Date(d).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return 'Yesterday';
  return new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}
