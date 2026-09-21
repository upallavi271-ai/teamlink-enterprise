// ---------------------------------------------------------------------------
// Knowledge Transfer — AI Weekly Idea Contribution.
//
// Every employee submits 3 unique HRMS-improvement ideas per week. Submitting
// runs the idea through the server-side AI (backend/src/utils/ideaAi.js),
// which screens it for duplicates and scores the unique ones on five named
// criteria. The key is never here: the browser only ever sees the result.
//
// The three stat cards and the Weekly Compliance list are SCOPED ON THE
// SERVER (utils/scope.js). Nothing on this screen filters people in the
// browser — the "/ 16" denominator is the number of employees in the viewer's
// own scope, and it is different for an employee, a TL and an admin because
// the API answered differently, not because this file hid rows.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import TabsPage from '../../components/TabsPage.jsx';
import {
  Panel, PanelHead, EmptyMini, QaRow, Modal, ScopeNote, Status,
} from '../../components/proto.jsx';
import { isHR as hasHrmsAdmin } from '../../permissions';

const SUBTITLE = 'Every employee submits 3 unique HRMS-improvement ideas per week. '
  + 'AI screens for duplicates and scores each unique idea on originality, usefulness, impact, clarity, and feasibility.';

const CRITERIA = [
  ['Originality', 'scoreOriginality'],
  ['Usefulness', 'scoreUsefulness'],
  ['Impact', 'scoreImpact'],
  ['Clarity', 'scoreClarity'],
  ['Feasibility', 'scoreFeasibility'],
];

// A score is a number or it is nothing. There is no third state and no
// placeholder digit — an unscored idea prints an em dash.
const score = (v) => (v == null ? <span className="cell-muted">—</span> : v);

function EmployeeCell({ name, code }) {
  return <>{name} <span className="cell-muted">({code})</span></>;
}

// --- Log KT Session (unchanged behaviour, /api/kt) --------------------------
function LogKtModal({ employees, onClose, onSaved }) {
  const [form, setForm] = useState({ topic: '', from: '', to: '' });
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    const fromEmp = employees.find((e) => e.id === form.from);
    const toEmp = employees.find((e) => e.id === form.to);
    try {
      await api.post('/kt', {
        employeeId: form.from || employees[0]?.id,
        title: form.topic || '(untitled)',
        fromName: fromEmp?.name,
        toName: toEmp?.name,
        date: new Date().toISOString().slice(0, 10),
      });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not log the session');
    }
  }

  return (
    <Modal
      title="Log KT Session"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={submit}>Save</button></>}
    >
      <div className="field"><label>Topic</label><input value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })} /></div>
      <div className="grid-2">
        <div className="field">
          <label>From</label>
          <select value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })}>
            <option value="">Select</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label>To</label>
          <select value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })}>
            <option value="">Select</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </div>
      </div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

