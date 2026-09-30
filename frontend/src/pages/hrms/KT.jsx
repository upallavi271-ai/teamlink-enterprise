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
  Panel, PanelHead, QaRow, Modal, ScopeNote, Status,
} from '../../components/proto.jsx';
import { isHR as hasHrmsAdmin, canDecideServices, canManageServices } from '../../permissions';
import AudiencePicker, { DeliverVia, audienceReady, useAudienceOptions } from '../../components/AudiencePicker.jsx';
import {
  ComposeModal, Field, Row, AiAssist, ResultNote, useSubmit,
} from '../../components/ComposeForm.jsx';
import Combo from '../../components/Combo.jsx';
import PeopleFilterBar, { EMPTY_PEOPLE_FILTERS, peopleMatches, peopleOptions, statusOptions, textMatches } from '../../components/PeopleFilterBar.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import { ListEmpty } from '../../components/ui/ListFilters.jsx';
import DataIoBar from '../../components/dataio/DataIoBar.jsx';

// The filter bars below offer the person filters (Employee name / ID,
// Department, Role, Employee status) only when the list actually holds more
// than one person — an employee who sees only their own row gets none.
const manyPeople = (rows, idOf) => new Set(rows.map(idOf).filter(Boolean)).size > 1;
const clearAll = (setPf) => () => setPf((f) => Object.fromEntries(Object.keys(f).map((k) => [k, ''])));
const lfOf = (pf, setPf) => ({ activeCount: Object.values(pf).some(Boolean) ? 1 : 0, clear: clearAll(setPf) });

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

// --- Log KT Session (/api/kt) ------------------------------------------------
// The reference compose layout. A lead who may create for others picks the
// presenter and sends the session to one person, several people, one or MANY
// departments, or everyone in scope — one KT row per recipient (From =
// presenter, To = that recipient). Anyone else logs a session of their own.
function LogKtModal({ canSend, me, onClose, onSaved }) {
  const { opts } = useAudienceOptions();
  const [form, setForm] = useState({ topic: '', detail: '', from: '', toName: '', date: new Date().toISOString().slice(0, 10) });
  const [audience, setAudience] = useState({ mode: 'individuals', departments: [], employeeIds: [] });
  const [channels, setChannels] = useState([]);
  const { busy, error, setError, run } = useSubmit();
  const people = opts?.employees || [];

  async function submit() {
    if (!form.topic.trim()) { setError('Enter the topic.'); return; }
    const presenter = people.find((e) => e.id === form.from);
    let body;
    if (canSend) {
      if (!audienceReady(audience)) { setError(audience.mode === 'departments' ? 'Pick at least one department.' : 'Pick at least one employee.'); return; }
      body = {
        title: form.topic.trim(), detail: form.detail || null, date: form.date,
        fromName: presenter ? presenter.name : me, audience, channels,
      };
    } else {
      body = { title: form.topic.trim(), detail: form.detail || null, date: form.date, fromName: me, toName: form.toName || null };
    }
    const res = await run(() => api.post('/kt', body), 'Could not log the session');
    if (res) onSaved(res.data);
  }

  return (
    <ComposeModal title="Log KT Session" onClose={onClose} onSubmit={submit} submitLabel="Log Session" busy={busy} error={error} wide={canSend}>
      <Field label="Topic" required><input value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })} /></Field>
      <AiAssist kind="kt" title={form.topic} text={form.detail} onText={(detail) => setForm((f) => ({ ...f, detail }))} />
      <Field label="Notes"><textarea rows="3" value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} placeholder="What was handed over" /></Field>
      <Row>
        {canSend ? (
          <Field label="Presented by">
            <Combo value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })}>
              <option value="">{me || 'Me'}</option>
              {people.map((e) => <option key={e.id} value={e.id}>{e.name}{e.employeeCode ? ` · ${e.employeeCode}` : ''}</option>)}
            </Combo>
          </Field>
        ) : (
          <Field label="Handed over to"><input value={form.toName} onChange={(e) => setForm({ ...form, toName: e.target.value })} placeholder="Name" /></Field>
        )}
        <Field label="Date" required><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
      </Row>
      {canSend && (
        <>
          <AudiencePicker value={audience} onChange={setAudience} label="Knowledge transfer to" required />
          <DeliverVia value={channels} onChange={setChannels} />
        </>
      )}
    </ComposeModal>
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
    <ComposeModal title="Submit Weekly Idea" onClose={onClose} onSubmit={submit} submitLabel="Submit Idea" busyLabel="Screening…" busy={busy} error={error}>
      <Field label="Idea" required><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="One HRMS improvement, in a line" /></Field>
      <Field label="Description"><textarea rows="4" value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} placeholder="What changes, and why it helps" /></Field>
      <div className="small-muted">
        {ai && ai.configured
          ? 'On submit this is screened for duplicates and scored on originality, usefulness, impact, clarity and feasibility.'
          : 'On submit this is screened for duplicates by a deterministic text-similarity check. AI scoring is not configured, so it will be recorded unscored.'}
      </div>
    </ComposeModal>
  );
}

