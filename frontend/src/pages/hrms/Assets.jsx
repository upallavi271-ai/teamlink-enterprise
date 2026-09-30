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

// The inventory's own statuses (backend/src/routes/assetInventory.js) and an
// asset REQUEST's (an EmployeeRecord: raised Open, then Approved / Rejected).
const ASSET_STATUSES = ['Available', 'Assigned', 'In Repair', 'Retired'];
const REQUEST_STATUSES = ['Open', 'Approved', 'Rejected'];
const EMPTY_ASSET_FILTERS = { q: '', code: '', name: '', department: '', role: '', status: '', category: '', from: '', to: '' };
const EMPTY_REQUEST_FILTERS = { q: '', code: '', name: '', department: '', role: '', status: '', from: '', to: '' };
const holderOf = (a) => a.assignedTo || {};
const purchasedOf = (a) => a.purchaseDate || a.createdAt;
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

const ASSET_CATEGORIES = ['Laptop', 'Desktop', 'Monitor', 'Mobile', 'Headset', 'ID Card', 'Other'];

// The reference compose layout. One asset is ONE thing, so these forms keep
// single-target semantics: add one asset, and allocate (or transfer) it to
// one employee.
function AddAssetModal({ onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', category: 'Laptop', assetType: '', location: '', purchaseDate: new Date().toISOString().slice(0, 10), warrantyUntil: '' });
  const { busy, error, setError, run } = useSubmit();
  async function submit() {
    if (!form.name.trim()) { setError('Enter the asset name.'); return; }
    const res = await run(() => api.post('/asset-inventory', { ...form, name: form.name.trim(), warrantyUntil: form.warrantyUntil || null }), 'Could not add the asset');
    if (res) onSaved();
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
        <Field label="Warranty until"><input type="date" value={form.warrantyUntil} onChange={(e) => setForm({ ...form, warrantyUntil: e.target.value })} /></Field>
      </Row>
    </ComposeModal>
  );
}

function AllocateAssetModal({ asset, employees, onClose, onSaved }) {
  const [employeeId, setEmployeeId] = useState('');
  const { busy, error, setError, run } = useSubmit();
  const transfer = !!asset.assignedToId;
  async function submit() {
    if (!employeeId) { setError('Pick the employee.'); return; }
    const res = await run(() => api.patch(`/asset-inventory/${asset.id}/assign`, { employeeId }), 'Could not allocate the asset');
    if (res) onSaved();
  }
  return (
    <ComposeModal title={`${transfer ? 'Transfer' : 'Allocate'} — ${asset.name}`} onClose={onClose} onSubmit={submit} submitLabel={transfer ? 'Transfer' : 'Allocate'} busy={busy} error={error}>
      {transfer && <div className="small-muted" style={{ marginBottom: 10 }}>Currently with {asset.assignedToName}.</div>}
      <Field label={transfer ? 'Transfer to' : 'Allocate to'} required>
        <Combo value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
          <option value="">Select employee</option>
          {employees.filter((e) => e.id !== asset.assignedToId).map((e) => <option key={e.id} value={e.id}>{e.name}{e.employeeCode ? ` · ${e.employeeCode}` : ''}</option>)}
        </Combo>
      </Field>
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
  const [employees, setEmployees] = useState([]);
  const [af, setAf] = useState(EMPTY_ASSET_FILTERS);
  const [rf, setRf] = useState(EMPTY_REQUEST_FILTERS);
  const [sort, setSort] = useState('new');
  const [adding, setAdding] = useState(false);
  const [allocating, setAllocating] = useState(null);

  function load() {
    api.get('/asset-inventory').then((res) => setAssets(res.data)).catch(() => setAssets([]));
    api.get('/assets').then((res) => setRequests(res.data)).catch(() => setRequests([]));
    if (isHR) api.get('/employees').then((res) => setEmployees(res.data)).catch(() => setEmployees([]));
  }
  useEffect(load, [isHR]);

  function addAsset() { setAdding(true); }
  function assign(asset) { setAllocating(asset); }
  const assetModals = (
    <>
      {adding && <AddAssetModal onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />}
      {allocating && <AllocateAssetModal asset={allocating} employees={employees} onClose={() => setAllocating(null)} onSaved={() => { setAllocating(null); load(); }} />}
    </>
  );
  async function markReturned(asset) { await api.patch(`/asset-inventory/${asset.id}/return`); load(); }
  async function maintain(asset) { await api.patch(`/asset-inventory/${asset.id}/maintenance`); load(); }
  async function retire(asset) { await api.patch(`/asset-inventory/${asset.id}/retire`); load(); }
  async function decideRequest(r, status) { await api.patch(`/assets/${r.id}/status`, { status }); load(); }

  // THE INVENTORY FILTERS — asset code/name, the HOLDER's ID, name,
  // department and role (an unassigned asset has no holder, so it drops out
  // once any of those is set), the asset's own status and category, and the
  // purchase date. Shared by every inventory screen below.
  const shownAssets = assets.filter((a) => textMatches(`${a.assetCode} ${a.name} ${a.category || ''} ${a.assetType || ''} ${a.location || ''} ${a.assignedToName || ''}`, af.q)
    && peopleMatches(a, af, holderOf, undefined, purchasedOf)
    && (!af.category || (a.category || 'Other') === af.category))
    .sort((ASSET_SORTS.find(([k]) => k === sort) || ASSET_SORTS[0])[2]);
  const assigned = shownAssets.filter((a) => a.assignedToId);
  const assetOpts = peopleOptions(assets.filter((a) => a.assignedTo), holderOf);
  const assetCategories = [...new Set([...ASSET_CATEGORIES, ...assets.map((a) => a.category).filter(Boolean)])];
  const assetBar = (statuses = ASSET_STATUSES, rows = shownAssets) => (
    <PeopleFilterBar
      filters={af} setFilters={setAf} search="Asset code, name, type or location" people={hrView}
      departments={hrView ? assetOpts.departments : undefined} roles={hrView ? assetOpts.roles : undefined}
      statuses={statuses} shown={rows.length} total={assets.length}
      dates="Purchased on" labels={{ category: 'Category' }}
    >
      <Combo value={af.category} title="Category" onChange={(e) => setAf((f) => ({ ...f, category: e.target.value }))}>
        <option value="">All categories</option>
        {assetCategories.map((c) => <option key={c}>{c}</option>)}
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
  const page = usePaged(viewRows);
  const pager = <Pager page={page} noun={view === 'approval' ? 'requests' : 'assets'} />;

  // ---- Feature screens -------------------------------------------------
  if (view === 'inventory') {
    return (
      <FeatureScreen title="Asset Inventory & Allocation" sub="Every company asset and who holds it." onBack={onBack}>
        {assetModals}
        {assetBar()}
        <FeatureTable
          heads={['Code', 'Asset', 'Category', 'Assigned To', 'Status', '']}
          empty={emptyAssets('No assets yet.')}
          rows={page.slice.map((a) => (
            <tr key={a.id}>
              <td><b>{a.assetCode}</b></td><td>{a.name}</td>
              <td className="cell-muted">{a.category || '—'}</td>
              <td className="cell-muted">{a.assignedToName || 'Unassigned'}</td>
              <td><span className={`status ${a.status === 'Available' ? 'active' : 'pending'}`}>{a.status}</span></td>
              <td>{isHR && <button className="btn btn-sm" onClick={() => assign(a)}>Assign</button>}</td>
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
      <FeatureScreen title="Asset Maintenance & Repair" sub="Track assets currently out for repair." onBack={onBack}>
        {assetBar()}
        <FeatureTable
          heads={['Code', 'Asset', 'Status', '']}
          empty={emptyAssets('No assets yet.')}
          rows={page.slice.map((a) => (
            <tr key={a.id}>
              <td><b>{a.assetCode}</b></td><td>{a.name}</td>
              <td><span className={`status ${a.status === 'In Repair' ? 'pending' : 'active'}`}>{a.status}</span></td>
              <td>{isHR && <button className="btn btn-sm" onClick={() => maintain(a)}>{a.status === 'In Repair' ? 'Mark Repaired' : 'Send for Repair'}</button>}</td>
            </tr>
          ))}
        />
        {pager}
      </FeatureScreen>
    );
  }
  if (view === 'warranty') {
    return (
      <FeatureScreen title="Warranty Management" sub="Purchase and warranty dates per asset." onBack={onBack}>
        {assetBar()}
        <FeatureTable
          heads={['Code', 'Asset', 'Purchased', 'Warranty Until']}
          empty={emptyAssets('No assets yet.')}
          rows={page.slice.map((a) => (
            <tr key={a.id}>
              <td><b>{a.assetCode}</b></td><td>{a.name}</td>
              <td className="cell-muted">{a.purchaseDate || '—'}</td>
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
              <td><span className={`status ${a.status === 'Retired' ? 'rejected' : 'active'}`}>{a.status}</span></td>
              <td>{a.status !== 'Retired' && isHR ? <button className="btn btn-sm" onClick={() => retire(a)}>Retire</button> : '—'}</td>
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
          <NumHead n={1} title="Asset Inventory" />
          {shownAssets.length === 0 ? emptyAssets('No assets on file.') : page.slice.map((a) => (
            <AssignRow key={a.id}>
              <span>
                <b>{a.name}</b> <span className="cell-muted">{a.assetCode}</span><br />
                <span className="cell-muted" style={{ fontSize: 11.5 }}>
                  {a.category || '—'}{a.assignedToName ? ` · assigned to ${a.assignedToName}` : ' · unassigned'}
                </span>
              </span>
              <span className={`status ${a.status === 'Available' ? 'active' : a.status === 'Retired' ? 'rejected' : 'pending'}`}>{a.status}</span>
            </AssignRow>
          ))}
          {shownAssets.length > 0 && pager}
        </PanelPad>
        <FeatureTiles features={AS_FEATURES} onOpen={onOpen} />
      </TwoCol>
    </div>
  );
}
