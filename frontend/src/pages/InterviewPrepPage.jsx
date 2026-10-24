import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';
import './interviewPrepPage.css';

// ---------------------------------------------------------------------------
// THE CANDIDATE'S "HOW TO PREPARE" PAGE (2026-10-12). Opened from the link in the mail / message the
// recruiter sent. No login: the link holds a signed key. Read only. It never shows the client's name
// (the server writes "the hiring company"), the pay, or anything internal.
// ---------------------------------------------------------------------------
export default function InterviewPrepPage() {
  const { token } = useParams();
  const [v, setV] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.get(`/public/interview-prep/${token}`).then((r) => setV(r.data)).catch((e) => setErr(e.response?.data?.error || 'This link does not work. Ask your recruiter for a new one.'));
  }, [token]);

  if (err) return <div className="ipp"><div className="ipp-card"><h1>How to prepare</h1><p className="ipp-err">{err}</p></div></div>;
  if (!v) return <div className="ipp"><div className="ipp-card"><p>Getting your page ready…</p></div></div>;
  return (
    <div className="ipp">
      <div className="ipp-card">
        <div className="ipp-brand">TeamLink</div>
        <h1>How to prepare for your {v.job} {v.type === 'ai' ? 'AI interview' : 'interview'}</h1>
        {v.cancelled && <p className="ipp-warn">This interview was cancelled. Your recruiter will tell you the new time.</p>}
        <p className="ipp-when">
          Hi {v.firstName}. {v.type === 'ai' ? `Please finish your AI interview ${v.when || 'soon'}.` : <>Round {v.round} · <b>{v.when}</b><br />{v.where}</>}
        </p>
        <p className="ipp-lead">These are questions that are often asked for this requirement. Read them once and think of a real example for each. You do not need to learn them by heart.</p>
        {v.groups.map((g) => (
          <section key={g.key}>
            <h2>{g.title}</h2>
            <ol className={g.key === 'ask' ? 'ipp-dash' : ''}>{g.questions.map((q, i) => <li key={i}>{q}</li>)}</ol>
          </section>
        ))}
        {v.tips.length > 0 && (
          <section>
            <h2>Revise before the interview</h2>
            <ul>{v.tips.map((t, i) => <li key={i}>{t.replace(/^revise\s*:\s*/i, '')}</li>)}</ul>
          </section>
        )}
        <section>
          <h2>On the day</h2>
          <ul>{v.onTheDay.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </section>
        {v.contact && <p className="ipp-contact">Any question? {v.contact}</p>}
        <p className="ipp-end">All the best!</p>
      </div>
    </div>
  );
}
