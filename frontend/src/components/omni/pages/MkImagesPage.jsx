import { useCallback, useEffect, useRef, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { getState } from '../omniStore.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Panel, Banner, Field, Tabs, Empty, ConfirmModal, GsModal, fmtDateTime } from '../ui.jsx';
import { MkStatus, MkImg, downloadMkImg, ClientChip } from '../marketing/mk.jsx';
import ClientReviewModal from '../marketing/ClientReviewModal.jsx';
import AutoStudioPanel from '../marketing/AutoStudioPanel.jsx';
import '../marketing/marketing.css';

// AI MARKETING > AI IMAGES: ONE place to make pictures, "✦ Create from your content" (AutoStudioPanel: type an idea, TeamLink makes the post pictures by itself, free).
// The second, separate "1 · Describe the picture" form (Google Gemini only, which needs billing and so never made a picture here) was removed on the founder's
// request (16 Nov 2026: "keep one, the best, free"). An AI-made picture is still available inside the one box (More options > Pictures) when a picture AI is connected.
// Every picture is saved here; it is used (calendar, posts) only after approval, and only approved pictures get a public link. Server: marketing/images.js.
const STYLE_WORDS = { photo: 'Photo', illustration: 'Illustration', graphic: 'Social graphic', poster: 'Minimal poster', '3d': '3D', upload: 'Uploaded' };
const UPLOAD_MAX = 10 * 1024 * 1024;

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
  const [toClient, setToClient] = useState(null); // the picture being sent to a client
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
  if (err && (!meta || !list)) return <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={load}>Try again</button></Banner>;
  if (!meta || !list) return <div className="card panel">Loading…</div>;

  const act = async (it, what) => {
    setBusy(it.id);
    try {
      if (what === 'submit') { const r = await omni.post(`/gs/marketing/images/${it.id}/submit`); toast(r.ok); }
      load();
    } catch (e) { toast(errOf(e, 'That did not work.')); } finally { setBusy(''); }
  };
  const remove = async () => { const it = del; setDel(null); try { await omni.del(`/gs/marketing/images/${it.id}`); toast('Deleted'); setView(null); load(); } catch (e) { toast(errOf(e, 'It could not be deleted.')); } };
  const saveName = async () => { try { await omni.put(`/gs/marketing/images/${rename.id}`, { title: rename.title }); toast('Renamed'); setRename(null); load(); } catch (e) { toast(errOf(e, 'It could not be renamed.')); } };
  const copyLink = async (it) => { const url = `${window.location.origin}${it.publicPath}`; try { await navigator.clipboard.writeText(url); toast('Public link copied'); } catch { window.prompt('Copy the public link:', url); } };
  const download = async (it) => { try { await downloadMkImg(it.id, it.title); } catch (e) { toast(errOf(e, 'It could not be downloaded.')); } };

  const shown = tab ? list.filter((i) => i.status === tab) : list;
  const cnt = (s) => list.filter((i) => i.status === s).length;
  const ratio = (a) => { const [w, h] = String(a || '1:1').split(':').map(Number); return `${w} / ${h}`; };

  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="AI Images" lead="Type your idea and TeamLink makes the post pictures for you, free, in your brand colours and with your logo, or upload your own. A picture is used only after it is approved.">
        {meta.canWrite ? (
          <>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" multiple style={{ display: 'none' }} onChange={upload} />
            <Btn disabled={busy === 'upload'} onClick={() => fileRef.current && fileRef.current.click()} title="PNG, JPG or WebP, under 10 MB each, up to 5 at a time. Only pictures you own or may use.">{busy === 'upload' ? 'Uploading…' : '⬆ Upload pictures'}</Btn>
          </>
        ) : null}
      </PageHead>
      {meta.canWrite ? <AutoStudioPanel kind="post" projectId={projectId} onMade={load} toast={toast} /> : null}
      {proj ? (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', background: '#eef6ff', border: '1px solid #c9defa', borderRadius: 10, padding: '9px 12px', margin: '0 0 12px', fontSize: 12, color: '#1d4fa8' }}>
          <span><b>Making pictures for {proj.clientName}</b>{proj.occasion ? ` · ${proj.occasion}` : ''}. {proj.hasLogo ? 'Their logo and colours are used.' : 'No logo is saved for this client yet: add one in the project.'} Then go back to the project and pick them as options.</span>
          <Btn small onClick={() => go('mkprojects', { open: proj.id })}>← Back to the project</Btn>
        </div>
      ) : null}
      {msg ? <Banner tone="error">{msg}</Banner> : null}

      {meta.canWrite ? (
        <Panel title="How it works" sub="Nothing is posted from here.">
          <ol style={{ fontSize: 11.5, lineHeight: 1.8, margin: 0, paddingLeft: 18 }}>
            <li>Type your idea in <b>✦ Create from your content</b> above and press <b>Create the post</b>. The pictures are made for you, free.</li>
            <li>Keep the ones you like; delete the rest.</li>
            <li>Press <b>Ask for approval</b>. A Team Lead or an Admin approves it in <b>Approvals</b>.</li>
            <li>An approved picture can be downloaded, gets a public link, and can be picked in <b>AI Video</b>.</li>
          </ol>
          <div style={{ fontSize: 10.5, marginTop: 10 }}><b>Your own pictures:</b> press <b>⬆ Upload pictures</b> (phone, Canva, the Gemini app). Only upload pictures you own or may use; the place and camera details are removed.</div>
          <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 10 }}>Check every picture before you use it: the words and faces must be right for your client.</div>
        </Panel>
      ) : <Banner tone="info">You can look at the pictures of your department and approve them in Approvals. Only Marketing and Admins make pictures.</Banner>}

      <Panel title="Your pictures" sub="Newest first" style={{ marginTop: 14 }} right={<span className="pill live">{list.length}</span>}>
        <Tabs value={tab} onChange={setTab} tabs={[['', 'All', list.length], ['draft', 'Saved', cnt('draft')], ['waiting', 'Waiting', cnt('waiting')], ['changes', 'Changes needed', cnt('changes')], ['approved', 'Approved', cnt('approved')]]} />
        {shown.length === 0 ? <Empty title="No pictures here yet">{list.length ? 'Nothing with that status.' : 'Type your idea in the box above and press Create the post.'}</Empty> : (
          <div className="mki-grid">
            {shown.map((it) => (
              <div key={it.id} className="card mki-card">
                <div style={{ aspectRatio: ratio(it.aspect), overflow: 'hidden', borderRadius: 10, cursor: 'zoom-in' }}><MkImg id={it.id} alt={it.title} style={{ height: '100%' }} onClick={() => setView(it)} /></div>
                <b style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 8 }} title={it.title}>{it.title}</b>
                <div style={{ margin: '3px 0', display: 'flex', gap: 4, flexWrap: 'wrap' }}><MkStatus status={it.status} /><ClientChip cr={it.clientReview} /></div>
                <small style={{ color: 'var(--muted)', fontSize: 9.5 }}>{STYLE_WORDS[it.style] || it.style} · {it.aspect}{it.withLogo ? ' · logo' : ''}{it.demo ? ' · sample' : ''} · {fmtDateTime(it.createdAt)}{!it.mine ? ` · ${it.createdByName}` : ''}</small>
                {it.status === 'changes' && it.note ? <div className="mk-note">Sent back by {it.decidedByName}: {it.note}</div> : null}
                <div className="mk-acts" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                  <TinyBtn onClick={() => download(it)}>⬇ Download</TinyBtn>
                  {it.canSubmit && !it.needsClient ? <TinyBtn disabled={busy === it.id} onClick={() => act(it, 'submit')}>Ask for approval</TinyBtn> : null}
                  {it.canSubmit && it.canEdit ? <TinyBtn onClick={() => setToClient(it)} title="The client approves it instead of your team: it becomes Approved only when the client says yes">➤ Ask client to approve</TinyBtn> : null}
                  {it.clientHold ? <TinyBtn onClick={() => setToClient(it)}>Client…</TinyBtn> : null}
                  {it.publicPath ? <TinyBtn onClick={() => copyLink(it)}>🔗 Copy link</TinyBtn> : null}
                  {it.status === 'approved' && it.canEdit ? <TinyBtn onClick={() => setToClient(it)}>{it.clientReview && it.clientReview.status !== 'revoked' ? 'Client…' : '➤ Send to client'}</TinyBtn> : null}
                  {it.canEdit ? <TinyBtn onClick={() => setRename({ id: it.id, title: it.title })} aria-label={`Rename ${it.title}`}>✎</TinyBtn> : null}
                  {it.canDelete ? <TinyBtn onClick={() => setDel(it)} aria-label={`Delete ${it.title}`}>🗑</TinyBtn> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {view ? (
        <GsModal title={view.title} sub={`${STYLE_WORDS[view.style] || view.style} · ${view.aspect}${view.model ? ` · ${view.model}` : ''}`} width={720} onClose={() => setView(null)}
          foot={<><Btn onClick={() => download(view)}>⬇ Download</Btn>{view.publicPath ? <Btn onClick={() => copyLink(view)}>🔗 Copy public link</Btn> : null}<Btn primary onClick={() => setView(null)}>Close</Btn></>}>
          <MkImg id={view.id} alt={view.title} style={{ maxHeight: '60vh', objectFit: 'contain', background: '#111' }} />
          <div style={{ fontSize: 11, marginTop: 8 }}><b>Asked for:</b> {view.prompt}{view.headline ? <> · <b>Headline:</b> “{view.headline}”</> : null}</div>
        </GsModal>
      ) : null}
      {toClient ? <ClientReviewModal kind="image" item={toClient} onClose={() => setToClient(null)} onChanged={load} toast={toast} /> : null}
      {rename ? (
        <GsModal title="Rename the picture" width={420} onClose={() => setRename(null)} foot={<><Btn onClick={() => setRename(null)}>Cancel</Btn><Btn primary disabled={!rename.title.trim()} onClick={saveName}>Save</Btn></>}>
          <Field label="NAME"><input autoFocus value={rename.title} maxLength={80} onChange={(e) => setRename({ ...rename, title: e.target.value })} /></Field>
        </GsModal>
      ) : null}
      {del ? <ConfirmModal danger title={`Delete "${del.title}"?`} text={del.status === 'approved' ? 'Its public link stops working.' : 'The picture is removed.'} yes="Delete" onNo={() => setDel(null)} onYes={remove} /> : null}
    </div>
  );
}
