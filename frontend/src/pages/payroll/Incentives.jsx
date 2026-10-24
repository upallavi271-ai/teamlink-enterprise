// ---------------------------------------------------------------------------
// PAYROLL -> INCENTIVES (HRMS spec 2026-10-09, point 4).
//
//   1. THE MONTH   pick a month, "Work out the month" proposes an incentive for
//                  everyone who qualifies under the rules; Super Admin approves
//                  or rejects each one. Approved = an Incentive earning in the
//                  payroll of the month it is paid with (and its payslip).
//   2. THE RULES   per department (and role): what is measured, how much must
//                  be achieved, what is paid. Super Admin edits; the table
//                  starts empty - no amount is ever made up.
//   3. HISTORY     one person's incentives, month by month, and where each
//                  stands in payroll. Every employee sees their own.
// (backend: routes/incentives.js, utils/incentives.js)
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { FacetSelect, useLocalFacets } from '../../components/ui/ListPageHeader.jsx';
import './incentives.css';
import Combo from '../../components/Combo.jsx';

const inr = (n) => (n === null || n === undefined || n === '' ? '—' : `₹${Math.round(Number(n)).toLocaleString('en-IN')}`);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (m) => (/^\d{4}-\d{2}$/.test(m || '') ? `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}` : m || '');
const errText = (e, fallback) => (e && e.response && e.response.data && e.response.data.error) || fallback;
const STATUS_WORD = { 'Waiting for amount': 'Target completed - waiting for the amount', Pending: 'Waiting for approval', Approved: 'Approved', Rejected: 'Rejected', Paid: 'Paid' };
const STATUS_TONE = { 'Waiting for amount': 'blue', Pending: 'orange', Approved: 'green', Rejected: 'red', Paid: 'green' };
const metricWord = (m) => ({ JOININGS: 'Joinings (ATS)', TARGET: 'Monthly target', MANUAL: 'Typed in by HR' }[m] || m);
const basisWord = (b, r) => (b === 'COMPLETION' ? (Number(r.amount) > 0 ? `${inr(r.amount)} when the target is completed` : 'Amount not set: Super Admin gives it when the target is completed')
  : b === 'FIXED' ? `${inr(r.amount)} once`
  : b === 'PER_UNIT' ? `${inr(r.amount)} for each one`
    : `${inr(r.amount)} for each one above ${r.target != null ? r.target : r.minAchieved}`);
