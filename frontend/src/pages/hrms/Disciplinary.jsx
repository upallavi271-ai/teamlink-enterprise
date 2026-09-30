import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { Panel, PanelHead, QaRow } from '../../components/proto.jsx';
import { isHR as hasHrmsAdmin, canManageServices } from '../../permissions';
import Combo from '../../components/Combo.jsx';
import PeopleFilterBar, { EMPTY_PEOPLE_FILTERS, peopleMatches, peopleOptions, statusOptions, textMatches } from '../../components/PeopleFilterBar.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import { ListEmpty } from '../../components/ui/ListFilters.jsx';
import { ComposeModal, Field, AiAssist, useSubmit } from '../../components/ComposeForm.jsx';
import DataIoBar from '../../components/dataio/DataIoBar.jsx';

const CATEGORIES = ['Warning', 'Suspension', 'Termination', 'Other'];
// A case is logged Open and closed with Close Case.
const CASE_STATUSES = ['Open', 'Closed'];

// The reference compose layout. A disciplinary case is about ONE person, so
// it keeps a single Employee picker — no Send-to.
function LogCaseModal({ employees, onClose, onSaved }) {
  const [form, setForm] = useState({ employeeId: '', category: 'Warning', detail: '' });
  const { busy, error, setError, run } = useSubmit();

  async function submit() {
    if (!form.employeeId) { setError('Pick an employee.'); return; }
    if (!form.detail.trim()) { setError('Enter a description.'); return; }
    const res = await run(() => api.post('/disciplinary', {
      employeeId: form.employeeId,
      title: form.category,
      category: form.category,
      detail: form.detail.trim(),
      date: new Date().toISOString().slice(0, 10),
    }), 'Could not log the case');
    if (res) onSaved();
  }

  return (
    <ComposeModal title="Log Disciplinary Case" onClose={onClose} onSubmit={submit} submitLabel="Log Case" busy={busy} error={error}>
      <Field label="Employee" required>
        <Combo value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
          <option value="">Select employee</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.name}{e.employeeCode ? ` · ${e.employeeCode}` : ''}</option>)}
        </Combo>
      </Field>
      <Field label="Category" required>
        <Combo creatable value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
          {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
        </Combo>
      </Field>
      <AiAssist kind="disciplinary" title={form.category} text={form.detail} onText={(detail) => setForm((f) => ({ ...f, detail }))} />
      <Field label="Description" required><textarea rows="4" value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} /></Field>
    </ComposeModal>
  );
}

export default function Disciplinary() {
  const { user } = useAuth();
  // isHR here DRAWS WRITE CONTROLS, so it asks the write permission and not
  // only the read one. A Manager and an Assistant Manager are view-only (§3,
  // §4) and still hold Employee Management/view, so isHR() alone would have
  // gone on offering them every button on this screen. Both halves, because
  // the screen is an administration screen AND these are writes.
  const hrView = hasHrmsAdmin(user);
  const isHR = hrView && canManageServices(user);
  const [records, setRecords] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [open, setOpen] = useState(false);
  const [pf, setPf] = useState({ q: '', ...EMPTY_PEOPLE_FILTERS, category: '', from: '', to: '' });

  function load() {
    api.get('/disciplinary').then((res) => setRecords(res.data));
    if (isHR) api.get('/employees').then((res) => setEmployees(res.data)).catch(() => setEmployees([]));
  }
  useEffect(load, [isHR]);

  async function closeCase(r) {
    await api.patch(`/disciplinary/${r.id}/status`, { status: 'Closed' });
    load();
  }

  const shown = records.filter((r) => textMatches(`${r.detail || ''} ${r.raisedBy || ''}`, pf.q)
    && peopleMatches(r, pf) && (!pf.category || r.category === pf.category));
  const opts = peopleOptions(records);
  const page = usePaged(shown);
  const clearPf = () => setPf((f) => Object.fromEntries(Object.keys(f).map((k) => [k, ''])));
  const categories = [...new Set([...CATEGORIES, ...records.map((r) => r.category).filter(Boolean)])];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Disciplinary Action Tracking</h1>
          <div className="page-sub">Disciplinary action tracking — candidate/case history is never deleted</div>
        </div>
      </div>
      {/* The head is hidden when this screen sits inside Performance &
          Development's tab strip, so the action lives in its own row. */}
      {/* Data I/O: export all / one employee and import of case history with
          the compulsory sample (backend src/io/disciplinary.js). */}
      <QaRow style={{ marginBottom: 14 }}>
        {isHR && <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>Log Case</button>}
        <DataIoBar
          ioKey="disciplinary"
          params={Object.fromEntries(['department', 'status', 'category', 'from', 'to'].filter((k) => pf[k]).map((k) => [k, pf[k]]))}
          onImported={load}
        />
      </QaRow>

      <Panel>
        <PanelHead title="Cases" />
        <div style={{ padding: '0 18px' }}>
          <PeopleFilterBar
            filters={pf} setFilters={setPf} people={hrView}
            departments={hrView ? opts.departments : undefined} roles={hrView ? opts.roles : undefined}
            statuses={statusOptions(records, CASE_STATUSES)} shown={shown.length} total={records.length}
            search="Description or raised by" dates="Date" labels={{ category: 'Category' }}
          >
            <Combo value={pf.category} title="Category" onChange={(e) => setPf((f) => ({ ...f, category: e.target.value }))}>
              <option value="">All categories</option>
              {categories.map((c) => <option key={c}>{c}</option>)}
            </Combo>
          </PeopleFilterBar>
        </div>
        {shown.length === 0 ? <ListEmpty lf={{ activeCount: Object.values(pf).some(Boolean) ? 1 : 0, clear: clearPf }} noun="cases" title="No disciplinary cases on file." /> : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Employee</th><th>Category</th><th>Description</th><th>Raised By</th><th>Date</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {page.slice.map((r) => (
                  <tr key={r.id}>
                    <td>{r.employee?.name}</td>
                    <td><span className={`status ${r.category === 'Warning' ? 'pending' : r.category === 'Other' ? 'review' : 'rejected'}`}>{r.category || '—'}</span></td>
                    <td>{r.detail || '—'}</td>
                    <td className="cell-muted">{r.raisedBy || '—'}</td>
                    <td className="cell-muted">{r.date || '—'}</td>
                    <td>{r.status}</td>
                    <td>{r.status === 'Open' && isHR ? <button className="btn btn-sm" onClick={() => closeCase(r)}>Close Case</button> : <span className="small-muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {page.total > 0 && <Pager page={page} noun="cases" />}
      </Panel>

      {open && <LogCaseModal employees={employees} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); load(); }} />}
    </div>
  );
}
