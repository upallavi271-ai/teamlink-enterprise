import { useEffect, useState } from 'react';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { isHR as hasHrmsAdmin, canDecideServices, canManageServices } from '../permissions';
import Combo from './Combo.jsx';
import PeopleFilterBar, { EMPTY_PEOPLE_FILTERS, peopleMatches, peopleOptions, statusOptions, textMatches } from './PeopleFilterBar.jsx';
import Pager, { usePaged } from './Pager.jsx';
import { ListEmpty } from './ui/ListFilters.jsx';
import AudiencePicker, { DeliverVia, EMPTY_AUDIENCE, audienceReady } from './AudiencePicker.jsx';
import {
  ComposeModal, Field, Row, AiAssist, ResultNote,
} from './ComposeForm.jsx';


// Generic list + create + (optional) status-decision page for the EmployeeRecord-backed
// HRMS areas (KT, Targets, Resignation, Recognition, Disciplinary, Shift Roster, Timesheet,
// Assets, Expenses, Helpdesk, Access Requests, Weekly Ideas) — one component, ~12 configs.
export default function SimpleRecordPage({
  title,
  apiPath,
  titleLabel = 'Title',
  detailLabel = 'Detail',
  showDate = false,
  dateLabel = 'Date',
  showAmount = false,
  amountLabel = 'Amount (₹)',
  showHours = false,
  showCategory = false,
  categoryLabel = 'Category',
  categoryOptions = [],
  showPriority = false,
  showLocation = false,
  showProgress = false,
  statuses = ['Open', 'In Progress', 'Resolved'],
  decisions = null, // e.g. ['Approved', 'Rejected'] to show decision buttons for HR roles
  createByHrOnly = false, // when true, only HR roles see the create form (e.g. assigning goals/assets)
  // When true the record can carry a real uploaded bill/receipt: the file is
  // POSTed as multipart to `${apiPath}/:id/bill` and stored on the server
  // OUTSIDE the repository (backend/src/utils/attachments.js). Every other
  // "document" in this app is still a filename typed into a box; this is the
  // first screen that stores bytes, and it is meant to be the pattern the
  // others adopt.
  showAttachment = false,
  attachmentLabel = 'Bill / Receipt',
  // AUDIENCE: when true, a login that may create for other people
  // (hrms/Employee Services/create) gets the shared Send-to picker — everyone
  // in scope, one or MANY departments, or named employees — and one record is
  // written per person. Everyone else still creates their own record.
  audience = false,
  audienceLabel = 'For',
  createLabel = 'New',
  aiKind = null, // AI Assist on the detail field, e.g. 'expense'
}) {
  const { user } = useAuth();
  // TWO HALVES, DELIBERATELY.
  //   hrView  — READ: may this login see other people's records here? It is
  //             what decides which rows and which columns are shown, and a
  //             view-only Manager (§3) keeps every one of them.
  //   isHR    — WRITE: may this login act on them? A Manager and an Assistant
  //             Manager hold Employee Management/view and so pass the read
  //             half; they must not be drawn a button the API refuses.
  const hrView = hasHrmsAdmin(user);
  const isHR = hrView && canDecideServices(user);
  const canSendToOthers = audience && hrView && (canManageServices(user) || canDecideServices(user));
  const [open, setOpen] = useState(false);
  const [aud, setAud] = useState(EMPTY_AUDIENCE);
  const [channels, setChannels] = useState([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [records, setRecords] = useState([]);
  const [employees, setEmployees] = useState([]);
  const emptyForm = { employeeId: '', title: '', detail: '', date: '', amount: '', hours: '', category: '', priority: 'Medium', location: '', progressPct: 0 };
  const [form, setForm] = useState(emptyForm);
  const [file, setFile] = useState(null);
  const [fileKey, setFileKey] = useState(0); // resets the <input type="file">
  const [error, setError] = useState('');
  // Filters (PeopleFilterBar): title search, the employee, status, the
  // record's category / priority when the page has them, and a date range on
  // the record's own date (or the day it was created when it has none).
  const [pf, setPf] = useState({ q: '', ...EMPTY_PEOPLE_FILTERS, category: '', priority: '', from: '', to: '' });
  const [sort, setSort] = useState('new');

  function load() {
    api.get(apiPath).then((res) => setRecords(res.data));
    if (createByHrOnly && isHR) api.get('/employees').then((res) => setEmployees(res.data));
  }
  useEffect(load, [apiPath]);

  // Mirrors the server's limits so the common mistakes are caught before a
  // 5MB upload crosses the wire. The server enforces them regardless.
  const MAX_BILL_BYTES = 5 * 1024 * 1024;
  const BILL_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];

  async function uploadBill(recordId, chosen) {
    const body = new FormData();
    body.append('file', chosen);
    // No explicit Content-Type: the browser has to set the multipart boundary.
    await api.post(`${apiPath}/${recordId}/bill`, body);
  }

  // Fetch the bill through the API (the download route is authenticated and
  // scope-checked) and hand the bytes to the browser as a save.
  async function downloadBill(r) {
    setError('');
    try {
      const res = await api.get(`${apiPath}/${r.id}/bill`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = r.billName || 'bill';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch {
      setError('Could not download that file.');
    }
  }

  async function submit() {
    setError('');
    if (!String(form.title || '').trim()) { setError(`Enter the ${titleLabel.toLowerCase()}.`); return; }
    if (createByHrOnly && !form.employeeId) { setError('Pick an employee.'); return; }
    if (canSendToOthers && !audienceReady(aud)) { setError(aud.mode === 'departments' ? 'Pick at least one department.' : 'Pick at least one employee.'); return; }
    const payload = { title: form.title, detail: form.detail };
    if (createByHrOnly) payload.employeeId = form.employeeId;
    else if (canSendToOthers) { payload.audience = aud; payload.channels = channels; }
    // A lead filing their OWN record names themselves; the server forces it
    // for a self-service login anyway.
    else if (user?.employeeId) payload.employeeId = user.employeeId;
    if (showDate) payload.date = form.date;
    if (showAmount) payload.amount = form.amount;
    if (showHours) payload.hours = form.hours;
    if (showCategory) payload.category = form.category;
    if (showPriority) payload.priority = form.priority;
    if (showLocation) payload.location = form.location;
    if (showProgress) payload.progressPct = form.progressPct;
    if (showAttachment && file) {
      if (file.size > MAX_BILL_BYTES) { setError('That file is larger than 5MB.'); return; }
      if (!BILL_TYPES.includes(file.type)) { setError('Only PNG, JPEG, WebP images and PDF files can be attached.'); return; }
    }
    let created;
    setBusy(true);
    try {
      created = (await api.post(apiPath, payload)).data;
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save that record.');
      setBusy(false);
      return;
    }
    setBusy(false);
    if (showAttachment && file) {
      try {
        await uploadBill(created.id, file);
      } catch (err) {
        // The claim saved; only the file failed. Say which, rather than
        // leaving the user guessing why the row has no bill on it.
        setError(`${err.response?.data?.error || 'The file could not be uploaded.'} The claim was saved without it.`);
      }
    }
    setForm(emptyForm);
    setFile(null);
    setFileKey((k) => k + 1);
    setAud(EMPTY_AUDIENCE);
    setChannels([]);
    setOpen(false);
    setDone(created && created.created != null
      ? `Saved for ${created.label} — ${created.created} record(s). ${created.deliveryText || ''}`
      : 'Saved.');
    load();
  }

  async function decide(id, status) {
    await api.patch(`${apiPath}/${id}/status`, { status });
    load();
  }

  async function updateProgress(id, current) {
    const v = prompt('Progress (%)', current ?? 0);
    if (v === null) return;
    await api.patch(`${apiPath}/${id}`, { progressPct: Number(v) || 0 });
    load();
  }

  const canCreate = !createByHrOnly || isHR;

  // The list's filters: the record's own title, the employee (for those who
  // see other people's records) and the record's status — the configured
  // `statuses` plus any other value actually on file.
  const shown = records.filter((r) => textMatches(`${r.title} ${r.detail || ''}`, pf.q) && peopleMatches(r, pf)
    && (!pf.category || r.category === pf.category)
    && (!pf.priority || r.priority === pf.priority));
  const opts = peopleOptions(records);
  const categories = showCategory ? statusOptions(records, categoryOptions, (r) => r.category) : [];
  const priorities = showPriority ? statusOptions(records, ['Low', 'Medium', 'High', 'Urgent'], (r) => r.priority) : [];
  // Newest first by default; the record's own date / amount when it has one.
  const SORTS = [
    { key: 'new', label: 'Newest first', cmp: (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) },
    { key: 'old', label: 'Oldest first', cmp: (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) },
    ...(showDate ? [{ key: 'date', label: `${dateLabel} (latest first)`, cmp: (a, b) => String(b.date || '').localeCompare(String(a.date || '')) }] : []),
    ...(showAmount ? [{ key: 'amount', label: 'Amount (high to low)', cmp: (a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0) }] : []),
    { key: 'title', label: `${titleLabel} A–Z`, cmp: (a, b) => String(a.title || '').localeCompare(String(b.title || '')) },
  ];
  const sorted = [...shown].sort((SORTS.find((x) => x.key === sort) || SORTS[0]).cmp);
  const page = usePaged(sorted);
  const pfOn = Object.values(pf).some(Boolean);
  const clearPf = () => setPf((f) => Object.fromEntries(Object.keys(f).map((k) => [k, ''])));
  const noun = /claim/i.test(title) ? 'claims' : 'records';

  return (
    <div>
      <div className="page-head"><h1>{title}</h1></div>

      {canCreate && (
        <div className="qa-row" style={{ marginBottom: 14 }}>
          <button className="btn btn-primary btn-sm" onClick={() => { setError(''); setOpen(true); }}>+ {createLabel}</button>
        </div>
      )}
      <ResultNote>{done}</ResultNote>
      {canCreate && open && (
        <ComposeModal title={createLabel} onClose={() => setOpen(false)} onSubmit={submit} submitLabel="Save" busy={busy} error={error} wide={canSendToOthers}>
          {createByHrOnly && (
            <Field label="Employee" required>
              <Combo value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
                <option value="">Select employee</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </Combo>
            </Field>
          )}
          <Field label={titleLabel} required><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
          {aiKind && <AiAssist kind={aiKind} title={form.title} text={form.detail} onText={(detail) => setForm((f) => ({ ...f, detail }))} />}
          <Field label={detailLabel}>
            {aiKind
              ? <textarea rows="3" value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} />
              : <input value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} />}
          </Field>
          <Row>
            {showCategory && (
              <Field label={categoryLabel}>
                {categoryOptions.length > 0 ? (
                  <Combo creatable value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                    <option value="">Select</option>
                    {categoryOptions.map((c) => <option key={c}>{c}</option>)}
                  </Combo>
                ) : (
                  <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
                )}
              </Field>
            )}
            {showPriority && (
              <Field label="Priority">
                <Combo value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                  <option>Low</option><option>Medium</option><option>High</option><option>Urgent</option>
                </Combo>
              </Field>
            )}
            {showLocation && <Field label="Location"><input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} /></Field>}
            {showDate && <Field label={dateLabel}><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>}
            {showAmount && <Field label={amountLabel}><input type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>}
            {showHours && <Field label="Hours"><input type="number" step="0.5" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} /></Field>}
            {showProgress && <Field label="Progress (%)"><input type="number" min="0" max="100" value={form.progressPct} onChange={(e) => setForm({ ...form, progressPct: e.target.value })} /></Field>}
          </Row>
          {showAttachment && (
            <Field label={attachmentLabel} hint="PNG, JPEG, WebP or PDF, up to 5MB. The file is stored on the server and only people who can see this claim can download it.">
              <input
                key={fileKey}
                type="file"
                accept="image/png,image/jpeg,image/webp,application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
            </Field>
          )}
          {canSendToOthers && (
            <>
              <AudiencePicker value={aud} onChange={setAud} label={audienceLabel} required />
              <DeliverVia value={channels} onChange={setChannels} />
            </>
          )}
        </ComposeModal>
      )}
      {!open && error && <div className="error-text" style={{ marginBottom: 8 }}>{error}</div>}

      <PeopleFilterBar
        filters={pf} setFilters={setPf} search={titleLabel} people={hrView}
        departments={hrView ? opts.departments : undefined} roles={hrView ? opts.roles : undefined}
        statuses={statusOptions(records, statuses)} shown={shown.length} total={records.length}
        dates={showDate ? dateLabel : 'Created on'}
        labels={{ category: categoryLabel, priority: 'Priority' }}
        moreKeys={['priority']}
        more={showPriority ? (
          <Combo value={pf.priority} title="Priority" onChange={(e) => setPf((f) => ({ ...f, priority: e.target.value }))}>
            <option value="">All priorities</option>
            {priorities.map((p) => <option key={p}>{p}</option>)}
          </Combo>
        ) : null}
      >
        {showCategory && (
          <Combo value={pf.category} title={categoryLabel} onChange={(e) => setPf((f) => ({ ...f, category: e.target.value }))}>
            <option value="">{`All ${categoryLabel.toLowerCase().replace(/y$/, 'ie')}s`}</option>
            {categories.map((c) => <option key={c}>{c}</option>)}
          </Combo>
        )}
        <label className="lf-sort">
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            {SORTS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>
        </label>
      </PeopleFilterBar>

      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              {hrView && <th>Employee</th>}
              <th>{titleLabel}</th>
              <th>{detailLabel}</th>
              {showCategory && <th>{categoryLabel}</th>}
              {showPriority && <th>Priority</th>}
              {showLocation && <th>Location</th>}
              {showDate && <th>{dateLabel}</th>}
              {showAmount && <th>Amount</th>}
              {showHours && <th>Hours</th>}
              {showProgress && <th>Progress</th>}
              {showAttachment && <th>{attachmentLabel}</th>}
              <th>Status</th>
              {isHR && decisions && <th></th>}
            </tr>
          </thead>
          <tbody>
            {page.slice.map((r) => (
              <tr key={r.id}>
                {hrView && <td>{r.employee?.name}</td>}
                <td>{r.title}</td>
                <td>{r.detail || '—'}</td>
                {showCategory && <td>{r.category || '—'}</td>}
                {showPriority && <td>{r.priority ? <span className={`status ${r.priority === 'Urgent' || r.priority === 'High' ? 'priority-high' : r.priority === 'Medium' ? 'priority-medium' : 'priority-low'}`}>{r.priority}</span> : '—'}</td>}
                {showLocation && <td>{r.location || '—'}</td>}
                {showDate && <td>{r.date || '—'}</td>}
                {showAmount && <td>{r.amount != null ? `₹${r.amount.toLocaleString('en-IN')}` : '—'}</td>}
                {showHours && <td>{r.hours ?? '—'}</td>}
                {showProgress && (
                  <td>
                    <span style={{ cursor: 'pointer' }} onClick={() => updateProgress(r.id, r.progressPct)}>{r.progressPct ?? 0}%</span>
                  </td>
                )}
                {showAttachment && (
                  <td>
                    {r.billFile ? (
                      <button type="button" className="link-btn" onClick={() => downloadBill(r)}>
                        {r.billName || 'Download'}
                        <span className="small-muted"> ({Math.max(1, Math.round((r.billSize || 0) / 1024))} KB)</span>
                      </button>
                    ) : <span className="small-muted">—</span>}
                  </td>
                )}
                <td><span className="status">{r.status}</span></td>
                {isHR && decisions && (
                  <td>
                    {decisions.map((d) => (
                      <button key={d} className="btn btn-sm" style={{ marginRight: 6 }} onClick={() => decide(r.id, d)}>{d}</button>
                    ))}
                  </td>
                )}
              </tr>
            ))}
            {shown.length === 0 && (
              <tr><td colSpan="12"><ListEmpty lf={{ activeCount: pfOn ? 1 : 0, clear: clearPf }} noun={noun} /></td></tr>
            )}
          </tbody>
        </table>
      </div>
      {page.total > 0 && <Pager page={page} noun={noun} />}
    </div>
  );
}
