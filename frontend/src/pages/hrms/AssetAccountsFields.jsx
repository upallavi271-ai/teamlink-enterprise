// HRMS → Assets: the fields Accounts needs (spec S2.1 / S2.2, 2026-10-05).
// HRMS owns them; Accounts only reads them and posts the journal.
//   AccountsFields   vendor, invoice, GST, paid via, useful life, method, rate, salvage
//   DisposalFields   shown for Sold / Written off: date, sale amount, received in
//   RepairFields     the accounting part of a repair (type, GST, invoice, paid via, warranty, capitalise)
//   AssetRepairsModal the asset's repair / maintenance log (add, edit, cancel)
//   accountsNote(res) "Posted to Accounts" / why not, from the API's `accounts`
import { useEffect, useState } from 'react';
import api from '../../api';
import { Modal } from '../../components/proto.jsx';
import { Field, Row } from '../../components/ComposeForm.jsx';
import '../../components/accounts/ledgerBooks.css';

export const ACCOUNT_FIELD_KEYS = ['vendor', 'invoiceNo', 'gstPaid', 'paidVia', 'usefulLifeYears', 'depreciationMethod', 'depreciationRate', 'salvageValue', 'disposalDate', 'disposalAmount', 'disposalPaidVia'];
export const accountsDefaults = (a = {}) => Object.fromEntries(ACCOUNT_FIELD_KEYS.map((k) => [k, a[k] ?? '']));
const rupees = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;

export function accountsNote(data) {
  const list = (data && data.accounts) || [];
  if (!list.length) return '';
  const bad = list.find((x) => !x.ok);
  if (bad) return ` Not sent to Accounts yet: ${bad.error}`;
  const words = { posted: 'posted to Accounts', updated: 'Accounts entry updated', 'in-sync': 'Accounts already up to date', reversed: 'Accounts entry reversed' };
  return ` ${[...new Set(list.map((x) => words[x.status] || 'sent to Accounts'))].join(', ')}.`.replace(/^ ./, (m) => m.toUpperCase());
}

export function AccountsFields({ form, setForm }) {
  const [open, setOpen] = useState(!!(form.vendor || form.gstPaid || form.usefulLifeYears));
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <div style={{ marginTop: 6 }}>
      <button type="button" className="btn btn-sm" onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Show'} details for Accounts</button>
      {open && (
        <div style={{ marginTop: 8 }}>
          <Row>
            <Field label="Vendor"><input value={form.vendor} onChange={set('vendor')} placeholder="Who sold it" /></Field>
            <Field label="Invoice no."><input value={form.invoiceNo} onChange={set('invoiceNo')} placeholder="e.g. INV-2041" /></Field>
          </Row>
          <Row>
            <Field label="GST paid (₹)"><input inputMode="decimal" value={form.gstPaid} onChange={set('gstPaid')} placeholder="e.g. 9900" /></Field>
            <Field label="Paid via">
              <select value={form.paidVia} onChange={set('paidVia')}>
                <option value="">Bank (default)</option><option>Bank</option><option>Cash</option><option value="Payable">Not paid yet (vendor payable)</option>
              </select>
            </Field>
          </Row>
          <Row>
            <Field label="Useful life (years)"><input inputMode="decimal" value={form.usefulLifeYears} onChange={set('usefulLifeYears')} placeholder="IT items: 3" /></Field>
            <Field label="Depreciation">
              <select value={form.depreciationMethod} onChange={set('depreciationMethod')}>
                <option value="">Straight line (default)</option><option value="SL">Straight line (SL)</option><option value="WDV">Written down value (WDV)</option>
              </select>
            </Field>
          </Row>
          <Row>
            <Field label="Rate % a year (WDV)"><input inputMode="decimal" value={form.depreciationRate} onChange={set('depreciationRate')} placeholder="e.g. 40" /></Field>
            <Field label="Salvage value (₹)"><input inputMode="decimal" value={form.salvageValue} onChange={set('salvageValue')} placeholder="0" /></Field>
          </Row>
        </div>
      )}
    </div>
  );
}

