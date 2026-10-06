import { RepairFields, accountsNote } from './AssetAccountsFields.jsx';
import { useRef, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { ComposeModal, Field, Row, useSubmit } from '../../components/ComposeForm.jsx';
import './AssetRepair.css';

// ASSET REPAIR WITH THE VENDOR'S SLIP (backend/src/routes/assetInventory.js,
// POST /:id/repair/send | /:id/repair/back | /:id/repair/:entryId/slip).
// Each repair step is written to the asset's history with its details and the
// uploaded slip; the slip is fetched with the login's token and only for an
// asset this login can see.

const SLIP_MAX = 10 * 1024 * 1024;
const SLIP_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
export const SLIP_HINT = 'Slip: PDF or photo, up to 10 MB';

function slipProblem(file) {
  if (!file) return '';
  if (!SLIP_TYPES.includes(file.type)) return 'The slip must be a PDF or a photo (JPG, PNG or WebP).';
  if (file.size > SLIP_MAX) return 'That file is bigger than 10 MB. Please upload a smaller PDF or photo.';
  return '';
}
const kb = (n) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const money = (n) => `₹${Number(n).toLocaleString('en-IN')}`;

function toForm(fields, file) {
  const body = new FormData();
  Object.entries(fields).forEach(([k, v]) => body.append(k, v == null ? '' : String(v)));
  if (file) body.append('slip', file, file.name);
  return body;
}

function SlipField({ file, setFile, setError }) {
  return (
    <Field label="Repair slip (optional)" hint={SLIP_HINT}>
      <input
        type="file"
        accept="application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png,.webp"
        onChange={(e) => {
          const f = e.target.files && e.target.files[0];
          const bad = slipProblem(f);
          if (bad) { setError(bad); e.target.value = ''; setFile(null); return; }
          setError('');
          setFile(f || null);
        }}
      />
    </Field>
  );
}

export function SendRepairModal({ asset, onClose, onSaved }) {
  const [form, setForm] = useState({ vendor: '', issue: '', expectedBack: '' });
  const [file, setFile] = useState(null);
  const { busy, error, setError, run } = useSubmit();
  async function submit() {
    if (!form.vendor.trim()) { setError('Enter the repair shop (vendor) name.'); return; }
    if (!form.issue.trim()) { setError('Write what the problem is.'); return; }
    const res = await run(() => api.post(`/asset-inventory/${asset.id}/repair/send`, toForm(form, file)), 'Could not send for repair. Please try again.');
    if (res) onSaved(res.data, `Saved. ${asset.name} is now with ${form.vendor.trim()} for repair.`);
  }
  return (
    <ComposeModal title={`Send for repair — ${asset.name}`} onClose={onClose} onSubmit={submit} submitLabel="Send for repair" busy={busy} error={error}>
      <Field label="Repair shop (vendor)" required>
        <input value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} placeholder="e.g. Sai Laptop Care" maxLength={120} />
      </Field>
      <Field label="What is the problem?" required>
        <textarea rows={3} value={form.issue} onChange={(e) => setForm({ ...form, issue: e.target.value })} placeholder="e.g. Screen is cracked" maxLength={500} />
      </Field>
      <Row>
        <Field label="Expected back on (optional)">
          <input type="date" value={form.expectedBack} onChange={(e) => setForm({ ...form, expectedBack: e.target.value })} />
        </Field>
      </Row>
      <SlipField file={file} setFile={setFile} setError={setError} />
    </ComposeModal>
  );
}

export function BackRepairModal({ asset, onClose, onSaved }) {
  const [form, setForm] = useState({ fixed: '', cost: '', repairType: 'Repair', gstPaid: '', invoiceNo: '', paidVia: '', underWarranty: false, capitalise: false });
  const [file, setFile] = useState(null);
  const { busy, error, setError, run } = useSubmit();
  async function submit() {
    if (!form.fixed.trim()) { setError('Write what was fixed.'); return; }
    if (form.cost.trim() && !/^\d[\d,]*(\.\d+)?$/.test(form.cost.trim())) { setError('Cost must be a number, like 1500.'); return; }
    const res = await run(() => api.post(`/asset-inventory/${asset.id}/repair/back`, toForm(form, file)), 'Could not save. Please try again.');
    if (res) onSaved(res.data, `Saved. ${asset.name} is back from repair.${accountsNote(res.data)}`);
  }
  return (
    <ComposeModal title={`Back from repair — ${asset.name}`} onClose={onClose} onSubmit={submit} submitLabel="Mark as back" busy={busy} error={error}>
      <Field label="What was fixed?" required>
        <textarea rows={3} value={form.fixed} onChange={(e) => setForm({ ...form, fixed: e.target.value })} placeholder="e.g. Screen replaced" maxLength={500} />
      </Field>
      <Row>
        <Field label="Cost in ₹ (optional)">
          <input inputMode="decimal" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} placeholder="e.g. 2500" />
        </Field>
      </Row>
      <RepairFields form={form} setForm={setForm} />
      <SlipField file={file} setFile={setFile} setError={setError} />
    </ComposeModal>
  );
}

