import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { PanelPad, EmptyMini, Modal } from '../../components/proto.jsx';
import Combo from '../../components/Combo.jsx';
import { SecureVideo, SecureDocument, VIEW_ONLY_NOTE } from './MaterialViewer.jsx';
import CertificateModal from './Certificate.jsx';
import PeopleFilterBar, { EMPTY_PEOPLE_FILTERS, peopleMatches, peopleOptions } from '../../components/PeopleFilterBar.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import { ListEmpty } from '../../components/ui/ListFilters.jsx';
import FilterChips from '../../components/FilterChips.jsx';
import { ApprovalChainModal } from '../../components/ApprovalChain.jsx';
import AudiencePicker from '../../components/AudiencePicker.jsx';
import CourseFilesPicker, { uploadMaterial } from './CourseFiles.jsx';

// The Enrolled Employees panel's status is the enrolment's own, worded as the
// row words it.
const ENROL_STATUSES = ['Completed', 'Not yet completed'];
const enrolStatusOf = (row) => (row.completed ? 'Completed' : 'Not yet completed');
const EMPTY_ENROL_FILTERS = { ...EMPTY_PEOPLE_FILTERS, from: '', to: '' };

// ---------------------------------------------------------------------------
// COURSE MANAGEMENT — the three panels behind "View & Enroll" on a course:
// Course Materials, Manage Assessment and Enrolled Employees.
//
// Every list here is read from GET /lms/courses/:id/manage, which scopes the
// employee halves through utils/scope.js employeeWhere(). The enrol dropdown
// therefore offers only people the caller may reach, and the server re-checks
// that on the way in rather than trusting the dropdown.
//
// THE ANSWER KEY IS ONLY EVER DRAWN ON THIS SCREEN. /manage is guarded by the
// same create permission the write endpoints are, and the LEARNER endpoint
// (/courses/:id/assessment) strips correctIndex and shuffles. So the green tick
// below exists nowhere a learner can reach.
//
// COMPLETION RULES AND ASSIGNMENT live here too: Edit Course sets the three
// require* toggles, each material carries its kind and whether it is
// required, and Assign Course hands the course to Everyone / departments /
// individuals inside the caller's scope — previewed first, so the count on
// the confirmation is the count the server then writes.
// ---------------------------------------------------------------------------

