import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { isHR as hasHrmsAdmin, canManageServices } from '../../permissions';
import Combo from '../../components/Combo.jsx';
import PeopleFilterBar, { peopleMatches, textMatches } from '../../components/PeopleFilterBar.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import { ListEmpty } from '../../components/ui/ListFilters.jsx';
import DataIoBar from '../../components/dataio/DataIoBar.jsx';
import AudiencePicker, { DeliverVia, EMPTY_AUDIENCE, audienceReady } from '../../components/AudiencePicker.jsx';
import {
  ComposeModal, Field, Row, CheckLine, useSubmit,
} from '../../components/ComposeForm.jsx';

// A policy document is company-wide, not per employee, so its filters are its
// own: title, category, and — for HR, who sees unpublished ones — whether it
// is published to employees, hidden, or company paperwork that never is.
const DOC_STATUSES = ['Published', 'Hidden', 'Internal only'];
const docStatusOf = (d) => (d.publishable === false ? 'Internal only' : d.published ? 'Published' : 'Hidden');
const EMPTY_DOC_FILTERS = { q: '', category: '', status: '', mandatory: '', target: '', from: '', to: '' };
const docDateOf = (d) => d.uploadedDate || d.createdAt;
const DOC_SORTS = [
  ['new', 'Newest first', (a, b) => String(docDateOf(b)).localeCompare(String(docDateOf(a)))],
  ['old', 'Oldest first', (a, b) => String(docDateOf(a)).localeCompare(String(docDateOf(b)))],
  ['title', 'Title A–Z', (a, b) => String(a.title || '').localeCompare(String(b.title || ''))],
];

// The reference compose layout (components/ComposeForm.jsx). SEND TO is the
// shared AudiencePicker — everyone, one or MANY departments, or named
// employees — and the acknowledgement count is measured against exactly
// that audience. A Company Documents item is never pushed to employees, so
// the picker and the delivery row are hidden for it.
function PublishDocumentModal({ onClose, onSaved }) {
  const [form, setForm] = useState({ title: '', category: 'Policy', mandatory: true, uploadedDate: new Date().toISOString().slice(0, 10) });
  const [audience, setAudience] = useState(EMPTY_AUDIENCE);
  const [channels, setChannels] = useState([]);
  const { busy, error, setError, run } = useSubmit();
  const internal = form.category.trim().toLowerCase() === 'company documents';

  async function submit() {
    if (!form.title.trim()) { setError('Enter a title.'); return; }
    if (!internal && !audienceReady(audience)) { setError(audience.mode === 'departments' ? 'Pick at least one department.' : 'Pick at least one employee.'); return; }
    const body = internal ? { ...form, target: 'Internal only' } : { ...form, audience, channels };
    const res = await run(() => api.post('/documents', body), 'Could not publish the document');
    if (res) onSaved(res.data);
  }

  return (
    <ComposeModal title="Publish Document" onClose={onClose} onSubmit={submit} submitLabel="Publish" busy={busy} error={error} wide>
      <Field label="Title" required><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
      <Row>
        <Field label="Category">
          <Combo creatable value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            <option>Policy</option>
            <option>Compliance</option>
            {/* The one category that is never pushed to employee
                self-service — the company's own paperwork. The server
                enforces it; this option is just how it gets chosen. */}
            <option>Company Documents</option>
          </Combo>
        </Field>
        <Field label="Document date" required><input type="date" value={form.uploadedDate} onChange={(e) => setForm({ ...form, uploadedDate: e.target.value })} /></Field>
      </Row>
      {internal ? (
        <div className="notice amber">Company documents are the company's own paperwork and are never published to employees.</div>
      ) : (
        <>
          <AudiencePicker value={audience} onChange={setAudience} />
          <DeliverVia value={channels} onChange={setChannels} />
        </>
      )}
      <CheckLine checked={form.mandatory} onChange={(mandatory) => setForm({ ...form, mandatory })}>Mandatory — needs each recipient's acknowledgement</CheckLine>
    </ComposeModal>
  );
}

