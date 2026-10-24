import { useJobPublish } from './JobPortalRows.jsx';
import NeedsHelp from './NeedsHelp.jsx';
import { portalName } from './jpKit.js';

// "Needs your help" boxes for ONE job, wherever the job is shown (the Post step, the job page). Renders nothing when no site
// is waiting for a person. It polls (every 7 s) only while something is queued / running / waiting, like the other job rows.
export default function JobHelp({ jobId, onChanged }) {
  const data = useJobPublish(jobId);
  const rows = (data.status && data.status.portals) || [];
  const canPost = !!(data.status && data.status.canPost);
  const need = rows.filter((p) => p.lastQueue && (p.lastQueue.waiting || (p.lastQueue.status === 'NEEDS_HUMAN' && p.lastQueue.help)));
  if (!need.length) return null;
  return (
    <div className="jp-wrap" aria-live="polite">
      {need.map((p) => <NeedsHelp key={p.portal} item={p.lastQueue} name={portalName(p.portal)} canPost={canPost} onChanged={() => { data.reload(); if (onChanged) onChanged(); }} />)}
    </div>
  );
}
