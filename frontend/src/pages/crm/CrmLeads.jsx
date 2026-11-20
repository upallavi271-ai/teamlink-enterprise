// CRM > LEADS (2026-11-02): every lead (company, contact, source, rating, status, owner, last touched, next follow-up),
// search and filters; + Lead (duplicate check against the CRM's leads, accounts and contacts); Import from Excel /
// CSV (preview first, duplicates skipped with the reason); tick leads to give them to a BDE (BDE TL / Admin) or set their
// status / rating together; Download as CSV. A row opens the lead with its timeline, follow-ups and "Convert to deal".
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { useCrm, errOf, dateOf, istToday, Pill, DateField, QuickLog, RecordForm, download } from './crmShared.jsx';
import MultiSelect from '../../components/ats/MultiSelect.jsx'; // checkboxes: several values per filter (founder 2026-11-20)
import CrmCampaigns from './CrmCampaigns.jsx';
import { ListFilterStrip, useListXf } from '../../components/ats/ListFilters.jsx';
import CrmLeadBoard from './CrmLeadBoard.jsx';
import { ProductCatalog } from './CrmProducts.jsx';

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
  const [view, setView] = useState(['campaigns', 'products'].includes(sp.get('tab')) ? sp.get('tab') : 'leads');
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
  // the table is paged and sorted on the server (50 a page, with the total); the board still reads every lead at once
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('updated');
  const [dir, setDir] = useState('desc');
  const [paging, setPaging] = useState(null); // { total, page, pages }
  const xf = useListXf('crmleads'); // added-on date range, city, industry (components/ats/ListFilters.jsx)
  const seq = useRef(0);
  const load = () => { seq.current += 1; const mine = seq.current; return api.get('/crm/leads', { params: { q: q || undefined, status: (layout === 'board' ? 'all' : status) || undefined, stage: stage || undefined, from: from || undefined, to: to || undefined, source: source || undefined, rating: rating || undefined, owner: owner || undefined, ...xf.params, ...(layout === 'table' ? { page, pageSize: 50, sort, dir } : {}) } })
    .then((r) => { if (mine !== seq.current) return; setRows(r.data.rows); setPaging(layout === 'table' && r.data.total != null ? { total: r.data.total, page: r.data.page, pages: r.data.pages } : null); setErr(''); setPicked(new Set()); }).catch((e) => { if (mine === seq.current) setErr(errOf(e, 'The leads could not be read.')); }); };
  // a changed filter or sort goes back to page 1 first (and loads from there)
  const fkey = JSON.stringify([q, status, stage, from, to, layout, source, rating, owner, sort, dir, xf.key]);
  const lastKey = useRef(fkey);
  useEffect(() => {
    if (lastKey.current !== fkey) { lastKey.current = fkey; if (page !== 1) { setPage(1); return undefined; } }
    const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t);
  }, [fkey, version, page]); // eslint-disable-line react-hooks/exhaustive-deps
  const sortBy = (k) => { if (sort === k) setDir(dir === 'asc' ? 'desc' : 'asc'); else { setSort(k); setDir(['company', 'owner', 'stage', 'next'].includes(k) ? 'asc' : 'desc'); } };
  const Th = ({ k, children }) => <th aria-sort={sort === k ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}><button type="button" className="crm-sort" onClick={() => sortBy(k)} title="Sort">{children}{sort === k ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>;
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
          {me.rights && me.rights.export && <button type="button" className="btn" onClick={() => download(`/crm/export/leads?${new URLSearchParams(Object.entries({ q, status, stage, from, to, source, rating, owner, ...xf.params }).filter(([, v]) => v))}`, `crm-leads-${today}.csv`).catch(() => toast('The download did not work.'))}>Download</button>}
          {me.rights && me.rights.import && <button type="button" className="btn" onClick={() => setImporting(true)}>Import Excel</button>}
          {me.canCreate && <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>+ Lead</button>}
        </div>
      </div>
      <div className="tabs" role="tablist">
        {[['leads', 'Leads'], ['campaigns', 'Campaigns'], ['products', 'Our products']].map(([k, l]) => <div key={k} role="tab" tabIndex={0} aria-selected={view === k} className={`tab${view === k ? ' active' : ''}`} onClick={() => setView(k)} onKeyDown={(e) => { if (e.key === 'Enter') setView(k); }}>{l}</div>)}
      </div>
      {view === 'campaigns' && <CrmCampaigns />}
      {view === 'products' && <ProductCatalog />}
      {view === 'leads' && (<>
      <ListFilterStrip list="crmleads" xf={xf} total={paging ? paging.total : null} noun="leads" allTime={Object.keys(xf.values).length > 0 || !!(q || stage || from || to || source || rating || owner)} />
      <div className="filter-row">
        <input type="text" placeholder="Search company, person, phone, email, city" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 260 }} aria-label="Search leads" />
        <MultiSelect label="Status" allLabel="Open leads" value={status} onChange={setStatus} options={me.lists.leadStatuses.map((s) => ({ value: s, label: s }))} />
        <MultiSelect label="Stage" allLabel="Any stage" value={stage} onChange={setStage} options={me.lists.leadStages.map((s) => ({ value: s.name, label: s.name }))} />
        <DateField value={from} onChange={setFrom} aria-label="Added from" style={{ width: 145 }} />
        <DateField value={to} onChange={setTo} aria-label="Added to" style={{ width: 145 }} />
        <MultiSelect label="Rating" allLabel="Any rating" value={rating} onChange={setRating} options={me.lists.ratings.map((s) => ({ value: s, label: s }))} />
        <MultiSelect label="Source" allLabel="Any source" value={source} onChange={setSource} options={me.lists.sources.map((s) => ({ value: s, label: s }))} />
        {me.seesAll && <MultiSelect label="Owner" allLabel="Everyone" value={owner} onChange={setOwner} options={me.owners.map((o) => ({ value: o.id, label: o.name }))} />}
      </div>
      {err && <div className="notice" role="alert">{err}</div>}
      {rows && (
        <div className="results-bar">
          <span>{paging ? `${paging.total.toLocaleString('en-IN')} lead${paging.total === 1 ? '' : 's'}${paging.pages > 1 ? ` · page ${paging.page} of ${paging.pages}` : ''}` : `${rows.length} lead${rows.length === 1 ? '' : 's'}`}</span>
          <span style={{ display: 'flex', gap: 4 }}>
            <button type="button" className={`btn btn-sm${layout === 'table' ? ' btn-primary' : ''}`} onClick={() => setLayout('table')}>Table</button>
            <button type="button" className={`btn btn-sm${layout === 'board' ? ' btn-primary' : ''}`} onClick={() => setLayout('board')}>Board</button>
          </span>
          {me.canEdit && picked.size > 0 && (
            <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <b>{picked.size} ticked:</b>
              {me.canAssign && <select defaultValue="" onChange={(e) => { if (e.target.value) bulk({ ownerId: e.target.value }); e.target.value = ''; }} aria-label="Give to"><option value="">Give to…</option>{me.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
              <button type="button" className="btn btn-sm" onClick={() => bulk({ status: 'Junk' })} title="Stages move on their own; the one thing set by hand is Junk">Mark junk</button>
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
              <Th k="company">Company</Th><th>Contact</th><th>Source</th><th>Rating</th><Th k="stage">Stage</Th><Th k="value">Value</Th><Th k="created">Added</Th><Th k="touched">Last touched</Th><Th k="next">Next follow-up</Th>{me.seesAll && <Th k="owner">Owner</Th>}{me.canEdit && <th />}
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
      {layout === 'table' && paging && paging.pages > 1 && (
        <div className="crm-pager">
          <button type="button" className="btn btn-sm" disabled={paging.page <= 1} onClick={() => setPage(1)}>« First</button>
          <button type="button" className="btn btn-sm" disabled={paging.page <= 1} onClick={() => setPage(paging.page - 1)}>‹ Before</button>
          <span>Page {paging.page} of {paging.pages}</span>
          <button type="button" className="btn btn-sm" disabled={paging.page >= paging.pages} onClick={() => setPage(paging.page + 1)}>Next ›</button>
          <button type="button" className="btn btn-sm" disabled={paging.page >= paging.pages} onClick={() => setPage(paging.pages)}>Last »</button>
        </div>
      )}
      </>)}
      {adding && <RecordForm kind="lead" preset={{ source: '' }} onClose={() => setAdding(false)} onSaved={(row) => { setAdding(false); load(); setOpen({ kind: 'lead', id: row.id }); }} />}
      {importing && <ImportLeads onClose={() => setImporting(false)} onDone={() => { setImporting(false); load(); }} />}
      {logging && <QuickLog record={logging} onClose={() => setLogging(null)} onLogged={() => { setLogging(null); load(); }} />}
    </div>
  );
}
