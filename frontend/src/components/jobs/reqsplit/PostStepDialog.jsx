import Modal from '../../Modal.jsx';
import PostStep, { placesFromSources } from './PostStep.jsx';
import '../../clients/clientForm.css';
import '../../clients/addClientModal.css';
import './reqsplit.css';

// The Post step on its own, for a job that is already saved ("Post this job" on the job page): sites, logins, dry run, results.
export default function PostStepDialog({ job, sources = [], onClose, onChanged, startTargets = null }) {
  return (
    <Modal
      title={`Post this requirement — ${job.title}`}
      size="xwide acw-modal"
      onClose={() => { onClose(); if (onChanged) onChanged(); }}
      footer={<div className="cf-bar"><span className="cf-bar-note">Nothing is called Posted until the site really shows the requirement.</span></div>}
    >
      <div className="acw-wrap" style={{ display: 'block', overflowY: 'auto' }}>
        <div className="acw-form" style={{ overflow: 'visible' }}>
          <PostStep job={job} initial={placesFromSources(sources)} startTargets={startTargets} onDone={() => { onClose(); if (onChanged) onChanged(); }} />
        </div>
      </div>
    </Modal>
  );
}
