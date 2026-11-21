import { useState } from 'react';
import api from '../../api';
import TabStrip from '../ui/TabStrip.jsx';
import { Notice, Section, Table, useLoad, useAction, pctTxt, when, daysAgo, todayIst, row } from './kit.jsx';

// ---------------------------------------------------------------------------
// ATS REPORTS -> RECRUITER INSIGHTS (market benchmark 05.08 / 05.09 / 05.10 / 05.12). The leaderboard itself (05.06) is
// in "Results vs target" (components/ats/AtsWork.jsx). Every number is the Daily report's own; who sees whom is decided on
// the server (/api/ats-plus/insights/*): a recruiter sees their own row with the team line beside it.
// ---------------------------------------------------------------------------
const TABS = [
  { key: 'ratios', label: 'Ratios', hint: 'Sent to client : interviews : offers : joinings, per recruiter' },
  { key: 'coach', label: 'Coaching', hint: 'Each recruiter against the team, and what to work on' },
  { key: 'calls', label: 'Call recordings', hint: 'Recorded calls: listen and read or paste the transcript' },
  { key: 'ai', label: 'AI activity', hint: 'What the AI did, for whom and when' },
];

function Period({ from, to, setFrom, setTo }) {
  return (
    <span style={row}>
      <span className="small-muted">From</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value || daysAgo(89))} />
      <span className="small-muted">to</span><input type="date" value={to} onChange={(e) => setTo(e.target.value || todayIst())} />
    </span>
  );
}

function Ratios() {
  const [from, setFrom] = useState(daysAgo(89)); const [to, setTo] = useState(todayIst());
  const { data, err } = useLoad(`/ats-plus/insights/ratios?from=${from}&to=${to}`);
  const t = data && data.team;
  return (
    <Section title="Recruiting ratios" note={data ? data.note : 'Loading…'} right={<Period {...{ from, to, setFrom, setTo }} />}>
      <Notice tone="red">{err}</Notice>
      {t && <div style={{ marginBottom: 8 }}><b>Team ({t.people} people):</b> {t.line} · profile to interview {pctTxt(t.subToInterview)} · interview to offer {pctTxt(t.interviewToOffer)} · offer to joining {pctTxt(t.offerToJoin)}</div>}
      {data && (
        <Table rows={data.rows} rowKey={(r) => r.userId} empty="No submissions in this period."
          cols={[
            { key: 'name', label: 'Recruiter' },
            { key: 'line', label: 'Sent : Interviews : Offers : Joined' },
            { key: 'a', label: 'Profile → interview', render: (r) => pctTxt(r.subToInterview) },
            { key: 'b', label: 'Interview → offer', render: (r) => pctTxt(r.interviewToOffer) },
            { key: 'c', label: 'Offer → joining', render: (r) => pctTxt(r.offerToJoin) },
            { key: 'd', label: 'Profiles per joining', render: (r) => (r.submissionsPerJoining ?? '—') },
          ]} />
      )}
    </Section>
  );
}

const WORDS = { subToInterview: 'Profile → interview', interviewToOffer: 'Interview → offer', offerToJoin: 'Offer → joining', calls: 'Calls', submissions: 'Submissions', followUps: 'Follow-ups' };
function Coaching() {
  const [from, setFrom] = useState(daysAgo(89)); const [to, setTo] = useState(todayIst());
  const { data, err } = useLoad(`/ats-plus/insights/coaching?from=${from}&to=${to}`);
  return (
    <Section title="Coaching insights" note="Each recruiter's conversion against the team, from the same events as the Daily report. A ratio is judged only after 3 or more profiles at that step." right={<Period {...{ from, to, setFrom, setTo }} />}>
      <Notice tone="red">{err}</Notice>
      {data && data.rows.length === 0 && <Notice>Nobody has work in this period yet.</Notice>}
      {data && data.rows.map((r) => (
        <div key={r.userId} className="card" style={{ padding: 12, marginBottom: 10 }}>
          <div style={row}><b>{r.name}</b><span className="small-muted">{r.ratios.line} · calls {r.activity.calls} · follow-ups {r.activity.followUps}</span></div>
          <div style={{ margin: '4px 0' }}>{r.summary}</div>
          {r.work.map((w) => <div key={w.key} className="notice amber" style={{ margin: '4px 0' }}><span><b>{WORDS[w.key]}</b>: {w.yours}{['calls', 'submissions', 'followUps'].includes(w.key) ? '' : '%'} against the team&apos;s {w.team}{['calls', 'submissions', 'followUps'].includes(w.key) ? ' a person' : '%'}. {w.tip}</span></div>)}
          {r.strengths.map((w) => <div key={w.key} className="notice green" style={{ margin: '4px 0' }}><span><b>{WORDS[w.key]}</b>: {w.yours}% against {w.team}%. {w.tip}</span></div>)}
        </div>
      ))}
    </Section>
  );
}

