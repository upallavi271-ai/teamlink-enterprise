import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Combo from '../../Combo.jsx';
import { Btn, PageHead, Tabs, Banner, GsModal, ConfirmModal, Planned } from '../ui.jsx';
import omni from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import CustomerModal from '../crm/CustomerModal.jsx';
import CustomerDetail from '../crm/CustomerDetail.jsx';
import ImportModal from '../crm/ImportModal.jsx';
import AtsImportModal from '../crm/AtsImportModal.jsx';
import ImportsHistory from '../crm/ImportsHistory.jsx';
import { saveBlob, dayLabel, timeLabel, errText } from '../crm/crmUtil.js';
import '../crm/crm.css';

// ---------------------------------------------------------------------------
// ALL CUSTOMERS (the prototype's "Customers"): one list of our contacts. Real data from /api/outreach/gs/crm/customers (the server applies the role's scope and
// hides phone / email for the BDE team and Recruiters). Search, Manage Columns, a menu on every column header (filter / sort / hide), Refresh, Export Excel (Admin),
// views ("Default" + each Web Form), paging, Add / Edit, a detail box, Import Data (3 steps), Import from ATS (Admin and Team Lead), and an Imports tab.
// ---------------------------------------------------------------------------
const COLS_KEY = 'tl_omni_crm_cols_v1';
const readCols = () => { try { const v = window.localStorage.getItem(COLS_KEY); return v ? JSON.parse(v) : null; } catch { return null; } };
const writeCols = (v) => { try { window.localStorage.setItem(COLS_KEY, JSON.stringify(v)); } catch { /* fine */ } };
const PREF = { whatsapp: 'WhatsApp', email: 'Email', sms: 'SMS', call: 'Call' };
const SRC_TONE = { allowed: 'live', not_asked: 'draft', opted_out: 'red' };
const BASE_VISIBLE = ['name', 'phone', 'source', 'email', 'platformId', 'kinds', 'city', 'language', 'permission', 'cf:lead_stage', 'cf:lead_status', 'owner', 'created'];
const Empty = () => <span className="crm-empty">Empty</span>;

function columnsOf(meta, masked) {
  const cols = [
    { id: 'name', header: 'Customer Name', key: 'core_name' },
    { id: 'phone', header: 'Phone Number', key: 'core_phone_number', noFilter: masked, noSort: masked },
    { id: 'source', header: 'Source', key: 'core_source' },
    { id: 'email', header: 'Email Address', key: 'core_email', noFilter: masked, noSort: masked },
    { id: 'platformId', header: 'Platform ID', key: 'core_platform_id' },
    { id: 'kinds', header: 'Kind', key: 'core_kind' },
    { id: 'city', header: 'City', key: 'core_city' },
    { id: 'company', header: 'Company', key: 'core_company' },
    { id: 'skills', header: 'Skills', key: 'core_skills' },
    { id: 'language', header: 'Language', key: 'core_language' },
    { id: 'preferredChannel', header: 'Preferred Channel', key: 'core_preferred_channel' },
    { id: 'lastReply', header: 'Last Reply', key: 'core_last_reply', noFilter: true },
    { id: 'notes', header: 'Notes', key: 'core_notes', noSort: true },
    { id: 'permission', header: 'Permission', key: 'core_permission', noSort: true },
  ];
  meta.fields.filter((f) => !(masked && ['phone', 'email'].includes(f.type))).forEach((f) => cols.push({ id: `cf:${f.id}`, header: f.name, key: `cf_${f.id}`, field: f, noSort: f.type === 'multi' }));
  cols.push({ id: 'owner', header: 'Owner', key: 'core_owner' }, { id: 'created', header: 'Created On', key: 'core_created', noFilter: true });
  return cols;
}

