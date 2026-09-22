import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { isHR as hasHrmsAdmin, canManageDevelopment } from '../../permissions';
import Combo from '../../components/Combo.jsx';


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

  function load() {
    api.get('/performance').then((res) => setReviews(res.data));
  }
  useEffect(() => {
    load();
    if (isHR) api.get('/employees').then((res) => setEmployees(res.data));
  }, [isHR]);

  async function submit(e) {
    e.preventDefault();
    await api.post('/performance', form);
    setForm({ employeeId: '', period: '', score: '', notes: '' });
    load();
  }

  const avgScore = reviews.length ? Math.round(reviews.reduce((s, r) => s + r.score, 0) / reviews.length) : 0;
  const bandCount = (band) => reviews.filter((r) => r.band === band).length;
  const recCount = (rec) => reviews.filter((r) => r.recommendation === rec).length;

  return (
    <div>
      <div className="page-head"><h1>Performance Reports</h1></div>

      <div className="statbar">
        <div className="statitem"><div className="n">{avgScore}%</div><div className="l">Average Overall Score</div></div>
        <div className="statitem"><div className="n">{bandCount('High')}</div><div className="l">High Performers</div></div>
        <div className="statitem"><div className="n">{bandCount('Medium')}</div><div className="l">Medium Band</div></div>
        <div className="statitem"><div className="n">{bandCount('Low')}</div><div className="l">Low Band</div></div>
        <div className="statitem"><div className="n">{recCount('Recommended')}</div><div className="l">Salary Increase Recommended</div></div>
        <div className="statitem"><div className="n">{recCount('Not Recommended')}</div><div className="l">Not Recommended</div></div>
      </div>

      {isHR && (
        <form className="card section" onSubmit={submit}>
          <h3>Record a review</h3>
          <div className="grid-2">
            <label className="field">
              <span>Employee</span>
              <Combo required value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
                <option value="">Select employee</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </Combo>
            </label>
            <label className="field"><span>Period</span><input required placeholder="2026-H2" value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })} /></label>
            <label className="field"><span>Score (0-100)</span><input required type="number" min="0" max="100" value={form.score} onChange={(e) => setForm({ ...form, score: e.target.value })} /></label>
            <label className="field"><span>Notes</span><input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
          </div>
          <button className="btn btn-primary btn-sm" type="submit">Save review</button>
        </form>
      )}

      <div className="tbl-wrap">
        <table>
          <thead><tr>{isHR && <th>Employee</th>}<th>Period</th><th>Score</th><th>Band</th><th>Recommendation</th><th>Notes</th></tr></thead>
          <tbody>
            {reviews.map((r) => (
              <tr key={r.id}>
                {isHR && <td>{r.employee?.name}</td>}
                <td>{r.period}</td>
                <td>{r.score}%</td>
                <td><span className={`status ${r.band === 'High' ? 'priority-low' : r.band === 'Low' ? 'priority-high' : ''}`}>{r.band}</span></td>
                <td>{r.recommendation}</td>
                <td>{r.notes || '—'}</td>
              </tr>
            ))}
            {reviews.length === 0 && <tr><td colSpan={isHR ? 6 : 5} className="small-muted">No reviews yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
