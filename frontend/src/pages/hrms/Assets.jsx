import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  Panel, PanelPad, PanelHead, StatRow, AssignRow, EmptyMini, TwoCol, QaRow,
  NumHead, FeatureTiles, FeatureScreen, FeatureTable,
} from '../../components/proto.jsx';
import { isHR as hasHrmsAdmin, canManageServices } from '../../permissions';
import PeopleFilterBar, { peopleMatches, peopleOptions, statusOptions, textMatches } from '../../components/PeopleFilterBar.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import { ListEmpty } from '../../components/ui/ListFilters.jsx';
import Combo from '../../components/Combo.jsx';
import { ComposeModal, Field, Row, useSubmit } from '../../components/ComposeForm.jsx';
import AssetReport from './AssetReport.jsx';
import InsightsPanel from '../../components/charts/InsightsPanel.jsx';
import DataIoBar from '../../components/dataio/DataIoBar.jsx';
import { SendRepairModal, BackRepairModal, RepairHistoryModal, repairEntries } from './AssetRepair.jsx';
// Accounts spec S2: the fields Accounts needs + the repair log.
import { AccountsFields, DisposalFields, AssetRepairsModal, accountsDefaults, accountsNote } from './AssetAccountsFields.jsx';

// The inventory's own statuses (backend/src/routes/assetInventory.js) and an
// asset REQUEST's (an EmployeeRecord: raised Open, then Approved / Rejected).
const ASSET_STATUSES = ['Available', 'Assigned', 'In Repair', 'Retired', 'Sold', 'Written off'];
// Out of use: no assign / repair / retire buttons (Sold / Written off: Accounts spec S2).
const OUT_OF_USE = ['Retired', 'Sold', 'Written off'];
const REQUEST_STATUSES = ['Open', 'Approved', 'Rejected'];
const EMPTY_ASSET_FILTERS = { q: '', code: '', name: '', department: '', role: '', status: '', category: '', from: '', to: '' };
const EMPTY_REQUEST_FILTERS = { q: '', code: '', name: '', department: '', role: '', status: '', from: '', to: '' };
const holderOf = (a) => a.assignedTo || {};
const purchasedOf = (a) => a.purchaseDate || a.createdAt;
const rupees = (n) => (n === null || n === undefined || n === '' ? '—' : `₹${Number(n).toLocaleString('en-IN')}`);
const ASSET_SORTS = [
  ['new', 'Newest first', (a, b) => String(b.createdAt).localeCompare(String(a.createdAt))],
  ['name', 'Name A–Z', (a, b) => String(a.name || '').localeCompare(String(b.name || ''))],
  ['code', 'Asset code', (a, b) => String(a.assetCode || '').localeCompare(String(b.assetCode || ''), undefined, { numeric: true })],
  ['status', 'Status', (a, b) => String(a.status || '').localeCompare(String(b.status || ''))],
];

// The prototype's ten Asset feature tiles, in its order (AS_FEATURES, line 4421).
export const AS_FEATURES = [
  ['inventory', 'Asset Inventory & Allocation'],
  ['transfer', 'Asset Transfer'],
  ['return', 'Asset Return'],
  ['maintenance', 'Asset Maintenance & Repair'],
  ['warranty', 'Warranty Management'],
  ['disposal', 'Asset Disposal & History'],
  ['barcode', 'Barcode / QR Code Tracking'],
  ['approval', 'Asset Approval'],
  ['reports', 'Asset Reports & Analytics'],
  ['audit', 'Asset Audit'],
];

// SIM Card / Mobile Phone / Phone Charger: the SIM + phone import (2026-10-05).
const ASSET_CATEGORIES = ['Laptop', 'Desktop', 'Monitor', 'Mobile', 'Mobile Phone', 'Phone Charger', 'SIM Card', 'Headset', 'ID Card', 'Other'];

