// AFTER SOMEBODY LEAVES (user, 2026-10-10).
//
// When a person exits their seat is freed by itself. What is NOT done silently is giving their
// work to someone else, so this strip says what is still pointing at a person who has left:
//   - clients with no active BDE            (reassign them in Clients)
//   - jobs whose team lead / recruiter left (assign again in the job)
//   - people whose manager has left         (move them here, in one go)
//   - approvals, follow-ups and tasks still waiting on them
// It shows nothing when there is nothing to do. One main button opens the list.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Modal from '../Modal.jsx';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export default function AfterExit({ canEdit = false, onChanged }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  // New managers are offered PER DEPARTMENT: only the team leads of that department (server-side).
  const [mgrByDept, setMgrByDept] = useState({});
  const [picked, setPicked] = useState(() => new Set());
  const [chosen, setChosen] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = () => api.get('/employees/after-exit').then((r) => setData(r.data)).catch(() => setData(null));
  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!open || !canEdit || !data) return;
    const depts = [...new Set((data.people || []).map((p) => p.department || ''))];
    depts.filter((d) => !(d in mgrByDept)).forEach((d) => {
      api.get('/employees/management/manager-options', { params: { department: d, designation: 'Employee' } })
        .then((r) => setMgrByDept((m) => ({ ...m, [d]: r.data })))
        .catch(() => setMgrByDept((m) => ({ ...m, [d]: { options: [], empty: 'Could not load the team leads.' } })));
    });
  }, [open, canEdit, data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return null;
  const c = data.counts || {};
  const total = (c.clients || 0) + (c.jobs || 0) + (c.people || 0) + (c.approvals || 0) + (c.followUps || 0) + (c.tasks || 0);
  if (!total) return null;

  const bits = [];
  if (c.clients) bits.push(`${plural(c.clients, 'client needs', 'clients need')} a new BDE`);
  if (c.jobs) bits.push(`${plural(c.jobs, 'job needs', 'jobs need')} a new team lead or recruiter`);
  if (c.people) bits.push(`${plural(c.people, 'person needs', 'people need')} a new manager`);
  const waiting = (c.approvals || 0) + (c.followUps || 0) + (c.tasks || 0);
  if (waiting) bits.push(`${plural(waiting, 'item is', 'items are')} waiting on someone who left`);

  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const groups = [...(data.people || []).reduce((m, p) => { const k = p.department || ''; if (!m.has(k)) m.set(k, []); m.get(k).push(p); return m; }, new Map())];

  async function move(dept, people) {
    const ids = people.filter((p) => picked.has(p.id)).map((p) => p.id);
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await api.post('/employees/management/reassign-manager', { employeeIds: ids, managerId: chosen[dept] });
      setMsg(`Moved ${plural(r.data.moved, 'person', 'people')} to ${r.data.manager}.${r.data.skipped && r.data.skipped.length ? ` Not moved: ${r.data.skipped.join(', ')}.` : ''}`);
      setPicked((cur) => { const n = new Set(cur); ids.forEach((i) => n.delete(i)); return n; });
      await load();
      if (onChanged) onChanged();
    } catch (e) {
      setErr(e.response?.data?.error || 'Could not move them. Try again.');
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="notice amber after-exit-strip" style={{ marginBottom: 12, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ flex: '1 1 260px' }}><b>Someone left.</b> {bits.join(' · ')}.</span>
        <button type="button" className="btn btn-primary" onClick={() => { setOpen(true); setMsg(''); setErr(''); }}>See what to hand over</button>
      </div>
      {open && (
        <Modal title="After someone leaves - what to hand over" size="wide" onClose={() => setOpen(false)} foot={<button className="btn" onClick={() => setOpen(false)}>Close</button>}>
          <p className="small-muted" style={{ marginTop: 0 }}>Their seat is already free. Nothing below was moved for you - pick who takes it over.</p>
          {msg && <div className="notice" style={{ marginBottom: 10 }}>{msg}</div>}
          {err && <div className="error-text" style={{ marginBottom: 10 }}>{err}</div>}

          {(data.clients || []).length > 0 && (
            <section style={{ marginBottom: 16 }}>
              <h4 style={{ margin: '0 0 6px' }}>Clients with no active BDE ({data.clients.length})</h4>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {data.clients.map((cl) => (
                  <li key={cl.id}>
                    {data.canOpenClient ? <Link to={`/clients/${cl.id}`}>{cl.name}</Link> : cl.name}
                    {' - '}former BDE: <b>{cl.formerBde}</b> ({cl.role}){cl.department ? `, ${cl.department}` : ''}
                    {cl.otherBde ? <> · still has {cl.otherBde}</> : null}
                  </li>
                ))}
              </ul>
              <div className="small-muted">Open the client and use Reassign owner. The old name stays on the client as history.</div>
            </section>
          )}

          {(data.jobs || []).length > 0 && (
            <section style={{ marginBottom: 16 }}>
              <h4 style={{ margin: '0 0 6px' }}>Jobs that lost their {`team lead / recruiter`} ({data.jobs.length})</h4>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {data.jobs.map((j, i) => (
                  <li key={`${j.id}-${j.missing}-${i}`}>
                    {data.canOpenJob ? <Link to={`/requirements/${j.id}`}>{j.reqCode || j.title}</Link> : (j.reqCode || j.title)}
                    {' - '}{j.title}{j.client ? ` (${j.client})` : ''} · {j.missing} <b>{j.person}</b> left
                  </li>
                ))}
              </ul>
            </section>
          )}

          {groups.length > 0 && (
            <section style={{ marginBottom: 16 }}>
              <h4 style={{ margin: '0 0 6px' }}>People whose manager has left ({data.people.length})</h4>
              {groups.map(([dept, people]) => {
                const m = mgrByDept[dept];
                const opts = (m && m.options) || [];
                const n = people.filter((p) => picked.has(p.id)).length;
                return (
                  <div key={dept || 'none'} style={{ marginBottom: 12 }} data-testid="after-exit-dept">
                    <div style={{ fontWeight: 600 }}>{dept || 'No department'}</div>
                    {canEdit && (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '4px 0 6px' }}>
                        <select value={chosen[dept] || ''} onChange={(e) => setChosen({ ...chosen, [dept]: e.target.value })} aria-label={`New manager for ${dept}`} style={{ minWidth: 220 }}>
                          <option value="">{opts.length ? 'Choose the new manager' : ((m && m.empty) || 'Loading...')}</option>
                          {opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                        </select>
                        <button type="button" className="btn btn-primary" disabled={busy || !n || !chosen[dept]} onClick={() => move(dept, people)}>
                          {busy ? 'Moving...' : `Move ${n || ''} ${n === 1 ? 'person' : 'people'} to them`}
                        </button>
                        <button type="button" className="btn btn-sm" onClick={() => setPicked((cur) => { const nx = new Set(cur); const all = people.every((p) => nx.has(p.id)); people.forEach((p) => (all ? nx.delete(p.id) : nx.add(p.id))); return nx; })}>
                          {people.every((p) => picked.has(p.id)) ? 'Untick all' : 'Tick all'}
                        </button>
                        {m && opts.length > 0 && <span className="small-muted">{m.title}</span>}
                      </div>
                    )}
                    <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
                      {people.map((p) => (
                        <li key={p.id} style={{ padding: '3px 0' }}>
                          {canEdit && <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} aria-label={`Tick ${p.name}`} style={{ marginRight: 8 }} />}
                          <Link to={`/employees/${p.id}`}>{p.name}</Link>
                          {' - '}{p.gone.map((g) => `${g.label}: ${g.who} (left)`).join(', ')}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </section>
          )}

          {waiting > 0 && (
            <section>
              <h4 style={{ margin: '0 0 6px' }}>Still waiting on someone who left</h4>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {c.approvals > 0 && <li>{plural(c.approvals, 'approval step', 'approval steps')} - HR can re-route them from the approval screen.</li>}
                {c.followUps > 0 && <li>{plural(c.followUps, 'follow-up', 'follow-ups')} still open.</li>}
                {c.tasks > 0 && <li>{plural(c.tasks, 'task', 'tasks')} still open.</li>}
              </ul>
            </section>
          )}
        </Modal>
      )}
    </>
  );
}
