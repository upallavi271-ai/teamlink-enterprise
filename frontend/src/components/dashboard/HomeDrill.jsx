import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Modal from '../Modal.jsx';
import StatusChip from '../ui/StatusChip.jsx';
import { ListToolbar, FacetSelect } from '../ui/ListPageHeader.jsx';
import { useAtsIoAccess } from '../AtsDataTools.jsx';
import './homeDrill.css';

// ---------------------------------------------------------------------------
// THE LIST BEHIND A DASHBOARD NUMBER — opens RIGHT THERE on the dashboard
// (the user: every number opens its list in place, never another module;
// "veetilo kuda filters raavali" — these lists get filters too).
//
//   [ Search… ] [ Filters (2) ]                       [⬇ Excel] [⬇ CSV]
//   Client = Orbit ✕ | Step = Sent to client ✕   Clear all
//   Candidate · Job · Client · Step · Due · Updated · Open
//   Showing 1–50 of 66                                  ‹ Back  Next ›
//
// The server (GET /dashboard/ats/home/list, utils/atsHome.js homeList)
// searches and filters WITHIN the set behind the number — which is already
// inside the login's role scope and the dashboard's own filters. Filter
// options cascade, carry counts and are never offered at zero. Export
// downloads exactly the filtered rows (Excel or CSV).
// ---------------------------------------------------------------------------
const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-IN'));
const rupees = (n) => (n === null || n === undefined ? '—' : `₹${Math.round(Number(n)).toLocaleString('en-IN')}`);
const shortDate = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
};
const dateTime = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const FACET_ALL = {
  d_client: 'All clients', d_job: 'All jobs', d_rec: 'All recruiters', d_tl: 'All team leads', d_step: 'All steps', d_due: 'Any', d_dept: 'All departments',
};

function DueCell({ r }) {
  if (r.note) return <StatusChip tone={r.tone === 'red' ? 'red' : 'amber'}>{r.note}</StatusChip>;
  if (r.dueKey === 'overdue') return <StatusChip tone="red" title={`Was due ${r.due}`}>Late · {shortDate(r.due)}</StatusChip>;
  if (r.dueKey === 'due_today') return <StatusChip tone="amber">Due today</StatusChip>;
  if (r.dueKey === 'upcoming' && r.due) return <StatusChip tone="blue">Due {shortDate(r.due)}</StatusChip>;
  if (r.dueKey === 'closed') return <StatusChip tone="green">Done</StatusChip>;
  return <span className="cell-muted">—</span>;
}

// Agreement pill: green signed, red expired / rejected, orange still waiting.
const agreementTone = (a) => (/^(signed|active)$/i.test(a || '') ? 'green' : /^(expired|rejected)$/i.test(a || '') ? 'red' : 'amber');

function saveBlob(res, fallback) {
  const cd = res.headers?.['content-disposition'] || '';
  const m = /filename="?([^";]+)"?/.exec(cd);
  const name = (m && m[1]) || fallback;
  const href = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = href; a.download = name; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(href), 2000);
  return name;
}

function OpenLink({ to, onClose }) {
  if (!to) return null;
  return <Link className="hd-open" to={to} onClick={onClose}>Open</Link>;
}

