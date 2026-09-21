import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { isHR as hasHrmsAdmin } from '../../permissions';


export default function Lms() {
  const { user } = useAuth();
  const isHR = hasHrmsAdmin(user);
  const [courses, setCourses] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [form, setForm] = useState({ title: '', category: '', duration: '' });

  function load() {
    api.get('/lms/courses').then((res) => setCourses(res.data));
    api.get('/lms/assignments').then((res) => setAssignments(res.data));
  }
  useEffect(load, []);

  async function createCourse(e) {
    e.preventDefault();
    await api.post('/lms/courses', form);
    setForm({ title: '', category: '', duration: '' });
    load();
  }

  async function complete(id) {
    await api.patch(`/lms/assignments/${id}/complete`);
    load();
  }

  return (
    <div>
      <div className="page-head"><h1>Learning (LMS)</h1></div>

      {isHR && (
        <form className="card section" onSubmit={createCourse}>
          <h3>Add course</h3>
          <div className="grid-2">
            <label className="field"><span>Title</span><input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
            <label className="field"><span>Category</span><input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Onboarding / Compliance / Soft Skills" /></label>
            <label className="field"><span>Duration</span><input value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value })} placeholder="2h" /></label>
          </div>
          <button className="btn btn-primary btn-sm" type="submit">Add course</button>
        </form>
      )}

      <div className="card section">
        <h3>Course catalog</h3>
        {courses.map((c) => (
          <div className="kv" key={c.id}>
            <span className="k">{c.title} — {c.category}</span>
            <span className="small-muted">{c.assignments.length} assigned, {c.assignments.filter((a) => a.completed).length} completed</span>
          </div>
        ))}
        {courses.length === 0 && <div className="small-muted">No courses yet.</div>}
      </div>

      <div className="card section">
        <h3>{isHR ? 'All assignments' : 'My learning'}</h3>
        <div className="tbl-wrap">
          <table>
            <thead><tr>{isHR && <th>Employee</th>}<th>Course</th><th>Status</th>{!isHR && <th></th>}</tr></thead>
            <tbody>
              {assignments.map((a) => (
                <tr key={a.id}>
                  {isHR && <td>{a.employee?.name}</td>}
                  <td>{a.course?.title}</td>
                  <td><span className={`status ${a.completed ? 'priority-low' : ''}`}>{a.completed ? 'Completed' : 'Assigned'}</span></td>
                  {!isHR && <td>{!a.completed && <button className="btn btn-sm" onClick={() => complete(a.id)}>Mark complete</button>}</td>}
                </tr>
              ))}
              {assignments.length === 0 && <tr><td colSpan={isHR ? 3 : 3} className="small-muted">No assignments yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
