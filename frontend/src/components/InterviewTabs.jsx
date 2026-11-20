import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { INTERVIEW_TABS, INTERVIEW_PATHS, visibleItems } from '../nav';
import TabStrip from './ui/TabStrip.jsx';

// Tabs of ATS → Interview Calendar: Interviews · Feedback · Offers · Joining
// (user, 2026-10-03: "side bar lo extra modules add cheyyodhu" — fold the
// workflow screens into the existing module). Shown only on those four pages;
// each tab follows its page's own view permission (nav.js INTERVIEW_TABS).
// 2026-11-20 (founder: "give clear tabs"): the one TabStrip, a tooltip on each tab and a line saying what it is for.
// Each tab is still its own address.
const SAY = {
  '/ats/calendar': 'Interviews by day: book, move or cancel one, and see who has an interview today.',
  '/ats/interview-feedback': 'Interviews that are over: record the result and decide the next step.',
  '/ats/offers': 'Offers after a selection: prepare, approve, send, and see who accepted.',
  '/ats/joining': 'People who accepted, until their first day; joined and dropped.',
};
export default function InterviewTabs({ pathname }) {
  const { user } = useAuth() || {};
  const navigate = useNavigate();
  if (!INTERVIEW_PATHS.includes(pathname)) return null;
  const tabs = visibleItems(user, INTERVIEW_TABS);
  if (tabs.length < 2) return null;
  return (
    <div className="module-tabs" style={{ marginBottom: 14 }}>
      <TabStrip
        label="Interview Calendar"
        value={pathname}
        onChange={(to) => navigate(to)}
        maxMain={5}
        tabs={tabs.map((t) => ({ key: t.to, label: t.label, hint: SAY[t.to] || t.label }))}
      />
    </div>
  );
}
