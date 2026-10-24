import { useEffect, useRef, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import api from '../../api';
import Modal from '../Modal.jsx';
import StatusChip from '../ui/StatusChip.jsx';
import CampaignDialog from './CampaignDialog.jsx';
import CampaignResults from './CampaignResults.jsx';
import './broadcast.css';

// ---------------------------------------------------------------------------
// CANDIDATES > CONTACT LISTS. A company gives us contact lists (CSV / Excel). Import them, send a job to them on
// WhatsApp, read the replies. Three small parts:  My lists  ·  Campaigns  ·  Settings (Admin).
// Server: /api/job-broadcast. Rules and limits: docs/job-broadcast/FLOW.md.
// ---------------------------------------------------------------------------
export function contactsAllowed(user) {
  const roles = [user?.role, user?.atsRole].filter(Boolean);
  if (roles.some((r) => ['CLIENT', 'CANDIDATE', 'RECRUITER', 'ACCOUNTANT'].includes(r)) && !roles.some((r) => ['SUPER_ADMIN', 'ADMIN', 'TL', 'BDE', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'HR'].includes(r))) return false;
  return roles.some((r) => ['SUPER_ADMIN', 'ADMIN', 'TL', 'BDE', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'HR'].includes(r));
}
const when = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const sendable = (t) => (t ? (t.valid || 0) + (t.candidate || 0) + (t.other_list || 0) : 0);
const STATUS_TONE = { valid: 'green', candidate: 'blue', other_list: 'blue', invalid: 'red', no_phone: 'red', dup_in_file: 'yellow', stop: 'red', no_consent: 'red' };
const CAMP_TONE = { DRAFT: 'grey', SCHEDULED: 'blue', RUNNING: 'blue', PAUSED: 'yellow', DONE: 'green', CANCELLED: 'grey' };
const CAMP_WORDS = { DRAFT: 'Not started', SCHEDULED: 'Scheduled', RUNNING: 'Sending', PAUSED: 'Paused', DONE: 'Finished', CANCELLED: 'Cancelled' };

// ---------------------------------------------------------------------------- import (3 steps)
function ImportContacts({ onClose, onSaved }) {
  const [file, setFile] = useState(null);
  const [check, setCheck] = useState(null);
  const [mapping, setMapping] = useState({});
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState('');
  const [pct, setPct] = useState(0);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(null);
  const input = useRef(null);
  const step = saved ? 4 : check && !check.needsMapping ? 2 : 1;

  const send = (path, f, map, extra = '') => api.post(`/job-broadcast${path}?mapping=${encodeURIComponent(JSON.stringify(map || {}))}${extra}`, f, {
    headers: { 'Content-Type': 'application/octet-stream' }, transformRequest: [(x) => x], onUploadProgress: (e) => setPct(e.total ? Math.round((e.loaded * 100) / e.total) : 0),
  });
  async function run(f, map) {
    setBusy('check'); setErr(''); setPct(0);
    try {
      const r = await send('/import/check', f, map);
      setCheck(r.data); setMapping(r.data.mapping || {});
      if (!name) setName(f.name.replace(/\.[^.]+$/, '').slice(0, 80));
      if (r.data.error && r.data.needsMapping) setErr(r.data.error);
    } catch (e) { setErr(e.response?.data?.error || 'That file could not be read.'); setCheck(null); } finally { setBusy(''); }
  }
  const pick = (f) => { if (!f) return; setFile(f); setCheck(null); setSaved(null); run(f, null); };
  async function save() {
    setBusy('save'); setErr(''); setPct(0);
    try {
      const r = await send('/import/save', file, mapping, `&name=${encodeURIComponent(name)}&source=${encodeURIComponent(source)}&filename=${encodeURIComponent(file.name)}`);
      setSaved(r.data); onSaved(r.data.list);
    } catch (e) { setErr(e.response?.data?.error || 'It could not be saved.'); } finally { setBusy(''); }
  }
  const errorsCsv = () => {
    const rows = [['Row', 'Name', 'Phone', 'Problem', 'Why'], ...(check.problems || []).map((p) => [p.i, p.name, p.phone, p.statusWords, p.why])];
    const csv = rows.map((r) => r.map((c) => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'rows-with-problems.csv'; a.click();
  };
  const t = check && check.totals;

  return (
    <Modal title="Import contacts" size="wide" onClose={onClose} foot={(
      <>
        <button type="button" className="btn" onClick={onClose}>{saved ? 'Close' : 'Cancel'}</button>
        {!saved && check && !check.needsMapping && <button type="button" className="btn btn-primary" disabled={!!busy || name.trim().length < 2 || !sendable(t)} onClick={save}>{busy === 'save' ? 'Saving…' : `3. Save ${sendable(t).toLocaleString('en-IN')} contacts`}</button>}
      </>
    )}
    >
      <div className="bc-steps">
        <div className={`bc-step ${step === 1 ? 'on' : 'done'}`}>1. Upload</div>
        <div className={`bc-step ${step === 2 ? 'on' : (step > 2 ? 'done' : '')}`}>2. Check</div>
        <div className={`bc-step ${step === 4 ? 'done' : ''}`}>3. Save</div>
      </div>
      {!saved && (
        <div className="bc-row" style={{ marginTop: 0 }}>
          <input ref={input} type="file" accept=".csv,.xlsx,.xls" onChange={(e) => pick(e.target.files?.[0])} aria-label="Contact file" />
          <a className="btn btn-sm" href="/api/job-broadcast/lists/template?format=xlsx" onClick={(e) => { e.preventDefault(); api.get('/job-broadcast/lists/template', { params: { format: 'xlsx' }, responseType: 'blob' }).then((r) => { const a = document.createElement('a'); a.href = URL.createObjectURL(r.data); a.download = 'contact-list-template.xlsx'; a.click(); }); }}>Download the Excel template</a>
          <span className="bc-note">CSV or Excel, up to 5,000 rows. Columns: Name, Phone, Email, Company, City, Skills.</span>
        </div>
      )}
      {busy === 'check' && <div><div className="bc-bar"><i style={{ width: `${pct || 30}%` }} /></div><div className="bc-note">Reading and checking every number…</div></div>}
      {err && <div className="bc-err" role="alert">{err}</div>}

      {check && check.needsMapping && (
        <div className="bc-box">
          <b>Which column has the phone number?</b>
          <div className="bc-row">{check.headers.map((h, i) => <button type="button" key={i} className="bc-tab" onClick={() => { const m = { ...mapping, phone: i }; setMapping(m); run(file, m); }}>{h || `Column ${i + 1}`}</button>)}</div>
        </div>
      )}

      {check && !check.needsMapping && !saved && (
        <>
          <div className="bc-tiles" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
            <div className="bc-tile green"><div className="n">{sendable(t)}</div><div className="l">Can be messaged</div></div>
            <div className="bc-tile red"><div className="n">{(t.invalid || 0) + (t.no_phone || 0)}</div><div className="l">Bad or missing number</div></div>
            <div className="bc-tile orange"><div className="n">{(t.dup_in_file || 0) + (t.stop || 0) + (t.no_consent || 0)}</div><div className="l">Repeated, STOP or no permission</div></div>
            <div className="bc-tile blue"><div className="n">{(t.candidate || 0) + (t.other_list || 0)}</div><div className="l">Already known (still ok)</div></div>
          </div>
          <div className="bc-note">{`${check.rowCount.toLocaleString('en-IN')} rows read. Columns found: ${Object.entries(mapping).map(([f, i]) => `${check.fields[f]} = "${check.headers[i]}"`).join(' · ')}`}</div>
          <div className="grid-2" style={{ marginTop: 8 }}>
            <label className="field"><span>List name</span><input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></label>
            <label className="field"><span>Where did it come from? (source tag)</span><input value={source} maxLength={140} placeholder="Client X contact list, Oct 2026" onChange={(e) => setSource(e.target.value)} /></label>
          </div>
          {check.problemCount > 0 && (
            <>
              <div className="bc-row"><b>{check.problemCount} rows need a look</b><button type="button" className="btn btn-sm" onClick={errorsCsv}>Download these rows</button></div>
              <div className="bc-scroll" style={{ maxHeight: 220 }}>
                <table className="bc-table"><thead><tr><th>Row</th><th>Name</th><th>Phone</th><th>Problem</th></tr></thead>
                  <tbody>{check.problems.slice(0, 100).map((p) => <tr key={p.i}><td>{p.i}</td><td>{p.name}</td><td>{p.phone}</td><td><StatusChip tone={STATUS_TONE[p.status]}>{p.statusWords}</StatusChip> <span className="bc-note">{p.why}</span></td></tr>)}</tbody></table>
              </div>
            </>
          )}
          <div className="bc-note" style={{ marginTop: 6 }}>Nothing is sent by importing. Before the first message the sender confirms the people gave permission.</div>
        </>
      )}
      {saved && (
        <div className="bc-ok" role="status">
          {saved.ok}<div style={{ marginTop: 6 }}>Next: open the list and press "Send a requirement to this list".</div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------- one list
function ListDetail({ id, canRun, masked, onClose, onSend, onChanged }) {
  const [d, setD] = useState(null);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api.get(`/job-broadcast/lists/${id}`, { params: { status: status || undefined, q: q || undefined, page } }).then((r) => setD(r.data)).catch((e) => setErr(e.response?.data?.error || 'Could not open the list.'));
  useEffect(() => { load(); }, [id, status, page]); // eslint-disable-line react-hooks/exhaustive-deps
  const setRetention = async (days) => { try { await api.put(`/job-broadcast/lists/${id}`, { retentionDays: days }); setMsg(days ? `This list is kept for ${days} days, then the contacts are removed.` : 'This list is kept until you delete it.'); load(); } catch (e) { setErr(e.response?.data?.error || 'Not saved.'); } };
  const exportIt = async () => { try { const r = await api.get(`/job-broadcast/lists/${id}/export`, { responseType: 'blob' }); const a = document.createElement('a'); a.href = URL.createObjectURL(r.data); a.download = 'contact-list.xlsx'; a.click(); } catch (e) { setErr('You cannot download this list.'); } };
  if (!d) return <Modal title="Contact list" size="xwide" onClose={onClose}><div className="bc-note">{err || 'Loading…'}</div></Modal>;
  const l = d.list;
  const chips = [['', 'All', Object.values(d.counts).reduce((a, b) => a + b, 0)], ...Object.keys(d.statusWords).filter((k) => d.counts[k]).map((k) => [k, d.statusWords[k], d.counts[k]])];
  return (
    <Modal title={l.name} size="xwide" onClose={onClose} foot={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      <div className="bc-row" style={{ marginTop: 0 }}>
        <span className="bc-note">{`${l.source || 'No source tag'} · imported ${when(l.createdAt)} by ${l.createdByName} · owner ${l.ownerName}`}</span>
        <span style={{ flex: 1 }} />
        {canRun && <button type="button" className="btn btn-primary" onClick={() => onSend(l.id)}>Send a requirement to this list</button>}
        {canRun && !masked && <button type="button" className="btn btn-sm" onClick={exportIt}>Download list</button>}
      </div>
      {l.consent
        ? <div className="bc-ok">Permission confirmed by {l.consent.byName} on {when(l.consent.at)}: "{l.consent.basis}"</div>
        : <div className="bc-warn">Permission is not confirmed yet. You tick it when you send the first requirement (the reason is saved in the audit log).</div>}
      {masked && <div className="bc-note">Phone numbers are hidden for your login. The server sends the messages.</div>}
      <div className="bc-tabs">{chips.map(([k, w, n]) => <button type="button" key={k} className={`bc-tab${status === k ? ' on' : ''}`} onClick={() => { setStatus(k); setPage(1); }}>{w}<span className="bc-n">{n}</span></button>)}</div>
      <div className="bc-row"><input placeholder="Search name, company, city" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { setPage(1); load(); } }} /><button type="button" className="btn btn-sm" onClick={() => { setPage(1); load(); }}>Search</button></div>
      <div className="bc-scroll" style={{ maxHeight: 360 }}>
        <table className="bc-table"><thead><tr><th>Name</th><th>Phone</th><th>Company</th><th>City</th><th>Status</th></tr></thead>
          <tbody>{d.contacts.map((c) => (
            <tr key={c.i}><td>{c.name}</td><td>{c.phone}</td><td>{c.company}</td><td>{c.city}</td>
              <td><StatusChip tone={STATUS_TONE[c.status]}>{c.statusWords}</StatusChip> {c.cand && <Link className="bc-note" to={`/candidates/${c.cand.id}`}>open profile</Link>} <span className="bc-note">{c.status !== 'valid' ? c.why : ''}</span></td></tr>
          ))}</tbody></table>
      </div>
      <div className="bc-row">
        <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Back</button>
        <span className="bc-note">{`Page ${page} · ${d.total.toLocaleString('en-IN')} people`}</span>
        <button type="button" className="btn btn-sm" disabled={page * 50 >= d.total} onClick={() => setPage(page + 1)}>Next</button>
        {canRun && (
          <>
            <span style={{ flex: 1 }} />
            <span className="bc-note">Keep this list for</span>
            {[[0, 'Until I delete it'], [30, '30 days'], [90, '90 days'], [365, '1 year']].map(([n, w]) => <button type="button" key={n} className={`bc-tab${(l.retentionDays || 0) === n ? ' on' : ''}`} onClick={() => setRetention(n)}>{w}</button>)}
          </>
        )}
      </div>
      {msg && <div className="bc-ok">{msg}</div>}
      {err && <div className="bc-err">{err}</div>}
      <span style={{ display: 'none' }}>{onChanged ? '' : ''}</span>
    </Modal>
  );
}

// ---------------------------------------------------------------------------- the tab
export default function ContactLists({ user }) {
  const [sp, setSp] = useSearchParams();
  const [sub, setSub] = useState(sp.get('campaign') ? 'campaigns' : 'lists');
  const [lists, setLists] = useState(null);
  const [canRun, setCanRun] = useState(false);
  const [masked, setMasked] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const [camps, setCamps] = useState(null);
  const [settings, setSettings] = useState(null);
  const [isAdminUser, setIsAdminUser] = useState(false);
  const [importing, setImporting] = useState(false);
  const [open, setOpen] = useState(null);
  const [sending, setSending] = useState(null);
  const [results, setResults] = useState(sp.get('campaign') || null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [source, setSource] = useState(null);

  const loadLists = () => api.get('/job-broadcast/lists', { params: { deleted: showDeleted ? 1 : undefined } }).then((r) => { setLists(r.data.lists); setCanRun(r.data.canRun); setMasked(r.data.masked); }).catch((e) => setErr(e.response?.data?.error || 'Could not load the lists.'));
  const loadCamps = () => api.get('/job-broadcast/campaigns').then((r) => setCamps(r.data.campaigns)).catch(() => setCamps([]));
  const loadSettings = () => api.get('/job-broadcast/settings').then((r) => { setSettings(r.data.settings); setIsAdminUser(r.data.canEdit); }).catch(() => {});
  useEffect(() => { loadLists(); }, [showDeleted]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadCamps(); loadSettings(); api.get('/job-broadcast/sources').then((r) => setSource(r.data.sources)).catch(() => {}); }, []);
  useEffect(() => { if (!camps || !camps.some((c) => c.status === 'RUNNING')) return undefined; const t = setTimeout(loadCamps, 6000); return () => clearTimeout(t); }, [camps]); // eslint-disable-line react-hooks/exhaustive-deps

  const del = async (l) => { if (!window.confirm(`Delete the list "${l.name}"? You can bring it back for 7 days.`)) return; try { await api.delete(`/job-broadcast/lists/${l.id}`); setMsg(`"${l.name}" is deleted. You can bring it back for 7 days.`); loadLists(); } catch (e) { setErr(e.response?.data?.error || 'Not deleted.'); } };
  const undo = async (l) => { try { await api.post(`/job-broadcast/lists/${l.id}/undelete`); setMsg(`"${l.name}" is back.`); loadLists(); } catch (e) { setErr(e.response?.data?.error || 'Could not bring it back.'); } };
  const saveSettings = async (patch) => { try { const r = await api.put('/job-broadcast/settings', patch); setSettings(r.data.settings); setMsg('Saved.'); } catch (e) { setErr(e.response?.data?.error || 'Not saved.'); } };
  const closeResults = () => { setResults(null); if (sp.get('campaign')) { const n = new URLSearchParams(sp); n.delete('campaign'); setSp(n, { replace: true }); } };

  return (
    <div className="bc-lists">
      <div className="bc-row" style={{ marginTop: 0 }}>
        {[['lists', 'My lists'], ['campaigns', 'Campaigns'], ...(settings ? [['settings', 'Settings']] : [])].map(([k, l]) => <button type="button" key={k} className={`bc-tab${sub === k ? ' on' : ''}`} onClick={() => setSub(k)}>{l}{k === 'campaigns' && camps ? <span className="bc-n">{camps.length}</span> : null}</button>)}
        <span style={{ flex: 1 }} />
        {canRun && <button type="button" className="btn btn-primary" onClick={() => setImporting(true)}>Import contacts</button>}
        {canRun && <button type="button" className="btn" onClick={() => setSending('')}>Send a requirement to a list</button>}
      </div>
      {settings && !settings.master && <div className="bc-warn">Requirement broadcasts are switched OFF for the company. You can import and prepare, but nothing is sent until an Admin switches them on (Settings).</div>}
      {msg && <div className="bc-ok" role="status">{msg}</div>}
      {err && <div className="bc-err" role="alert">{err}</div>}

      {sub === 'lists' && (
        <>
          {lists === null && <div className="bc-note">Loading…</div>}
          {lists && lists.length === 0 && (
            <div className="bc-box">
              <b>No contact list yet.</b>
              <div className="bc-note" style={{ margin: '4px 0 8px' }}>A company gives you its contacts in Excel. Press "Import contacts", upload the file, check it, save it. Then send the requirement to them on WhatsApp.</div>
              {canRun && <button type="button" className="btn btn-primary" onClick={() => setImporting(true)}>Import contacts</button>}
            </div>
          )}
          {lists && lists.length > 0 && (
            <div className="bc-scroll">
              <table className="bc-table">
                <thead><tr><th>List</th><th>Source</th><th>People</th><th>Permission</th><th>Imported</th><th /></tr></thead>
                <tbody>{lists.map((l) => (
                  <tr key={l.id} style={l.deletedAt ? { opacity: 0.55 } : undefined}>
                    <td><b>{l.name}</b><div className="bc-note">{`Owner ${l.ownerName}`}</div></td>
                    <td>{l.source}</td>
                    <td>{`${sendable(l.totals).toLocaleString('en-IN')} can be messaged`}<div className="bc-note">{`of ${l.totals.total.toLocaleString('en-IN')} rows`}</div></td>
                    <td>{l.consent ? <StatusChip tone="green">Confirmed</StatusChip> : <StatusChip tone="yellow">Not yet</StatusChip>}</td>
                    <td>{when(l.createdAt)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {l.deletedAt ? (canRun && <button type="button" className="btn btn-sm btn-primary" onClick={() => undo(l)}>Bring back</button>) : (
                        <>
                          <button type="button" className="btn btn-sm" onClick={() => setOpen(l.id)}>Open</button>{' '}
                          {canRun && <button type="button" className="btn btn-sm btn-primary" onClick={() => setSending(l.id)}>Send a requirement</button>}{' '}
                          {canRun && <button type="button" className="btn btn-sm" onClick={() => del(l)}>Delete</button>}
                        </>
                      )}
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          <label className="bc-note"><input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} /> Also show deleted lists (they can be brought back for 7 days)</label>
        </>
      )}

      {sub === 'campaigns' && (
        <>
          {camps === null && <div className="bc-note">Loading…</div>}
          {camps && camps.length === 0 && <div className="bc-box bc-note">No requirement has been sent to a list yet. Open "My lists", then "Send a requirement".</div>}
          {camps && camps.length > 0 && (
            <div className="bc-scroll">
              <table className="bc-table">
                <thead><tr><th>Requirement</th><th>List</th><th>Status</th><th>Sent</th><th>Replies</th><th>Started</th><th /></tr></thead>
                <tbody>{camps.map((c) => (
                  <tr key={c.id}>
                    <td><b>{c.jobTitle}</b><div className="bc-note">{c.jobCode}</div></td>
                    <td>{c.listName}</td>
                    <td><StatusChip tone={CAMP_TONE[c.status]}>{CAMP_WORDS[c.status]}</StatusChip>{c.note && <div className="bc-note">{c.note}</div>}</td>
                    <td>{`${c.sent} of ${c.total}`}{c.failed ? <div className="bc-note">{`${c.failed} failed`}</div> : null}</td>
                    <td>{c.replies}</td>
                    <td>{when(c.createdAt)}<div className="bc-note">{c.createdByName}</div></td>
                    <td><button type="button" className="btn btn-sm btn-primary" onClick={() => setResults(c.id)}>See results</button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          {source && source.length > 0 && (
            <div className="bc-note" style={{ marginTop: 10 }}>
              {`Candidates who came from these broadcasts: ${source.map((s) => `${s.source.replace('WhatsApp campaign: ', '')} ${s.people}`).join(', ')}. (They also show in the Sources tab as "Other", with the exact words kept.)`}
            </div>
          )}
        </>
      )}

      {sub === 'settings' && settings && (
        <div className="bc-box">
          <div className="bc-row" style={{ marginTop: 0 }}>
            <b style={{ minWidth: 220 }}>Requirement broadcasts</b>
            <StatusChip tone={settings.master ? 'green' : 'grey'}>{settings.master ? 'ON' : 'OFF'}</StatusChip>
            {isAdminUser && <button type="button" className="btn btn-sm btn-primary" onClick={() => saveSettings({ master: !settings.master })}>{settings.master ? 'Switch OFF' : 'Switch ON'}</button>}
            <span className="bc-note">Nothing is sent to a contact list while this is OFF. It starts OFF.</span>
          </div>
          <div className="bc-row">
            <b style={{ minWidth: 220 }}>Automatic reply to "YES"</b>
            <StatusChip tone={settings.autoReply.on ? 'green' : 'grey'}>{settings.autoReply.on ? 'ON' : 'OFF'}</StatusChip>
            {isAdminUser && <button type="button" className="btn btn-sm" onClick={() => saveSettings({ autoReply: { on: !settings.autoReply.on, text: settings.autoReply.text } })}>{settings.autoReply.on ? 'Switch OFF' : 'Switch ON'}</button>}
          </div>
          <textarea className="bc-text short" style={{ minHeight: 70 }} disabled={!isAdminUser} value={settings.autoReply.text} onChange={(e) => setSettings({ ...settings, autoReply: { ...settings.autoReply, text: e.target.value } })} aria-label="Automatic reply text" />
          {isAdminUser && <button type="button" className="btn btn-sm" onClick={() => saveSettings({ autoReply: settings.autoReply })}>Save this text</button>}
          <div className="bc-note" style={{ marginTop: 6 }}>It is sent once per person, only after they say yes, and never after STOP. On the official WhatsApp API it only works within 24 hours of their reply.</div>
          <div className="bc-note">{`Quiet hours: nothing is sent between ${settings.quiet.from}:00 and ${settings.quiet.to}:00.`}</div>
          <div className="bc-row">
            <b style={{ minWidth: 220 }}>Show the old "Add as candidate" button</b>
            <StatusChip tone={settings.showAddAsCandidate ? 'yellow' : 'grey'}>{settings.showAddAsCandidate ? 'Shown' : 'Hidden'}</StatusChip>
            {isAdminUser && <button type="button" className="btn btn-sm" onClick={() => saveSettings({ showAddAsCandidate: !settings.showAddAsCandidate })}>{settings.showAddAsCandidate ? 'Hide it' : 'Show it'}</button>}
            <span className="bc-note">Hidden by default: Omni-Channel never turns a reply into an ATS candidate by itself.</span>
          </div>
        </div>
      )}

      {importing && <ImportContacts onClose={() => setImporting(false)} onSaved={() => { loadLists(); }} />}
      {open && <ListDetail id={open} canRun={canRun} masked={masked} onClose={() => { setOpen(null); loadLists(); }} onSend={(lid) => { setOpen(null); setSending(lid); }} />}
      {sending !== null && <CampaignDialog listId={sending || ''} onClose={() => setSending(null)} onStarted={(c) => { setSending(null); setSub('campaigns'); loadCamps(); loadLists(); setResults(c.id); }} />}
      {results && <CampaignResults id={results} canRun={canRun} onClose={closeResults} onChanged={loadCamps} />}
      <span style={{ display: 'none' }}>{user ? '' : ''}</span>
    </div>
  );
}
