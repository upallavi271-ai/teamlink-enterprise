import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import vendorApi, { vendorError } from '../../vendorApi';
import { VendorIoBar } from './VendorIo.jsx';
import Modal from '../../components/Modal.jsx';
import VendorShell, { openVendorFile } from './VendorShell.jsx';
import VendorPager from './VendorPager.jsx';
import { day } from './vendorFormat.js';
import { when, HistoryList } from './assetPortalCommon.jsx';
import { StatusTag, Photo } from './idCardCommon.jsx';
import { IDCARD_BUCKET_OF } from './vendorNav.js';
import './idCardPortal.css';
import './vendorModules.css';

// The four ID card modules (2026-10-19) are ONE screen with four views: ID Card Requests (all), Pending ID Cards, Completed ID Cards and
// Delivered / Printed. A request = one employee's card on one of the company's orders; its status is its order's status (New > Received >
// Printing > Ready > Delivered). Everything (search, filters, sort, pages, counts) is done by the server, inside the vendor taken from the
// session. Moving a status moves the WHOLE order, one step at a time; nothing completes or delivers by itself.
const PAGES = {
  all: { title: 'ID Card Requests', sub: 'Every ID card request the company has given you.', empty: 'No ID card requests found.' },
  pending: { title: 'Pending ID Cards', sub: 'Requests that are not finished yet: new, received or being printed.', empty: 'No pending ID cards found.' },
  completed: { title: 'Completed ID Cards', sub: 'Printing is finished. These cards are ready to be handed over.', empty: 'No completed ID cards found.' },
  delivered: { title: 'Delivered / Printed', sub: 'Cards that have been printed and delivered to the company.', empty: 'No delivered ID cards found.' },
};
const SORTS = [['requestDate', 'Request date'], ['employeeName', 'Name'], ['employeeCode', 'Employee ID'], ['department', 'Department'], ['designation', 'Designation'], ['status', 'ID card status'], ['orderCode', 'Request reference']];
const BLANK = { q: '', department: '', status: '', printing: '', delivery: '', from: '', to: '', sort: 'requestDate', dir: '', page: 1 };

export default function IdCardRequests() {
  const { pathname } = useLocation();
  const bucket = IDCARD_BUCKET_OF[pathname] || 'all';
  const p = PAGES[bucket];
  return (
    <VendorShell title={p.title} sub={p.sub}>
      <Body key={bucket} bucket={bucket} page={p} />
    </VendorShell>
  );
}

