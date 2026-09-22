import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  Panel, PanelPad, PanelHead, StatRow, AssignRow, EmptyMini, TwoCol, QaRow,
  NumHead, FeatureTiles, FeatureScreen, FeatureTable, Modal,
} from '../../components/proto.jsx';
import { isHR as hasHrmsAdmin, canEditServices } from '../../permissions';
import Combo from '../../components/Combo.jsx';

const TICKET_STATUSES = ['Open', 'In Progress', 'Resolved', 'Closed'];
const CLOSED = ['Resolved', 'Closed'];

// The prototype's nine Help Desk feature tiles, in its order (HD_FEATURES, line 4412).
export const HD_FEATURES = [
  ['create', 'Ticket Creation, Assignment & Categorization'],
  ['sla', 'SLA Tracking & Status'],
  ['resolution', 'Ticket Resolution, Closure & Reopening'],
  ['notes', 'Internal Notes, Attachments & Screenshots'],
  ['kb', 'Knowledge Base'],
  ['routing', 'Auto Routing & Email Notifications'],
  ['escalation', 'Ticket Escalation'],
  ['csat', 'CSAT / Customer Satisfaction Feedback'],
  ['analytics', 'Helpdesk Dashboard, Reports & Analytics'],
];

function NewTicketModal({ meta, employees, isHR, onClose, onSaved }) {
  const [form, setForm] = useState({ employeeId: '', assignedTo: '', category: meta.categories[0], priority: 'Medium', title: '', detail: '' });
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    if (!form.title.trim()) { setError('Subject is required.'); return; }
    try {
      const payload = { title: form.title, detail: form.detail, category: form.category, priority: form.priority };
      if (isHR) { payload.employeeId = form.employeeId; payload.assignedTo = form.assignedTo || undefined; }
      await api.post('/helpdesk', payload);
      onSaved(`Ticket created — auto-routed to ${meta.routing.find((r) => r.category === form.category)?.team || 'HR Team'} (simulated email).`);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not create the ticket');
    }
  }

  return (
    <Modal
      title="New Ticket"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={submit}>Create Ticket</button></>}
    >
      {isHR && (
        <div className="grid-2">
          <div className="field">
            <label>Employee *</label>
            <Combo value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
              <option value="">Select employee</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </Combo>
          </div>
          <div className="field">
            <label>Assign to</label>
            <Combo value={form.assignedTo} onChange={(e) => setForm({ ...form, assignedTo: e.target.value })}>
              <option value="">Unassigned</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </Combo>
          </div>
        </div>
      )}
      <div className="grid-2">
        <div className="field">
          <label>Category *</label>
          <Combo creatable value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            {meta.categories.map((c) => <option key={c}>{c}</option>)}
          </Combo>
        </div>
        <div className="field">
          <label>Priority</label>
          <Combo value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
            {meta.priorities.map((p) => <option key={p}>{p}</option>)}
          </Combo>
        </div>
      </div>
      <div className="field"><label>Subject *</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
      <div className="field"><label>Description</label><textarea rows="2" value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} /></div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

