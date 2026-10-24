import { useState } from 'react';
import { createPortal } from 'react-dom';
import WaModal from './WaModal.jsx';
import { useWaConfig, waMayUse, WA_ICON } from './waKit.js';
import '../reach/reach.css';
import './wa.css';

// The WhatsApp icon button for ONE row / profile. Shows only when this login may WhatsApp this kind of person and the master switch is on.
//   <WaButton entityType="candidate" id={c.id} name={c.name} hasNumber />      hasNumber === false hides it (no number on that row)
export default function WaButton({ entityType, id, name, hasNumber, requirementId, applicationId, label = '', className = '' }) {
  const cfg = useWaConfig();
  const [open, setOpen] = useState(false);
  if (!id || hasNumber === false || !waMayUse(cfg, entityType)) return null;
  return (
    <span className="wa-wrap" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} role="presentation">
      <button type="button" className={`wa-btn ${className}`} aria-label={`WhatsApp ${name || ''}`.trim()} title="Send a WhatsApp message (opens WhatsApp in a new tab)" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
        <span className="wa-ic" aria-hidden="true">{WA_ICON}</span>{label && <span>{label}</span>}
      </button>
      {open && createPortal(
        <div className="rch-boost"><WaModal entityType={entityType} id={id} name={name} requirementId={requirementId} applicationId={applicationId} onClose={() => setOpen(false)} /></div>,
        document.body,
      )}
    </span>
  );
}