function Rows({ data, onClose }) {
  const rows = data.rows || [];
  const k = data.kind;
  if (k === 'app') {
    return (
      <table className="hd-tbl">
        <thead><tr><th>Candidate</th><th>Job</th><th>Client</th><th>Step</th><th>Due</th><th>Updated</th><th aria-label="Open" /></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}>
            <td><b className="hd-name">{r.candidate}</b>{r.recruiter && <div className="hd-sub">{r.recruiter}</div>}</td>
            <td>{r.requirement}{r.reqCode && <div className="hd-sub">{r.reqCode}</div>}</td>
            <td>{r.client || '—'}</td>
            <td><StatusChip status={r.step} /></td>
            <td><DueCell r={r} /></td>
            <td className="hd-sub">{shortDate(r.updatedAt)}</td>
            <td><OpenLink to={`/candidates/${r.candidateId}`} onClose={onClose} /></td>
          </tr>
        ))}</tbody>
      </table>
    );
  }
  if (k === 'req') {
    return (
      <table className="hd-tbl">
        <thead><tr><th>Job</th><th>Client</th><th>Department</th><th>Recruiter</th><th>Status</th><th className="num">Openings</th><th aria-label="Open" /></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}>
            <td><b className="hd-name">{r.title}</b>{r.reqCode && <div className="hd-sub">{r.reqCode}</div>}</td>
            <td>{r.client || '—'}</td>
            <td>{r.department || '—'}</td>
            <td>{r.recruiter || <StatusChip tone="amber">No recruiter</StatusChip>}</td>
            <td><StatusChip status={r.status} /></td>
            <td className="num">{fmt(r.openings)}</td>
            <td><OpenLink to={`/requirements/${r.id}`} onClose={onClose} /></td>
          </tr>
        ))}</tbody>
      </table>
    );
  }
  if (k === 'client') {
    return (
      <table className="hd-tbl"><thead><tr><th>Client</th><th>Agreement</th><th>Client manager (BDE)</th><th className="num">Open jobs</th><th aria-label="Open" /></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td><b className="hd-name">{r.name}</b></td><td><StatusChip tone={agreementTone(r.agreement)}>{r.agreement || 'Not signed'}</StatusChip></td><td>{r.owner || '—'}</td><td className="num">{fmt(r.openJobs)}</td><td><OpenLink to={r.to} onClose={onClose} /></td></tr>)}</tbody>
      </table>
    );
  }
  if (k === 'inv') {
    return (
      <table className="hd-tbl"><thead><tr><th>Invoice</th><th>Client</th><th>Invoice date</th><th>Due</th><th>Status</th><th className="num" title="Before GST">Amount</th><th className="num">Unpaid</th><th aria-label="Open" /></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td><b className="hd-name">{r.invoiceNumber || 'Invoice'}</b></td><td>{r.client}</td><td>{shortDate(r.invoiceDate)}</td><td>{shortDate(r.dueDate)}{r.daysOverdue > 0 && <div className="hd-sub hd-red">{r.daysOverdue} days late</div>}</td><td><StatusChip status={r.status} /></td><td className="num">{rupees(r.amount)}</td><td className="num">{rupees(r.outstanding)}</td><td><OpenLink to={r.to} onClose={onClose} /></td></tr>)}</tbody>
      </table>
    );
  }
  if (k === 'pay') {
    return (
      <table className="hd-tbl"><thead><tr><th>Date</th><th>Invoice</th><th>Client</th><th>Method</th><th className="num">Amount</th><th aria-label="Open" /></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td>{shortDate(r.date)}</td><td>{r.invoiceNumber || 'Invoice'}</td><td>{r.client || '—'}</td><td>{r.method}{r.reference && <div className="hd-sub">{r.reference}</div>}</td><td className="num">{rupees(r.amount)}</td><td><OpenLink to={r.to || (r.invoiceId ? `/invoices/${r.invoiceId}` : null)} onClose={onClose} /></td></tr>)}</tbody>
      </table>
    );
  }
  if (k === 'emp') {
    return (
      <table className="hd-tbl"><thead><tr><th>Employee</th><th>Department</th><th>Designation</th><th>Today</th><th aria-label="Open" /></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td><b className="hd-name">{r.name}</b></td><td>{r.department || '—'}</td><td>{r.designation || '—'}</td><td>{r.status ? <StatusChip status={r.status} /> : '—'}</td><td><OpenLink to={r.to} onClose={onClose} /></td></tr>)}</tbody>
      </table>
    );
  }
  if (k === 'user') {
    return (
      <table className="hd-tbl"><thead><tr><th>Name</th><th>Role</th><th>Last sign-in</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td><b className="hd-name">{r.name}</b></td><td>{r.role}</td><td>{dateTime(r.at)}</td></tr>)}</tbody>
      </table>
    );
  }
  if (k === 'event') {
    return (
      <table className="hd-tbl"><thead><tr><th>Candidate</th><th>Job</th><th>Moved from</th><th>To</th><th>By</th><th>When</th><th aria-label="Open" /></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td><b className="hd-name">{r.candidate}</b></td><td>{r.requirement}</td><td>{r.from}</td><td><StatusChip status={r.to} /></td><td>{r.by || '—'}</td><td className="hd-sub">{dateTime(r.at)}</td><td><OpenLink to={`/candidates/${r.candidateId}`} onClose={onClose} /></td></tr>)}</tbody>
      </table>
    );
  }
  if (k === 'integ') {
    return (
      <table className="hd-tbl"><thead><tr><th>What is wrong</th><th>Detail</th><th aria-label="Open" /></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td><b className="hd-name">{r.what}</b></td><td>{r.detail}</td><td><OpenLink to={r.to} onClose={onClose} /></td></tr>)}</tbody>
      </table>
    );
  }
  return null;
}

