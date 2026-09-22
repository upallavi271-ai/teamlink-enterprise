import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import { PanelPad, EmptyMini, Modal } from '../../components/proto.jsx';
import Combo from '../../components/Combo.jsx';

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
// ---------------------------------------------------------------------------

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

// --- The Question Bank screen ----------------------------------------------
function AssessmentScreen({ data, reload, onBack }) {
  const [modal, setModal] = useState(null);
  const [error, setError] = useState('');

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
      <div className="page-head">
        <div>
          <h1>Manage Assessment — {data.course.title}</h1>
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

        {data.questions.length === 0
          ? <EmptyMini>No questions yet. Add one, or paste a set with Import Questions.</EmptyMini>
          : data.questions.map((q, i) => (
            <div className="qbank-item" key={q.id}>
              <div className="qbank-q">{i + 1}. {q.question}</div>
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
  const [file, setFile] = useState(null);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [enrollId, setEnrollId] = useState('');

  const load = useCallback(() => {
    api.get(`/lms/courses/${courseId}/manage`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Could not open this course.'));
  }, [courseId]);
  useEffect(load, [load]);

  async function addMaterial(e) {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      if (file) {
        // multipart — the file and its title in one request, the same upload
        // path utils/attachments.js validates for every other attachment.
        const body = new FormData();
        body.append('title', title || file.name);
        body.append('file', file);
        await api.post(`/lms/courses/${courseId}/materials`, body);
      } else if (link.trim()) {
        await api.post(`/lms/courses/${courseId}/materials`, { title: title || link.trim(), url: link.trim() });
      } else {
        setError('Choose a file or paste a link.');
        return;
      }
      setTitle(''); setFile(null); setLink('');
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add that material.');
    } finally { setBusy(false); }
  }

  async function removeMaterial(m) {
    // eslint-disable-next-line no-alert
    if (!confirm(`Remove "${m.title}"?`)) return;
    setError('');
    try { await api.delete(`/lms/materials/${m.id}`); load(); } catch (err) {
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
      <div className="page-head">
        <div>
          <h1>{data.course.title}</h1>
          <div className="page-sub">
            {data.course.category || 'Course'}
            {data.course.duration ? ` · ${data.course.duration}` : ''}
            {' · '}Pass mark {data.course.passMark}%
            {data.course.mandatory ? ' · Mandatory' : ''}
          </div>
        </div>
      </div>
      <button className="btn" onClick={onBack}>← Back to Learning Management</button>

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
              <div className="material-row" key={m.id}>
                <span className="material-icon" aria-hidden="true">📄</span>
                <span className="material-name">
                  {m.title}
                  <span className="material-meta">
                    {m.fileName ? `${m.fileName}${m.sizeBytes ? ` · ${fmtSize(m.sizeBytes)}` : ''}` : m.url}
                  </span>
                </span>
                <a className="btn btn-sm" href={m.href} target="_blank" rel="noreferrer">View Document</a>
                <button className="btn btn-sm btn-ghost" onClick={() => removeMaterial(m)}>Remove</button>
              </div>
            ))}

          <form className="material-add" onSubmit={addMaterial}>
            <input
              placeholder="Material title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <input
              type="file"
              onChange={(e) => { setFile(e.target.files[0] || null); setLink(''); }}
            />
            <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>
              {busy ? 'Adding…' : 'Add'}
            </button>
          </form>
          <div className="material-link">
            <input
              placeholder="…or paste a link instead"
              value={link}
              onChange={(e) => { setLink(e.target.value); setFile(null); }}
            />
          </div>
        </PanelPad>

        {/* --- Enrolled Employees ---------------------------------------- */}
        <PanelPad>
          <div className="panel-head">
            <h3>Enrolled Employees ({data.enrolled.length})</h3>
          </div>

          {data.enrolled.length === 0
            ? <EmptyMini>Nobody is enrolled yet.</EmptyMini>
            : data.enrolled.map((row) => (
              <div className="enrol-row" key={row.id}>
                <div className="enrol-top">
                  <b>{row.name}</b>
                  <span className={`status ${row.completed ? 'approved' : 'pending'}`}>
                    {row.completed ? 'Completed' : 'Not yet completed'}
                  </span>
                </div>
                <div className="enrol-meta">
                  <span className="enrol-score">{row.score == null ? '—' : `${row.score}%`}</span>
                  <span>
                    {row.attempts ? `${row.attempts} attempt(s)` : 'No attempt yet'}
                    {' · '}
                    Video watch time: {fmtWatch(row.watchedSeconds)}
                  </span>
                  <button className="link-btn" onClick={() => unenroll(row)}>Remove</button>
                </div>
              </div>
            ))}

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
            Only employees inside your scope are listed, and the server checks that again on enrolment.
          </div>
        </PanelPad>
      </div>
    </div>
  );
}
