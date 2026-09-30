import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  Panel, PanelPad, PanelHead, AssignRow, EmptyMini, TwoCol, QaRow,
  NumHead, FeatureTiles, FeatureScreen, FeatureTable, ProgressBar, Modal,
} from '../../components/proto.jsx';
import { isHR as hasHrmsAdmin, canManageServices } from '../../permissions';
import Combo from '../../components/Combo.jsx';
import PeopleFilterBar, { peopleMatches, textMatches } from '../../components/PeopleFilterBar.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import { ListEmpty } from '../../components/ui/ListFilters.jsx';
import AudiencePicker, { DeliverVia, EMPTY_AUDIENCE, audienceReady } from '../../components/AudiencePicker.jsx';
import {
  ComposeModal, Field, AiAssist, useSubmit,
} from '../../components/ComposeForm.jsx';

// A survey is not per employee: its filters are title, the department it was
// published to (an untargeted survey reaches every department, so it stays in)
// and its own status — Active or Closed (backend/src/routes/surveys.js).
const SURVEY_STATUSES = ['Active', 'Closed'];
const EMPTY_SURVEY_FILTERS = { q: '', department: '', status: '', from: '', to: '' };
const SURVEY_SORTS = [
  ['new', 'Newest first', (a, b) => String(b.createdAt).localeCompare(String(a.createdAt))],
  ['old', 'Oldest first', (a, b) => String(a.createdAt).localeCompare(String(b.createdAt))],
  ['responses', 'Most responses', (a, b) => (b.responses || []).length - (a.responses || []).length],
  ['title', 'Title A–Z', (a, b) => String(a.title || '').localeCompare(String(b.title || ''))],
];

// The prototype's three Engagement Survey feature tiles (SV_FEATURES, line 4429).
export const SV_FEATURES = [
  ['create', 'Create Pulse Survey'],
  ['results', 'Aggregated Results'],
  ['history', 'Survey History'],
];

