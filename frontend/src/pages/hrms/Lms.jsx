import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  PanelPad, StatRow, AssignRow, EmptyMini, SectionLabel, ScopeNote, TwoCol,
  QaRow, NumHead, FeatureScreen, FeatureTable, Modal,
} from '../../components/proto.jsx';
import { can } from '../../permissions';
import Combo from '../../components/Combo.jsx';
import CourseManage from './CourseManage.jsx';

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
];

function progressLine(row) {
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
  const [managing, setManaging] = useState(null);
  const [modal, setModal] = useState(null);        // 'enroll' | 'material'

  const load = useCallback(() => {
    api.get('/lms/my').then((res) => setMy(res.data)).catch(() => setError('Could not load your learning.'));
    api.get('/lms/company').then((res) => setCompany(res.data)).catch(() => setCompany(null));
    api.get('/lms/my/material-requests').then((res) => setRequests(res.data)).catch(() => setRequests([]));
  }, []);
  useEffect(load, [load]);

  async function enroll(id) {
    setError('');
    try {
      await api.post('/lms/my/enroll', { courseId: id });
      setModal(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not enroll in that course.');
    }
  }

  async function markComplete(assignmentId) {
    setError('');
    try {
      await api.patch(`/lms/assignments/${assignmentId}/complete`);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not record completion.');
    }
  }

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
  const openCourse = myCourses.find((c) => c.id === courseId);
  if (openCourse) {
    return (
      <FeatureScreen
        title={openCourse.title}
        sub={`${openCourse.category || 'Course'}${openCourse.duration ? ` · ${openCourse.duration}` : ''} · Pass mark: ${openCourse.passMark}%`}
        onBack={() => setCourseId(null)}
      >
        {error && <div className="error-text">{error}</div>}
        <PanelPad>
          <NumHead n={1} title="My Progress" />
          <div className="kv"><span className="k">Mandatory</span><span>{openCourse.mandatory ? 'Yes' : 'No'}</span></div>
          <div className="kv"><span className="k">Pass mark</span><span>{openCourse.passMark}%</span></div>
          <div className="kv"><span className="k">Enrollment</span><span>{openCourse.enrolled ? 'Enrolled' : 'Not enrolled'}</span></div>
          <div className="kv"><span className="k">Progress</span><span>{openCourse.completed} / {openCourse.total} completed ({openCourse.pct}%)</span></div>
          <div className="kv">
            <span className="k">Certificate</span>
            <span>{openCourse.completedAt ? new Date(openCourse.completedAt).toISOString().slice(0, 10) : 'Not earned yet'}</span>
          </div>
          <QaRow style={{ marginTop: 12 }}>
            {!openCourse.enrolled && (
              <button className="btn btn-primary btn-sm" disabled={!my.canEnroll} onClick={() => enroll(openCourse.id)}>Enroll in this course</button>
            )}
            {openCourse.enrolled && openCourse.completed === 0 && (
              <button className="btn btn-primary btn-sm" onClick={() => markComplete(openCourse.assignmentId)}>Mark complete</button>
            )}
            <button className="btn btn-sm" disabled={!my.canEnroll} onClick={() => setModal({ kind: 'material', courseId: openCourse.id })}>Request Material Download</button>
          </QaRow>
          {!my.canEnroll && (
            <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 8 }}>
              This login has no employee record linked to it, so it cannot enrol or request material.
            </div>
          )}
          <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 10 }}>
            Completion is recorded per course — this app stores no per-lesson or per-assessment progress, so a course reads 0 / 1 until you complete it.
          </div>
        </PanelPad>
        {modal?.kind === 'material' && (
          <MaterialModal courses={myCourses} preset={modal.courseId} onClose={() => setModal(null)} onSubmit={requestMaterial} />
        )}
      </FeatureScreen>
    );
  }

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
      <StatRow
        columns={2}
        cells={[
          { value: my.enrolledCourses, label: 'My Enrolled Courses' },
          { value: my.certificatesEarned, label: 'Certificates Earned' },
        ]}
      />

      <TwoCol style={{ marginTop: 14 }}>
        <PanelPad>
          <NumHead n={1} title="Training Courses" />
          <div className="cell-muted" style={{ fontSize: 11.5, marginBottom: 6 }}>
            Your own progress on every course in the catalog. Completion is recorded per course, not per lesson.
          </div>
          {myCourses.length === 0 ? <EmptyMini>No courses in the catalog yet.</EmptyMini> : myCourses.map((c) => (
            <CourseRow
              key={c.id}
              row={c}
              action={(
                <button className={`btn btn-sm${c.enrolled ? '' : ' btn-primary'}`}
                  onClick={() => (canManageCourse ? setManaging(c.id) : setCourseId(c.id))}
                >
                  {/* A course OWNER opens the management screen — materials,
                      the question bank and who is enrolled. A learner opens
                      their own progress view, which is what this always was. */}
                  {canManageCourse ? 'View & Manage' : (c.enrolled ? 'View Course' : 'View & Enroll')}
                </button>
              )}
            />
          ))}
        </PanelPad>
        <PanelPad>
          <NumHead n={2} title="Quick Actions" />
          <QaRow style={{ marginBottom: 10 }}>
            <button className="btn btn-primary btn-sm" disabled={!my.canEnroll} onClick={() => setModal({ kind: 'enroll' })}>Enroll in Course</button>
            <button className="btn btn-sm" disabled={!my.canEnroll} onClick={() => setModal({ kind: 'material' })}>Request Material Download</button>
          </QaRow>
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
          <StatRow
            columns={2}
            cells={[
              { value: company.activeCourses, label: 'Active Courses' },
              { value: company.totalEnrolled, label: 'Total Enrolled' },
            ]}
          />
          <div className="cell-muted" style={{ fontSize: 11.5, margin: '8px 0 0' }}>{scopeLine}</div>

          <TwoCol style={{ marginTop: 14 }}>
            <PanelPad>
              <NumHead n={1} title="Training Courses" />
              <div className="cell-muted" style={{ fontSize: 11.5, marginBottom: 6 }}>
                Read-only. The figures count enrollments inside your scope only — they are not company-wide totals.
              </div>
              {companyCourses.length === 0 ? <EmptyMini>No courses in the catalog yet.</EmptyMini>
                : companyCourses.map((c) => <CourseRow key={c.id} row={c} />)}
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

      {company && tab === 'certifications' && <CertificationsTable enrollments={enrollments} />}
      {company && tab === 'reports' && <ReportsPanel company={company} />}

      {modal?.kind === 'enroll' && (
        <EnrollModal courses={myCourses} onClose={() => setModal(null)} onSubmit={enroll} />
      )}
      {modal?.kind === 'material' && (
        <MaterialModal courses={myCourses} preset={modal.courseId} onClose={() => setModal(null)} onSubmit={requestMaterial} />
      )}
    </div>
  );
}

