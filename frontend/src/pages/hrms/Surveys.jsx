import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  Panel, PanelPad, PanelHead, AssignRow, EmptyMini, TwoCol, QaRow,
  NumHead, FeatureTiles, FeatureScreen, FeatureTable, ProgressBar, Modal,
} from '../../components/proto.jsx';
import { isHR as hasHrmsAdmin, canManageServices } from '../../permissions';
import Combo from '../../components/Combo.jsx';


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

function CreateSurveyModal({ onClose, onSaved }) {
  const [form, setForm] = useState({ title: '', questions: '' });
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    const questions = form.questions.split('\n').map((q) => q.trim()).filter(Boolean);
    if (!form.title.trim()) { setError('Enter a survey title.'); return; }
    if (!questions.length) { setError('Add at least one question.'); return; }
    try {
      await api.post('/surveys', { title: form.title.trim(), questions });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not create the survey');
    }
  }

  return (
    <Modal
      title="Create Survey"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={submit}>Publish</button></>}
    >
      <div className="field"><label>Title</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
      <div className="field">
        <label>Questions (one per line)</label>
        <textarea
          rows="4"
          placeholder={'I feel supported by my manager.\nI have the tools I need to do my job well.'}
          value={form.questions}
          onChange={(e) => setForm({ ...form, questions: e.target.value })}
        />
      </div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
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
  const [surveys, setSurveys] = useState([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [responding, setResponding] = useState(null);

  function load() { api.get('/surveys').then((res) => setSurveys(res.data)); }
  useEffect(load, []);

  async function toggle(s) {
    await api.patch(`/surveys/${s.id}/status`, { status: s.status === 'Active' ? 'Closed' : 'Active' });
    load();
  }

  const createButton = isHR && <button className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)}>+ Create Survey</button>;
  const modals = (
    <>
      {createOpen && <CreateSurveyModal onClose={() => setCreateOpen(false)} onSaved={() => { setCreateOpen(false); load(); }} />}
      {responding && <RespondModal survey={responding} onClose={() => setResponding(null)} onSaved={() => { setResponding(null); load(); }} />}
    </>
  );

  if (view === 'create') {
    return (
      <FeatureScreen title="Create Pulse Survey" sub="Short, recurring surveys that measure engagement over time." onBack={onBack}>
        <PanelPad style={{ marginTop: 14 }}>{createButton || <div className="cell-muted" style={{ fontSize: 12 }}>Only HR can create a survey.</div>}</PanelPad>
        {modals}
      </FeatureScreen>
    );
  }
  if (view === 'results') {
    return (
      <FeatureScreen title="Aggregated Results" sub="Average score per question — individual responses are never shown to managers." onBack={onBack}>
        {surveys.length === 0 ? (
          <PanelPad style={{ marginTop: 14 }}><EmptyMini>No surveys yet.</EmptyMini></PanelPad>
        ) : surveys.map((s) => (
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
      </FeatureScreen>
    );
  }
  if (view === 'history') {
    return (
      <FeatureScreen title="Survey History" sub="Every survey run, open or closed." onBack={onBack}>
        <FeatureTable
          heads={['Survey', 'Questions', 'Responses', 'Status']}
          empty="No surveys yet."
          rows={surveys.map((s) => (
            <tr key={s.id}>
              <td>{s.title}</td>
              <td className="cell-muted">{s.questions.length}</td>
              <td className="cell-muted">{(s.responses || []).length}</td>
              <td><span className={`status ${s.status === 'Active' ? 'active' : 'pending'}`}>{s.status}</span></td>
            </tr>
          ))}
        />
      </FeatureScreen>
    );
  }

  return (
    <div>
      <QaRow style={{ marginBottom: 14 }}>{createButton}</QaRow>
      <TwoCol style={{ alignItems: 'start' }}>
        <PanelPad>
          <NumHead n={1} title="Surveys" />
          {surveys.length === 0 ? <EmptyMini>No surveys created yet.</EmptyMini> : surveys.map((s) => (
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
        </PanelPad>
        <FeatureTiles features={SV_FEATURES} onOpen={onOpen} />
      </TwoCol>
      {modals}
    </div>
  );
}
