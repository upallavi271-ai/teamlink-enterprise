// ---------------------------------------------------------------------------
// The Super Admin popup on the HRMS dashboard (user, 2026-10-05): after a
// month ends, "September 2026 — recruiter joinings" lists every recruiter
// (name · seat · joinings / target), with Give incentive / Raise salary /
// No action per person. It comes back on every visit until everyone has a
// decision, or until "Remind me later" (once a day). The server decides
// whether to show it (GET /recruiter-joinings/popup — Super Admin only).
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { Modal } from '../proto.jsx';
import {
  JoiningsTable, RuleBox, SummaryCards, errText,
} from './RjParts.jsx';
import './rj.css';

export default function RecruiterJoiningsPopup() {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('last');
  const [live, setLive] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback((keepOpen) => {
    api.get('/recruiter-joinings/popup', { params: keepOpen ? { peek: '1' } : {} }).then((res) => {
      setData(res.data);
      if (!keepOpen) setOpen(!!res.data.show);
    }).catch(() => { /* no popup */ });
  }, []);
  useEffect(() => { load(false); }, [load]);
  useEffect(() => {
    if (open && tab === 'now' && !live) {
      api.get('/recruiter-joinings/board').then((r) => setLive(r.data)).catch((e) => setError(errText(e, 'Could not load this month.')));
    }
  }, [open, tab, live]);

  async function later() {
    try { await api.post('/recruiter-joinings/popup/snooze'); } catch { /* closes anyway */ }
    setOpen(false);
  }
  if (!open || !data) return null;
  const done = (data.summary?.pending || 0) === 0;
  return (
    <Modal
      wide
      title={`${data.label} — recruiter joinings`}
      onClose={() => setOpen(false)}
      footer={(
        <>
          <Link className="btn btn-sm" to="/performance?tab=joinings" onClick={() => setOpen(false)}>Open full screen</Link>
          {!done && <button className="btn btn-sm" onClick={later}>Remind me later</button>}
          <button className="btn btn-primary btn-sm" onClick={() => setOpen(false)}>{done ? 'Done' : 'Close'}</button>
        </>
      )}
    >
      <div className="rj">
        <p className="rj-lead">
          {done
            ? `Every recruiter has a decision for ${data.label}. This will not pop up again for ${data.label}.`
            : `${data.label} is over. Here is how many joinings each recruiter got against their target. Decide for each person: give an incentive, raise the salary, or no action. ${data.summary.pending} still waiting.`}
        </p>
        <div className="rj-tabs">
          <button type="button" className={tab === 'last' ? 'on' : ''} onClick={() => setTab('last')}>{data.label}</button>
          <button type="button" className={tab === 'now' ? 'on' : ''} onClick={() => setTab('now')}>This month so far</button>
        </div>
        {error && <div className="rj-error">{error}</div>}
        {tab === 'last' ? (
          <>
            <SummaryCards s={data.summary} decisions />
            <RuleBox rule={data.rule} />
            <JoiningsTable board={data} rows={data.rows} onChanged={() => load(true)} />
          </>
        ) : !live ? <div className="rj-empty">Loading this month…</div> : (
          <>
            <p className="rj-lead">{live.label} so far — live. Decisions open after the month ends.</p>
            <SummaryCards s={live.summary} />
            <JoiningsTable board={live} rows={live.rows} showDecision={false} />
          </>
        )}
      </div>
    </Modal>
  );
}
