import { useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { Btn, GsModal, Banner, fmtDateTime } from '../ui.jsx';
import './external.css';

// The prototype's "Post Insights" sheet (postInsightsModal). Used by this Social Media page and meant for Analytics > Social "Post Performance" rows.
//   <PostInsightsModal postId="..." onClose={...} />   (or pass `post` when you already have the saved post)
// HONEST: a post here is only SAVED (posting to the network is planned), so views / likes / comments are "Not synced yet", never invented numbers.
export const PLATFORMS = {
  facebook: { label: 'Facebook', icon: '📘', color: '#1877f2' },
  instagram: { label: 'Instagram', icon: '📸', color: '#d6249f' },
  linkedin: { label: 'LinkedIn', icon: '💼', color: '#0a66c2' },
  threads: { label: 'Threads', icon: '🧵', color: '#111111' },
  twitter: { label: 'X (Twitter)', icon: '✕', color: '#111111' },
  youtube: { label: 'YouTube', icon: '▶', color: '#ff0000' },
};
export default function PostInsightsModal({ postId, post: given, onClose }) {
  const [post, setPost] = useState(given || null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (given || !postId) return undefined;
    let on = true;
    omni.get(`/gs/external/social/posts/${postId}`).then((d) => { if (on) setPost(d.post); }).catch((e) => { if (on) setErr(errOf(e, 'The post could not be loaded.')); });
    return () => { on = false; };
  }, [postId, given]);
  const p = post && PLATFORMS[(post.platforms || [])[0]];
  return (
    <GsModal title="Post Insights" width={900} onClose={onClose} foot={<Btn onClick={onClose}>Close</Btn>}>
      {err && <Banner tone="error">{err}</Banner>}
      {!post && !err && <p style={{ fontSize: 11 }}>Loading…</p>}
      {post && (
        <div className="ext-insights">
          <div>
            <div style={{ minHeight: 220, borderRadius: 14, background: `${(p && p.color) || '#11985a'}18`, display: 'grid', placeItems: 'center', textAlign: 'center', padding: 16, overflow: 'hidden' }}>
              {post.mediaUrl
                ? <img src={post.mediaUrl} alt="" style={{ maxWidth: '100%', maxHeight: 260, borderRadius: 10 }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                : <div><div style={{ fontSize: 26 }}>{p ? p.icon : '📱'}</div><b style={{ fontSize: 12 }}>{p ? p.label : 'Post'} Post Preview</b><div style={{ fontSize: 10, color: 'var(--muted)' }}>No picture or video was added.</div></div>}
            </div>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11, margin: '12px 0 6px' }}><span>👍 — Likes</span><span>💬 — Comments</span><span>👁 — Views</span></div>
            <div style={{ fontSize: 9.5, color: 'var(--muted)', fontWeight: 800 }}>⏱ {post.status === 'scheduled' ? `SCHEDULED FOR ${fmtDateTime(post.scheduledAt)}` : `SAVED ${fmtDateTime(post.createdAt)}`}</div>
            <div className="ext-post-text" style={{ fontSize: 11, marginTop: 8 }}>{post.text || 'Untitled Post'}</div>
          </div>
          <div>
            <div style={{ fontWeight: 850, fontSize: 12, marginBottom: 8 }}>Comments</div>
            <div className="ca-empty" style={{ padding: '24px 8px' }}>
              <b style={{ fontSize: 11, color: 'var(--ink)' }}>Not synced yet</b>
              <div style={{ fontSize: 10, marginTop: 4 }}>Posting to the network is planned: this post is saved here, nothing is published. Views, likes and comments will appear once posts are published and synced.</div>
            </div>
          </div>
        </div>
      )}
    </GsModal>
  );
}
