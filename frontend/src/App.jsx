import { Routes, Route } from 'react-router-dom';
import Shell from './components/Shell.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';

import Requirements from './pages/Requirements.jsx';
import RequirementDetail from './pages/RequirementDetail.jsx';
import JobPortalWorkspace from './pages/ats/JobPortalWorkspace.jsx';
import ClientJobPortal from './pages/ats/ClientJobPortal.jsx';
import Clients from './pages/Clients.jsx';
import ClientDetail from './pages/ClientDetail.jsx';
import Agreements from './pages/Agreements.jsx';
import Candidates from './pages/Candidates.jsx';
import CandidateDetail from './pages/CandidateDetail.jsx';
import CandidateHome from './pages/CandidateHome.jsx';
import AtsDashboard from './pages/ats/AtsDashboard.jsx';
import Team from './pages/ats/Team.jsx';
import InterviewCalendar from './pages/ats/InterviewCalendar.jsx';
import InterviewFeedback from './pages/ats/InterviewFeedback.jsx';
import Offers from './pages/ats/Offers.jsx';
import Joining from './pages/ats/Joining.jsx';
import InternalHiring from './pages/ats/InternalHiring.jsx';
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

import AtsReports from './pages/reports/AtsReports.jsx';
import JobPortalReports from './pages/reports/JobPortalReports.jsx';
import AccountsReports from './pages/reports/AccountsReports.jsx';

import CompanySetup from './pages/admin/CompanySetup.jsx';
import Departments from './pages/admin/Departments.jsx';
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
import SetPassword from './pages/SetPassword.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

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
        {/* The INTERNAL Job Portal workspace, inside Jobs / Requirements.
            A static segment, so it is matched ahead of requirements/:id.
            Reaching it without requirements/Job Portal Workspace/view gets an
            empty screen and a 403 from every call it makes. */}
        <Route path="requirements/job-portal" element={<JobPortalWorkspace />} />
        <Route path="requirements/:id" element={<RequirementDetail />} />
        {/* The CLIENT-facing view is a DIFFERENT screen on a different route
            with a different permission (requirements/Client Job Portal), so a
            client can never land on the internal workspace above. */}
        <Route path="client-portal" element={<ClientJobPortal />} />
        {/* Clients · Requirements · Agreements · Job Portal are one module;
            each tab keeps its own route so it stays bookmarkable. Job Portal
            is another agent's screen — see components/ClientModuleTabs.jsx. */}
        <Route path="clients" element={<Clients />} />
        <Route path="clients/:id" element={<ClientDetail />} />
        <Route path="agreements" element={<Agreements />} />
        <Route path="candidates" element={<Candidates />} />
        <Route path="candidates/:id" element={<CandidateDetail />} />
        {/* Where a signed-in candidate lands (identity.js WORKSPACE_HOME).
            The route did not exist, so logging in as one hit a dead page. */}
        <Route path="my-applications" element={<CandidateHome />} />
        <Route path="ats/team" element={<Team />} />
        <Route path="ats/calendar" element={<InterviewCalendar />} />
        {/* Interviews & Joining: Interview Calendar (above) - Interview Feedback
            - Offers - Joining - Internal Hiring */}
        <Route path="ats/interview-feedback" element={<InterviewFeedback />} />
        <Route path="ats/offers" element={<Offers />} />
        <Route path="ats/joining" element={<Joining />} />
        <Route path="ats/internal-hiring" element={<InternalHiring />} />
        <Route path="ats/search" element={<Search />} />
        <Route path="ats/dashboard" element={<AtsDashboard />} />

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

        {/* Reports */}
        <Route path="reports/ats" element={<AtsReports />} />
        <Route path="reports/job-portal" element={<JobPortalReports />} />
        <Route path="reports/accounts" element={<AccountsReports />} />

        {/* Administration */}
        <Route path="admin/company" element={<CompanySetup />} />
        <Route path="admin/departments" element={<Departments />} />
        <Route path="admin/users" element={<Users />} />
        <Route path="admin/roles" element={<RoleCatalog />} />
        <Route path="admin/integrations" element={<Integrations />} />
        {/* The prototype files Organization Structure under Administration; it
            also stays a tab inside Performance & Development. */}
        <Route path="admin/org-structure" element={<OrgStructure />} />
        <Route path="admin/notifications" element={<Notifications />} />
        <Route path="admin/audit" element={<AuditLogs />} />
        <Route path="admin/profile" element={<Profile />} />
      </Route>
    </Routes>
  );
}
