import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  PanelPad, StatRow, AssignRow, EmptyMini, SectionLabel, ScopeNote, TwoCol,
  QaRow, NumHead, FeatureScreen, FeatureTable, Modal,
} from '../../components/proto.jsx';
import { can } from '../../permissions';
import Combo from '../../components/Combo.jsx';
import CourseManage, { CourseFormModal, AssignModal } from './CourseManage.jsx';
import LearnCourse from './LearnCourse.jsx';
import CertificateModal, { downloadCertificate } from './Certificate.jsx';
import PeopleFilterBar, { EMPTY_PEOPLE_FILTERS, peopleMatches, peopleOptions } from '../../components/PeopleFilterBar.jsx';
import ListFilterBar, { useListFilters, ListEmpty } from '../../components/ui/ListFilters.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import InsightsPanel from '../../components/charts/InsightsPanel.jsx';
import ExportMenu from '../../components/ExportMenu.jsx';
import DataIoBar from '../../components/dataio/DataIoBar.jsx';

// ---------------------------------------------------------------------------
// Learning (LMS) — two stacked sections.
//
//   A. My Learning                     the signed-in person's own learning.
//   B. Company Learning & Development  the same catalog read through the
//                                      viewer's data scope, read-only.
//
// Which half is actionable is decided by the permission engine
// (frontend/src/permissions.js mirrors backend/src/utils/permissions.js) —
// there is no role name in this file. Section B carries no write action at
// all, for anyone: the API has no write endpoint behind it, which is what
// makes its scope note true rather than decorative.
// ---------------------------------------------------------------------------

// Each entry opens its own screen (the key is the screen id).
const FEATURES = [
  ['catalog', 'Course & Program Management'],
  ['enrollment', 'Course Enrollment'],
  ['delivery', 'Training Delivery & Scheduling'],
  ['certifications', 'Certifications'],
  ['reports', 'Training Reports & Analytics'],
];

const COMPANY_TABS = [
  ['dashboard', 'Dashboard'],
  ['certifications', 'Certifications'],
  ['reports', 'Reports'],
  ['history', 'History'],
];

// The learner's dashboard badges (HRMS-24 §21).
const STATUS_CLASS = { Completed: 'approved', Failed: 'rejected', 'Not started': 'pending', 'In progress': 'pending', 'Assessment due': 'pending' };
const ASSESS_CLASS = { Passed: 'approved', Failed: 'rejected', Available: 'active', Locked: 'pending', 'Not required': 'pending' };
const fmtD = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');
const fmtDT = (d) => (d ? new Date(d).toLocaleString() : '—');

