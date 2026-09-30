import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  Panel, PanelPad, PanelHead, StatRow, AssignRow, EmptyMini, TwoCol, QaRow,
  NumHead, FeatureTiles, FeatureScreen, FeatureTable,
} from '../../components/proto.jsx';
import { isHR as hasHrmsAdmin, canEditServices } from '../../permissions';
import Combo from '../../components/Combo.jsx';
import DateRangePicker, { RANGE_PRESETS, rangeParams } from '../../components/DateRangePicker.jsx';

const HELPDESK_PRESETS = [['all', 'All Time'], ...RANGE_PRESETS];
import PeopleFilterBar, { EMPTY_PEOPLE_FILTERS, peopleMatches, peopleOptions, textMatches } from '../../components/PeopleFilterBar.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import { ListEmpty } from '../../components/ui/ListFilters.jsx';
import { ComposeModal, Field, Row, AiAssist, useSubmit } from '../../components/ComposeForm.jsx';
import DataIoBar from '../../components/dataio/DataIoBar.jsx';

const TICKET_STATUSES = ['Open', 'In Progress', 'Resolved', 'Closed'];
const CLOSED = ['Resolved', 'Closed'];

// THE TICKET FILTERS (filter standard): Search (code, subject, description,
// category, employee, assignee) · Employee · Department · Status · Category ·
// Sort | More: Employee ID · Role · Employee status · Raised on · Priority.
const HD_EMPTY = { ...EMPTY_PEOPLE_FILTERS, q: '', category: '', priority: '', from: '', to: '' };
const PRIORITY_RANK = { Urgent: 0, High: 1, Medium: 2, Low: 3 };
const newest = (a, b) => String(b.createdAt).localeCompare(String(a.createdAt));
const HD_SORTS = [
  ['new', 'Newest first', newest],
  ['old', 'Oldest first', (a, b) => -newest(a, b)],
  ['priority', 'Priority (Urgent first)', (a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) || newest(a, b)],
];

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