export default function Helpdesk({ view, onOpen, onBack }) {
  const { user } = useAuth();
  // TWO HALVES, DELIBERATELY.
  //   hrView  — READ: may this login see other people's records here? It is
  //             what decides which rows and which columns are shown, and a
  //             view-only Manager (§3) keeps every one of them.
  //   isHR    — WRITE: may this login act on them? A Manager and an Assistant
  //             Manager hold Employee Management/view and so pass the read
  //             half; they must not be drawn a button the API refuses.
  const hrView = hasHrmsAdmin(user);
  const isHR = hrView && canEditServices(user);
  const [meta, setMeta] = useState(null);
  const [tickets, setTickets] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [message, setMessage] = useState('');

  function load() {
    api.get('/helpdesk').then((res) => setTickets(res.data));
    // hrView, not isHR: loading the directory and the analytics is a READ, and
    // a view-only Manager (§3) keeps both.
    if (hrView) {
      api.get('/employees').then((res) => setEmployees(res.data)).catch(() => setEmployees([]));
      api.get('/helpdesk/analytics').then((res) => setAnalytics(res.data)).catch(() => setAnalytics(null));
    }
  }
  useEffect(() => { api.get('/helpdesk/meta').then((res) => setMeta(res.data)); }, []);
  useEffect(load, [hrView, isHR]);

  async function setStatus(ticket, status) {
    if (ticket.status === status) return;
    const body = { status };
    if (CLOSED.includes(status)) {
      const note = prompt(`${status} ticket — resolution note:`, ticket.resolution || '');
      if (note === null) return;
      if (!note.trim()) { setMessage('A resolution note is required.'); return; }
      body.resolution = note.trim();
    }
    await api.patch(`/helpdesk/${ticket.id}/status`, body);
    load();
  }
  async function addNote(ticket) {
    const note = prompt('Internal note (not shown to the employee):', '');
    if (!note || !note.trim()) return;
    await api.post(`/helpdesk/${ticket.id}/notes`, { text: note.trim(), internal: true });
    load();
  }
  async function escalate(ticket) { await api.patch(`/helpdesk/${ticket.id}/escalate`); load(); }
  async function rate(ticket) {
    const v = prompt('CSAT rating (1–5)?', '5');
    if (v === null) return;
    await api.patch(`/helpdesk/${ticket.id}/csat`, { csat: Math.max(1, Math.min(5, Number(v) || 5)) });
    load();
  }
  async function assign(ticket) {
    const list = employees.map((e, i) => `${i + 1}. ${e.name}`).join('\n');
    const pick = prompt(`Assign to:\n${list}`, '1');
    if (pick === null) return;
    const emp = employees[(Number(pick) || 1) - 1];
    if (!emp) return;
    await api.patch(`/helpdesk/${ticket.id}/assign`, { assignedTo: emp.id });
    load();
  }

  if (!meta) return <div className="small-muted">Loading…</div>;

  // ---- Feature screens -------------------------------------------------
  if (view) {
    const back = onBack;
    if (view === 'create') {
      return (
        <FeatureScreen title="Ticket Creation, Assignment & Categorization" sub="Every ticket on file with its category and owner." onBack={back}>
          <FeatureTable
            heads={['Code', 'Employee', 'Subject', 'Category', 'Assigned To', 'Status']}
            empty="No tickets yet."
            rows={tickets.map((t) => (
              <tr key={t.id}>
                <td><b>{t.id.slice(-8).toUpperCase()}</b></td>
                <td>{t.employee?.name}</td>
                <td>{t.title}</td>
                <td className="cell-muted">{t.category}</td>
                <td className="cell-muted">
                  {t.assignedToName || 'Unassigned'}
                  {isHR && <> <button className="btn btn-sm" onClick={() => assign(t)}>Assign</button></>}
                </td>
                <td><span className={`status ${t.status === 'Open' ? 'pending' : t.status === 'In Progress' ? 'review' : 'active'}`}>{t.status}</span></td>
              </tr>
            ))}
          />
        </FeatureScreen>
      );
    }
    if (view === 'sla') {
      return (
        <FeatureScreen title="SLA Tracking & Status" sub="Target response windows by priority: Urgent 4h · High 8h · Medium 24h · Low 48h." onBack={back}>
          <FeatureTable
            heads={['Code', 'Subject', 'Priority', 'SLA', 'Status']}
            empty="No tickets yet."
            rows={tickets.map((t) => (
              <tr key={t.id}>
                <td><b>{t.id.slice(-8).toUpperCase()}</b></td>
                <td>{t.title}</td>
                <td className="cell-muted">{t.priority}</td>
                <td className="cell-muted">{CLOSED.includes(t.status) ? 'Closed within SLA' : t.sla.label}{t.sla.breached ? ' · breached' : ''}</td>
                <td><span className={`status ${CLOSED.includes(t.status) ? 'active' : 'pending'}`}>{t.status}</span></td>
              </tr>
            ))}
          />
        </FeatureScreen>
      );
    }
    if (view === 'resolution') {
      const done = tickets.filter((t) => CLOSED.includes(t.status));
      return (
        <FeatureScreen title="Ticket Resolution, Closure & Reopening" sub="Resolved and closed tickets, with the note recorded at closure." onBack={back}>
          <FeatureTable
            heads={['Code', 'Subject', 'Resolution', 'Resolved On', '']}
            empty="No resolved tickets yet."
            rows={done.map((t) => (
              <tr key={t.id}>
                <td><b>{t.id.slice(-8).toUpperCase()}</b></td>
                <td>{t.title}</td>
                <td className="cell-muted">{t.resolution || '—'}</td>
                <td className="cell-muted">{t.resolvedAt || '—'}</td>
                <td><button className="btn btn-sm" onClick={() => setStatus(t, 'Open')}>Reopen</button></td>
              </tr>
            ))}
          />
        </FeatureScreen>
      );
    }
    if (view === 'notes') {
      return (
        <FeatureScreen title="Internal Notes, Attachments & Screenshots" sub="Internal notes are never shown to the employee who raised the ticket." onBack={back}>
          <FeatureTable
            heads={['Code', 'Subject', 'Notes', '']}
            empty="No tickets yet."
            rows={tickets.map((t) => (
              <tr key={t.id}>
                <td><b>{t.id.slice(-8).toUpperCase()}</b></td>
                <td>{t.title}</td>
                <td className="cell-muted">{t.noteCount ?? (t.notes || []).length} note(s)</td>
                <td>{isHR && <button className="btn btn-sm" onClick={() => addNote(t)}>+ Add note</button>}</td>
              </tr>
            ))}
          />
        </FeatureScreen>
      );
    }
    if (view === 'kb') {
      return (
        <FeatureScreen title="Knowledge Base" sub="Self-serve articles that deflect common tickets." onBack={back}>
          <Panel style={{ marginTop: 14 }}>
            {meta.knowledgeBase.map((a) => (
              <AssignRow key={a.title}>
                <span>{a.title}</span>
                <span className="status pending">{a.category}</span>
              </AssignRow>
            ))}
          </Panel>
        </FeatureScreen>
      );
    }
    if (view === 'routing') {
      return (
        <FeatureScreen title="Auto Routing & Email Notifications" sub="Each category routes to a team automatically when a ticket is raised." onBack={back}>
          <Panel style={{ marginTop: 14 }}>
            {meta.routing.map((r) => (
              <AssignRow key={r.category}><span>{r.category}</span><span className="cell-muted">→ {r.team}</span></AssignRow>
            ))}
            <div className="cell-muted" style={{ padding: '12px 18px', fontSize: 11.5, fontStyle: 'italic' }}>
              Email/WhatsApp/SMS delivery is simulated in this prototype.
            </div>
          </Panel>
        </FeatureScreen>
      );
    }
    if (view === 'escalation') {
      const hot = tickets.filter((t) => ['Urgent', 'High'].includes(t.priority));
      return (
        <FeatureScreen title="Ticket Escalation" sub="High and Urgent tickets can be escalated to the reporting manager." onBack={back}>
          <FeatureTable
            heads={['Code', 'Subject', 'Priority', '']}
            empty="No high-priority tickets."
            rows={hot.map((t) => (
              <tr key={t.id}>
                <td><b>{t.id.slice(-8).toUpperCase()}</b></td>
                <td>{t.title}</td>
                <td className="cell-muted">{t.priority}</td>
                <td>{t.escalated ? <span className="status rejected">Escalated</span> : <button className="btn btn-sm" onClick={() => escalate(t)}>Escalate</button>}</td>
              </tr>
            ))}
          />
        </FeatureScreen>
      );
    }
    if (view === 'csat') {
      const rated = tickets.filter((t) => t.csat != null);
      const avg = rated.length ? Math.round((rated.reduce((s, t) => s + t.csat, 0) / rated.length) * 10) / 10 : '—';
      const done = tickets.filter((t) => CLOSED.includes(t.status));
      return (
        <FeatureScreen title="CSAT / Customer Satisfaction Feedback" sub={`Average rating: ${avg} / 5`} onBack={back}>
          <FeatureTable
            heads={['Code', 'Subject', 'CSAT', '']}
            empty="No resolved tickets to rate."
            rows={done.map((t) => (
              <tr key={t.id}>
                <td><b>{t.id.slice(-8).toUpperCase()}</b></td>
                <td>{t.title}</td>
                <td className="cell-muted">{t.csat != null ? `${t.csat} / 5` : 'Not rated'}</td>
                <td><button className="btn btn-sm" onClick={() => rate(t)}>Rate</button></td>
              </tr>
            ))}
          />
        </FeatureScreen>
      );
    }
    if (view === 'analytics') {
      if (!analytics) return <FeatureScreen title="Helpdesk Dashboard, Reports & Analytics" sub="" onBack={back}><EmptyMini>Not available for your role.</EmptyMini></FeatureScreen>;
      return (
        <FeatureScreen title="Helpdesk Dashboard, Reports & Analytics" sub="Volume by category and priority across every ticket on file." onBack={back}>
          <StatRow cells={[
            { value: analytics.kpis.total, label: 'Total Tickets' },
            { value: analytics.kpis.open, label: 'Open' },
            { value: analytics.kpis.resolved, label: 'Resolved' },
          ]} />
          <TwoCol style={{ marginTop: 14 }}>
            <Panel>
              <PanelHead title="By Category" />
              {analytics.byCategory.map((c) => <AssignRow key={c.category}><span>{c.category}</span><b>{c.tickets}</b></AssignRow>)}
            </Panel>
            <Panel>
              <PanelHead title="By Priority" />
              {analytics.byPriority.map((p) => <AssignRow key={p.priority}><span>{p.priority}</span><b>{p.tickets}</b></AssignRow>)}
            </Panel>
          </TwoCol>
        </FeatureScreen>
      );
    }
  }

  // ---- Tab body --------------------------------------------------------
  const open = tickets.filter((t) => t.status === 'Open').length;
  const prog = tickets.filter((t) => t.status === 'In Progress').length;
  const done = tickets.filter((t) => CLOSED.includes(t.status)).length;
  const list = tickets.filter((t) => !CLOSED.includes(t.status));

  return (
    <div>
      <StatRow cells={[
        { value: open, label: 'Open' },
        { value: prog, label: 'In Progress' },
        { value: done, label: 'Resolved' },
      ]} />

      <QaRow style={{ margin: '14px 0' }}>
        <button className="btn btn-primary btn-sm" onClick={() => setModalOpen(true)}>+ Raise Ticket</button>
        <button className="btn btn-sm" onClick={() => onOpen('analytics')}>Reports</button>
      </QaRow>
      {message && <div className="error-text">{message}</div>}

      <TwoCol style={{ alignItems: 'start' }}>
        <PanelPad>
          <NumHead n={1} title="Helpdesk Tickets" />
          <div className="cell-muted" style={{ fontSize: 12, marginBottom: 6 }}>
            Resolved/Closed tickets drop off this list — see them in Ticket Resolution or Reports.
          </div>
          {list.length === 0 ? <EmptyMini>No open tickets.</EmptyMini> : list.map((t) => (
            <div key={t.id} style={{ padding: '12px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <b>{t.title}</b>
                <span className="cell-muted">— {t.employee?.name}</span>
                <span className="status pending">{t.category}</span>
                <span className={`status ${['Urgent', 'High'].includes(t.priority) ? 'rejected' : 'pending'}`}>{t.priority}</span>
              </div>
              <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 3 }}>
                {t.id.slice(-8).toUpperCase()} · raised {new Date(t.createdAt).toISOString().slice(0, 10)} · {t.sla.label}
              </div>
              {t.detail && <div className="cell-muted" style={{ fontSize: 12, marginTop: 4 }}>{t.detail}</div>}
              <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
                <Combo value={t.status} onChange={(e) => setStatus(t, e.target.value)}>
                  {TICKET_STATUSES.map((s) => <option key={s}>{s}</option>)}
                </Combo>
                <button className="btn btn-sm" onClick={() => onOpen('notes')}>Notes &amp; attachments</button>
              </div>
            </div>
          ))}
        </PanelPad>
        <FeatureTiles features={HD_FEATURES} onOpen={onOpen} />
      </TwoCol>

      {modalOpen && (
        <NewTicketModal
          meta={meta}
          employees={employees}
          isHR={isHR}
          onClose={() => setModalOpen(false)}
          onSaved={(msg) => { setModalOpen(false); setMessage(msg); load(); }}
        />
      )}
    </div>
  );
}
