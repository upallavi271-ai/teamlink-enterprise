import { Routes, Route, Navigate } from 'react-router-dom';
import Shell from './components/Shell.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';

import Requirements from './pages/Requirements.jsx';
import RequirementDetail from './pages/RequirementDetail.jsx';
import ClientJobPortal from './pages/ats/ClientJobPortal.jsx';
import Clients from './pages/Clients.jsx';
import ClientDetail from './pages/ClientDetail.jsx';
import ClientDuplicates from './pages/ClientDuplicates.jsx';
import Agreements from './pages/Agreements.jsx';
import Candidates from './pages/Candidates.jsx';
import CandidateDetail from './pages/CandidateDetail.jsx';
import CandidateDuplicates from './pages/CandidateDuplicates.jsx';
import CandidateHome from './pages/CandidateHome.jsx';
import AtsDashboard from './pages/ats/AtsDashboard.jsx';
import Team from './pages/ats/Team.jsx';
import FollowUps from './pages/ats/FollowUps.jsx';
import InterviewCalendar from './pages/ats/InterviewCalendar.jsx';
import InterviewFeedback from './pages/ats/InterviewFeedback.jsx';
import Offers from './pages/ats/Offers.jsx';
import Joining from './pages/ats/Joining.jsx';
import AtsWorkflow from './pages/ats/AtsWorkflow.jsx';
import Search from './pages/ats/Search.jsx';
import AccountsDashboard from './pages/AccountsDashboard.jsx';

import Employees from './pages/Employees.jsx';
import EmployeeDetail from './pages/EmployeeDetail.jsx';
import Attendance from './pages/Attendance.jsx';
import Leave from './pages/Leave.jsx';
import Payroll from './pages/Payroll.jsx';
import HrmsDashboard from './pages/hrms/HrmsDashboard.jsx';
import PerformanceDevelopment from './pages/hrms/PerformanceDevelopment.jsx';
import EmployeeServices from './pages/hrms/EmployeeServices.jsx';
import Timesheet from './pages/hrms/Timesheet.jsx';
import MyProfile from './pages/hrms/MyProfile.jsx';
import OrgStructure from './pages/admin/OrgStructure.jsx';

import Invoices from './pages/Invoices.jsx';
import InvoiceDetail from './pages/InvoiceDetail.jsx';
import Bank from './pages/Bank.jsx';
import Office from './pages/Office.jsx';
import JournalLedger from './pages/accounts/JournalLedger.jsx';

import AtsReports, { AtsReportsRedirect } from './pages/reports/AtsReports.jsx';
import JobPortalReports from './pages/reports/JobPortalReports.jsx';
import AccountsReports from './pages/reports/AccountsReports.jsx';

import CompanySetup from './pages/admin/CompanySetup.jsx';
import Departments from './pages/admin/Departments.jsx';
import Positions from './pages/admin/Positions.jsx';
import Users from './pages/admin/Users.jsx';
import RoleCatalog from './pages/admin/RoleCatalog.jsx';
import Integrations from './pages/admin/Integrations.jsx';
import Notifications from './pages/admin/Notifications.jsx';
import AuditLogs from './pages/admin/AuditLogs.jsx';
import Profile from './pages/admin/Profile.jsx';

import Careers from './pages/Careers.jsx';
import JobPortalRedirect from './pages/JobPortalRedirect.jsx';
import JobDetail from './pages/JobDetail.jsx';
import MyApplications from './pages/MyApplications.jsx';
import AgreementSigning from './pages/AgreementSigning.jsx';
import AgreementView from './pages/AgreementView.jsx';
import SetPassword from './pages/SetPassword.jsx';
import HomeRoute from './pages/home/HomeRoute.jsx';
// Super Admin "View as" (read-only): the picker and the banner on every page.
import ViewAsPicker from './pages/admin/ViewAsPicker.jsx';
import { ViewAsBanner } from './components/ViewAs.jsx';

