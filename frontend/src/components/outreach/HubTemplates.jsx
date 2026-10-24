import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import Combo from '../Combo.jsx';
import Templates from './Templates.jsx';
import './omni2.css';

// ---------------------------------------------------------------------------
// OMNI-CHANNEL > TEMPLATES = the ONE place for every template (founder note (d)). The list is read from the stores that own the data
// (message templates, campaign messages, saved jobs, job-posting texts): nothing is copied, so the old screens always show the same thing.
// Server: GET /api/outreach/hub/templates, PUT /hub/templates/:key (goes through the owner's own rules), POST /hub/templates.
// ---------------------------------------------------------------------------
const CHIPS = [['all', 'Everything'], ['ATS', 'ATS'], ['Omni-Channel', 'Omni-Channel'], ['Job Portal', 'Job Portal'], ['HRMS / internal', 'HRMS / internal']];
const WA_WORD = { None: 'Not sent for approval', Pending: 'Waiting for WhatsApp', Approved: 'Approved by WhatsApp', Rejected: 'Rejected by WhatsApp' };
const fmt = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '');
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;

function EditModal({ acc, item, onClose, onSaved }) {
  const isNew = !item.key;
  const [f, setF] = useState(isNew
    ? { source: 'outreach', name: '', channel: 'Email', subject: '', body: '', audience: 'candidate_lead' }
    : { name: item.name, subject: item.subject, body: item.body, department: item.department || '', waTemplateName: item.wa ? item.wa.name : '', waStatus: item.wa ? item.wa.status : 'None' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [depts, setDepts] = useState([]);
  useEffect(() => { if (acc.isAdmin) api.get('/outreach/config/department-names').then((r) => setDepts(r.data.names)).catch(() => setDepts([])); }, [acc.isAdmin]);
  const readOnly = !isNew && !item.canEdit;
  const channel = isNew ? f.channel : item.channel;
  const showSubject = isNew ? f.channel === 'Email' : ['Email', 'Job', 'Posting'].includes(item.channel);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const kindValue = f.source === 'message' ? (f.audience === 'employee' ? 'message-employee' : 'message-candidate') : (f.audience === 'internal' ? 'outreach-internal' : 'outreach');
  const pickKind = (e) => {
    const v = e.target.value;
    if (v === 'outreach') setF({ ...f, source: 'outreach', audience: 'candidate_lead' });
    else if (v === 'outreach-internal') setF({ ...f, source: 'outreach', audience: 'internal' });
    else setF({ ...f, source: 'message', audience: v === 'message-employee' ? 'employee' : 'candidate' });
  };
  const save = async () => {
    setBusy(true); setErr('');
    try {
      if (isNew) await api.post('/outreach/hub/templates', f);
      else await api.put(`/outreach/hub/templates/${encodeURIComponent(item.key)}`, f);
      onSaved(); onClose();
    } catch (e) { setErr(errOf(e, 'It could not be saved.')); } finally { setBusy(false); }
  };
  return (
    <Modal
      title={isNew ? 'New template' : (readOnly ? `Template: ${item.name}` : `Edit: ${item.name}`)}
      size="wide"
      onClose={onClose}
      foot={(
        <>
          <button type="button" className="btn" onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</button>
          {!readOnly && <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>}
        </>
      )}
    >
      {isNew && (
        <div className="grid-2">
          <div className="field"><span>What kind of template</span>
            <Combo value={kindValue} onChange={pickKind}>
              <option value="outreach">Requirement campaign message (Omni-Channel)</option>
              {acc.canEditInternalTemplates && <option value="outreach-internal">Staff campaign message (internal)</option>}
              <option value="message-candidate">Message template for candidates and clients (ATS)</option>
              <option value="message-employee">Message template for staff (HRMS)</option>
            </Combo>
          </div>
          <div className="field"><span>Channel</span><Combo value={f.channel} onChange={set('channel')}><option>Email</option><option>WhatsApp</option><option>SMS</option></Combo></div>
        </div>
      )}
      {readOnly && <div className="bc-warn" role="status">{item.readOnlyWhy || 'You can look at this template but not change it.'}</div>}
      <label className="field"><span>Name</span><input value={f.name} maxLength={120} disabled={readOnly} onChange={set('name')} /></label>
      {showSubject && <label className="field"><span>{channel === 'Job' ? 'Requirement title' : 'Subject'}</span><input value={f.subject} maxLength={200} disabled={readOnly} onChange={set('subject')} /></label>}
      <label className="field"><span>{channel === 'Job' ? 'Requirement description' : 'Message'}</span><textarea className="oc-text" rows={9} value={f.body} disabled={readOnly} onChange={set('body')} /></label>
      {!isNew && acc.isAdmin && item.source !== 'script' && (
        <div className="field"><span>Which department uses it (empty = every department)</span><Combo value={f.department || ''} onChange={set('department')}><option value="">Every department</option>{depts.map((d) => <option key={d} value={d}>{d}</option>)}</Combo></div>
      )}
      {!isNew && item.source === 'message' && item.channel === 'WhatsApp' && acc.isAdmin && (
        <div className="grid-2">
          <label className="field"><span>WhatsApp template name (as in the Meta console)</span><input value={f.waTemplateName || ''} onChange={set('waTemplateName')} /></label>
          <div className="field"><span>WhatsApp approval</span><Combo value={f.waStatus} onChange={set('waStatus')}>{Object.keys(WA_WORD).map((k) => <option key={k} value={k}>{WA_WORD[k]}</option>)}</Combo></div>
        </div>
      )}
      {!isNew && <div className="oc2-edit-note">This is the same template as in {item.oldPlace}. A change here shows there too.</div>}
      {err && <div className="bc-err" role="alert">{err}</div>}
    </Modal>
  );
}

export default function HubTemplates({ acc }) {
  const [view, setView] = useState('all'); // all | queue (waiting for Meta approval) | campaign (full campaign message editor)
  const [where, setWhere] = useState('all');
  const [q, setQ] = useState('');
  const [channel, setChannel] = useState('');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState(null);
  const load = useCallback(() => api.get('/outreach/hub/templates', { params: { where: where === 'all' ? undefined : where, q: q || undefined, channel: channel || undefined, approval: view === 'queue' ? 'queue' : undefined } })
    .then((r) => { setData(r.data); setErr(''); })
    .catch((e) => { setErr(errOf(e, 'The templates could not be loaded.')); setData((d) => d || { items: [], counts: {}, channels: {} }); }), [where, q, channel, view]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  const counts = (data && data.counts) || {};
  const chans = Object.keys((data && data.channels) || {});
  const canNew = acc.canEditTemplates || acc.canEditInternalTemplates || acc.isAdmin || acc.kind === 'tl' || acc.kind === 'hr';
  return (
    <div>
      <div className="oc2-seg" role="tablist" aria-label="Templates view">
        <button type="button" role="tab" aria-selected={view === 'all'} className={view === 'all' ? 'on' : ''} onClick={() => { setView('all'); setChannel(''); }}>All templates</button>
        <button type="button" role="tab" aria-selected={view === 'queue'} className={view === 'queue' ? 'on' : ''} onClick={() => { setView('queue'); setChannel('WhatsApp'); }}>Approval queue{data && data.queue ? ` (${data.queue.pending + data.queue.notSent})` : ''}</button>
        <button type="button" role="tab" aria-selected={view === 'campaign'} className={view === 'campaign' ? 'on' : ''} onClick={() => setView('campaign')}>Campaign message editor</button>
      </div>
      {view === 'campaign' && <Templates acc={acc} type={acc.seesLeads ? 'candidate_lead' : 'internal'} />}
      {view !== 'campaign' && (
        <>
          {view === 'queue' && data && data.queue && <div className="oc2-tiles"><div className="oc2-tile o"><b>{data.queue.pending}</b><span>Waiting for WhatsApp to approve</span></div><div className="oc2-tile"><b>{data.queue.notSent}</b><span>Not sent for approval yet</span></div><div className="oc2-tile r"><b>{data.queue.rejected}</b><span>Rejected</span></div></div>}
          {view === 'queue' && <div className="oc-note">WhatsApp templates that are not approved yet, for your own department. An Admin changes the status after Meta answers (Edit). We never mark one Approved ourselves.</div>}
          <div className="oc2-planned">Planned, not built: AI call scripts. Today the built-in call scripts are listed here (channel &quot;Call script&quot;) and are only read.</div>
          <div className="oc-note">Every message and requirement template in one place. Pick where it is used, search, and press Edit. A change here is the same as in the old screens.</div>
          <div className="oc2-chips" role="group" aria-label="Where it is used">
            {CHIPS.map(([id, label]) => (
              <button type="button" key={id} className={`oc2-chip${where === id ? ' on' : ''}`} aria-pressed={where === id} onClick={() => setWhere(id)}>{label}<span className="n">{id === 'all' ? counts.all : counts[id]}</span></button>
            ))}
          </div>
          <div className="oc-bar">
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a template name or words in it" aria-label="Search templates" />
            <div style={{ minWidth: 180 }}><Combo value={channel} onChange={(e) => setChannel(e.target.value)}><option value="">All channels</option>{chans.map((c) => <option key={c} value={c}>{c}</option>)}</Combo></div>
            {canNew && <button type="button" className="btn btn-primary" onClick={() => setEdit({})}>New template</button>}
          </div>
          {err && <div className="bc-err" role="alert">{err}</div>}
          {!data && <div className="oc-note">Loading…</div>}
          {data && data.items.length === 0 && !err && <div className="oc-empty"><b>No templates found.</b><div>Try another place or clear the search.</div></div>}
          {data && data.items.length > 0 && (
            <div className="oc-scroll">
              <table className="oc2-table oc2-hub">
                <thead><tr><th>Template</th><th>Used in</th><th>Kind</th><th>Channel</th><th>WhatsApp approval</th><th>Department</th><th>Changed</th><th>Change</th></tr></thead>
                <tbody>
                  {data.items.map((i) => (
                    <tr key={i.key}>
                      <td className="name">{i.name}{i.group && i.group !== i.name && <span className="oc2-sub">{i.group}{i.language ? `, ${i.language}` : ''}</span>}</td>
                      <td data-l="Used in">{i.where.map((w) => <span key={w} className="oc-pill kind">{w}</span>)}</td>
                      <td data-l="Kind">{i.sourceWord}</td>
                      <td data-l="Channel">{i.channel}</td>
                      <td data-l="WhatsApp">{i.wa ? <span className={`oc2-wa ${i.wa.status}`}>{WA_WORD[i.wa.status] || i.wa.status}</span> : ''}</td>
                      <td data-l="Department">{i.department}</td>
                      <td data-l="Changed">{fmt(i.updatedAt)}{i.byName && <span className="oc2-sub">{i.byName}</span>}</td>
                      <td><button type="button" className="btn btn-sm" onClick={() => setEdit(i)} title={i.canEdit ? 'Change this template' : (i.readOnlyWhy || 'Look at this template')}>Edit</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.truncated && <div className="oc-note">Showing the first 600. Use the search to narrow it down.</div>}
            </div>
          )}
          {edit && <EditModal acc={acc} item={edit} onClose={() => setEdit(null)} onSaved={load} />}
        </>
      )}
    </div>
  );
}