// THE FILTER STANDARD for every course list here (components/ui/ListFilters.jsx):
// Search · Category · Mandatory (+ list-specific), Sort, paged 25 / 50 / 100.
const COURSE_FIELDS = [
  { key: 'q', type: 'search', placeholder: 'Search course or category…', get: (c) => `${c.title || ''} ${c.category || ''}` },
  { key: 'category', label: 'Category', primary: true, get: (c) => c.category },
  { key: 'mandatory', label: 'Mandatory', primary: true, allLabel: 'Mandatory or optional', options: ['Mandatory', 'Optional'], get: (c) => (c.mandatory ? 'Mandatory' : 'Optional') },
];
const byTitle = (a, b) => String(a.title || '').localeCompare(String(b.title || ''));
const COURSE_SORTS = [
  { key: 'catalog', label: 'Catalogue order' },
  { key: 'title', label: 'Title A–Z', cmp: byTitle },
  { key: 'enrolled', label: 'Most enrolled', cmp: (a, b) => (b.total || 0) - (a.total || 0) },
];
// My Learning: Search · Status · Assessment · Category | More: Assigned via ·
// Mandatory · Due date. Only my own courses, so no people filters.
const MY_FIELDS = [
  { key: 'q', type: 'search', placeholder: 'Search my courses…', get: (c) => `${c.title || ''} ${c.category || ''} ${c.assignedByName || ''}` },
  { key: 'stage', label: 'Status', primary: true, get: (c) => c.stage },
  { key: 'assessment', label: 'Assessment', primary: true, get: (c) => c.assessmentStatus },
  { key: 'category', label: 'Category', primary: true, get: (c) => c.category },
  { key: 'source', label: 'Assigned via', allLabel: 'Assigned any way', get: (c) => c.source },
  { key: 'mandatory', label: 'Mandatory', allLabel: 'Mandatory or optional', options: ['Mandatory', 'Optional'], get: (c) => (c.mandatory ? 'Mandatory' : 'Optional') },
  { key: 'due', type: 'daterange', label: 'Due date', get: (c) => c.dueDate },
];
const MY_SORTS = [
  { key: 'new', label: 'Newest assigned', cmp: (a, b) => String(b.assignedAt || '').localeCompare(String(a.assignedAt || '')) },
  { key: 'due', label: 'Due soonest', cmp: (a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')) },
  { key: 'title', label: 'Title A–Z', cmp: byTitle },
];
const CATALOG_FIELDS = [
  ...COURSE_FIELDS,
  { key: 'approval', label: 'Approval', allLabel: 'Any approval status', get: (c) => c.approvalStatus },
];

function DeptCell({ row }) {
  const how = row.source === 'Everyone' ? 'Organisation-wide'
    : row.source === 'Department' ? 'Assigned to the department'
      : row.source === 'Individual' ? 'Assigned to you'
        : null;
  return (
    <span>
      {row.department || '—'}
      {how && <span className="lms-sub" style={{ display: 'block' }}>{how}</span>}
    </span>
  );
}

// My Learning: Course | Department | Status | Progress | Assessment | Score.
// Only the courses assigned to me — the server sends nothing else.
function MyLearningTable({ rows, onOpen, onCert, empty }) {
  return (
    <div className="tbl-wrap lms-dash">
      <table>
        <thead>
          <tr><th>Course</th><th>Department</th><th>Status</th><th>Progress</th><th>Assessment</th><th>Score</th><th /></tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={7} className="small-muted" style={{ padding: 16 }}>{empty || 'No courses have been assigned to you yet. Courses assigned to you, your department or the whole organisation appear here.'}</td></tr>
          ) : rows.map((c) => (
            <tr key={c.id}>
              <td>
                <CourseTitle row={c} />
                <span className="lms-sub" style={{ display: 'block' }}>
                  {c.assignedByName ? `Assigned by ${c.assignedByName}` : 'Assigned'} · {fmtD(c.assignedAt)}
                  {c.dueDate ? ` · due ${fmtD(c.dueDate)}` : ''}
                </span>
              </td>
              <td><DeptCell row={c} /></td>
              <td>
                <span className={`status ${STATUS_CLASS[c.stage] || 'pending'}`}>{c.stage}</span>
                {c.completedAt && <span className="lms-sub" style={{ display: 'block' }}>{fmtDT(c.completedAt)}</span>}
              </td>
              <td>
                <div className="lms-pbar">
                  <div className="pct-bar"><i style={{ width: `${c.coursePct || 0}%` }} /></div>
                  <span className="pct-num">{c.coursePct || 0}%</span>
                </div>
                <span className="lms-sub">
                  {c.requiredDone}/{c.requiredTotal} material(s)
                  {c.videoPct != null ? ` · video ${c.videoPct}%` : ''}
                  {c.docPct != null ? ` · docs ${c.docPct}%` : ''}
                </span>
              </td>
              <td>
                <span className={`status ${ASSESS_CLASS[c.assessmentStatus] || 'pending'}`}>{c.assessmentStatus}</span>
                {c.assessmentStatus === 'Failed' && (
                  <span className="lms-sub" style={{ display: 'block' }}>
                    {c.canRetry ? `Retry available${c.attemptsLeft != null ? ` (${c.attemptsLeft} left)` : ''}` : 'No attempts left'}
                  </span>
                )}
              </td>
              <td>{c.score != null ? `${c.score}%` : '—'}<span className="lms-sub" style={{ display: 'block' }}>pass {c.passMark}%</span></td>
              <td>
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {c.certificateId && <button className="btn btn-sm" onClick={() => onCert(c.assignmentId)}>Certificate</button>}
                  <button className={`btn btn-sm${c.stage === 'Completed' ? '' : ' btn-primary'}`} onClick={() => onOpen(c.id)}>
                    {c.stage === 'Completed' ? 'Review' : c.stage === 'Not started' ? 'Start' : 'Continue'}
                  </button>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// §22 — the audit trail, read from GET /lms/history (held to the viewer's
// scope on the server: an employee sees their own rows only).
function HistoryPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [view, setView] = useState('assignments');
  useEffect(() => {
    api.get('/lms/history').then((r) => setData(r.data)).catch((err) => setError(err.response?.data?.error || 'Could not load the learning history.'));
  }, []);
  // Filters for the two per-learner views (the server already held the rows
  // to this login's scope: an employee's history is their own, so the
  // Department / Employee filters only appear when there is more than one).
  const all = data?.rows || [];
  const manyPeople = new Set(all.map((r) => r.employeeCode || r.employee)).size > 1;
  const lf = useListFilters(all, [
    { key: 'q', type: 'search', placeholder: 'Search course, employee, department…', minWidth: 240,
      get: (r) => `${r.course || ''} ${r.employee || ''} ${r.employeeCode || ''} ${r.department || ''} ${r.assignedBy || ''}` },
    { key: 'status', label: 'Status', primary: true, get: (r) => r.status },
    { key: 'course', label: 'Course', primary: true, get: (r) => r.course },
    { key: 'department', label: 'Department', primary: true, show: manyPeople, get: (r) => r.department },
    { key: 'date', type: 'daterange', label: 'Assigned on', primary: true, get: (r) => r.assignedAt },
    { key: 'by', label: 'Assigned by', allLabel: 'Assigned by anyone', get: (r) => r.assignedBy },
    { key: 'result', label: 'Result', allLabel: 'Any result', get: (r) => r.result },
    { key: 'overdue', label: 'Due', allLabel: 'Overdue or not', options: ['Overdue', 'Not overdue'], get: (r) => (r.overdue ? 'Overdue' : 'Not overdue') },
  ], {
    sorts: [
      { key: 'new', label: 'Newest first', cmp: (a, b) => String(b.assignedAt || '').localeCompare(String(a.assignedAt || '')) },
      { key: 'old', label: 'Oldest first', cmp: (a, b) => String(a.assignedAt || '').localeCompare(String(b.assignedAt || '')) },
      { key: 'due', label: 'Due soonest', cmp: (a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')) },
      { key: 'employee', label: 'Employee A–Z', cmp: (a, b) => String(a.employee || '').localeCompare(String(b.employee || '')) },
    ],
  });
  const lfB = useListFilters(data?.batches || [], [
    { key: 'q', type: 'search', placeholder: 'Search course or who assigned…', get: (b) => `${b.course || ''} ${b.assignedBy || ''} ${b.label || ''} ${(b.departments || []).join(' ')}` },
    { key: 'mode', label: 'Assigned to', primary: true, allLabel: 'Assigned to anyone', get: (b) => b.mode },
    { key: 'date', type: 'daterange', label: 'Assigned on', primary: true, get: (b) => b.createdAt },
  ]);
  const page = usePaged(lf.rows);
  const pageB = usePaged(lfB.rows);
  if (error) return <div className="error-text">{error}</div>;
  if (!data) return <div className="small-muted">Loading history…</div>;
  const rows = page.slice;
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '10px 0' }}>
        {[['assignments', 'Assignments'], ['completions', 'Progress & completion'], ['batches', 'Assign actions']].map(([k, l]) => (
          <button key={k} className={`btn btn-sm${view === k ? ' btn-primary' : ''}`} onClick={() => setView(k)}>{l}</button>
        ))}
      </div>
      {view !== 'batches'
        ? <ListFilterBar lf={lf} storageKey="lms-history" noun="records" />
        : <ListFilterBar lf={lfB} storageKey="lms-batches" noun="assign actions" />}
      {view === 'assignments' && (
        <FeatureTable
          heads={['Course', 'Assigned by', 'Assigned to', 'Department', 'Employee', 'Date', 'Time', 'Due date', 'Status']}
          empty={<ListEmpty lf={lf} noun="course assignments" title="No course assignments inside your scope." />}
          rows={rows.map((r) => (
            <tr key={r.id}>
              <td>{r.course}</td>
              <td>{r.assignedBy || '—'}</td>
              <td>{r.assignedTo || '—'}</td>
              <td>{r.department || '—'}</td>
              <td>{r.employee}<span className="lms-sub" style={{ display: 'block' }}>{r.employeeCode || ''}</span></td>
              <td>{fmtD(r.assignedAt)}</td>
              <td>{r.assignedAt ? new Date(r.assignedAt).toLocaleTimeString() : '—'}</td>
              <td>{fmtD(r.dueDate)}{r.overdue && <span className="status rejected" style={{ marginLeft: 6 }}>Overdue</span>}</td>
              <td><span className={`status ${STATUS_CLASS[r.status] || 'pending'}`}>{r.status}</span></td>
            </tr>
          ))}
        />
      )}
      {view === 'completions' && (
        <FeatureTable
          heads={['Course', 'Employee', 'Start date', 'Last accessed', 'Video', 'Documents', 'Attempts', 'Score', 'Pass / Fail', 'Completed']}
          empty={<ListEmpty lf={lf} noun="learning records" title="No learning activity inside your scope." />}
          rows={rows.map((r) => (
            <tr key={r.id}>
              <td>{r.course}</td>
              <td>{r.employee}</td>
              <td>{fmtDT(r.startedAt)}</td>
              <td>{fmtDT(r.lastAccessedAt)}</td>
              <td>{r.videoPct != null ? `${r.videoPct}%` : '—'}</td>
              <td>{r.docPct != null ? `${r.docPct}% (${r.docsDone}/${r.docTotal})` : '—'}</td>
              <td title={r.attemptLog.map((a) => `#${a.attemptNo}: ${a.timedOut ? 'timed out' : a.submittedAt ? `${a.score}% ${a.passed ? 'pass' : 'fail'}` : 'in progress'}`).join('\n')}>
                {r.attempts}{r.passedAttempt ? ` (passed on #${r.passedAttempt})` : ''}
              </td>
              <td>{r.score != null ? `${r.score}%` : '—'}</td>
              <td>{r.result ? <span className={`status ${r.result === 'Fail' ? 'rejected' : 'approved'}`}>{r.result}</span> : '—'}</td>
              <td>{fmtDT(r.completedAt)}{r.certificateEligible && <span className="lms-sub" style={{ display: 'block' }}>Certificate {r.certificateId || 'eligible'}</span>}</td>
            </tr>
          ))}
        />
      )}
      {view === 'batches' && (
        <FeatureTable
          heads={['When', 'Course', 'Assigned by', 'To', 'Due date', 'New', 'Already had it']}
          empty={<ListEmpty lf={lfB} noun="assign actions" title="No assign actions to show." />}
          rows={pageB.slice.map((b) => (
            <tr key={b.id}>
              <td>{fmtDT(b.createdAt)}</td>
              <td>{b.course}</td>
              <td>{b.assignedBy || '—'}{b.assignedByRole ? <span className="lms-sub" style={{ display: 'block' }}>{b.assignedByRole}</span> : null}</td>
              <td>{b.mode === 'Departments' ? `Departments: ${b.departments.join(', ')}` : b.mode === 'Everyone' ? 'Everyone' : `Individual: ${b.label || ''}`}</td>
              <td>{fmtD(b.dueDate)}</td>
              <td>{b.assignedCount}</td>
              <td>{b.alreadyCount}</td>
            </tr>
          ))}
        />
      )}
      {view === 'batches' ? <Pager page={pageB} noun="assign actions" /> : <Pager page={page} noun="records" />}
    </div>
  );
}

// A My Learning row carries the viewer's own stage and content progress; a
// Company row carries completions across the viewer's scope.
function progressLine(row) {
  if (row.stage && row.enrolled) {
    return `${row.stage} · ${row.requiredDone} / ${row.requiredTotal} required material(s) (${row.contentPct}%) · Pass mark: ${row.passMark}%`
      + (row.certificateId ? ` · Certificate ${row.certificateId}` : '');
  }
  if (row.stage) return `Not enrolled · Pass mark: ${row.passMark}%`;
  return `${row.completed} / ${row.total} completed (${row.pct}%) · Pass mark: ${row.passMark}%`;
}

function CourseTitle({ row }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <b>{row.title}</b>
      {row.mandatory && <span className="status rejected">Mandatory</span>}
      {row.category && <span className="cell-muted" style={{ fontSize: 11.5 }}>{row.category}</span>}
    </span>
  );
}

// One course row: name (+ Mandatory tag), the progress line, then either an
// action or nothing at all in the read-only section.
function CourseRow({ row, action }) {
  return (
    <AssignRow>
      <span>
        <CourseTitle row={row} />
        <span className="cell-muted" style={{ fontSize: 11.5 }}>{progressLine(row)}</span>
      </span>
      {action || null}
    </AssignRow>
  );
}

export default function Lms() {
  const { user } = useAuth();
  // Both flags come from the engine, never from a role name.
  const canEditFields = can(user, 'hrms', 'hrms', 'Performance & Development', 'edit');

  const [my, setMy] = useState(null);
  const [company, setCompany] = useState(null);
  const [requests, setRequests] = useState([]);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('dashboard');
  const [screen, setScreen] = useState(null);      // a Key Feature screen
  const [courseId, setCourseId] = useState(null);  // a single course screen
  // Whoever may CREATE on Performance & Development runs the course: the
  // materials, the question bank and who is enrolled. Same permission the
  // write endpoints are guarded by, asked once here.
  const canManageCourse = can(user, 'hrms', 'hrms', 'Performance & Development', 'create');
  // ASSIGNING is wider than managing: a Manager / Assistant Manager holds
  // `assign` without `create`, so they get an Assign button on each course
  // (the same modal the management screen opens) and nothing else. Who they
  // may assign to is the server's scope rule, not this flag.
  const canAssignCourse = canManageCourse || can(user, 'hrms', 'hrms', 'Performance & Development', 'assign');
  const [managing, setManaging] = useState(null);
  const [modal, setModal] = useState(null);        // 'enroll' | 'material' | 'course'
  const [certFor, setCertFor] = useState(null);    // an assignment id

  // The filters must be set up on every render (hooks), so over whatever has
  // loaded so far.
  const lfMy = useListFilters(my?.courses || [], MY_FIELDS, { sorts: MY_SORTS });
  const lfCat = useListFilters(my?.catalog || [], CATALOG_FIELDS, { sorts: COURSE_SORTS.slice(0, 2) });
  const lfCo = useListFilters(company?.courses || [], COURSE_FIELDS, { sorts: COURSE_SORTS });
  const pageMy = usePaged(lfMy.rows);
  const pageCat = usePaged(lfCat.rows);
  const pageCo = usePaged(lfCo.rows);

  const load = useCallback(() => {
    api.get('/lms/my').then((res) => setMy(res.data)).catch(() => setError('Could not load your learning.'));
    api.get('/lms/company').then((res) => setCompany(res.data)).catch(() => setCompany(null));
    api.get('/lms/my/material-requests').then((res) => setRequests(res.data)).catch(() => setRequests([]));
  }, []);
  useEffect(load, [load]);

  async function requestMaterial(id, note) {
    setError('');
    try {
      await api.post('/lms/my/material-requests', { courseId: id, note });
      setModal(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not raise the request.');
    }
  }

  if (!my) return <div className="small-muted">Loading learning…</div>;

  const myCourses = my.courses || [];
  const companyCourses = company?.courses || [];
  const enrollments = company?.enrollments || [];
  const scope = company?.scope;
  const scopeLine = !scope ? ''
    : scope.global
      ? 'Your scope is organization-wide.'
      : `Your scope: ${[...(scope.departments || []), ...(scope.teams || [])].join(', ') || 'your own record'} · ${scope.employeeCount} employee(s).`;

  // ---- Course management: materials, assessment, enrolled employees -------
  if (managing) {
    return <CourseManage courseId={managing} onBack={() => { setManaging(null); load(); }} />;
  }

  // ---- A single course's own screen ---------------------------------------
  // Only a course assigned to me opens (the server answers nothing else):
  // materials, progress, the assessment when it opens, and the certificate.
  // There is no "Mark complete" here; a course completes itself
  // (routes/lms.js evaluate()).
  const openCourse = myCourses.find((c) => c.id === courseId);
  if (openCourse) {
    return <LearnCourse courseId={openCourse.id} onBack={() => { setCourseId(null); load(); }} />;
  }
  const catalog = my.catalog || [];

  // ---- A Key Feature screen -----------------------------------------------
  if (screen) {
    return (
      <CompanyFeature
        screen={screen}
        company={company}
        scopeLine={scopeLine}
        onBack={() => setScreen(null)}
      />
    );
  }

  return (
    <div>
      {error && <div className="error-text" style={{ marginBottom: 10 }}>{error}</div>}

      {/* ================= A. My Learning ================= */}
      <SectionLabel style={{ marginTop: 0 }}>My Learning</SectionLabel>
      {!my.linked && (
        <div className="notice amber">
          This login has no employee record linked to it, so there is nothing to enroll. Ask HR to link one.
        </div>
      )}
      {/* ONE KPI row per page: with Company L&D open to this login, these
          two join the row on its Dashboard tab; otherwise this is the row. */}
      {!company && (
        <StatRow
          columns={2}
          cells={[
            { value: my.enrolledCourses, label: 'My Enrolled Courses' },
            { value: my.certificatesEarned, label: 'Certificates Earned' },
          ]}
        />
      )}

      {/* ---- My Courses: ONLY what is assigned to me (§18 / §21) ---- */}
      <PanelPad style={{ marginTop: 14 }}>
        <NumHead n={1} title="My Courses" />
        <div className="cell-muted" style={{ fontSize: 11.5, marginBottom: 6 }}>
          Courses assigned to you, to your department or to the whole organisation. Each completes on its own: watch the videos, view the documents, then the assessment unlocks by itself.
        </div>
        {myCourses.length > 0 && <ListFilterBar lf={lfMy} storageKey="lms-my" noun="courses" />}
        <MyLearningTable
          rows={pageMy.slice} onOpen={setCourseId} onCert={setCertFor}
          empty={myCourses.length ? <ListEmpty lf={lfMy} noun="courses" /> : null}
        />
        {myCourses.length > 0 && <Pager page={pageMy} noun="courses" />}
        {my.linked && myCourses.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <ExportMenu url="/insights/lms/export" params={{ mine: '1' }} label="Export my learning" align="left" />
          </div>
        )}
      </PanelPad>

      <TwoCol style={{ marginTop: 14 }}>
        {catalog.length > 0 || canManageCourse ? (
          <PanelPad>
            <NumHead n={2} title="Course Catalogue — assign &amp; manage" />
            <div className="cell-muted" style={{ fontSize: 11.5, marginBottom: 6 }}>
              {canManageCourse
                ? 'Courses you can assign to people in your scope; the ones you may edit also open their materials, assessment and enrolments.'
                : 'Courses you can assign to people in your scope. Learners see only what is assigned to them.'}
            </div>
            {(canManageCourse || canAssignCourse) && (
              <QaRow style={{ marginBottom: 8 }}>
                {canManageCourse && <button className="btn btn-primary btn-sm" onClick={() => setModal({ kind: 'course' })}>+ New Course</button>}
                {/* Data I/O: the enrolment register (everyone in scope / one
                    employee) and an import of course ASSIGNMENTS with the
                    compulsory sample (backend src/io/lms.js — the assign
                    rules hold; learners are NOT notified by an import). */}
                <DataIoBar ioKey="lms" exportUrl="/insights/lms/export" onImported={load} />
              </QaRow>
            )}
            {catalog.length > 0 && <ListFilterBar lf={lfCat} storageKey="lms-catalog" noun="courses" />}
            {lfCat.rows.length === 0 ? <ListEmpty lf={lfCat} noun="courses" title="No courses in the catalog yet." /> : pageCat.slice.map((c) => (
              <CourseRow
                key={c.id}
                row={{ ...c, stage: null }}
                action={(
                  <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {c.approvalStatus !== 'Approved' && <span className="status pending">{c.approvalStatus}</span>}
                    {c.canEdit && (
                      <button className="btn btn-sm" onClick={() => setManaging(c.id)}>View &amp; Manage</button>
                    )}
                    {canAssignCourse && c.approvalStatus === 'Approved' && (
                      <button className="btn btn-sm" onClick={() => setModal({ kind: 'assign', courseId: c.id })}>Assign</button>
                    )}
                  </span>
                )}
              />
            ))}
            {lfCat.rows.length > 0 && <Pager page={pageCat} noun="courses" />}
          </PanelPad>
        ) : <div />}
        <PanelPad>
          <NumHead n={catalog.length > 0 || canManageCourse ? 3 : 2} title="Quick Actions" />
          <QaRow style={{ marginBottom: 10 }}>
            <button className="btn btn-sm" disabled={!my.linked || myCourses.length === 0} onClick={() => setModal({ kind: 'material' })}>Request Material Download</button>
          </QaRow>
          <div className="cell-muted" style={{ fontSize: 11.5, marginBottom: 8 }} title="Screenshots and screen recording cannot be prevented by any web app.">
            Course materials are view-only in the app — no downloads. A request is logged for L&amp;D to decide on; nothing is downloaded here.
          </div>
          <div className="cell-muted" style={{ fontSize: 11.5 }}>My material requests</div>
          {requests.length === 0 ? <EmptyMini>None raised.</EmptyMini> : requests.slice(0, 6).map((r) => (
            <AssignRow flush key={r.id}>
              <span style={{ fontSize: 12 }}>{r.title}</span>
              <span className="status pending">{r.status}</span>
            </AssignRow>
          ))}
        </PanelPad>
      </TwoCol>

      {/* ======== B. Company Learning & Development ======== */}
      <SectionLabel>Company Learning &amp; Development</SectionLabel>
      <ScopeNote>
        Team/organization learning — view your assigned department(s)/team(s) only; no create, edit, or enrollment-management actions here.
      </ScopeNote>

      <div className="tabbar">
        {COMPANY_TABS.map(([k, label]) => (
          <button key={k} className={`tab-btn${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {!company && <EmptyMini>Company learning is not available for this login.</EmptyMini>}

      {company && tab === 'dashboard' && (
        <div>
          {/* hrms-24 §1 / §9 — enrolled, in progress, completed and the
              assessment results for courses assigned inside the range, in
              this login's scope, with the enrolment register export. */}
          {/* ONE KPI row: the range's enrolment / progress / assessment
              tiles, then the catalogue's active courses (now) and this
              login's own learning. "Total Enrolled" is the range's Enrolled. */}
          <InsightsPanel
            module="lms"
            storageKey="tl_range_lms"
            extraTiles={[
              { value: company.activeCourses, label: 'Active Courses (now)' },
              { value: my.enrolledCourses, label: 'My Enrolled Courses' },
              { value: my.certificatesEarned, label: 'Certificates Earned' },
            ]}
          />
          <div className="cell-muted" style={{ fontSize: 11.5, margin: '8px 0 0' }}>{scopeLine}</div>

          <TwoCol style={{ marginTop: 14 }}>
            <PanelPad>
              <NumHead n={1} title="Training Courses" />
              <div className="cell-muted" style={{ fontSize: 11.5, marginBottom: 6 }}>
                Read-only. The figures count enrollments inside your scope only — they are not company-wide totals.
              </div>
              {companyCourses.length > 0 && <ListFilterBar lf={lfCo} storageKey="lms-company" noun="courses" />}
              {lfCo.rows.length === 0 ? <ListEmpty lf={lfCo} noun="courses" title="No courses in the catalog yet." />
                : pageCo.slice.map((c) => <CourseRow key={c.id} row={c} />)}
              {lfCo.rows.length > 0 && <Pager page={pageCo} noun="courses" />}
            </PanelPad>
            <div>
              <PanelPad>
                <NumHead n={2} title="Key Features" />
                <div className="cell-muted" style={{ fontSize: 12, marginBottom: 10 }}>Each feature opens its own screen.</div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {FEATURES.map(([key, label]) => (
                    <button key={key} className="btn btn-sm" style={{ textAlign: 'left' }} onClick={() => setScreen(key)}>{label}</button>
                  ))}
                </div>
              </PanelPad>
              <PanelPad>
                <NumHead n={3} title="Field-Level Access" />
                <AssignRow flush>
                  <span>Record Owner / Assigned-To</span>
                  <span className={`status ${canEditFields ? 'active' : 'pending'}`}>{canEditFields ? 'Editable' : 'Read-only'}</span>
                </AssignRow>
                <AssignRow flush>
                  <span>Internal Notes / Remarks</span>
                  <span className={`status ${canEditFields ? 'active' : 'pending'}`}>{canEditFields ? 'Editable' : 'Read-only'}</span>
                </AssignRow>
                <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 8 }}>
                  These are the only two field-level exceptions on a learning record; everything else is system-owned. The state shown is what the permission engine grants you — editing happens on the record, never in this read-only section.
                </div>
              </PanelPad>
            </div>
          </TwoCol>
        </div>
      )}

      {company && tab === 'certifications' && <CertificationsTable enrollments={enrollments} onView={setCertFor} />}
      {company && tab === 'reports' && <ReportsPanel company={company} />}
      {company && tab === 'history' && <HistoryPanel />}

      {modal?.kind === 'material' && (
        <MaterialModal courses={myCourses} preset={modal.courseId} onClose={() => setModal(null)} onSubmit={requestMaterial} />
      )}
      {modal?.kind === 'course' && (
        <CourseFormModal
          onClose={() => setModal(null)}
          onSaved={(created) => { setModal(null); load(); if (created?.id) setManaging(created.id); }}
        />
      )}
      {modal?.kind === 'assign' && (
        <AssignModal courseId={modal.courseId} onClose={() => { setModal(null); load(); }} onDone={load} />
      )}
      {certFor && <CertificateModal assignmentId={certFor} onClose={() => setCertFor(null)} />}
    </div>
  );
}

// --- Modals ----------------------------------------------------------------

function MaterialModal({ courses, preset, onClose, onSubmit }) {
  const [id, setId] = useState(preset || courses[0]?.id || '');
  const [note, setNote] = useState('');
  return (
    <Modal
      title="Request Material Download"
      onClose={onClose}
      footer={(
        <>
          <button className="btn btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary btn-sm" disabled={!id} onClick={() => onSubmit(id, note)}>Send request</button>
        </>
      )}
    >
      <label className="field">
        <span>Course</span>
        <Combo value={id} onChange={(e) => setId(e.target.value)}>
          {courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
        </Combo>
      </label>
      <label className="field">
        <span>Why do you need the material offline?</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
      </label>
      <div className="small-muted">
        Course materials are view-only inside the app. This request is logged for L&amp;D to decide on an offline copy — nothing is downloaded here.
      </div>
    </Modal>
  );
}

// --- Company read-only screens ---------------------------------------------

// Every certificate inside the viewer's scope, each with its ID and a way to
// open it. The certificate endpoint applies the same scope rule again.
// THE FILTERS FOR BOTH PEOPLE TABLES (Enrollment, Certifications): Employee
// ID, name, department, role and course, over the in-scope rows the server
// sent. An enrollment's status is its own — In Progress or Completed; every
// certificate is Completed, so that table has no status filter.
const ENROLLMENT_STATUSES = ['In Progress', 'Completed'];
const learnerOf = (e) => ({ employeeCode: e.employeeCode, name: e.employee, department: e.department, designation: e.designation, employmentStatus: e.employmentStatus });
const enrollmentStatusOf = (e) => (e.completed ? 'Completed' : 'In Progress');

const EMPTY_ENROLMENT_FILTERS = { ...EMPTY_PEOPLE_FILTERS, course: '', from: '', to: '' };
function useEnrollmentFilters(rows, { withStatus }) {
  const [f, setF] = useState(EMPTY_ENROLMENT_FILTERS);
  // Enrollments are dated by when they were assigned, certificates by when
  // they were earned.
  const dateOf = withStatus ? (e) => e.assignedAt : (e) => e.completedAt;
  const shown = rows.filter((e) => peopleMatches(e, f, learnerOf, enrollmentStatusOf, dateOf) && (!f.course || e.course === f.course))
    .sort((a, b) => String(dateOf(b) || '').localeCompare(String(dateOf(a) || '')));
  const page = usePaged(shown);
  const opts = peopleOptions(rows, learnerOf);
  const courses = [...new Set(rows.map((e) => e.course).filter(Boolean))].sort();
  const bar = (
    <PeopleFilterBar
      filters={f} setFilters={setF} departments={opts.departments} roles={opts.roles}
      statuses={withStatus ? ENROLLMENT_STATUSES : undefined} shown={shown.length} total={rows.length}
      dates={withStatus ? 'Enrolled on' : 'Certified on'} labels={{ course: 'Course' }}
    >
      <Combo value={f.course} title="Course" onChange={(e) => setF((x) => ({ ...x, course: e.target.value }))}>
        <option value="">All courses</option>
        {courses.map((c) => <option key={c}>{c}</option>)}
      </Combo>
    </PeopleFilterBar>
  );
  const lfLike = { activeCount: Object.values(f).filter(Boolean).length, clear: () => setF(EMPTY_ENROLMENT_FILTERS) };
  return { shown, bar, page, lfLike };
}

function EnrollmentTable({ enrollments }) {
  const { page, bar, lfLike } = useEnrollmentFilters(enrollments, { withStatus: true });
  return (
    <>
      {bar}
      <FeatureTable
        heads={['Employee', 'Course', 'Department', 'Team', 'Enrolled on', 'Status']}
        empty={<ListEmpty lf={lfLike} noun="enrollments" title="No enrollments inside your scope yet." />}
        rows={page.slice.map((e) => (
          <tr key={e.id}>
            <td>{e.employee}</td>
            <td>{e.course}</td>
            <td>{e.department}</td>
            <td>{e.team}</td>
            <td>{new Date(e.assignedAt).toISOString().slice(0, 10)}</td>
            <td><span className={`status ${e.completed ? 'active' : 'pending'}`}>{e.completed ? 'Completed' : 'In Progress'}</span></td>
          </tr>
        ))}
      />
      <Pager page={page} noun="enrollments" />
    </>
  );
}

function CertificationsTable({ enrollments, onView }) {
  const all = enrollments.filter((e) => e.completed);
  const { page, bar, lfLike } = useEnrollmentFilters(all, { withStatus: false });
  return (
    <>
      {bar}
      <FeatureTable
        heads={['Employee', 'Course', 'Department', 'Score', 'Certified on', 'Certificate ID', '']}
        empty={<ListEmpty lf={lfLike} noun="certificates" title="No certificates earned inside your scope yet." />}
        rows={page.slice.map((e) => (
          <tr key={e.id}>
            <td>{e.employee}</td>
            <td>{e.course}</td>
            <td>{e.department}</td>
            <td>{e.score != null ? `${e.score}%` : '—'} <span className="cell-muted">/ {e.passMark}%</span></td>
            <td>{e.completedAt ? new Date(e.completedAt).toISOString().slice(0, 10) : '—'}</td>
            <td className="mono">{e.certificateId || <span className="cell-muted">Issued when opened</span>}</td>
            <td>
              <span style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-sm" onClick={() => onView(e.id)}>View</button>
                <button className="btn btn-sm" onClick={() => downloadCertificate(e.id, e.certificateId).catch(() => {})}>PDF</button>
              </span>
            </td>
          </tr>
        ))}
      />
      <Pager page={page} noun="certificates" />
    </>
  );
}

function ReportsPanel({ company }) {
  const withLearners = company.courses.filter((c) => c.total > 0);
  const lf = useListFilters(withLearners, COURSE_FIELDS, {
    sorts: [
      COURSE_SORTS[2],
      { key: 'low', label: 'Lowest completion %', cmp: (a, b) => (a.pct || 0) - (b.pct || 0) },
      { key: 'high', label: 'Highest completion %', cmp: (a, b) => (b.pct || 0) - (a.pct || 0) },
      COURSE_SORTS[1],
    ],
  });
  const page = usePaged(lf.rows);
  const rows = page.slice;
  const mandatory = company.courses.filter((c) => c.mandatory);
  const mandatoryDone = mandatory.reduce((n, c) => n + c.completed, 0);
  const mandatoryTotal = mandatory.reduce((n, c) => n + c.total, 0);
  return (
    <div>
      <StatRow
        columns={3}
        cells={[
          { value: `${mandatoryTotal ? Math.round((mandatoryDone / mandatoryTotal) * 100) : 0}%`, label: 'Mandatory compliance' },
          { value: company.totalEnrolled, label: 'Enrollments in scope' },
          { value: company.materialRequests.length, label: 'Material requests' },
        ]}
      />
      <div style={{ marginTop: 14 }}><ListFilterBar lf={lf} storageKey="lms-reports" noun="courses" /></div>
      <FeatureTable
        heads={['Course', 'Mandatory', 'Enrolled', 'Completed', 'Completion %', 'Pass mark']}
        empty={<ListEmpty lf={lf} noun="courses" title="No enrollments inside your scope yet." />}
        rows={rows.map((c) => (
          <tr key={c.id}>
            <td>{c.title}</td>
            <td>{c.mandatory ? 'Yes' : 'No'}</td>
            <td>{c.total}</td>
            <td>{c.completed}</td>
            <td>{c.pct}%</td>
            <td>{c.passMark}%</td>
          </tr>
        ))}
      />
      <Pager page={page} noun="courses" />
    </div>
  );
}

const SCREEN_TITLE = {
  catalog: ['Course & Program Management', 'Every course and program in the catalog, with its mandatory flag and pass mark.'],
  enrollment: ['Course Enrollment', 'Who is enrolled on what, inside your scope.'],
  delivery: ['Training Delivery & Scheduling', 'How each course is delivered and how long it runs.'],
  certifications: ['Certifications', 'Certificates earned inside your scope.'],
  reports: ['Training Reports & Analytics', 'Completion and mandatory-compliance figures for your scope.'],
};

function CompanyFeature({ screen, company, scopeLine, onBack }) {
  const [certFor, setCertFor] = useState(null);
  const [title, sub] = SCREEN_TITLE[screen] || ['Learning', ''];
  const enrollments = company?.enrollments || [];
  // Catalog and Delivery list courses: Search · Category · Mandatory · Sort.
  const lf = useListFilters(company?.courses || [], COURSE_FIELDS, { sorts: COURSE_SORTS });
  const page = usePaged(lf.rows);
  const courses = page.slice;
  const courseBar = <ListFilterBar lf={lf} storageKey="lms-feature-courses" noun="courses" />;
  const courseEmpty = <ListEmpty lf={lf} noun="courses" title="No courses in the catalog yet." />;
  const coursePager = <Pager page={page} noun="courses" />;

  let body = null;
  if (screen === 'catalog') {
    body = (
      <>
      {courseBar}
      <FeatureTable
        heads={['Course', 'Category', 'Duration', 'Mandatory', 'Pass mark', 'Enrolled (your scope)']}
        empty={courseEmpty}
        rows={courses.map((c) => (
          <tr key={c.id}>
            <td>{c.title}</td>
            <td>{c.category || '—'}</td>
            <td>{c.duration || '—'}</td>
            <td>{c.mandatory ? <span className="status rejected">Mandatory</span> : '—'}</td>
            <td>{c.passMark}%</td>
            <td>{c.total}</td>
          </tr>
        ))}
      />
      {coursePager}
      </>
    );
  } else if (screen === 'enrollment') {
    body = <EnrollmentTable enrollments={enrollments} />;
  } else if (screen === 'delivery') {
    body = (
      <>
        {courseBar}
        <FeatureTable
          heads={['Course', 'Category', 'Duration', 'Mandatory', 'Learners in scope']}
          empty={courseEmpty}
          rows={courses.map((c) => (
            <tr key={c.id}>
              <td>{c.title}</td>
              <td>{c.category || '—'}</td>
              <td>{c.duration || '—'}</td>
              <td>{c.mandatory ? 'Yes' : 'No'}</td>
              <td>{c.total}</td>
            </tr>
          ))}
        />
        {coursePager}
        <div className="notice amber" style={{ marginTop: 14 }}>
          Delivery is self-paced: this app records a course and its duration, not scheduled sessions, trainers or rooms. Nothing is hidden here — there is no session data to show.
        </div>
      </>
    );
  } else if (screen === 'certifications') {
    body = <CertificationsTable enrollments={enrollments} onView={setCertFor} />;
  } else if (screen === 'reports') {
    body = <ReportsPanel company={company} />;
  }

  return (
    <FeatureScreen title={title} sub={sub} onBack={onBack}>
      <ScopeNote>
        Team/organization learning — view your assigned department(s)/team(s) only; no create, edit, or enrollment-management actions here.
      </ScopeNote>
      <div className="cell-muted" style={{ fontSize: 11.5, marginBottom: 10 }}>{scopeLine}</div>
      {body}
      {certFor && <CertificateModal assignmentId={certFor} onClose={() => setCertFor(null)} />}
    </FeatureScreen>
  );
}