export default function HomeDrill({ listUrl, params, setId, onClose }) {
  const access = useAtsIoAccess();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState({});
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [tick, setTick] = useState(0);

  // A new number: start clean.
  useEffect(() => { setSearch(''); setQ(''); setPicked({}); setPage(1); setMsg(null); }, [setId]);
  useEffect(() => {
    const t = setTimeout(() => { setQ(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const query = { ...params, set: setId, ...(q ? { d_q: q } : {}), ...picked, ...(page > 1 ? { d_page: page } : {}) };
  const key = JSON.stringify(query);
  useEffect(() => {
    let alive = true;
    setError('');
    api.get(listUrl, { params: query })
      .then((r) => { if (alive) setData(r.data); })
      .catch((e) => { if (alive) setError(e.response?.data?.error || 'This list did not load.'); });
    return () => { alive = false; };
  }, [listUrl, key, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const facets = (data && data.facets) || {};
  const setFacet = (k, v) => { setPicked((p) => { const n = { ...p }; if (v) n[k] = v; else delete n[k]; return n; }); setPage(1); };
  const labelOf = (k, v) => (((facets[k] || {}).options || []).find((o) => o.value === v) || {}).label || v;
  const chips = Object.entries(picked).map(([k, v]) => ({ key: k, label: (facets[k] || {}).label || 'Filter', value: labelOf(k, v), onRemove: () => setFacet(k, '') }));
  const clearAll = () => { setPicked({}); setSearch(''); setQ(''); setPage(1); };
  const panel = Object.keys(facets).length ? (
    <>
      {Object.entries(facets).map(([k, f]) => (
        <FacetSelect key={k} label={f.label} value={picked[k] || ''} onChange={(v) => setFacet(k, v)} options={f.options} allLabel={FACET_ALL[k] || 'All'} />
      ))}
    </>
  ) : null;

  const mayExport = !!(access && (access.exports || {}).dashboard);
  async function exportAs(format) {
    setBusy(format); setMsg(null);
    try {
      const { d_page: _p, ...rest } = query; // eslint-disable-line no-unused-vars, camelcase
      const res = await api.get(listUrl, { params: { ...rest, format }, responseType: 'blob' });
      const name = saveBlob(res, `dashboard-list.${format}`);
      setMsg({ ok: true, text: `Downloaded ${name} — ${fmt(res.headers?.['x-export-rows'] || (data && data.filtered))} rows.` });
    } catch (e) {
      let text = 'The file could not be made. Try again, or narrow the list.';
      try { const j = JSON.parse(await e.response.data.text()); if (j.error) text = j.error; } catch { /* keep the plain message */ }
      setMsg({ ok: false, text });
    } finally { setBusy(''); }
  }

  const rows = (data && data.rows) || [];
  const filtered = data ? data.filtered : 0;
  const from = data && filtered ? (data.page - 1) * data.pageSize + 1 : 0;
  const to = data ? Math.min(filtered, data.page * data.pageSize) : 0;
  const narrowed = !!(q || Object.keys(picked).length);
  const note = data ? (narrowed ? `${fmt(filtered)} of ${fmt(data.total)}` : `${fmt(data.total)} in total`) : '';
  const exportBtns = mayExport && data && data.total > 0 ? (
    <span className="hd-export">
      <button type="button" className="btn btn-sm" disabled={!!busy || !filtered} onClick={() => exportAs('xlsx')} title="Download this list (with your search and filters) as Excel">
        <span aria-hidden="true">⬇</span> {busy === 'xlsx' ? 'Preparing…' : 'Excel'}
      </button>
      <button type="button" className="btn btn-sm" disabled={!!busy || !filtered} onClick={() => exportAs('csv')} title="Download this list (with your search and filters) as CSV">
        <span aria-hidden="true">⬇</span> {busy === 'csv' ? 'Preparing…' : 'CSV'}
      </button>
    </span>
  ) : null;

  return (
    <Modal title={data ? data.title : 'Loading…'} note={note} size="xwide" onClose={onClose} bodyStyle={{ maxHeight: '74vh', overflow: 'auto', padding: 0 }}>
      <div className="hd">
        {data && data.total > 0 && (
          <div className="hd-bar">
            <ListToolbar
              search={data.searchable ? search : undefined}
              onSearch={data.searchable ? setSearch : undefined}
              placeholder={data.kind === 'app' ? 'Search name, job, client…' : 'Search…'}
              searchWidth={220}
              filterCount={chips.length}
              panel={panel}
              chips={chips}
              onClearAll={narrowed ? clearAll : undefined}
              right={exportBtns}
            />
            {msg && <div className={`hd-msg ${msg.ok ? 'ok' : 'bad'}`} role="status">{msg.text}</div>}
          </div>
        )}
        {error && <div className="notice red" style={{ margin: 12 }}>{error} <button type="button" className="btn btn-sm" onClick={() => setTick((n) => n + 1)}>Try again</button></div>}
        {!data && !error && <div className="small-muted hd-pad">Loading…</div>}
        {data && data.total === 0 && <div className="hd-empty">Nothing here now. Close this and pick another number.</div>}
        {data && data.total > 0 && filtered === 0 && (
          <div className="hd-empty">Nothing matches your search or filters. <button type="button" className="link-btn" onClick={clearAll}>Clear all</button></div>
        )}
        {data && rows.length > 0 && <div className="hd-wrap"><Rows data={data} onClose={onClose} /></div>}
        {data && filtered > 0 && (
          <div className="hd-foot">
            <span>Showing {fmt(from)}–{fmt(to)} of {fmt(filtered)}</span>
            {filtered > data.pageSize && (
              <span className="hd-pager">
                <button type="button" className="btn btn-sm" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>‹ Back</button>
                <button type="button" className="btn btn-sm" disabled={to >= filtered} onClick={() => setPage(data.page + 1)}>Next ›</button>
              </span>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
