import { useState } from 'react';
import Modal from '../../Modal.jsx';
import PostStep, { placesFromSources } from './PostStep.jsx';
import { PostRecipientsStep } from '../ResponseRecipients.jsx';
import '../../clients/clientForm.css';
import '../../clients/addClientModal.css';
import './reqsplit.css';

// The Post step on its own, for a job that is already saved ("Post this job" on the job page): sites, logins, dry run, results.
// Founder 2026-11-20 (the requirement flow, step 4): the department TL ticks WHO RECEIVES THE RESPONSES and posts it. Both stay:
// the assigned recruiters (they work and source the job - POST /requirements/:id/assign, unchanged) and the response recipients
// (PUT /requirements/:id/response-recipients: each new response goes to one of them in turn - utils/responseRecipients.js).
// After posting: "Successfully posted. Now the responses go to <names>."
const SAVED_ONLY_START = 'Saved. Nothing was posted yet';

export default function PostStepDialog({ job, sources = [], onClose, onChanged, startTargets = null, canAssign = false }) {
  const [owner, setOwner] = useState(null); // { names } once the recipients are saved
  const [posted, setPosted] = useState(false);
  const close = () => { onClose(); if (onChanged) onChanged(); };
  const done = (res) => {
    const summary = res && res.summary ? String(res.summary) : '';
    if (summary && !summary.startsWith(SAVED_ONLY_START)) { setPosted(true); if (onChanged) onChanged(); return; }
    close();
  };

  let body;
  if (posted) {
    body = (
      <div className="notice green" role="status" style={{ margin: 16 }}>
        <b>Successfully posted.</b>
        {owner && owner.names ? ` Now the responses go to ${owner.names}${owner.many ? ', one by one in turn' : ''}.` : ' The responses go to the job\'s recruiter.'}
      </div>
    );
  } else if (!owner) {
    body = <PostRecipientsStep job={job} canAssign={canAssign} onDone={(r) => { setOwner({ names: r.names, many: (r.people || []).length > 1 }); if (onChanged) onChanged(); }} />;
  } else {
    body = (
      <>
        <div className="small-muted" style={{ padding: '8px 16px 0' }}>{owner.names ? `Responses go to: ${owner.names}` : 'Responses go to the job\'s recruiter'}</div>
        <PostStep job={job} initial={placesFromSources(sources)} startTargets={startTargets} onDone={done} stay />
      </>
    );
  }

  return (
    <Modal
      title={`Post this requirement — ${job.title}`}
      size="xwide acw-modal"
      onClose={close}
      footer={(
        <div className="cf-bar">
          {posted
            ? <button type="button" className="btn btn-primary" onClick={close}>Close</button>
            : <span className="cf-bar-note">Nothing is called Posted until the site really shows the requirement.</span>}
        </div>
      )}
    >
      <div className="acw-wrap" style={{ display: 'block', overflowY: 'auto' }}>
        <div className="acw-form" style={{ overflow: 'visible' }}>{body}</div>
      </div>
    </Modal>
  );
}