// The reference compose layout. One asset is ONE thing, so these forms keep
// single-target semantics: add one asset, and allocate (or transfer) it to
// one employee.
function AddAssetModal({ onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', category: 'Laptop', assetType: '', location: '', purchaseDate: new Date().toISOString().slice(0, 10), purchaseCost: '', warrantyUntil: '', ...accountsDefaults() });
  const { busy, error, setError, run } = useSubmit();
  async function submit() {
    if (!form.name.trim()) { setError('Enter the asset name.'); return; }
    const res = await run(() => api.post('/asset-inventory', { ...form, name: form.name.trim(), warrantyUntil: form.warrantyUntil || null }), 'Could not add the asset');
    if (res) onSaved(`Saved ${form.name.trim()}.${accountsNote(res.data)}`);
  }
  return (
    <ComposeModal title="Add Asset" onClose={onClose} onSubmit={submit} submitLabel="Add Asset" busy={busy} error={error}>
      <Field label="Asset name" required><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Dell Latitude 5440" /></Field>
      <Field label="Category">
        <Combo creatable value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
          {ASSET_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
        </Combo>
      </Field>
      <Row>
        <Field label="Asset type"><input value={form.assetType} onChange={(e) => setForm({ ...form, assetType: e.target.value })} placeholder="e.g. Latitude 5440" /></Field>
        <Field label="Location"><input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="e.g. Hyderabad office" /></Field>
      </Row>
      <Row>
        <Field label="Purchase date"><input type="date" value={form.purchaseDate} onChange={(e) => setForm({ ...form, purchaseDate: e.target.value })} /></Field>
        <Field label="Purchase cost (₹)"><input inputMode="numeric" value={form.purchaseCost} onChange={(e) => setForm({ ...form, purchaseCost: e.target.value })} placeholder="e.g. 55000" /></Field>
      </Row>
      <Row>
        <Field label="Warranty until"><input type="date" value={form.warrantyUntil} onChange={(e) => setForm({ ...form, warrantyUntil: e.target.value })} /></Field>
      </Row>
      <AccountsFields form={form} setForm={setForm} />
    </ComposeModal>
  );
}

// ASSIGN BY DEPARTMENT, THEN EMPLOYEE (user, 2026-10-05). Step 1 picks the
// department (every active one, with its number of active people); step 2
// lists only that department's active employees, with their employee ID.
// `people` is GET /asset-inventory/people: { departments, employees }.
const NO_DEPT = '__none__';
function AllocateAssetModal({ asset, people, onClose, onSaved }) {
  const transfer = !!asset.assignedToId;
  // Starts on the asset's seat department ("BDE EDU-1" -> BDE) when it has one.
  const [department, setDepartment] = useState(asset.seatDepartment || '');
  const [employeeId, setEmployeeId] = useState('');
  const { busy, error, setError, run } = useSubmit();
  const all = (people && people.employees) || [];
  const depts = (people && people.departments) || [];
  const inDept = department
    ? all.filter((e) => (department === NO_DEPT ? !e.department : e.department === department) && e.id !== asset.assignedToId)
    : [];
  async function submit() {
    if (!department) { setError('First pick the department.'); return; }
    if (!employeeId) { setError('Now pick the employee.'); return; }
    const res = await run(() => api.patch(`/asset-inventory/${asset.id}/assign`, { employeeId }), 'Could not assign the asset');
    if (res) onSaved(`${asset.name} ${transfer ? 'moved' : 'given'} to ${(all.find((e) => e.id === employeeId) || {}).name || 'the employee'}.`);
  }
  return (
    <ComposeModal title={`${transfer ? 'Transfer' : 'Assign'} — ${asset.name}${asset.seatDepartment ? ` (seat ${asset.location})` : ''}`} onClose={onClose} onSubmit={submit} submitLabel={transfer ? 'Transfer' : 'Assign'} busy={busy} error={error}>
      {transfer && <div className="small-muted" style={{ marginBottom: 10 }}>Now with {asset.assignedToName}{asset.assignedTo?.department ? ` (${asset.assignedTo.department})` : ''}.</div>}
      {!people && <div className="small-muted">Loading people…</div>}
      <Field label="1. Department" required>
        <Combo value={department} onChange={(e) => { setDepartment(e.target.value); setEmployeeId(''); }}>
          <option value="">Pick the department</option>
          {depts.map((d) => <option key={d.name} value={d.name}>{`${d.name} (${d.count} ${d.count === 1 ? 'person' : 'people'})`}</option>)}
          {people && people.noDepartment > 0 && <option value={NO_DEPT}>{`No department on file (${people.noDepartment})`}</option>}
        </Combo>
      </Field>
      {department && (
        <Field label={`2. ${transfer ? 'Transfer to' : 'Give to'}`} required>
          {inDept.length === 0
            ? <div className="small-muted">Nobody active in this department yet. Pick another department.</div>
            : (
              <Combo value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                <option value="">Pick the employee</option>
                {inDept.map((e) => <option key={e.id} value={e.id}>{`${e.name}${e.employeeCode ? ` · ${e.employeeCode}` : ''}${e.seats && e.seats.length ? ` · ${e.seats.join(', ')}` : e.designation ? ` · ${e.designation}` : ''}`}</option>)}
              </Combo>
            )}
        </Field>
      )}
    </ComposeModal>
  );
}

// EDIT AN ASSET (user, 2026-10-05: "Super Admin and HR can edit the assets").
// Shown only when the server says this login may edit (options.canEdit);
// the server checks again and writes every change to the asset's history.
// There is no serial-number / asset-tag column yet, so brand, model and
// serial go in "Asset type" — the search box finds them there.
function EditAssetModal({ asset, categories, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: asset.name || '', category: asset.category || 'Other', assetType: asset.assetType || '', location: asset.location || '',
    purchaseDate: asset.purchaseDate || '', purchaseCost: asset.purchaseCost ?? '', warrantyUntil: asset.warrantyUntil || '', status: asset.status,
    ...accountsDefaults(asset),
  });
  const { busy, error, setError, run } = useSubmit();
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  // Status follows the holder: Assigned only with a holder, Available only without.
  const statusChoices = asset.assignedToId ? ['Assigned', 'In Repair', 'Retired', 'Sold', 'Written off'] : ['Available', 'In Repair', 'Retired', 'Sold', 'Written off'];
  async function submit() {
    if (!form.name.trim()) { setError('Enter the asset name.'); return; }
    if ((form.status === 'Sold' || form.status === 'Written off') && !form.disposalDate) { setError(`Enter the date it was ${form.status === 'Sold' ? 'sold' : 'written off'}.`); return; }
    const res = await run(() => api.patch(`/asset-inventory/${asset.id}`, { ...form, name: form.name.trim() }), 'Could not save the asset');
    if (res) onSaved(`Saved ${form.name.trim()}.${accountsNote(res.data)}`);
  }
  return (
    <ComposeModal title={`Edit — ${asset.assetCode}`} onClose={onClose} onSubmit={submit} submitLabel="Save" busy={busy} error={error}>
      <div className="small-muted" style={{ marginBottom: 10 }}>{asset.assignedToName ? `With ${asset.assignedToName}${asset.assignedTo?.department ? ` (${asset.assignedTo.department})` : ''}. Use Assign / Return to move it.` : 'Not with anyone (in stock).'}</div>
      <Field label="Asset name" required><input value={form.name} onChange={set('name')} placeholder="Lenovo ThinkPad T470" /></Field>
      <Row>
        <Field label="Category">
          <Combo creatable value={form.category} onChange={set('category')}>
            {categories.map((c) => <option key={c}>{c}</option>)}
          </Combo>
        </Field>
        <Field label="Status">
          <select value={form.status} onChange={set('status')}>
            {[...new Set([form.status, ...statusChoices])].map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
      </Row>
      <Row>
        <Field label="Asset type (brand, model, serial)"><input value={form.assetType} onChange={set('assetType')} placeholder="e.g. Lenovo T470 · SN PF0VNAK8" /></Field>
        <Field label="Location"><input value={form.location} onChange={set('location')} placeholder="e.g. Office" /></Field>
      </Row>
      <Row>
        <Field label="Purchase date"><input type="date" value={form.purchaseDate} onChange={set('purchaseDate')} /></Field>
        <Field label="Purchase cost (₹)"><input inputMode="numeric" value={form.purchaseCost} onChange={set('purchaseCost')} placeholder="e.g. 55000" /></Field>
      </Row>
      <Row>
        <Field label="Warranty until"><input type="date" value={form.warrantyUntil} onChange={set('warrantyUntil')} /></Field>
      </Row>
      <DisposalFields form={form} setForm={setForm} status={form.status} />
      <AccountsFields form={form} setForm={setForm} />
    </ComposeModal>
  );
}

export default function Assets({ view, onOpen, onBack }) {
  const { user } = useAuth();
  // isHR here DRAWS WRITE CONTROLS, so it asks the write permission and not
  // only the read one. A Manager and an Assistant Manager are view-only (§3,
  // §4) and still hold Employee Management/view, so isHR() alone would have
  // gone on offering them every button on this screen. Both halves, because
  // the screen is an administration screen AND these are writes.
  const hrView = hasHrmsAdmin(user);
  const isHR = hrView && canManageServices(user);
  const [assets, setAssets] = useState([]);
  const [requests, setRequests] = useState([]);
  // GET /asset-inventory/people — departments + active employees for Assign.
  const [people, setPeople] = useState(null);
  // GET /asset-inventory/options — every active department, and canEdit.
  const [opts, setOpts] = useState(null);
  const [af, setAf] = useState(EMPTY_ASSET_FILTERS);
  const [rf, setRf] = useState(EMPTY_REQUEST_FILTERS);
  const [sort, setSort] = useState('new');
  const [adding, setAdding] = useState(false);
  const [allocating, setAllocating] = useState(null);
  const [editing, setEditing] = useState(null);
  // "Saved …" after Assign / Edit (simple-UX rule: always say what happened).
  const [flash, setFlash] = useState('');
  const canEdit = !!(opts && opts.canEdit);
  // Repair with the vendor's slip (AssetRepair.jsx): which modal is open,
  // for which asset id, and the "Saved …" line shown after an action.
  const [repair, setRepair] = useState(null); // { mode: 'send' | 'back' | 'history', id }
  const [repairFlash, setRepairFlash] = useState('');

  function load() {
    api.get('/asset-inventory').then((res) => setAssets(res.data)).catch(() => setAssets([]));
    api.get('/assets').then((res) => setRequests(res.data)).catch(() => setRequests([]));
    api.get('/asset-inventory/options').then((res) => setOpts(res.data)).catch(() => setOpts(null));
    if (isHR) api.get('/asset-inventory/people').then((res) => setPeople(res.data)).catch(() => setPeople({ departments: [], employees: [] }));
  }
  useEffect(load, [isHR]);

  function addAsset() { setAdding(true); }
  function assign(asset) { setFlash(''); setAllocating(asset); }
  function edit(asset) { setFlash(''); setEditing(asset); }
  const done = (close) => (message) => { close(null); if (message) setFlash(message); load(); };
  const assetModals = (
    <>
      {adding && <AddAssetModal onClose={() => setAdding(false)} onSaved={(m) => { setAdding(false); setFlash(m || 'Asset added.'); load(); }} />}
      {allocating && <AllocateAssetModal asset={allocating} people={people} onClose={() => setAllocating(null)} onSaved={done(setAllocating)} />}
      {editing && <EditAssetModal asset={editing} categories={[...new Set([...ASSET_CATEGORIES, ...assets.map((a) => a.category).filter(Boolean)])]} onClose={() => setEditing(null)} onSaved={done(setEditing)} />}
      {flash && <div className="asrep-flash" role="status">{flash}</div>}
    </>
  );
  async function markReturned(asset) { await api.patch(`/asset-inventory/${asset.id}/return`); load(); }
  // A repair action answers with the saved asset; put it in the list at once
  // so the open repair history shows the new entry.
  function repairSaved(updated, message) {
    if (updated && updated.id) setAssets((list) => list.map((x) => (x.id === updated.id ? updated : x)));
    if (message) { setRepair(null); setRepairFlash(message); }
  }
  async function retire(asset) { await api.patch(`/asset-inventory/${asset.id}/retire`); load(); }
  async function decideRequest(r, status) { await api.patch(`/assets/${r.id}/status`, { status }); load(); }

  // THE INVENTORY FILTERS — asset code/name, the HOLDER's ID, name,
  // department and role (an unassigned asset has no holder, so it drops out
  // once any of those is set), the asset's own status and category, and the
  // purchase date. Shared by every inventory screen below.
  // Department = the holder's, or for an asset in stock the department of its
  // seat (location "BDE EDU-1", "HR", "R&D-3") — the server's departmentArm.
  // The server decides it once (assetInventory.js deptOfSeat: the seat code's
  // FIRST word — "BDE MED" is BDE) and sends it as a.department.
  const inDept = (a, d) => !d || a.department === d;
  const shownAssets = assets.filter((a) => textMatches(`${a.assetCode} ${a.name} ${a.category || ''} ${a.assetType || ''} ${a.location || ''} ${a.assignedToName || ''}`, af.q)
    && peopleMatches(a, { ...af, department: '' }, holderOf, undefined, purchasedOf) && inDept(a, af.department)
    && (!af.category || (a.category || 'Other') === af.category))
    .sort((ASSET_SORTS.find(([k]) => k === sort) || ASSET_SORTS[0])[2]);
  const assigned = shownAssets.filter((a) => a.assignedToId);
  const assetOpts = peopleOptions(assets.filter((a) => a.assignedTo), holderOf);
  // DEPARTMENT FILTER = every active department (server list, scoped by role),
  // each with how many assets its people hold among the rows matching the
  // OTHER filters — so it cascades. 0 shows "(0)" and stays pickable (user ask).
  const otherThanDept = assets.filter((a) => textMatches(`${a.assetCode} ${a.name} ${a.category || ''} ${a.assetType || ''} ${a.location || ''} ${a.assignedToName || ''}`, af.q)
    && peopleMatches(a, { ...af, department: '' }, holderOf, undefined, purchasedOf)
    && (!af.category || (a.category || 'Other') === af.category));
  const deptNames = [...new Set([...((opts && opts.departments) || []), ...assetOpts.departments])].sort((x, y) => x.localeCompare(y));
  const deptHeld = {};
  otherThanDept.forEach((a) => {
    const d = a.department;
    if (d) deptHeld[d] = (deptHeld[d] || 0) + 1;
  });
  const deptOptions = deptNames.map((d) => ({ value: d, label: `${d} (${deptHeld[d] || 0})` }));
  // Category counts the same way (rows matching every filter but category).
  const catHeld = {};
  assets.filter((a) => textMatches(`${a.assetCode} ${a.name} ${a.category || ''} ${a.assetType || ''} ${a.location || ''} ${a.assignedToName || ''}`, af.q)
    && peopleMatches(a, { ...af, department: '' }, holderOf, undefined, purchasedOf) && inDept(a, af.department))
    .forEach((a) => { const c = a.category || 'Other'; catHeld[c] = (catHeld[c] || 0) + 1; });
  const assetCategories = [...new Set([...ASSET_CATEGORIES, ...assets.map((a) => a.category).filter(Boolean)])];
  const assetBar = (statuses = ASSET_STATUSES, rows = shownAssets) => (
    <PeopleFilterBar
      filters={af} setFilters={setAf} search="Asset code, name, type or location" people={hrView}
      departments={hrView ? deptOptions : undefined} roles={hrView ? assetOpts.roles : undefined}
      statuses={statuses} shown={rows.length} total={assets.length}
      dates="Purchased on" labels={{ category: 'Category' }}
    >
      <Combo value={af.category} title="Category" onChange={(e) => setAf((f) => ({ ...f, category: e.target.value }))}>
        <option value="">All categories</option>
        {assetCategories.map((c) => [c, catHeld[c] || 0]).filter(([c, n]) => n > 0 || c === af.category)
          .map(([c, n]) => <option key={c} value={c}>{`${c} (${n})`}</option>)}
      </Combo>
      <label className="lf-sort">
        Sort
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          {ASSET_SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
    </PeopleFilterBar>
  );
  const afLike = { activeCount: Object.values(af).filter(Boolean).length, clear: () => setAf(EMPTY_ASSET_FILTERS) };
  const emptyAssets = (none) => <ListEmpty lf={afLike} noun="assets" title={none} />;

  // Asset REQUESTS are per employee, with the request's own status.
  const shownRequests = requests.filter((r) => textMatches(`${r.title} ${r.detail || ''} ${r.employee?.name || ''}`, rf.q) && peopleMatches(r, rf));
  const requestOpts = peopleOptions(requests);
  const rfLike = { activeCount: Object.values(rf).filter(Boolean).length, clear: () => setRf(EMPTY_REQUEST_FILTERS) };

  // The rows the open screen lists — paged 25 / 50 / 100.
  const viewRows = view === 'approval' ? shownRequests
    : ['transfer', 'return'].includes(view) ? assigned
      : shownAssets;
  // ALL ASSETS ON ONE PAGE (user, 2026-10-05: "all assets are not clearly
  // visible"). 250 a page, so the whole register (124 today) shows at once;
  // the pager only appears past 250.
  const page = usePaged(viewRows, 250);
  const pager = <Pager page={page} noun={view === 'approval' ? 'requests' : 'assets'} />;

  // ---- Feature screens -------------------------------------------------
  if (view === 'inventory') {
    return (
      <FeatureScreen title="Asset Inventory & Allocation" sub="Every company asset and who holds it." onBack={onBack}>
        {assetModals}
        {assetBar()}
        <FeatureTable
          heads={['Code', 'Asset', 'Category', 'With', 'Seat', 'Department', 'Status', '']}
          empty={emptyAssets('No assets yet.')}
          rows={page.slice.map((a) => (
            <tr key={a.id}>
              <td><b>{a.assetCode}</b></td><td>{a.name}{a.assetType ? <div className="small-muted">{a.assetType}</div> : null}</td>
              <td className="cell-muted">{a.category || '—'}</td>
              <td className="cell-muted">{a.assignedTo ? <>{a.assignedToName}{a.assignedTo.employeeCode ? <div className="small-muted">{a.assignedTo.employeeCode}</div> : null}</> : 'In stock'}</td>
              <td className="cell-muted">{a.seatDepartment ? <b>{a.location}</b> : '—'}</td>
              <td className="cell-muted">{a.department || '—'}{a.assignedTo && a.seatDepartment && a.seatDepartment !== a.assignedTo.department ? <div className="small-muted">seat is {a.seatDepartment}</div> : null}</td>
              <td><span className={`status ${a.status === 'Available' ? 'active' : OUT_OF_USE.includes(a.status) ? 'rejected' : 'pending'}`}>{a.status}</span></td>
              <td>
                <div className="asrep-row-actions">
                  {isHR && !OUT_OF_USE.includes(a.status) && <button className="btn btn-sm" onClick={() => assign(a)}>{a.assignedToId ? 'Transfer' : 'Assign'}</button>}
                  {canEdit && <button className="btn btn-sm" onClick={() => edit(a)}>Edit</button>}
                </div>
              </td>
            </tr>
          ))}
        />
        {pager}
      </FeatureScreen>
    );
  }
  if (view === 'transfer') {
    return (
      <FeatureScreen title="Asset Transfer" sub="Move an assigned asset from one employee to another." onBack={onBack}>
        {assetModals}
        {assetBar(null, assigned)}
        <FeatureTable
          heads={['Code', 'Asset', 'Currently With', '']}
          empty={emptyAssets('No assigned assets.')}
          rows={page.slice.map((a) => (
            <tr key={a.id}>
              <td><b>{a.assetCode}</b></td><td>{a.name}</td>
              <td className="cell-muted">{a.assignedToName}</td>
              <td>{isHR && <button className="btn btn-sm" onClick={() => assign(a)}>Transfer</button>}</td>
            </tr>
          ))}
        />
        {pager}
      </FeatureScreen>
    );
  }
  if (view === 'return') {
    return (
      <FeatureScreen title="Asset Return" sub="Return an asset to the pool when an employee hands it back." onBack={onBack}>
        {assetBar(null, assigned)}
        <FeatureTable
          heads={['Code', 'Asset', 'Held By', '']}
          empty={emptyAssets('No assets to return.')}
          rows={page.slice.map((a) => (
            <tr key={a.id}>
              <td><b>{a.assetCode}</b></td><td>{a.name}</td>
              <td className="cell-muted">{a.assignedToName}</td>
              <td>{isHR && <button className="btn btn-sm" onClick={() => markReturned(a)}>Mark Returned</button>}</td>
            </tr>
          ))}
        />
        {pager}
      </FeatureScreen>
    );
  }
  if (view === 'maintenance') {
    return (
      <FeatureScreen title="Asset Maintenance & Repair" sub="Send an asset for repair, keep the vendor's slip, and see every repair." onBack={onBack}>
        {repairFlash && <div className="asrep-flash" role="status">{repairFlash}</div>}
        {(() => {
          const open = repair && assets.find((x) => x.id === repair.id);
          if (!open) return null;
          if (repair.mode === 'send') return <SendRepairModal asset={open} onClose={() => setRepair(null)} onSaved={repairSaved} />;
          if (repair.mode === 'back') return <BackRepairModal asset={open} onClose={() => setRepair(null)} onSaved={repairSaved} />;
          if (repair.mode === 'log') return <AssetRepairsModal asset={open} canEdit={isHR} onClose={() => { setRepair(null); load(); }} />;
          return <RepairHistoryModal asset={open} canEdit={isHR} onClose={() => setRepair(null)} onChanged={(u) => repairSaved(u)} />;
        })()}
        {assetBar()}
        <FeatureTable
          heads={['Code', 'Asset', 'Status', 'Repairs', '']}
          empty={emptyAssets('No assets yet.')}
          rows={page.slice.map((a) => {
            const reps = repairEntries(a);
            const now = a.status === 'In Repair' && reps.find((h) => h.kind === 'repair' && h.step === 'sent');
            return (
              <tr key={a.id}>
                <td><b>{a.assetCode}</b></td><td>{a.name}</td>
                <td><span className={`status ${a.status === 'In Repair' ? 'pending' : OUT_OF_USE.includes(a.status) ? 'rejected' : 'active'}`}>{a.status}</span></td>
                <td className="cell-muted">
                  {now ? `With ${now.vendor}${now.expectedBack ? `, back by ${now.expectedBack}` : ''}` : reps.length ? `${reps.filter((h) => h.step !== 'back' && h.text !== 'Repair completed').length} repair(s)` : 'No repairs yet'}
                </td>
                <td>
                  <div className="asrep-row-actions">
                    {isHR && a.status === 'In Repair' && <button className="btn btn-sm btn-primary" onClick={() => { setRepairFlash(''); setRepair({ mode: 'back', id: a.id }); }}>Back from repair</button>}
                    {isHR && !['In Repair', ...OUT_OF_USE].includes(a.status) && <button className="btn btn-sm" onClick={() => { setRepairFlash(''); setRepair({ mode: 'send', id: a.id }); }}>Send for repair</button>}
                    <button className="btn btn-sm" onClick={() => setRepair({ mode: 'history', id: a.id })}>Repair history</button>
                    <button className="btn btn-sm" onClick={() => setRepair({ mode: 'log', id: a.id })}>Repairs &amp; costs</button>
                  </div>
                </td>
              </tr>
            );
          })}
        />
        {pager}
      </FeatureScreen>
    );
  }
  if (view === 'warranty') {
    return (
      <FeatureScreen title="Warranty Management" sub="Purchase date, cost and warranty per asset." onBack={onBack}>
        {assetBar()}
        <FeatureTable
          heads={['Code', 'Asset', 'Purchased', 'Cost', 'Warranty Until']}
          empty={emptyAssets('No assets yet.')}
          rows={page.slice.map((a) => (
            <tr key={a.id}>
              <td><b>{a.assetCode}</b></td><td>{a.name}</td>
              <td className="cell-muted">{a.purchaseDate || '—'}</td>
              <td className="cell-muted">{rupees(a.purchaseCost)}</td>
              <td className="cell-muted">{a.warrantyUntil || 'Not recorded'}</td>
            </tr>
          ))}
        />
        {pager}
      </FeatureScreen>
    );
  }
  if (view === 'disposal') {
    return (
      <FeatureScreen title="Asset Disposal & History" sub="Retire an asset at end of life; the record is kept, never deleted." onBack={onBack}>
        {assetBar()}
        <FeatureTable
          heads={['Code', 'Asset', 'Status', '']}
          empty={emptyAssets('No assets yet.')}
          rows={page.slice.map((a) => (
            <tr key={a.id}>
              <td><b>{a.assetCode}</b></td><td>{a.name}</td>
              <td><span className={`status ${OUT_OF_USE.includes(a.status) ? 'rejected' : 'active'}`}>{a.status}</span></td>
              <td>{!OUT_OF_USE.includes(a.status) && isHR ? <button className="btn btn-sm" onClick={() => retire(a)}>Retire</button> : '—'}</td>
            </tr>
          ))}
        />
        {pager}
      </FeatureScreen>
    );
  }
  if (view === 'barcode') {
    return (
      <FeatureScreen title="Barcode / QR Code Tracking" sub="Each asset carries a scannable code (simulated in this prototype)." onBack={onBack}>
        {assetBar()}
        <FeatureTable
          heads={['Code', 'Asset', 'Barcode']}
          empty={emptyAssets('No assets yet.')}
          rows={page.slice.map((a) => (
            <tr key={a.id}>
              <td><b>{a.assetCode}</b></td><td>{a.name}</td>
              <td style={{ fontFamily: 'monospace' }}>{`TL-${String(a.assetCode).replace(/\D/g, '').slice(-6).padStart(6, '0')}`}</td>
            </tr>
          ))}
        />
        {pager}
      </FeatureScreen>
    );
  }
  if (view === 'approval') {
    return (
      <FeatureScreen title="Asset Approval" sub="Employee asset requests awaiting a decision." onBack={onBack}>
        <PeopleFilterBar
          filters={rf} setFilters={setRf} search="Asset requested" people={hrView}
          departments={hrView ? requestOpts.departments : undefined} roles={hrView ? requestOpts.roles : undefined}
          statuses={statusOptions(requests, REQUEST_STATUSES)} shown={shownRequests.length} total={requests.length}
          dates="Requested on"
        />
        <FeatureTable
          heads={['Employee', 'Asset', 'Status', '']}
          empty={<ListEmpty lf={rfLike} noun="asset requests" />}
          rows={page.slice.map((r) => (
            <tr key={r.id}>
              <td>{r.employee?.name || '—'}</td>
              <td>{r.title}</td>
              <td><span className={`status ${r.status === 'Approved' ? 'active' : r.status === 'Rejected' ? 'rejected' : 'pending'}`}>{r.status}</span></td>
              <td>{isHR && ['Pending', 'Open'].includes(r.status) ? (
                <>
                  <button className="btn btn-sm btn-primary" onClick={() => decideRequest(r, 'Approved')}>Approve</button>{' '}
                  <button className="btn btn-sm btn-danger" onClick={() => decideRequest(r, 'Rejected')}>Reject</button>
                </>
              ) : '—'}</td>
            </tr>
          ))}
        />
        {pager}
      </FeatureScreen>
    );
  }
  if (view === 'reports') {
    const byCat = {};
    assets.forEach((a) => { const c = a.category || 'Other'; byCat[c] = (byCat[c] || 0) + 1; });
    return (
      <FeatureScreen title="Asset Reports & Analytics" sub="Filter the register, then export exactly what you see." onBack={onBack}>
        {/* The asset tiles and charts live once, on the Assets tab itself. */}
        <Panel>
          <PanelHead title="By Category" />
          {Object.keys(byCat).length === 0
            ? <EmptyMini>No assets yet.</EmptyMini>
            : Object.keys(byCat).map((c) => <AssignRow key={c}><span>{c}</span><b>{byCat[c]}</b></AssignRow>)}
        </Panel>
        {/* hrms-24 §6 — the filterable, exportable asset report. */}
        <AssetReport />
      </FeatureScreen>
    );
  }
  if (view === 'audit') {
    return (
      <FeatureScreen title="Asset Audit" sub="Each asset's movement history for audit." onBack={onBack}>
        {assetBar()}
        <FeatureTable
          heads={['Code', 'Asset', 'History', 'Currently With']}
          empty={emptyAssets('No assets yet.')}
          rows={page.slice.map((a) => (
            <tr key={a.id}>
              <td><b>{a.assetCode}</b></td><td>{a.name}</td>
              <td className="cell-muted">{(a.history || []).length} event(s)</td>
              <td className="cell-muted">{a.assignedToName || 'Unassigned'}</td>
            </tr>
          ))}
        />
        {pager}
      </FeatureScreen>
    );
  }

  // ---- Tab body --------------------------------------------------------
  return (
    <div>
      {/* hrms-24 §1 / §9 — assigned / available / maintenance now, and what
          was assigned and returned inside the range, in this login's scope.
          The filtered register export is on Asset Reports. */}
      <InsightsPanel module="assets" storageKey="tl_range_assets" exportModule={null} />

      <QaRow style={{ margin: '14px 0' }}>
        {isHR && <button className="btn btn-primary btn-sm" onClick={addAsset}>+ Add Asset</button>}
        {/* The asset register: export all (company stock + holders in scope)
            / the assets one employee holds, and import with the compulsory
            sample (src/io/assets.js). Rights come from the server. */}
        <DataIoBar ioKey="assets" onImported={load} />
        {assetModals}
      </QaRow>

      {assetBar()}

      <TwoCol style={{ alignItems: 'start' }}>
        <PanelPad>
          <NumHead n={1} title={`Asset Inventory — ${shownAssets.length === assets.length ? `all ${assets.length}` : `${shownAssets.length} of ${assets.length}`} assets`} />
          {shownAssets.length === 0 ? emptyAssets('No assets on file.') : page.slice.map((a) => (
            <AssignRow key={a.id}>
              <span>
                <b>{a.name}</b> <span className="cell-muted">{a.assetCode}</span><br />
                <span className="cell-muted" style={{ fontSize: 11.5 }}>
                  {a.category || '—'}{a.assignedToName ? ` · with ${a.assignedToName}${a.assignedTo?.employeeCode ? ` (${a.assignedTo.employeeCode})` : ''}${a.assignedTo?.department ? ` · ${a.assignedTo.department}` : ''}` : ` · in stock${a.department ? ` · ${a.department}` : ''}`}{a.seatDepartment ? ` · seat ${a.location}` : ''}
                </span>
              </span>
              <span className="asrep-row-actions" style={{ alignItems: 'center' }}>
                <span className={`status ${a.status === 'Available' ? 'active' : OUT_OF_USE.includes(a.status) ? 'rejected' : 'pending'}`}>{a.status}</span>
                {isHR && !OUT_OF_USE.includes(a.status) && <button className="btn btn-sm" onClick={() => assign(a)}>{a.assignedToId ? 'Transfer' : 'Assign'}</button>}
                {canEdit && <button className="btn btn-sm" onClick={() => edit(a)}>Edit</button>}
              </span>
            </AssignRow>
          ))}
          {shownAssets.length > 0 && pager}
        </PanelPad>
        <FeatureTiles features={AS_FEATURES} onOpen={onOpen} />
      </TwoCol>
    </div>
  );
}
