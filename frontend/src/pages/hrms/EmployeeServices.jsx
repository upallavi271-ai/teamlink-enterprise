import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import Helpdesk from './Helpdesk.jsx';
import Assets from './Assets.jsx';
import Stationery from './Stationery.jsx';
import Announcements from './Announcements.jsx';
import Surveys from './Surveys.jsx';
import Resignation from './Resignation.jsx';
import Documents from './Documents.jsx';
import ShiftRoster from './ShiftRoster.jsx';
import Timesheet from './Timesheet.jsx';
import Expenses from './Expenses.jsx';
import './employee-services-kind.css';

// The prototype's five Employee Services tabs, each with its own page head
// (servicesView, line 4466). The remaining self-service areas main carries —
// documents, shift roster, timesheet and expenses — follow them.
const PROTO_TABS = [
  ['helpdesk', 'Help Desk', 'Helpdesk', 'Track and resolve employee IT/HR/Admin/Grievance/Facilities/Payroll tickets.'],
  // ONE tab for both (user, 2026-10-09): Assets, and Stationery (counted things
  // like notepads and pens - pages/hrms/Stationery.jsx) behind a switch inside it.
  ['assets', 'Assets', 'Assets & Stationery', 'Things the company owns (laptops, SIMs, headsets) and things that get used up (notepads, pens): who has what, repairs, stock.'],
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
  // Inside the Assets tab: Assets | Stationery.
  const [kind, setKind] = useState('assets');
  // Which feature-tile screen is open, per tab — the prototype's svcView.
  const [view, setView] = useState(null);
  // ?tab=announcements — a notification links straight to a tab.
  const [params] = useSearchParams();
  const urlTab = params.get('tab');
  useEffect(() => {
    // The old ?tab=stationery address lands on Assets with the Stationery switch on.
    if (urlTab === 'stationery') { setTab('assets'); setKind('stationery'); setView(null); return; }
    if (urlTab && [...PROTO_TABS, ...EXTRA_TABS].some(([k]) => k === urlTab)) { setTab(urlTab); setView(null); if (urlTab === 'assets') setKind('assets'); }
  }, [urlTab, params]);

  // §17 — SHIFT ROSTER IS NOT SHOWN TO A TL. Rostering is scheduling other
  // people; a TL leads a team but does not set the roster. Role-based
  // visibility, not deletion: the tab, the screen and the API are all intact
  // for the roles that own it.
  const isTl = (user && (user.productRoles ? user.productRoles.hrms : user.hrmsRole)) === 'TL';
  const extraTabs = useMemo(
    () => EXTRA_TABS.filter(([, , , , , cap]) => !(cap === 'shiftRoster' && isTl)),
    [isTl],
  );

  function selectTab(k) { setTab(k); setView(null); if (k === 'assets') setKind('assets'); }
  function selectKind(k) { setKind(k); setView(null); }
  const open = (key) => setView(key);
  const back = () => setView(null);

  const proto = PROTO_TABS.find(([k]) => k === tab);
  const extra = extraTabs.find(([k]) => k === tab);
  // A TL who arrives on the hidden tab by URL gets the first tab, not a crash.
  const chosen = proto || extra || PROTO_TABS[0];
  const [, , title0, sub0] = chosen;
  const stationeryOn = tab === 'assets' && kind === 'stationery';
  const title = stationeryOn ? 'Stationery' : title0;
  const sub = stationeryOn ? 'Notepads, pens and other office things — how many each person got.' : sub0;

  let body = null;
  if (tab === 'helpdesk') body = <Helpdesk view={view} onOpen={open} onBack={back} />;
  else if (tab === 'assets') body = kind === 'stationery' ? <Stationery /> : <Assets view={view} onOpen={open} onBack={back} />;
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
      {/* Assets and Stationery are two kinds of "things" in ONE place: pick which. */}
      {tab === 'assets' && (
        <div className="es-kind" role="group" aria-label="Which kind of thing">
          <button type="button" className={`es-kind-btn${kind === 'assets' ? ' on' : ''}`} onClick={() => selectKind('assets')}>
            <b>Assets</b><span>Things the company owns and tracks one by one: laptops, SIM cards, mouse, headsets</span>
          </button>
          <button type="button" className={`es-kind-btn${kind === 'stationery' ? ' on' : ''}`} onClick={() => selectKind('stationery')}>
            <b>Stationery</b><span>Things that get used up and are counted: notepads, pens</span>
          </button>
        </div>
      )}
      <div className="tab-content">{body}</div>
    </div>
  );
}
