import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api';
import { FeatureScreen, PanelPad, EmptyMini } from '../../components/proto.jsx';
import { SecureVideo, SecureDocument, VIEW_ONLY_NOTE } from './MaterialViewer.jsx';
import CertificateModal, { downloadCertificate } from './Certificate.jsx';

// ---------------------------------------------------------------------------
// THE LEARNER'S COURSE SCREEN — watch, read, get assessed, get certified.
//
// Everything comes from GET /lms/my/courses/:id, which only answers for a
// course the viewer is enrolled on. The order is the server's, not this
// screen's:
//
//   1. the REQUIRED materials (per the course's completion rules) are
//      watched / read — progress is reported per material and credited by
//      the server;
//   2. the moment they are all done the assessment OPENS BY ITSELF — this
//      screen switches to it, nobody has to activate anything;
//   3. passing it (or finishing the content, on a course with no
//      assessment) completes the course and issues the certificate.
//
// There is no "Mark as completed" anywhere, because there is no endpoint
// that would honour one.
// ---------------------------------------------------------------------------

function fmtClock(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function fmtDate(d) {
  return d ? new Date(d).toISOString().slice(0, 10) : '—';
}

const ICON = { Video: '🎬', Document: '📄', Link: '🔗' };

// One material's progress, in words.
function progressText(m) {
  if (m.progress.completed) return 'Completed';
  if (m.kind === 'Video') {
    if (!m.durationSeconds) return m.progress.secondsWatched ? `${fmtClock(m.progress.secondsWatched)} watched` : 'Not started';
    return `${Math.min(100, Math.round((m.progress.secondsWatched / m.durationSeconds) * 100))}% watched`;
  }
  if (m.progress.pageCount) return `${m.progress.pagesViewed || 0}/${m.progress.pageCount} pages viewed`;
  return m.progress.secondsWatched ? 'Opened' : 'Not opened';
}

function Bar({ pct }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div className="pct-bar"><i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></div>
      <span className="pct-num">{pct}%</span>
    </div>
  );
}

// --- A document / link: tracked, and completed AUTOMATICALLY -----------------
// There is no "I have read this" (HRMS-24 §14 — nothing is marked complete by
// hand). The panel reports how long the document has been open and, for a
// PDF, how many of its pages have been on screen; the SERVER completes it once
// it has been open long enough and every page has been viewed.
const DOC_TICK_MS = 10000;