// --- Modals ----------------------------------------------------------------

function EnrollModal({ courses, onClose, onSubmit }) {
  const available = courses.filter((c) => !c.enrolled);
  const [id, setId] = useState(available[0]?.id || '');
  return (
    <Modal
      title="Enroll in Course"
      onClose={onClose}
      footer={(
        <>
          <button className="btn btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary btn-sm" disabled={!id} onClick={() => onSubmit(id)}>Enroll</button>
        </>
      )}
    >
      {available.length === 0 ? (
        <div className="small-muted">You are already enrolled in every course in the catalog.</div>
      ) : (
        <label className="field">
          <span>Course</span>
          <Combo value={id} onChange={(e) => setId(e.target.value)}>
            {available.map((c) => (
              <option key={c.id} value={c.id}>{c.title}{c.mandatory ? ' (Mandatory)' : ''}</option>
            ))}
          </Combo>
        </label>
      )}
    </Modal>
  );
}

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
        The request is logged for L&amp;D to action — this app stores no course files, so nothing is downloaded here.
      </div>
    </Modal>
  );
}

// --- Company read-only screens ---------------------------------------------

function CertificationsTable({ enrollments }) {
  const certified = enrollments.filter((e) => e.completed);
  return (
    <FeatureTable
      heads={['Employee', 'Course', 'Department', 'Pass mark', 'Certified on']}
      empty="No certificates earned inside your scope yet."
      rows={certified.map((e) => (
        <tr key={e.id}>
          <td>{e.employee}</td>
          <td>{e.course}</td>
          <td>{e.department}</td>
          <td>{e.passMark}%</td>
          <td>{e.completedAt ? new Date(e.completedAt).toISOString().slice(0, 10) : '—'}</td>
        </tr>
      ))}
    />
  );
}

function ReportsPanel({ company }) {
  const rows = company.courses.filter((c) => c.total > 0);
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
      <FeatureTable
        heads={['Course', 'Mandatory', 'Enrolled', 'Completed', 'Completion %', 'Pass mark']}
        empty="No enrollments inside your scope yet."
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
  const [title, sub] = SCREEN_TITLE[screen] || ['Learning', ''];
  const courses = company?.courses || [];
  const enrollments = company?.enrollments || [];

  let body = null;
  if (screen === 'catalog') {
    body = (
      <FeatureTable
        heads={['Course', 'Category', 'Duration', 'Mandatory', 'Pass mark', 'Enrolled (your scope)']}
        empty="No courses in the catalog yet."
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
    );
  } else if (screen === 'enrollment') {
    body = (
      <FeatureTable
        heads={['Employee', 'Course', 'Department', 'Team', 'Enrolled on', 'Status']}
        empty="No enrollments inside your scope yet."
        rows={enrollments.map((e) => (
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
    );
  } else if (screen === 'delivery') {
    body = (
      <>
        <FeatureTable
          heads={['Course', 'Category', 'Duration', 'Mandatory', 'Learners in scope']}
          empty="No courses in the catalog yet."
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
        <div className="notice amber" style={{ marginTop: 14 }}>
          Delivery is self-paced: this app records a course and its duration, not scheduled sessions, trainers or rooms. Nothing is hidden here — there is no session data to show.
        </div>
      </>
    );
  } else if (screen === 'certifications') {
    body = <CertificationsTable enrollments={enrollments} />;
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
    </FeatureScreen>
  );
}