function parseAnswers(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Average score per question, over the numeric answers only.
function averages(survey) {
  const responses = (survey.responses || []).map((r) => parseAnswers(r.answers));
  return survey.questions.map((q, i) => {
    const vals = responses.map((a) => Number(a[i])).filter((n) => Number.isFinite(n));
    return { question: q, avg: vals.length ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : 0 };
  });
}

// Follows the reference compose layout (components/ComposeForm.jsx). SEND TO
// is the shared AudiencePicker: everyone, one or MANY departments, or named
// employees. The server resolves it inside the creator's scope and refuses a
// response from anybody it was not sent to.
function CreateSurveyModal({ onClose, onSaved }) {
  const [form, setForm] = useState({ title: '', questions: '' });
  const [audience, setAudience] = useState(EMPTY_AUDIENCE);
  const [channels, setChannels] = useState([]);
  const { busy, error, setError, run } = useSubmit();

  async function submit() {
    const questions = form.questions.split('\n').map((q) => q.trim()).filter(Boolean);
    if (!form.title.trim()) { setError('Enter a survey title.'); return; }
    if (!questions.length) { setError('Add at least one question.'); return; }
    if (!audienceReady(audience)) { setError(audience.mode === 'departments' ? 'Pick at least one department.' : 'Pick at least one employee.'); return; }
    const res = await run(() => api.post('/surveys', { title: form.title.trim(), questions, audience, channels }), 'Could not create the survey');
    if (res) onSaved(res.data);
  }

  return (
    <ComposeModal title="Create Survey" onClose={onClose} onSubmit={submit} submitLabel="Publish Survey" busy={busy} error={error} wide>
      <Field label="Title" required><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
      <AiAssist kind="survey" title={form.title} text={form.questions} onText={(questions) => setForm((f) => ({ ...f, questions }))} />
      <Field label="Questions (one per line)" required hint="Each line becomes one statement employees rate from 1 to 5.">
        <textarea
          rows="5"
          placeholder={'I feel supported by my manager.\nI have the tools I need to do my job well.'}
          value={form.questions}
          onChange={(e) => setForm({ ...form, questions: e.target.value })}
        />
      </Field>
      <AudiencePicker value={audience} onChange={setAudience} />
      <DeliverVia value={channels} onChange={setChannels} />
    </ComposeModal>
  );
}

// An employee answers each question on the prototype's 1–5 rating scale.
function RespondModal({ survey, onClose, onSaved }) {
  const [answers, setAnswers] = useState(survey.questions.map(() => 5));
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    try {
      // One answer per question, in question order, so the aggregate reads them
      // back positionally.
      await api.post(`/surveys/${survey.id}/respond`, { answers: answers.map(String) });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not record your response');
    }
  }

  return (
    <Modal
      title={survey.title}
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={submit}>Submit</button></>}
    >
      {survey.questions.map((q, i) => (
        <div className="field" key={i}>
          <label>{q}</label>
          <Combo value={answers[i]} onChange={(e) => setAnswers(answers.map((a, n) => (n === i ? Number(e.target.value) : a)))}>
            {[1, 2, 3, 4, 5].map((v) => <option key={v} value={v}>{v} / 5</option>)}
          </Combo>
        </div>
      ))}
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

export default function Surveys({ view, onOpen, onBack }) {
  const { user } = useAuth();
  // isHR here DRAWS WRITE CONTROLS, so it asks the write permission and not
  // only the read one. A Manager and an Assistant Manager are view-only (§3,
  // §4) and still hold Employee Management/view, so isHR() alone would have
  // gone on offering them every button on this screen. Both halves, because
  // the screen is an administration screen AND these are writes.
  const isHR = hasHrmsAdmin(user) && canManageServices(user);
  // READ half: a lead reading the aggregate across departments gets the
  // Department filter; an employee sees only what reached them, so not.
  const seesOthers = hasHrmsAdmin(user);
  const [surveys, setSurveys] = useState([]);
  const [sort, setSort] = useState('new');
  const [createOpen, setCreateOpen] = useState(false);
  const [responding, setResponding] = useState(null);
  const [sent, setSent] = useState('');
  const [sf, setSf] = useState(EMPTY_SURVEY_FILTERS);

  function load() {
    api.get('/surveys').then((res) => setSurveys(res.data));
  }
  useEffect(load, []);

  async function toggle(s) {
    await api.patch(`/surveys/${s.id}/status`, { status: s.status === 'Active' ? 'Closed' : 'Active' });
    load();
  }

  const shown = surveys.filter((s) => textMatches(`${s.title} ${(s.questions || []).join(' ')}`, sf.q)
    && (!sf.department || !(s.departments || []).length || s.departments.includes(sf.department))
    && (!sf.status || s.status === sf.status)
    && peopleMatches(s, { from: sf.from, to: sf.to }, undefined, undefined, (r) => r.createdAt))
    .sort((SURVEY_SORTS.find(([k]) => k === sort) || SURVEY_SORTS[0])[2]);
  const page = usePaged(shown);
  const surveyDepts = [...new Set(surveys.flatMap((s) => s.departments || []))].sort();
  const bar = (
    <PeopleFilterBar
      filters={sf} setFilters={setSf} people={false} search="Survey title or question"
      departments={seesOthers ? surveyDepts : undefined} statuses={SURVEY_STATUSES} shown={shown.length} total={surveys.length}
      dates="Created on"
    >
      <label className="lf-sort">
        Sort
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          {SURVEY_SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
    </PeopleFilterBar>
  );
  const sfLike = { activeCount: Object.values(sf).filter(Boolean).length, clear: () => setSf(EMPTY_SURVEY_FILTERS) };
  const none = <ListEmpty lf={sfLike} noun="surveys" />;
  const pager = <Pager page={page} noun="surveys" />;

  const createButton = isHR && <button className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)}>+ Create Survey</button>;
  const modals = (
    <>
      {createOpen && <CreateSurveyModal onClose={() => setCreateOpen(false)} onSaved={(sv) => { setCreateOpen(false); setSent(`"${sv.title}" published to ${sv.label} — ${sv.reached} employee(s). ${sv.deliveryText || ''}`); load(); }} />}
      {responding && <RespondModal survey={responding} onClose={() => setResponding(null)} onSaved={() => { setResponding(null); load(); }} />}
    </>
  );

  if (view === 'create') {
    return (
      <FeatureScreen title="Create Pulse Survey" sub="Short, recurring surveys that measure engagement over time." onBack={onBack}>
        <PanelPad style={{ marginTop: 14 }}>{createButton || <div className="cell-muted" style={{ fontSize: 12 }}>Only HR can create a survey.</div>}{sent && <div className="notice" style={{ marginTop: 10 }}>{sent}</div>}</PanelPad>
        {modals}
      </FeatureScreen>
    );
  }
  if (view === 'results') {
    return (
      <FeatureScreen title="Aggregated Results" sub="Average score per question — individual responses are never shown to managers." onBack={onBack}>
        {bar}
        {shown.length === 0 ? (
          <PanelPad style={{ marginTop: 14 }}>{none}</PanelPad>
        ) : page.slice.map((s) => (
          <Panel key={s.id} style={{ marginTop: 14 }}>
            <PanelHead title={<>{s.title} <span className="cell-muted" style={{ fontSize: 12 }}>({(s.responses || []).length} response(s))</span></>} />
            {(s.responses || []).length === 0 ? <EmptyMini>No responses yet.</EmptyMini> : averages(s).map((a) => (
              <AssignRow key={a.question}>
                <span>{a.question}</span>
                <ProgressBar pct={(a.avg / 5) * 100} />
                <span style={{ minWidth: 52, textAlign: 'right' }}><b>{a.avg} / 5</b></span>
              </AssignRow>
            ))}
          </Panel>
        ))}
        {shown.length > 0 && pager}
      </FeatureScreen>
    );
  }
  if (view === 'history') {
    return (
      <FeatureScreen title="Survey History" sub="Every survey run, open or closed." onBack={onBack}>
        {bar}
        <FeatureTable
          heads={['Survey', 'Questions', 'Responses', 'Status']}
          empty={none}
          rows={page.slice.map((s) => (
            <tr key={s.id}>
              <td>{s.title}</td>
              <td className="cell-muted">{s.questions.length}</td>
              <td className="cell-muted">{(s.responses || []).length}</td>
              <td><span className={`status ${s.status === 'Active' ? 'active' : 'pending'}`}>{s.status}</span></td>
            </tr>
          ))}
        />
        {pager}
      </FeatureScreen>
    );
  }

  return (
    <div>
      <QaRow style={{ marginBottom: 14 }}>{createButton}</QaRow>
      {sent && <div className="notice">{sent}</div>}
      {bar}
      <TwoCol style={{ alignItems: 'start' }}>
        <PanelPad>
          <NumHead n={1} title="Surveys" />
          {shown.length === 0 ? none : page.slice.map((s) => (
            <AssignRow key={s.id}>
              <span>
                <b>{s.title}</b><br />
                <span className="cell-muted" style={{ fontSize: 11.5 }}>{s.questions.length} question(s) · {(s.responses || []).length} response(s)</span>
              </span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span className={`status ${s.status === 'Active' ? 'active' : 'pending'}`}>{s.status}</span>
                {isHR && <button className="btn btn-sm" onClick={() => toggle(s)}>{s.status === 'Active' ? 'Close' : 'Reopen'}</button>}
                {!isHR && s.status === 'Active' && <button className="btn btn-sm btn-primary" onClick={() => setResponding(s)}>Respond</button>}
                <button className="btn btn-sm" onClick={() => onOpen('results')}>View Results</button>
              </span>
            </AssignRow>
          ))}
          {shown.length > 0 && pager}
        </PanelPad>
        <FeatureTiles features={SV_FEATURES} onOpen={onOpen} />
      </TwoCol>
      {modals}
    </div>
  );
}
