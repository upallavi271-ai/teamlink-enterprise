import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';

// B7 — "Share with partners" on the job page. Lists the partner master with
// a tick per partner (+ "show client name"); the server (routes/partners.js)
// decides who may change it (Super Admin / Admin / STL / TL, job in scope) and
// refuses a paused partner or one whose agreement does not cover the job's
// department. Hidden entirely when the partners module is not reachable.
export default function PartnerShare({ requirementId, onChanged }) {
  const [d, setD] = useState(null);
  const [open, setOpen] = useState(false);
  const [gone, setGone] = useState(false);
  const load = () => api.get(`/partners/shares/job/${requirementId}`).then((r) => { setD(r.data); setGone(false); }).catch(() => setGone(true));
  useEffect(() => { load(); }, [requirementId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (gone || !d) return null;
  const shared = d.partners.filter((p) => p.shared);
  if (!d.canEdit && !shared.length) return null;
  return (
    <div style={{ marginTop: 10, fontSize: 13 }}>
      <b style={{ fontSize: 13 }}>Shared with partners</b>
      <span className="small-muted" style={{ marginLeft: 6 }}>
        {shared.length ? shared.map((p) => `${p.name}${p.submissions ? ` (${p.submissions} sent)` : ''}`).join(', ') : 'Not shared with any agency / freelancer'}
      </span>
      {d.canEdit && <button type="button" className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => setOpen(true)}>{shared.length ? 'Change' : 'Share with partners'}</button>}
      {open && <ShareModal requirementId={requirementId} data={d} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); load(); onChanged?.(); }} />}
    </div>
  );
}

function ShareModal({ requirementId, data, onClose, onSaved }) {
  const [picked, setPicked] = useState(() => new Map(data.partners.filter((p) => p.shared).map((p) => [p.id, p.showClientName])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [said, setSaid] = useState('');
  const toggle = (p) => { const n = new Map(picked); if (n.has(p.id)) n.delete(p.id); else n.set(p.id, p.showClientName); setPicked(n); };
  const flip = (p) => { const n = new Map(picked); n.set(p.id, !n.get(p.id)); setPicked(n); };
  async function save() {
    setBusy(true); setError('');
    try {
      const r = await api.put(`/partners/shares/job/${requirementId}`, { shares: [...picked.entries()].map(([partnerId, showClientName]) => ({ partnerId, showClientName })) });
      setSaid(r.data.message); setTimeout(onSaved, 600);
    } catch (e) { setError(e.response?.data?.error || 'Could not save.'); } finally { setBusy(false); }
  }
  const eligible = data.partners.filter((p) => p.eligible);
  const others = data.partners.filter((p) => !p.eligible);
  return (
    <Modal title="Share this job with partners" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <div className="small-muted" style={{ marginBottom: 8 }}>A ticked partner sees this job in their portal and can send candidates. Untick to take it away (their earlier candidates keep their status).</div>
      {!data.partners.length && <div className="notice amber"><span>No partners yet. Add them in Administration → Company Setup → Partners.</span></div>}
      {eligible.map((p) => (
        <div key={p.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 4px', borderTop: '1px solid var(--line-soft)', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: 0, fontWeight: 400, flex: '1 1 220px', cursor: 'pointer' }}>
            <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p)} style={{ width: 'auto' }} />
            <span><b>{p.name}</b> <span className="small-muted">· {p.type}{p.submissions ? ` · ${p.submissions} sent` : ''}{p.sharedByName ? ` · shared by ${p.sharedByName}` : ''}</span></span>
          </label>
          {picked.has(p.id) && (
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0, fontWeight: 400, fontSize: 12.5, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!picked.get(p.id)} onChange={() => flip(p)} style={{ width: 'auto' }} /> show client name
            </label>
          )}
        </div>
      ))}
      {others.length > 0 && (
        <div className="small-muted" style={{ marginTop: 10, fontSize: 12 }}>
          Cannot take this job (paused, or not covering {data.jobDepartment || 'this department'}): {others.map((p) => p.name).join(', ')}.
        </div>
      )}
      {said && <div className="notice green" style={{ marginTop: 8 }}><span>{said}</span></div>}
      {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
    </Modal>
  );
}
