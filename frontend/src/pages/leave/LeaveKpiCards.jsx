import './LeaveKpiCards.css';

// ---------------------------------------------------------------------------
// HRMS item 23 — Leave → Reports: KPI cards, a quick summary of the leave
// requests the report's filters pick. Plain words, four colours:
// green done · blue going on · orange waiting · red problem. Never a bare 0.
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const round1 = (n) => Math.round(n * 10) / 10;
const daysOf = (r) => Number(r.chargedDays ?? r.days ?? 1) || 0;

export default function LeaveKpiCards({ requests }) {
  const list = Array.isArray(requests) ? requests : [];
  const today = todayIso();
  const approved = list.filter((r) => r.status === 'Approved' || r.status === 'Cancellation Requested');
  const waiting = list.filter((r) => r.status === 'Pending');
  const rejected = list.filter((r) => r.status === 'Rejected');
  const onLeaveToday = new Set(approved.filter((r) => r.fromDate <= today && (r.toDate || r.fromDate) >= today).map((r) => r.employeeId)).size;
  const daysTaken = round1(approved.reduce((n, r) => n + daysOf(r), 0));
  const cards = [
    { tone: 'green', value: approved.length, label: approved.length ? `Approved · ${daysTaken} day${daysTaken === 1 ? '' : 's'} taken` : 'Nothing approved yet' },
    { tone: 'orange', value: waiting.length, label: waiting.length ? 'Waiting for a decision' : 'None waiting' },
    { tone: 'red', value: rejected.length, label: rejected.length ? 'Rejected' : 'None rejected' },
    { tone: 'blue', value: onLeaveToday, label: onLeaveToday ? `${onLeaveToday === 1 ? 'Person' : 'People'} on leave today` : 'No one on leave today' },
  ];
  return (
    <div className="lvk-cards" role="list" aria-label="Leave summary">
      {cards.map((c) => (
        <div key={c.tone} className={`lvk-card lvk-${c.tone}`} role="listitem">
          {c.value > 0 && <div className="lvk-v">{c.value}</div>}
          <div className="lvk-l">{c.label}</div>
        </div>
      ))}
    </div>
  );
}
