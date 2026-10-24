import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOmniStore, setDept } from './omniStore.js';
import { pagePath } from './omniPages.js';
import OrgWorkspaceModal from './admin/OrgWorkspaceModal.jsx';
import './gs.css';

// The prototype's top bar chips, drawn in the Shell's top bar while an Omni-Channel page is open:
//   workspace switcher (the department; Admin / Manager see all, others a fixed one)  and  the credits pill (opens Billing).
export default function OmniTopChips() {
  const s = useOmniStore();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [orgs, setOrgs] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const f = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', f);
    return () => document.removeEventListener('mousedown', f);
  }, [open]);
  const w = s.workspaces; const wl = s.wallet;
  const label = s.dept || (w && !w.all && w.list.length === 1 ? w.list[0].name : 'All departments');
  const pill = wl ? (wl.value === null || wl.value === undefined ? `✦ ${wl.label}` : `✦ ${Number(wl.value).toLocaleString('en-IN')} credits`) : '✦ credits';
  return (
    <span className="gsx" style={{ background: 'transparent', minHeight: 0, overflow: 'visible', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span className="dropdown" ref={box}>
        <button type="button" className="workspace-switch" id="topWorkspace" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} disabled={!w}><span>{label}</span>{w && w.canSwitch ? <span>⌄</span> : null}</button>
        {open && w && (
          <div className="menu show" role="menu" style={{ right: 'auto', left: 0 }}>
            <div className="menu-label">Workspace (department)</div>
            {w.all && <button type="button" className={!s.dept ? 'active' : ''} onClick={() => { setDept(''); setOpen(false); }}><span>All departments</span>{!s.dept ? <span>✓</span> : null}</button>}
            {w.list.map((d) => <button type="button" key={d.name} className={s.dept.toLowerCase() === d.name.toLowerCase() ? 'active' : ''} onClick={() => { setDept(w.canSwitch ? d.name : ''); setOpen(false); }}><span>{d.name}</span><span style={{ color: '#8b968f', fontWeight: 500 }}>{d.people ? `${d.people} people` : ''}</span></button>)}
            {!w.all && <div className="menu-foot"><button type="button" disabled>Your department is fixed by your role</button></div>}
            <div className="menu-foot"><button type="button" onClick={() => { setOpen(false); setOrgs(true); }}>Switch Organization…</button></div>
          </div>
        )}
      </span>
      <button type="button" className="credits" id="creditsPill" title={wl ? wl.words : 'Credits'} onClick={() => navigate(pagePath('billing'))}>{pill}</button>
      {orgs && <OrgWorkspaceModal onClose={() => setOrgs(false)} />}
    </span>
  );
}
