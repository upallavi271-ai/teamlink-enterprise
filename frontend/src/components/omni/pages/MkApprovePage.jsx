import { useCallback, useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, Panel, Banner, Empty, GsModal, Tag, fmtDateTime } from '../ui.jsx';
import { useMkMeta, MkStatus, TextsPreview, aiLabel } from '../marketing/mk.jsx';

// AI MARKETING > APPROVALS: what people wrote with AI and asked to have approved. An approver (an Admin, or a Team Lead / BDE TL of the department) reads the
// words channel by channel, then approves (the words go into the Content Library) or sends it back with a note. Nobody approves their own work, except an
// Admin when the Admin switch allows it (it is recorded as self-approved).
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export default function MkApprovePage() {
  const { toast, go, acc } = useOmni();
  const { meta, err } = useMkMeta();
  const [data, setData] = useState(null);
  const [avoid, setAvoid] = useState([]);
  const [back, setBack] = useState(null);
  const [note, setNote] = useState('');
  const [notes, setNotes] = useState({});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const load = useCallback(() => omni.get('/gs/marketing/items').then(setData).catch((e) => setMsg(errOf(e, 'The list could not be read.'))), []);
  useEffect(() => { load(); omni.get('/gs/marketing/brand').then((b) => setAvoid(b.brand.avoidWords || [])).catch(() => {}); }, [load]);
  if (err) return <Banner tone="error">{err}</Banner>;
  if (!meta || !data) return msg ? <Banner tone="error">{msg}</Banner> : <div className="card panel">Loading…</div>;
  const chansOf = (it) => meta.channels.filter((c) => (it.channels || []).includes(c.key));
  const flagsFor = (it) => { const out = new Set(); Object.values(it.texts || {}).forEach((t) => avoid.forEach((w) => { if (new RegExp(`(^|[^\\p{L}\\p{N}])${esc(w)}($|[^\\p{L}\\p{N}])`, 'iu').test(t)) out.add(w); })); return [...out]; };
  const items = data.items;
  const mine = items.filter((i) => i.status === 'waiting' && i.canApprove);
  const others = items.filter((i) => i.status === 'waiting' && !i.canApprove);
  const decided = items.filter((i) => (i.status === 'approved' || i.status === 'changes') && i.decidedAt).sort((a, b) => String(b.decidedAt).localeCompare(String(a.decidedAt))).slice(0, 15);
  const approve = async (it) => {
    setBusy(it.id); setMsg('');
    try { const r = await omni.post(`/gs/marketing/items/${it.id}/approve`, { note: notes[it.id] || '' }); toast(r.ok); await load(); } catch (e) { const m = errOf(e, 'It could not be approved.'); setMsg(m); toast(m); } finally { setBusy(''); }
  };
  const sendBack = async () => {
    const it = back; setBusy(it.id);
    try { const r = await omni.post(`/gs/marketing/items/${it.id}/reject`, { note }); toast(r.ok); setBack(null); setNote(''); await load(); } catch (e) { toast(errOf(e, 'It could not be sent back.')); } finally { setBusy(''); }
  };
  const card = (it, actions) => {
    const fl = flagsFor(it);
    return (
      <div className="mk-row" key={it.id}>
        <div>
          <b>{it.title}</b> <MkStatus status={it.status} />{it.selfApproved ? <> <Tag title="The writer was an Admin who approved their own content">Self-approved</Tag></> : null}
          <small>By {it.createdByName || '—'}{it.submittedAt ? ` · asked ${fmtDateTime(it.submittedAt)}` : ''}{it.department ? ` · ${it.department}` : ''}{it.goal ? ` · ${it.goal}` : ''}{it.audience ? ` · for ${it.audience}` : ''}{it.ai && it.ai.provider ? ` · written by ${aiLabel(it.ai)}` : ''}</small>
          {it.brief ? <small>Brief: {it.brief}</small> : null}
          {fl.length > 0 && <div className="mk-flag">Contains words the brand voice says never to use: <b>{fl.join(', ')}</b></div>}
          <TextsPreview chans={chansOf(it)} texts={it.texts || {}} subject={it.subject} />
          {it.note && it.status === 'changes' ? <div className="mk-note">Sent back by {it.decidedByName}: {it.note}</div> : null}
          {it.note && it.status === 'approved' ? <div className="mk-note ok">Approved by {it.decidedByName}: {it.note}</div> : null}
          {it.status === 'approved' && it.decidedByName && !it.note ? <small>Approved by {it.decidedByName} · {fmtDateTime(it.decidedAt)}</small> : null}
        </div>
        <div className="mk-acts" style={{ flexDirection: 'column', alignItems: 'stretch', minWidth: 200 }}>{actions}</div>
      </div>
    );
  };
  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="Approvals" lead="AI-written words are used only after a person approves them. Approved words go into the Content Library, where the campaign screens find them." />
      {msg ? <Banner tone="error">{msg}</Banner> : null}
      <Panel title="Waiting for you" sub={`${mine.length} item${mine.length === 1 ? '' : 's'}`}>
        {mine.length === 0 ? <Empty title="Nothing is waiting for you">When somebody asks for approval of AI content you can approve, it appears here and you get a notice.</Empty> : mine.map((it) => card(it, (
          <>
            <input value={notes[it.id] || ''} placeholder="Note (optional)" maxLength={300} onChange={(e) => setNotes({ ...notes, [it.id]: e.target.value })} aria-label="Note for the writer" style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '7px 9px', font: 'inherit', fontSize: 11 }} />
            <Btn primary disabled={busy === it.id} onClick={() => approve(it)}>✔ Approve</Btn>
            <Btn disabled={busy === it.id} onClick={() => { setBack(it); setNote(''); }}>↩ Send back</Btn>
            {it.mine ? <small style={{ fontSize: 9.5, color: 'var(--muted)' }}>You wrote this. As an Admin you may approve it; it is recorded as self-approved.</small> : null}
          </>
        )))}
      </Panel>
      {others.length > 0 && (
        <Panel title="Waiting for somebody else" sub="You can read these, but you cannot approve them." style={{ marginTop: 14 }}>
          {others.map((it) => card(it, <small style={{ color: 'var(--muted)' }}>{it.mine ? 'Your own content: another approver has to approve it.' : 'Another approver will decide.'}</small>))}
        </Panel>
      )}
      <Panel title="Recently decided" sub="The last 15 approvals and send-backs you can see" style={{ marginTop: 14 }}>
        {decided.length === 0 ? <div style={{ fontSize: 12, color: 'var(--muted)', padding: '10px 0' }}>Nothing decided yet.</div> : decided.map((it) => card(it, (
          it.status === 'approved' && it.libraryId && acc && acc.pages && acc.pages.includes('campaigns')
            ? <Btn small onClick={() => go('campaigns', { content: it.libraryId })}>Use in a campaign →</Btn> : null
        )))}
      </Panel>
      {back ? (
        <GsModal title={`Send back "${back.title}"`} sub="Tell the writer what to change. They can edit it and ask again." width={480} onClose={() => setBack(null)}
          foot={<><Btn onClick={() => setBack(null)}>Cancel</Btn><Btn primary disabled={note.trim().length < 5 || busy === back.id} onClick={sendBack}>Send back</Btn></>}>
          <textarea autoFocus style={{ width: '100%', minHeight: 110, border: '1px solid var(--line)', borderRadius: 10, padding: 11, font: 'inherit', fontSize: 12.5 }} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="For example: please remove the word free and shorten the SMS." />
          <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>{note.trim().length < 5 ? 'Write at least a few words.' : `${note.length} / 300`}</div>
        </GsModal>
      ) : null}
    </div>
  );
}
