// CRM > LEADS (2026-11-02): every lead (company, contact, source, rating, status, owner, last touched, next follow-up),
// search and filters; + Lead (duplicate check against the CRM's leads, accounts and contacts); Import from Excel /
// CSV (preview first, duplicates skipped with the reason); tick leads to give them to a BDE (BDE TL / Admin) or set their
// status / rating together; Download as CSV. A row opens the lead with its timeline, follow-ups and "Convert to deal".
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { useCrm, errOf, dateOf, istToday, Pill, DateField, QuickLog, RecordForm, download } from './crmShared.jsx';
import CrmCampaigns from './CrmCampaigns.jsx';
import CrmLeadBoard from './CrmLeadBoard.jsx';

function ImportLeads({ onClose, onDone }) {
  const { me, toast } = useCrm();
  const [file, setFile] = useState(null);
  const [ownerId, setOwnerId] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [map, setMap] = useState(null); // { field: heading } the person chose; null = the file's own headings, read automatically
  const [headings, setHeadings] = useState(null);
  const [detected, setDetected] = useState(null); // which heading is read as which field right now
  const send = (dryRun, m = map) => api.post('/crm/leads/import', file, { params: { name: file.name, ownerId: ownerId || undefined, dryRun: dryRun ? 1 : undefined, map: m ? JSON.stringify(m) : undefined }, headers: { 'Content-Type': 'application/octet-stream' } });
  async function check(m = map) {
    setBusy(true); setErr(''); setPreview(null);
    try { const d = (await send(true, m)).data; setPreview(d); setHeadings(d.headings || null); setDetected(d.columns || null); } catch (e) {
      setErr(errOf(e, 'The file could not be read.'));
      if (e.response && e.response.data && e.response.data.headings) { setHeadings(e.response.data.headings); setDetected(e.response.data.columns || null); } // no company column found: let the person pick it
    } finally { setBusy(false); }
  }
  const pick = (field, heading) => { const m = { ...(map || {}), [field]: heading }; setMap(m); check(m); };
  const skippedCsv = () => {
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const text = `\ufeff${['Row,Company,Why it was left out', ...preview.skipped.map((s) => [s.row, s.company, s.reason].map(esc).join(','))].join('\r\n')}`;
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })); a.download = 'leads-not-imported.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  async function go() {
    setBusy(true); setErr('');
    try { const r = await send(false); toast(`${r.data.created} lead(s) added${r.data.skipped.length ? `, ${r.data.skipped.length} skipped` : ''}.`); onDone(); } catch (e) { setErr(errOf(e, 'The leads could not be imported.')); } finally { setBusy(false); }
  }
  return (
    <Modal
      title="Import leads from Excel / CSV"
      size="wide"
      onClose={onClose}
      foot={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          {!preview && <button type="button" className="btn btn-primary" disabled={!file || busy} onClick={() => check()}>{busy ? 'Reading…' : 'Check the file'}</button>}
          {preview && <button type="button" className="btn btn-primary" disabled={busy || !preview.ready} onClick={go}>{busy ? 'Importing…' : `Import ${preview.ready} lead${preview.ready === 1 ? '' : 's'}`}</button>}
        </>
      )}
    >
      <p className="small-muted" style={{ marginTop: 0 }}>The first sheet, one lead per row. Headings it understands: <b>Company</b> (needed), Contact person, Designation, Phone / Mobile, Email, Industry, City, Source, Rating (Hot / Warm / Cold), Notes. A company, phone or email already in TeamLink is skipped and you see why. At most 2000 rows.</p>
      <div className="grid-2">
        <div className="field"><label>File</label><input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => { setFile(e.target.files[0] || null); setPreview(null); setErr(''); setMap(null); setHeadings(null); setDetected(null); }} /></div>
        {me.canAssign && (
          <div className="field">
            <label>Give the leads to</label>
            <select value={ownerId} onChange={(e) => { setOwnerId(e.target.value); setPreview(null); }}><option value="">Me</option>{me.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
          </div>
        )}
      </div>
      {err && <div className="notice" role="alert" style={{ color: 'var(--red)' }}>{err}</div>}
      {headings && (
        <div className="card" style={{ padding: 12, marginBottom: 10 }}>
          <div style={{ fontSize: 13, marginBottom: 6 }}><b>Which column is which?</b> <span className="small-muted">It is read from the headings; change a column here if it picked wrong or found none.</span></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 8 }}>
            {[['company', 'Company *'], ['contactName', 'Contact person'], ['phone', 'Phone / Mobile'], ['email', 'Email'], ['designation', 'Designation'], ['industry', 'Industry'], ['city', 'City'], ['source', 'Source'], ['rating', 'Rating'], ['notes', 'Notes']].map(([f, label]) => (
              <div key={f} className="field" style={{ margin: 0 }}>
                <label style={{ fontSize: 12 }}>{label}</label>
                <select value={(detected && detected[f]) || ''} disabled={busy} onChange={(e) => pick(f, e.target.value)} aria-label={`Column for ${label}`}>
                  <option value="">— not in this file —</option>
                  {headings.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}
      {preview && (
        <div className="card" style={{ padding: 12 }}>
          <div style={{ fontSize: 13, marginBottom: 6 }}><b>{preview.rows}</b> rows read · <b style={{ color: 'var(--teal)' }}>{preview.ready} ready</b> · {preview.skipped.length} skipped · owner {preview.owner}</div>
          <div className="small-muted" style={{ fontSize: 11.5, marginBottom: 6 }}>Columns found: {Object.entries(preview.columns).map(([k, v]) => `${v} → ${k}`).join(', ')}</div>
          {preview.skipped.length > 0 && <div style={{ marginBottom: 6 }}><button type="button" className="btn btn-sm" onClick={skippedCsv}>Download the {preview.skipped.length} left-out row{preview.skipped.length === 1 ? '' : 's'} (CSV)</button> <span className="small-muted" style={{ fontSize: 11.5 }}>duplicates say whose lead it already is, so nobody calls the same person twice</span></div>}
          {preview.skipped.length > 0 && (
            <div style={{ maxHeight: 200, overflow: 'auto', fontSize: 12.5 }}>
              {preview.skipped.slice(0, 200).map((s) => <div key={`${s.row}${s.reason}`} style={{ padding: '2px 0' }}>Row {s.row}{s.company ? ` · ${s.company}` : ''}: <span className="small-muted">{s.reason}</span></div>)}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export default function CrmLeads() {
  const { me, toast, openRecord, version } = useCrm();
  const [sp, setSp] = useSearchParams();
  const setOpen = (o) => openRecord(o.kind, o.id);
  const [view, setView] = useState(sp.get('tab') === 'campaigns' ? 'campaigns' : 'leads');
  const [adding, setAdding] = useState(sp.get('add') === '1');
  const [importing, setImporting] = useState(false);
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [rating, setRating] = useState('');
  const [owner, setOwner] = useState('');
  const [stage, setStage] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [layout, setLayout] = useState('table'); // table | board (the board shows won and lost leads too)
  const [picked, setPicked] = useState(() => new Set());
  const [logging, setLogging] = useState(null); // 📞 Log on a row
  const load = () => api.get('/crm/leads', { params: { q: q || undefined, status: (layout === 'board' ? 'all' : status) || undefined, stage: stage || undefined, from: from || undefined, to: to || undefined, source: source || undefined, rating: rating || undefined, owner: owner || undefined } })
    .then((r) => { setRows(r.data.rows); setErr(''); setPicked(new Set()); }).catch((e) => setErr(errOf(e, 'The leads could not be read.')));
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [q, status, stage, from, to, layout, source, rating, owner, version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (sp.get('add') === '1') { const n = new URLSearchParams(sp); n.delete('add'); setSp(n, { replace: true }); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const today = istToday();
  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allPicked = rows && rows.length > 0 && rows.every((l) => picked.has(l.id));
  async function bulk(change) {
    try {
      const r = await api.post('/crm/leads/bulk', { ids: [...picked], ...change });
      const sk = r.data.skipped || [];
      const why = [...new Set(sk.map((s) => s.reason))];
      // say WHY some were left out: a lead with nothing logged cannot be marked Contacted / Qualified (log a call on it first, from its row)
      toast(`${r.data.changed} lead(s) changed${sk.length ? `, ${sk.length} skipped: ${why.join('; ')}${why.includes('nothing logged on it yet') ? ' - press 📞 Log on each of those first' : ''}` : ''}.`);
      load();
    } catch (e) { toast(errOf(e, 'The leads could not be changed.')); }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Leads</h1><div className="page-sub">Companies to sell to, before they become a deal · campaigns to reach many at once</div></div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {me.rights && me.rights.export && <button type="button" className="btn" onClick={() => download('/crm/export/leads', `crm-leads-${today}.csv`).catch(() => toast('The download did not work.'))}>Download</button>}
          {me.rights && me.rights.import && <button type="button" className="btn" onClick={() => setImporting(true)}>Import Excel</button>}
          {me.canCreate && <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>+ Lead</button>}
        </div>
      </div>
      <div className="tabs" role="tablist">
        {[['leads', 'Leads'], ['campaigns', 'Campaigns']].map(([k, l]) => <div key={k} role="tab" tabIndex={0} aria-selected={view === k} className={`tab${view === k ? ' active' : ''}`} onClick={() => setView(k)} onKeyDown={(e) => { if (e.key === 'Enter') setView(k); }}>{l}</div>)}
      </div>
      {view === 'campaigns' && <CrmCampaigns />}
      {view === 'leads' && (<>
      <div className="filter-row">
        <input type="text" placeholder="Search company, person, phone, email, city" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 260 }} aria-label="Search leads" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Open leads</option>
          {me.lists.leadStatuses.map((s) => <option key={s} value={s}>{s}</option>)}
          <option value="all">All leads</option>
        </select>
        <select value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Stage"><option value="">Any stage</option>{me.lists.leadStages.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}</select>
        <DateField value={from} onChange={setFrom} aria-label="Added from" style={{ width: 145 }} />
        <DateField value={to} onChange={setTo} aria-label="Added to" style={{ width: 145 }} />
        <select value={rating} onChange={(e) => setRating(e.target.value)} aria-label="Rating"><option value="">Any rating</option>{me.lists.ratings.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source"><option value="">Any source</option>{me.lists.sources.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        {me.seesAll && <select value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Owner"><option value="">Everyone</option>{me.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
      </div>
      {err && <div className="notice" role="alert">{err}</div>}
      {rows && (
        <div className="results-bar">
          <span>{rows.length} lead{rows.length === 1 ? '' : 's'}</span>
          <span style={{ display: 'flex', gap: 4 }}>
            <button type="button" className={`btn btn-sm${layout === 'table' ? ' btn-primary' : ''}`} onClick={() => setLayout('table')}>Table</button>
            <button type="button" className={`btn btn-sm${layout === 'board' ? ' btn-primary' : ''}`} onClick={() => setLayout('board')}>Board</button>
          </span>
          {me.canEdit && picked.size > 0 && (
            <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <b>{picked.size} ticked:</b>
              {me.canAssign && <select defaultValue="" onChange={(e) => { if (e.target.value) bulk({ ownerId: e.target.value }); e.target.value = ''; }} aria-label="Give to"><option value="">Give to…</option>{me.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
              <select defaultValue="" onChange={(e) => { if (e.target.value) bulk({ status: e.target.value }); e.target.value = ''; }} aria-label="Set status"><option value="">Set status…</option>{['New', 'Contacted', 'Qualified', 'Junk'].map((s) => <option key={s} value={s}>{s}</option>)}</select>
              <select defaultValue="" onChange={(e) => { if (e.target.value) bulk({ rating: e.target.value }); e.target.value = ''; }} aria-label="Set rating"><option value="">Set rating…</option>{me.lists.ratings.map((s) => <option key={s} value={s}>{s}</option>)}</select>
              <button type="button" className="btn btn-sm" onClick={() => setPicked(new Set())}>Clear</button>
            </span>
          )}
        </div>
      )}
      {layout === 'board' && rows && <CrmLeadBoard rows={rows} onMoved={load} />}
      {layout === 'table' && <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              {me.canEdit && <th style={{ width: 28 }}><input type="checkbox" aria-label="Tick all" checked={!!allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set((rows || []).map((l) => l.id)))} style={{ width: 'auto' }} /></th>}
              <th>Company</th><th>Contact</th><th>Source</th><th>Rating</th><th>Stage</th><th>Value</th><th>Added</th><th>Last touched</th><th>Next follow-up</th>{me.seesAll && <th>Owner</th>}{me.canEdit && <th />}
            </tr>
          </thead>
          <tbody>
            {rows == null && <tr><td colSpan={12} className="small-muted">Loading…</td></tr>}
            {rows && !rows.length && <tr><td colSpan={12}><div className="empty"><h3>No leads here</h3>{me.canEdit ? 'Add a lead with "+ Lead", or bring many in with "Import Excel".' : 'Nothing matches.'}</div></td></tr>}
            {(rows || []).map((l) => (
              <tr key={l.id} className="row-link" onClick={() => setOpen({ kind: 'lead', id: l.id })}>
                {me.canEdit && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Tick ${l.company}`} checked={picked.has(l.id)} onChange={() => toggle(l.id)} style={{ width: 'auto' }} /></td>}
                <td><b>{l.company}</b><div className="small-muted" style={{ fontSize: 11.5 }}>{[l.industry, l.city].filter(Boolean).join(' · ')}</div></td>
                <td>{l.contactName || '—'}<div className="small-muted" style={{ fontSize: 11.5 }}>{[l.designation, l.phone].filter(Boolean).join(' · ')}</div></td>
                <td>{l.source || '—'}</td>
                <td><Pill v={l.rating} /></td>
                <td><Pill v={l.stage} /></td>
                <td>{l.expectedValue ? `₹${Number(l.expectedValue).toLocaleString('en-IN')}` : '—'}</td>
                <td className="small-muted">{dateOf(l.createdAt)}</td>
                <td className="small-muted">{l.lastActivityAt ? dateOf(l.lastActivityAt) : 'Never'}</td>
                <td style={{ color: l.nextTaskDue && l.nextTaskDue < today ? 'var(--red)' : undefined, fontWeight: l.nextTaskDue && l.nextTaskDue <= today ? 600 : undefined }}>{l.nextTaskDue ? (l.nextTaskDue === today ? 'Today' : dateOf(l.nextTaskDue)) : '—'}</td>
                {me.seesAll && <td>{l.ownerName || '—'}</td>}
                {me.canEdit && <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>{l.status !== 'Converted' && <button type="button" className="btn btn-sm" onClick={() => setLogging(l)} aria-label={`Log a call on ${l.company}`} title="Log a call, WhatsApp, email, meeting or note, and set the next follow-up">📞 Log</button>}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
      </>)}
      {adding && <RecordForm kind="lead" preset={{ source: '' }} onClose={() => setAdding(false)} onSaved={(row) => { setAdding(false); load(); setOpen({ kind: 'lead', id: row.id }); }} />}
      {importing && <ImportLeads onClose={() => setImporting(false)} onDone={() => { setImporting(false); load(); }} />}
      {logging && <QuickLog record={logging} onClose={() => setLogging(null)} onLogged={() => { setLogging(null); load(); }} />}
    </div>
  );
}
