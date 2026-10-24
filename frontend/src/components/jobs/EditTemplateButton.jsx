import { useState } from 'react';
import Modal from '../Modal.jsx';
import ReadyTemplatePanel from '../broadcast/ReadyTemplatePanel.jsx';

// "Edit template" (2026-10-13): opens the job's ready template (job post, WhatsApp, SMS, email) to change it.
// The saved edit (Use this) is the version posting uses; "Reset to auto" writes it again from the job.
export default function EditTemplateButton({ requirementId, className = 'btn btn-sm', label = 'Edit template' }) {
  const [open, setOpen] = useState(false);
  if (!requirementId) return null;
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} title="Change the text used to post this requirement">{label}</button>
      {open && (
        <Modal title="Edit the job template" size="wide" onClose={() => setOpen(false)} foot={<button type="button" className="btn" onClick={() => setOpen(false)}>Close</button>}>
          <ReadyTemplatePanel requirementId={requirementId} />
        </Modal>
      )}
    </>
  );
}
