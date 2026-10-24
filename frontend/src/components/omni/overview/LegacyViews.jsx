import { Performance, Roi } from '../../outreach/Insights.jsx';
import { Reports } from '../../outreach/OverviewReports.jsx';
import Activity from '../../outreach/Activity.jsx';
import '../../broadcast/broadcast.css';
import '../../outreach/outreach.css';
import '../../outreach/omni.css';
import '../../outreach/omni2.css';

// The earlier Insights screens, kept reachable as extra Analytics tabs because our staff need them (same server routes, same role rules):
//   performance = Team performance (Admin, Department Head, Team Lead)     roi = ROI (Admin, Department Head, Team Lead, Marketing)
//   reports = Reports (everybody who may use Analytics)                    mine = My activity (everybody except Finance)
// They are loaded only when one of these tabs is opened (so their style sheets do not weigh on the Dashboard).
export default function LegacyViews({ which, acc }) {
  return (
    <div className="an-legacy">
      {which === 'performance' && <Performance acc={acc} />}
      {which === 'roi' && <Roi />}
      {which === 'reports' && <Reports acc={acc} />}
      {which === 'mine' && <Activity acc={acc} />}
    </div>
  );
}
