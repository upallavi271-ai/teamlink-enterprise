import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  Panel, PanelPad, PanelHead, StatRow, AssignRow, EmptyMini, TwoCol, QaRow,
  NumHead, FeatureTiles, FeatureScreen, FeatureTable,
} from '../../components/proto.jsx';
import { isHR as hasHrmsAdmin, canManageServices } from '../../permissions';


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

export default function Assets({ view, onOpen, onBack }) {
  const { user } = useAuth();
  // isHR here DRAWS WRITE CONTROLS, so it asks the write permission and not
  // only the read one. A Manager and an Assistant Manager are view-only (§3,
  // §4) and still hold Employee Management/view, so isHR() alone would have
  // gone on offering them every button on this screen. Both halves, because
  // the screen is an administration screen AND these are writes.
  const isHR = hasHrmsAdmin(user) && canManageServices(user);
  const [assets, setAssets] = useState([]);
  const [requests, setRequests] = useState([]);
  const [employees, setEmployees] = useState([]);

  function load() {
    api.get('/asset-inventory').then((res) => setAssets(res.data)).catch(() => setAssets([]));
    api.get('/assets').then((res) => setRequests(res.data)).catch(() => setRequests([]));
    if (isHR) api.get('/employees').then((res) => setEmployees(res.data)).catch(() => setEmployees([]));
  }
  useEffect(load, [isHR]);

  async function addAsset() {
    const name = prompt('Asset name?');
    if (!name || !name.trim()) return;
    const category = prompt('Category?', 'Laptop') || 'Laptop';
    await api.post('/asset-inventory', { name: name.trim(), category });
    load();
  }
  async function assign(asset) {
    const list = employees.map((e, i) => `${i + 1}. ${e.name}`).join('\n');
    const pick = prompt(`Assign to:\n${list}`, '1');
    if (pick === null) return;
    const emp = employees[(Number(pick) || 1) - 1];
    if (!emp) return;
    await api.patch(`/asset-inventory/${asset.id}/assign`, { employeeId: emp.id });
    load();
  }
  async function markReturned(asset) { await api.patch(`/asset-inventory/${asset.id}/return`); load(); }
  async function maintain(asset) { await api.patch(`/asset-inventory/${asset.id}/maintenance`); load(); }
  async function retire(asset) { await api.patch(`/asset-inventory/${asset.id}/retire`); load(); }
  async function decideRequest(r, status) { await api.patch(`/assets/${r.id}/status`, { status }); load(); }

  const assigned = assets.filter((a) => a.assignedToId);

  // ---- Feature screens -------------------------------------------------
  if (view === 'inventory') {
    return (
      <FeatureScreen title="Asset Inventory & Allocation" sub="Every company asset and who holds it." onBack={onBack}>
        <FeatureTable
          heads={['Code', 'Asset', 'Category', 'Assigned To', 'Status', '']}
          empty="No assets yet."
          rows={assets.map((a) => (
            <tr key={a.id}>
              <td><b>{a.assetCode}</b></td><td>{a.name}</td>
              <td className="cell-muted">{a.category || '—'}</td>
              <td className="cell-muted">{a.assignedToName || 'Unassigned'}</td>
              <td><span className={`status ${a.status === 'Available' ? 'active' : 'pending'}`}>{a.status}</span></td>
              <td>{isHR && <button className="btn btn-sm" onClick={() => assign(a)}>Assign</button>}</td>
            </tr>
          ))}
        />
      </FeatureScreen>
    );
  }
  if (view === 'transfer') {
    return (
      <FeatureScreen title="Asset Transfer" sub="Move an assigned asset from one employee to another." onBack={onBack}>
        <FeatureTable
          heads={['Code', 'Asset', 'Currently With', '']}
          empty="No assigned assets."
          rows={assigned.map((a) => (
            <tr key={a.id}>
              <td><b>{a.assetCode}</b></td><td>{a.name}</td>
              <td className="cell-muted">{a.assignedToName}</td>
              <td>{isHR && <button className="btn btn-sm" onClick={() => assign(a)}>Transfer</button>}</td>
            </tr>
          ))}
        />
      </FeatureScreen>
    );
  }
  if (view === 'return') {
    return (
      <FeatureScreen title="Asset Return" sub="Return an asset to the pool when an employee hands it back." onBack={onBack}>
        <FeatureTable
          heads={['Code', 'Asset', 'Held By', '']}
          empty="No assets to return."
          rows={assigned.map((a) => (
            <tr key={a.id}>
              <td><b>{a.assetCode}</b></td><td>{a.name}</td>
              <td className="cell-muted">{a.assignedToName}</td>
              <td>{isHR && <button className="btn btn-sm" onClick={() => markReturned(a)}>Mark Returned</button>}</td>
            </tr>
          ))}
        />
      </FeatureScreen>
    );
  }
  if (view === 'maintenance') {
    return (
      <FeatureScreen title="Asset Maintenance & Repair" sub="Track assets currently out for repair." onBack={onBack}>
        <FeatureTable
          heads={['Code', 'Asset', 'Status', '']}
          empty="No assets yet."
          rows={assets.map((a) => (
            <tr key={a.id}>
              <td><b>{a.assetCode}</b></td><td>{a.name}</td>
              <td><span className={`status ${a.status === 'In Repair' ? 'pending' : 'active'}`}>{a.status}</span></td>
              <td>{isHR && <button className="btn btn-sm" onClick={() => maintain(a)}>{a.status === 'In Repair' ? 'Mark Repaired' : 'Send for Repair'}</button>}</td>
            </tr>
          ))}
        />
      </FeatureScreen>
    );
  }
  if (view === 'warranty') {
    return (
      <FeatureScreen title="Warranty Management" sub="Purchase and warranty dates per asset." onBack={onBack}>
        <FeatureTable
          heads={['Code', 'Asset', 'Purchased', 'Warranty Until']}
          empty="No assets yet."
          rows={assets.map((a) => (
            <tr key={a.id}>
              <td><b>{a.assetCode}</b></td><td>{a.name}</td>
              <td className="cell-muted">{a.purchaseDate || '—'}</td>
              <td className="cell-muted">{a.warrantyUntil || 'Not recorded'}</td>
            </tr>
          ))}
        />
      </FeatureScreen>
    );
  }
  if (view === 'disposal') {
    return (
      <FeatureScreen title="Asset Disposal & History" sub="Retire an asset at end of life; the record is kept, never deleted." onBack={onBack}>
        <FeatureTable
          heads={['Code', 'Asset', 'Status', '']}
          empty="No assets yet."
          rows={assets.map((a) => (
            <tr key={a.id}>
              <td><b>{a.assetCode}</b></td><td>{a.name}</td>
              <td><span className={`status ${a.status === 'Retired' ? 'rejected' : 'active'}`}>{a.status}</span></td>
              <td>{a.status !== 'Retired' && isHR ? <button className="btn btn-sm" onClick={() => retire(a)}>Retire</button> : '—'}</td>
            </tr>
          ))}
        />
      </FeatureScreen>
    );
  }
  if (view === 'barcode') {
    return (
      <FeatureScreen title="Barcode / QR Code Tracking" sub="Each asset carries a scannable code (simulated in this prototype)." onBack={onBack}>
        <FeatureTable
          heads={['Code', 'Asset', 'Barcode']}
          empty="No assets yet."
          rows={assets.map((a) => (
            <tr key={a.id}>
              <td><b>{a.assetCode}</b></td><td>{a.name}</td>
              <td style={{ fontFamily: 'monospace' }}>{`TL-${String(a.assetCode).replace(/\D/g, '').slice(-6).padStart(6, '0')}`}</td>
            </tr>
          ))}
        />
      </FeatureScreen>
    );
  }
  if (view === 'approval') {
    return (
      <FeatureScreen title="Asset Approval" sub="Employee asset requests awaiting a decision." onBack={onBack}>
        <FeatureTable
          heads={['Employee', 'Asset', 'Status', '']}
          empty="No asset requests."
          rows={requests.map((r) => (
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
      </FeatureScreen>
    );
  }
  if (view === 'reports') {
    const byCat = {};
    assets.forEach((a) => { const c = a.category || 'Other'; byCat[c] = (byCat[c] || 0) + 1; });
    return (
      <FeatureScreen title="Asset Reports & Analytics" sub="Inventory split by category and status." onBack={onBack}>
        <StatRow cells={[
          { value: assets.length, label: 'Total Assets' },
          { value: assets.filter((a) => a.status === 'Assigned').length, label: 'Assigned' },
          { value: assets.filter((a) => a.status === 'Available').length, label: 'Available' },
        ]} />
        <Panel style={{ marginTop: 14 }}>
          <PanelHead title="By Category" />
          {Object.keys(byCat).length === 0
            ? <EmptyMini>No assets yet.</EmptyMini>
            : Object.keys(byCat).map((c) => <AssignRow key={c}><span>{c}</span><b>{byCat[c]}</b></AssignRow>)}
        </Panel>
      </FeatureScreen>
    );
  }
  if (view === 'audit') {
    return (
      <FeatureScreen title="Asset Audit" sub="Each asset's movement history for audit." onBack={onBack}>
        <FeatureTable
          heads={['Code', 'Asset', 'History', 'Currently With']}
          empty="No assets yet."
          rows={assets.map((a) => (
            <tr key={a.id}>
              <td><b>{a.assetCode}</b></td><td>{a.name}</td>
              <td className="cell-muted">{(a.history || []).length} event(s)</td>
              <td className="cell-muted">{a.assignedToName || 'Unassigned'}</td>
            </tr>
          ))}
        />
      </FeatureScreen>
    );
  }

  // ---- Tab body --------------------------------------------------------
  return (
    <div>
      <StatRow cells={[
        { value: assets.length, label: 'Total Assets' },
        { value: assets.filter((a) => a.status === 'Available').length, label: 'Available' },
        { value: assets.filter((a) => a.status === 'Assigned').length, label: 'Assigned' },
        { value: assets.filter((a) => a.status === 'In Repair').length, label: 'In Maintenance' },
      ]} />

      <QaRow style={{ margin: '14px 0' }}>
        {isHR && <button className="btn btn-primary btn-sm" onClick={addAsset}>+ Add Asset</button>}
      </QaRow>

      <TwoCol style={{ alignItems: 'start' }}>
        <PanelPad>
          <NumHead n={1} title="Asset Inventory" />
          {assets.length === 0 ? <EmptyMini>No assets on file.</EmptyMini> : assets.map((a) => (
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
        </PanelPad>
        <FeatureTiles features={AS_FEATURES} onOpen={onOpen} />
      </TwoCol>
    </div>
  );
}