export function DisposalFields({ form, setForm, status }) {
  if (status !== 'Sold' && status !== 'Written off') return null;
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Row>
      <Field label={status === 'Sold' ? 'Sold on' : 'Written off on'} required><input type="date" value={form.disposalDate} onChange={set('disposalDate')} /></Field>
      {status === 'Sold' && <Field label="Sold for (₹)"><input inputMode="decimal" value={form.disposalAmount} onChange={set('disposalAmount')} placeholder="e.g. 12000" /></Field>}
      {status === 'Sold' && (
        <Field label="Money received in">
          <select value={form.disposalPaidVia} onChange={set('disposalPaidVia')}><option value="">Bank</option><option>Bank</option><option>Cash</option></select>
        </Field>
      )}
    </Row>
  );
}

const REPAIR_TYPES = ['Repair', 'Service', 'AMC', 'Replacement of part'];
export function RepairFields({ form, setForm }) {
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  return (
    <>
      <Row>
        <Field label="Type">
          <select value={form.repairType || 'Repair'} onChange={set('repairType')}>{REPAIR_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
        </Field>
        <Field label="GST paid (₹)"><input inputMode="decimal" value={form.gstPaid ?? ''} onChange={set('gstPaid')} placeholder="0" /></Field>
      </Row>
      <Row>
        <Field label="Invoice no."><input value={form.invoiceNo ?? ''} onChange={set('invoiceNo')} /></Field>
        <Field label="Paid via">
          <select value={form.paidVia ?? ''} onChange={set('paidVia')}>
            <option value="">Bank (default)</option><option>Bank</option><option>Cash</option><option value="Payable">Not paid yet (payable)</option>
          </select>
        </Field>
      </Row>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', margin: '4px 0 8px' }}>
        <label className="prb-check"><input type="checkbox" checked={!!form.underWarranty} onChange={set('underWarranty')} /> Under warranty</label>
        <label className="prb-check"><input type="checkbox" checked={!!form.capitalise} onChange={set('capitalise')} /> Adds to the asset&apos;s value (capitalise)</label>
      </div>
    </>
  );
}

const STATUS_CLS = { Reported: 'orange', 'In Repair': 'blue', Completed: 'green', Cancelled: 'grey' };

function RepairEditor({ asset, repair, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    issue: repair?.issue || '', vendor: repair?.vendor || '', dateReported: repair?.dateReported || new Date().toISOString().slice(0, 10),
    repairDate: repair?.repairDate || '', cost: repair?.cost ?? '', gstPaid: repair?.gstPaid ?? '', invoiceNo: repair?.invoiceNo || '',
    paidVia: repair?.paidVia || '', underWarranty: !!repair?.underWarranty, capitalise: !!repair?.capitalise,
    repairType: repair?.repairType || 'Repair', status: repair?.status || 'Reported', notes: repair?.notes || '',
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  async function save() {
    if (!form.issue.trim()) { setError('Write what the problem is.'); return; }
    setBusy(true); setError('');
    try {
      const r = repair
        ? await api.patch(`/asset-inventory/${asset.id}/repairs/${repair.id}`, form)
        : await api.post(`/asset-inventory/${asset.id}/repairs`, form);
      onSaved(`Saved ${r.data.repair.repairNo}.${accountsNote(r.data)}`);
    } catch (err) { setError(err.response?.data?.error || 'Could not save. Please try again.'); } finally { setBusy(false); }
  }
  return (
    <Modal title={repair ? `${repair.repairNo} — ${asset.name}` : `Log a repair — ${asset.name}`} onClose={onClose}
      footer={<><button type="button" className="btn btn-sm" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <Field label="What is the problem?" required><textarea rows={2} value={form.issue} onChange={set('issue')} maxLength={500} /></Field>
      <Row>
        <Field label="Vendor / service centre"><input value={form.vendor} onChange={set('vendor')} /></Field>
        <Field label="Status">
          <select value={form.status} onChange={set('status')}>{['Reported', 'In Repair', 'Completed', 'Cancelled'].map((s) => <option key={s}>{s}</option>)}</select>
        </Field>
      </Row>
      <Row>
        <Field label="Reported on"><input type="date" value={form.dateReported} onChange={set('dateReported')} /></Field>
        <Field label="Repaired on"><input type="date" value={form.repairDate} onChange={set('repairDate')} /></Field>
      </Row>
      <Row>
        <Field label="Cost before GST (₹)"><input inputMode="decimal" value={form.cost} onChange={set('cost')} placeholder={form.underWarranty ? '0 — covered by warranty' : 'e.g. 2500'} /></Field>
      </Row>
      <RepairFields form={form} setForm={setForm} />
      <Field label="Notes"><input value={form.notes} onChange={set('notes')} /></Field>
      <div className="lb-note">A Completed repair with a cost goes to Accounts. Cancelled undoes its Accounts entry.</div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

export function AssetRepairsModal({ asset, canEdit, onClose }) {
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null); // null | 'new' | repair
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  function load() { api.get(`/asset-inventory/${asset.id}/repairs`).then((r) => setData(r.data)).catch((err) => setError(err.response?.data?.error || 'Could not load the repairs.')); }
  useEffect(load, [asset.id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function remove(r) {
    if (!window.confirm(`Delete ${r.repairNo}?`)) return;
    setMsg(''); setError('');
    try { await api.delete(`/asset-inventory/${asset.id}/repairs/${r.id}`); setMsg(`Deleted ${r.repairNo}.`); load(); } catch (err) { setError(err.response?.data?.error || 'Could not delete it.'); }
  }
  const total = (data?.repairs || []).filter((r) => r.status !== 'Cancelled').reduce((n, r) => n + (Number(r.cost) || 0), 0);
  return (
    <Modal title={`Repairs & maintenance — ${asset.assetCode} ${asset.name}`} onClose={onClose} wide
      footer={<>{canEdit && <button type="button" className="btn btn-sm" onClick={() => setEditing('new')}>Log a repair</button>}<button type="button" className="btn btn-primary btn-sm" onClick={onClose}>Close</button></>}>
      {msg && <div className="lb-ok" style={{ margin: '0 0 8px' }}>{msg}</div>}
      {error && <div className="lb-err" style={{ margin: '0 0 8px' }}>{error}</div>}
      {!data ? <div className="lb-note">Loading…</div> : data.repairs.length === 0 ? <div className="lb-note">No repairs logged for this asset yet.</div> : (
        <>
          <div className="lb-note" style={{ marginBottom: 6 }}>{data.repairs.length} repair(s) · {rupees(total)} spent{asset.purchaseCost ? ` · ${Math.round((total / asset.purchaseCost) * 100)}% of the purchase cost` : ''}</div>
          <div className="tbl-wrap">
            <table className="lb-tbl">
              <thead><tr><th>Repair ID</th><th>Problem</th><th>Type</th><th>Vendor</th><th>Repaired</th><th className="lb-num">Cost</th><th>Status</th><th>Accounts</th><th /></tr></thead>
              <tbody>
                {data.repairs.map((r) => (
                  <tr key={r.id}>
                    <td><b>{r.repairNo}</b></td><td style={{ whiteSpace: 'normal', minWidth: 160 }}>{r.issue || '—'}</td><td>{r.repairType}{r.capitalise ? <div className="lb-note">capitalised</div> : null}</td>
                    <td className="cell-muted">{r.vendor || '—'}</td><td>{r.repairDate || '—'}</td>
                    <td className="lb-num">{rupees(r.cost)}{r.gstPaid ? <div className="lb-note">+ GST {rupees(r.gstPaid)}</div> : null}</td>
                    <td><span className={`lb-badge ${STATUS_CLS[r.status] || 'grey'}`}>{r.status}</span>{r.coveredByWarranty && <div className="lb-note">Covered by warranty</div>}</td>
                    <td>{r.accounts.posted ? <span className="lb-badge green">Posted</span> : <span className="lb-badge grey">Not posted</span>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {canEdit && <button type="button" className="btn btn-sm" onClick={() => setEditing(r)}>Edit</button>}
                      {canEdit && !r.accounts.posted && <> <button type="button" className="btn btn-sm" onClick={() => remove(r)}>Delete</button></>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {editing && <RepairEditor asset={asset} repair={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(m) => { setEditing(null); setMsg(m); load(); }} />}
    </Modal>
  );
}
