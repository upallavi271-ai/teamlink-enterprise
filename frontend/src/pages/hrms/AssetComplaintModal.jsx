import { useEffect, useState } from 'react';
import api from '../../api';
import { ComposeModal, Field, useSubmit } from '../../components/ComposeForm.jsx';

// "REPORT A PROBLEM" on an asset the employee holds (2026-10-19). Three plain choices:
//   Repair       - it is broken: HR or the manager decides; once approved the company sends it to the repair vendor.
//   Replacement  - it cannot be fixed or is lost.
//   Other        - anything else.
// The answer shows in Employee Services > Assets > Asset Approval. Nothing here is sent to a vendor until HR or the manager approves a Repair.
const KINDS = [
  ['Repair', 'It is broken or not working', 'HR or your manager decides. When approved, the company sends it for repair.'],
  ['Replacement', 'It cannot be fixed, or it is lost', 'Ask for a new one.'],
  ['Other', 'Something else about this asset', 'Tell us what is wrong.'],
];

export default function AssetComplaintModal({ onClose, onSaved }) {
  const [assets, setAssets] = useState(null);
  const [form, setForm] = useState({ assetId: '', kind: 'Repair', issue: '' });
  const { busy, error, setError, run } = useSubmit();
  useEffect(() => {
    api.get('/asset-complaints/my-assets').then((r) => {
      setAssets(r.data.rows);
      if (r.data.rows.length === 1) setForm((f) => ({ ...f, assetId: r.data.rows[0].id }));
    }).catch(() => setAssets([]));
  }, []);
  async function submit() {
    if (!form.assetId) { setError('Pick the asset.'); return; }
    if (form.issue.trim().length < 5) { setError('Write what is wrong, in a few words.'); return; }
    const res = await run(() => api.post('/asset-complaints', form), 'Could not send it');
    if (res) onSaved(res.data.message || 'Sent.');
  }
  const help = (KINDS.find((k) => k[0] === form.kind) || [])[2];
  return (
    <ComposeModal title="Report a problem" onClose={onClose} onSubmit={submit} submitLabel="Send" busy={busy} busyLabel="Sending..." error={error} disabled={assets !== null && !assets.length}>
      {assets !== null && !assets.length && <div className="cell-muted">No asset is assigned to you right now, so there is nothing to report.</div>}
      {(assets === null || assets.length > 0) && (
        <>
          <Field label="Which asset?">
            <select value={form.assetId} onChange={(e) => setForm({ ...form, assetId: e.target.value })} aria-label="Which asset?">
              <option value="">{assets === null ? 'Loading...' : 'Pick the asset'}</option>
              {(assets || []).map((a) => <option key={a.id} value={a.id}>{a.name} ({a.assetCode})</option>)}
            </select>
          </Field>
          <Field label="What do you need?" hint={help}>
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} aria-label="What do you need?">
              {KINDS.map(([k, label]) => <option key={k} value={k}>{k} - {label}</option>)}
            </select>
          </Field>
          <Field label="What is wrong?" hint="Do not write phone numbers or other private details. The repair vendor can see this text.">
            <textarea rows={3} maxLength={800} value={form.issue} onChange={(e) => setForm({ ...form, issue: e.target.value })} placeholder="e.g. The screen flickers and goes black after a few minutes" />
          </Field>
        </>
      )}
    </ComposeModal>
  );
}
