// "Add GSTIN" — attach the vendor's GSTIN to one bill. Checked as it is typed
// (the real mod-36 checksum); the API checks again and the at-risk figures are
// recomputed from the record on the next load.
import { useState } from 'react';
import api from '../../api';
import { checkGstin } from '../../utils/gstin';

export default function AddGstin({ bill, onSaved, onCancel }) {
  const [v, setV] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const c = v ? checkGstin(v) : null;
  const save = async () => {
    setBusy(true); setErr('');
    try {
      await api.post(`/office-expenses/${bill.id}/gstin`, { gstin: v, rememberForVendor: remember });
      onSaved();
    } catch (e) {
      setErr(e.response?.data?.error || 'Could not save the GSTIN');
      setBusy(false);
    }
  };
  return (
    <div className="oe-addg">
      <input
        autoFocus
        value={v}
        maxLength={15}
        placeholder="15-character GSTIN"
        onChange={(e) => setV(e.target.value.toUpperCase().replace(/\s+/g, ''))}
        onKeyDown={(e) => { if (e.key === 'Enter' && c?.ok) save(); if (e.key === 'Escape') onCancel(); }}
        aria-label={`Vendor GSTIN for ${bill.vendor || 'this bill'}`}
      />
      {bill.vendor && (
        <label className="oe-addg-rem">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          every bill from {bill.vendor}
        </label>
      )}
      <button type="button" className="btn btn-sm btn-primary" disabled={!c?.ok || busy} onClick={save}>Save</button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>Cancel</button>
      <div className={`oe-addg-msg${c && !c.ok ? ' bad' : ''}`}>
        {err || (c ? (c.ok ? `Valid · ${c.stateName}` : c.error) : '')}
      </div>
    </div>
  );
}