function Body({ bucket, page }) {
  const [params] = useSearchParams();
  const [data, setData] = useState(null);
  const [f, setF] = useState({ ...BLANK, q: params.get('q') || '' });
  const [qDeb, setQDeb] = useState(f.q);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  const [sel, setSel] = useState({}); // request id -> row (only processable rows)
  const [confirm, setConfirm] = useState(null);
  const [toast, setToast] = useState('');
  const [printRows, setPrintRows] = useState(null);
  const reqNo = useRef(0);
  useEffect(() => { const t = setTimeout(() => setQDeb(f.q), 250); return () => clearTimeout(t); }, [f.q]);
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(''), 5000); return () => clearTimeout(t); }, [toast]);
  const query = useMemo(() => ({ bucket, q: qDeb || undefined, department: f.department || undefined, status: f.status || undefined, printing: f.printing || undefined, delivery: f.delivery || undefined, from: f.from || undefined, to: f.to || undefined, sort: f.sort, dir: f.dir || undefined, page: f.page }), [bucket, qDeb, f]);
  const load = useCallback(() => {
    const n = ++reqNo.current; // only the newest answer is shown
    vendorApi.get('/idcard-portal/requests', { params: query })
      .then((r) => { if (n === reqNo.current) { setData(r.data); setError(''); } }).catch((e) => { if (n === reqNo.current) setError(vendorError(e, 'Could not load the requests.')); });
  }, [query]);
  useEffect(() => { load(); }, [load]);
  const set = (patch) => { setSel({}); setF((x) => ({ ...x, page: 1, ...patch })); };
  const rows = data?.rows || [];
  const filtered = !!(f.q || f.department || f.status || f.printing || f.delivery || f.from || f.to);
  const picked = Object.values(sel);
  const orders = useMemo(() => { const m = new Map(); picked.forEach((r) => m.set(r.orderId, r)); return [...m.values()]; }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps
  const statuses = [...new Set(orders.map((o) => o.status))];
  const sameStep = statuses.length === 1;
  const next = sameStep ? orders[0].nextStatus : null;
  const canAct = (r) => !!(data?.canUpdate && r.nextStatus);
  const pageProcessable = rows.filter(canAct);
  const allOnPage = pageProcessable.length > 0 && pageProcessable.every((r) => sel[r.id]);
  const toggle = (r) => setSel((s) => { const c = { ...s }; if (c[r.id]) delete c[r.id]; else c[r.id] = r; return c; });
  const togglePage = () => setSel((s) => { const c = { ...s }; if (allOnPage) pageProcessable.forEach((r) => delete c[r.id]); else pageProcessable.forEach((r) => { c[r.id] = r; }); return c; });
  const doPrint = (list) => {
    setPrintRows(list);
    setTimeout(() => {
      const after = () => { document.body.classList.remove('idc-printing'); window.removeEventListener('afterprint', after); setPrintRows(null); };
      window.addEventListener('afterprint', after);
      document.body.classList.add('idc-printing');
      window.print();
    }, 150);
  };
  const cols = bucket === 'pending' ? 'Waiting' : (bucket === 'completed' ? 'Completed on' : (bucket === 'delivered' ? 'Delivered on' : null));
  const colVal = (r) => (bucket === 'pending' ? (r.waitingDays == null ? '-' : `${r.waitingDays} ${r.waitingDays === 1 ? 'day' : 'days'}`) : (bucket === 'completed' ? day(r.completedOn) : day(r.deliveredOn)));
  const opt = (list) => (list || []).map((o) => <option key={o.value} value={o.value}>{o.value} ({o.count})</option>);

  return (
    <>
      <div className="idc-screen">
        {toast && <div className="notice green" style={{ marginBottom: 10 }} role="status"><span>{toast}</span></div>}
        {error && <div className="notice red" style={{ marginBottom: 10 }} role="alert"><span>{error} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>}
        <VendorIoBar list="requests" params={query} importKey="order-status" onImported={load} />
        <div className="vp-filters" role="search">
          <input className="vp-search" type="search" placeholder="Search employee ID, name, department, designation or request reference" value={f.q} onChange={(e) => set({ q: e.target.value })} aria-label="Search requests" />
          <select aria-label="Department" value={f.department} onChange={(e) => set({ department: e.target.value })}><option value="">Any department</option>{opt(data?.facets.department)}</select>
          <select aria-label="ID card status" value={f.status} onChange={(e) => set({ status: e.target.value })}><option value="">Any ID card status</option>{opt(data?.facets.status)}</select>
          <select aria-label="Printing status" value={f.printing} onChange={(e) => set({ printing: e.target.value })}><option value="">Any printing status</option>{opt(data?.facets.printing)}</select>
          <select aria-label="Delivery status" value={f.delivery} onChange={(e) => set({ delivery: e.target.value })}><option value="">Any delivery status</option>{opt(data?.facets.delivery)}</select>
          <div className="vp-dates">
            <input type="date" aria-label="Requested from" value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.target.value })} />
            <span className="vp-to">to</span>
            <input type="date" aria-label="Requested to" value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.target.value })} />
          </div>
          <select aria-label="Sort by" value={f.sort} onChange={(e) => set({ sort: e.target.value, dir: '' })}>{SORTS.map(([k, l]) => <option key={k} value={k}>Sort: {l}</option>)}</select>
          <button type="button" className="btn btn-sm" onClick={() => set({ dir: (f.dir || data?.dir) === 'asc' ? 'desc' : 'asc' })} aria-label="Change the sort direction">{(f.dir || data?.dir) === 'asc' ? 'Smallest first' : 'Largest first'}</button>
          {filtered && <button type="button" className="btn btn-sm btn-ghost" onClick={() => set({ ...BLANK })}>Clear filters</button>}
        </div>

        {picked.length > 0 && (
          <div className="idc-bar" role="region" aria-label="Selected requests">
            <b>{picked.length} selected</b>
            {sameStep && next
              ? <button type="button" className="btn btn-sm btn-primary" onClick={() => setConfirm({ orders, next })}>Move {orders.length === 1 ? 'the order' : `${orders.length} orders`} to {next}</button>
              : <span className="cell-muted">Pick requests that are at the same step to move them together.</span>}
            <button type="button" className="btn btn-sm" onClick={() => doPrint(picked)}>Print list</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSel({})}>Clear selection</button>
          </div>
        )}

        {!data ? (
          <div className="idc-wrap" aria-busy="true" aria-label="Loading">{[1, 2, 3, 4, 5].map((n) => <div key={n} className="idc-skel" style={{ margin: 12, height: 22 }} />)}</div>
        ) : !rows.length ? (
          <div className="vp-empty">{data.counts.all && (filtered) ? <><h3>No request matches</h3><p>Clear the filters to see more.</p></> : <><h3>{page.empty}</h3><p>When the company gives you ID card requests, they show here.</p></>}</div>
        ) : (
          <>
            <div className="idc-wrap">
              <table className="idc-table">
                <thead>
                  <tr>
                    {data.canUpdate && <th><input type="checkbox" checked={allOnPage} disabled={!pageProcessable.length} onChange={togglePage} aria-label="Select all requests on this page that can be moved" /></th>}
                    <th>Photo</th><th>Employee ID</th><th>Name</th><th>Department</th><th>Designation</th><th>Request date</th><th>ID card status</th><th>Printing</th><th>Delivery status</th>{cols && <th>{cols}</th>}<th>Reference</th><th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      {data.canUpdate && <td>{canAct(r) ? <input type="checkbox" checked={!!sel[r.id]} onChange={() => toggle(r)} aria-label={`Select ${r.name}`} /> : null}</td>}
                      <td><Photo row={r} /></td>
                      <td>{r.employeeCode || '-'}</td>
                      <td><strong>{r.name}</strong></td>
                      <td>{r.department || '-'}</td>
                      <td>{r.designation || '-'}</td>
                      <td>{day(r.requestDate)}</td>
                      <td><StatusTag status={r.status} /></td>
                      <td>{r.printingStatus}</td>
                      <td>{r.deliveryStatus}</td>
                      {cols && <td>{colVal(r)}</td>}
                      <td>{r.requestRef}</td>
                      <td className="idc-tbl-actions"><button type="button" className="btn btn-sm" onClick={() => setOpen(r.id)} aria-label={`View details of ${r.name}`}>View details</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <VendorPager data={data} onPage={(page2) => { setSel({}); setF((x) => ({ ...x, page: page2 })); }} />
          </>
        )}
        {open && <Detail id={open} onClose={() => setOpen(null)} onChanged={load} onToast={setToast} onPrint={(r) => doPrint([r])} />}
        {confirm && <ConfirmMove c={confirm} onClose={() => setConfirm(null)} onDone={(msg) => { setConfirm(null); setSel({}); setToast(msg); load(); }} />}
      </div>
      {printRows && (
        <div className="idc-print" aria-hidden="true">
          <h2>ID card list ({printRows.length})</h2>
          {printRows.map((r) => (
            <div key={r.id} className="idc-sheet-row">
              <Photo row={r} />
              <div><strong>{r.name}</strong><br />Employee ID: {r.employeeCode || '-'} &middot; {r.designation || '-'} &middot; {r.department || '-'}<br />Reference {r.requestRef} &middot; {r.cardType} &middot; {r.status}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function ConfirmMove({ c, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [res, setRes] = useState(null);
  const cards = c.orders.reduce((t, o) => t + (o.cardsInOrder || 0), 0);
  async function go() {
    if (busy) return; // a second click while it is saving does nothing
    setBusy(true); setError('');
    try {
      const r = await vendorApi.post('/idcard-portal/bulk/status', { orderIds: c.orders.map((o) => o.orderId), status: c.next });
      if (r.data.refused) { setRes(r.data); } else onDone(r.data.message || 'Done.');
    } catch (e) { setError(vendorError(e, 'Could not change the status.')); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Move to ${c.next}`} onClose={onClose} footer={res ? <button type="button" className="btn btn-primary" onClick={() => onDone(res.message)}>Close</button> : (
      <><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="btn btn-primary" onClick={go} disabled={busy}>{busy ? 'Saving...' : `Yes, move to ${c.next}`}</button></>
    )}>
      {error && <div className="notice red" role="alert"><span>{error}</span></div>}
      {!res ? (
        <>
          <p>The status belongs to the whole order. This moves <strong>{c.orders.length} {c.orders.length === 1 ? 'order' : 'orders'}</strong>{cards ? <> ({cards} {cards === 1 ? 'card' : 'cards'})</> : null} from <strong>{c.orders[0].status}</strong> to <strong>{c.next}</strong>.</p>
          <ul className="vm-hist">{c.orders.map((o) => <li key={o.orderId}>{o.requestRef}{o.cardsInOrder ? ` - ${o.cardsInOrder} cards` : ''}</li>)}</ul>
          <p className="cell-muted">The company is told. One step at a time; it cannot be skipped or taken back.</p>
        </>
      ) : (
        <>
          <p><strong>{res.moved}</strong> moved, <strong>{res.unchanged}</strong> were already there, <strong>{res.refused}</strong> could not be changed.</p>
          <ul className="vm-hist">{res.results.map((r) => <li key={r.orderId}>{r.orderCode || 'Order'}: {r.result === 'moved' ? `now ${r.status}` : (r.result === 'unchanged' ? 'already there' : `not changed - ${r.error}`)}</li>)}</ul>
        </>
      )}
    </Modal>
  );
}

function Detail({ id, onClose, onChanged, onToast, onPrint }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [remarks, setRemarks] = useState('');
  const [proof, setProof] = useState('');
  const fileRef = useRef(null);
  const url = `/idcard-portal/requests/${encodeURIComponent(id)}`;
  const load = useCallback(() => { vendorApi.get(url).then((r) => { setD(r.data); setError(''); }).catch((e) => setError(vendorError(e, 'Could not open this request.'))); }, [url]);
  useEffect(() => { load(); }, [load]);
  const r = d?.request;
  async function advance() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const x = await vendorApi.post(`/idcard-portal/orders/${encodeURIComponent(r.orderId)}/status`, { status: r.nextStatus, remarks: remarks || undefined });
      onToast(x.data.message); setRemarks(''); load(); onChanged();
    } catch (e) { setError(vendorError(e, 'Could not change the status.')); } finally { setBusy(false); }
  }
  async function saveProof() {
    const file = fileRef.current?.files?.[0];
    if (!file && !proof.trim()) { setError('Attach the challan or proof file, or write a remark.'); return; }
    setBusy(true); setError('');
    const fd = new FormData();
    if (file) fd.append('file', file);
    fd.append('remarks', proof);
    try {
      const x = await vendorApi.post(`/idcard-portal/orders/${encodeURIComponent(r.orderId)}/proof`, fd);
      onToast(x.data.message); setProof(''); if (fileRef.current) fileRef.current.value = ''; load();
    } catch (e) { setError(vendorError(e, 'Could not save.')); } finally { setBusy(false); }
  }
  const history = (d?.history || []).map((h) => (h.from && h.from !== h.to
    ? { id: h.id, by: h.by, kind: 'status', field: 'the status', from: h.from, to: h.to, note: h.note, at: h.at }
    : { id: h.id, by: h.by, kind: 'remark', field: 'Remark', from: null, to: h.note || (h.to ? `status ${h.to}` : ''), note: null, at: h.at }));
  return (
    <Modal title={r ? `${r.name} - ${r.requestRef}` : 'Request'} size="wide" onClose={onClose} footer={<><button type="button" className="btn" onClick={() => r && onPrint(r)} disabled={!r}>Print details</button><button type="button" className="btn" onClick={onClose}>Close</button></>}>
      {error && <div className="notice red" role="alert" style={{ marginBottom: 8 }}><span>{error} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>}
      {!d && !error && <div className="idc-skel" style={{ height: 120 }} aria-busy="true" />}
      {d && (
        <div className="vp-detail">
          <div className="vm-row" style={{ alignItems: 'flex-start' }}>
            <Photo row={r} big />
            <dl style={{ flex: 1, minWidth: 220 }}>
              <dt>Employee ID</dt><dd>{r.employeeCode || '-'}</dd>
              <dt>Name</dt><dd><strong>{r.name}</strong></dd>
              <dt>Designation</dt><dd>{r.designation || '-'}</dd>
              <dt>Department</dt><dd>{r.department || '-'}</dd>
              <dt>Blood group</dt><dd>{r.bloodGroup || '-'}</dd>
              <dt>Card type</dt><dd>{r.cardType}</dd>
            </dl>
          </div>
          <ol className="vm-steps" aria-label="Order steps">{d.steps.map((s, i) => { const at = d.steps.indexOf(r.status); return <li key={s} className={i < at ? 'done' : (i === at ? 'now' : '')} aria-current={i === at ? 'step' : undefined}>{s}</li>; })}</ol>
          <dl>
            <dt>Request reference</dt><dd>{r.requestRef} ({r.cardsInOrder} {r.cardsInOrder === 1 ? 'card' : 'cards'} in this order)</dd>
            <dt>ID card status</dt><dd><StatusTag status={r.status} /></dd>
            <dt>Printing</dt><dd>{r.printingStatus}</dd>
            <dt>Delivery</dt><dd>{r.deliveryStatus}</dd>
            <dt>Requested</dt><dd>{when(r.dates.requested)}</dd>
            <dt>Received</dt><dd>{r.dates.received ? when(r.dates.received) : '-'}</dd>
            <dt>Printing started</dt><dd>{r.dates.printing ? when(r.dates.printing) : '-'}</dd>
            <dt>Ready</dt><dd>{r.dates.ready ? when(r.dates.ready) : '-'}</dd>
            <dt>Delivered</dt><dd>{r.dates.delivered ? when(r.dates.delivered) : '-'}</dd>
            {r.orderNote && (<><dt>Note from the company</dt><dd>{r.orderNote}</dd></>)}
            {r.vendorRemarks && (<><dt>Your last remark</dt><dd>{r.vendorRemarks}</dd></>)}
          </dl>
          {d.canUpdate && r.nextStatus && (
            <div className="vm-form" style={{ marginTop: 10 }}>
              <h4>What to do next</h4>
              <p className="cell-muted" style={{ marginTop: 0 }}>This moves the whole order ({r.cardsInOrder} {r.cardsInOrder === 1 ? 'card' : 'cards'}) to <strong>{r.nextStatus}</strong>. One step at a time.</p>
              <input type="text" value={remarks} maxLength={500} placeholder="A short remark (optional)" onChange={(e) => setRemarks(e.target.value)} aria-label="Remark" style={{ width: '100%', marginBottom: 8 }} />
              <button type="button" className="btn btn-primary" disabled={busy} onClick={advance}>{busy ? 'Saving...' : r.nextButton}</button>
            </div>
          )}
          {!r.nextStatus && <p className="cell-muted">This order is delivered. Thank you.</p>}
          {d.canProof && (
            <div className="vm-form" style={{ marginTop: 10 }}>
              <h4>Delivery challan / proof and remarks</h4>
              {r.hasChallan && <div className="vm-row"><span>Uploaded: <strong>{r.challanName}</strong></span><button type="button" className="btn btn-sm" onClick={() => openVendorFile({ kind: 'po-challan', id: r.orderId }).catch((e) => setError(vendorError(e, 'Could not open it.')))}>Open</button></div>}
              <input type="file" ref={fileRef} accept=".pdf,.jpg,.jpeg,.png" aria-label="Challan or proof file" />
              <textarea rows={2} value={proof} maxLength={800} onChange={(e) => setProof(e.target.value)} placeholder="A remark for the company" aria-label="Remark for the company" style={{ width: '100%', marginTop: 6 }} />
              <div style={{ marginTop: 8 }}><button type="button" className="btn" disabled={busy} onClick={saveProof}>Save challan / remark</button></div>
            </div>
          )}
          <h4 style={{ margin: '14px 0 6px' }}>History</h4>
          <HistoryList rows={history} />
        </div>
      )}
    </Modal>
  );
}
