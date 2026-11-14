import { useEffect, useMemo, useState } from 'react';
import api from '../../../api';
import omni, { errOf } from '../omniApi.js';
import { Btn, TinyBtn, GsModal, Field, Banner, fmtDateTime } from '../ui.jsx';
import { ClientChip } from './mk.jsx';

// "SEND TO CLIENT" (AI Marketing > client approval): for an item the team has approved, makes a private link the client opens without a login to Approve or Request
// changes. TeamLink does not send the link itself (no email / WhatsApp is connected): this window gives Copy, WhatsApp and Email buttons. Server: marketing/clientReview.js.
const digits = (s) => String(s || '').replace(/\D/g, '');
const WORD = { content: 'message', image: 'picture' };

export default function ClientReviewModal({ kind, item, isVideo, onClose, onChanged, toast }) {
  const [reviews, setReviews] = useState(null);
  const [clients, setClients] = useState([]);
  const [f, setF] = useState({ clientName: '', clientId: '', contactName: '', contactEmail: '', contactPhone: '', message: '', days: 14 });
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [again, setAgain] = useState(false); // "make a new link" pressed
  const [fresh, setFresh] = useState(null); // the review just made
  const word = isVideo ? 'video' : (WORD[kind] || 'item');

  const load = () => omni.get('/gs/marketing/client-reviews', { kind, itemId: item.id }).then((d) => setReviews(d.reviews || [])).catch((e) => setErr(errOf(e, 'The client approvals could not be read.')));
  useEffect(() => { load(); api.get('/clients').then((r) => setClients(Array.isArray(r.data) ? r.data : (r.data && r.data.clients) || [])).catch(() => setClients([])); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const names = useMemo(() => clients.map((c) => c.name).filter(Boolean), [clients]);

  const pickClient = (name) => {
    const c = clients.find((x) => x.name === name);
    setF((x) => ({ ...x, clientName: name, clientId: c ? c.id : '', contactName: c ? (c.contactName || x.contactName) : x.contactName, contactEmail: c ? (c.contactEmail || x.contactEmail) : x.contactEmail, contactPhone: c ? (c.contactWhatsApp || c.contactPhone || x.contactPhone) : x.contactPhone }));
  };
  const make = async () => {
    setBusy('make'); setErr('');
    try { const r = await omni.post('/gs/marketing/client-reviews', { ...f, kind, itemId: item.id, message: f.message || `Please check this ${word} and tell us if it is OK to use.` }); setFresh(r.review); setAgain(false); toast('The private link is ready'); load(); onChanged && onChanged(); } catch (e) { setErr(errOf(e, 'The link could not be made.')); } finally { setBusy(''); }
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
  const wa = (r) => window.open(`https://wa.me/${digits(r.contactPhone)}?text=${encodeURIComponent(text(r))}`, '_blank', 'noopener');
  const mail = (r) => { window.location.href = `mailto:${encodeURIComponent(r.contactEmail || '')}?subject=${encodeURIComponent(`Please review: ${item.title}`)}&body=${encodeURIComponent(text(r))}`; };

  const share = (r) => (
    <div style={{ background: '#f3fbf7', border: '1px solid #cfe9dc', borderRadius: 10, padding: 12, marginTop: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: '#166534' }}>PRIVATE LINK FOR {r.clientName.toUpperCase()}</div>
      <input readOnly value={url(r)} onFocus={(e) => e.target.select()} aria-label="The private link" style={{ width: '100%', boxSizing: 'border-box', margin: '6px 0', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 9px', font: 'inherit', fontSize: 11 }} />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Btn small primary onClick={() => copy(r)}>⧉ Copy link</Btn>
        <Btn small onClick={() => wa(r)} title={r.contactPhone ? '' : 'No number: WhatsApp will ask for one'}>WhatsApp ↗</Btn>
        <Btn small onClick={() => mail(r)}>Email ↗</Btn>
      </div>
      <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 6 }}>TeamLink does not send it for you: press a button, then send the message yourself. The client needs no login. Valid until {fmtDateTime(r.expiresAt)}.</div>
    </div>
  );

  return (
    <GsModal title={`Send to client: ${item.title}`} sub={`The client sees this ${word} on a private page and answers Approve or Request changes.`} width={560} onClose={onClose}
      foot={<Btn onClick={onClose}>Close</Btn>}>
      {err ? <Banner tone="error">{err}</Banner> : null}
      {!reviews ? <div style={{ fontSize: 12 }}>Loading…</div> : null}
      {current && !again ? (
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><b style={{ fontSize: 12 }}>{current.clientName}</b><ClientChip cr={current} /></div>
          {current.status === 'approved' ? <div className="mk-note ok" style={{ marginTop: 8 }}>Approved by {current.decidedByName} on {fmtDateTime(current.decidedAt)}.{current.comment ? ` “${current.comment}”` : ''}</div> : null}
          {current.status === 'changes' ? <div className="mk-note" style={{ marginTop: 8 }}>{current.decidedByName} asked for changes on {fmtDateTime(current.decidedAt)}: “{current.comment}”. Fix it, get it approved by your team, then send a new link.</div> : null}
          {current.status === 'expired' ? <div className="mk-note" style={{ marginTop: 8 }}>This link expired on {fmtDateTime(current.expiresAt)}.</div> : null}
          {open ? <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>Waiting for the client{current.views ? ` · opened ${current.views} time${current.views === 1 ? '' : 's'}` : ' · not opened yet'}.</div> : null}
          {open || fresh ? share(current) : null}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
            {open ? <TinyBtn disabled={!!busy} onClick={() => act(current, 'extend')}>Extend 14 days</TinyBtn> : null}
            {open ? <TinyBtn disabled={!!busy} onClick={() => act(current, 'revoke')}>Cancel the link</TinyBtn> : null}
            {!fresh ? <TinyBtn onClick={() => { setAgain(true); setFresh(null); }}>Make a new link</TinyBtn> : null}
          </div>
        </div>
      ) : null}
      {showForm ? (
        <div className="form-grid" style={{ marginTop: current && !again ? 14 : 0 }}>
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
            <Btn primary disabled={busy === 'make' || f.clientName.trim().length < 2} onClick={make}>{busy === 'make' ? 'Making…' : 'Make the private link'}</Btn>
            {again ? <Btn onClick={() => setAgain(false)}>Back</Btn> : null}
          </div>
        </div>
      ) : null}
    </GsModal>
  );
}