function DocumentPanel({ material, minSeconds, onProgress }) {
  const [seconds, setSeconds] = useState(material.progress.secondsWatched || 0);
  const [pages, setPages] = useState({ pageCount: material.progress.pageCount || 0, pagesViewed: material.progress.pagesViewed || 0 });
  const [opened, setOpened] = useState(!!material.hasFile || !!material.progress.secondsWatched);
  const pending = useRef(0);
  const pagesRef = useRef(pages);
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const done = material.progress.completed;
  const isPdf = material.hasFile && material.mimeType === 'application/pdf';

  const readyRef = useRef(false);
  const report = useCallback((force = false) => {
    const open = pending.current;
    pending.current = 0;
    const p = pagesRef.current;
    if (!open && !force && !readyRef.current) return Promise.resolve(null);
    return api.post(`/lms/materials/${material.id}/progress`, {
      openSeconds: open,
      ...(isPdf ? { pageCount: p.pageCount || undefined, pagesViewed: p.pagesViewed || undefined } : {}),
    }).catch((err) => {
      // Not lost: the seconds go back and ride on the next report.
      pending.current += open;
      throw err;
    });
  }, [material.id, isPdf]);

  // The open-time clock. A document counts only while this tab is actually in
  // front of the learner; a link is read in another tab, so it counts once
  // the learner has opened it.
  useEffect(() => {
    if (done || !opened) return undefined;
    const tick = setInterval(() => {
      if (material.hasFile && document.visibilityState !== 'visible') return;
      pending.current += 1;
      setSeconds((s) => s + 1);
    }, 1000);
    const send = setInterval(() => {
      report().then((res) => { if (res && onProgressRef.current) onProgressRef.current(res.data); }).catch(() => {});
    }, DOC_TICK_MS);
    return () => {
      clearInterval(tick);
      clearInterval(send);
      report().then((res) => { if (res && onProgressRef.current) onProgressRef.current(res.data); }).catch(() => {});
    };
  }, [material.id, material.hasFile, done, opened, report]);

  // The minimum open time reached, or the last page seen: report at once so
  // the material completes without waiting for the next tick.
  const left = Math.max(0, minSeconds - seconds);
  const allPages = !isPdf || (pages.pageCount > 0 && pages.pagesViewed >= pages.pageCount);
  const ready = !done && opened && left === 0 && allPages;
  // While ready and not yet confirmed by the server, every tick re-sends —
  // so a report lost to a network blip is simply tried again.
  readyRef.current = ready;
  useEffect(() => {
    if (!ready) return;
    report(true).then((res) => { if (res && onProgressRef.current) onProgressRef.current(res.data); }).catch(() => {});
  }, [ready, report]);

  function onPages(p) {
    pagesRef.current = p;
    setPages(p);
  }

  return (
    <div>
      {!material.hasFile ? (
        <div className="notice">
          <span>
            This material is an external page.{' '}
            <a href={material.url} target="_blank" rel="noreferrer noopener" onClick={() => setOpened(true)}>Open {material.title}</a>
            {' '}— it opens in a new tab. It counts as read once it has been open for {minSeconds} seconds.
          </span>
        </div>
      ) : (
        <SecureDocument material={material} onPages={onPages} />
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
        {done ? (
          <span className="status approved">Viewed · completed on {fmtDate(material.progress.completedAt)}</span>
        ) : (
          <span className="small-muted">
            {isPdf && (pages.pageCount
              ? <>Pages viewed: <b>{pages.pagesViewed} / {pages.pageCount}</b> · </>
              : 'Counting pages… · ')}
            {left > 0 ? <>Open time: <b>{Math.min(seconds, minSeconds)}s / {minSeconds}s</b></> : <>Open time reached</>}
            {' · '}It completes automatically once {isPdf ? 'every page has been on screen and ' : ''}it has been open for {minSeconds} seconds.
          </span>
        )}
      </div>
    </div>
  );
}

// --- The assessment ----------------------------------------------------------
// Passed: the certificate, right where the learner submitted. Shown the
// moment a passing submission comes back (and whenever a completed course is
// reopened), so the learner never has to go looking for it.
function PassedPanel({ assignment, passMark, onView, onDownload, downloading }) {
  return (
    <div
      role="status"
      style={{
        border: '1px solid var(--teal)', background: 'var(--teal-tint)', borderRadius: 10,
        padding: '16px 18px', color: 'var(--ink)',
      }}
    >
      <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--teal)' }}>🎉 Passed — your certificate is ready</div>
      <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.6 }}>
        {assignment.score != null && <>You scored <b>{assignment.score}%</b>{passMark != null ? <> (pass mark {passMark}%)</> : null}. </>}
        Course completed on <b>{fmtDate(assignment.completedAt)}</b>.
        {assignment.certificateId ? <> Certificate ID <b>{assignment.certificateId}</b>.</> : ' Your certificate ID is being issued…'}
      </div>
      <div className="qa-row" style={{ marginTop: 12 }}>
        <button className="btn btn-primary btn-sm" disabled={!assignment.certificateId} onClick={onView}>View Certificate</button>
        <button className="btn btn-sm" disabled={!assignment.certificateId || downloading} onClick={onDownload}>
          {downloading ? 'Preparing…' : 'Download PDF'}
        </button>
      </div>
      <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 10 }}>
        It is also kept in your certificates on My Learning. You can still revisit the course materials from the list on the left.
      </div>
    </div>
  );
}

