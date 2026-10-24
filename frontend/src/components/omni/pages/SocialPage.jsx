import { useCallback, useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Panel, Tabs, Pill, GsModal, Field, Banner, fmtDateTime } from '../ui.jsx';
import PostInsightsModal, { PLATFORMS } from '../external/PostInsightsModal.jsx';
import { useConnection } from '../external/useExternal.js';
import '../external/external.css';

// Social Media Management (prototype page social). The composer is real, but posting to the networks is PLANNED:
// "Post Now" and "Schedule" only SAVE the post here (status "Not sent yet" / "Scheduled") and say so. Nothing is published.
// Facebook / Instagram show their real connection state (from the connection on the Facebook / Instagram pages); the other networks are "Planned".
const ORDER = ['facebook', 'instagram', 'linkedin', 'threads', 'twitter', 'youtube'];
const REAL = ['facebook', 'instagram'];
const istDefault = () => { const d = new Date(Date.now() + 5.5 * 3600000 + 30 * 60000).toISOString(); return { date: d.slice(0, 10), time: d.slice(11, 16) }; };
const whenWords = (p) => (p.status === 'scheduled' ? `For ${fmtDateTime(p.scheduledAt)}` : `Saved ${fmtDateTime(p.createdAt)}`);

function PostSettingsModal({ selected, values, setValues, onClose }) {
  const has = selected.filter((k) => REAL.includes(k));
  return (
    <GsModal title="Platform-Specific Settings" sub="Saved with the post." width={560} onClose={onClose}
      foot={<Btn primary onClick={onClose} style={{ width: '100%' }}>Close and Save Settings</Btn>}>
      {has.length === 0 && <p style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 11 }}>No platform-specific settings for the selected platform(s).</p>}
      {has.includes('facebook') && (
        <div className="pss-section"><div className="pss-head">📘 Facebook Settings</div>
          <div className="pss-field"><label>Photo album name (optional)</label><input placeholder="Leave empty to post to the timeline" value={values.fbAlbum || ''} onChange={(e) => setValues({ ...values, fbAlbum: e.target.value })} maxLength={120} /></div>
        </div>
      )}
      {has.includes('instagram') && (
        <div className="pss-section"><div className="pss-head">📸 Instagram Settings</div>
          <label className="pss-checkbox"><input type="checkbox" checked={!!values.igHideCounts} onChange={(e) => setValues({ ...values, igHideCounts: e.target.checked })} /> Hide like and view counts on this post</label>
          <div className="pss-field"><label>Tag Location (Requires Location ID)</label><input placeholder="Location ID (optional)" value={values.igTagLocation || ''} onChange={(e) => setValues({ ...values, igTagLocation: e.target.value })} maxLength={120} /><div className="tpl-hint">Location IDs must correspond to a Facebook Page with a confirmed location.</div></div>
        </div>
      )}
    </GsModal>
  );
}

function ScheduleModal({ onClose, onConfirm }) {
  const [v, setV] = useState(istDefault);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!v.date || !v.time) { setErr('Pick a date and time first.'); return; }
    setBusy(true); setErr('');
    const e = await onConfirm(v);
    setBusy(false);
    if (e) setErr(e);
  };
  return (
    <GsModal title="Schedule send" sub="Pick a date and time to send this post." width={420} onClose={onClose}
      foot={<><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={busy} onClick={go}>{busy ? 'Saving…' : '📅 Schedule send'}</Btn></>}>
      <Field label="DATE"><input type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></Field>
      <div style={{ marginTop: 13 }}><Field label="TIME (IST)"><input type="time" value={v.time} onChange={(e) => setV({ ...v, time: e.target.value })} /></Field></div>
      <p style={{ fontSize: 9.5, color: 'var(--muted)', margin: '10px 0 0' }}>All times are in India Standard Time (Asia/Kolkata). The post is saved as Scheduled. Nothing is published: posting to the network is planned.</p>
      {err && <div className="ext-err" role="alert">{err}</div>}
    </GsModal>
  );
}

