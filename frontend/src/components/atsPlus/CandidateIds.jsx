import { useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import { Notice, Table, useLoad, useAction, when, row } from './kit.jsx';

// ---------------------------------------------------------------------------
// THE CANDIDATE'S "IDs & consent" (market wave IN-07 / IN-08 / 15.09): Aadhaar (last 4 digits only), PAN and bank account (encrypted,
// shown masked; a Super Admin / Admin / HR opens the full number with a reason, logged), and the consent log with Record / Withdraw.
// Not drawn for a BDE (no IDs in the BDE view); the server refuses them anyway. Backend: utils/atsPlus/privacy.js.
// ---------------------------------------------------------------------------
export function mayIds(user) {
  if (!user) return false;
  return !['BDE', 'CLIENT', 'CANDIDATE'].includes(user.atsRole) && !['CLIENT', 'CANDIDATE'].includes(user.role);
}
function Body({ c }) {
  const ids = useLoad(`/ats-plus/privacy/candidates/${c.id}/ids`);
  const cons = useLoad(`/ats-plus/privacy/consents?candidateId=${c.id}`);
  const { run, busy, flash } = useAction(() => { ids.reload(); return cons.reload(); });
  const [f, setF] = useState({ kind: 'PAN', value: '', ifsc: '' });
  const [shown, setShown] = useState(null);
  const reveal = (r) => { const reason = window.prompt('Why do you need the full number? (it is logged)'); if (!reason) return; api.post(`/ats-plus/privacy/ids/${r.id}/reveal`, { reason }).then((x) => setShown({ id: r.id, v: x.data.value })).catch((e) => setShown({ id: r.id, v: (e.response && e.response.data && e.response.data.error) || 'Not shown.' })); };
  const consent = (status) => { let reason = ''; if (status === 'WITHDRAWN') { reason = window.prompt('How did the person ask to withdraw? (their words)') || ''; if (!reason.trim()) return; } run(() => api.post('/ats-plus/privacy/consents', { candidateId: c.id, status, reason, channel: 'call' }), status === 'GIVEN' ? 'Consent recorded with the current notice.' : 'Consent withdrawn: do not contact.'); };
  return (
    <>
      <Notice tone="red">{ids.err}</Notice>{flash}
      <b>ID numbers</b>
      {ids.data && <Table rows={ids.data.rows} empty="None saved."
        cols={[{ key: 'kind', label: 'What' }, { key: 'masked', label: 'Number', render: (r) => (shown && shown.id === r.id ? <b>{shown.v}</b> : r.masked) }, { key: 'ifsc', label: 'IFSC', render: (r) => r.ifsc || '—' }, { key: 'savedAt', label: 'Saved', render: (r) => when(r.savedAt) },
          { key: 'a', label: '', render: (r) => ids.data.canReveal && r.kind !== 'AADHAAR' && <button type="button" className="btn btn-sm" onClick={() => reveal(r)}>Show full</button> }]} />}
      <div style={{ ...row, margin: '8px 0' }}>
        <select aria-label="Kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="AADHAAR">Aadhaar (last 4 kept)</option><option value="PAN">PAN</option><option value="BANK">Bank account</option></select>
        <input aria-label="Number" placeholder="Number" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} autoComplete="off" />
        {f.kind === 'BANK' && <input aria-label="IFSC" placeholder="IFSC" value={f.ifsc} onChange={(e) => setF({ ...f, ifsc: e.target.value })} />}
        <button type="button" className="btn btn-sm btn-primary" disabled={busy || !f.value} onClick={() => run(() => api.post(`/ats-plus/privacy/candidates/${c.id}/ids`, f), 'Saved (masked).').then(() => setF({ ...f, value: '', ifsc: '' }))}>Save</button>
      </div>
      <b>Consent log</b>
      {cons.data && <Table rows={cons.data.rows} empty="No consent recorded in the log yet."
        cols={[{ key: 'createdAt', label: 'When', render: (r) => when(r.createdAt) }, { key: 'status', label: 'Consent' }, { key: 'noticeVersion', label: 'Notice' }, { key: 'channel', label: 'How' }, { key: 'createdByName', label: 'By' }, { key: 'reason', label: 'Words', render: (r) => r.reason || '—' }]} />}
      <div style={{ ...row, marginTop: 6 }}>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => consent('GIVEN')}>Record consent (read the notice to them)</button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => consent('WITHDRAWN')}>Withdraw consent</button>
        <a href="/privacy-notice" target="_blank" rel="noreferrer">The notice</a>
      </div>
    </>
  );
}
export default function CandidateIds({ c, user }) {
  const [open, setOpen] = useState(false);
  if (!mayIds(user) || !c) return null;
  return (
    <>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)} title="Aadhaar, PAN, bank (masked) and the consent log">IDs &amp; consent</button>
      {open && <Modal title={`IDs & consent: ${c.name}`} size="wide" onClose={() => setOpen(false)}><Body c={c} /></Modal>}
    </>
  );
}