// --- Submit an idea ---------------------------------------------------------
// The screening result is shown before the modal closes, so a duplicate is
// visibly caught rather than silently filed.
function SubmitIdeaModal({ ai, onClose, onSaved }) {
  const [form, setForm] = useState({ title: '', detail: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  async function submit() {
    setError('');
    if (!form.title.trim()) { setError('Enter the idea.'); return; }
    setBusy(true);
    try {
      const res = await api.post('/weekly-ideas', {
        title: form.title.trim(),
        detail: form.detail,
        date: new Date().toISOString().slice(0, 10),
      });
      setResult(res.data);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not submit the idea');
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const s = result.screening || {};
    const dup = s.duplicate;
    return (
      <Modal
        title={dup ? 'Duplicate — not counted' : 'Idea recorded'}
        onClose={onClose}
        footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}
      >
        <div style={{ marginBottom: 10 }}>
          <Status cls={dup ? 'rejected' : 'active'}>{dup ? 'Duplicate' : 'Unique'}</Status>
          <span className="small-muted" style={{ marginLeft: 8 }}>
            Screened by {s.method === 'model' ? `the AI model${result.aiModel ? ` (${result.aiModel})` : ''}` : 'the deterministic text-similarity check'}
            {s.similarity != null ? ` · closest match ${s.similarity}%` : ''}
          </span>
        </div>
        <div style={{ fontSize: 13, marginBottom: 10 }}>{s.note}</div>
        {result.scores ? (
          <div className="tbl-wrap">
            <table>
              <thead><tr>{CRITERIA.map(([label]) => <th key={label}>{label}</th>)}<th>Total</th></tr></thead>
              <tbody>
                <tr>
                  {CRITERIA.map(([label, key]) => <td key={label}>{result[key]}</td>)}
                  <td><strong>{result.scoreTotal} / 50</strong></td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <div className="small-muted">
            {dup
              ? 'Duplicates are not scored.'
              : ai && ai.configured
                ? 'This idea is unscored: AI scoring did not run for this submission, so no score has been recorded for it.'
                : 'This idea is unscored: AI scoring is not configured on this server, so no score has been recorded for it.'}
          </div>
        )}
        {s.reason && <div className="small-muted" style={{ marginTop: 8 }}>{s.reason}</div>}
      </Modal>
    );
  }

  return (
    <Modal
      title="Submit Weekly Idea"
      onClose={onClose}
      footer={(
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? 'Screening…' : 'Submit'}</button>
        </>
      )}
    >
      <div className="field"><label>Idea</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="One HRMS improvement, in a line" /></div>
      <div className="field"><label>Description</label><textarea rows="4" value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} placeholder="What changes, and why it helps" /></div>
      <div className="small-muted">
        {ai && ai.configured
          ? 'On submit this is screened for duplicates and scored on originality, usefulness, impact, clarity and feasibility.'
          : 'On submit this is screened for duplicates by a deterministic text-similarity check. AI scoring is not configured, so it will be recorded unscored.'}
      </div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

// --- Tab 1: Weekly Compliance ----------------------------------------------
function WeeklyCompliance({ data }) {
  const rows = (data && data.rows) || [];
  return (
    <Panel>
      <PanelHead title={`Weekly quota — ${(data && data.quota) || 3} unique ideas`} />
      {rows.length === 0 ? <EmptyMini>No employees in your scope.</EmptyMini> : (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Employee</th><th>Department</th><th>This Week</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.employeeId}>
                  <td><EmployeeCell name={r.name} code={r.employeeCode} /></td>
                  <td className="cell-muted">{r.department}</td>
                  <td>{r.count} / {r.quota}</td>
                  <td><Status cls={r.met ? 'active' : 'pending'}>{r.met ? 'Met' : 'Short'}</Status></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// --- Tab 2: Leaderboard -----------------------------------------------------
// Contributors ranked by their scored ideas. With no key configured nothing is
// scored, so the score columns read "—" and the order falls back to unique
// ideas contributed — a real figure rather than an invented score.
function Leaderboard({ data }) {
  const rows = (data && data.rows) || [];
  const scored = rows.some((r) => r.totalScore != null);
  return (
    <Panel>
      <PanelHead title={scored ? 'Top contributors — by AI score' : 'Top contributors — by unique ideas'} />
      {rows.length === 0 ? <EmptyMini>No ideas submitted yet.</EmptyMini> : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th><th>Employee</th><th>Department</th>
                <th>Unique Ideas</th><th>Duplicates</th><th>Weeks Active</th>
                <th>Scored</th><th>Avg Score</th><th>Total Score</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.employeeId}>
                  <td>{r.rank}</td>
                  <td><EmployeeCell name={r.name} code={r.employeeCode} /></td>
                  <td className="cell-muted">{r.department}</td>
                  <td>{r.unique}</td>
                  <td className="cell-muted">{r.duplicates}</td>
                  <td className="cell-muted">{r.weeks}</td>
                  <td className="cell-muted">{r.scored}</td>
                  <td>{r.avgScore == null ? <span className="cell-muted">—</span> : `${r.avgScore} / ${data.maxScore}`}</td>
                  <td>{score(r.totalScore)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!scored && rows.length > 0 && (
        <div className="small-muted" style={{ padding: '0 18px 14px' }}>
          No idea on file carries an AI score, so the ranking is by unique ideas contributed.
        </div>
      )}
    </Panel>
  );
}

// --- Tab 3: All Ideas -------------------------------------------------------
function AllIdeas({ ideas }) {
  return (
    <Panel>
      <PanelHead title={`All ideas on file (${ideas.length})`} />
      {ideas.length === 0 ? <EmptyMini>No ideas submitted yet.</EmptyMini> : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Employee</th><th>Idea</th><th>Week</th><th>Screening</th>
                {CRITERIA.map(([label]) => <th key={label}>{label}</th>)}
                <th>Total</th><th>Scored By</th>
              </tr>
            </thead>
            <tbody>
              {ideas.map((i) => (
                <tr key={i.id}>
                  <td>{i.employee ? <EmployeeCell name={i.employee.name} code={i.employee.employeeCode} /> : '—'}</td>
                  <td>
                    {i.title}
                    {i.detail && <div className="small-muted">{i.detail}</div>}
                  </td>
                  <td className="cell-muted">{i.weekStart || i.date || '—'}</td>
                  <td>
                    <Status cls={i.aiDuplicate ? 'rejected' : 'active'}>{i.aiDuplicate ? 'Duplicate' : 'Unique'}</Status>
                    {i.aiDuplicate && i.duplicateOfTitle && (
                      <div className="small-muted">of “{i.duplicateOfTitle}”{i.aiSimilarity != null ? ` · ${i.aiSimilarity}%` : ''}</div>
                    )}
                  </td>
                  {CRITERIA.map(([label, key]) => <td key={label}>{score(i[key])}</td>)}
                  <td>{i.scoreTotal == null ? <span className="cell-muted">—</span> : <strong>{i.scoreTotal}</strong>}</td>
                  <td className="cell-muted">
                    {i.aiMethod === 'model' ? `AI model${i.aiModel ? ` · ${i.aiModel}` : ''}` : i.aiMethod === 'fallback' ? 'Text-similarity fallback (unscored)' : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// --- The screen -------------------------------------------------------------
export default function KT() {
  const { user } = useAuth();
  const isHR = hasHrmsAdmin(user);
  const [compliance, setCompliance] = useState(null);
  const [board, setBoard] = useState(null);
  const [ideas, setIdeas] = useState([]);
  const [records, setRecords] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [ktOpen, setKtOpen] = useState(false);
  const [ideaOpen, setIdeaOpen] = useState(false);

  function load() {
    api.get('/weekly-ideas/compliance').then((res) => setCompliance(res.data)).catch(() => setCompliance(null));
    api.get('/weekly-ideas/leaderboard').then((res) => setBoard(res.data)).catch(() => setBoard(null));
    api.get('/weekly-ideas').then((res) => setIdeas(res.data)).catch(() => setIdeas([]));
    api.get('/kt').then((res) => setRecords(res.data)).catch(() => setRecords([]));
    api.get('/employees').then((res) => setEmployees(res.data)).catch(() => setEmployees([]));
  }
  useEffect(load, []);

  async function complete(r) {
    await api.patch(`/kt/${r.id}/status`, { status: 'Completed' });
    load();
  }

  const ai = compliance ? compliance.ai : null;
  const stats = [
    { label: 'Met 3-Idea Quota', value: compliance ? `${compliance.met} / ${compliance.inScope}` : '—', edge: 'var(--teal)' },
    { label: 'Week Starting', value: compliance ? compliance.weekStart : '—', edge: 'var(--navy)' },
    { label: 'Total Ideas on File', value: compliance ? compliance.totalIdeas : '—', edge: 'var(--amber)' },
  ];

  const banner = (
    <>
      {ai && !ai.configured && (
        <ScopeNote amber>
          <strong>AI scoring is not configured.</strong> Ideas are still submitted and stored, and duplicates are
          screened by a deterministic text-similarity check — but no originality, usefulness, impact, clarity or
          feasibility score is produced, and none is shown. {ai.reason} Add an Anthropic API key in
          Administration → Integrations to turn scoring on.
        </ScopeNote>
      )}
      <div className="stat-row" style={{ gridTemplateColumns: 'repeat(3,1fr)', marginBottom: 16 }}>
        {stats.map((s) => (
          <div key={s.label} className="stat-cell" style={{ borderLeft: `4px solid ${s.edge}` }}>
            <div className="v">{s.value}</div>
            <div className="l">{s.label}</div>
          </div>
        ))}
      </div>
    </>
  );

  return (
    <div>
      {/* Not a .page-head: styles.css hides one inside a tab strip, and this
          screen only ever renders inside Performance & Development's tabs. */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 14, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <h2 style={{ fontSize: 18, margin: 0 }}>Knowledge Transfer — AI Weekly Idea Contribution</h2>
          <div className="page-sub" style={{ marginTop: 3, maxWidth: 760 }}>{SUBTITLE}</div>
        </div>
        <QaRow style={{ margin: 0 }}>
          <button className="btn btn-primary btn-sm" onClick={() => setIdeaOpen(true)}>Submit Idea</button>
          <button className="btn btn-sm" onClick={() => setKtOpen(true)}>Log KT Session</button>
        </QaRow>
      </div>

      <TabsPage
        embedded
        banner={banner}
        tabs={[
          { key: 'compliance', label: 'Weekly Compliance', element: <WeeklyCompliance data={compliance} /> },
          { key: 'leaderboard', label: 'Leaderboard', element: <Leaderboard data={board} /> },
          { key: 'ideas', label: 'All Ideas', element: <AllIdeas ideas={ideas} /> },
        ]}
      />

      {/* KT sessions and handovers — the other half of Knowledge Transfer,
          unchanged (/api/kt). */}
      <Panel style={{ marginTop: 18 }}>
        <PanelHead title="KT Sessions" />
        {records.length === 0 ? <EmptyMini>No KT sessions logged yet.</EmptyMini> : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Topic</th><th>From</th><th>To</th><th>Date</th><th>Status</th>{isHR && <th></th>}</tr></thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id}>
                    <td>{r.title}</td>
                    <td className="cell-muted">{r.fromName || r.employee?.name || '—'}</td>
                    <td className="cell-muted">{r.toName || '—'}</td>
                    <td className="cell-muted">{r.date || '—'}</td>
                    <td><span className={`status ${r.status === 'Completed' ? 'active' : 'review'}`}>{r.status}</span></td>
                    {isHR && <td>{r.status !== 'Completed' && <button className="btn btn-sm" onClick={() => complete(r)}>Mark Completed</button>}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {ktOpen && <LogKtModal employees={employees} onClose={() => setKtOpen(false)} onSaved={() => { setKtOpen(false); load(); }} />}
      {ideaOpen && <SubmitIdeaModal ai={ai} onClose={() => { setIdeaOpen(false); load(); }} onSaved={load} />}
    </div>
  );
}