export default function SocialPage() {
  const { go, toast, dept } = useOmni();
  const { conn, error } = useConnection('meta-social');
  const [org, setOrg] = useState('TeamLink');
  const [sel, setSel] = useState([]);
  const [text, setText] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  const [vals, setVals] = useState({});
  const [pv, setPv] = useState(null);
  const [tab, setTab] = useState('notsent');
  const [size, setSize] = useState(10);
  const [list, setList] = useState({ posts: [], counts: { notsent: 0, scheduled: 0 }, loading: true, error: '' });
  const [showSettings, setShowSettings] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [insight, setInsight] = useState(null);
  const [busy, setBusy] = useState(false);

  const metaOk = conn && conn.status === 'connected';
  const info = (metaOk && conn.info) || {};
  const accountOf = (k) => (k === 'facebook' ? (info.pageName || 'Facebook') : k === 'instagram' ? (info.igUsername ? `@${info.igUsername}` : 'Instagram') : PLATFORMS[k].label);
  const stateOf = (k) => {
    if (!REAL.includes(k)) return 'planned';
    if (!conn || conn.status === 'not_connected') return 'off';
    if (conn.status === 'saved') return 'saved';
    if (conn.status === 'failed') return 'failed';
    return k === 'instagram' && !info.igUsername ? 'noig' : 'on';
  };

  const load = useCallback(async () => {
    try {
      const d = await omni.get('/gs/external/social/posts', { tab, limit: size });
      setList({ posts: d.posts || [], counts: d.counts || { notsent: 0, scheduled: 0 }, loading: false, error: '' });
    } catch (e) { setList((s) => ({ ...s, loading: false, error: errOf(e, 'The posts could not be loaded.') })); }
  }, [tab, size, dept]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  const toggle = (k) => {
    if (!REAL.includes(k)) { toast(`${PLATFORMS[k].label} posting is planned. It cannot be picked yet.`); return; }
    setSel((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));
  };
  const previewKey = pv && sel.includes(pv) ? pv : sel[0];
  const plat = previewKey ? PLATFORMS[previewKey] : null;

  const save = async (schedule) => {
    if (!sel.length) { toast('Select at least one platform'); return 'Select at least one platform'; }
    if (!text.trim()) { toast('Write the post text first'); return 'Write the post text first.'; }
    try {
      setBusy(true);
      const d = await omni.post('/gs/external/social/posts', { platforms: sel, text, mediaUrl, organization: org, settings: vals, schedule: schedule || null });
      setText(''); setMediaUrl('');
      setTab(schedule ? 'scheduled' : 'notsent');
      await load();
      toast(schedule ? `Saved as Scheduled for ${schedule.date} ${schedule.time} IST (Post #${d.post.postNumber}). Nothing is published yet.` : `Saved as Post #${d.post.postNumber}. Nothing is published yet.`);
      return '';
    } catch (e) { const m = errOf(e, 'The post could not be saved.'); toast(m); return m; } finally { setBusy(false); }
  };
  const openSchedule = () => {
    if (!sel.length) { toast('Select at least one platform'); return; }
    if (!text.trim()) { toast('Write the post text first'); return; }
    setShowSchedule(true);
  };
  const confirmSchedule = async (v) => { const e = await save(v); if (!e) setShowSchedule(false); return e; };
  const edit = (p) => { setSel(p.platforms.filter((k) => REAL.includes(k))); setText(p.text || ''); setMediaUrl(p.mediaUrl || ''); setVals(p.settings || {}); toast('Loaded into the composer. Change it and save again.'); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const remove = async (p) => { try { await omni.del(`/gs/external/social/posts/${p.id}`); await load(); toast('Post deleted'); } catch (e) { toast(errOf(e, 'The post could not be deleted.')); } };
  const mediaLooksOk = /^https?:\/\//i.test(mediaUrl.trim());

  const tile = (k) => {
    const p = PLATFORMS[k]; const st = stateOf(k); const on = sel.includes(k);
    if (st === 'planned') {
      return <div key={k} className="social-platform-tile ext-tile-off" title={`${p.label} posting is planned`} onClick={() => toggle(k)}><span style={{ fontSize: 20, color: p.color }}>{p.icon}</span><span style={{ fontSize: 9, fontWeight: 800, textAlign: 'center' }}>{p.label}</span><span style={{ fontSize: 8, color: 'var(--muted)', textAlign: 'center', fontWeight: 700 }}>Planned</span></div>;
    }
    const sub = st === 'on' ? accountOf(k) : st === 'saved' ? 'Saved, not verified' : st === 'failed' ? 'Check failed' : st === 'noig' ? 'No Instagram account added' : 'Not connected';
    return (
      <div key={k} className={`social-platform-tile${on ? ' selected' : ''}`} onClick={() => toggle(k)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') toggle(k); }}>
        <span className="sp-check">✓</span>
        <span style={{ fontSize: 20, color: p.color }}>{p.icon}</span>
        <span style={{ fontSize: 9, fontWeight: 800, textAlign: 'center' }}>{p.label}</span>
        <span style={{ fontSize: 8, color: 'var(--muted)', textAlign: 'center' }}>{sub}</span>
        {st !== 'on' && <button type="button" className="link-btn" style={{ fontSize: 8 }} onClick={(e) => { e.stopPropagation(); go(k === 'facebook' ? 'fbchannel' : 'igchannel'); }}>Connect →</button>}
      </div>
    );
  };

  return (
    <div>
      <PageHead eyebrow="Organic & paid reach" title="Social Media Management" lead="Connect accounts, publish content from your library, and monitor performance." />
      {error && <Banner tone="error">{error}</Banner>}
      <div className="ext-split">
        <div className="card panel">
          <p className="panel-title">Publish a post</p>
          <Banner tone="warn">Posting to the network is planned: nothing is published. "Post Now" and "Schedule" only save your post in the list below.</Banner>
          <label className="console-label" style={{ marginTop: 12 }}>Posting As Organization</label>
          <input className="select" style={{ width: '100%', marginTop: 6 }} value={org} onChange={(e) => setOrg(e.target.value)} maxLength={80} aria-label="Posting as organization" />
          <label className="console-label" style={{ marginTop: 16 }}>Select Platforms <button type="button" className="link-btn" style={{ marginLeft: 6 }} onClick={() => { go('fbchannel'); toast('Connect your Facebook Page and Instagram account on their pages: they appear here automatically'); }}>Connect accounts →</button></label>
          <div className="ext-tiles">{ORDER.map(tile)}</div>
          {sel.includes('facebook') && (
            <div className="page-select-panel">
              <div className="page-select-head">📘 Select Facebook Pages</div>
              {metaOk && info.pageName
                ? <label className="page-select-row"><input type="checkbox" checked readOnly /> {info.pageName}</label>
                : <div className="page-select-warn">⚠ No Facebook Page is connected yet. <button type="button" className="link-btn" onClick={() => go('fbchannel')}>Connect it</button>. Your post is only saved here for now.</div>}
            </div>
          )}
          <div className="field" style={{ marginTop: 16 }}>
            <label>POST TEXT</label>
            <div className="ext-posttext"><textarea aria-label="Post text" placeholder="Write what you want to say…" value={text} onChange={(e) => setText(e.target.value)} maxLength={5000} /></div>
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <label>PICTURE OR VIDEO LINK (OPTIONAL)</label>
            <input placeholder="https://…" value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} maxLength={500} />
            {mediaUrl.trim() && !mediaLooksOk && <div className="ext-err">The link must start with http:// or https://</div>}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, gap: 8 }}>
            <span style={{ fontSize: 9, color: 'var(--muted)' }}>Content can also be written in Content Studio.</span>
            <button type="button" className="link-btn" onClick={() => go('studio')}>✎ Create in Content Studio →</button>
          </div>
          <div className="ext-triple">
            <Btn onClick={() => { if (!sel.length) { toast('Select at least one platform first'); return; } setShowSettings(true); }}>⚙ Configure Post Settings</Btn>
            <Btn primary disabled={busy} onClick={() => save(null)}>➤ Post Now</Btn>
            <Btn disabled={busy} onClick={openSchedule}>📅 Schedule</Btn>
          </div>
        </div>
        <div className="card panel" style={{ position: 'sticky', top: 14 }}>
          <p className="panel-title">Live Preview</p>
          <p className="panel-sub">{plat ? `How this post looks on ${plat.label}` : 'How this post looks to your audience.'}</p>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: 12 }}>
            {sel.length > 1 && <div className="social-preview-switcher">{sel.map((k) => <button type="button" key={k} className={`social-preview-switch-btn${k === previewKey ? ' active' : ''}`} style={{ color: PLATFORMS[k].color }} title={PLATFORMS[k].label} onClick={() => setPv(k)}>{PLATFORMS[k].icon}</button>)}</div>}
            {!plat
              ? <div className="preview-placeholder"><div className="ph-icon">📱</div><div style={{ fontSize: 11, fontWeight: 800 }}>Select a platform</div><div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 5, maxWidth: 200 }}>Choose at least one platform above to preview your post.</div></div>
              : (
                <div className="phone" style={{ width: 250, minHeight: 460, transform: 'scale(.92)', transformOrigin: 'top center' }}>
                  <div className="phone-top"><span>{plat.label}</span><span>9:41</span></div>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '8px 4px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <span style={{ width: 26, height: 26, borderRadius: '50%', background: `${plat.color}22`, color: plat.color, display: 'grid', placeItems: 'center', fontSize: 12 }}>{plat.icon}</span>
                      <div><b style={{ fontSize: 9, display: 'block' }}>{accountOf(previewKey)}</b><small style={{ fontSize: 7, color: 'var(--muted)' }}>{org}</small></div>
                    </div>
                    {mediaLooksOk && <div className="media-preview-box" style={{ background: 'none', padding: 0, overflow: 'hidden' }}><img src={mediaUrl.trim()} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} /></div>}
                    <div style={{ fontSize: 9, lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: mediaLooksOk ? 8 : 0 }}>{text.trim() ? text : <span style={{ color: 'var(--muted)' }}>Your post content will appear here…</span>}</div>
                    <div style={{ display: 'flex', gap: 14, marginTop: 12, fontSize: 13, color: 'var(--muted)' }}><span>♡</span><span>💬</span><span>↗</span></div>
                  </div>
                </div>
              )}
          </div>
        </div>
      </div>

      <div className="card panel" style={{ marginTop: 16 }}>
        <div className="panel-top">
          <div className="panel-title">Posts</div>
          <select className="select" aria-label="Rows per page" value={size} onChange={(e) => setSize(Number(e.target.value))}><option value={10}>10</option><option value={20}>20</option></select>
        </div>
        <Tabs tabs={[['notsent', 'Not sent yet'], ['scheduled', 'Scheduled']]} value={tab} onChange={setTab} className="" />
        <div style={{ marginTop: 12, display: 'grid', gap: 2 }}>
          {list.error && <Banner tone="error">{list.error}</Banner>}
          {list.posts.map((p) => {
            const k = p.platforms[0]; const pl = PLATFORMS[k] || PLATFORMS.facebook;
            return (
              <div className="social-post-row" key={p.id}>
                <span className="social-post-icon" style={{ background: pl.color }}>{pl.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b style={{ fontSize: 10 }}>Post #{p.postNumber}</b> <Pill tone={p.status === 'scheduled' ? 'scheduled' : 'draft'}>{p.statusWords}</Pill>
                  <div style={{ fontSize: 8, color: 'var(--accent,#11985a)', fontWeight: 700 }}>to {accountOf(k)}{p.platforms.length > 1 ? ` +${p.platforms.length - 1} more` : ''}</div>
                  <div style={{ fontSize: 8, color: 'var(--muted)' }}>{whenWords(p)}{p.createdByName ? ` · ${p.createdByName}` : ''}</div>
                  <div className="ext-post-text">{p.text}</div>
                </div>
                <TinyBtn onClick={() => setInsight(p)} title="Post insights">ⓘ</TinyBtn>
                <TinyBtn onClick={() => edit(p)} title="Load into the composer">✎</TinyBtn>
                <TinyBtn onClick={() => remove(p)} title="Delete this post">🗑</TinyBtn>
              </div>
            );
          })}
          {!list.posts.length && <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 11, padding: '24px 0' }}>{list.loading ? 'Loading…' : tab === 'scheduled' ? 'No scheduled posts yet.' : 'No saved posts yet. Nothing has been published.'}</div>}
        </div>
      </div>
      {showSettings && <PostSettingsModal selected={sel} values={vals} setValues={setVals} onClose={() => { setShowSettings(false); toast('Platform-specific settings saved'); }} />}
      {showSchedule && <ScheduleModal onClose={() => setShowSchedule(false)} onConfirm={confirmSchedule} />}
      {insight && <PostInsightsModal post={insight} onClose={() => setInsight(null)} />}
    </div>
  );
}
