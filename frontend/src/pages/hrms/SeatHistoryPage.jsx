import SeatHistory from '../../components/SeatHistory.jsx';

// HRMS → Positions & Seat History: who held each position, when, and who
// replaced them. The same component ATS shows under Recruiter & BDE.
export default function SeatHistoryPage() {
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Positions &amp; Seat History</h1>
          <div className="page-sub">
            Who held each position, from when to when, and who took over — with the work done from the seat in that time.
          </div>
        </div>
      </div>
      <SeatHistory />
    </div>
  );
}
