// ---------------------------------------------------------------------------
// STATIONERY — Employee Services → Stationery (user, 2026-10-05):
// "HR pushes (adds) the quantity; then based on the count, assigns to
// employees how many pens and notepads. That count we also want to know
// employee-wise."
//
// Counted things (notepads, pens …), not unique assets. The API is
// backend/src/routes/stationery.js, which also decides who may do what:
//   HR / Admin / Super Admin  add stock, give, give to many, take back
//   Manager / Asst Manager    see everything, change nothing
//   TL / STL                  their team's counts, read-only
//   everyone else             only what was given to them
// The screen only mirrors those answers (GET /stationery/me).
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import Combo from '../../components/Combo.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import { FacetSelect } from '../../components/ui/ListPageHeader.jsx';
import { ComposeModal, Field, Row, useSubmit } from '../../components/ComposeForm.jsx';
import './Stationery.css';

const todayYmd = () => new Date().toLocaleDateString('en-CA');
// "1 pen", "12 pens", "3 stapler pins" — same rule as the server.
function plural(name, n) {
  const w = String(name || '').toLowerCase();
  if (n === 1) return w;
  if (/s$/.test(w)) return w;
  if (/(x|ch|sh)$/.test(w)) return `${w}es`;
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`;
  return `${w}s`;
}
const countOf = (name, n) => `${n} ${plural(name, n)}`;
const titleCase = (w) => w.charAt(0).toUpperCase() + w.slice(1);
const fmtDate = (d) => {
  if (!d) return '—';
  const x = new Date(`${d}T00:00:00`);
  return Number.isNaN(x.getTime()) ? d : x.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};
const personLabel = (e) => `${e.name}${e.employeeCode ? ` · ${e.employeeCode}` : ''}${e.seats && e.seats.length ? ` · ${e.seats.join(', ')}` : e.designation ? ` · ${e.designation}` : ''}`;
const errText = (err, fallback) => (err && err.response && err.response.data && err.response.data.error) || fallback;
const NO_DEPT = '__none__';

// ---- Give to one employee ----------------------------------------------------------
function GiveModal({ items, people, onClose, onSaved }) {
  const [department, setDepartment] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [itemId, setItemId] = useState(() => ((items.find((i) => i.active && i.left > 0) || {}).id || ''));
  const [quantity, setQuantity] = useState('1');
  const [date, setDate] = useState(todayYmd());
  const [note, setNote] = useState('');
  const { busy, error, setError, run } = useSubmit();
  const all = (people && people.employees) || [];
  const inDept = department ? all.filter((e) => (department === NO_DEPT ? !e.department : e.department === department)) : [];
  const item = items.find((i) => i.id === itemId);
  const qty = Number(quantity);
  const tooMany = item && Number.isInteger(qty) && qty > 0 && qty > item.left;
  async function submit() {
    if (!department) { setError('First pick the department.'); return; }
    if (!employeeId) { setError('Now pick the employee.'); return; }
    if (!itemId) { setError('Pick the item.'); return; }
    if (!Number.isInteger(qty) || qty <= 0) { setError('Enter how many, 1 or more.'); return; }
    if (tooMany) { setError(item.left <= 0 ? `No ${plural(item.name, 2)} left. Add stock first.` : `Only ${countOf(item.name, item.left)} left.`); return; }
    const res = await run(() => api.post('/stationery/issue', { employeeId, itemId, quantity: qty, date, note }), 'Could not save. Try again.');
    if (res) onSaved(res.data.message);
  }
  return (
    <ComposeModal title="Give to employee" onClose={onClose} onSubmit={submit} submitLabel="Give" busy={busy} error={error}>
      {!people && <div className="small-muted">Loading people…</div>}
      <Field label="1. Department" required>
        <Combo value={department} onChange={(e) => { setDepartment(e.target.value); setEmployeeId(''); }}>
          <option value="">Pick the department</option>
          {((people && people.departments) || []).map((d) => <option key={d.name} value={d.name}>{`${d.name} (${d.count} ${d.count === 1 ? 'person' : 'people'})`}</option>)}
          {people && people.noDepartment > 0 && <option value={NO_DEPT}>{`No department on file (${people.noDepartment})`}</option>}
        </Combo>
      </Field>
      {department && (
        <Field label="2. Employee" required>
          {inDept.length === 0
            ? <div className="small-muted">Nobody working in this department now. Pick another department.</div>
            : (
              <Combo value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                <option value="">Pick the employee</option>
                {inDept.map((e) => <option key={e.id} value={e.id}>{personLabel(e)}</option>)}
              </Combo>
            )}
        </Field>
      )}
      <Row>
        <Field label="3. Item" required>
          <select value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">Pick the item</option>
            {items.filter((i) => i.active).map((i) => <option key={i.id} value={i.id}>{`${i.name} (${i.left > 0 ? `${i.left} left` : 'none left'})`}</option>)}
          </select>
        </Field>
        <Field label="How many" required>
          <input inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/[^0-9]/g, ''))} />
        </Field>
      </Row>
      {item && Number.isInteger(qty) && qty > 0 && (
        tooMany
          ? <div className="stn-warn stn-red">{item.left <= 0 ? `No ${plural(item.name, 2)} left. Add stock first.` : `Only ${countOf(item.name, item.left)} left.`}</div>
          : <div className="stn-warn stn-green">{`After this: ${countOf(item.name, item.left - qty)} left.`}</div>
      )}
      <Row>
        <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Note (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. new joiner kit" /></Field>
      </Row>
    </ComposeModal>
  );
}

// ---- Give to many: a department or several people, the same quantity each ------------
function GiveManyModal({ items, people, onClose, onSaved }) {
  const [department, setDepartment] = useState('');
  const [picked, setPicked] = useState(() => new Set());
  const [each, setEach] = useState({});
  const [date, setDate] = useState(todayYmd());
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState(null);
  const [checking, setChecking] = useState(false);
  const [retry, setRetry] = useState(0); // the server was restarting: ask again
  const { busy, error, setError, run } = useSubmit();
  const all = (people && people.employees) || [];
  const inDept = department ? all.filter((e) => (department === NO_DEPT ? !e.department : e.department === department)) : [];
  const active = items.filter((i) => i.active);
  const lines = active.map((i) => ({ itemId: i.id, quantity: Number(each[i.id] || 0) })).filter((l) => l.quantity > 0);
  const ids = [...picked];
  const key = JSON.stringify([ids, lines]);
  // The total and the balance check, from the server, before saving.
  useEffect(() => {
    if (!ids.length || !lines.length) { setPreview(null); return undefined; }
    let live = true;
    setChecking(true);
    const t = setTimeout(() => {
      api.post('/stationery/issue-many/preview', { employeeIds: ids, lines })
        .then((r) => { if (live) setPreview(r.data); })
        .catch((err) => {
          if (!live) return;
          const down = !err.response || [502, 503, 504].includes(err.response.status) || (err.response.status === 500 && !err.response.data);
          if (down && retry < 8) { setTimeout(() => setRetry((n) => n + 1), 1500); return; }
          setPreview({ ok: false, error: errText(err, 'Could not check the stock. Try again.') });
        })
        .finally(() => { if (live) setChecking(false); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [key, retry]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const tickAll = (on) => setPicked((s) => { const n = new Set(s); inDept.forEach((e) => (on ? n.add(e.id) : n.delete(e.id))); return n; });
  const pickedHere = inDept.filter((e) => picked.has(e.id)).length;
  async function submit() {
    if (!ids.length) { setError('Pick at least one person.'); return; }
    if (!lines.length) { setError('Type how many of an item each person gets.'); return; }
    if (!preview || !preview.ok) { setError((preview && (preview.error || (preview.plan || []).filter((p) => !p.ok).map((p) => p.problem).join(' '))) || 'Wait for the stock check.'); return; }
    const res = await run(() => api.post('/stationery/issue-many', { employeeIds: ids, lines, date, note }), 'Could not save. Try again.');
    if (res) onSaved(res.data.message);
  }
  return (
    <ComposeModal title="Give to many" wide onClose={onClose} onSubmit={submit} submitLabel={ids.length ? `Give to ${ids.length} ${ids.length === 1 ? 'person' : 'people'}` : 'Give'} busy={busy} disabled={!preview || !preview.ok || checking} error={error}>
      <div className="small-muted" style={{ marginBottom: 8 }}>Everyone you tick gets the same. Example: 1 notepad + 2 pens to everyone in Medical.</div>
      <Field label="1. Who gets it — pick a department, then tick people">
        <Combo value={department} onChange={(e) => setDepartment(e.target.value)}>
          <option value="">Pick the department</option>
          {((people && people.departments) || []).map((d) => <option key={d.name} value={d.name}>{`${d.name} (${d.count} ${d.count === 1 ? 'person' : 'people'})`}</option>)}
          {people && people.noDepartment > 0 && <option value={NO_DEPT}>{`No department on file (${people.noDepartment})`}</option>}
        </Combo>
      </Field>
      {department && (
        <div className="stn-pick">
          <div className="stn-pick-head">
            <span>{`${pickedHere} of ${inDept.length} ticked here`}</span>
            <button type="button" className="btn btn-sm" onClick={() => tickAll(true)}>Tick all</button>
            <button type="button" className="btn btn-sm" onClick={() => tickAll(false)}>Untick all</button>
          </div>
          <div className="stn-pick-list">
            {inDept.length === 0 && <div className="small-muted">Nobody working in this department now.</div>}
            {inDept.map((e) => (
              <label key={e.id} className="stn-pick-row">
                <input type="checkbox" checked={picked.has(e.id)} onChange={() => toggle(e.id)} />
                <span>{personLabel(e)}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="stn-picked">{ids.length ? `${ids.length} ${ids.length === 1 ? 'person' : 'people'} picked in all${ids.length > pickedHere ? ' (some from other departments)' : ''}.` : 'Nobody picked yet.'}
        {ids.length > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicked(new Set())}>Clear</button>}
      </div>
      <Field label="2. Each person gets">
        <div className="stn-each">
          {active.length === 0 && <div className="small-muted">No items yet. Add stock first.</div>}
          {active.map((i) => (
            <label key={i.id} className="stn-each-row">
              <span className="stn-each-name">{i.name}<small>{i.left > 0 ? `${i.left} left` : 'none left'}</small></span>
              <input inputMode="numeric" placeholder="0" value={each[i.id] || ''} onChange={(e) => setEach((m) => ({ ...m, [i.id]: e.target.value.replace(/[^0-9]/g, '') }))} />
            </label>
          ))}
        </div>
      </Field>
      <Row>
        <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Note (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. monthly kit" /></Field>
      </Row>
      <div className="stn-preview" aria-live="polite">
        <b>Check before saving</b>
        {!ids.length || !lines.length ? <div className="small-muted">Pick people and type how many — the total shows here.</div>
          : checking && !preview ? <div className="small-muted">Checking stock…</div>
            : preview && preview.error ? <div className="stn-warn stn-red">{preview.error}</div>
              : preview && (preview.plan || []).map((p) => (
                <div key={p.itemId} className={`stn-warn ${p.ok ? 'stn-green' : 'stn-red'}`}>
                  {p.ok ? `${p.text}. ${p.left} left now → ${p.after} after.` : `${p.text}. ${p.problem}`}
                </div>
              ))}
      </div>
    </ComposeModal>
  );
}

// ---- + Add stock (HR pushes the quantity) -------------------------------------------------
function AddStockModal({ items, onClose, onSaved }) {
  const [form, setForm] = useState({ item: (items.find((i) => i.active) || {}).name || '', quantity: '', date: todayYmd(), vendor: '', costPerUnit: '', billNo: '', note: '' });
  const { busy, error, setError, run } = useSubmit();
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const known = items.find((i) => i.name.toLowerCase() === form.item.trim().toLowerCase());
  async function submit() {
    if (!form.item.trim()) { setError('Pick the item (or type a new one).'); return; }
    const q = Number(form.quantity);
    if (!Number.isInteger(q) || q <= 0) { setError('Enter how many you are adding, 1 or more.'); return; }
    const body = { ...form, quantity: q, ...(known ? { itemId: known.id } : { itemName: form.item.trim() }) };
    delete body.item;
    const res = await run(() => api.post('/stationery/stock', body), 'Could not save. Try again.');
    if (res) onSaved(res.data.message, res.data.id);
  }
  return (
    <ComposeModal title="+ Add stock" onClose={onClose} onSubmit={submit} submitLabel="Add stock" busy={busy} error={error}>
      <Row>
        <Field label="Item" required hint={form.item.trim() && !known ? `"${form.item.trim()}" is new — it will be added to the list.` : 'Pick one, or type a new item (e.g. Pencil).'}>
          <Combo creatable value={form.item} onChange={set('item')}>
            {items.filter((i) => i.active).map((i) => <option key={i.id} value={i.name}>{i.name}</option>)}
          </Combo>
        </Field>
        <Field label="How many (pcs)" required>
          <input inputMode="numeric" value={form.quantity} onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value.replace(/[^0-9]/g, '') }))} placeholder="e.g. 100" />
        </Field>
      </Row>
      <Row>
        <Field label="Date"><input type="date" value={form.date} onChange={set('date')} /></Field>
        <Field label="Vendor (optional)"><input value={form.vendor} onChange={set('vendor')} placeholder="e.g. Sri Stationers" /></Field>
      </Row>
      <Row>
        <Field label="Cost per piece ₹ (optional)"><input inputMode="decimal" value={form.costPerUnit} onChange={set('costPerUnit')} placeholder="e.g. 10" /></Field>
        <Field label="Bill no. (optional)"><input value={form.billNo} onChange={set('billNo')} /></Field>
      </Row>
      <Field label="Note (optional)"><input value={form.note} onChange={set('note')} /></Field>
    </ComposeModal>
  );
}

// ---- Edit an item: name, warning level, hide ------------------------------------------------
function ItemModal({ item, onClose, onSaved }) {
  const isNew = !item;
  const [name, setName] = useState(item ? item.name : '');
  const [level, setLevel] = useState(item && item.reorderLevel !== null && item.reorderLevel !== undefined ? String(item.reorderLevel) : '');
  const { busy, error, setError, run } = useSubmit();
  async function submit() {
    if (!name.trim()) { setError('Type the item name.'); return; }
    const body = { name: name.trim(), reorderLevel: level === '' ? null : Number(level) };
    const res = await run(() => (isNew ? api.post('/stationery/items', body) : api.patch(`/stationery/items/${item.id}`, body)), 'Could not save. Try again.');
    if (res) onSaved(isNew ? `${name.trim()} added to the list.` : `${name.trim()} saved.`);
  }
  async function hide(active) {
    const res = await run(() => api.patch(`/stationery/items/${item.id}`, { active }), 'Could not save. Try again.');
    if (res) onSaved(active ? `${item.name} is back on the list.` : `${item.name} hidden. Its history is kept.`);
  }
  return (
    <ComposeModal title={isNew ? 'New item' : `Edit ${item.name}`} onClose={onClose} onSubmit={submit} submitLabel="Save" busy={busy} error={error}>
      <Field label="Item name" required><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pencil, Marker, Stapler pins" /></Field>
      <Field label="Warn me when left is at or below (optional)" hint="Example: 10 — the card turns orange when 10 or fewer are left.">
        <input inputMode="numeric" value={level} onChange={(e) => setLevel(e.target.value.replace(/[^0-9]/g, ''))} placeholder="e.g. 10" />
      </Field>
      {!isNew && (
        <div style={{ marginTop: 6 }}>
          {item.active
            ? <button type="button" className="btn btn-sm" onClick={() => hide(false)} disabled={busy}>Hide this item</button>
            : <button type="button" className="btn btn-sm" onClick={() => hide(true)} disabled={busy}>Show this item again</button>}
        </div>
      )}
    </ComposeModal>
  );
}

// ---- One person's history (+ Take back for the desk) --------------------------------------
function HistoryModal({ employeeId, canManage, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [back, setBack] = useState(null); // { itemId, quantity, note }
  const { busy, error, setError, run } = useSubmit();
  const [flash, setFlash] = useState('');
  function load() {
    api.get(`/stationery/employee/${employeeId}`).then((r) => setData(r.data)).catch((e) => setErr(errText(e, 'Could not load the history.')));
  }
  useEffect(load, [employeeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const holds = (data && data.totals.filter((t) => t.net > 0)) || [];
  async function takeBack() {
    const q = Number(back.quantity);
    if (!back.itemId) { setError('Pick the item.'); return; }
    if (!Number.isInteger(q) || q <= 0) { setError('Enter how many, 1 or more.'); return; }
    const res = await run(() => api.post('/stationery/return', { employeeId, itemId: back.itemId, quantity: q, note: back.note }), 'Could not save. Try again.');
    if (res) { setBack(null); setFlash(res.data.message); load(); onChanged(); }
  }
  const e = data && data.employee;
  return (
    <Modal title={e ? `${e.name}${e.employeeCode ? ` · ${e.employeeCode}` : ''}` : 'Stationery history'} size="wide" onClose={onClose}>
      {err && <div className="error-text">{err} <button type="button" className="btn btn-sm" onClick={() => { setErr(''); load(); }}>Try again</button></div>}
      {!data && !err && <div className="small-muted">Loading…</div>}
      {data && (
        <div className="stn">
          <div className="small-muted">{[e.department, (e.seats || []).join(', '), e.designation].filter(Boolean).join(' · ') || ' '}</div>
          <div className="stn-chips">
            {holds.length === 0 ? <span className="small-muted">Nothing given yet.</span>
              : holds.map((t) => <span key={t.itemId} className="stn-chip">{countOf(t.item, t.net)}</span>)}
          </div>
          {flash && <div className="stn-flash" role="status">{flash}</div>}
          {canManage && holds.length > 0 && !back && (
            <button type="button" className="btn btn-sm" onClick={() => { setError(''); setBack({ itemId: holds[0].itemId, quantity: '1', note: '' }); }}>Take back (wrong issue)</button>
          )}
          {back && (
            <div className="stn-back">
              <b>Take back</b>
              <div className="stn-back-row">
                <select value={back.itemId} onChange={(ev) => setBack({ ...back, itemId: ev.target.value })}>
                  {holds.map((t) => <option key={t.itemId} value={t.itemId}>{`${t.item} (has ${t.net})`}</option>)}
                </select>
                <input inputMode="numeric" value={back.quantity} onChange={(ev) => setBack({ ...back, quantity: ev.target.value.replace(/[^0-9]/g, '') })} aria-label="How many" />
                <input value={back.note} onChange={(ev) => setBack({ ...back, note: ev.target.value })} placeholder="Why? (optional)" />
              </div>
              {error && <div className="error-text">{error}</div>}
              <div className="stn-back-row">
                <button type="button" className="btn btn-primary btn-sm" onClick={takeBack} disabled={busy}>{busy ? 'Saving…' : 'Take back'}</button>
                <button type="button" className="btn btn-sm" onClick={() => setBack(null)}>Cancel</button>
              </div>
            </div>
          )}
          <div className="tbl-wrap" style={{ marginTop: 10 }}>
            <table>
              <thead><tr><th>Date</th><th>Item</th><th>How many</th><th>What</th><th>By</th><th>Note</th></tr></thead>
              <tbody>
                {data.rows.length === 0 && <tr><td colSpan={6} className="cell-muted">Nothing given yet.</td></tr>}
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td>{fmtDate(r.date)}</td><td>{r.item}</td>
                    <td><b>{r.kind === 'RETURN' ? `−${r.quantity}` : r.quantity}</b></td>
                    <td><span className={`status ${r.kind === 'RETURN' ? 'pending' : 'active'}`}>{r.kind === 'RETURN' ? 'Taken back' : r.batch ? 'Given (to many)' : 'Given'}</span></td>
                    <td className="cell-muted">{r.by || '—'}</td><td className="cell-muted">{r.note || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---- "Stationery given to you" (everyone, read-only) ---------------------------------------
export function MyStationery({ compact = false }) {
  const [data, setData] = useState(null);
  useEffect(() => { api.get('/stationery/mine').then((r) => setData(r.data)).catch(() => setData({ rows: [], totals: [] })); }, []);
  if (!data) return null;
  const has = data.totals.filter((t) => t.net > 0);
  return (
    <div className="card stn-mine">
      <h3>Stationery given to you</h3>
      {has.length === 0
        ? <div className="small-muted">Nothing given to you yet. Ask HR if you need a notepad or pen.</div>
        : <div className="stn-mine-big">{has.map((t) => countOf(t.item, t.net)).join(', ')}</div>}
      {!compact && data.rows.length > 0 && (
        <ul className="stn-mine-list">
          {data.rows.slice(0, 20).map((r) => (
            <li key={r.id}><span>{fmtDate(r.date)}</span><span>{r.kind === 'RETURN' ? `${countOf(r.item, r.quantity)} taken back` : countOf(r.item, r.quantity)}</span></li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- Employee-wise counts (the main thing) ---------------------------------------------------
const EMPTY = { department: '', employeeId: '', itemId: '', from: '', to: '', q: '', all: '' };
function WhoGotWhat({ reloadKey, onOpen, scope }) {
  const [f, setF] = useState(EMPTY);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busyX, setBusyX] = useState(false);
  const [xErr, setXErr] = useState('');
  const params = useMemo(() => Object.fromEntries(Object.entries(f).filter(([, v]) => v)), [f]);
  const key = JSON.stringify(params);
  useEffect(() => {
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      api.get('/stationery/employees', { params }).then((r) => { if (live) setData(r.data); }).catch(() => { if (live) setData({ items: [], rows: [], totals: {}, facets: {} }); })
        .finally(() => { if (live) setLoading(false); });
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [key, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = (data && data.rows) || [];
  const items = (data && data.items) || [];
  const page = usePaged(rows, 25);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v, ...(k === 'department' ? { employeeId: '' } : {}) }));
  const active = Object.entries(f).filter(([, v]) => v).length;
  async function excel() {
    setXErr('');
    setBusyX(true);
    try {
      const r = await api.get('/stationery/employees/export.xlsx', { params, responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url; a.download = `stationery-employee-wise-${todayYmd()}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch { setXErr('Could not make the Excel file. Try again.'); } finally { setBusyX(false); }
  }
  const facets = (data && data.facets) || {};
  return (
    <div className="stn-section">
      <div className="stn-filters">
        <FacetSelect label="Department" value={f.department} onChange={set('department')} options={facets.department} allLabel="All departments" loading={loading} />
        <FacetSelect label="Employee" value={f.employeeId} onChange={set('employeeId')} options={facets.employeeId} allLabel="Everyone" loading={loading} />
        <FacetSelect label="Item" value={f.itemId} onChange={set('itemId')} options={facets.itemId} allLabel="All items" loading={loading} />
        <label className="lph-facet"><span className="lph-facet-lbl">From</span><input type="date" value={f.from} onChange={(e) => set('from')(e.target.value)} /></label>
        <label className="lph-facet"><span className="lph-facet-lbl">To</span><input type="date" value={f.to} onChange={(e) => set('to')(e.target.value)} /></label>
        <label className="lph-facet"><span className="lph-facet-lbl">Search</span><input value={f.q} onChange={(e) => set('q')(e.target.value)} placeholder="Name or ID" /></label>
      </div>
      <div className="stn-tools">
        <label className="stn-check"><input type="checkbox" checked={f.all === '1'} onChange={(e) => set('all')(e.target.checked ? '1' : '')} /> Also show people who got nothing</label>
        {active > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setF(EMPTY)}>Clear filters</button>}
        <span className="stn-grow" />
        <button type="button" className="btn btn-sm" onClick={excel} disabled={busyX || rows.length === 0}>{busyX ? 'Making file…' : '⬇ Excel'}</button>
      </div>
      {xErr && <div className="error-text">{xErr}</div>}
      <div className="small-muted" style={{ margin: '4px 0 8px' }}>
        {data ? `${rows.length} ${rows.length === 1 ? 'person' : 'people'}${scope === 'team' ? ' in your team' : ''}. Click a name to see what they got and when.` : 'Loading…'}
      </div>
      <div className="tbl-wrap">
        <table className="stn-table">
          <thead>
            <tr>
              <th>Employee</th><th>Department</th>
              {items.map((i) => <th key={i.id} className="num">{`${titleCase(plural(i.name, 2))} given`}</th>)}
              <th className="num">Total</th><th>Last given</th>
            </tr>
          </thead>
          <tbody>
            {data && rows.length === 0 && (
              <tr><td colSpan={items.length + 4} className="cell-muted">
                {active ? 'Nobody matches these filters. Clear a filter to see more.' : 'No stationery given yet. Use "Give to employee" or "Give to many" to start.'}
              </td></tr>
            )}
            {page.slice.map((r) => (
              <tr key={r.id} className="stn-click" onClick={() => onOpen(r.id)}>
                <td><button type="button" className="stn-link" onClick={(e) => { e.stopPropagation(); onOpen(r.id); }}>{r.name}</button>
                  <div className="small-muted">{[r.employeeCode, (r.seats || []).join(', ')].filter(Boolean).join(' · ')}</div></td>
                <td className="cell-muted">{r.department || '—'}</td>
                {items.map((i) => <td key={i.id} className="num">{r.counts[i.id] ? <b>{r.counts[i.id]}</b> : <span className="cell-muted">—</span>}</td>)}
                <td className="num"><b>{r.total || '—'}</b></td>
                <td className="cell-muted">{fmtDate(r.lastGiven)}</td>
              </tr>
            ))}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr>
                <td><b>Total</b></td><td className="cell-muted">{`${rows.length} ${rows.length === 1 ? 'person' : 'people'}`}</td>
                {items.map((i) => <td key={i.id} className="num"><b>{(data.totals && data.totals[i.id]) || '—'}</b></td>)}
                <td className="num"><b>{items.reduce((s, i) => s + ((data.totals && data.totals[i.id]) || 0), 0)}</b></td><td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {rows.length > 25 && <Pager page={page} noun="people" />}
    </div>
  );
}