const lastMonth = () => { const d = new Date(); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

function Pill({ tone, children }) { return <span className={`inc-pill tone-${tone}`}>{children}</span>; }

// ---- the rule form ----------------------------------------------------------------
const EMPTY_RULE = { name: '', department: '', role: '', metric: 'JOININGS', minAchieved: '', target: '', basis: 'COMPLETION', amount: '', maxAmount: '', carryForward: false, fromMonth: '', toMonth: '', active: true, note: '' };
function RuleModal({ rule, options, onClose, onSaved }) {
  const [f, setF] = useState(rule ? { ...EMPTY_RULE, ...Object.fromEntries(Object.entries(rule).map(([k, v]) => [k, v === null ? '' : v])) } : EMPTY_RULE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  async function save(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const body = { ...f, minAchieved: f.minAchieved === '' ? 0 : Number(f.minAchieved), target: f.target === '' ? null : Number(f.target), amount: f.amount === '' ? null : Number(f.amount), maxAmount: f.maxAmount === '' ? null : Number(f.maxAmount) };
      const r = rule ? await api.put(`/incentives/rules/${rule.id}`, body) : await api.post('/incentives/rules', body);
      onSaved(r.data.message);
    } catch (err) { setError(errText(err, 'Could not save the rule.')); } finally { setBusy(false); }
  }
  const unit = metricWord(f.metric).toLowerCase();
  return (
    <Modal title={rule ? 'Change rule' : 'New incentive rule'} size="wide" onClose={onClose}
      foot={<><button className="btn btn-primary" type="submit" form="inc-rule" disabled={busy}>{busy ? 'Saving…' : 'Save rule'}</button><button className="btn" type="button" onClick={onClose}>Cancel</button></>}>
      <form id="inc-rule" onSubmit={save} className="inc-form">
        {error && <div className="error-text">{error}</div>}
        <label className="field"><span>Name of the rule</span><input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Education recruiter - 4 joinings" /></label>
        <div className="grid-2">
          <label className="field"><span>Department</span>
            <Combo value={f.department} onChange={(e) => set('department', e.target.value)}>
              <option value="">Every department</option>
              {options.departments.map((d) => <option key={d.value} value={d.value}>{d.label} ({d.count})</option>)}
            </Combo>
          </label>
          <label className="field"><span>Role (designation)</span>
            <Combo value={f.role} onChange={(e) => set('role', e.target.value)}>
              <option value="">Everyone in the department</option>
              {options.roles.map((d) => <option key={d.value} value={d.value}>{d.label} ({d.count})</option>)}
            </Combo>
          </label>
          <label className="field"><span>What is measured</span>
            <Combo value={f.metric} onChange={(e) => set('metric', e.target.value)}>
              {options.metrics.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </Combo>
          </label>
          <label className="field"><span>Must achieve at least</span>
            <input type="number" min="0" value={f.minAchieved} onChange={(e) => set('minAchieved', e.target.value)} placeholder="0" />
            <span className="small-muted">Below this in the month, nothing is paid ({unit}).</span>
          </label>
          <label className="field"><span>How the amount is worked out</span>
            <Combo value={f.basis} onChange={(e) => set('basis', e.target.value)}>
              {options.bases.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </Combo>
          </label>
          <label className="field"><span>Amount (₹)</span>
            <input type="number" min="1" value={f.amount} onChange={(e) => set('amount', e.target.value)} placeholder={f.basis === 'COMPLETION' ? 'Leave empty: decided each time' : ''} />
            {f.basis === 'COMPLETION' && <span className="small-muted">Empty = nothing is paid by itself; when the target is completed it waits for you to give the amount.</span>}
          </label>
          {(f.basis === 'COMPLETION' || f.basis === 'PER_UNIT_OVER_TARGET') && (
            <label className="field"><span>{f.basis === 'COMPLETION' ? 'Target to complete each month' : 'Target'}</span><input type="number" min="0" value={f.target} onChange={(e) => set('target', e.target.value)} placeholder="4" /></label>
          )}
          {f.basis === 'PER_UNIT_OVER_TARGET' && (
            <span className="small-muted">Blank target = the person&apos;s own target (or the minimum above).</span>
          )}
          <label className="field"><span>Most one person can get in a month (₹)</span><input type="number" min="1" value={f.maxAmount} onChange={(e) => set('maxAmount', e.target.value)} placeholder="No limit" /></label>
          <label className="field"><span>From month</span><input type="month" value={f.fromMonth} onChange={(e) => set('fromMonth', e.target.value)} /></label>
          <label className="field"><span>Until month</span><input type="month" value={f.toMonth} onChange={(e) => set('toMonth', e.target.value)} /></label>
        </div>
        <label className="field"><span>Note</span><input value={f.note} onChange={(e) => set('note', e.target.value)} /></label>
        {f.metric === 'JOININGS' && f.basis === 'COMPLETION' && (
          <>
            <label className="inc-check"><input type="checkbox" checked={!!f.carryForward} onChange={(e) => set('carryForward', e.target.checked)} /> If someone joins fewer, add the missing ones to next month&apos;s target</label>
            {f.carryForward && <p className="small-muted">Example with a target of 4: joined 2 in January, so February&apos;s target is 6; joined 2 in February, so March&apos;s target is 8. Counting starts at the &quot;From month&quot; below (nothing is carried from before it). Joining more than the target does not make a later target smaller than {f.target || 4}.</p>}
          </>
        )}
        {rule && (
          <label className="inc-check"><input type="checkbox" checked={!!f.active} onChange={(e) => set('active', e.target.checked)} /> The rule is on</label>
        )}
        <p className="small-muted">When more than one rule fits a person, the most specific one is used (department and role, then department, then role, then everyone).</p>
      </form>
    </Modal>
  );
}

// ---- add one by hand -------------------------------------------------------------------
function AddModal({ rules, month, onClose, onSaved }) {
  const [people, setPeople] = useState([]);
  const [f, setF] = useState({ employeeId: '', ruleId: '', achieved: '', amount: '', month, note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/incentives/people').then((r) => setPeople(r.data.people || [])).catch(() => setPeople([])); }, []);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  async function save(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const r = await api.post('/incentives/awards', { ...f, achieved: f.achieved === '' ? undefined : Number(f.achieved), amount: f.amount === '' ? undefined : Number(f.amount) });
      onSaved(r.data.message);
    } catch (err) { setError(errText(err, 'Could not add it.')); } finally { setBusy(false); }
  }
  return (
    <Modal title="Add an incentive" onClose={onClose}
      foot={<><button className="btn btn-primary" type="submit" form="inc-add" disabled={busy}>{busy ? 'Saving…' : 'Add'}</button><button className="btn" type="button" onClick={onClose}>Cancel</button></>}>
      <form id="inc-add" onSubmit={save} className="inc-form">
        {error && <div className="error-text">{error}</div>}
        <label className="field"><span>Person</span>
          <Combo value={f.employeeId} onChange={(e) => set('employeeId', e.target.value)}>
            <option value="">Pick a person</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.employeeCode} · {p.department || '—'}</option>)}
          </Combo>
        </label>
        <label className="field"><span>Month the work was done in</span><input type="month" value={f.month} onChange={(e) => set('month', e.target.value)} /></label>
        <label className="field"><span>Under which rule</span>
          <Combo value={f.ruleId} onChange={(e) => set('ruleId', e.target.value)}>
            <option value="">No rule - I will type the amount</option>
            {rules.filter((r) => r.active).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Combo>
        </label>
        {f.ruleId
          ? <label className="field"><span>How much was achieved</span><input type="number" min="0" value={f.achieved} onChange={(e) => set('achieved', e.target.value)} /><span className="small-muted">The amount is worked out from the rule.</span></label>
          : <label className="field"><span>Amount (₹)</span><input type="number" min="1" value={f.amount} onChange={(e) => set('amount', e.target.value)} /></label>}
        <label className="field"><span>Note</span><input value={f.note} onChange={(e) => set('note', e.target.value)} placeholder="Why" /></label>
        <p className="small-muted">It waits for approval like the others.</p>
      </form>
    </Modal>
  );
}

// ---- one person's history -----------------------------------------------------------------
function HistoryTable({ data }) {
  if (!data) return <div className="small-muted">Loading…</div>;
  return (
    <div>
      <div className="inc-sub">
        {data.employee ? <><b>{data.employee.name}</b> · {data.employee.employeeCode} · {data.employee.department || '—'}</> : null}
        {' · '}Approved so far: <b>{inr(data.totalApproved)}</b>
      </div>
      {data.rows.length === 0 ? <div className="inc-empty">No incentives for this person yet.</div> : (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Month</th><th>For</th><th>Achieved</th><th>Amount</th><th>Status</th><th>Where it is in payroll</th></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={`${r.kind}-${r.id}`}>
                  <td>{r.label}</td>
                  <td>{r.rule}<div className="small-muted">{metricWord(r.metric)}</div></td>
                  <td>{r.achieved}{r.target != null ? ` of ${r.target}` : ''}</td>
                  <td><b>{inr(r.amount)}</b></td>
                  <td><Pill tone={STATUS_TONE[r.status] || 'grey'}>{STATUS_WORD[r.status] || r.status}</Pill></td>
                  <td className="small-muted">{r.pay || '—'}{r.decidedByName ? ` · decided by ${r.decidedByName}` : ''}{r.note ? ` · ${r.note}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function Incentives() {
  const [options, setOptions] = useState(null);
  const [month, setMonth] = useState(lastMonth());
  const [preview, setPreview] = useState(null);
  const [awards, setAwards] = useState(null);
  const [rules, setRules] = useState(null);
  const [canEdit, setCanEdit] = useState(false);
  const [mine, setMine] = useState(null);
  const [hist, setHist] = useState(null);
  const [histFor, setHistFor] = useState('');
  const [people, setPeople] = useState([]);
  const [dept, setDept] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [ruleModal, setRuleModal] = useState(null); // null | {} | rule
  const [adding, setAdding] = useState(false);
  const [decide, setDecide] = useState(null); // { award, decision, payMonth, note }

  const all = !!(options && options.viewer.all);
  const sa = !!(options && options.viewer.superAdmin);

  useEffect(() => { api.get('/incentives/options').then((r) => setOptions(r.data)).catch((e) => setError(errText(e, 'Could not open Incentives.'))); }, []);
  const load = useCallback(() => {
    if (!options) return;
    setError('');
    if (!options.viewer.all) { api.get('/incentives/mine').then((r) => setMine(r.data)).catch((e) => setError(errText(e, 'Could not load your incentives.'))); return; }
    Promise.all([
      api.get('/incentives/preview', { params: { month } }),
      api.get('/incentives/awards', { params: { month } }),
      api.get('/incentives/rules'),
    ]).then(([p, a, r]) => { setPreview(p.data); setAwards(a.data); setRules(r.data.rules); setCanEdit(r.data.canEdit); })
      .catch((e) => setError(errText(e, 'Could not load the incentives.')));
  }, [options, month]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (all) api.get('/incentives/people').then((r) => setPeople(r.data.people || [])).catch(() => setPeople([])); }, [all]);
  useEffect(() => {
    if (!histFor) { setHist(null); return; }
    api.get(`/incentives/history/${histFor}`).then((r) => setHist(r.data)).catch((e) => setError(errText(e, 'Could not load the history.')));
  }, [histFor, awards]);

  async function generate() {
    setBusy('gen'); setMsg(''); setError('');
    try { const r = await api.post('/incentives/generate', { month }); setMsg(r.data.message); load(); } catch (e) { setError(errText(e, 'Could not work it out.')); } finally { setBusy(''); }
  }
  async function sendDecision() {
    setBusy('dec'); setError('');
    try {
      const r = await api.post(`/incentives/awards/${decide.award.id}/decision`, { decision: decide.decision, payMonth: decide.payMonth || undefined, note: decide.note, amount: decide.amount === '' || decide.amount === undefined ? undefined : Number(decide.amount) });
      setMsg(r.data.message); setDecide(null); load();
    } catch (e) { setError(errText(e, 'Could not save the decision.')); } finally { setBusy(''); }
  }
  async function undo(a) {
    try { const r = await api.post(`/incentives/awards/${a.id}/decision`, { decision: 'undo' }); setMsg(r.data.message); load(); } catch (e) { setError(errText(e, 'Could not undo.')); }
  }
  async function removeRule(r) {
    if (!window.confirm(`Remove "${r.name}"?`)) return;
    try { const x = await api.delete(`/incentives/rules/${r.id}`); setMsg(x.data.message); load(); } catch (e) { setError(errText(e, 'Could not remove it.')); }
  }
  async function toggleRule(r) {
    try { const x = await api.put(`/incentives/rules/${r.id}`, { active: !r.active }); setMsg(x.data.message); load(); } catch (e) { setError(errText(e, 'Could not save.')); }
  }

  const FIELDS = useMemo(() => [{ key: 'department', get: (p) => p.department || '' }], []);
  const peopleFacets = useLocalFacets(people, FIELDS, { department: dept });
  const shownPeople = people.filter((p) => !dept || p.department === dept);

  if (!options) return <div className="inc">{error ? <div className="error-text">{error}</div> : <div className="small-muted">Loading…</div>}</div>;

  // ---- an employee without payroll rights: their own history only
  if (!all) {
    return (
      <div className="inc">
        <p className="inc-lead">Your incentives, month by month, and where each one is in payroll.</p>
        {error && <div className="error-text">{error}</div>}
        <HistoryTable data={mine} />
      </div>
    );
  }

  const awardRows = awards ? awards.rows : [];
  const waiting = awardRows.filter((a) => ['Pending', 'Waiting for amount'].includes(a.status)).length;
  const rowsPreview = preview ? preview.rows.filter((r) => !r.award) : [];

  return (
    <div className="inc">
      <p className="inc-lead">
        Incentives follow the <b>rules</b> below. Each month: <b>work out the month</b>, then <b>approve</b> each incentive. An approved incentive is paid as an
        &quot;Incentive&quot; line on the person&apos;s payslip, in the month you choose.
      </p>
      {msg && <div className="notice inc-note">{msg}</div>}
      {error && <div className="error-text">{error}</div>}

      <div className="inc-bar">
        <label className="inc-month"><span>Month the work was done in</span>
          <input type="month" value={month} max={options.lastMonth} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </label>
        <span className="inc-grow" />
        {sa && <button className="btn btn-primary" disabled={busy === 'gen'} onClick={generate}>{busy === 'gen' ? 'Working it out…' : `Work out ${monthLabel(month)}`}</button>}
        {sa && <button className="btn" onClick={() => setAdding(true)}>Add one by hand</button>}
      </div>

      {/* 1. the month */}
      <h3 className="inc-h">{monthLabel(month)} — {awardRows.length === 0 ? 'nothing worked out yet' : `${awardRows.length} incentive${awardRows.length === 1 ? '' : 's'}${waiting ? `, ${waiting} waiting for approval` : ''}`}</h3>
      {rules && rules.length === 0 && <div className="inc-empty">There are no rules yet. {sa ? 'Add the first rule below - nothing is paid until you do.' : 'Super Admin writes them.'}</div>}
      {awardRows.length > 0 && (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Employee</th><th>Rule</th><th>Achieved</th><th>Amount</th><th>Status</th><th /></tr></thead>
            <tbody>
              {awardRows.map((a) => (
                <tr key={a.id}>
                  <td><button type="button" className="link-btn" onClick={() => setHistFor(a.employeeId)}>{a.name}</button><div className="small-muted">{a.employeeCode} · {a.department || '—'}</div></td>
                  <td>{a.rule}<div className="small-muted">{metricWord(a.metric)}</div></td>
                  <td>{a.achieved}{a.target != null ? ` of ${a.target}` : ''}{a.carriedIn > 0 ? <div className="small-muted">{a.baseTarget} + {a.carriedIn} carried</div> : null}</td>
                  <td>{a.amount > 0 ? <b>{inr(a.amount)}</b> : <span className="small-muted">Not decided</span>}</td>
                  <td><Pill tone={STATUS_TONE[a.status]}>{STATUS_WORD[a.status] || a.status}</Pill>{a.payLabel ? <div className="small-muted">with {a.payLabel} salary</div> : null}</td>
                  <td className="inc-acts">
                    {awards.canDecide && ['Pending', 'Waiting for amount'].includes(a.status) && (
                      <>
                        <button className="btn btn-sm btn-primary" onClick={() => setDecide({ award: a, decision: 'approve', payMonth: '', note: '', amount: a.amount > 0 ? '' : '' })}>{a.status === 'Waiting for amount' ? 'Give the amount' : 'Approve'}</button>
                        <button className="btn btn-sm" onClick={() => setDecide({ award: a, decision: 'reject', payMonth: '', note: '' })}>Reject</button>
                      </>
                    )}
                    {awards.canDecide && ['Approved', 'Rejected'].includes(a.status) && <button className="btn btn-sm" onClick={() => undo(a)}>Undo</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rowsPreview.length > 0 && (
        <details className="inc-details">
          <summary>{rowsPreview.filter((r) => r.eligible).length} qualify but are not worked out yet · {rowsPreview.filter((r) => !r.eligible).length} do not qualify</summary>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Employee</th><th>Rule</th><th>Achieved</th><th>Would be</th><th>Result</th></tr></thead>
              <tbody>
                {rowsPreview.map((r) => (
                  <tr key={`${r.employeeId}-${r.ruleId}`}>
                    <td>{r.name}<div className="small-muted">{r.employeeCode} · {r.department || '—'}</div></td>
                    <td>{r.ruleName}</td>
                    <td>{r.achieved}{r.target != null ? ` of ${r.target}` : ''}</td>
                    <td>{r.eligible ? <b>{inr(r.amount)}</b> : '—'}</td>
                    <td>{r.eligible ? <Pill tone="blue">Qualifies</Pill> : <span className="small-muted">{r.why}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {/* 2. the rules */}
      <h3 className="inc-h">Rules {rules ? `(${rules.length})` : ''}</h3>
      <div className="inc-bar">
        {canEdit && <button className="btn btn-primary btn-sm" onClick={() => setRuleModal({})}>+ Add rule</button>}
        {!canEdit && <span className="small-muted">Only Super Admin changes the rules.</span>}
      </div>
      {rules && rules.length > 0 && (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Rule</th><th>Who</th><th>Measured by</th><th>Needs at least</th><th>Pays</th><th>Months</th><th>On</th><th /></tr></thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className={r.active ? '' : 'inc-off'}>
                  <td><b>{r.name}</b>{r.note ? <div className="small-muted">{r.note}</div> : null}</td>
                  <td>{r.department || 'Every department'}{r.role ? <div className="small-muted">{r.role}</div> : null}</td>
                  <td>{metricWord(r.metric)}</td>
                  <td>{r.minAchieved}</td>
                  <td>{basisWord(r.basis, r)}{r.maxAmount ? <div className="small-muted">up to {inr(r.maxAmount)}</div> : null}</td>
                  <td className="small-muted">{r.fromMonth ? monthLabel(r.fromMonth) : 'From the start'}{r.toMonth ? ` to ${monthLabel(r.toMonth)}` : ' onward'}</td>
                  <td>{r.active ? <Pill tone="green">On</Pill> : <Pill tone="grey">Off</Pill>}</td>
                  <td className="inc-acts">
                    {canEdit && <button className="btn btn-sm" onClick={() => setRuleModal(r)}>Change</button>}
                    {canEdit && <button className="btn btn-sm" onClick={() => toggleRule(r)}>{r.active ? 'Switch off' : 'Switch on'}</button>}
                    {canEdit && <button className="btn btn-sm" onClick={() => removeRule(r)}>Remove</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 3. history */}
      <h3 className="inc-h">One person&apos;s history</h3>
      <div className="inc-bar">
        <FacetSelect label="Department" allLabel="All departments" value={dept} onChange={(v) => { setDept(v); setHistFor(''); }} options={peopleFacets.department || []} />
        <label className="lph-facet"><span className="lph-facet-lbl">Person</span>
          <Combo value={histFor} onChange={(e) => setHistFor(e.target.value)}>
            <option value="">Pick a person…</option>
            {shownPeople.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.employeeCode})</option>)}
          </Combo>
        </label>
      </div>
      {histFor ? <HistoryTable data={hist} /> : <div className="small-muted">Pick a person, or tap a name above.</div>}

      {ruleModal && <RuleModal rule={ruleModal.id ? ruleModal : null} options={options} onClose={() => setRuleModal(null)} onSaved={(m) => { setRuleModal(null); setMsg(m); load(); }} />}
      {adding && <AddModal rules={rules || []} month={month} onClose={() => setAdding(false)} onSaved={(m) => { setAdding(false); setMsg(m); load(); }} />}
      {decide && (
        <Modal title={decide.decision === 'approve' ? `${decide.award.amount > 0 ? 'Approve' : 'Give the amount for'} ${decide.award.name}'s incentive` : `Reject ${decide.award.name}'s incentive`} onClose={() => setDecide(null)}
          foot={<><button className="btn btn-primary" disabled={busy === 'dec'} onClick={sendDecision}>{decide.decision === 'approve' ? 'Approve' : 'Reject'}</button><button className="btn" onClick={() => setDecide(null)}>Cancel</button></>}>
          <p><b>{decide.award.amount > 0 ? inr(decide.award.amount) : 'Amount not decided'}</b> for {decide.award.label} — {decide.award.rule} ({decide.award.achieved}{decide.award.target != null ? ` of ${decide.award.target}` : ''}).</p>
          {decide.decision === 'approve' && !(decide.award.amount > 0) && (
            <label className="field"><span>Incentive amount (₹)</span><input type="number" min="1" value={decide.amount ?? ''} onChange={(e) => setDecide((d) => ({ ...d, amount: e.target.value }))} /><span className="small-muted">The rule has no amount yet, so you give it now.</span></label>
          )}
          {decide.decision === 'approve' && (
            <label className="field"><span>Pay it with the salary of</span>
              <input type="month" value={decide.payMonth} onChange={(e) => setDecide((d) => ({ ...d, payMonth: e.target.value }))} />
              <span className="small-muted">Leave blank for the next payroll that can still take it.</span>
            </label>
          )}
          <label className="field"><span>Note</span><input value={decide.note} onChange={(e) => setDecide((d) => ({ ...d, note: e.target.value }))} /></label>
        </Modal>
      )}
    </div>
  );
}
