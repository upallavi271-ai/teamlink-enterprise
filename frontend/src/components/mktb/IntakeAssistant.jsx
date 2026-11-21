import { useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import { M, Chips, Flash, FlagAi, useRun } from './kit.jsx';

// JOB INTAKE ASSISTANT (market wave B 02.13): paste a call note or the client's e-mail; the assistant drafts the requirement
// (title, client, skills, experience, place, notice, job description). "Use this draft" opens the normal Add requirement form
// filled in: the person checks every field and saves it there (nothing is saved here). Contact details in the note are dropped.
export default function IntakeAssistant({ onClose, onUse }) {
  const [text, setText] = useState('');
  const [out, setOut] = useState(null);
  const { busy, msg, run } = useRun();
  const d = out && out.draft;
  const toForm = () => {
    const f = {
      title: d.title, clientId: d.clientId, openings: d.openings || 1, skills: d.skills, goodToHaveSkills: d.goodToHaveSkills,
      jobDescription: [d.jobDescription, d.salaryNote].filter(Boolean).join('\n\n'), responsibilities: d.responsibilities,
      ...(d.department ? { department: d.department, departments: [d.department] } : {}),
      ...(d.location ? { location: d.location } : {}), ...(d.workMode ? { workMode: d.workMode } : {}), ...(d.employmentType ? { employmentType: d.employmentType } : {}),
      ...(d.expMin !== '' ? { expMin: d.expMin } : {}), ...(d.expMax !== '' ? { expMax: d.expMax } : {}), ...(d.noticePeriodMax ? { noticePeriodMax: d.noticePeriodMax } : {}), jobPreference: d.jobPreference,
    };
    onUse(f);
  };
  return (
    <Modal
      title="Draft a requirement from a call note or e-mail"
      size="wide"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          {d && <button type="button" className="btn btn-primary" onClick={toForm}>Use this draft</button>}
        </>
      )}
    >
      <p className="small-muted">Paste what the client said or wrote. You check the draft in the normal form before anything is saved.</p>
      <textarea rows={7} style={{ width: '100%' }} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Need 3 staff nurses for the ICU at City Hospital, Hyderabad, 2-5 years, BLS, immediate joiners, 25-35k a month" aria-label="Call note or e-mail" data-testid="mkb-intake-text" />
      <div className="mkb-row"><button type="button" className="btn btn-sm" disabled={busy || text.trim().length < 10} onClick={() => run(() => api.post(`${M}/intake`, { text })).then((r) => r && setOut(r.data))}>Draft it</button></div>
      {d && (
        <div data-testid="mkb-intake-draft">
          <Chips items={[
            { key: 't', label: 'Title', value: d.title || '-' }, { key: 'c', label: 'Client', value: d.clientName || 'not found - pick it in the form' },
            { key: 'd', label: 'Department', value: d.department || '-' }, { key: 's', label: 'Skills', value: d.skills || '-' },
            { key: 'e', label: 'Experience', value: d.expMin !== '' ? `${d.expMin}-${d.expMax} years` : '-' }, { key: 'l', label: 'Location', value: d.location || '-' },
            { key: 'n', label: 'Notice', value: d.noticePeriodMax || '-' }, { key: 'o', label: 'Openings', value: String(d.openings || 1) },
          ]} />
          {out.missing.length > 0 && <div className="small-muted">{`Not found in the note: ${out.missing.join(', ')}.`}</div>}
          {d.jobDescription && <div className="mkb-pre">{d.jobDescription}</div>}
          <div className="mkb-row small-muted">{`${out.note} Drafted by ${out.by === 'rules+ai' ? 'the rules and the AI' : 'the rules'}.`}</div>
          <FlagAi feature="Job intake" refType="Intake" refId={d.title} output={JSON.stringify(d).slice(0, 1200)} />
        </div>
      )}
      <Flash msg={msg} />
    </Modal>
  );
}