// ---- Per department: given / per person --------------------------------------------------------
function ByDepartment({ reloadKey }) {
  const [range, setRange] = useState({ from: '', to: '' });
  const [data, setData] = useState(null);
  useEffect(() => {
    const params = Object.fromEntries(Object.entries(range).filter(([, v]) => v));
    api.get('/stationery/departments', { params }).then((r) => setData(r.data)).catch(() => setData({ items: [], departments: [] }));
  }, [range, reloadKey]);
  const items = (data && data.items) || [];
  const list = (data && data.departments) || [];
  return (
    <div className="stn-section">
      <div className="stn-filters">
        <label className="lph-facet"><span className="lph-facet-lbl">From</span><input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} /></label>
        <label className="lph-facet"><span className="lph-facet-lbl">To</span><input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} /></label>
      </div>
      <div className="tbl-wrap">
        <table className="stn-table">
          <thead>
            <tr><th>Department</th><th className="num">People</th><th className="num">Got some</th>
              {items.map((i) => <th key={i.id} className="num">{`${i.name}: given / per person`}</th>)}</tr>
          </thead>
          <tbody>
            {data && list.length === 0 && <tr><td colSpan={items.length + 3} className="cell-muted">No stationery given yet.</td></tr>}
            {list.map((d) => (
              <tr key={d.department}>
                <td><b>{d.department}</b></td><td className="num">{d.people || '—'}</td><td className="num">{d.got || '—'}</td>
                {items.map((i) => <td key={i.id} className="num">{d.counts[i.id] ? <><b>{d.counts[i.id]}</b><span className="cell-muted">{d.perPerson[i.id] !== null ? ` / ${d.perPerson[i.id]}` : ''}</span></> : <span className="cell-muted">—</span>}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="small-muted" style={{ marginTop: 6 }}>"Per person" = given ÷ people working in that department now.</div>
    </div>
  );
}

// ---- Stock movement history ---------------------------------------------------------------------
function StockHistory({ items, reloadKey, canManage, onChanged }) {
  const [itemId, setItemId] = useState('');
  const [rows, setRows] = useState(null);
  const [msg, setMsg] = useState('');
  function load() {
    api.get('/stationery/movements', { params: itemId ? { itemId } : {} }).then((r) => setRows(r.data)).catch(() => setRows([]));
  }
  useEffect(load, [itemId, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const page = usePaged(rows || [], 25);
  async function remove(r) {
    if (!window.confirm(`Remove this stock entry (+${r.quantity} ${r.item})? Use this only for a wrong entry.`)) return;
    try { const res = await api.delete(`/stationery/stock/${r.id}`); setMsg(res.data.message); onChanged(); } catch (e) { setMsg(errText(e, 'Could not remove it.')); }
  }
  return (
    <div className="stn-section">
      <div className="stn-filters">
        <label className="lph-facet"><span className="lph-facet-lbl">Item</span>
          <select value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">All items</option>
            {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        </label>
      </div>
      {msg && <div className="stn-flash" role="status">{msg}</div>}
      <div className="tbl-wrap">
        <table className="stn-table">
          <thead><tr><th>Date</th><th>Item</th><th className="num">In / Out</th><th>What happened</th><th>By</th>{canManage && <th />}</tr></thead>
          <tbody>
            {rows && rows.length === 0 && <tr><td colSpan={canManage ? 6 : 5} className="cell-muted">No stock added yet. Use "+ Add stock" to start.</td></tr>}
            {page.slice.map((r) => (
              <tr key={`${r.kind}-${r.id}`}>
                <td>{fmtDate(r.date)}</td><td>{r.item}</td>
                <td className="num"><span className={`stn-move ${r.kind === 'OUT' ? 'out' : 'in'}`}>{r.kind === 'OUT' ? `−${r.quantity}` : `+${r.quantity}`}</span></td>
                <td>{r.text}{r.note ? <div className="small-muted">{r.note}</div> : null}</td>
                <td className="cell-muted">{r.by || '—'}</td>
                {canManage && <td>{r.kind === 'IN' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(r)}>Remove</button>}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(rows || []).length > 25 && <Pager page={page} noun="entries" />}
    </div>
  );
}

// ---- The tab ------------------------------------------------------------------------------------
export default function Stationery() {
  const [me, setMe] = useState(null);
  const [items, setItems] = useState([]);
  const [people, setPeople] = useState(null);
  const [modal, setModal] = useState(null); // 'stock' | 'give' | 'many' | { item } | 'newItem'
  const [history, setHistory] = useState(null);
  const [flash, setFlash] = useState(null); // { text, undoStockId }
  const [view, setView] = useState('who');
  const [reloadKey, setReloadKey] = useState(0);

  const [meTry, setMeTry] = useState(0);
  useEffect(() => { api.get('/stationery/me').then((r) => setMe(r.data)).catch((e) => setMe({ ready: false, retry: true, error: errText(e, 'Could not open Stationery. The server may be restarting.') })); }, [meTry]);
  const ready = me && me.ready;
  function loadItems() { if (ready) api.get('/stationery/items').then((r) => setItems(r.data)).catch(() => setItems([])); }
  useEffect(loadItems, [ready, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (ready && me.canManage) api.get('/stationery/people').then((r) => setPeople(r.data)).catch(() => setPeople({ departments: [], employees: [] })); }, [ready, me && me.canManage]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!me) return <div className="small-muted">Loading…</div>;
  if (!me.ready) return <div className="card stn-mine"><h3>Stationery</h3><div className="small-muted">{me.error || 'Stationery is not switched on yet.'}</div>{me.retry && <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => { setMe(null); setMeTry((n) => n + 1); }}>Try again</button>}</div>;

  const reload = () => setReloadKey((k) => k + 1);
  const saved = (text, undoStockId) => { setModal(null); setFlash({ text, undoStockId }); reload(); };
  async function undoStock(id) {
    try { const r = await api.delete(`/stationery/stock/${id}`); setFlash({ text: `Undone. ${r.data.message}` }); } catch (e) { setFlash({ text: errText(e, 'Could not undo.') }); }
    reload();
  }

  // An employee: only their own, read-only.
  if (me.self) {
    return (
      <div className="stn">
        <p className="stn-sub">Notepads, pens and other things the office gave you.</p>
        <MyStationery />
      </div>
    );
  }

  const shown = me.seeAll ? items : [];
  const tabs = [['who', 'Who got what'], ['dept', 'By department'], ...(me.seeAll ? [['stock', 'Stock history']] : [])];
  return (
    <div className="stn">
      <p className="stn-sub">{me.canManage
        ? 'Notepads, pens and other things: add stock, give them out, and see how many each person got.'
        : me.team ? "How many notepads, pens and other things your team got. (Only HR can give them.)"
          : 'How many notepads, pens and other things each person got. (View only.)'}</p>

      {me.team && me.employee && <MyStationery compact />}

      {me.canManage && (
        <div className="stn-actions">
          <button type="button" className="btn btn-primary stn-big" onClick={() => { setFlash(null); setModal('stock'); }}>+ Add stock</button>
          <button type="button" className="btn stn-big" onClick={() => { setFlash(null); setModal('give'); }}>Give to employee</button>
          <button type="button" className="btn stn-big" onClick={() => { setFlash(null); setModal('many'); }}>Give to many</button>
        </div>
      )}
      {flash && (
        <div className="stn-flash" role="status">{flash.text}
          {flash.undoStockId && <button type="button" className="btn btn-ghost btn-sm" onClick={() => undoStock(flash.undoStockId)}>Undo</button>}
        </div>
      )}

      {me.seeAll && (
        <div className="stn-cards">
          {shown.filter((i) => i.active || i.added > 0).map((i) => {
            const tone = i.left <= 0 ? 'red' : i.low ? 'amber' : 'ok';
            return (
              <div key={i.id} className={`stn-card ${tone}${i.active ? '' : ' hidden-item'}`}>
                <div className="stn-card-head">
                  <b>{i.name}</b>
                  {me.canManage && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setModal({ item: i })}>Edit</button>}
                </div>
                <div className="stn-card-left"><span>{i.left}</span> left</div>
                <div className="stn-card-nums"><span>Added <b>{i.added}</b></span><span>Given <b>{i.given}</b></span></div>
                {!i.active && <div className="small-muted">Hidden from the lists</div>}
                {i.active && i.left <= 0 && <div className="stn-card-warn">{i.added ? 'None left — add stock' : 'No stock yet — add stock'}</div>}
                {i.active && i.left > 0 && i.low && <div className="stn-card-warn">{`Running low (warn at ${i.reorderLevel})`}</div>}
              </div>
            );
          })}
          {me.canManage && <button type="button" className="stn-card stn-card-new" onClick={() => setModal('newItem')}>+ New item<small>e.g. Pencil, Marker</small></button>}
        </div>
      )}

      <div className="stn-views" role="tablist">
        {tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={view === k} className={`stn-view${view === k ? ' on' : ''}`} onClick={() => setView(k)}>{l}</button>)}
      </div>
      {view === 'who' && <WhoGotWhat reloadKey={reloadKey} onOpen={setHistory} scope={me.seeAll ? 'all' : 'team'} />}
      {view === 'dept' && <ByDepartment reloadKey={reloadKey} />}
      {view === 'stock' && me.seeAll && <StockHistory items={items} reloadKey={reloadKey} canManage={me.canManage} onChanged={reload} />}

      {me.canManage && me.employee && <div style={{ marginTop: 18 }}><MyStationery compact /></div>}

      {modal === 'stock' && <AddStockModal items={items} onClose={() => setModal(null)} onSaved={saved} />}
      {modal === 'give' && <GiveModal items={items} people={people} onClose={() => setModal(null)} onSaved={(t) => saved(t)} />}
      {modal === 'many' && <GiveManyModal items={items} people={people} onClose={() => setModal(null)} onSaved={(t) => saved(t)} />}
      {modal === 'newItem' && <ItemModal item={null} onClose={() => setModal(null)} onSaved={(t) => saved(t)} />}
      {modal && modal.item && <ItemModal item={modal.item} onClose={() => setModal(null)} onSaved={(t) => saved(t)} />}
      {history && <HistoryModal employeeId={history} canManage={me.canManage} onClose={() => setHistory(null)} onChanged={reload} />}
    </div>
  );
}