export default function App() {
  return (
    <>
    <ViewAsBanner />
    <Routes>
      <Route path="/login" element={<Login />} />

      {/* Public home page. A logged-out "/" shows it too (ProtectedRoute). */}
      <Route path="/home" element={<HomeRoute />} />

      {/* Public Job Portal — no login required.
          /job-portal/ is the stable route for the real TeamLink Job Portal (the
          self-contained app served from frontend/public/job-portal/index.html).
          This React route only catches the no-trailing-slash form; see
          JobPortalRedirect.jsx. /careers is kept as an alias of it so that
          existing "Job Portal (public)" links land on the real portal, while the
          database-backed careers list still lives at /careers/classic and its
          deep links (/careers/:id, /careers/my-applications) are untouched. */}
      <Route path="/job-portal" element={<JobPortalRedirect />} />
      <Route path="/careers" element={<JobPortalRedirect />} />
      <Route path="/careers/classic" element={<Careers />} />
      <Route path="/careers/my-applications" element={<MyApplications />} />
      <Route path="/careers/:id" element={<JobDetail />} />

      {/* Client-facing agreement signing link — no login, token is the key */}
      <Route path="/agreement/:token" element={<AgreementSigning />} />

      {/* New employee sign-in link — single-use, expiring, no login required */}
      <Route path="/set-password/:token" element={<SetPassword />} />

      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Shell />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />

        {/* HRMS — matches the prototype's 6-item sidebar; the long tail of
            sub-features lives as tabs inside Performance & Development and
            Employee Services (see those two pages). */}
        <Route path="hrms" element={<HrmsDashboard />} />
        {/* Moved to Administration -> Positions & Seat History (Seat History tab). */}
        <Route path="hrms/seat-history" element={<Navigate to="/admin/positions?tab=history" replace />} />
        <Route path="employees" element={<Employees />} />
        <Route path="employees/:id" element={<EmployeeDetail />} />
        <Route path="attendance" element={<Attendance />} />
        <Route path="leave" element={<Leave />} />
        <Route path="payroll" element={<Payroll />} />
        <Route path="performance" element={<PerformanceDevelopment />} />
        <Route path="employee-services" element={<EmployeeServices />} />
        {/* Timesheet is a tab of Employee Services AND a screen of its own, so
            it stays bookmarkable — the same convention Agreements, Offers and
            Joining follow. It is not listed in the sidebar, which keeps the
            prototype's six HRMS entries. */}
        <Route path="timesheet" element={<Timesheet standalone />} />
        <Route path="my-profile" element={<MyProfile />} />

        {/* ATS */}
        <Route path="requirements" element={<Requirements />} />
        {/* The Job Portal is candidate INTAKE (2026-09-29): its applications /
            screening / Send to ATS view is Candidates & Pipeline → Job Portal
            Candidates. The old workspace URL redirects there. A static
            segment, so it is matched ahead of requirements/:id. */}
        <Route path="requirements/job-portal" element={<Navigate to="/candidates?view=job-portal" replace />} />
        <Route path="requirements/:id" element={<RequirementDetail />} />
        {/* The CLIENT-facing view is a DIFFERENT screen on a different route
            with a different permission (requirements/Client Job Portal), so a
            client can never land on the internal workspace above. */}
        <Route path="client-portal" element={<ClientJobPortal />} />
        {/* Clients · Requirements · Agreements · Job Portal are one module;
            each tab keeps its own route so it stays bookmarkable. Job Portal
            is another agent's screen — see components/ClientModuleTabs.jsx. */}
        <Route path="clients" element={<Clients />} />
        <Route path="clients/duplicates" element={<ClientDuplicates />} />
        <Route path="clients/:id" element={<ClientDetail />} />
        <Route path="agreements" element={<Agreements />} />
        {/* One agreement: client login, its BDE, Accounts, Admin (routes/agreementSeal.js decides). */}
        <Route path="agreements/:clientId" element={<AgreementView />} />
        <Route path="candidates" element={<Candidates />} />
        <Route path="candidates/duplicates" element={<CandidateDuplicates />} />
        <Route path="candidates/:id" element={<CandidateDetail />} />
        {/* Where a signed-in candidate lands (identity.js WORKSPACE_HOME).
            The route did not exist, so logging in as one hit a dead page. */}
        <Route path="my-applications" element={<CandidateHome />} />
        <Route path="ats/team" element={<Team />} />
        {/* NOT a seventh sidebar module (§1) — Follow-ups is reached from the
            ATS Dashboard and from Recruiter & BDE, which is where §31/§32 put
            it. Routed so those links have somewhere to go. */}
        <Route path="ats/followups" element={<FollowUps />} />
        <Route path="ats/calendar" element={<InterviewCalendar />} />
        {/* Interviews & Joining: Interview Calendar (above) - Interview Feedback
            - Offers - Joining - Internal Hiring */}
        <Route path="ats/interview-feedback" element={<InterviewFeedback />} />
        <Route path="ats/offers" element={<Offers />} />
        <Route path="ats/joining" element={<Joining />} />
        {/* Internal Hiring is NOT a separate module (the user's rule, 2026-09-29):
            it runs inside Jobs / Requirements and Candidates. Old links land on
            the internal requirements. */}
        <Route path="ats/internal-hiring" element={<Navigate to="/requirements?type=internal" replace />} />
        {/* The actual workflow with live counts per box (ATS Dashboard "See workflow"). */}
        <Route path="ats/workflow" element={<AtsWorkflow />} />
        <Route path="ats/search" element={<Search />} />
        <Route path="ats/dashboard" element={<AtsDashboard />} />
        {/* An ATS-side address for the reports, kept working: it lands on
            Reports -> ATS Reports with its ?tab= intact. */}
        <Route path="ats/reports" element={<AtsReportsRedirect />} />

        {/* These three tabs have real screens now: Agreements ships with the
            Clients & Requirements module, Job Portal / Integrations is the
            Integrations screen, and Internal Hiring is routed above. */}
        <Route path="ats/agreements" element={<Agreements />} />
        <Route path="ats/job-portal" element={<Integrations />} />

        {/* Accounts */}
        <Route path="invoices" element={<Invoices />} />
        <Route path="invoices/:id" element={<InvoiceDetail />} />
        <Route path="bank" element={<Bank />} />
        <Route path="office" element={<Office />} />
        <Route path="accounts/dashboard" element={<AccountsDashboard />} />
        <Route path="accounts/journal" element={<JournalLedger />} />
        {/* Signed client agreements for the accounts desk (read-only). */}
        <Route path="accounts/agreements" element={<Agreements />} />

        {/* Reports */}
        {/* ATS Reports: every ATS report is a tab inside this one page. */}
        <Route path="reports/ats" element={<AtsReports />} />
        <Route path="reports/job-portal" element={<JobPortalReports />} />
        <Route path="reports/accounts" element={<AccountsReports />} />

        {/* Administration */}
        <Route path="admin/company" element={<CompanySetup />} />
        <Route path="admin/departments" element={<Departments />} />
        <Route path="admin/positions" element={<Positions />} />
        <Route path="admin/users" element={<Users />} />
        <Route path="admin/view-as" element={<ViewAsPicker />} />
        <Route path="admin/roles" element={<RoleCatalog />} />
        <Route path="admin/integrations" element={<Integrations />} />
        {/* The prototype files Organization Structure under Administration; it
            also stays a tab inside Performance & Development. */}
        <Route path="admin/org-structure" element={<OrgStructure />} />
        <Route path="admin/notifications" element={<Notifications />} />
        <Route path="admin/audit" element={<AuditLogs />} />
        <Route path="admin/profile" element={<Profile />} />
        {/* A section's bare address opens its dashboard, and an address that
            matches nothing goes home instead of drawing an empty page. */}
        <Route path="ats" element={<Navigate to="/ats/dashboard" replace />} />
        <Route path="accounts" element={<Navigate to="/accounts/dashboard" replace />} />
        <Route path="reports" element={<Navigate to="/reports/ats" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
    </>
  );
}