function fmtLeft(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// The assessment, per the course's rules (HRMS-24 §14): N questions drawn per
// attempt, an optional time limit kept by the SERVER (the attempt carries its
// expiry; this countdown only shows it and submits when it reaches zero),
// a limited number of attempts, randomised order. Nothing starts until the
// learner presses Start — opening the tab does not use up an attempt.
function AssessmentPanel({ courseId, course, state, openAttempt, attempts, onFinished }) {
  const [paper, setPaper] = useState(null);
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const skew = useRef(0); // server clock - browser clock
  const submitted = useRef(false);

  const start = useCallback(() => {
    setError(''); setBusy(true); setResult(null); setAnswers({}); submitted.current = false;
    api.get(`/lms/courses/${courseId}/assessment`)
      .then((res) => {
        if (res.data.serverNow) skew.current = new Date(res.data.serverNow).getTime() - Date.now();
        setPaper(res.data);
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not load the assessment.'))
      .finally(() => setBusy(false));
  }, [courseId]);

  const submit = useCallback(async (auto = false) => {
    if (submitted.current || !paper) return;
    submitted.current = true;
    setError(''); setBusy(true);
    try {
      const res = await api.post(`/lms/courses/${courseId}/assessment/submit`, { answers, attemptId: paper.attemptId });
      setResult({ ...res.data, auto });
      setPaper(null);
      onFinished(res.data);
    } catch (err) {
      submitted.current = false;
      setError(err.response?.data?.error || 'Could not submit the assessment.');
    } finally { setBusy(false); }
  }, [courseId, answers, paper, onFinished]);

  // The countdown. At zero the answers given so far are submitted.
  const expiresAt = paper && paper.expiresAt ? new Date(paper.expiresAt).getTime() : null;
  useEffect(() => {
    if (!expiresAt) return undefined;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [expiresAt]);
  const msLeft = expiresAt ? expiresAt - (now + skew.current) : null;
  useEffect(() => {
    if (msLeft != null && msLeft <= 0 && paper && !submitted.current) submit(true);
  }, [msLeft, paper, submit]);

  if (result) {
    return (
      <div>
        <div className={`notice${result.passed ? '' : ' amber'}`}>
          <span>
            {result.timedOut ? <>Time ran out on attempt {result.attemptNo} — it is recorded with a score of 0%. </>
              : <>Attempt {result.attemptNo}: you scored <b>{result.score}%</b> ({result.correct} of {result.total} correct) — pass mark {result.passMark}%.{result.auto ? ' (Submitted automatically when the time ran out.)' : ''}{' '}</>}
            {result.passed
              ? 'Passed. The course is complete and your certificate has been issued.'
              : result.canRetry
                ? `Not passed this time.${result.attemptsLeft != null ? ` ${result.attemptsLeft} attempt(s) left.` : ''} Review the materials and retake it whenever you are ready.`
                : 'Not passed, and you have used every attempt this course allows. Ask HR or your lead if you need another.'}
          </span>
        </div>
        {!result.passed && result.canRetry && <button className="btn btn-primary btn-sm" onClick={start}>Retake assessment</button>}
      </div>
    );
  }

  if (!paper) {
    const left = state.attemptsLeft;
    const n = course.questionsPerAttempt ? Math.min(course.questionsPerAttempt, state.questionCount) : state.questionCount;
    return (
      <div>
        <div style={{ fontSize: 13 }}>
          {openAttempt ? <b>You have an attempt in progress.</b> : <b>The assessment is open.</b>} The rules:
        </div>
        <ul className="lms-rules">
          <li>{n} question(s){course.randomizeQuestions !== false ? ', drawn and ordered at random for each attempt' : ''}</li>
          <li>Pass mark: <b>{course.passMark}%</b> — scored automatically when you submit</li>
          <li>Time limit: {course.timeLimitMinutes ? <b>{course.timeLimitMinutes} minute(s)</b> : 'none'}{course.timeLimitMinutes ? ' — the clock starts when you press Start and keeps running if you leave; answers are submitted automatically at zero' : ''}</li>
          <li>Attempts: {course.maxAttempts ? <><b>{course.maxAttempts}</b> allowed · {attempts || 0} used · {left} left</> : <>unlimited · {attempts || 0} used</>}</li>
        </ul>
        {error && <div className="error-text">{error}</div>}
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={start}>
          {busy ? 'Loading…' : openAttempt ? `Resume attempt ${openAttempt.attemptNo}` : `Start attempt ${(attempts || 0) + 1}`}
        </button>
      </div>
    );
  }

  const answered = paper.questions.filter((q) => answers[q.id] !== undefined).length;
  return (
    <div>
      <div className="small-muted" style={{ marginBottom: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span>
          Attempt {paper.attemptNo}{paper.maxAttempts ? ` of ${paper.maxAttempts}` : ''} · {paper.questions.length} question(s) · pass mark {paper.passMark}%
        </span>
        {msLeft != null && (
          <span className={`lms-assess-timer${msLeft < 60000 ? ' low' : ''}`} title="Time left — kept by the server">⏱ {fmtLeft(msLeft)}</span>
        )}
      </div>
      {paper.questions.map((q, i) => (
        <div className="qbank-item" key={q.id}>
          <div className="qbank-q">{i + 1}. {q.question}</div>
          {q.options.map((o, oi) => (
            // eslint-disable-next-line react/no-array-index-key
            <label key={oi} className="qopt-row" style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
              <input
                type="radio"
                name={`q-${q.id}`}
                style={{ width: 'auto' }}
                checked={answers[q.id] === o}
                onChange={() => setAnswers((a) => ({ ...a, [q.id]: o }))}
              />
              <span>{o}</span>
            </label>
          ))}
        </div>
      ))}
      {error && <div className="error-text">{error}</div>}
      <button className="btn btn-primary" style={{ marginTop: 10 }} disabled={busy || answered < paper.questions.length} onClick={() => submit(false)}>
        {busy ? 'Submitting…' : `Submit assessment (${answered}/${paper.questions.length} answered)`}
      </button>
    </div>
  );
}

// --- The screen --------------------------------------------------------------
export default function LearnCourse({ courseId, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [active, setActive] = useState(null);   // a material id | 'assessment' | 'certificate'
  const [certOpen, setCertOpen] = useState(false);
  const [flash, setFlash] = useState('');
  const [downloading, setDownloading] = useState(false);

  const pickDefault = (d) => {
    if (d.assignment.completed) return 'certificate';
    if (d.state.assessmentOpen) return 'assessment';
    const next = d.materials.find((m) => m.counts && !m.progress.completed) || d.materials[0];
    return next ? next.id : null;
  };

  const load = useCallback((keepActive) => {
    api.get(`/lms/my/courses/${courseId}`)
      .then((res) => {
        setData(res.data);
        setActive((a) => (keepActive && a ? a : pickDefault(res.data)));
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not open this course.'));
  }, [courseId]);
  useEffect(() => load(false), [load]);

  // A progress report came back. Merge the material's progress; when the
  // server says the content is now done, the assessment opens by itself.
  const dataRef = useRef(null);
  dataRef.current = data;
  const onProgress = useCallback((resp) => {
    if (!resp || !resp.progress) return;
    const before = dataRef.current;
    if (resp.state && before && !before.state.contentDone && resp.state.contentDone) {
      if (resp.assignment && resp.assignment.completed) {
        setFlash('All required content is complete — this course needs no assessment, so it is now complete and your certificate is ready.');
        setActive('certificate');
      } else if (resp.state.assessmentOpen) {
        setFlash('All required content is complete — your assessment is now open.');
        setActive('assessment');
      }
    }
    setData((d) => {
      if (!d) return d;
      const materials = d.materials.map((m) => (m.id === resp.progress.materialId
        ? { ...m, durationSeconds: m.durationSeconds || resp.progress.durationSeconds, progress: { ...m.progress, ...resp.progress } }
        : m));
      const next = { ...d, materials };
      if (resp.state) next.state = resp.state;
      if (resp.assignment) next.assignment = { ...d.assignment, ...resp.assignment };
      return next;
    });
  }, []);

  if (error && !data) {
    return (
      <FeatureScreen title="Course" onBack={onBack}>
        <div className="error-text">{error}</div>
      </FeatureScreen>
    );
  }
  if (!data) return <div className="small-muted">Loading course…</div>;

  const { course, materials, assignment, state } = data;
  const current = materials.find((m) => m.id === active);
  const rules = [
    course.requireVideos ? 'watch the required videos' : null,
    course.requireDocuments ? 'read the required documents' : null,
    course.requireAssessment ? `pass the assessment (${course.passMark}%)` : null,
  ].filter(Boolean);

  async function downloadCert() {
    setDownloading(true); setError('');
    try { await downloadCertificate(assignment.id, assignment.certificateId); } catch { setError('Could not download the certificate.'); } finally { setDownloading(false); }
  }

  const navItem = (key, label, sub, done, disabled) => (
    <button
      key={key}
      type="button"
      className="btn btn-sm"
      disabled={disabled}
      onClick={() => setActive(key)}
      style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
        marginBottom: 6, ...(active === key ? { borderColor: 'var(--teal)', boxShadow: '0 0 0 1px var(--teal) inset' } : {}),
      }}
    >
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        <span className="cell-muted" style={{ fontSize: 11 }}>{sub}</span>
      </span>
      <span aria-hidden="true">{done ? '✅' : ''}</span>
    </button>
  );

  return (
    <FeatureScreen
      title={course.title}
      sub={`${course.category || 'Course'}${course.duration ? ` · ${course.duration}` : ''} · Pass mark: ${course.passMark}%${course.mandatory ? ' · Mandatory' : ''}`}
      onBack={onBack}
    >
      {flash && <div className="notice"><span>{flash}</span></div>}

      <PanelPad>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <b>My progress</b>
            <div className="cell-muted" style={{ fontSize: 11.5 }}>
              {state.requiredDone} of {state.requiredTotal} required material(s) done
              {' · '}Status: <b>{state.stage}</b>
              {state.videoTotal ? ` · Video ${state.videoPct ?? 0}% (${fmtClock(state.videoSecondsWatched)} watched)` : ''}
              {state.docTotal ? ` · Documents ${state.docsDone}/${state.docTotal}` : ''}
              {state.needsAssessment ? ` · Assessment: ${state.assessmentStatus}` : ''}
              {assignment.attempts ? ` · ${assignment.attempts} attempt(s)` : ''}
              {assignment.score != null ? ` · last score ${assignment.score}%` : ''}
            </div>
            <div className="cell-muted" style={{ fontSize: 11 }}>
              {assignment.assignedByName ? `Assigned by ${assignment.assignedByName} · ` : ''}
              {assignment.dueDate ? `Due ${fmtDate(assignment.dueDate)} · ` : ''}
              {assignment.startedAt ? `Started ${fmtDate(assignment.startedAt)}` : 'Not started'}
              {assignment.completedAt ? ` · Completed ${new Date(assignment.completedAt).toLocaleString()}` : ''}
              {assignment.passedAttempt ? ` · passed on attempt ${assignment.passedAttempt}` : ''}
            </div>
          </div>
          <div style={{ minWidth: 220, flex: '0 1 320px' }} title="Course progress: required materials plus the assessment"><Bar pct={state.coursePct ?? state.contentPct} /></div>
        </div>
        <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 8 }}>
          To complete this course: {rules.length ? rules.join(', then ') : 'open it'}. It completes on its own when you have done that — there is nothing to mark as complete.
        </div>
      </PanelPad>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start', marginTop: 14 }}>
        <div style={{ flex: '1 1 250px', maxWidth: 360 }}>
          <PanelPad>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Course content</div>
            {materials.length === 0 && <EmptyMini>No materials have been added yet.</EmptyMini>}
            {materials.map((m) => navItem(
              m.id,
              `${ICON[m.kind] || '📄'} ${m.title}`,
              `${m.kind}${m.counts ? '' : ' · optional'} · ${progressText(m)}`,
              m.progress.completed,
              false,
            ))}
            {course.requireAssessment && navItem(
              'assessment',
              '📝 Assessment',
              assignment.completed ? `Passed${assignment.score != null ? ` · ${assignment.score}%` : ''}`
                : state.outOfAttempts ? 'Failed · no attempts left'
                  : state.assessmentOpen ? (state.assessmentStatus === 'Failed' ? `Failed · retry available${state.attemptsLeft != null ? ` (${state.attemptsLeft} left)` : ''}` : 'Available now')
                    : state.contentDone && !state.questionCount ? 'Not set up yet'
                      : 'Locked · opens when the required content is done',
              assignment.completed,
              !state.assessmentOpen && !state.outOfAttempts,
            )}
            {navItem('certificate', '🎓 Certificate', assignment.certificateId || 'Issued on completion', !!assignment.certificateId, !assignment.completed)}
          </PanelPad>
        </div>

        <div style={{ flex: '3 1 480px', minWidth: 0 }}>
          <PanelPad>
            {current && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
                  <div>
                    <b>{current.title}</b>
                    <div className="cell-muted" style={{ fontSize: 11.5 }}>
                      {current.kind}{current.counts ? ' · required' : ' · optional'} · {progressText(current)}
                      {current.kind === 'Video' && current.progress.lastPosition > 0 && !current.progress.completed
                        ? ` · resumes at ${fmtClock(current.progress.lastPosition)}` : ''}
                    </div>
                  </div>
                </div>
                {current.kind === 'Video' && current.hasFile && (
                  <SecureVideo
                    key={current.id}
                    material={current}
                    startAt={current.progress.lastPosition}
                    track
                    onProgress={onProgress}
                  />
                )}
                {current.kind === 'Video' && !current.hasFile && <div className="small-muted">This video has no file attached.</div>}
                {current.kind !== 'Video' && (
                  <DocumentPanel key={current.id} material={current} minSeconds={data.docMinSeconds} onProgress={onProgress} />
                )}
                <div className="cell-muted" style={{ fontSize: 11, marginTop: 10 }}>{VIEW_ONLY_NOTE}</div>
              </>
            )}

            {active === 'assessment' && (
              assignment.completed ? (
                <PassedPanel
                  assignment={assignment}
                  passMark={course.passMark}
                  downloading={downloading}
                  onView={() => setCertOpen(true)}
                  onDownload={downloadCert}
                />
              ) : state.assessmentOpen ? (
                <>
                  <div style={{ fontWeight: 700, marginBottom: 8 }}>Assessment</div>
                  <AssessmentPanel
                    courseId={course.id}
                    course={course}
                    state={state}
                    openAttempt={data.openAttempt}
                    attempts={assignment.attempts}
                    onFinished={(r) => {
                      setData((d) => ({ ...d, openAttempt: null, assignment: { ...d.assignment, attempts: r.attempts, score: r.score, completed: r.completed, completedAt: r.completedAt, certificateId: r.certificateId, passedAttempt: r.passed ? r.attemptNo : d.assignment.passedAttempt } }));
                      // A pass flips assignment.completed right here, so the
                      // section above swaps to "Passed — your certificate is
                      // ready" at once; the reload then brings in the server's
                      // state and the issued certificate.
                      if (r.passed) setTimeout(() => load(true), 300);
                    }}
                  />
                </>
              ) : (
                <div className="small-muted">
                  {state.outOfAttempts ? `You have used all ${state.maxAttempts} attempt(s) this course allows and did not reach the ${course.passMark}% pass mark. Ask HR or your lead if you need another attempt.`
                    : state.contentDone && !state.questionCount ? 'The assessment has not been set up yet. It will appear here as soon as it is.'
                      : 'Locked — the assessment opens by itself once every required material is complete.'}
                </div>
              )
            )}

            {active === 'certificate' && (
              assignment.completed ? (
                <PassedPanel
                  assignment={assignment}
                  passMark={course.requireAssessment ? course.passMark : null}
                  downloading={downloading}
                  onView={() => setCertOpen(true)}
                  onDownload={downloadCert}
                />
              ) : <div className="small-muted">Your certificate is issued automatically when the course is complete.</div>
            )}

            {!current && active !== 'assessment' && active !== 'certificate' && (
              <EmptyMini>Pick a material on the left to start.</EmptyMini>
            )}
            {error && <div className="error-text">{error}</div>}
          </PanelPad>
        </div>
      </div>

      {certOpen && <CertificateModal assignmentId={assignment.id} onClose={() => setCertOpen(false)} />}
    </FeatureScreen>
  );
}