function HeaderCell({ col, sort, filter, open, onOpen, onClose, onFilter, onSort, onHide, canHide }) {
  const [draft, setDraft] = useState(filter || '');
  useEffect(() => { if (open) setDraft(filter || ''); }, [open, filter]);
  return (
    <th style={{ position: 'relative' }}>
      <span className="col-head-btn" role="button" tabIndex={0} aria-haspopup="true" onClick={(e) => { e.stopPropagation(); onOpen(); }} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}>
        {col.header}<span className="dots">⋮</span>
        {sort && <span style={{ fontSize: 9 }}>{sort === 'asc' ? '▲' : '▼'}</span>}
        {filter && <span className="col-filtered">●</span>}
      </span>
      {open && (
        <div className="menu show" style={{ width: 210, left: 0, top: '100%', zIndex: 30 }} onClick={(e) => e.stopPropagation()}>
          {!col.noFilter && (
            <>
              <div className="menu-label">Filter</div>
              <div style={{ padding: '0 10px 9px' }}>
                <input className="col-filter-input" autoFocus placeholder="Contains…" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onFilter(col, draft.trim()); } if (e.key === 'Escape') onClose(); }} />
                <button type="button" className="col-filter-apply" onClick={() => onFilter(col, draft.trim())}>Apply Filter</button>
                {filter && <button type="button" className="col-filter-clear" onClick={() => onFilter(col, '')}>Clear filter</button>}
              </div>
            </>
          )}
          {col.noFilter && <div className="menu-label">{col.id === 'phone' || col.id === 'email' ? 'Hidden for your login' : 'No filter here'}</div>}
          {!col.noSort && <><button type="button" onClick={() => onSort(col, 'asc')}>⇡ Sort Ascending</button><button type="button" onClick={() => onSort(col, 'desc')}>⇣ Sort Descending</button></>}
          {canHide && <button type="button" onClick={() => onHide(col)}>🚫 Hide this column</button>}
        </div>
      )}
    </th>
  );
}

