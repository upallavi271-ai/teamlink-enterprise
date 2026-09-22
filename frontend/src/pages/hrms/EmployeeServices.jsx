import { useMemo, useState } from 'react';
import { useAuth } from '../../context/AuthContext.jsx';
import Helpdesk from './Helpdesk.jsx';
import Assets from './Assets.jsx';
import Announcements from './Announcements.jsx';
import Surveys from './Surveys.jsx';
import Resignation from './Resignation.jsx';
import Documents from './Documents.jsx';
import ShiftRoster from './ShiftRoster.jsx';
import Timesheet from './Timesheet.jsx';
import Expenses from './Expenses.jsx';

// The prototype's five Employee Services tabs, each with its own page head
// (servicesView, line 4466). The remaining self-service areas main carries —
// documents, shift roster, timesheet and expenses — follow them.
const PROTO_TABS = [
  ['helpdesk', 'Help Desk', 'Helpdesk', 'Track and resolve employee IT/HR/Admin/Grievance/Facilities/Payroll tickets.'],
  ['assets', 'Assets', 'Asset Management', 'Company asset inventory, allocation, transfers, maintenance and audit.'],
  ['announcements', 'Announcements', 'Announcements', 'Company-wide notice board.'],
  ['survey', 'Engagement Survey', 'Employee Engagement Surveys', 'Create pulse surveys and review aggregated results.'],
  ['resignation', 'Resignation', 'Resignation', 'Notice period, last working day, exit checklist and relieving.'],
];

const EXTRA_TABS = [
  ['documents', 'Documents', 'Documents', 'Policies, compliance documents and acknowledgements.', Documents],
  // §17 — the 5th element is a CAPABILITY KEY. Shift Roster is not shown to
  // a TL: rostering is scheduling other people, which is not theirs. This is
  // role-based visibility, not deletion — the screen and its route are
  // untouched for the roles that own it.
  ['shift', 'Shift Roster', 'Shift & Roster', 'Shift patterns and who is rostered on which day.', ShiftRoster, 'shiftRoster'],
  ['timesheet', 'Timesheet', 'Timesheet', 'Track and assign work across your team — create a task, assign it, and follow it to done.', Timesheet],
  ['expenses', 'Expense Claims', 'Expense & Travel Claims', 'Claims, approvals and reimbursement.', Expenses],
];

export default function EmployeeServices() {
  const { user } = useAuth();
  const [tab, setTab] = useState('helpdesk');
  // Which feature-tile screen is open, per tab — the prototype's svcView.
  const [view, setView] = useState(null);

  // §17 — SHIFT ROSTER IS NOT SHOWN TO A TL. Rostering is scheduling other
  // people; a TL leads a team but does not set the roster. Role-based
  // visibility, not deletion: the tab, the screen and the API are all intact
  // for the roles that own it.
  const isTl = (user && (user.productRoles ? user.productRoles.hrms : user.hrmsRole)) === 'TL';
  const extraTabs = useMemo(
    () => EXTRA_TABS.filter(([, , , , , cap]) => !(cap === 'shiftRoster' && isTl)),
    [isTl],
  );

  function selectTab(k) { setTab(k); setView(null); }
  const open = (key) => setView(key);
  const back = () => setView(null);

  const proto = PROTO_TABS.find(([k]) => k === tab);
  const extra = extraTabs.find(([k]) => k === tab);
  // A TL who arrives on the hidden tab by URL gets the first tab, not a crash.
  const chosen = proto || extra || PROTO_TABS[0];
  const [, , title, sub] = chosen;

  let body = null;
  if (tab === 'helpdesk') body = <Helpdesk view={view} onOpen={open} onBack={back} />;
  else if (tab === 'assets') body = <Assets view={view} onOpen={open} onBack={back} />;
  else if (tab === 'announcements') body = <Announcements view={view} onOpen={open} onBack={back} />;
  else if (tab === 'survey') body = <Surveys view={view} onOpen={open} onBack={back} />;
  else if (tab === 'resignation') body = <Resignation />;
  else if (extra) { const C = extra[4]; body = <C />; }

  return (
    <div>
      <div className="page-head"><div><h1>{title}</h1><div className="page-sub">{sub}</div></div></div>
      <div className="tabbar">
        {[...PROTO_TABS, ...extraTabs].map(([k, label]) => (
          <button key={k} className={'tab-btn' + (tab === k ? ' active' : '')} onClick={() => selectTab(k)}>{label}</button>
        ))}
      </div>
      <div className="tab-content">{body}</div>
    </div>
  );
}