// The reference compose layout. A ticket is about ONE person's problem, so it
// keeps single-target semantics: my own ticket, or — for the helpdesk desk —
// one employee's ticket, optionally assigned to one agent.
function NewTicketModal({ meta, employees, isHR, onClose, onSaved }) {
  const [form, setForm] = useState({ employeeId: '', assignedTo: '', category: meta.categories[0], priority: 'Medium', title: '', detail: '' });
  const { busy, error, setError, run } = useSubmit();

  async function submit() {
    if (!form.title.trim()) { setError('Subject is required.'); return; }
    if (!form.category) { setError('Pick a category.'); return; }
    if (isHR && !form.employeeId) { setError('Pick the employee this ticket is for.'); return; }
    const payload = { title: form.title, detail: form.detail, category: form.category, priority: form.priority };
    if (isHR) { payload.employeeId = form.employeeId; payload.assignedTo = form.assignedTo || undefined; }
    const res = await run(() => api.post('/helpdesk', payload), 'Could not create the ticket');
    if (res) onSaved(`Ticket created — auto-routed to ${meta.routing.find((r) => r.category === form.category)?.team || 'HR Team'} (simulated email).`);
  }

  return (
    <ComposeModal title="New Ticket" onClose={onClose} onSubmit={submit} submitLabel="Create Ticket" busy={busy} error={error}>
      <Field label="Subject" required><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
      <AiAssist kind="helpdesk" title={form.title} text={form.detail} onText={(detail) => setForm((f) => ({ ...f, detail }))} />
      <Field label="Description"><textarea rows="4" value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} /></Field>
      <Row>
        <Field label="Category" required>
          <Combo creatable value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            {meta.categories.map((c) => <option key={c}>{c}</option>)}
          </Combo>
        </Field>
        <Field label="Priority">
          <Combo value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
            {meta.priorities.map((p) => <option key={p}>{p}</option>)}
          </Combo>
        </Field>
      </Row>
      {isHR && (
        <Row>
          <Field label="Employee" required>
            <Combo value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
              <option value="">Select employee</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </Combo>
          </Field>
          <Field label="Assign to">
            <Combo value={form.assignedTo} onChange={(e) => setForm({ ...form, assignedTo: e.target.value })}>
              <option value="">Unassigned</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </Combo>
          </Field>
        </Row>
      )}
    </ComposeModal>
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
  const [pf, setPf] = useState(HD_EMPTY);
  const [sort, setSort] = useState('new');

  // hrms-24 §1 — the analytics screen's From → To → Apply (All Time = every
  // ticket on file, which is what it showed before).
  const [range, setRange] = useState({ range: 'all', from: '', to: '' });

  function load() {
    api.get('/helpdesk').then((res) => setTickets(res.data));
    // hrView, not isHR: loading the directory and the analytics is a READ, and
    // a view-only Manager (§3) keeps both.
    if (hrView) {
      api.get('/employees').then((res) => setEmployees(res.data)).catch(() => setEmployees([]));
    }
  }
  useEffect(() => { api.get('/helpdesk/meta').then((res) => setMeta(res.data)); }, []);
  useEffect(load, [hrView, isHR]);
  useEffect(() => {
    if (!hrView) return;
    api.get('/helpdesk/analytics', { params: rangeParams(range) }).then((res) => setAnalytics(res.data)).catch(() => setAnalytics(null));
  }, [hrView, isHR, range]);

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

  // One set of filters for the ticket list and every ticket screen. The
  // employee half is for those who see other people's tickets; an employee
  // looking at their own gets search, status, category, priority and dates.
  const shown = tickets.filter((t) => peopleMatches(t, pf, undefined, undefined, (r) => r.createdAt)
    && textMatches(`${t.id.slice(-8)} ${t.title} ${t.detail || ''} ${t.category || ''} ${t.employee?.name || ''} ${t.assignedToName || ''}`, pf.q)
    && (!pf.category || t.category === pf.category)
    && (!pf.priority || t.priority === pf.priority))
    .sort((HD_SORTS.find(([k]) => k === sort) || HD_SORTS[0])[2]);
  // The rows the current screen lists — paged 25 / 50 / 100.
  const viewRows = view === 'resolution' || view === 'csat' ? shown.filter((t) => CLOSED.includes(t.status))
    : view === 'escalation' ? shown.filter((t) => ['Urgent', 'High'].includes(t.priority))
      : view ? shown
        // Closed tickets drop off the tab's list — unless the status filter asks for them.
        : shown.filter((t) => pf.status || !CLOSED.includes(t.status));
  const page = usePaged(viewRows);
  const lfLike = { activeCount: Object.values(pf).filter(Boolean).length, clear: () => setPf(HD_EMPTY) };
  const emptyRow = (title) => <ListEmpty lf={lfLike} noun="tickets" title={title} />;

  if (!meta) return <div className="small-muted">Loading…</div>;

  const opts = peopleOptions(tickets);
  const categories = [...new Set([...(meta.categories || []), ...tickets.map((t) => t.category).filter(Boolean)])];
  const priorities = [...new Set([...(meta.priorities || []), ...tickets.map((t) => t.priority).filter(Boolean)])];
  const setF = (k, v) => setPf((f) => ({ ...f, [k]: v }));
  const bar = (statuses = TICKET_STATUSES) => (
    <PeopleFilterBar
      filters={pf} setFilters={setPf} people={hrView} search="Tickets"
      departments={hrView ? opts.departments : undefined} roles={hrView ? opts.roles : undefined}
      statuses={statuses} shown={shown.length} total={tickets.length}
      dates="Raised on" labels={{ category: 'Category', priority: 'Priority' }} moreKeys={['priority']}
      more={(
        <Combo value={pf.priority} title="Priority" onChange={(e) => setF('priority', e.target.value)}>
          <option value="">All priorities</option>
          {priorities.map((p) => <option key={p}>{p}</option>)}
        </Combo>
      )}
    >
      <Combo value={pf.category} title="Category" onChange={(e) => setF('category', e.target.value)}>
        <option value="">All categories</option>
        {categories.map((c) => <option key={c}>{c}</option>)}
      </Combo>
      <label className="lf-sort">
        Sort
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          {HD_SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
    </PeopleFilterBar>
  );

  // ---- Feature screens -------------------------------------------------
  if (view) {
    const back = onBack;
    if (view === 'create') {
      return (
        <FeatureScreen title="Ticket Creation, Assignment & Categorization" sub="Every ticket on file with its category and owner." onBack={back}>
          {bar()}
          <FeatureTable
            heads={['Code', 'Employee', 'Subject', 'Category', 'Assigned To', 'Status']}
            empty={emptyRow('No tickets yet.')}
            rows={page.slice.map((t) => (
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
          <Pager page={page} noun="tickets" />
        </FeatureScreen>
      );
    }
    if (view === 'sla') {
      return (
        <FeatureScreen title="SLA Tracking & Status" sub="Target response windows by priority: Urgent 4h · High 8h · Medium 24h · Low 48h." onBack={back}>
          {bar()}
          <FeatureTable
            heads={['Code', 'Subject', 'Priority', 'SLA', 'Status']}
            empty={emptyRow('No tickets yet.')}
            rows={page.slice.map((t) => (
              <tr key={t.id}>
                <td><b>{t.id.slice(-8).toUpperCase()}</b></td>
                <td>{t.title}</td>
                <td className="cell-muted">{t.priority}</td>
                <td className="cell-muted">{CLOSED.includes(t.status) ? 'Closed within SLA' : t.sla.label}{t.sla.breached ? ' · breached' : ''}</td>
                <td><span className={`status ${CLOSED.includes(t.status) ? 'active' : 'pending'}`}>{t.status}</span></td>
              </tr>
            ))}
          />
          <Pager page={page} noun="tickets" />
        </FeatureScreen>
      );
    }
    if (view === 'resolution') {
      return (
        <FeatureScreen title="Ticket Resolution, Closure & Reopening" sub="Resolved and closed tickets, with the note recorded at closure." onBack={back}>
          {bar(CLOSED)}
          <FeatureTable
            heads={['Code', 'Subject', 'Resolution', 'Resolved On', '']}
            empty={emptyRow('No resolved tickets yet.')}
            rows={page.slice.map((t) => (
              <tr key={t.id}>
                <td><b>{t.id.slice(-8).toUpperCase()}</b></td>
                <td>{t.title}</td>
                <td className="cell-muted">{t.resolution || '—'}</td>
                <td className="cell-muted">{t.resolvedAt || '—'}</td>
                <td><button className="btn btn-sm" onClick={() => setStatus(t, 'Open')}>Reopen</button></td>
              </tr>
            ))}
          />
          <Pager page={page} noun="tickets" />
        </FeatureScreen>
      );
    }
    if (view === 'notes') {
      return (
        <FeatureScreen title="Internal Notes, Attachments & Screenshots" sub="Internal notes are never shown to the employee who raised the ticket." onBack={back}>
          {bar()}
          <FeatureTable
            heads={['Code', 'Subject', 'Notes', '']}
            empty={emptyRow('No tickets yet.')}
            rows={page.slice.map((t) => (
              <tr key={t.id}>
                <td><b>{t.id.slice(-8).toUpperCase()}</b></td>
                <td>{t.title}</td>
                <td className="cell-muted">{t.noteCount ?? (t.notes || []).length} note(s)</td>
                <td>{isHR && <button className="btn btn-sm" onClick={() => addNote(t)}>+ Add note</button>}</td>
              </tr>
            ))}
          />
          <Pager page={page} noun="tickets" />
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
      return (
        <FeatureScreen title="Ticket Escalation" sub="High and Urgent tickets can be escalated to the reporting manager." onBack={back}>
          {bar()}
          <FeatureTable
            heads={['Code', 'Subject', 'Priority', '']}
            empty={emptyRow('No high-priority tickets.')}
            rows={page.slice.map((t) => (
              <tr key={t.id}>
                <td><b>{t.id.slice(-8).toUpperCase()}</b></td>
                <td>{t.title}</td>
                <td className="cell-muted">{t.priority}</td>
                <td>{t.escalated ? <span className="status rejected">Escalated</span> : <button className="btn btn-sm" onClick={() => escalate(t)}>Escalate</button>}</td>
              </tr>
            ))}
          />
          <Pager page={page} noun="tickets" />
        </FeatureScreen>
      );
    }
    if (view === 'csat') {
      const rated = tickets.filter((t) => t.csat != null);
      const avg = rated.length ? Math.round((rated.reduce((s, t) => s + t.csat, 0) / rated.length) * 10) / 10 : '—';
      return (
        <FeatureScreen title="CSAT / Customer Satisfaction Feedback" sub={`Average rating: ${avg} / 5`} onBack={back}>
          {bar(CLOSED)}
          <FeatureTable
            heads={['Code', 'Subject', 'CSAT', '']}
            empty={emptyRow('No resolved tickets to rate.')}
            rows={page.slice.map((t) => (
              <tr key={t.id}>
                <td><b>{t.id.slice(-8).toUpperCase()}</b></td>
                <td>{t.title}</td>
                <td className="cell-muted">{t.csat != null ? `${t.csat} / 5` : 'Not rated'}</td>
                <td><button className="btn btn-sm" onClick={() => rate(t)}>Rate</button></td>
              </tr>
            ))}
          />
          <Pager page={page} noun="tickets" />
        </FeatureScreen>
      );
    }
    if (view === 'analytics') {
      if (!analytics) return <FeatureScreen title="Helpdesk Dashboard, Reports & Analytics" sub="" onBack={back}><EmptyMini>Not available for your role.</EmptyMini></FeatureScreen>;
      return (
        <FeatureScreen title="Helpdesk Dashboard, Reports & Analytics" sub="Volume by category and priority for tickets raised in the range." onBack={back}>
          <div className="filter-row" style={{ marginBottom: 12 }}>
            <DateRangePicker value={range} onChange={setRange} period={analytics.period} presets={HELPDESK_PRESETS} />
          </div>
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
  const open = shown.filter((t) => t.status === 'Open').length;
  const prog = shown.filter((t) => t.status === 'In Progress').length;
  const done = shown.filter((t) => CLOSED.includes(t.status)).length;

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
        {/* Data I/O: export all / one employee (own tickets without the
            export right) and import of ticket history with the compulsory
            sample (backend src/io/helpdesk.js — nobody is notified). */}
        <DataIoBar
          ioKey="helpdesk"
          params={Object.fromEntries(['department', 'status', 'category', 'priority', 'from', 'to'].filter((k) => pf[k]).map((k) => [k, pf[k]]))}
          onImported={load}
        />
      </QaRow>
      {message && <div className="error-text">{message}</div>}
      {bar()}

      <TwoCol style={{ alignItems: 'start' }}>
        <PanelPad>
          <NumHead n={1} title="Helpdesk Tickets" />
          <div className="cell-muted" style={{ fontSize: 12, marginBottom: 6 }}>
            Resolved/Closed tickets drop off this list — see them in Ticket Resolution or Reports.
          </div>
          {viewRows.length === 0 ? emptyRow('No open tickets.') : page.slice.map((t) => (
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
          {viewRows.length > 0 && <Pager page={page} noun="tickets" />}
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
