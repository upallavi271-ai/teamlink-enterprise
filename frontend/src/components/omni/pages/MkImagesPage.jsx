import { useCallback, useEffect, useRef, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { getState } from '../omniStore.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Panel, Pill, Banner, Field, Tabs, Empty, ConfirmModal, GsModal, fmtDateTime } from '../ui.jsx';
import { MkStatus, MkImg, downloadMkImg, ClientChip } from '../marketing/mk.jsx';
import ClientReviewModal from '../marketing/ClientReviewModal.jsx';
import PostItemModal from '../marketing/PostItemModal.jsx';
import AutoStudioPanel from '../marketing/AutoStudioPanel.jsx';
import '../marketing/marketing.css';

// AI MARKETING > AI IMAGES: ONE place to make pictures, "✦ Create from your content" (AutoStudioPanel: type an idea, TeamLink makes the post pictures by itself, free).
// The second, separate "1 · Describe the picture" form (Google Gemini only, which needs billing and so never made a picture here) was removed on the founder's
// request (16 Nov 2026: "keep one, the best, free"). An AI-made picture is still available inside the one box (More options > Pictures) when a picture AI is connected.
// Every picture is saved here; it is used (calendar, posts) only after approval, and only approved pictures get a public link. Server: marketing/images.js.
const STYLE_WORDS = { photo: 'Photo', illustration: 'Illustration', graphic: 'Social graphic', poster: 'Minimal poster', '3d': '3D', upload: 'Uploaded', banner: 'Banner' };
const UPLOAD_MAX = 10 * 1024 * 1024;
// the changes a client asked for (marketing/revision.js): TeamLink changes the picture and sends it again by itself; this shows where each one is, and the history with the versions side by side
const RV_TONE = { processing: 'live', sent: 'warn', completed: 'warn', failed: 'error', 'needs-person': 'draft' };
const RV_METHOD = { rules: 'read by plain rules', ai: 'read by the AI model', 'rules+ai': 'read by plain rules and the AI model', 'ai-edit': 'changed by the AI picture model, using the picture as the reference' };
function RevisionModal({ item, onClose }) {
  const [d, setD] = useState(null); const [err, setErr] = useState('');
  const latest = (item.version || 1) - 1; const [a, setA] = useState(0); const [b, setB] = useState(latest);
  useEffect(() => { omni.get(`/gs/marketing/images/${item.id}/revisions`).then(setD).catch((e) => setErr(errOf(e, 'The history could not be read.'))); }, [item.id]);
  const options = Array.from({ length: latest + 1 }, (_, k) => k);
  const word = (k) => (k === 0 ? 'Version 1 (the original)' : `Version ${k + 1}${k === latest ? ' (the latest)' : ''}`);
  return (
    <GsModal title={`Changes asked for: ${item.title}`} sub={`Version ${item.version || 1} now. The original is always kept.`} width={1100} onClose={onClose} foot={<Btn primary onClick={onClose}>Close</Btn>}>
      {err ? <Banner tone="error">{err}</Banner> : null}
      {latest > 0 ? (
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
            <b style={{ fontSize: 12.5 }}>Compare</b>
            <select aria-label="First version to compare" value={a} onChange={(e) => setA(Number(e.target.value))}>{options.map((k) => <option key={k} value={k}>{word(k)}</option>)}</select>
            <span>with</span>
            <select aria-label="Second version to compare" value={b} onChange={(e) => setB(Number(e.target.value))}>{options.map((k) => <option key={k} value={k}>{word(k)}</option>)}</select>
          </div>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 12 }}>
            {[a, b].map((k, i) => <figure key={i} style={{ margin: 0 }}><MkImg id={item.id} version={k} ver={item.revision && item.revision.at ? 1 : 0} alt={word(k)} style={{ width: '100%', objectFit: 'contain', background: '#111' }} /><figcaption style={{ fontSize: 11.5, marginTop: 4 }}>{word(k)}</figcaption></figure>)}
          </div>
        </div>
      ) : null}
      {!d ? (err ? null : <div>Loading…</div>) : (d.revisions.length ? d.revisions.map((r) => (
        <div key={r.id} style={{ borderTop: '1px solid var(--line, #e2e8f0)', padding: '10px 0', fontSize: 12.5 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><b>Version {r.version}</b><Pill tone={RV_TONE[r.status] || 'draft'} dot>{r.label}</Pill><span style={{ color: 'var(--muted)' }}>asked {fmtDateTime(r.createdAt)}{r.sentAt ? ` · sent again ${fmtDateTime(r.sentAt)}` : ''}</span></div>
          <div style={{ marginTop: 4 }}><b>{r.clientName || 'The client'} wrote:</b> “{r.feedback}”</div>
          {r.summary.length ? <div style={{ marginTop: 2 }}><b>What TeamLink did{r.method ? ` (${RV_METHOD[r.method] || r.method})` : ''}:</b> {r.summary.join(' ')}</div> : null}
          {r.unclear.length ? <div style={{ marginTop: 2, color: '#8a6410' }}><b>Not done (a person has to):</b> {r.unclear.join(' / ')}</div> : null}
          {r.error ? <div style={{ marginTop: 2, color: '#9b1c1c' }}>{r.error}</div> : null}
        </div>
      )) : <div style={{ color: 'var(--muted)' }}>The client has not asked for changes on this picture yet.</div>)}
    </GsModal>
  );
}

export default function MkImagesPage() {
  const { toast, go } = useOmni();
  const [meta, setMeta] = useState(null);
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [tab, setTab] = useState('');
  const [view, setView] = useState(null); // the picture opened large
  const [del, setDel] = useState(null);
  const [rename, setRename] = useState(null);
  const [hist, setHist] = useState(null); // the picture whose change history is open
  const [toClient, setToClient] = useState(null); // the picture being sent to a client
  const [postIt, setPostIt] = useState(null); // the approved picture being posted on social accounts
  const [proj, setProj] = useState(null); // a client project these pictures are made for (?project=<id>): its logo and colours are used (marketing/projects.js)
  const projectId = (() => { try { return new URLSearchParams(window.location.search).get('project') || ''; } catch { return ''; } })();
  useEffect(() => { if (projectId) omni.get(`/gs/marketing/projects/${projectId}`).then((x) => setProj({ id: x.project.id, clientName: x.project.clientName, occasion: x.project.occasion, hasLogo: x.project.hasLogo })).catch(() => setProj(null)); }, [projectId]);
  const fileRef = useRef(null);
  // the person's own pictures (phone, Canva, the Gemini app): up to 5 at a time, each saved like an AI picture and approved before use
  const upload = async (e) => {
    const files = [...(e.target.files || [])]; e.target.value = '';
    if (!files.length) return;
    if (files.length > 5) { toast('Upload at most 5 pictures at a time'); return; }
    const bad = files.find((x) => !/^image\/(png|jpeg|webp)$/.test(x.type) || x.size > UPLOAD_MAX);
    if (bad) { toast(`"${bad.name}": use a PNG, JPG or WebP under 10 MB`); return; }
    setBusy('upload'); setMsg('');
    let ok = 0; const failed = [];
    for (const x of files) {
      try { await omni.post('/gs/marketing/images/upload', x, { headers: { 'Content-Type': x.type }, params: { title: x.name, ...(projectId ? { projectId } : {}), ...(getState().dept ? { department: getState().dept } : {}) }, timeout: 120000 }); ok += 1; } // eslint-disable-line no-await-in-loop
      catch (er) { failed.push(`${x.name}: ${errOf(er, 'not saved')}`); }
    }
    setBusy(''); setTab(''); load();
    toast(`${ok} picture${ok === 1 ? '' : 's'} uploaded${failed.length ? `, ${failed.length} not` : ''}. Ask for approval to use them.`);
    if (failed.length) setMsg(`Not uploaded: ${failed.join(' · ')}`);
  };

  const load = useCallback(() => {
    setErr('');
    omni.get('/gs/marketing/images/meta').then(setMeta).catch((e) => setErr(errOf(e, 'AI Images could not be opened.')));
    omni.get('/gs/marketing/images', { kind: 'image' }).then((d) => setList(d.items || [])).catch((e) => setErr(errOf(e, 'The pictures could not be read.')));
  }, []);
  useEffect(() => { load(); }, [load]);
  // while TeamLink is changing a picture after a client's request, the list refreshes every few seconds so the status is live (no need to reload)
  const processing = (list || []).some((i) => i.revision && i.revision.status === 'processing');
  useEffect(() => {
    if (!processing) return undefined;
    const t = setInterval(() => { omni.get('/gs/marketing/images', { kind: 'image' }).then((d) => setList(d.items || [])).catch(() => {}); }, 4000);
    return () => clearInterval(t);
  }, [processing]);
  if (err && (!meta || !list)) return <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={load}>Try again</button></Banner>;
  if (!meta || !list) return <div className="card panel">Loading…</div>;

  const act = async (it, what) => {
    setBusy(it.id);
    try {
      if (what === 'submit') { const r = await omni.post(`/gs/marketing/images/${it.id}/submit`); toast(r.ok); }
      load();
    } catch (e) { toast(errOf(e, 'That did not work.')); } finally { setBusy(''); }
  };
  const tryAgain = async (it) => { setBusy(it.id); try { const r = await omni.post(`/gs/marketing/revisions/${it.revision.id}/retry`); toast(r.revised ? 'Changed and sent again' : (r.needsPerson ? `Not changed: ${r.needsPerson}` : (r.failed ? `Failed: ${r.failed}` : (r.ok || 'Done')))); load(); } catch (e) { toast(errOf(e, 'It could not be tried again.')); } finally { setBusy(''); } };
  const remove = async () => { const it = del; setDel(null); try { await omni.del(`/gs/marketing/images/${it.id}`); toast('Deleted'); setView(null); load(); } catch (e) { toast(errOf(e, 'It could not be deleted.')); } };
  const saveName = async () => { try { await omni.put(`/gs/marketing/images/${rename.id}`, { title: rename.title }); toast('Renamed'); setRename(null); load(); } catch (e) { toast(errOf(e, 'It could not be renamed.')); } };
  const copyLink = async (it) => { const url = `${window.location.origin}${it.publicPath}`; try { await navigator.clipboard.writeText(url); toast('Public link copied'); } catch { window.prompt('Copy the public link:', url); } };
  const download = async (it) => { try { await downloadMkImg(it.id, it.title); } catch (e) { toast(errOf(e, 'It could not be downloaded.')); } };

  const shown = tab ? list.filter((i) => i.status === tab) : list;
  const cnt = (s) => list.filter((i) => i.status === s).length;
  const ratio = (a) => { const [w, h] = String(a || '1:1').split(':').map(Number); return `${w} / ${h}`; };

  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="AI Images">
        {meta.canWrite ? (
          <>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" multiple style={{ display: 'none' }} onChange={upload} />
            <Btn disabled={busy === 'upload'} onClick={() => fileRef.current && fileRef.current.click()} title="PNG, JPG or WebP, under 10 MB each, up to 5 at a time. Only pictures you own or may use.">{busy === 'upload' ? 'Uploading…' : '⬆ Upload pictures'}</Btn>
          </>
        ) : null}
      </PageHead>
      {meta.canWrite ? <AutoStudioPanel kind="post" projectId={projectId} onMade={load} toast={toast} /> : null}
      {/* 21 Nov 2026 (owner: "remove the banner too, it becomes a mess"): the "Design a banner" card is gone from this screen. marketing/banner.js, the server routes and BannerPanel.jsx are untouched, so putting it back is one line. */}
      {proj ? (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', background: '#eef6ff', border: '1px solid #c9defa', borderRadius: 10, padding: '9px 12px', margin: '0 0 12px', fontSize: 12, color: '#1d4fa8' }}>
          <span><b>Making pictures for {proj.clientName}</b>{proj.occasion ? ` · ${proj.occasion}` : ''}. {proj.hasLogo ? 'Their logo and colours are used.' : 'No logo is saved for this client yet: add one in the project.'} Then go back to the project and pick them as options.</span>
          <Btn small onClick={() => go('mkprojects', { open: proj.id })}>← Back to the project</Btn>
        </div>
      ) : null}
      {msg ? <Banner tone="error">{msg}</Banner> : null}

      {/* 21 Nov 2026 (owner: "remove this, it becomes a mess"): the "How it works" panel is gone; the page lead says it in one line */}
      {meta.canWrite ? null : <Banner tone="info">You can look at the pictures of your department and approve them in Approvals. Only Marketing and Admins make pictures.</Banner>}

      <Panel title="Your pictures" sub="Newest first" style={{ marginTop: 14 }} right={<span className="pill live">{list.length}</span>}>
        <Tabs value={tab} onChange={setTab} tabs={[['', 'All', list.length], ['draft', 'Saved', cnt('draft')], ['waiting', 'Waiting', cnt('waiting')], ['changes', 'Changes needed', cnt('changes')], ['approved', 'Approved', cnt('approved')]]} />
        {shown.length === 0 ? <Empty title="No pictures here yet">{list.length ? 'Nothing with that status.' : 'Type your idea in the box above and press Create the post.'}</Empty> : (
          <div className="mki-grid">
            {shown.map((it) => (
              <div key={it.id} className="card mki-card">
                <div style={{ aspectRatio: ratio(it.aspect), overflow: 'hidden', borderRadius: 10, cursor: 'zoom-in' }}><MkImg id={it.id} ver={it.version > 1 ? it.version : 0} alt={it.title} style={{ height: '100%' }} onClick={() => setView(it)} /></div>
                <b style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 8 }} title={it.title}>{it.title}</b>
                <div style={{ margin: '3px 0', display: 'flex', gap: 4, flexWrap: 'wrap' }}><MkStatus status={it.status} /><ClientChip cr={it.clientReview} /></div>
                <small style={{ color: 'var(--muted)', fontSize: 9.5 }}>{STYLE_WORDS[it.style] || it.style} · {it.aspect}{it.withLogo ? ' · logo' : ''}{it.uses && it.uses.campaigns ? ` · in ${it.uses.campaigns} campaign${it.uses.campaigns === 1 ? '' : 's'}, sent to ${it.uses.recipients} people` : ''}{it.demo ? ' · sample' : ''} · {fmtDateTime(it.createdAt)}{!it.mine ? ` · ${it.createdByName}` : ''}</small>
                {it.revision && typeof it.revision === 'object' ? (
                  <div style={{ fontSize: 10.5, margin: '3px 0' }}>
                    <Pill tone={it.revision.label === 'Approved' ? 'live' : (RV_TONE[it.revision.status] || 'draft')} dot>{it.revision.label}</Pill>{' '}
                    <b>Version {it.version}</b>{it.revision.finishedAt ? <span style={{ color: 'var(--muted)' }}> · last change {fmtDateTime(it.revision.finishedAt)}</span> : null}
                    {it.revision.status === 'processing' ? <div style={{ color: 'var(--muted)' }}>TeamLink is changing it now. This updates by itself.</div> : null}
                    {it.revision.feedback ? <div className="mk-note">Client asked: “{it.revision.feedback}”</div> : null}
                    {it.revision.error ? <div className="mk-note" style={{ color: '#9b1c1c' }}>{it.revision.error}</div> : null}
                  </div>
                ) : null}
                {it.status === 'changes' && it.note && !(it.revision && it.revision.feedback) ? <div className="mk-note">Sent back by {it.decidedByName}: {it.note}</div> : null}
                <div className="mk-acts" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                  <TinyBtn onClick={() => download(it)}>⬇ Download</TinyBtn>
                  {it.revision && typeof it.revision === 'object' ? <TinyBtn onClick={() => setHist(it)} title="What the client asked for, what TeamLink changed, and every version side by side">🕘 Versions ({it.revision.count})</TinyBtn> : null}
                  {it.revision && typeof it.revision === 'object' && ['failed', 'completed'].includes(it.revision.status) && it.canClient ? <TinyBtn disabled={busy === it.id} onClick={() => tryAgain(it)}>{it.revision.status === 'failed' ? '↻ Try again' : '➤ Send again'}</TinyBtn> : null}
                  {it.revision && typeof it.revision === 'object' && it.revision.status === 'needs-person' && it.canClient && it.clientReview && it.clientReview.status === 'changes' ? <TinyBtn disabled={busy === it.id} onClick={() => tryAgain(it)} title="TeamLink reads the client's request again and tries to make the change by itself">↻ Try the change again</TinyBtn> : null}
                  {it.canSubmit && !it.needsClient ? <TinyBtn disabled={busy === it.id} onClick={() => act(it, 'submit')}>Ask for approval</TinyBtn> : null}
                  {it.canSubmit && it.canEdit ? <TinyBtn onClick={() => setToClient(it)} title="The client approves it instead of your team: it becomes Approved only when the client says yes">➤ Ask client to approve</TinyBtn> : null}
                  {it.clientHold ? <TinyBtn onClick={() => setToClient(it)}>Client…</TinyBtn> : null}
                  {it.publicPath ? <TinyBtn onClick={() => copyLink(it)}>🔗 Copy link</TinyBtn> : null}
                  {it.status === 'approved' && it.canEdit ? <TinyBtn onClick={() => setToClient(it)}>{it.clientReview && it.clientReview.status !== 'revoked' ? 'Client…' : '➤ Send to client'}</TinyBtn> : null}
                  {it.status === 'approved' && it.canEdit && it.style !== 'clip' ? <TinyBtn onClick={() => setPostIt(it)} title="Post it on the connected Facebook, Instagram or X accounts">📣 Post…</TinyBtn> : null}
                  {it.canEdit ? <TinyBtn onClick={() => setRename({ id: it.id, title: it.title })} aria-label={`Rename ${it.title}`}>✎</TinyBtn> : null}
                  {it.canDelete ? <TinyBtn onClick={() => setDel(it)} aria-label={`Delete ${it.title}`}>🗑</TinyBtn> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {view ? (
        <GsModal title={view.title} sub={`${STYLE_WORDS[view.style] || view.style} · ${view.aspect}${view.model ? ` · ${view.model}` : ''}`} width={1100} onClose={() => setView(null)}
          foot={<><Btn onClick={() => download(view)}>⬇ Download</Btn>{view.publicPath ? <Btn onClick={() => copyLink(view)}>🔗 Copy public link</Btn> : null}<Btn primary onClick={() => setView(null)}>Close</Btn></>}>
          <MkImg id={view.id} alt={view.title} style={{ width: '100%', maxHeight: '78vh', objectFit: 'contain', background: '#111' }} />
          <div style={{ fontSize: 11, marginTop: 8 }}><b>Asked for:</b> {view.prompt}{view.headline ? <> · <b>Headline:</b> “{view.headline}”</> : null}</div>
        </GsModal>
      ) : null}
      {hist ? <RevisionModal item={hist} onClose={() => setHist(null)} /> : null}
      {toClient ? <ClientReviewModal kind="image" item={toClient} onClose={() => setToClient(null)} onChanged={load} toast={toast} /> : null}
      {postIt ? <PostItemModal item={postIt} onClose={() => setPostIt(null)} onChanged={load} toast={toast} /> : null}
      {rename ? (
        <GsModal title="Rename the picture" width={420} onClose={() => setRename(null)} foot={<><Btn onClick={() => setRename(null)}>Cancel</Btn><Btn primary disabled={!rename.title.trim()} onClick={saveName}>Save</Btn></>}>
          <Field label="NAME"><input autoFocus value={rename.title} maxLength={80} onChange={(e) => setRename({ ...rename, title: e.target.value })} /></Field>
        </GsModal>
      ) : null}
      {del ? <ConfirmModal danger title={`Delete "${del.title}"?`} text={del.status === 'approved' ? 'Its public link stops working.' : 'The picture is removed.'} yes="Delete" onNo={() => setDel(null)} onYes={remove} /> : null}
    </div>
  );
}