function Calls() {
  const [days, setDays] = useState(30);
  const { data, err, reload } = useLoad(`/ats-plus/insights/calls?days=${days}`);
  const { run, busy, flash } = useAction(reload);
  const [open, setOpen] = useState(null); const [text, setText] = useState('');
  return (
    <Section title="Call recordings and transcripts" note={data ? data.note : ''} right={<select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">{[7, 30, 90, 365].map((d) => <option key={d} value={d}>Last {d} days</option>)}</select>}>
      <Notice tone="red">{err}</Notice>{flash}
      {data && (
        <Table rows={data.rows} rowKey={(r) => `${r.source}:${r.id}`} empty="No recorded calls in this period."
          cols={[
            { key: 'at', label: 'When', render: (r) => when(r.at) },
            { key: 'candidate', label: 'Candidate', render: (r) => r.candidate || '—' },
            { key: 'by', label: 'Called by', render: (r) => `${r.by}${r.source === 'ai' ? ' (AI call)' : ''}` },
            { key: 'rec', label: 'Recording', render: (r) => (r.recordingUrl ? <a href={r.recordingUrl} target="_blank" rel="noreferrer">Listen</a> : '—') },
            { key: 'tx', label: 'Transcript', render: (r) => (open === `${r.source}:${r.id}` ? (
              <span style={{ display: 'block', minWidth: 260 }}>
                <textarea rows={4} style={{ width: '100%' }} value={text} onChange={(e) => setText(e.target.value)} aria-label="Transcript" />
                <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.put(`/ats-plus/insights/calls/${r.source}/${r.id}/transcript`, { text }), 'Transcript saved.').then(() => setOpen(null))}>Save</button>{' '}
                <button type="button" className="btn btn-sm" onClick={() => setOpen(null)}>Cancel</button>
              </span>
            ) : (
              <span>{r.transcript ? <span title={r.transcriptBy}>{String(r.transcript).slice(0, 140)}{r.transcript.length > 140 ? '…' : ''}</span> : <span className="cell-muted">none</span>}{' '}
                <button type="button" className="btn btn-sm" onClick={() => { setOpen(`${r.source}:${r.id}`); setText(r.transcript || ''); }}>{r.transcript ? 'Edit' : 'Paste'}</button></span>
            )) },
          ]} />
      )}
    </Section>
  );
}

function AiActivity() {
  const [days, setDays] = useState(30); const [userId, setUserId] = useState('');
  const { data, err } = useLoad(`/ats-plus/insights/ai-activity?days=${days}${userId ? `&userId=${userId}` : ''}`);
  return (
    <Section title="AI activity log" note="Everything the AI assistant, the AI agent and the AI caller did: what, for whom and when. You see your own; an Admin can pick anyone."
      right={<span style={row}>
        {data && data.canPick && <select value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Person"><option value="">Me</option>{data.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">{[7, 30, 90, 365].map((d) => <option key={d} value={d}>Last {d} days</option>)}</select>
      </span>}>
      <Notice tone="red">{err}</Notice>
      {data && <Table rows={data.rows} rowKey={(r, i) => `${r.at}-${i}`} empty="The AI did nothing for this person in this period."
        cols={[{ key: 'at', label: 'When', render: (r) => when(r.at) }, { key: 'by', label: 'For' }, { key: 'what', label: 'What the AI did' }, { key: 'on', label: 'On', render: (r) => [r.on, r.onName].filter(Boolean).join(': ') || '—' }, { key: 'detail', label: 'Detail', render: (r) => r.detail || '—' }]} />}
    </Section>
  );
}

export default function RecruiterInsights() {
  const [tab, setTab] = useState('ratios');
  return (
    <div>
      <TabStrip label="Recruiter insights" tabs={TABS} value={tab} onChange={setTab} />
      {tab === 'ratios' && <Ratios />}
      {tab === 'coach' && <Coaching />}
      {tab === 'calls' && <Calls />}
      {tab === 'ai' && <AiActivity />}
    </div>
  );
}
