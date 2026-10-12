import { createRoot } from 'react-dom/client';
import DupCheckPanel from './DupCheckPanel.jsx';
import Modal from '../Modal.jsx';
import './Duplicates.css';

// Opens the "Check duplicates" window from anywhere (a chip, a button, or the server's 409 "Duplicate: resolve first").
// openDupPanel({ candidateId, message, onChanged })
let current = null;

function Host({ opts, onClose }) {
  return (
    <Modal title="Check duplicates" size="lg" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      <div className="dupx-gate">
        {opts.message && <div className="dupx-banner" role="alert"><span><b>Not moved.</b>{` ${opts.message}`}</span></div>}
        <DupCheckPanel candidateId={opts.candidateId} onChanged={(r) => { if (opts.onChanged) opts.onChanged(r); }} />
      </div>
    </Modal>
  );
}

export function openDupPanel(opts = {}) {
  if (!opts.candidateId) return;
  if (current) current.close();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => {
    if (current && current.host === host) current = null;
    root.unmount();
    host.remove();
    if (opts.onClose) opts.onClose();
  };
  current = { host, close };
  root.render(<Host opts={opts} onClose={close} />);
}
