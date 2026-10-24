import { useEffect, useState } from 'react';
import api from '../../api';
import './agreementFlow.css';

// "Agreement HR approver(s)" - who fills Tax & billing, Payment details, Documents and Notes before the BDE TL
// checks the agreement (user, 2026-10-13). Default: employee ID TL309 (Purna Sir). Admin changes it; the rest read.
export default function AgreementHrApprovers() {
  const [d, setD] = useState(null);
  const [text, setText] = useState('');
  const [label, setLabel] = useState('');
  const [allowHr, setAllowHr] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    api.get('/agreement-flow/settings').then((r) => { setD(r.data); setText((r.data.approvers || []).join(', ')); setLabel(r.data.hrLabel || ''); setAllowHr(!!r.data.allowHrDesk); }).catch(() => setD(false));
  }, []);
  if (!d) return null;
  async function save() {
    setErr(''); setMsg('');
    try {
      const r = await api.put('/agreement-flow/settings', { approvers: text, hrLabel: label, allowHrDesk: allowHr });
      setD(r.data); setMsg('Saved.');
    } catch (e) { setErr(e.response?.data?.error || 'Could not save.'); }
  }
  return (
    <>
      <div className="section-label">Agreement HR approver(s)</div>
      <div className="small-muted" style={{ fontSize: 12, marginBottom: 6 }}>
        The BDE fills the commercial part and sends it here. This person fills Tax &amp; billing, Payment details, Documents and Notes, then sends it to the BDE team lead.
      </div>
      {d.canEdit ? (
        <>
          <label className="field"><span>Employee ID(s), like TL309</span><input value={text} onChange={(e) => setText(e.target.value)} placeholder="TL309" /></label>
          <label className="field"><span>Name shown on the buttons</span><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="HR" /></label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={allowHr} onChange={(e) => setAllowHr(e.target.checked)} />
            Anyone on the HR desk may fill it too (off: only the IDs above)
          </label>
          <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={save}>Save approvers</button>
          {msg && <span className="af-ok"> {msg}</span>}
          {err && <div className="error-text" role="alert">{err}</div>}
        </>
      ) : <div className="small-muted">Filled by {d.hrLabel}. Only an Admin changes who.</div>}
    </>
  );
}
