import { useCallback, useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Panel, Banner, Empty, GsModal, Tag, Tabs, ConfirmModal, fmtDateTime } from '../ui.jsx';
import { useMkMeta, MkStatus, TextsPreview, TextsEditor, aiLabel, MkImg, ClientChip } from '../marketing/mk.jsx';
import ClientReviewModal from '../marketing/ClientReviewModal.jsx';

// AI MARKETING > APPROVALS: what people wrote with AI and asked to have approved. An approver (an Admin, or a Team Lead / BDE TL of the department) reads the
// words channel by channel, then approves (the words go into the Content Library), corrects small things and approves ("Edit & approve"), or sends it back
// with a note. Several items can be approved at once. Nobody approves their own work, except an Admin when the Admin switch allows it (recorded as self-approved).
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (t, w) => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(w)}($|[^\\p{L}\\p{N}])`, 'iu').test(t || '');
const REASONS = ['Please shorten the SMS.', 'Remove the never-use words.', 'Check the facts (dates, place, salary).', 'The tone does not sound like us.', 'Add a clear call to action.', 'Fix the spelling and grammar.'];
const DAY = 86400000;
const ageOf = (iso) => { const ms = Date.now() - Date.parse(iso || ''); if (!Number.isFinite(ms) || ms < 0) return null; const h = Math.floor(ms / 3600000); return { ms, words: h < 1 ? 'less than an hour' : h < 24 ? `${h} hour${h === 1 ? '' : 's'}` : `${Math.floor(h / 24)} day${Math.floor(h / 24) === 1 ? '' : 's'}` }; };

export default function MkApprovePage() {
  const { toast, go, acc } = useOmni();
  const { meta, err } = useMkMeta();
  const [data, setData] = useState(null);
  const [avoid, setAvoid] = useState([]);
  const [avoidErr, setAvoidErr] = useState(false);
  const [back, setBack] = useState(null);
  const [note, setNote] = useState('');
  const [notes, setNotes] = useState({});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [edit, setEdit] = useState(null); // { it, texts, subject, note } for "Edit & approve"
  const [picked, setPicked] = useState([]); // ids ticked for "Approve selected"
  const [bulkAsk, setBulkAsk] = useState(null); // { ids, flagged }
  const [hist, setHist] = useState(''); // '' | 'approved' | 'changes'
  const [histN, setHistN] = useState(15);
  const [pics, setPics] = useState([]); // AI pictures waiting (marketing/images.js)
  const [picBack, setPicBack] = useState(null);
  const [picNote, setPicNote] = useState('');
  const [crs, setCrs] = useState([]); // client approvals: sent to a client, answered (marketing/clientReview.js)
  const [toClient, setToClient] = useState(null); // { kind, item, isVideo }: an item waiting for the team that the company rule says only a client may approve
  const loadPics = useCallback(() => omni.get('/gs/marketing/images', { status: 'waiting' }).then((d) => setPics(d.items || [])).catch(() => setPics([])), []);
  const loadCrs = useCallback(() => omni.get('/gs/marketing/client-reviews').then((d) => setCrs((d.reviews || []).filter((r) => r.status !== 'revoked'))).catch(() => setCrs([])), []);
  const load = useCallback(() => { loadPics(); loadCrs(); return omni.get('/gs/marketing/items').then((d) => { setData(d); setMsg(''); }).catch((e) => setMsg(errOf(e, 'The list could not be read.'))); }, [loadPics, loadCrs]);
  useEffect(() => { load(); omni.get('/gs/marketing/brand').then((b) => { setAvoid(b.brand.avoidWords || []); setAvoidErr(false); }).catch(() => setAvoidErr(true)); }, [load]);
  if (err) return <Banner tone="error">{err}</Banner>;
  if (!meta || !data) return msg ? <Banner tone="error">{msg} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={load}>Try again</button></Banner> : <div className="card panel">Loading…</div>;
  const chansOf = (it) => meta.channels.filter((c) => (it.channels || []).includes(c.key));
  const flagsIn = (texts) => { const out = new Set(); Object.values(texts || {}).forEach((t) => avoid.forEach((w) => { if (hasWord(t, w)) out.add(w); })); return [...out]; };
  const flagsFor = (it) => flagsIn(it.texts);
  const items = data.items;
  const mine = items.filter((i) => i.status === 'waiting' && i.canApprove).sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt))); // oldest first
  const heldWords = items.filter((i) => i.status === 'waiting' && i.clientHold); // the CLIENT is their approver (clientReview.js mode 'decide'): no Approve button for the team
  const heldPics = pics.filter((p) => p.clientHold);
  const others = items.filter((i) => i.status === 'waiting' && !i.canApprove && !i.clientHold);
  const decidedAll = items.filter((i) => (i.status === 'approved' || i.status === 'changes') && i.decidedAt).sort((a, b) => String(b.decidedAt).localeCompare(String(a.decidedAt)));
  const decided = (hist ? decidedAll.filter((i) => i.status === hist) : decidedAll);
  const late = mine.filter((i) => { const a = ageOf(i.submittedAt); return a && a.ms > DAY; }).length;
  const pickable = mine.filter((i) => !i.mine && !i.needsClient);
  const allPicked = pickable.length > 0 && pickable.every((i) => picked.includes(i.id));

  const approveOne = async (it, body) => omni.post(`/gs/marketing/items/${it.id}/approve`, body);
  const approve = async (it) => {
    setBusy(it.id); setMsg('');
    try { const r = await approveOne(it, { note: notes[it.id] || '' }); toast(r.ok); setPicked((p) => p.filter((x) => x !== it.id)); await load(); } catch (e) { const m = errOf(e, 'It could not be approved.'); setMsg(m); toast(m); } finally { setBusy(''); }
  };
  const editApprove = async () => {
    const { it } = edit;
    const over = chansOf(it).find((c) => (edit.texts[c.key] || '').length > c.limit);
    if (over) { toast(`The ${over.label} version is over its limit`); return; }
    setBusy(it.id);
    try { const r = await approveOne(it, { note: edit.note || '', edits: { texts: edit.texts, subject: edit.subject } }); toast(r.ok); setEdit(null); setPicked((p) => p.filter((x) => x !== it.id)); await load(); } catch (e) { toast(errOf(e, 'It could not be approved.')); } finally { setBusy(''); }
  };
  const sendBack = async () => {
    const it = back; setBusy(it.id);
    try { const r = await omni.post(`/gs/marketing/items/${it.id}/reject`, { note }); toast(r.ok); setBack(null); setNote(''); setPicked((p) => p.filter((x) => x !== it.id)); await load(); } catch (e) { toast(errOf(e, 'It could not be sent back.')); } finally { setBusy(''); }
  };
  const askBulk = () => {
    const ids = picked.filter((id) => pickable.some((i) => i.id === id));
    if (!ids.length) return;
    setBulkAsk({ ids, flagged: ids.filter((id) => flagsFor(pickable.find((i) => i.id === id)).length > 0).length });
  };
  // one at a time, so each approval is checked and audited like a single one; the summary says what happened
  const bulkApprove = async () => {
    const { ids } = bulkAsk; setBulkAsk(null); setBusy('bulk'); setMsg('');
    let ok = 0; const failed = [];
    for (const id of ids) {
      const it = pickable.find((i) => i.id === id);
      try { await approveOne(it, { note: notes[id] || '' }); ok += 1; } catch (e) { failed.push(`${it.title}: ${errOf(e, 'not approved')}`); } // eslint-disable-line no-await-in-loop
    }
    setPicked([]); await load(); setBusy('');
    toast(`${ok} approved${failed.length ? `, ${failed.length} not approved` : ''}`);
    if (failed.length) setMsg(`Not approved: ${failed.join(' · ')}`);
  };
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const crAct = async (r, what) => { setBusy(what + r.id); try { const res = await omni.post(`/gs/marketing/client-reviews/${r.id}/${what}`, what === 'extend' ? { days: 14 } : {}); toast(res.ok); loadCrs(); } catch (e) { toast(errOf(e, 'That did not work.')); } finally { setBusy(''); } };
  const crCopy = async (r) => { const url = `${window.location.origin}${r.link}`; try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { window.prompt('Copy the link:', url); } };
  const picsMine = pics.filter((p) => p.canApprove);
  const approvePic = async (p) => { setBusy(p.id); try { const r = await omni.post(`/gs/marketing/images/${p.id}/approve`, {}); toast(r.ok); loadPics(); } catch (e) { toast(errOf(e, 'It could not be approved.')); } finally { setBusy(''); } };
  const sendBackPic = async () => { const p = picBack; setBusy(p.id); try { const r = await omni.post(`/gs/marketing/images/${p.id}/reject`, { note: picNote }); toast(r.ok); setPicBack(null); setPicNote(''); loadPics(); } catch (e) { toast(errOf(e, 'It could not be sent back.')); } finally { setBusy(''); } };

  const card = (it, actions, pick) => {
    const fl = flagsFor(it);
    const age = it.status === 'waiting' ? ageOf(it.submittedAt) : null;
    return (
      <div className="mk-row" key={it.id} style={pick && picked.includes(it.id) ? { background: '#f3fbf7' } : undefined}>
        {pick ? <input type="checkbox" checked={picked.includes(it.id)} disabled={it.mine || it.needsClient || busy === 'bulk'} onChange={() => toggle(it.id)} aria-label={`Select ${it.title}`} title={it.mine ? 'Your own content is approved one by one' : 'Select for "Approve selected"'} style={{ alignSelf: 'flex-start', marginTop: 4 }} /> : null}
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>{it.title}</b> <MkStatus status={it.status} />{it.selfApproved ? <> <Tag title="The writer was an Admin who approved their own content">Self-approved</Tag></> : null}
          {age ? <> <Tag green={age.ms <= DAY} title="How long it has been waiting">{age.ms > DAY ? '⚠ ' : ''}waiting {age.words}</Tag></> : null}
          <small>By {it.createdByName || '—'}{it.submittedAt ? ` · asked ${fmtDateTime(it.submittedAt)}` : ''}{it.department ? ` · ${it.department}` : ''}{it.goal ? ` · ${it.goal}` : ''}{it.audience ? ` · for ${it.audience}` : ''}{it.ai && it.ai.provider ? ` · written by ${aiLabel(it.ai)}` : ''}</small>
          {it.brief ? <small>Brief: {it.brief}</small> : null}
          {fl.length > 0 && <div className="mk-flag">Contains words the brand voice says never to use: <b>{fl.join(', ')}</b></div>}
          <TextsPreview chans={chansOf(it)} texts={it.texts || {}} subject={it.subject} />
          {it.note && it.status === 'changes' ? <div className="mk-note">Sent back by {it.decidedByName}: {it.note}</div> : null}
          {it.note && it.status === 'approved' ? <div className="mk-note ok">Approved by {it.decidedByName}: {it.note}</div> : null}
          {it.status !== 'waiting' && it.decidedByName && !it.note ? <small>{it.status === 'approved' ? 'Approved' : 'Sent back'} by {it.decidedByName} · {fmtDateTime(it.decidedAt)}</small> : null}
        </div>
        <div className="mk-acts" style={{ flexDirection: 'column', alignItems: 'stretch', minWidth: 200 }}>{actions}</div>
      </div>
    );
  };
  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="Approvals" lead="AI-written words are used only after a person approves them. Approved words go into the Content Library, where the campaign screens find them." />
      {msg ? <Banner tone="error">{msg}</Banner> : null}
      {meta.limits && meta.limits.clientRequired ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 11.5, color: 'var(--muted)', margin: '0 0 12px' }}>
          <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 4, background: '#0f766e', display: 'inline-block' }} />
          <span>Client sign-off is on for {(meta.limits.clientFor || []).map((k) => ({ words: 'words', pictures: 'pictures', videos: 'finished videos' }[k])).join(', ')}.</span>
          {meta.isAdmin ? <button type="button" className="link-btn" style={{ fontSize: 11.5 }} onClick={() => go('mkusage')}>Change</button> : null}
        </div>
      ) : null}
      {avoidErr ? <Banner tone="warn">The never-use word list could not be read, so those words are not highlighted here. Read the words carefully.</Banner> : null}
      <Panel title="Waiting for you" sub={`${mine.length} item${mine.length === 1 ? '' : 's'}${late ? ` · ${late} waiting more than a day` : ''} · oldest first`}
        right={pickable.length > 1 ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ fontSize: 11, display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={allPicked} onChange={() => setPicked(allPicked ? [] : pickable.map((i) => i.id))} disabled={busy === 'bulk'} />All</label>
            <Btn small primary disabled={!picked.length || busy === 'bulk'} onClick={askBulk}>{busy === 'bulk' ? 'Approving…' : `✔ Approve selected (${picked.length})`}</Btn>
          </div>
        ) : null}>
        {mine.length === 0 ? <Empty title="Nothing is waiting for you">When somebody asks for approval of AI content you can approve, it appears here and you get a notice.</Empty> : mine.map((it) => card(it, (
          it.needsClient ? (
            <>
              <small style={{ fontSize: 10.5, color: 'var(--muted)' }}>Needs the client's sign-off.</small>
              {it.canClient ? <Btn primary disabled={!!busy} onClick={() => setToClient({ kind: 'content', item: it })}>➤ Send to the client</Btn> : <small style={{ fontSize: 10, color: 'var(--muted)' }}>The writer or an Admin sends it.</small>}
              <Btn disabled={!!busy} onClick={() => { setBack(it); setNote(''); }}>↩ Send back</Btn>
            </>
          ) : (
            <>
              <input value={notes[it.id] || ''} placeholder="Note (optional)" maxLength={300} onChange={(e) => setNotes({ ...notes, [it.id]: e.target.value })} aria-label="Note for the writer" style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '7px 9px', font: 'inherit', fontSize: 11 }} />
              <Btn primary disabled={!!busy} onClick={() => approve(it)}>{busy === it.id ? 'Approving…' : '✔ Approve'}</Btn>
              <Btn disabled={!!busy} onClick={() => setEdit({ it, texts: { ...(it.texts || {}) }, subject: it.subject || '', note: notes[it.id] || '' })} title="Correct small things yourself, then approve">✎ Edit &amp; approve</Btn>
              <Btn disabled={!!busy} onClick={() => { setBack(it); setNote(''); }}>↩ Send back</Btn>
              {it.mine ? <small style={{ fontSize: 9.5, color: 'var(--muted)' }}>You wrote this. As an Admin you may approve it; it is recorded as self-approved.</small> : null}
            </>
          )
        ), true))}
      </Panel>
      {heldWords.length + heldPics.length > 0 && (
        <Panel title="Waiting for the client" sub="Only the client's answer approves these. Their private links are under Client approvals below." style={{ marginTop: 14 }} right={<span className="pill live">{heldWords.length + heldPics.length}</span>}>
          {heldWords.map((it) => card(it, <><ClientChip cr={it.clientReview} /><small style={{ color: 'var(--muted)' }}>Only the client can approve this.</small></>))}
          {heldPics.length > 0 && (
            <div className="mki-grid" style={{ marginTop: heldWords.length ? 10 : 0 }}>
              {heldPics.map((p) => (
                <div key={p.id} className="card mki-card">
                  <MkImg id={p.id} lazy alt={p.title} video={p.kind === 'video'} style={{ aspectRatio: p.aspect.replace(':', ' / '), ...(p.kind === 'video' ? { objectFit: 'contain', background: '#000' } : {}) }} />
                  <b style={{ fontSize: 11.5, marginTop: 6 }}>{p.title}</b>
                  <small style={{ color: 'var(--muted)', fontSize: 9.5 }}>By {p.createdByName}</small>
                  <ClientChip cr={p.clientReview} />
                  <small style={{ fontSize: 9.5, color: 'var(--muted)' }}>Only the client can approve this.</small>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}
      {picsMine.length > 0 && (
        <Panel title="Pictures and videos waiting for you" sub={`${picsMine.length} waiting · check faces, hands, spelling and watermarks before you approve`} style={{ marginTop: 14 }}>
          <div className="mki-grid">
            {picsMine.map((p) => (
              <div key={p.id} className="card mki-card">
                <MkImg id={p.id} alt={p.title} video={p.kind === 'video'} style={{ aspectRatio: p.aspect.replace(':', ' / '), ...(p.kind === 'video' ? { objectFit: 'contain', background: '#000' } : {}) }} />
                <b style={{ fontSize: 11.5, marginTop: 6 }}>{p.title}</b>
                <small style={{ color: 'var(--muted)', fontSize: 9.5 }}>By {p.createdByName}{p.headline ? ` · “${p.headline}”` : ''}{p.demo ? ' · sandbox sample' : ''}</small>
                <small style={{ fontSize: 9.5 }}>Asked for: {p.prompt}</small>
                <div className="mk-acts" style={{ marginTop: 6 }}>
                  {p.needsClient
                    ? (p.canClient ? <Btn small primary disabled={!!busy} onClick={() => setToClient({ kind: 'image', item: p, isVideo: p.kind === 'video' })}>➤ Send to the client</Btn> : <small style={{ fontSize: 9.5, color: 'var(--muted)' }}>Needs the client's sign-off. The maker or an Admin sends it.</small>)
                    : <Btn small primary disabled={!!busy} onClick={() => approvePic(p)}>{busy === p.id ? 'Approving…' : '✔ Approve'}</Btn>}
                  <Btn small disabled={!!busy} onClick={() => { setPicBack(p); setPicNote(''); }}>↩ Send back</Btn>
                </div>
                {p.mine ? <small style={{ fontSize: 9, color: 'var(--muted)' }}>Your own picture: recorded as self-approved.</small> : null}
              </div>
            ))}
          </div>
        </Panel>
      )}
      {picBack ? (
        <GsModal title={`Send back "${picBack.title}"`} sub="Say what to change. They can make a new picture and ask again." width={460} onClose={() => setPicBack(null)}
          foot={<><Btn onClick={() => setPicBack(null)}>Cancel</Btn><Btn primary disabled={picNote.trim().length < 5 || busy === picBack.id} onClick={sendBackPic}>Send back</Btn></>}>
          <div className="mk-revise" style={{ marginBottom: 8 }}>{['The faces or hands look wrong.', 'The words on it are misspelt.', 'It has a watermark or a stock-site mark.', 'Not our brand colours.', 'Use a different scene.'].map((r) => <TinyBtn key={r} onClick={() => setPicNote((n) => (n.includes(r) ? n : `${n ? `${n.trim()} ` : ''}${r}`).slice(0, 300))}>{r.replace(/\.$/, '')}</TinyBtn>)}</div>
          <textarea autoFocus style={{ width: '100%', minHeight: 90, border: '1px solid var(--line)', borderRadius: 10, padding: 11, font: 'inherit', fontSize: 12.5 }} value={picNote} maxLength={300} onChange={(e) => setPicNote(e.target.value)} />
        </GsModal>
      ) : null}
      {others.length > 0 && (
        <Panel title="Waiting for somebody else" sub="You can read these, but you cannot approve them." style={{ marginTop: 14 }}>
          {others.map((it) => card(it, <small style={{ color: 'var(--muted)' }}>{it.mine ? 'Your own content: another approver has to approve it.' : 'Another approver will decide.'}</small>))}
        </Panel>
      )}
      {crs.length > 0 && (
        <Panel title="Client approvals" sub="Items sent to a client on a private link. When it says “Client approves”, the client's answer is the approval; otherwise the client confirms what your team already approved." style={{ marginTop: 14 }} right={<span className="pill live">{crs.length}</span>}>
          {crs.slice(0, 20).map((r) => (
            <div className="mk-row" key={r.id}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{r.itemTitle}</b> <small style={{ display: 'inline' }}>({r.kind === 'content' ? 'words' : 'picture / video'})</small> {r.mode === 'decide' ? <Tag green title="The client's answer is the approval">Client approves</Tag> : null} <ClientChip cr={r} />
                <small>For {r.clientName}{r.contactName ? ` · ${r.contactName}` : ''} · sent {fmtDateTime(r.createdAt)} by {r.createdByName || '—'}{r.status === 'sent' ? ` · ${r.views ? `opened ${r.views}×` : 'not opened yet'} · valid until ${fmtDateTime(r.expiresAt)}` : ''}</small>
                {r.status === 'approved' ? <div className="mk-note ok">Approved by {r.decidedByName} on {fmtDateTime(r.decidedAt)}.{r.comment ? ` “${r.comment}”` : ''}</div> : null}
                {r.status === 'changes' ? <div className="mk-note">{r.decidedByName} asked for changes: “{r.comment}”</div> : null}
              </div>
              <div className="mk-acts" style={{ flexDirection: 'column', alignItems: 'stretch', minWidth: 150 }}>
                {['sent', 'expired'].includes(r.status) ? <Btn small onClick={() => crCopy(r)}>⧉ Copy link</Btn> : null}
                {meta.canWrite && r.status === 'sent' ? <TinyBtn disabled={!!busy} onClick={() => crAct(r, 'extend')}>Extend 14 days</TinyBtn> : null}
                {meta.canWrite && r.status === 'sent' ? <TinyBtn disabled={!!busy} onClick={() => crAct(r, 'revoke')}>Cancel the link</TinyBtn> : null}
              </div>
            </div>
          ))}
        </Panel>
      )}
      <Panel title="Recently decided" sub="Approvals and send-backs you can see, newest first" style={{ marginTop: 14 }}>
        <Tabs value={hist} onChange={(v) => { setHist(v); setHistN(15); }} tabs={[['', 'All', decidedAll.length], ['approved', 'Approved', decidedAll.filter((i) => i.status === 'approved').length], ['changes', 'Sent back', decidedAll.filter((i) => i.status === 'changes').length]]} />
        {decided.length === 0 ? <div style={{ fontSize: 12, color: 'var(--muted)', padding: '10px 0' }}>Nothing decided yet.</div> : decided.slice(0, histN).map((it) => card(it, (
          it.status === 'approved' && it.libraryId && acc && acc.pages && acc.pages.includes('campaigns')
            ? <Btn small onClick={() => go('campaigns', { content: it.libraryId })}>Use in a campaign →</Btn> : null
        )))}
        {decided.length > histN ? <div style={{ marginTop: 8 }}><TinyBtn onClick={() => setHistN(histN + 15)}>Show {Math.min(15, decided.length - histN)} more</TinyBtn></div> : null}
      </Panel>
      {toClient ? <ClientReviewModal kind={toClient.kind} item={toClient.item} isVideo={toClient.isVideo} onClose={() => setToClient(null)} onChanged={load} toast={toast} /> : null}
      {back ? (
        <GsModal title={`Send back "${back.title}"`} sub="Tell the writer what to change. They can edit it and ask again." width={500} onClose={() => setBack(null)}
          foot={<><Btn onClick={() => setBack(null)}>Cancel</Btn><Btn primary disabled={note.trim().length < 5 || busy === back.id} onClick={sendBack}>{busy === back.id ? 'Sending…' : 'Send back'}</Btn></>}>
          <div className="mk-revise" style={{ marginBottom: 8 }}>
            {REASONS.map((r) => <TinyBtn key={r} onClick={() => setNote((n) => (n.includes(r) ? n : `${n ? `${n.trim()} ` : ''}${r}`).slice(0, 300))}>{r.replace(/\.$/, '')}</TinyBtn>)}
          </div>
          <textarea autoFocus style={{ width: '100%', minHeight: 110, border: '1px solid var(--line)', borderRadius: 10, padding: 11, font: 'inherit', fontSize: 12.5 }} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="For example: please remove the word free and shorten the SMS." />
          <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>{note.trim().length < 5 ? 'Pick a reason above or write a few words.' : `${note.length} / 300`}</div>
        </GsModal>
      ) : null}
      {edit ? (
        <GsModal title={`Edit & approve "${edit.it.title}"`} sub="Correct small things yourself. The writer is told it was approved with changes. For bigger changes, send it back instead." width={680} onClose={() => setEdit(null)}
          foot={<><Btn onClick={() => setEdit(null)}>Cancel</Btn><Btn primary disabled={busy === edit.it.id} onClick={editApprove}>{busy === edit.it.id ? 'Approving…' : '✔ Approve with my changes'}</Btn></>}>
          <TextsEditor chans={chansOf(edit.it)} texts={edit.texts} subject={edit.subject} onTexts={(t) => setEdit({ ...edit, texts: t })} onSubject={(s) => setEdit({ ...edit, subject: s })} flagsOf={(k, t) => avoid.filter((w) => hasWord(t, w))} />
          <input value={edit.note} placeholder="Note for the writer (optional)" maxLength={300} onChange={(e) => setEdit({ ...edit, note: e.target.value })} aria-label="Note for the writer" style={{ width: '100%', marginTop: 10, border: '1px solid var(--line)', borderRadius: 8, padding: '7px 9px', font: 'inherit', fontSize: 11 }} />
          {flagsIn(edit.texts).length ? <div className="mk-flag">Still contains never-use words: <b>{flagsIn(edit.texts).join(', ')}</b></div> : null}
        </GsModal>
      ) : null}
      {bulkAsk ? <ConfirmModal title={`Approve ${bulkAsk.ids.length} item${bulkAsk.ids.length === 1 ? '' : 's'}?`} text={`They go into the Content Library for campaigns.${bulkAsk.flagged ? ` ${bulkAsk.flagged} of them contain${bulkAsk.flagged === 1 ? 's' : ''} never-use words.` : ''} Notes you typed next to each item go with it.`} yes="Approve all of them" onNo={() => setBulkAsk(null)} onYes={bulkApprove} /> : null}
    </div>
  );
}