const HEAD = { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 14, gap: 14, flexWrap: 'wrap' };

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// "Video watch time: Not started" — the screenshot's own wording.
function fmtWatch(seconds) {
  if (!seconds) return 'Not started';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

function QuestionModal({ courseId, editing, onClose, onSaved }) {
  const [question, setQuestion] = useState(editing ? editing.question : '');
  const [options, setOptions] = useState(() => {
    const base = editing ? [...editing.options] : ['', '', '', ''];
    while (base.length < 4) base.push('');
    return base;
  });
  const [correctIndex, setCorrectIndex] = useState(editing ? editing.correctIndex : 0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function setOption(i, v) {
    setOptions((o) => o.map((x, idx) => (idx === i ? v : x)));
  }

  async function save() {
    setError(''); setBusy(true);
    try {
      const body = { question, options, correctIndex };
      if (editing) await api.put(`/lms/questions/${editing.id}`, body);
      else await api.post(`/lms/courses/${courseId}/questions`, body);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save that question.');
    } finally { setBusy(false); }
  }

  return (
    <Modal
      title={editing ? 'Edit Question' : 'Add Question'}
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save question'}</button>
      </>}
    >
      <div className="field">
        <label>Question</label>
        <textarea rows="2" value={question} autoFocus onChange={(e) => setQuestion(e.target.value)} />
      </div>
      <div className="small-muted" style={{ marginBottom: 6 }}>
        Tick the correct answer. It is stored on the server and never sent to a learner&apos;s browser.
      </div>
      {options.map((o, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <div className="qopt-row" key={i}>
          <label className="qopt-pick" title="Mark this as the correct answer">
            <input type="radio" name="correct" checked={correctIndex === i} onChange={() => setCorrectIndex(i)} />
            {LETTERS[i]}
          </label>
          <input value={o} placeholder={`Option ${LETTERS[i]}`} onChange={(e) => setOption(i, e.target.value)} />
        </div>
      ))}
      <button className="link-btn" type="button" onClick={() => setOptions((o) => [...o, ''])}>+ another option</button>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

function ImportModal({ courseId, onClose, onSaved }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run() {
    setError(''); setBusy(true);
    try {
      const res = await api.post(`/lms/courses/${courseId}/questions/import`, { text });
      setResult(res.data);
      if (res.data.imported) onSaved(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not import those questions.');
    } finally { setBusy(false); }
  }

  return (
    <Modal
      title="Import Questions"
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>{result ? 'Done' : 'Cancel'}</button>
        <button className="btn btn-primary" disabled={busy || !text.trim()} onClick={run}>{busy ? 'Importing…' : 'Import'}</button>
      </>}
    >
      <div className="small-muted" style={{ marginBottom: 8 }}>
        One question per block, blank line between blocks. Mark the correct option with a <b>*</b>. A block with
        nothing marked is reported back rather than guessed at.
      </div>
      <pre className="import-sample">{`1. What is prompt engineering?
A. Prompt
B. Better way of prompt
*C. Understanding the computer
D. Engineer`}</pre>
      <div className="field">
        <label>Paste your questions</label>
        <textarea rows="8" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      {result && (
        <div className="notice">
          Imported <b>{result.imported}</b> question(s).
          {result.rejected.length > 0 && (
            <ul style={{ margin: '6px 0 0 16px' }}>
              {result.rejected.map((r) => (
                <li key={r.block}>Block {r.block}{r.question ? ` — "${r.question}"` : ''}: {r.reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

// --- Create / edit a course, with its completion rules ----------------------
const RULES = [
  ['requireVideos', 'Watch all required videos', 'A video counts once about 90% of it has actually been played — skipping ahead does not count.'],
  ['requireDocuments', 'Read all required documents', 'A document or link completes by itself once it has been open for 30 seconds — and, for a PDF, once every page has been on screen. There is no "mark as read".'],
  ['requireAssessment', 'Pass the assessment', 'Opens by itself when the content above is done; the course completes on a score at or above the pass mark.'],
];
const blankOr = (v) => (v == null ? '' : v);

export function CourseFormModal({ course, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    title: course?.title || '',
    category: course?.category || '',
    duration: course?.duration || '',
    passMark: course?.passMark ?? 70,
    mandatory: !!course?.mandatory,
    requireVideos: course ? course.requireVideos !== false : true,
    requireDocuments: course ? course.requireDocuments !== false : true,
    requireAssessment: course ? course.requireAssessment !== false : true,
    questionsPerAttempt: blankOr(course?.questionsPerAttempt),
    timeLimitMinutes: blankOr(course?.timeLimitMinutes),
    maxAttempts: blankOr(course?.maxAttempts),
    randomizeQuestions: course ? course.randomizeQuestions !== false : true,
  }));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  // NEW COURSE ONLY: documents and videos picked on the form. The course is
  // created first, then each file is uploaded against its new id, one at a
  // time, each with its own progress and result. A file that fails says why
  // and the course keeps every file that worked.
  const [items, setItems] = useState([]);
  const [created, setCreated] = useState(null);
  const [phase, setPhase] = useState('form'); // form | uploading | done
  const patchItem = (key, patch) => setItems((list) => list.map((it) => (it.key === key ? { ...it, ...patch } : it)));

  async function uploadAll(newCourse) {
    setPhase('uploading');
    for (const it of items) {
      if (it.status !== 'waiting') continue;
      patchItem(it.key, { status: 'uploading', pct: 0 });
      try {
        // eslint-disable-next-line no-await-in-loop
        await uploadMaterial(newCourse.id, it, (pct) => patchItem(it.key, { pct }));
        patchItem(it.key, { status: 'done', pct: 100 });
      } catch (err) {
        patchItem(it.key, { status: 'failed', error: err.message });
      }
    }
    setPhase('done');
  }

  async function save() {
    setError(''); setBusy(true);
    try {
      if (course) {
        const res = await api.put(`/lms/courses/${course.id}`, form);
        onSaved(res.data);
        return;
      }
      const res = await api.post('/lms/courses', form);
      if (!items.some((it) => it.status === 'waiting')) { onSaved(res.data); return; }
      setCreated(res.data);
      await uploadAll(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save the course.');
    } finally { setBusy(false); }
  }

  // Once the course exists, closing the form still opens it — it was saved.
  const close = () => {
    if (phase === 'uploading') return;
    if (created) onSaved(created); else onClose();
  };
  const added = items.filter((it) => it.status === 'done').length;

  let footer;
  if (phase === 'uploading') {
    footer = <button className="btn btn-primary" disabled>Uploading files…</button>;
  } else if (phase === 'done') {
    footer = <button className="btn btn-primary" onClick={() => onSaved(created)}>Open course</button>;
  } else {
    footer = <>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !form.title.trim()} onClick={save}>
        {busy ? 'Saving…' : (course ? 'Save course' : 'Create course')}
      </button>
    </>;
  }

  if (phase !== 'form') {
    return (
      <Modal title={`New Course — ${created?.title || form.title}`} onClose={close} footer={footer}>
        <div className="notice cfiles-summary">
          <span>
            <b>Saved.</b> The course is created.{' '}
            {phase === 'uploading'
              ? 'Now adding your files — keep this window open.'
              : added === items.length
                ? `All ${added} file${added === 1 ? '' : 's'} added.`
                : `${added} of ${items.length} files added. The ones marked "Not added" say why — you can add them again on the course screen.`}
          </span>
        </div>
        <CourseFilesPicker items={items} buttons={false} hint={false} />
      </Modal>
    );
  }

  return (
    <Modal
      title={course ? 'Edit Course' : 'New Course'}
      onClose={close}
      footer={footer}
    >
      <label className="field"><span>Title</span>
        <input value={form.title} autoFocus onChange={(e) => set('title', e.target.value)} />
      </label>
      <div className="grid-2">
        <label className="field"><span>Category</span>
          <input value={form.category} placeholder="Onboarding, Compliance…" onChange={(e) => set('category', e.target.value)} />
        </label>
        <label className="field"><span>Duration</span>
          <input value={form.duration} placeholder="e.g. 2h" onChange={(e) => set('duration', e.target.value)} />
        </label>
        <label className="field"><span>Pass mark (%)</span>
          <input type="number" min="0" max="100" value={form.passMark} onChange={(e) => set('passMark', e.target.value)} />
        </label>
        <label className="field" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 22 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={form.mandatory} onChange={(e) => set('mandatory', e.target.checked)} />
          Mandatory course
        </label>
      </div>
      {!course && (
        <div className="field">
          <span>Course files (you can add more later)</span>
          <CourseFilesPicker
            items={items}
            onPick={(more) => setItems((list) => [...list, ...more])}
            onRemove={(key) => setItems((list) => list.filter((it) => it.key !== key))}
            disabled={busy}
          />
        </div>
      )}
      <div className="field">
        <span>Completion rules — the course completes itself when all ticked steps are done</span>
        {/* Wrapped so the rows are not `.field > label`, which styles.css
            renders as a small upper-case caption. */}
        <div>
          {RULES.map(([k, label, help]) => (
            <label key={k} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '6px 0', cursor: 'pointer' }}>
              <input type="checkbox" style={{ width: 'auto', marginTop: 3 }} checked={form[k]} onChange={(e) => set(k, e.target.checked)} />
              <span><b style={{ fontSize: 13 }}>{label}</b><br /><span className="small-muted">{help}</span></span>
            </label>
          ))}
        </div>
      </div>
      {form.requireAssessment && (
        <div className="field">
          <span>Assessment rules — leave a box blank for no limit</span>
          <div className="grid-2">
            <label className="field"><span>Questions per attempt</span>
              <input type="number" min="1" placeholder="All questions" value={form.questionsPerAttempt} onChange={(e) => set('questionsPerAttempt', e.target.value)} />
            </label>
            <label className="field"><span>Time limit (minutes)</span>
              <input type="number" min="1" placeholder="No time limit" value={form.timeLimitMinutes} onChange={(e) => set('timeLimitMinutes', e.target.value)} />
            </label>
            <label className="field"><span>Attempts allowed</span>
              <input type="number" min="1" placeholder="Unlimited" value={form.maxAttempts} onChange={(e) => set('maxAttempts', e.target.value)} />
            </label>
            <label className="field" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 22 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={form.randomizeQuestions} onChange={(e) => set('randomizeQuestions', e.target.checked)} />
              Randomise questions and options
            </label>
          </div>
          <div className="small-muted">Scored automatically against the pass mark. A failed attempt can be retried while attempts remain; the time limit is kept by the server.</div>
        </div>
      )}
      {!course && (
        <div className="small-muted">
          A course drafted by a TL goes up the approval chain before learners can see it; add materials and questions in the meantime.
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

// --- Assign Course: Everyone | Department(s) | Individual employee(s) -------
// The shared AudiencePicker (components/AudiencePicker.jsx), fed with the
// lists GET /lms/courses/:id/assign-options returns — the people and
// departments this login may reach, which are exactly what the server checks
// the request against. "Everyone" is offered only to an organisation-wide
// login (HR, Super Admin, Manager). Anything outside scope — even if typed
// into the request by hand — is refused by the server with 403.
const TO_API_MODE = { everyone: 'Everyone', departments: 'Departments', individuals: 'Individuals' };
const FROM_API_MODE = { Everyone: 'everyone', Departments: 'departments', Individuals: 'individuals' };

export function AssignModal({ courseId, onClose, onDone }) {
  const [opts, setOpts] = useState(null);
  const [aud, setAud] = useState({ mode: 'departments', departments: [], employeeIds: [] });
  const [due, setDue] = useState('');
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get(`/lms/courses/${courseId}/assign-options`)
      .then((res) => {
        setOpts(res.data);
        const last = FROM_API_MODE[res.data.course.assignMode];
        setAud({ mode: last === 'everyone' && !res.data.canAssignEveryone ? 'departments' : (last || (res.data.canAssignEveryone ? 'everyone' : 'departments')), departments: [], employeeIds: [] });
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not load who this course can be assigned to.'));
  }, [courseId]);

  // Any change to the choice invalidates the confirmation.
  useEffect(() => { setPreview(null); }, [aud, due]);

  // The picker's lists, held to the caller's scope by the server.
  const pickerOptions = useMemo(() => (opts ? {
    departments: opts.departments.map((d) => d.name),
    employees: opts.employees,
  } : null), [opts]);

  const body = { mode: TO_API_MODE[aud.mode], departments: aud.departments, employeeIds: aud.employeeIds, dueDate: due || undefined };
  const ready = aud.mode === 'everyone' || (aud.mode === 'departments' ? aud.departments.length > 0 : aud.employeeIds.length > 0);
  const today = new Date().toISOString().slice(0, 10);

  async function check() {
    setError(''); setBusy(true);
    try {
      const res = await api.post(`/lms/courses/${courseId}/assign`, { ...body, preview: true });
      setPreview(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not work out who would receive it.');
    } finally { setBusy(false); }
  }

  async function commit() {
    setError(''); setBusy(true);
    try {
      const res = await api.post(`/lms/courses/${courseId}/assign`, body);
      setResult(res.data);
      onDone();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not assign the course.');
    } finally { setBusy(false); }
  }

  return (
    <Modal
      title={`Assign Course${opts ? ` — ${opts.course.title}` : ''}`}
      onClose={onClose}
      wide
      footer={result ? <button className="btn btn-primary" onClick={onClose}>Done</button> : <>
        <button className="btn" onClick={onClose}>Cancel</button>
        {!preview && <button className="btn btn-primary" disabled={busy || !ready || !opts} onClick={check}>{busy ? 'Checking…' : 'Review'}</button>}
        {preview && (
          <button className="btn btn-primary" disabled={busy || preview.toAssign === 0} onClick={commit}>
            {busy ? 'Assigning…' : `Confirm — assign to ${preview.toAssign}`}
          </button>
        )}
      </>}
    >
      {!opts && !error && <div className="small-muted">Loading…</div>}
      {opts && opts.course.approvalStatus !== 'Approved' && (
        <div className="notice amber"><span>This course is still awaiting approval. It can be assigned once it is published.</span></div>
      )}
      {opts && !result && (
        <>
          <div className="small-muted" style={{ marginBottom: 10 }}>
            {opts.scope.global
              ? `You can assign to anyone in the organisation — ${opts.total} active employee(s).`
              : `You can assign to people inside your scope only (${[...(opts.scope.departments || []), ...(opts.scope.teams || [])].join(', ') || 'your own record'}) — ${opts.total} active employee(s). "Everyone" is for organisation-wide roles.`}
            {' '}Exited employees are never included, and anyone already assigned is skipped.
          </div>
          <AudiencePicker
            label="Assign to"
            value={aud}
            onChange={setAud}
            options={pickerOptions}
            allowEveryone={!!opts.canAssignEveryone}
            everyoneLabel="Everyone (organisation-wide)"
          />
          <label className="field" style={{ maxWidth: 240 }}><span>Due date (optional)</span>
            <input type="date" min={today} value={due} onChange={(e) => setDue(e.target.value)} />
          </label>

          {preview && (
            <div className="notice">
              <span>
                <b>{preview.toAssign}</b> employee(s) will receive this course{preview.label ? <> — {preview.label}</> : null}.
                {preview.alreadyAssigned ? ` ${preview.alreadyAssigned} already have it and will be skipped.` : ''}
                {preview.skippedExited ? ` ${preview.skippedExited} picked employee(s) have left and will be skipped.` : ''}
                {preview.dueDate ? ` Due ${String(preview.dueDate).slice(0, 10)}.` : ''}
                {preview.sample.length ? <><br /><span className="small-muted">Including: {preview.sample.join(', ')}{preview.toAssign > preview.sample.length ? '…' : ''}</span></> : null}
              </span>
            </div>
          )}
        </>
      )}
      {result && (
        <div className="notice">
          <span>
            Assigned to <b>{result.assigned}</b> employee(s){result.label ? ` — ${result.label}` : ''}. Each of them has an in-app notification and sees it under My Learning.
            {result.alreadyAssigned ? ` ${result.alreadyAssigned} already had it.` : ''}
          </span>
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

// --- Preview a material the way a learner sees it --------------------------
function MaterialPreview({ material, onClose }) {
  return (
    <Modal title={material.title} onClose={onClose} wide>
      {material.kind === 'Video'
        ? <SecureVideo material={material} />
        : <SecureDocument material={material} />}
      <div className="small-muted" style={{ marginTop: 8 }}>{VIEW_ONLY_NOTE}</div>
    </Modal>
  );
}

// --- The Question Bank screen ----------------------------------------------
function AssessmentScreen({ data, reload, onBack }) {
  const [modal, setModal] = useState(null);
  const [error, setError] = useState('');
  // A bulk-imported bank runs to hundreds of questions: a search box (question
  // or option text) and 25 / 50 / 100 paging. Numbers stay the bank's own.
  const [q, setQ] = useState('');
  const numbered = data.questions.map((x, i) => ({ ...x, n: i + 1 }));
  const needle = q.trim().toLowerCase();
  const matching = needle
    ? numbered.filter((x) => `${x.question} ${(x.options || []).join(' ')}`.toLowerCase().includes(needle))
    : numbered;
  const page = usePaged(matching);
  const qLike = { activeCount: needle ? 1 : 0, clear: () => setQ('') };

  async function remove(q) {
    // eslint-disable-next-line no-alert
    if (!confirm('Delete this question?')) return;
    setError('');
    try { await api.delete(`/lms/questions/${q.id}`); reload(); } catch (err) {
      setError(err.response?.data?.error || 'Could not delete that question.');
    }
  }

  return (
    <div>
      {/* Not .page-head: styles.css hides a .page-head inside .tab-content, and
          this screen renders inside the LMS tab. Same look as FeatureScreen. */}
      <div style={HEAD}>
        <div>
          <h1 style={{ fontSize: 19 }}>Manage Assessment — {data.course.title}</h1>
          <div className="page-sub">
            Questions are shuffled for each employee attempt; the correct answer is never sent to the browser.
          </div>
        </div>
      </div>
      <button className="btn" onClick={onBack}>← Back to Learning Management</button>

      {error && <div className="error-text" style={{ marginTop: 10 }}>{error}</div>}

      <div className="card section" style={{ marginTop: 14 }}>
        <div className="panel-head">
          <h3>Question Bank ({data.questions.length})</h3>
          <div className="panel-head-actions">
            <button className="btn" onClick={() => setModal({ kind: 'import' })}>Import Questions</button>
            <button className="btn btn-primary" onClick={() => setModal({ kind: 'question' })}>+ Add Question</button>
          </div>
        </div>

        {data.questions.length > 0 && (
          <div className="lf" style={{ margin: '8px 0' }}>
            <div className="mf-row" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input type="search" placeholder="Search questions or options…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search questions" style={{ minWidth: 240 }} />
              {needle && <span className="small-muted">{matching.length} of {data.questions.length} questions</span>}
            </div>
            <FilterChips filters={needle ? [{ key: 'q', label: 'Search', value: q.trim(), onRemove: () => setQ('') }] : []} onClearAll={needle ? () => setQ('') : undefined} />
          </div>
        )}
        {matching.length === 0
          ? <ListEmpty lf={qLike} noun="questions" title="No questions yet." hint="Add one, or paste a set with Import Questions." />
          : page.slice.map((q) => (
            <div className="qbank-item" key={q.id}>
              <div className="qbank-q">{q.n}. {q.question}</div>
              {q.options.map((o, oi) => (
                // eslint-disable-next-line react/no-array-index-key
                <div className={`qbank-opt${oi === q.correctIndex ? ' is-correct' : ''}`} key={oi}>
                  {LETTERS[oi]}. {o}{oi === q.correctIndex ? ' ✓' : ''}
                </div>
              ))}
              <div className="qbank-actions">
                <button className="btn btn-sm" onClick={() => setModal({ kind: 'question', editing: q })}>Edit</button>
                <button className="btn btn-sm btn-ghost" onClick={() => remove(q)}>Delete</button>
              </div>
            </div>
          ))}
        {matching.length > 0 && <Pager page={page} noun="questions" />}
      </div>

      {modal?.kind === 'question' && (
        <QuestionModal
          courseId={data.course.id}
          editing={modal.editing}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); reload(); }}
        />
      )}
      {modal?.kind === 'import' && (
        <ImportModal
          courseId={data.course.id}
          onClose={() => { setModal(null); reload(); }}
          onSaved={() => reload()}
        />
      )}
    </div>
  );
}

// --- Course Materials + Enrolled Employees ---------------------------------
export default function CourseManage({ courseId, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [view, setView] = useState('course');   // 'course' | 'assessment'
  const [title, setTitle] = useState('');
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [enrollId, setEnrollId] = useState('');
  const [required, setRequired] = useState(true);
  const [uploads, setUploads] = useState([]);     // files picked on this screen
  const [note, setNote] = useState('');
  const [modal, setModal] = useState(null);       // 'edit' | 'assign' | { preview } | { cert }
  const [ef, setEf] = useState(EMPTY_ENROL_FILTERS);
  // Enrolled Employees: the people filters + Assigned on, newest first, paged.
  // Set up before the loading returns below (hooks run on every render).
  const enrolledShown = (data?.enrolled || [])
    .filter((row) => peopleMatches(row, ef, undefined, enrolStatusOf, (r) => r.assignedAt))
    .sort((a, b) => String(b.assignedAt || '').localeCompare(String(a.assignedAt || '')));
  const enrolPage = usePaged(enrolledShown);
  const efLike = { activeCount: Object.values(ef).filter(Boolean).length, clear: () => setEf(EMPTY_ENROL_FILTERS) };

  const load = useCallback(() => {
    api.get(`/lms/courses/${courseId}/manage`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Could not open this course.'));
  }, [courseId]);
  useEffect(load, [load]);

  // FILES — "Add document" / "Add video" upload straight away, one at a time,
  // each with its own progress and result (CourseFiles.jsx). STREAMED: the
  // server's utils/lmsMedia.js checks type, size and magic bytes.
  const patchUpload = (key, patch) => setUploads((list) => list.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  async function pickFiles(more) {
    setUploads((list) => [...list.filter((it) => it.status !== 'done'), ...more]);
    setBusy(true);
    for (const it of more) {
      if (it.status !== 'waiting') continue;
      patchUpload(it.key, { status: 'uploading', pct: 0 });
      try {
        // eslint-disable-next-line no-await-in-loop
        await uploadMaterial(courseId, { ...it, required }, (pct) => patchUpload(it.key, { pct }));
        patchUpload(it.key, { status: 'done', pct: 100 });
      } catch (err) {
        patchUpload(it.key, { status: 'failed', error: err.message });
      }
    }
    setBusy(false);
    load();
  }

  async function addLink(e) {
    e.preventDefault();
    setError(''); setNote('');
    if (!/^https?:\/\//i.test(link.trim())) { setError('Paste a full link that starts with http:// or https://'); return; }
    setBusy(true);
    try {
      await api.post(`/lms/courses/${courseId}/materials`, { title: title.trim() || link.trim(), url: link.trim(), kind: 'Link', required });
      setTitle(''); setLink('');
      setNote('Saved. The link is added.');
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add that link.');
    } finally { setBusy(false); }
  }

  async function updateMaterial(m, patch) {
    setError('');
    try { await api.patch(`/lms/materials/${m.id}`, patch); load(); } catch (err) {
      setError(err.response?.data?.error || 'Could not update that material.');
    }
  }

  async function removeMaterial(m) {
    // eslint-disable-next-line no-alert
    if (!confirm(`Remove "${m.title}"?`)) return;
    setError(''); setNote('');
    try { await api.delete(`/lms/materials/${m.id}`); setNote(`Removed "${m.title}".`); load(); } catch (err) {
      setError(err.response?.data?.error || 'Could not remove that material.');
    }
  }

  async function enroll() {
    setError('');
    try {
      await api.post(`/lms/courses/${courseId}/enroll`, { employeeId: enrollId });
      setEnrollId('');
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not enroll that employee.');
    }
  }

  async function extraAttempt(row) {
    setError('');
    try { await api.post(`/lms/enrollments/${row.id}/extra-attempt`); load(); } catch (err) {
      setError(err.response?.data?.error || 'Could not grant another attempt.');
    }
  }

  async function unenroll(row) {
    // eslint-disable-next-line no-alert
    if (!confirm(`Remove ${row.name} from this course?`)) return;
    setError('');
    try { await api.delete(`/lms/enrollments/${row.id}`); load(); } catch (err) {
      setError(err.response?.data?.error || 'Could not remove that enrollment.');
    }
  }

  if (error && !data) return <div className="error-text">{error}</div>;
  if (!data) return <div className="small-muted">Loading course…</div>;

  if (view === 'assessment') {
    return <AssessmentScreen data={data} reload={load} onBack={() => { setView('course'); load(); }} />;
  }


  return (
    <div>
      {/* Not .page-head: styles.css hides a .page-head inside .tab-content, and
          this screen renders inside the LMS tab. Same look as FeatureScreen. */}
      <div style={HEAD}>
        <div>
          <h1 style={{ fontSize: 19 }}>{data.course.title}</h1>
          <div className="page-sub">
            {data.course.category || 'Course'}
            {data.course.duration ? ` · ${data.course.duration}` : ''}
            {' · '}Pass mark {data.course.passMark}%
            {data.course.mandatory ? ' · Mandatory' : ''}
            {data.course.approvalStatus && data.course.approvalStatus !== 'Approved' ? ` · ${data.course.approvalStatus} approval` : ''}
          </div>
          <div className="page-sub">
            Completes when the learner has{' '}
            {[
              data.course.requireVideos ? 'watched the required videos' : null,
              data.course.requireDocuments ? 'read the required documents' : null,
              data.course.requireAssessment ? 'passed the assessment' : null,
            ].filter(Boolean).join(', ') || 'opened it'}
            {data.course.assignMode ? ` · Last assigned: ${data.course.assignMode === 'Departments' ? `Departments (${data.course.assignDepartments.join(', ')})` : data.course.assignMode}` : ''}
          </div>
        </div>
      </div>
      <div className="qa-row">
        <button className="btn" onClick={onBack}>← Back to Learning Management</button>
        <button className="btn" onClick={() => setModal('edit')}>Edit Course &amp; Rules</button>
        {data.course.approvalStatus && <button className="btn" onClick={() => setModal('chain')}>Approval Chain</button>}
        {data.canAssign && <button className="btn btn-primary" onClick={() => setModal('assign')}>Assign Course</button>}
      </div>

      {error && <div className="error-text" style={{ marginTop: 10 }}>{error}</div>}

      <div className="course-manage">
        {/* --- Course Materials ------------------------------------------ */}
        <PanelPad>
          <div className="panel-head">
            <h3>Course Materials</h3>
            <button className="btn" onClick={() => setView('assessment')}>
              Manage Assessment ({data.questions.length})
            </button>
          </div>

          {data.materials.length === 0
            ? <EmptyMini>No materials yet.</EmptyMini>
            : data.materials.map((m) => (
              <div key={m.id} style={{ borderBottom: '1px solid var(--line-soft)', paddingBottom: 6, marginBottom: 6 }}>
                <div className="material-row">
                  <span className="material-icon" aria-hidden="true">{m.kind === 'Video' ? '🎬' : m.kind === 'Link' ? '🔗' : '📄'}</span>
                  <span className="material-name">
                    {m.title}
                    <span className="material-meta">
                      {m.fileName ? `${m.fileName}${m.sizeBytes ? ` · ${fmtSize(m.sizeBytes)}` : ''}` : m.url}
                      {m.durationSeconds ? ` · ${fmtWatch(m.durationSeconds)}` : ''}
                    </span>
                  </span>
                  {m.hasFile
                    ? <button className="btn btn-sm" onClick={() => setModal({ preview: m })}>View</button>
                    : <a className="btn btn-sm" href={m.href} target="_blank" rel="noreferrer noopener">Open Link</a>}
                  <button className="btn btn-sm btn-ghost" onClick={() => removeMaterial(m)}>Remove</button>
                </div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, marginLeft: 30 }}>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    Kind
                    <select value={m.kind} style={{ width: 'auto', minHeight: 28, padding: '2px 6px' }} onChange={(e) => updateMaterial(m, { kind: e.target.value })}>
                      {(m.hasFile ? ['Video', 'Document'] : ['Link', 'Document']).map((k) => <option key={k} value={k}>{k}</option>)}
                    </select>
                  </label>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                    <input type="checkbox" style={{ width: 'auto' }} checked={m.required} onChange={(e) => updateMaterial(m, { required: e.target.checked })} />
                    Required for completion
                  </label>
                </div>
              </div>
            ))}

          <div style={{ marginTop: 10 }}>
            <CourseFilesPicker
              items={uploads}
              onPick={pickFiles}
              onRemove={(key) => setUploads((list) => list.filter((it) => it.key !== key))}
              disabled={busy}
            />
          </div>
          <form className="material-add" onSubmit={addLink}>
            <input
              placeholder="Link title (optional)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <input
              placeholder="…or paste a link (https://…)"
              value={link}
              onChange={(e) => setLink(e.target.value)}
            />
            <button className="btn btn-sm" type="submit" disabled={busy || !link.trim()}>Add link</button>
          </form>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', fontSize: 12, marginTop: 6 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={required} onChange={(e) => setRequired(e.target.checked)} />
            New files and links are required for completion
          </label>
          {note && <div className="small-muted" style={{ marginTop: 6, color: '#15803d' }}>{note}</div>}
          <div className="small-muted" style={{ marginTop: 6 }}>
            PDFs, pictures, text and videos open inside the app only (view-only). Word, PowerPoint and Excel files open on the learner&apos;s own device — save them as PDF to keep them view-only.
          </div>
        </PanelPad>

        {/* --- Enrolled Employees ---------------------------------------- */}
        <PanelPad>
          <div className="panel-head">
            <h3>Enrolled Employees ({data.enrolled.length})</h3>
          </div>

          {data.enrolled.length > 0 && (
            <PeopleFilterBar
              filters={ef} setFilters={setEf}
              departments={peopleOptions(data.enrolled).departments} roles={peopleOptions(data.enrolled).roles}
              statuses={ENROL_STATUSES} shown={enrolledShown.length} total={data.enrolled.length}
              dates="Assigned on"
            />
          )}
          {enrolledShown.length === 0
            ? <ListEmpty lf={efLike} noun="enrolled employees" title="Nobody is enrolled yet." />
            : enrolPage.slice.map((row) => (
              <div className="enrol-row" key={row.id}>
                <div className="enrol-top">
                  <b>{row.name}</b>
                  <span className={`status ${row.completed ? 'approved' : row.stage === 'Failed' ? 'rejected' : 'pending'}`}>
                    {row.completed ? 'Completed' : (row.stage || 'Not yet completed')}
                  </span>
                </div>
                <div className="enrol-meta">
                  <span className="enrol-score">{row.score == null ? '—' : `${row.score}%`}</span>
                  <span>
                    Course {row.coursePct ?? row.contentPct}%
                    {row.videoPct != null ? ` · Video ${row.videoPct}%` : ''}
                    {row.docPct != null ? ` · Documents ${row.docPct}%` : ''}
                    {' · '}Assessment: {row.assessmentStatus || '—'}
                    {' · '}
                    {row.attempts ? `${row.attempts} attempt(s)` : 'No attempt yet'}
                    {row.attemptsLeft != null && !row.completed ? ` (${row.attemptsLeft} left)` : ''}
                    {' · '}
                    Video watch time: {fmtWatch(row.watchedSeconds)}
                    {row.certificateId && <>{' · '}<button className="link-btn" onClick={() => setModal({ cert: row.id })}>{row.certificateId}</button></>}
                    <br />
                    <span className="cell-muted" style={{ fontSize: 11 }}>
                      {row.source ? `${row.source} assignment` : 'Assigned'}{row.assignedByName ? ` by ${row.assignedByName}` : ''}
                      {row.assignedAt ? ` on ${new Date(row.assignedAt).toLocaleString()}` : ''}
                      {row.dueDate ? ` · due ${String(row.dueDate).slice(0, 10)}` : ''}
                      {row.lastAccessedAt ? ` · last accessed ${new Date(row.lastAccessedAt).toLocaleString()}` : ' · not opened yet'}
                      {row.completedAt ? ` · completed ${new Date(row.completedAt).toLocaleString()}${row.passedAttempt ? ` (attempt ${row.passedAttempt})` : ''}` : ''}
                    </span>
                  </span>
                  {data.canAssign && row.outOfAttempts && <button className="link-btn" onClick={() => extraAttempt(row)}>Grant another attempt</button>}
                  {data.canAssign && <button className="link-btn" onClick={() => unenroll(row)}>Remove</button>}
                </div>
              </div>
            ))}
          {enrolledShown.length > 0 && <Pager page={enrolPage} noun="enrolled employees" />}

          {data.canAssign && (
            <>
              <div className="enrol-add">
                <Combo value={enrollId} onChange={(e) => setEnrollId(e.target.value)}>
                  <option value="">Enroll an employee…</option>
                  {data.enrollable.map((c) => (
                    <option key={c.id} value={c.id}>{c.name} — {c.employeeCode}</option>
                  ))}
                </Combo>
                <button className="btn btn-primary" disabled={!enrollId} onClick={enroll}>Enroll</button>
              </div>
              <div className="small-muted" style={{ marginTop: 6 }}>
                Only employees inside your scope are listed, and the server checks that again on enrolment. Use Assign Course to hand it to a whole department or everyone at once.
              </div>
            </>
          )}
        </PanelPad>
      </div>

      {modal === 'chain' && (
        <ApprovalChainModal type="course" recordId={courseId} onClose={() => setModal(null)} onChanged={load} />
      )}
      {modal === 'edit' && (
        <CourseFormModal course={data.course} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />
      )}
      {modal === 'assign' && (
        <AssignModal courseId={data.course.id} onClose={() => { setModal(null); load(); }} onDone={load} />
      )}
      {modal?.preview && <MaterialPreview material={modal.preview} onClose={() => setModal(null)} />}
      {modal?.cert && <CertificateModal assignmentId={modal.cert} onClose={() => setModal(null)} />}
    </div>
  );
}