// Opens the slip in a new tab (fetched with the login's token). If the
// browser blocks the new tab, the file is downloaded instead.
async function viewSlip(asset, entry, setNote) {
  const tab = window.open('', '_blank');
  try {
    const res = await api.get(`/asset-inventory/${asset.id}/repair/${entry.id}/slip`, { responseType: 'blob' });
    const blob = new Blob([res.data], { type: (entry.slip && entry.slip.mime) || res.data.type });
    const url = URL.createObjectURL(blob);
    if (tab) tab.location.href = url;
    else {
      const a = document.createElement('a');
      a.href = url; a.download = (entry.slip && entry.slip.name) || 'repair-slip';
      document.body.appendChild(a); a.click(); a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch {
    if (tab) tab.close();
    setNote({ bad: true, text: 'Could not open the slip. You may not have access to this asset any more.' });
  }
}

function AddSlipButton({ asset, entry, onChanged, setNote }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  async function pick(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const bad = slipProblem(f);
    if (bad) { setNote({ bad: true, text: bad }); return; }
    setBusy(true);
    try {
      const res = await api.post(`/asset-inventory/${asset.id}/repair/${entry.id}/slip`, toForm({}, f));
      setNote({ bad: false, text: 'Slip added.' });
      onChanged(res.data);
    } catch (err) {
      setNote({ bad: true, text: err.response?.data?.error || 'Could not add the slip. Please try again.' });
    } finally { setBusy(false); }
  }
  return (
    <>
      <input ref={input} type="file" hidden accept="application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png,.webp" onChange={pick} />
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => input.current && input.current.click()}>
        {busy ? 'Adding…' : 'Add slip'}
      </button>
    </>
  );
}

// Old one-click repairs (before vendor + slip) were plain text entries.
const isRepairEntry = (h) => h && (h.kind === 'repair' || /^(Sent for repair|Repair completed)$/.test(h.text || ''));

export function repairEntries(asset) {
  return (asset.history || []).filter(isRepairEntry);
}

export function RepairHistoryModal({ asset, canEdit, onClose, onChanged }) {
  const [note, setNote] = useState(null);
  const entries = repairEntries(asset);
  return (
    <Modal title={`Repair history — ${asset.name}`} onClose={onClose}>
      <div className="asrep">
        {note && <div className={`asrep-note ${note.bad ? 'bad' : 'ok'}`} role="status">{note.text}</div>}
        {entries.length === 0 ? (
          <p className="asrep-empty">No repairs yet for this asset.</p>
        ) : (
          <ul className="asrep-list">
            {entries.map((h, i) => {
              const back = h.step === 'back' || h.text === 'Repair completed';
              return (
                <li key={h.id || `${h.at}-${i}`} className="asrep-item">
                  <div className="asrep-top">
                    <span className={`status ${back ? 'active' : 'pending'}`}>{back ? 'Back from repair' : 'Sent for repair'}</span>
                    <span className="asrep-when">{h.at}{h.by ? ` · ${h.by}` : ''}</span>
                  </div>
                  {h.kind === 'repair' ? (
                    <dl className="asrep-facts">
                      {h.vendor && <><dt>Repair shop</dt><dd>{h.vendor}</dd></>}
                      {h.issue && <><dt>Problem</dt><dd>{h.issue}</dd></>}
                      {h.expectedBack && <><dt>Expected back</dt><dd>{h.expectedBack}</dd></>}
                      {h.fixed && <><dt>What was fixed</dt><dd>{h.fixed}</dd></>}
                      {h.cost !== null && h.cost !== undefined && <><dt>Cost</dt><dd>{money(h.cost)}</dd></>}
                    </dl>
                  ) : <p className="asrep-old">{h.text} (no details were recorded)</p>}
                  {h.kind === 'repair' && (
                    <div className="asrep-slip">
                      {h.slip ? (
                        <button type="button" className="btn btn-sm" onClick={() => viewSlip(asset, h, setNote)}>
                          View slip
                        </button>
                      ) : <span className="asrep-noslip">No slip yet</span>}
                      {h.slip && <span className="asrep-file">{h.slip.name}{h.slip.size ? ` · ${kb(h.slip.size)}` : ''}</span>}
                      {!h.slip && canEdit && <AddSlipButton asset={asset} entry={h} onChanged={onChanged} setNote={setNote} />}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {canEdit && <p className="asrep-hint">{SLIP_HINT}</p>}
      </div>
    </Modal>
  );
}
