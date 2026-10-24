import './noticeDays.css';

// ---------------------------------------------------------------------------
// THE NOTICE PERIOD, DAY BY DAY (founder, 2026-10-23): "Day 12 of 45 · 33 days left" and a thin bar, from the resignation date to the last working day.
// `notice` is what the server sends (utils/noticeAutoExit.js progressOf): { day, total, left, state: serving | last-day | over, pct, last }.
// When the days are done the person moves to Exit (Relieved) by itself, the day after the last working day.
// ---------------------------------------------------------------------------
const lwdLabel = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

export default function NoticeDays({ notice, block = false }) {
  if (!notice) return null;
  const { day, total, left, state, pct } = notice;
  const text = state === 'over'
    ? 'Notice complete: moving to Exit'
    : state === 'last-day'
      ? `Last working day is today (day ${total} of ${total})`
      : `Day ${day} of ${total} · ${left} day${left === 1 ? '' : 's'} left`;
  return (
    <div className={`nd${block ? ' nd-block' : ''} nd-${state}`} title={`Notice from ${lwdLabel(notice.from)} to ${lwdLabel(notice.last)}. When the days are complete the person goes to Exit by itself.`}>
      <div className="nd-t">{text}</div>
      <div className="nd-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={day} aria-label="Notice days served"><span style={{ width: `${pct}%` }} /></div>
    </div>
  );
}