export default function Documents() {
  const { user } = useAuth();
  // isHR here DRAWS WRITE CONTROLS, so it asks the write permission and not
  // only the read one. A Manager and an Assistant Manager are view-only (§3,
  // §4) and still hold Employee Management/view, so isHR() alone would have
  // gone on offering them every button on this screen. Both halves, because
  // the screen is an administration screen AND these are writes.
  const isHR = hasHrmsAdmin(user) && canManageServices(user);
  const [documents, setDocuments] = useState([]);
  const [df, setDf] = useState(EMPTY_DOC_FILTERS);
  const [sort, setSort] = useState('new');
  const [publishing, setPublishing] = useState(false);
  const [sent, setSent] = useState('');

  function load() {
    api.get('/documents').then((res) => setDocuments(res.data));
  }
  useEffect(load, []);

  async function acknowledge(id) {
    await api.post(`/documents/${id}/acknowledge`);
    load();
  }

  async function toggleVisibility(id) {
    await api.put(`/documents/${id}/visibility`);
    load();
  }

  async function remove(id) {
    if (!confirm('Delete this document?')) return;
    await api.delete(`/documents/${id}`);
    load();
  }

  const shown = documents.filter((d) => textMatches(`${d.title} ${d.category || ''} ${d.target || ''} ${d.uploadedBy || ''}`, df.q)
    && (!df.category || d.category === df.category)
    && (!df.status || docStatusOf(d) === df.status)
    && (!df.mandatory || (df.mandatory === 'Mandatory' ? !!d.mandatory : !d.mandatory))
    && (!df.target || d.target === df.target)
    && peopleMatches(d, { from: df.from, to: df.to }, undefined, undefined, docDateOf))
    .sort((DOC_SORTS.find(([k]) => k === sort) || DOC_SORTS[0])[2]);
  const page = usePaged(shown);
  const categories = [...new Set(documents.map((d) => d.category).filter(Boolean))].sort();
  const targets = [...new Set(documents.map((d) => d.target).filter(Boolean))].sort();
  const setD = (k, v) => setDf((f) => ({ ...f, [k]: v }));
  const dfLike = { activeCount: Object.values(df).filter(Boolean).length, clear: () => setDf(EMPTY_DOC_FILTERS) };

  return (
    <div>
      <div className="page-head">
        <h1>Documents</h1>
      </div>

      {/* hrms-24 §3 — each employee's documents on file and policy
          acknowledgments, in this login's scope (own only without the
          export permission): Export all · Export one employee; Import is
          shown disabled with the reason — documents are files
          (src/io/documents.js). In this row, not the page head: inside the
          Employee Services tabs the page head is hidden (.tab-content
          .page-head), which is where the old export button went missing. */}
      <div className="qa-row" style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {isHR && <button className="btn btn-primary btn-sm" onClick={() => setPublishing(true)}>+ Publish Document</button>}
        <span style={{ marginLeft: 'auto' }}><DataIoBar ioKey="documents" exportUrl="/insights/documents/export" showImport={false} /></span>
      </div>
      {sent && <div className="notice">{sent}</div>}
      {publishing && (
        <PublishDocumentModal
          onClose={() => setPublishing(false)}
          onSaved={(d) => { setPublishing(false); setSent(d.reached == null ? `"${d.title}" saved — internal only, not published to employees.` : `"${d.title}" published to ${d.target} — ${d.reached} employee(s). ${d.deliveryText || ''}`); load(); }}
        />
      )}

      <PeopleFilterBar
        filters={df} setFilters={setDf} people={false} search="Title"
        statuses={hasHrmsAdmin(user) ? DOC_STATUSES : undefined} shown={shown.length} total={documents.length}
        dates="Document date" labels={{ category: 'Category', mandatory: 'Mandatory', target: 'Sent to' }} moreKeys={['mandatory', 'target']}
        more={(
          <>
            <Combo value={df.mandatory} title="Mandatory" onChange={(e) => setD('mandatory', e.target.value)}>
              <option value="">Mandatory or not</option>
              <option>Mandatory</option>
              <option>Optional</option>
            </Combo>
            <Combo value={df.target} title="Sent to" onChange={(e) => setD('target', e.target.value)}>
              <option value="">Sent to anyone</option>
              {targets.map((t) => <option key={t}>{t}</option>)}
            </Combo>
          </>
        )}
      >
        <Combo value={df.category} title="Category" onChange={(e) => setD('category', e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c}>{c}</option>)}
        </Combo>
        <label className="lf-sort">
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            {DOC_SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
      </PeopleFilterBar>

      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Title</th><th>Category</th><th>Mandatory</th><th>Target</th><th>Uploaded by</th><th>Date</th><th>Acknowledged</th><th></th></tr></thead>
          <tbody>
            {page.slice.map((d) => (
              <tr key={d.id}>
                <td>{d.title}</td>
                <td>{d.category}</td>
                <td>{d.mandatory ? 'Yes' : 'No'}</td>
                <td>{d.target}</td>
                <td>{d.uploadedBy || '—'}</td>
                <td>{d.uploadedDate}</td>
                <td>{d.acknowledgments.length} of {d.totalEmployees}</td>
                <td>
                  {!isHR && <button className="btn btn-sm" onClick={() => acknowledge(d.id)}>Acknowledge</button>}
                  {isHR && (
                    <>
                      {d.publishable === false ? (
                        <span className="small-muted" title="Company paperwork is never pushed to employee self-service">Internal only</span>
                      ) : (
                        <button className="btn btn-sm" onClick={() => toggleVisibility(d.id)}>{d.published ? 'Hide from Employees' : 'Publish'}</button>
                      )}
                      <button className="btn btn-sm" onClick={() => remove(d.id)}>Delete</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan="8" className="small-muted"><ListEmpty lf={dfLike} noun="documents" /></td></tr>}
          </tbody>
        </table>
      </div>
      {shown.length > 0 && <Pager page={page} noun="documents" />}
    </div>
  );
}
