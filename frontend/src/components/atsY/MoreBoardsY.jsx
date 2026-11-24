import api from '../../api';
import { Flash, useGet, useRun, when } from '../mktb/kit.jsx';

// ---------------------------------------------------------------------------
// REQUIREMENT > "Where it is posted" (ATS wave 2 Y): foundit (formerly Monster India, 10.09) - post / update / take down on the partner
// contract - and LinkedIn Recruiter System Connect (10.10) - send the job to LinkedIn Recruiter. Both need the founder's partner accounts;
// until then the row says what is missing. Nothing is drawn for a login that cannot see the requirement's posting.
// ---------------------------------------------------------------------------
const Y = '/ats/y';

export default function MoreBoardsY({ requirementId, internal }) {
  const f = useGet(internal ? null : `${Y}/jobs/${requirementId}/foundit`);
  const rsc = useGet(internal ? null : `${Y}/rsc`);
  const { busy, msg, run } = useRun();
  if (internal || !f.data) return null;
  const d = f.data; const post = d.post;
  const live = post && ['Posted', 'Pending'].includes(post.status);
  return (
    <div style={{ marginTop: 8 }} data-testid="atsy-boards">
      <div className="mkb-row" style={{ flexWrap: 'wrap', gap: 6 }}>
        <b style={{ fontSize: 12 }}>foundit</b>
        <span className="small-muted">{post ? `${post.status}${post.externalId ? ` (id ${post.externalId})` : ''} · ${post.by || ''} ${when(post.at)}${post.message ? ` · ${post.message}` : ''}` : (d.ready ? 'Not posted yet.' : d.hint)}</span>
        {post && post.externalUrl && <a href={post.externalUrl} target="_blank" rel="noreferrer" className="small-muted">open</a>}
        {d.canPost && d.ready && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${Y}/jobs/${requirementId}/foundit`), (r) => `foundit: ${r.data.post.status}.`).then(f.reload)}>{live ? 'Update on foundit' : 'Post to foundit'}</button>}
        {d.canPost && d.ready && live && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => run(() => api.delete(`${Y}/jobs/${requirementId}/foundit`), 'Taken off foundit.').then(f.reload)}>Take down</button>}
      </div>
      {rsc.data && (rsc.data.ready || rsc.data.switchOn) && d.canPost && (
        <div className="mkb-row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <b style={{ fontSize: 12 }}>LinkedIn Recruiter (RSC)</b>
          <span className="small-muted">{!rsc.data.ready ? rsc.data.hint : (!rsc.data.switchOn ? 'Switched off by the Admin.' : 'Shows this job and its candidates inside LinkedIn Recruiter.')}</span>
          <button type="button" className="btn btn-sm" disabled={busy || !rsc.data.ready || !rsc.data.switchOn} onClick={() => run(() => api.post(`${Y}/rsc/jobs/${requirementId}`), 'Sent to LinkedIn Recruiter.')}>Send to LinkedIn</button>
        </div>
      )}
      <Flash msg={msg} />
    </div>
  );
}
