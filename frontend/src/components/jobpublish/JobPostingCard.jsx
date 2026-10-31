import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import JpModal from './JpModal.jsx';
import JobPortalRows, { useJobPublish } from './JobPortalRows.jsx';
import PublishPopup from './PublishPopup.jsx';
import { PostingHistory } from './PostingLogs.jsx';
import { PortalChipRow } from './PublishChips.jsx';
import NeedsHelp from './NeedsHelp.jsx';
import { NOT_ON_WORDS, PORTALS, portalName, when } from './jpKit.js';
import './jobpublish.css';

// ---------------------------------------------------------------------------
// JOB POSTING STATUS card on the Job page.
//   site chips (icon + words) · the last 5 log lines (not shown to a Recruiter: the server sends none) ·
//   [Post this job] (people who may post) · [See what each site says] · [See full history]
// <JobPostingCard jobId title canPost onChanged />
// ---------------------------------------------------------------------------
export default function JobPostingCard({ jobId, title, canPost, onChanged, onPost = null }) { // onPost: open another screen (the Post step with logins) instead of the plain popup
  const data = useJobPublish(jobId);
  const [popup, setPopup] = useState(false);
  // the places the job went live from the "Posting sources" list too (TeamLink Job Portal, Website, boards marked posted by hand):
  // one View list for every place, whichever button posted it (founder 2026-10-31: "view ... redirect avvali ahh site ki")
  const [sites, setSites] = useState([]);
  useEffect(() => {
    let on = true;
    api.get(`/requirements/${jobId}/posting-sites`).then((r) => { if (on) setSites((r.data && r.data.sites) || []); }).catch(() => { if (on) setSites([]); });
    return () => { on = false; };
  }, [jobId, data.status]);
  const [detail, setDetail] = useState(false);
  const [history, setHistory] = useState(false);
  const postings = (data.status && data.status.portals) || [];
  const last5 = useMemo(() => postings
    .flatMap((p) => (p.logs || []).map((l) => ({ ...l, portal: p.portal })))
    .sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 5), [postings]);
  const touched = postings.filter((p) => p.status && p.status !== 'DRAFT').map((p) => p.portal);
  const showLogs = !!(data.status && data.status.canViewLogs);
  const changed = () => { data.reload(); if (onChanged) onChanged(); };

  return (
    <section className="card section jp-pcard" aria-labelledby="jp-card-h">
      <div className="jp-row">
        <b id="jp-card-h" style={{ fontSize: 13 }}>Job posting status</b>
        <span className="jp-spacer" />
        {canPost && !data.notOn && <button type="button" className="btn btn-sm btn-primary" onClick={() => (onPost ? onPost() : setPopup(true))}>Post this requirement</button>}
      </div>
      {data.loading && <div className="jp-note" role="status">Loading...</div>}
      {data.notOn && <div className="jp-off" role="status"><b>Job publishing is not switched on yet</b><span>{NOT_ON_WORDS}</span></div>}
      {data.error && <div className="jp-err" role="alert">{data.error}</div>}
      {!data.loading && !data.notOn && !data.error && (
        <>
          <div aria-live="polite">
            {touched.length > 0
              ? <PortalChipRow postings={postings} infos={data.infos} only={touched} />
              : (sites.some((x) => x.link)
                ? <span className="jp-note">Posted on {sites.filter((x) => x.link).map((x) => x.name).join(', ')}. {canPost ? 'Press Post this requirement for Facebook, Instagram and the other places.' : ''}</span>
                : <span className="jp-note">Not posted from here yet. {canPost ? 'Press Post this requirement.' : 'The team lead posts it.'}</span>)}
          </div>
          {/* VIEW: open the post itself where it went live - the Facebook post, the Instagram post, the job board page
              (founder 2026-10-31: "view click chesthe, ekkadaithey job post ayyindho akkadaki redirect avvali") */}
          {(() => {
            const links = postings.flatMap((p) => [
              ...(p.status === 'PUBLISHED' && p.portalUrl ? [{ key: p.portal, name: portalName(p.portal), url: p.portalUrl }] : []),
              ...((p.extraPosts || []).filter((x) => x.url).map((x, i) => ({ key: `${p.portal}-x${i}`, name: `${portalName(p.portal)}${x.name ? ` (${x.name})` : ''}`, url: x.url }))),
            ]);
            sites.filter((x) => x.link && !links.some((l) => l.url === x.link)).forEach((x, i) => links.push({ key: `site-${x.id || i}`, name: x.name, url: x.link }));
            if (!links.length) return null;
            return (
              <div className="jp-row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                <span className="jp-note">View the post:</span>
                {links.map((l) => <a key={l.key} className="btn btn-sm" href={l.url} target="_blank" rel="noreferrer">View on {l.name} ↗</a>)}
              </div>
            );
          })()}
          {postings.filter((p) => p.lastQueue && (p.lastQueue.waiting || (p.lastQueue.status === 'NEEDS_HUMAN' && p.lastQueue.help))).map((p) => (
            <NeedsHelp key={p.portal} item={p.lastQueue} name={portalName(p.portal)} canPost={canPost} onChanged={changed} />
          ))}
          {showLogs && last5.length > 0 && (
            <ul className="jp-logs" aria-label="Latest lines of the log">
              {last5.map((l, i) => <li key={i}><span className="t">{when(l.at)}</span><span>{portalName(l.portal)}</span><span className={`jp-lvl-${l.level}`}>{l.message}</span></li>)}
            </ul>
          )}
          <div className="jp-row">
            <button type="button" className="btn btn-sm" onClick={() => setDetail(true)}>See each site</button>
            {showLogs && <button type="button" className="btn btn-sm" onClick={() => setHistory(true)}>See full history</button>}
          </div>
        </>
      )}
      {popup && <PublishPopup jobIds={[jobId]} titles={{ [jobId]: title }} onClose={() => { setPopup(false); data.reload(); }} onDone={changed} />}
      {detail && (
        <JpModal title={`Sites for ${title || 'this requirement'}`} onClose={() => setDetail(false)} foot={<button type="button" className="btn" onClick={() => setDetail(false)}>Close</button>}>
          <JobPortalRows jobId={jobId} data={data} canPost={canPost} onChanged={changed} showLogs={showLogs} only={PORTALS.map((p) => p.key)} />
        </JpModal>
      )}
      {history && (
        <JpModal title={`History of ${title || 'this requirement'}`} size="is-wide" onClose={() => setHistory(false)} foot={<button type="button" className="btn" onClick={() => setHistory(false)}>Close</button>}>
          <PostingHistory jobId={jobId} />
        </JpModal>
      )}
    </section>
  );
}
