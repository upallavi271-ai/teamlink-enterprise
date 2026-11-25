import { useEffect, useMemo, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { Btn, TinyBtn, GsModal, Field, Banner, fmtDateTime } from '../ui.jsx';
import { ClientChip } from './mk.jsx';
import SenderPick from './SenderPick.jsx';
import { PostPlanBox } from './PostPlanBox.jsx';
import useClientPeople from './clientPeople.js';

// "SEND TO CLIENT" (AI Marketing > client approval): for an item the team has approved, makes a private link the client opens without a login to Approve or Request
// changes. "Send from TeamLink" WhatsApps / emails it from the company's own number (and can send the picture itself); Copy, "Open my own WhatsApp" and "Email" are the manual way.
// Server: marketing/clientReview.js.
const digits = (s) => String(s || '').replace(/\D/g, '');
const WORD = { content: 'message', image: 'picture' };

export default function ClientReviewModal({ kind, item, isVideo, onClose, onChanged, toast }) {
  // decide: the CLIENT is the approver (nothing has been approved by the team: the item waits and the client's answer is the approval). It is the case for a
  // draft / sent-back item ("Ask the client to approve") and for an item already waiting on such a link. An item the team approved only gets a confirmation.
  const decide = item.status !== 'approved';
  const [reviews, setReviews] = useState(null);
  const { people, find } = useClientPeople(); // the clients already sent to, with the details typed last time (marketing/clientPeople.js)
  const [f, setF] = useState({ clientName: '', clientId: '', contactName: '', contactEmail: '', contactPhone: '', message: '', days: 14 });
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [again, setAgain] = useState(false); // "make a new link" pressed
  const [fresh, setFresh] = useState(null); // the review just made
  const [ways, setWays] = useState(null); // is the company WhatsApp / email connected, and from which number
  const [email, setEmail] = useState(null); // the client's email typed in the send box (null = the one saved on the link)
  const [phone, setPhone] = useState(null); // the client's WhatsApp number typed in the send box (null = the one saved on the link)
  const [withFile, setWithFile] = useState(false); // also send the picture / video itself
  const [sendNote, setSendNote] = useState(null); // what the last "Send from TeamLink" did
  const [numberId, setNumberId] = useState(''); // the WhatsApp number to send from ('' = the default company number)
  const [planDirty, setPlanDirty] = useState(false); // the "post after the client approves" plan has changes that are not saved yet: nothing is sent until they are saved (the client must see what is saved)
  const word = isVideo ? 'video' : (WORD[kind] || 'item');

  const load = () => omni.get('/gs/marketing/client-reviews', { kind, itemId: item.id }).then((d) => setReviews(d.reviews || [])).catch((e) => setErr(errOf(e, 'The client approvals could not be read.')));
  useEffect(() => { load(); omni.get('/gs/marketing/projects/notify').then(setWays).catch(() => setWays(null)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const names = useMemo(() => people.map((c) => c.name), [people]);
  // a picture / video made for a CLIENT PROJECT: the client's name, contact person, WhatsApp number and email are the ones they gave in their request, so ONE press sends it to them
  const [fromRequest, setFromRequest] = useState(false);
  useEffect(() => {
    if (!item.projectId) return undefined;
    let on = true;
    omni.get(`/gs/marketing/projects/${item.projectId}`).then((x) => {
      const p = x && x.project; if (!on || !p) return;
      setF((cur) => ({ ...cur, clientName: cur.clientName || p.clientName || '', contactName: cur.contactName || p.contactName || '', contactPhone: cur.contactPhone || p.contactPhone || '', contactEmail: cur.contactEmail || p.contactEmail || '' }));
      setFromRequest(!!(p.contactPhone || p.contactEmail));
    }).catch(() => {});
    return () => { on = false; };
  }, [item.projectId]);

  const pickClient = (name) => {
    const c = find(name);
    setF((x) => ({ ...x, clientName: name, clientId: c ? c.clientId : '', contactName: c ? (c.contactName || x.contactName) : x.contactName, contactEmail: c ? (c.contactEmail || x.contactEmail) : x.contactEmail, contactPhone: c ? (c.contactPhone || x.contactPhone) : x.contactPhone }));
  };
  const make = async () => {
    setBusy('make'); setErr('');
    try { const r = await omni.post('/gs/marketing/client-reviews', { ...f, kind, itemId: item.id, ...(decide ? { mode: 'decide' } : {}), message: f.message || `Please check this ${word} and tell us if it is OK to use.` }); setFresh(r.review); setAgain(false); toast(decide ? 'Waiting for the client: the private link is ready' : 'The private link is ready'); load(); onChanged && onChanged(); } catch (e) { setErr(errOf(e, 'The link could not be made.')); } finally { setBusy(''); }
  };
  // 2026-11-23: ONE press: the private link is made and WhatsApp sends it (the picture / video itself, with Approve / Reject, when WhatsApp allows it)
  const makeAndSend = async () => {
    setBusy('makesend'); setErr(''); setSendNote(null);
    let made = null;
    try {
      const r = await omni.post('/gs/marketing/client-reviews', { ...f, kind, itemId: item.id, ...(decide ? { mode: 'decide' } : {}), message: f.message || `Please check this ${word} and tell us if it is OK to use.` });
      made = r.review; setFresh(made); setAgain(false); onChanged && onChanged();
      const res = await omni.post(`/gs/marketing/client-reviews/${made.id}/tell`, { ways: ['whatsapp'], ...(numberId ? { numberId } : {}), ...(String(f.contactPhone).trim() ? { phone: String(f.contactPhone).trim() } : {}) });
      setSendNote(res.ok); toast(res.ok); load();
    } catch (e) { setErr(`${errOf(e, 'It could not be sent.')}${made ? ' The private link is made: press Send below to try again.' : ''}`); } finally { setBusy(''); }
  };
  const act = async (r, what) => {
    setBusy(what + r.id); setErr('');
    try { const res = await omni.post(`/gs/marketing/client-reviews/${r.id}/${what}`, what === 'extend' ? { days: 14 } : {}); toast(res.ok); setFresh(null); load(); onChanged && onChanged(); } catch (e) { setErr(errOf(e, 'That did not work.')); } finally { setBusy(''); }
  };

  const live = (reviews || []).filter((r) => r.status !== 'revoked'); // a cancelled link is not shown
  const current = fresh || live[0] || null; // newest first
  const open = !!current && current.status === 'sent';
  const showForm = !!reviews && !fresh && (!current || again || ['expired', 'changes'].includes(current.status));
  const url = (r) => `${window.location.origin}${r.link}`;
  const text = (r) => `Hello${r.contactName ? ` ${r.contactName}` : ''}, please review the ${word} "${item.title}" and tell us if it is OK to use: ${url(r)}`;
  const copy = async (r) => { try { await navigator.clipboard.writeText(url(r)); toast('Link copied'); } catch { window.prompt('Copy the link:', url(r)); } };
  const wa = (r) => window.open(`https://wa.me/${digits(phone != null ? phone : r.contactPhone)}?text=${encodeURIComponent(text(r))}`, '_blank', 'noopener');
  // a person's click: the company's own WhatsApp number / mailbox sends it (no WhatsApp login needed here)
  const tellIt = async (r, way) => {
    setBusy(`tell${way}`); setErr(''); setSendNote(null);
    try {
      const res = await omni.post(`/gs/marketing/client-reviews/${r.id}/tell`, { ways: [way], ...(way === 'email' && email != null && String(email).trim() ? { email: String(email).trim() } : {}), picture: way === 'whatsapp' && withFile && kind === 'image', ...(way === 'whatsapp' && numberId ? { numberId } : {}), ...(phone != null && String(phone).trim() ? { phone: String(phone).trim() } : {}) });
      setSendNote(res.ok); toast(res.ok); if (phone != null) load();
    } catch (e) { setErr(errOf(e, 'It could not be sent.')); } finally { setBusy(''); }
  };
  const mail = (r) => { window.location.href = `mailto:${encodeURIComponent(r.contactEmail || '')}?subject=${encodeURIComponent(`Please review: ${item.title}`)}&body=${encodeURIComponent(text(r))}`; };

  const share = (r) => (
    <div style={{ background: '#f3fbf7', border: '1px solid #cfe9dc', borderRadius: 10, padding: 12, marginTop: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: '#166534' }}>PRIVATE LINK FOR {r.clientName.toUpperCase()}</div>
      <input readOnly value={url(r)} onFocus={(e) => e.target.select()} aria-label="The private link" style={{ width: '100%', boxSizing: 'border-box', margin: '6px 0', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 9px', font: 'inherit', fontSize: 11 }} />
      <div style={{ margin: '8px 0 4px', fontSize: 10, fontWeight: 800, color: '#166534' }}>CLIENT'S WHATSAPP NUMBER</div>
      <input value={phone != null ? phone : (r.contactPhone || '')} maxLength={30} inputMode="tel" placeholder="+91…" onChange={(e) => setPhone(e.target.value)} aria-label="The client's WhatsApp number" style={{ width: '100%', boxSizing: 'border-box', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 9px', font: 'inherit', fontSize: 12 }} />
      <div style={{ margin: '8px 0 4px', fontSize: 10, fontWeight: 800, color: '#166534' }}>CLIENT'S EMAIL (FOR "SEND EMAIL")</div>
      <input value={email != null ? email : (r.contactEmail || '')} maxLength={160} inputMode="email" placeholder="client@company.com" onChange={(e) => setEmail(e.target.value)} aria-label="The client's email address" style={{ width: '100%', boxSizing: 'border-box', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 9px', font: 'inherit', fontSize: 12 }} />
      <SenderPick value={numberId} onChange={setNumberId} disabled={!!busy} />
      {kind === 'image' ? (
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11.5, margin: '8px 0 2px' }}>
          <input type="checkbox" checked={withFile} onChange={(e) => setWithFile(e.target.checked)} style={{ marginTop: 2 }} />
          <span>Also send the {word} itself on WhatsApp. WhatsApp allows this only if the client has written to us in the last 24 hours; if not, the link is sent instead.</span>
        </label>
      ) : null}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        <Btn small primary disabled={!!busy || planDirty || (ways && !ways.whatsapp.ready)} onClick={() => tellIt(r, 'whatsapp')} title={ways && !ways.whatsapp.ready ? `WhatsApp is not connected: ${ways.whatsapp.reason || 'ask an Admin'}` : 'TeamLink sends it from the company WhatsApp number'}>{busy === 'tellwhatsapp' ? 'Sending…' : 'Send on WhatsApp from TeamLink'}</Btn>
        <Btn small disabled={!!busy || planDirty || !(String(email != null ? email : (r.contactEmail || '')).trim()) || (ways && !ways.email.ready)} onClick={() => tellIt(r, 'email')} title={(email != null ? email : r.contactEmail) ? 'TeamLink sends it from the company mailbox, with the video attached and Approve / Reject links' : 'Type the client\'s email address first'}>{busy === 'tellemail' ? 'Sending…' : 'Send email from TeamLink'}</Btn>
        <Btn small onClick={() => copy(r)}>⧉ Copy link</Btn>
      </div>
      {sendNote ? <div className="mk-note ok" style={{ marginTop: 8 }}>{sendNote}</div> : null}
      <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 6 }}>
        {ways && ways.whatsapp.ready ? `WhatsApp goes from the company number${ways.whatsapp.via ? ` (${ways.whatsapp.via})` : ''}: no WhatsApp login is needed here.` : 'WhatsApp from TeamLink needs the company WhatsApp to be connected (Administration > Integrations).'} The client needs no login. Valid until {fmtDateTime(r.expiresAt)}.
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
        <span style={{ fontSize: 10, color: 'var(--muted)' }}>Or by hand:</span>
        <TinyBtn onClick={() => wa(r)} title="Opens WhatsApp Web / your own WhatsApp: it asks you to log in there">Open my own WhatsApp ↗</TinyBtn>
        <TinyBtn onClick={() => mail(r)}>My own email app ↗</TinyBtn>
      </div>
    </div>
  );

  return (
    <GsModal title={`${decide ? 'Ask the client to approve' : 'Send to client'}: ${item.title}`} sub={decide ? `The client's answer is the approval. The ${word} becomes Approved only when the client says yes; until then nobody on your team can approve it.` : `The client sees this ${word} on a private page and answers Approve or Request changes.`} width={560} onClose={onClose}
      foot={<Btn onClick={onClose}>Close</Btn>}>
      {err ? <Banner tone="error">{err}</Banner> : null}
      {!reviews ? <div style={{ fontSize: 12 }}>Loading…</div> : null}
      {current && !again ? (
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><b style={{ fontSize: 12 }}>{current.clientName}</b><ClientChip cr={current} /></div>
          {current.status === 'approved' ? <div className="mk-note ok" style={{ marginTop: 8 }}>Approved by {current.decidedByName} on {fmtDateTime(current.decidedAt)}.{current.comment ? ` “${current.comment}”` : ''}</div> : null}
          {current.status === 'changes' ? <div className="mk-note" style={{ marginTop: 8 }}>{current.decidedByName} asked for changes on {fmtDateTime(current.decidedAt)}: “{current.comment}”. {current.mode === 'decide' ? 'It is back with the writer: fix it, then ask the client again.' : 'Fix it, get it approved by your team, then send a new link.'}</div> : null}
          {current.status === 'expired' ? <div className="mk-note" style={{ marginTop: 8 }}>This link expired on {fmtDateTime(current.expiresAt)}.{current.mode === 'decide' ? ' Make a new link, or let your team approve it.' : ''}</div> : null}
          {open ? <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>Waiting for the client{current.views ? ` · opened ${current.views} time${current.views === 1 ? '' : 's'}` : ' · not opened yet'}.{current.mode === 'decide' ? ' Only the client can approve it. If you cancel the link, it goes back to Drafts.' : ''}</div> : null}
          {open || fresh ? share(current) : null}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
            {open ? <TinyBtn disabled={!!busy} onClick={() => act(current, 'extend')}>Extend 14 days</TinyBtn> : null}
            {open ? <TinyBtn disabled={!!busy} onClick={() => act(current, 'revoke')}>Cancel the link</TinyBtn> : null}
            {!fresh ? <TinyBtn onClick={() => { setAgain(true); setFresh(null); }}>Make a new link</TinyBtn> : null}
          </div>
        </div>
      ) : null}
      {kind === 'image' && item.style !== 'clip' && reviews && !(item.plan && ['posted', 'posting'].includes(item.plan.state)) ? <PostPlanBox item={item} toast={toast} onChanged={onChanged} onDirty={setPlanDirty} /> : null}
      {showForm ? (
        <div className="form-grid" style={{ marginTop: current && !again ? 14 : 10 }}>
          {fromRequest ? <div className="mk-note ok" style={{ gridColumn: '1 / -1' }}>The client's details are taken from their request (name, WhatsApp number, email). Check the number, then press <b>Send</b>: the {word} itself goes to that number with Approve and Reject buttons.</div> : null}
          <Field label="CLIENT (COMPANY)" full>
            <input list="mk-clients" value={f.clientName} maxLength={120} onChange={(e) => pickClient(e.target.value)} placeholder="Pick or type the client's name" />
            <datalist id="mk-clients">{names.map((n) => <option key={n} value={n} />)}</datalist>
          </Field>
          <Field label="CONTACT PERSON"><input value={f.contactName} maxLength={120} onChange={(e) => setF({ ...f, contactName: e.target.value })} /></Field>
          <Field label="WHATSAPP NUMBER"><input value={f.contactPhone} maxLength={30} inputMode="tel" onChange={(e) => setF({ ...f, contactPhone: e.target.value })} placeholder="+91…" /></Field>
          <Field label="EMAIL" full><input value={f.contactEmail} maxLength={160} onChange={(e) => setF({ ...f, contactEmail: e.target.value })} /></Field>
          <Field label="MESSAGE TO THE CLIENT (OPTIONAL)" full><textarea style={{ minHeight: 60 }} value={f.message} maxLength={400} onChange={(e) => setF({ ...f, message: e.target.value })} placeholder={`Please check this ${word} and tell us if it is OK to use.`} /></Field>
          <Field label="THE LINK WORKS FOR"><select value={f.days} onChange={(e) => setF({ ...f, days: Number(e.target.value) })}>{[3, 7, 14, 30].map((n) => <option key={n} value={n}>{n} days</option>)}</select></Field>
          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
            <Btn primary disabled={!!busy || planDirty || f.clientName.trim().length < 2 || !String(f.contactPhone).trim() || (ways && !ways.whatsapp.ready)} onClick={makeAndSend} title={!String(f.contactPhone).trim() ? 'Write the client\'s WhatsApp number first' : 'Makes the private link and sends it on WhatsApp from the company number'}>{busy === 'makesend' ? 'Sending…' : 'Send to the client on WhatsApp'}</Btn>
            <Btn disabled={!!busy || f.clientName.trim().length < 2} onClick={make}>{busy === 'make' ? 'Making…' : 'Make the private link only'}</Btn>
            {again ? <Btn onClick={() => setAgain(false)}>Back</Btn> : null}
          </div>
        </div>
      ) : null}
    </GsModal>
  );
}