export default function CustomersPage() {
  const { acc, go, toast, dept } = useOmni();
  const startForm = useMemo(() => { try { return new URLSearchParams(window.location.search).get('form') || ''; } catch { return ''; } }, []);
  const [type, setType] = useState(acc && !acc.canPromo && acc.canInternal ? 'internal' : 'candidate_lead');
  const [tab, setTab] = useState('customers'); // customers | imports
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sort, setSort] = useState(null); // { id, dir }
  const [filters, setFilters] = useState({});
  const [form, setForm] = useState(startForm);
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [visible, setVisible] = useState(() => readCols() || BASE_VISIBLE);
  const [menu, setMenu] = useState(null); // 'cols' | 'views' | 'h:<colId>'
  const [colQ, setColQ] = useState('');
  const [refreshedAt, setRefreshedAt] = useState(null);
  const [sel, setSel] = useState(() => new Set());
  const [flashId, setFlashId] = useState(null);
  const [modal, setModal] = useState(null); // { kind: 'add' | 'edit' | 'detail' | 'import' | 'ats' | 'sheets' | 'erase', ... }
  const seq = useRef(0);
  const masked = !!(data ? data.masked : (acc && acc.masked));

  useEffect(() => { const t = setTimeout(() => { setDq(q); setPage(1); }, q ? 250 : 0); return () => clearTimeout(t); }, [q]);
  const load = useCallback(() => {
    const n = seq.current + 1; seq.current = n;
    setLoading(true);
    return omni.get('/gs/crm/customers', { type, q: dq || undefined, page, pageSize, sort: sort ? sort.id : undefined, dir: sort ? sort.dir : undefined, filters: Object.keys(filters).length ? JSON.stringify(filters) : undefined, form: form || undefined })
      .then((r) => { if (seq.current !== n) return r; setData(r); setMeta(r.meta); setErr(''); if (r.page !== page) setPage(r.page); return r; })
      .catch((e) => { if (seq.current === n) { setErr(errText(e, 'The customers could not be loaded.')); setData((d) => d || { contacts: [], total: 0, masked: true, meta: null }); } })
      .finally(() => { if (seq.current === n) setLoading(false); });
  }, [type, dq, page, pageSize, sort, filters, form]);
  useEffect(() => { if (tab === 'customers') load(); }, [load, tab]);
  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  const allCols = useMemo(() => (meta ? columnsOf(meta, masked) : []), [meta, masked]);
  const cols = allCols.filter((c) => visible.includes(c.id));
  const total = data ? data.total : 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const canWrite = !!(data && data.canWrite);
  const setVis = (v) => { const next = v.length ? v : ['name']; setVisible(next); writeCols(next); };
  const resetView = () => { setPage(1); };

  const onFilter = (col, v) => {
    setFilters((f) => { const n = { ...f }; if (v) n[col.id] = v; else delete n[col.id]; return n; });
    setPage(1); setMenu(null);
    toast(v ? `Filtered: ${col.key} contains "${v}"` : 'Filter cleared');
  };
  const onSort = (col, dir) => { setSort({ id: col.id, dir }); setPage(1); setMenu(null); toast(`Sorted by ${col.header} (${dir})`); };
  const onHide = (col) => { setVis(visible.filter((x) => x !== col.id)); setMenu(null); toast('Column hidden — restore it from Manage Columns'); };
  const refresh = async () => { setSel(new Set()); const r = await load(); setRefreshedAt(new Date()); toast(`Refreshed — ${(r && r.total) != null ? r.total : total} customers`); };
  const switchType = (t) => { setType(t); setPage(1); setForm(''); setFilters({}); setSort(null); setQ(''); setSel(new Set()); };
  const exportXlsx = async () => {
    try {
      const blob = await omni.blob('/gs/crm/customers/export', { type, q: dq || undefined, filters: Object.keys(filters).length ? JSON.stringify(filters) : undefined, form: form || undefined, sort: sort ? sort.id : undefined, dir: sort ? sort.dir : undefined, cols: visible.join(',') });
      const name = `customers-${new Date().toISOString().slice(0, 10)}.xlsx`;
      saveBlob(blob, name); toast(`Exported ${total} customers to ${name}`);
    } catch (e) { toast(errText(e, 'You cannot download this list.')); }
  };
  const setLead = async (row, fieldId, value) => {
    setData((d) => ({ ...d, contacts: d.contacts.map((c) => (c.id === row.id ? { ...c, customValues: { ...c.customValues, [fieldId]: value }, ...(fieldId === 'lead_stage' ? { leadStage: value } : {}), ...(fieldId === 'lead_status' ? { leadStatus: value } : {}) } : c)) }));
    try { await omni.put(`/gs/crm/customers/${row.id}`, { customValues: { [fieldId]: value }, enforceRequired: false }); } catch (e) { toast(errText(e, 'It could not be saved.')); load(); }
  };
  const afterSave = (r, editing, f) => {
    setModal(null);
    if (editing) { toast(r.ok || 'Customer updated'); load(); return; }
    setQ(''); setDq(''); setFilters({}); setSort(null); setPage(1); setForm('');
    setFlashId(r.id); setTimeout(() => setFlashId(null), 2800);
    load().then((x) => toast(`${f.name.trim() || f.phone.trim() || 'Customer'} added — ${x ? x.total : ''} customers`));
  };
  const erase = async () => {
    const row = modal.row; setModal(null);
    try { await omni.del(`/contacts/${row.id}`, { reason: 'Removed from the Customers list' }); toast('Removed. Only a do-not-contact marker stays.'); load(); } catch (e) { toast(errText(e, 'It could not be removed.')); }
  };
  const activeForm = meta && form ? meta.forms.find((f) => f.id === form) : null;
  const colMenuRows = allCols.filter((c) => !colQ || `${c.header} ${c.key}`.toLowerCase().includes(colQ.toLowerCase()));
  const allOn = allCols.length > 0 && visible.length >= allCols.length;

  const cell = (c, row) => {
    switch (c.id) {
      case 'name': return <td key={c.id} className="campaign-name" style={{ minWidth: 150 }}>{row.name ? <button type="button" className="link-btn" style={{ fontSize: 'inherit', fontWeight: 900, color: 'var(--ink)', textAlign: 'left', whiteSpace: 'normal' }} onClick={() => setModal({ kind: 'detail', id: row.id })}>{row.name}</button> : <button type="button" className="crm-empty link-btn" style={{ color: '#b3bcb6' }} onClick={() => setModal({ kind: 'detail', id: row.id })}>Empty</button>}</td>;
      case 'phone': return <td key={c.id} style={{ whiteSpace: 'nowrap' }}>{row.phone || <Empty />}</td>;
      case 'source': return <td key={c.id}>{row.source ? <span className="pill live">{/whatsapp/i.test(row.source) ? 'whatsapp' : row.source}</span> : '—'}</td>;
      case 'email': return <td key={c.id} style={{ overflowWrap: 'anywhere' }}>{row.email || <Empty />}</td>;
      case 'platformId': return <td key={c.id}>{row.platformId || <Empty />}</td>;
      case 'kinds': return <td key={c.id}>{row.kinds.length ? row.kinds.map((k) => <span className="tag green" key={k} style={{ marginRight: 4 }}>{k}</span>) : '—'}</td>;
      case 'city': case 'company': case 'skills': case 'language': return <td key={c.id} style={{ overflowWrap: 'anywhere' }}>{row[c.id] || <Empty />}</td>;
      case 'preferredChannel': return <td key={c.id}>{PREF[row.preferredChannel] || <Empty />}</td>;
      case 'lastReply': return <td key={c.id} style={{ whiteSpace: 'nowrap' }}>{row.lastReplyAt ? dayLabel(row.lastReplyAt) : '—'}</td>;
      case 'notes': return <td key={c.id} style={{ overflowWrap: 'anywhere', minWidth: 140 }}>{row.notes || <Empty />}</td>;
      case 'permission': return (
        <td key={c.id}><div style={{ display: 'grid', gap: 3 }}>{row.channels.filter((x) => x.state !== 'none').map((x) => (
          <span key={x.channel} className={`pill ${SRC_TONE[x.state]}`} title={[x.words, x.at ? dayLabel(x.at) : '', x.how].filter(Boolean).join(' · ')} style={{ justifySelf: 'start' }}>{x.label} · {x.words}{x.state === 'opted_out' && x.at ? ` ${dayLabel(x.at)}` : ''}</span>
        ))}{!row.channels.some((x) => x.state !== 'none') && '—'}</div></td>
      );
      case 'owner': return <td key={c.id}>{row.ownerName || '—'}</td>;
      case 'created': return <td key={c.id} style={{ whiteSpace: 'nowrap' }}>{dayLabel(row.createdAt)}</td>;
      default: {
        const f = c.field; const v = row.customValues[f.id];
        if (f.id === 'lead_stage' || f.id === 'lead_status') {
          return (
            <td key={c.id}><span style={{ display: 'inline-block', width: 150 }}>
              <Combo value={v || ''} disabled={!canWrite} onChange={(e) => setLead(row, f.id, e.target.value)}><option value="">-- Select --</option>{(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}</Combo>
            </span></td>
          );
        }
        const text = Array.isArray(v) ? v.join(', ') : (f.type === 'checkbox' ? (v === 'yes' ? 'Yes' : '') : (v || ''));
        return <td key={c.id} style={{ overflowWrap: 'anywhere' }}>{text || <Empty />}</td>;
      }
    }
  };

  return (
    <div id="customers">
      <PageHead eyebrow="Audience & CRM" title="Customers" lead="One customer record for segmentation, personalization, conversations and conversion history.">
        {meta && meta.canImport && <Btn onClick={() => setModal({ kind: 'import' })}>⬆ Import Data</Btn>}
        {meta && meta.canImportAts && type === 'candidate_lead' && <Btn onClick={() => setModal({ kind: 'ats' })}>⇩ Import from ATS</Btn>}
        <Btn onClick={() => setModal({ kind: 'sheets' })}>📄 Google Sheets <span className="tag" style={{ marginLeft: 4 }}>Planned</span></Btn>
        {meta && meta.canAdd && <Btn primary onClick={() => setModal({ kind: 'add' })}>＋ Add Customer</Btn>}
      </PageHead>
      {meta && meta.canInternal && meta.canPromo && (
        <Tabs value={type} onChange={switchType} tabs={[['candidate_lead', 'Candidate contacts'], ['internal', 'Internal (staff) contacts']]} />
      )}
      {type === 'internal' && <Banner tone="info">Internal contacts are your own staff. They never get job promotions or tracked apply links.</Banner>}
      <div style={{ margin: '6px 0 10px' }}><Tabs value={tab} onChange={setTab} tabs={[['customers', 'Customers'], ['imports', 'Imports']]} /></div>
      {err && <Banner tone="error">{err}</Banner>}

      {tab === 'imports' && <ImportsHistory type={type} toast={toast} onChanged={load} />}
      {tab === 'customers' && (
        <>
          {masked && <p style={{ fontSize: 10.5, color: 'var(--muted)', margin: '0 0 8px' }}>Phone numbers and emails are hidden for your login.</p>}
          <div className="cust-toolbar">
            <div className="cf-search-wrap" style={{ marginBottom: 0 }}>
              <span className="cf-search-ico"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.6" /><path d="M10.6 10.6L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg></span>
              <input placeholder="Search..." aria-label="Search customers" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="dropdown" onClick={(e) => e.stopPropagation()}>
              <button type="button" className="tiny-btn cust-tb" aria-expanded={menu === 'cols'} onClick={() => setMenu(menu === 'cols' ? null : 'cols')}>⇅ Manage Columns</button>
              {menu === 'cols' && (
                <div className="menu show" style={{ width: 270, left: 0 }}>
                  <div className="menu-label">Toggle Columns</div>
                  <div style={{ padding: '0 10px 8px' }}><input className="col-filter-input" placeholder="Search fields..." value={colQ} onChange={(e) => setColQ(e.target.value)} /></div>
                  <label className="columns-menu-row" style={{ fontWeight: 850, color: 'var(--ink)' }}>
                    <input type="checkbox" checked={allOn} onChange={() => { if (allOn) { setVis(['name']); toast('Columns cleared — Customer Name kept'); } else { setVis(allCols.map((c) => c.id)); toast('All columns shown'); } }} /><b>{allOn ? 'Unselect All' : 'Select All'}</b>
                  </label>
                  <div className="columns-menu-list">
                    {colMenuRows.map((c) => (
                      <label className="columns-menu-row" key={c.id}>
                        <input type="checkbox" checked={visible.includes(c.id)} onChange={(e) => setVis(e.target.checked ? [...visible, c.id] : visible.filter((x) => x !== c.id))} />
                        <span className="col-dot" /><span style={{ fontSize: 11 }}>{c.header}</span><span className="col-key" style={{ marginLeft: 'auto', fontSize: 9 }}>{c.key}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <button type="button" className="tiny-btn cust-tb" onClick={refresh}>↻ Refresh</button>
            {meta && meta.canExport && <button type="button" className="tiny-btn cust-tb" onClick={exportXlsx}>⬇ Export Excel</button>}
            <span className="cust-synced">{refreshedAt ? `Last refreshed ${refreshedAt.toLocaleTimeString()}` : ''}</span>
          </div>

          <div className="cust-tabstrip">
            <div className="cust-tab-active">📄 {activeForm ? activeForm.title : 'Default'}</div>
            <div className="dropdown" onClick={(e) => e.stopPropagation()}>
              <button type="button" className="cust-tab-more" aria-label="Saved views" onClick={() => setMenu(menu === 'views' ? null : 'views')}>···</button>
              {menu === 'views' && (
                <div className="menu show" style={{ width: 230, left: 0 }}>
                  <div className="menu-label">Saved views</div>
                  <button type="button" className={!form ? 'active' : ''} onClick={() => { setForm(''); resetView(); setMenu(null); toast('Switched to view: Default'); }}>📄 Default</button>
                  {meta && meta.forms.map((f) => <button type="button" key={f.id} className={form === f.id ? 'active' : ''} onClick={() => { setForm(f.id); resetView(); setMenu(null); toast(`Switched to view: ${f.title}`); }}>📄 {f.title}</button>)}
                  {meta && !meta.forms.length && <button type="button" disabled>No other views yet</button>}
                </div>
              )}
            </div>
          </div>

          <div className="card table-card" style={{ borderRadius: '0 0 14px 14px', borderTop: 0 }}>
            <div className="table-scroll">
              <table className="table cust-table" style={{ minWidth: Math.max(760, cols.length * 130 + 140) }}>
                <thead>
                  <tr>
                    <th style={{ width: 34 }}><input type="checkbox" aria-label="Select all on this page" checked={!!data && data.contacts.length > 0 && data.contacts.every((c) => sel.has(c.id))} onChange={(e) => setSel(e.target.checked ? new Set(data.contacts.map((c) => c.id)) : new Set())} /></th>
                    {cols.map((c) => (
                      <HeaderCell key={c.id} col={c} sort={sort && sort.id === c.id ? sort.dir : null} filter={filters[c.id]} open={menu === `h:${c.id}`} canHide={cols.length > 1}
                        onOpen={() => setMenu(menu === `h:${c.id}` ? null : `h:${c.id}`)} onClose={() => setMenu(null)} onFilter={onFilter} onSort={onSort} onHide={onHide} />
                    ))}
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && !(data && data.contacts.length) && <tr><td colSpan={cols.length + 2} style={{ textAlign: 'center', color: 'var(--muted)', padding: '26px 0' }}>Loading…</td></tr>}
                  {!loading && data && !data.contacts.length && <tr><td colSpan={cols.length + 2} style={{ textAlign: 'center', color: 'var(--muted)', padding: '26px 0' }}>{dq || Object.keys(filters).length || form ? 'No contacts match your search.' : (meta && meta.canImport ? 'No customers yet. Press "Import Data" to upload your file, or "Add Customer".' : 'No customers to show.')}</td></tr>}
                  {data && data.contacts.map((row) => (
                    <tr key={row.id} className={flashId === row.id ? 'crm-row-new' : undefined}>
                      <td><input type="checkbox" aria-label={`Select ${row.name || 'customer'}`} checked={sel.has(row.id)} onChange={(e) => setSel((s) => { const n = new Set(s); if (e.target.checked) n.add(row.id); else n.delete(row.id); return n; })} /></td>
                      {cols.map((c) => cell(c, row))}
                      <td>
                        <button type="button" className="tiny-btn" title="Open" aria-label="Open customer" onClick={() => setModal({ kind: 'detail', id: row.id })}>👁</button>{' '}
                        {canWrite && <button type="button" className="tiny-btn" title="Edit" aria-label="Edit customer" onClick={() => setModal({ kind: 'edit', row })}>✎</button>}{' '}
                        {meta && meta.isAdmin && <button type="button" className="tiny-btn" title="Remove for good" aria-label="Remove customer" onClick={() => setModal({ kind: 'erase', row })}>🗑</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="cust-foot">
              <span>Page {Math.min(page, pages)} of {pages} • Total {total.toLocaleString('en-IN')}{sel.size ? ` • ${sel.size} selected` : ''} {sel.size > 0 && <button type="button" className="link-btn" onClick={() => setSel(new Set())}>Clear</button>}</span>
              <div className="cust-foot-r">
                <span>Rows per page:</span>
                <select className="cf-rows-select" aria-label="Rows per page" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>{[10, 20, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}</select>
                <button type="button" className="cf-page-btn" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">‹</button>
                <button type="button" className="cf-page-btn" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page">›</button>
              </div>
            </div>
          </div>
        </>
      )}

      {modal && modal.kind === 'add' && meta && <CustomerModal meta={{ ...meta, masked }} type={type} context={activeForm ? activeForm.title : 'Default'} onClose={() => setModal(null)} onSaved={afterSave} />}
      {modal && modal.kind === 'edit' && meta && <CustomerModal meta={{ ...meta, masked }} type={type} initial={modal.row} context={activeForm ? activeForm.title : 'Default'} onClose={() => setModal(null)} onSaved={afterSave} />}
      {modal && modal.kind === 'detail' && meta && <CustomerDetail id={modal.id} meta={meta} canSend={!!(acc && acc.canCampaign)} go={go} toast={toast} onClose={() => setModal(null)} onChanged={load} onEdit={(c) => setModal({ kind: 'edit', row: c })} />}
      {modal && modal.kind === 'import' && meta && <ImportModal type={type} meta={meta} go={go} onClose={() => setModal(null)} onDone={(r) => { load(); if (r && r.counts) toast(`${r.counts.created} customer${r.counts.created === 1 ? '' : 's'} imported successfully`); }} />}
      {modal && modal.kind === 'ats' && <AtsImportModal toast={toast} onClose={() => setModal(null)} onDone={load} />}
      {modal && modal.kind === 'erase' && <ConfirmModal title="Remove this person for good?" text="Their details are wiped. Only a do-not-contact marker stays so they are never messaged again." yes="Remove for good" danger onYes={erase} onNo={() => setModal(null)} />}
      {modal && modal.kind === 'sheets' && (
        <GsModal title="Google Sheets" width={460} onClose={() => setModal(null)} foot={<><Btn onClick={() => setModal(null)}>Close</Btn>{meta && meta.canExport && <Btn primary onClick={() => { setModal(null); exportXlsx(); }}>⬇ Export Excel instead</Btn>}</>}>
          <Planned>Writing straight into a Google Sheet needs a Google account to be connected. That is not built yet, so nothing is faked here.</Planned>
          <p style={{ fontSize: 12, lineHeight: 1.6 }}>For now, an Admin can download the list as an Excel file (the Export Excel button) and open it in Google Sheets with File &gt; Import.</p>
        </GsModal>
      )}
    </div>
  );
}
