import { useCallback, useEffect, useRef, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { Btn, DataTable, Pill, fmtDate } from '../ui.jsx';

// The prototype's CRM Contact Selector: your Omni-Channel contacts in a table (search, Columns chooser, pages), tick the people, "Use selected contacts".
// Only people who AGREED to the chosen way can be ticked; by default only they are listed.
export default function CrmSelector({ channel, word, type, types, selected, onClose, onUse, go, toast }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [q, setQ] = useState('');
  const [onlyAgreed, setOnlyAgreed] = useState(true);
  const [kind, setKind] = useState(type);
  const [sel, setSel] = useState(() => new Set(selected || []));
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [masked, setMasked] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current; // eslint-disable-line no-plusplus
    setLoading(true);
    try {
      const d = await omni.get('/gs/console/contacts', { channel, q, type: kind, agreed: onlyAgreed ? 'yes' : 'no', page, pageSize });
      if (my !== seq.current) return;
      setRows(d.rows); setTotal(d.total); setMasked(!!d.masked); setErr('');
    } catch (e) { if (my === seq.current) setErr(errOf(e, 'The contacts could not be loaded.')); } finally { if (my === seq.current) setLoading(false); }
  }, [channel, q, kind, onlyAgreed, page, pageSize]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const pageIds = rows.filter((r) => r.agreed).map((r) => r.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => sel.has(id));
  const togglePage = () => setSel((s) => { const n = new Set(s); if (allOnPage) pageIds.forEach((id) => n.delete(id)); else pageIds.forEach((id) => n.add(id)); return n; });
  const selectAll = async () => {
    try { const d = await omni.get('/gs/console/contact-ids', { channel, q, type: kind }); setSel((s) => new Set([...s, ...d.ids])); toast(`${d.ids.length} people who agreed are selected`); } catch (e) { toast(errOf(e, 'Could not select them all.')); }
  };
  const use = () => { if (!sel.size) { toast('Select at least one contact first'); return; } onUse([...sel], kind); };

  const columns = [
    { id: 'pick', label: 'Pick', render: (r) => <input type="checkbox" aria-label={`Select ${r.name || 'this person'}`} checked={sel.has(r.id)} disabled={!r.agreed} onChange={() => toggle(r.id)} /> },
    { id: 'name', label: 'Customer Name', render: (r) => <b style={{ overflowWrap: 'anywhere' }}>{r.name || '—'}</b> },
    { id: 'phone', label: 'Phone Number', render: (r) => r.phone || <span className="crm-empty">Empty</span> },
    { id: 'source', label: 'Source', render: (r) => (r.source ? <Pill tone="live">{r.source}</Pill> : <span className="crm-empty">Empty</span>) },
    { id: 'kind', label: 'Kind', render: (r) => ((r.industries || []).length ? r.industries.join(', ') : <span className="crm-empty">Empty</span>) },
    { id: 'email', label: 'Email Address', render: (r) => r.email || <span className="crm-empty">Empty</span> },
    { id: 'created', label: 'Created On', render: (r) => fmtDate(r.createdAt) },
    { id: 'state', label: `Agreed to ${word}`, render: (r) => <Pill tone={r.agreed ? 'live' : (r.state === 'Asked us to stop' ? 'red' : 'warn')}>{r.state}</Pill> },
  ];

  return (
    <div className="modal-bg show">
      <div className="modal" role="dialog" aria-modal="true" aria-label="CRM Contact Selector" style={{ width: 'min(1080px,96vw)' }}>
        <div className="modal-head"><div><b>👥 CRM Contact Selector</b><p>Customers: manage leads and view captured data. Only people who agreed to {word} can be picked.</p></div><button type="button" className="close" onClick={onClose} aria-label="Close">×</button></div>
        <div className="modal-body" style={{ maxHeight: '70vh' }}>
          <div className="con-sel-bar">
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}><input type="checkbox" checked={onlyAgreed} onChange={(e) => { setOnlyAgreed(e.target.checked); setPage(1); }} /> Only people who agreed to {word}</label>
            {types && types.length > 1 && (
              <select className="select" aria-label="Kind of contact" value={kind} onChange={(e) => { setKind(e.target.value); setPage(1); setSel(new Set()); }}>
                <option value="candidate_lead">Candidate contacts</option><option value="internal">Staff contacts</option>
              </select>
            )}
            <Btn small onClick={() => { setSel(new Set()); setQ(''); setPage(1); load(); toast('Contacts refreshed — filters and sorting reset'); }}>↻ Refresh</Btn>
            <Btn small onClick={togglePage}>{allOnPage ? 'Unselect this page' : 'Select this page'}</Btn>
            <Btn small onClick={selectAll}>Select all who agreed</Btn>
            <span><b>{sel.size}</b> selected</span>
            <button type="button" className="con-link" onClick={() => { onClose(); go('customers'); }}>Add or import people in All Customers →</button>
          </div>
          {masked && <p style={{ fontSize: 9, color: 'var(--muted)', margin: '0 0 8px' }}>Phone numbers and email addresses are hidden for your login.</p>}
          {err && <div className="con-err" style={{ margin: '0 0 8px' }}>{err}</div>}
          <DataTable
            columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} persistKey="console_crm" pageSizes={[20, 50, 100]}
            searchPlaceholder="Search by name, company or city…" empty="No contacts match your search."
            server={{ total, page, pageSize, onPage: setPage, onPageSize: (n) => { setPageSize(n); setPage(1); }, onQuery: (v) => { setQ(v); setPage(1); }, query: q }}
          />
        </div>
        <div className="modal-foot"><Btn onClick={onClose}>Cancel</Btn><Btn primary onClick={use}>Use selected contacts</Btn></div>
      </div>
    </div>
  );
}