// --- Tab 1: Weekly Compliance ----------------------------------------------
function WeeklyCompliance({ data }) {
  const all = (data && data.rows) || [];
  const [pf, setPf] = useState(EMPTY_PEOPLE_FILTERS);
  // This week's standing is the row's status: Met or Short of the quota.
  const statusOf = (r) => (r.met ? 'Met' : 'Short');
  const rows = all.filter((r) => peopleMatches(r, pf, undefined, statusOf));
  const opts = peopleOptions(all);
  const many = manyPeople(all, (r) => r.employeeId);
  const page = usePaged(rows);
  return (
    <Panel>
      <PanelHead title={`Weekly quota — ${(data && data.quota) || 3} unique ideas`} />
      <div style={{ padding: '0 18px' }}>
        <PeopleFilterBar
          filters={pf} setFilters={setPf} people={many}
          departments={many ? opts.departments : undefined} roles={many ? opts.roles : undefined}
          statuses={['Met', 'Short']} shown={rows.length} total={all.length}
        />
      </div>
      {rows.length === 0 ? <ListEmpty lf={lfOf(pf, setPf)} noun="employees" title="No employees in your scope." /> : (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Employee</th><th>Department</th><th>This Week</th><th>Status</th></tr></thead>
            <tbody>
              {page.slice.map((r) => (
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
      {page.total > 0 && <Pager page={page} noun="employees" />}
    </Panel>
  );
}

// --- Tab 2: Leaderboard -----------------------------------------------------
// Contributors ranked by their scored ideas. With no key configured nothing is
// scored, so the score columns read "—" and the order falls back to unique
// ideas contributed — a real figure rather than an invented score.
function Leaderboard({ data }) {
  const all = (data && data.rows) || [];
  // A ranking has no status of its own, so only the person filters apply.
  const [pf, setPf] = useState(EMPTY_PEOPLE_FILTERS);
  const rows = all.filter((r) => peopleMatches(r, pf));
  const opts = peopleOptions(all);
  const scored = rows.some((r) => r.totalScore != null);
  const many = manyPeople(all, (r) => r.employeeId);
  const page = usePaged(rows);
  return (
    <Panel>
      <PanelHead title={scored ? 'Top contributors — by AI score' : 'Top contributors — by unique ideas'} />
      <div style={{ padding: '0 18px' }}>
        <PeopleFilterBar
          filters={pf} setFilters={setPf} people={many}
          departments={many ? opts.departments : undefined} roles={many ? opts.roles : undefined}
          shown={rows.length} total={all.length}
        />
      </div>
      {rows.length === 0 ? <ListEmpty lf={lfOf(pf, setPf)} noun="contributors" title="No ideas submitted yet." /> : (
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
              {page.slice.map((r) => (
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
      {page.total > 0 && <Pager page={page} noun="contributors" />}
      {!scored && rows.length > 0 && (
        <div className="small-muted" style={{ padding: '0 18px 14px' }}>
          No idea on file carries an AI score, so the ranking is by unique ideas contributed.
        </div>
      )}
    </Panel>
  );
}

// --- Tab 3: All Ideas -------------------------------------------------------
function AllIdeas({ ideas: all }) {
  // An idea's status is its screening result: Unique or Duplicate.
  const [pf, setPf] = useState({ q: '', ...EMPTY_PEOPLE_FILTERS, week: '' });
  const [sort, setSort] = useState('new');
  const statusOf = (i) => (i.aiDuplicate ? 'Duplicate' : 'Unique');
  const weekOf = (i) => i.weekStart || i.date || '';
  const ideas = all.filter((i) => textMatches(`${i.title || ''} ${i.detail || ''}`, pf.q)
    && peopleMatches(i, pf, undefined, statusOf) && (!pf.week || weekOf(i) === pf.week));
  const opts = peopleOptions(all);
  const weeks = [...new Set(all.map(weekOf).filter(Boolean))].sort().reverse();
  const many = manyPeople(all, (i) => i.employee?.id || i.employeeId);
  const SORTS = {
    new: (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
    score: (a, b) => (b.scoreTotal ?? -1) - (a.scoreTotal ?? -1),
  };
  const page = usePaged([...ideas].sort(SORTS[sort] || SORTS.new));
  return (
    <Panel>
      <PanelHead title={`All ideas on file (${all.length})`} />
      <div style={{ padding: '0 18px' }}>
        <PeopleFilterBar
          filters={pf} setFilters={setPf} people={many} search="Idea"
          departments={many ? opts.departments : undefined} roles={many ? opts.roles : undefined}
          statuses={['Unique', 'Duplicate']} statusLabel="All screening results" shown={ideas.length} total={all.length}
          labels={{ week: 'Week', status: 'Screening' }}
        >
          <Combo value={pf.week} title="Week" onChange={(e) => setPf((f) => ({ ...f, week: e.target.value }))}>
            <option value="">All weeks</option>
            {weeks.map((w) => <option key={w} value={w}>Week of {w}</option>)}
          </Combo>
          <label className="lf-sort">
            Sort
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="new">Newest first</option>
              <option value="score">Total score (high to low)</option>
            </select>
          </label>
        </PeopleFilterBar>
      </div>
      {ideas.length === 0 ? <ListEmpty lf={lfOf(pf, setPf)} noun="ideas" title="No ideas submitted yet." /> : (
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
              {page.slice.map((i) => (
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
      {page.total > 0 && <Pager page={page} noun="ideas" />}
    </Panel>
  );
}

// --- The screen -------------------------------------------------------------
export default function KT() {
  const { user } = useAuth();
  // isHR here DRAWS WRITE CONTROLS, so it asks the write permission and not
  // only the read one. A Manager and an Assistant Manager are view-only (§3,
  // §4) and still hold Employee Management/view, so isHR() alone would have
  // gone on offering them every button on this screen. Both halves, because
  // the screen is an administration screen AND these are writes.
  const isHR = hasHrmsAdmin(user) && canDecideServices(user);
  // May send a KT session to other people (Send-to picker). A view-only
  // Manager / Assistant Manager reads the list but is not drawn the button;
  // an employee without the HRMS admin view logs their own session.
  const hrView = hasHrmsAdmin(user);
  const canSendKt = hrView && (canManageServices(user) || canDecideServices(user));
  const canLogKt = !hrView || canSendKt;
  const [ktDone, setKtDone] = useState('');
  const [compliance, setCompliance] = useState(null);
  const [board, setBoard] = useState(null);
  const [ideas, setIdeas] = useState([]);
  const [records, setRecords] = useState([]);
  const [ktOpen, setKtOpen] = useState(false);
  const [ideaOpen, setIdeaOpen] = useState(false);
  // KT sessions filter by the person handing over (the record's employee) and
  // the session's own status.
  const [kf, setKf] = useState({ q: '', ...EMPTY_PEOPLE_FILTERS, from: '', to: '' });

  function load() {
    api.get('/weekly-ideas/compliance').then((res) => setCompliance(res.data)).catch(() => setCompliance(null));
    api.get('/weekly-ideas/leaderboard').then((res) => setBoard(res.data)).catch(() => setBoard(null));
    api.get('/weekly-ideas').then((res) => setIdeas(res.data)).catch(() => setIdeas([]));
    api.get('/kt').then((res) => setRecords(res.data)).catch(() => setRecords([]));
  }
  useEffect(load, []);

  async function complete(r) {
    await api.patch(`/kt/${r.id}/status`, { status: 'Completed' });
    load();
  }

  const sessions = records.filter((r) => textMatches(`${r.title} ${r.fromName || ''} ${r.toName || ''} ${r.detail || ''}`, kf.q) && peopleMatches(r, kf));
  const ktOpts = peopleOptions(records);
  const ktMany = manyPeople(records, (r) => r.employeeId);
  const ktPage = usePaged(sessions);

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
          {canLogKt && <button className="btn btn-sm" onClick={() => setKtOpen(true)}>Log KT Session</button>}
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
        {ktDone && <div style={{ padding: '0 18px' }}><ResultNote>{ktDone}</ResultNote></div>}
        {/* Data I/O for KT SESSIONS: export all / one employee and import
            with the compulsory sample (backend src/io/kt.js). The AI Weekly
            Ideas are not importable — they are scored on submission. */}
        <div style={{ padding: '0 18px 8px' }}>
          <DataIoBar
            ioKey="kt"
            params={Object.fromEntries(['department', 'status', 'from', 'to'].filter((k) => kf[k]).map((k) => [k, kf[k]]))}
            onImported={load}
          />
        </div>
        <div style={{ padding: '0 18px' }}>
          <PeopleFilterBar
            filters={kf} setFilters={setKf} search="Topic, from or to" people={ktMany}
            departments={ktMany ? ktOpts.departments : undefined} roles={ktMany ? ktOpts.roles : undefined}
            statuses={statusOptions(records, ['Open', 'Completed'])} shown={sessions.length} total={records.length}
            dates="Date"
          />
        </div>
        {sessions.length === 0 ? <ListEmpty lf={lfOf(kf, setKf)} noun="KT sessions" title="No KT sessions logged yet." /> : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Topic</th><th>From</th><th>To</th><th>Date</th><th>Status</th>{isHR && <th></th>}</tr></thead>
              <tbody>
                {ktPage.slice.map((r) => (
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
        {ktPage.total > 0 && <Pager page={ktPage} noun="KT sessions" />}
      </Panel>

      {ktOpen && (
        <LogKtModal
          canSend={canSendKt}
          me={user?.name}
          onClose={() => setKtOpen(false)}
          onSaved={(r) => { setKtOpen(false); setKtDone(r.created != null ? `KT session logged for ${r.label} — ${r.created} employee(s). ${r.deliveryText || ''}` : 'KT session logged.'); load(); }}
        />
      )}
      {ideaOpen && <SubmitIdeaModal ai={ai} onClose={() => { setIdeaOpen(false); load(); }} onSaved={load} />}
    </div>
  );
}
