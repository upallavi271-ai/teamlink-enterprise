import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { isHR as hasHrmsAdmin, canManageDevelopment } from '../../permissions';
import Combo from '../../components/Combo.jsx';
import PeopleFilterBar, { EMPTY_PEOPLE_FILTERS, peopleMatches, peopleOptions, statusOptions, textMatches } from '../../components/PeopleFilterBar.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import { ListEmpty } from '../../components/ui/ListFilters.jsx';
import { ComposeModal, Field, Row, AiAssist, useSubmit } from '../../components/ComposeForm.jsx';
import { ApprovalChainModal, ApprovalChainLine } from '../../components/ApprovalChain.jsx';
import InsightsPanel from '../../components/charts/InsightsPanel.jsx';
import DataIoBar from '../../components/dataio/DataIoBar.jsx';

// A review's status is whether the approval ladder agreed with it
// (approvalStatus — backend/src/routes/performance.js), not the person's.
const REVIEW_STATUSES = ['Pending', 'Approved', 'Rejected'];
const reviewStatusOf = (r) => r.approvalStatus;

export default function Performance() {
  const { user } = useAuth();
  // isHR here DRAWS WRITE CONTROLS, so it asks the write permission and not
  // only the read one. A Manager and an Assistant Manager are view-only (§3,
  // §4) and still hold Employee Management/view, so isHR() alone would have
  // gone on offering them every button on this screen. Both halves, because
  // the screen is an administration screen AND these are writes.
  const isHR = hasHrmsAdmin(user) && canManageDevelopment(user);
  const [reviews, setReviews] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [form, setForm] = useState({ employeeId: '', period: '', score: '', notes: '' });
  const [pf, setPf] = useState({ q: '', ...EMPTY_PEOPLE_FILTERS, band: '', recommendation: '', from: '', to: '' });
  const [sort, setSort] = useState('new');
  const [open, setOpen] = useState(false);
  const [chainFor, setChainFor] = useState(null);
  const { busy, error, setError, run } = useSubmit();

  function load() {
    api.get('/performance').then((res) => setReviews(res.data));
  }
  useEffect(() => {
    load();
    if (isHR) api.get('/employees').then((res) => setEmployees(res.data));
  }, [isHR]);

  // A review is about ONE person, so it keeps a single Employee picker.
  async function submit() {
    if (!form.employeeId) { setError('Pick an employee.'); return; }
    if (!form.period.trim()) { setError('Enter the review period.'); return; }
    if (form.score === '' || Number(form.score) < 0 || Number(form.score) > 100) { setError('Enter a score from 0 to 100.'); return; }
    const res = await run(() => api.post('/performance', { ...form, score: Number(form.score) }), 'Could not save the review');
    if (!res) return;
    setForm({ employeeId: '', period: '', score: '', notes: '' });
    setOpen(false);
    load();
  }

  const hrView = hasHrmsAdmin(user);
  const shown = reviews.filter((r) => textMatches(`${r.period} ${r.notes || ''}`, pf.q)
    && peopleMatches(r, pf, undefined, reviewStatusOf)
    && (!pf.band || r.band === pf.band)
    && (!pf.recommendation || r.recommendation === pf.recommendation));
  const opts = peopleOptions(reviews);
  const SORTS = {
    new: (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
    score: (a, b) => (Number(b.score) || 0) - (Number(a.score) || 0),
    period: (a, b) => String(b.period || '').localeCompare(String(a.period || '')),
  };
  const page = usePaged([...shown].sort(SORTS[sort] || SORTS.new));
  const clearPf = () => setPf((f) => Object.fromEntries(Object.keys(f).map((k) => [k, ''])));

  return (
    <div>
      <div className="page-head"><h1>Performance Reports</h1></div>

      {/* hrms-24 §1 / §9 — reviews and recognition in the range: the
          average-score trend, recognition trend and department-wise
          recognition, with the performance-review export. */}
      {/* ONE KPI row: the old score / band / recommendation cards are now
          server tiles for the reviews in the range (routes/insights.js),
          beside the recognition tiles — no second stat bar. */}
      <InsightsPanel
        module="performance"
        storageKey="tl_range_performance"
        only={['perf-trend', 'rw-trend', 'rw-dept']}
        tileKeys={['reviews', 'avgScore', 'highBand', 'mediumBand', 'lowBand', 'recommended', 'notRecommended', 'recognitions', 'points', 'nominations', 'awarded']}
      />

      {/* Data I/O: export all / one employee (the existing insights export)
          and import of review HISTORY with its compulsory sample (backend
          src/io/performance.js — no approval chain, nobody notified). */}
      <div className="qa-row" style={{ marginBottom: 14 }}>
        {isHR && <button className="btn btn-primary btn-sm" onClick={() => { setError(''); setOpen(true); }}>+ Record Review</button>}
        <DataIoBar
          ioKey="performance"
          exportUrl="/insights/performance/export"
          params={{ ...(pf.department ? { department: pf.department } : {}), ...(pf.from && pf.to ? { from: pf.from, to: pf.to } : {}) }}
          onImported={load}
        />
      </div>
      {open && (
        <ComposeModal title="Record a Review" onClose={() => setOpen(false)} onSubmit={submit} submitLabel="Save Review" busy={busy} error={error}>
          <Field label="Employee" required>
            <Combo value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
              <option value="">Select employee</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name}{e.employeeCode ? ` · ${e.employeeCode}` : ''}</option>)}
            </Combo>
          </Field>
          <Row>
            <Field label="Period" required><input placeholder="2026-H2" value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })} /></Field>
            <Field label="Score (0-100)" required><input type="number" min="0" max="100" value={form.score} onChange={(e) => setForm({ ...form, score: e.target.value })} /></Field>
          </Row>
          <AiAssist kind="review" title={`Review for ${form.period || 'this period'}, score ${form.score || '—'}`} text={form.notes} onText={(notes) => setForm((f) => ({ ...f, notes }))} />
          <Field label="Notes"><textarea rows="4" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        </ComposeModal>
      )}

      <PeopleFilterBar
        filters={pf} setFilters={setPf} people={hrView}
        departments={hrView ? opts.departments : undefined} roles={hrView ? opts.roles : undefined}
        statuses={statusOptions(reviews, REVIEW_STATUSES, reviewStatusOf)} statusLabel="All approval statuses"
        shown={shown.length} total={reviews.length}
        search="Period or notes" dates="Recorded on"
        labels={{ band: 'Band', recommendation: 'Recommendation' }}
        moreKeys={['recommendation']}
        more={(
          <Combo value={pf.recommendation} title="Recommendation" onChange={(e) => setPf((f) => ({ ...f, recommendation: e.target.value }))}>
            <option value="">All recommendations</option>
            {['Recommended', 'Not Recommended'].map((b) => <option key={b}>{b}</option>)}
          </Combo>
        )}
      >
        <Combo value={pf.band} title="Band" onChange={(e) => setPf((f) => ({ ...f, band: e.target.value }))}>
          <option value="">All bands</option>
          {['High', 'Medium', 'Low'].map((b) => <option key={b}>{b}</option>)}
        </Combo>
        <label className="lf-sort">
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="new">Newest first</option>
            <option value="score">Score (high to low)</option>
            <option value="period">Period (latest first)</option>
          </select>
        </label>
      </PeopleFilterBar>

      <div className="tbl-wrap">
        <table>
          <thead><tr>{isHR && <th>Employee</th>}<th>Period</th><th>Score</th><th>Band</th><th>Recommendation</th><th>Notes</th><th>Approval</th></tr></thead>
          <tbody>
            {page.slice.map((r) => (
              <tr key={r.id}>
                {isHR && <td>{r.employee?.name}</td>}
                <td>{r.period}</td>
                <td>{r.score}%</td>
                <td><span className={`status ${r.band === 'High' ? 'priority-low' : r.band === 'Low' ? 'priority-high' : ''}`}>{r.band}</span></td>
                <td>{r.recommendation}</td>
                <td>{r.notes || '—'}</td>
                <td style={{ minWidth: 180 }}>
                  <span className={`status ${r.approvalStatus === 'Approved' ? 'approved' : r.approvalStatus === 'Rejected' ? 'rejected' : 'pending'}`}>{r.approvalStatus || '—'}</span>
                  {r.workflow && <ApprovalChainLine workflow={r.workflow} compact />}
                  {r.workflow && <button className="btn btn-sm" style={{ marginTop: 4 }} onClick={() => setChainFor(r.id)}>Chain</button>}
                </td>
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={isHR ? 7 : 6}><ListEmpty lf={{ activeCount: Object.values(pf).some(Boolean) ? 1 : 0, clear: clearPf }} noun="reviews" /></td></tr>}
          </tbody>
        </table>
      </div>
      {page.total > 0 && <Pager page={page} noun="reviews" />}
      {chainFor && <ApprovalChainModal type="reward" recordId={chainFor} onClose={() => setChainFor(null)} onChanged={load} />}
    </div>
  );
}
