import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../../api';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Panel, Banner, Field, Tabs, Empty, GsModal, Pill, Tag, ConfirmModal, fmtDateTime, fmtDate } from '../ui.jsx';
import { MkImg, downloadMkImg } from '../marketing/mk.jsx';
import '../marketing/marketing.css';

// AI MARKETING > CLIENT PROJECTS: the agency workflow in one place. A client asks (email, WhatsApp, phone, our portal link) -> the team accepts -> makes options with AI
// -> shows them on ONE private link -> the client picks one and adds suggestions (their pick is the approval) -> the team posts it on the client's pages.
// Server: marketing/projects.js. The client's own page: marketing/ClientProjectPage.jsx.
const STATUS = {
  invited: ['draft', 'Waiting for the client\'s request'], request: ['warn', 'New request'], working: ['live', 'In progress'], awaiting_client: ['warn', 'With the client'],
  approved: ['live', 'Approved by the client'], posted: ['live', 'Posted'], declined: ['red', 'Declined'],
};
const TABS = [['', 'All'], ['request', 'New requests'], ['working', 'In progress'], ['awaiting_client', 'With the client'], ['approved', 'Approved'], ['posted', 'Posted'], ['invited', 'Invited'], ['declined', 'Declined']];
const STEPS = [['request', 'Request'], ['working', 'Accepted'], ['awaiting_client', 'With the client'], ['approved', 'Client chose'], ['posted', 'Posted']];
const KIND_ICON = { request: '✉', invited: '🔗', accepted: '✔', declined: '✖', options_sent: '➤', client_chose: '★', client_changes: '✎', cancelled: '↩', extended: '⏱', scheduled: '🗓', posted: '✓' };
const SEND = [['facebook', 'Facebook', 'f', '#1877f2'], ['instagram', 'Instagram', '◎', '#d62976'], ['x', 'X', '𝕏', '#111111']]; // the send buttons of an approved project
const digits = (s) => String(s || '').replace(/\D/g, '');
const origin = () => window.location.origin;
const statusPill = (s) => { const [tone, words] = STATUS[s] || ['draft', s]; return <Pill tone={tone} dot>{words}</Pill>; };
const readLogo = (file) => new Promise((resolve, reject) => {
  if (!file) { resolve(''); return; }
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { reject(new Error('Use a PNG, JPG or WebP logo.')); return; }
  if (file.size > 300 * 1024) { reject(new Error(`The logo is too big (${Math.round(file.size / 1024)} KB). Use one under 300 KB.`)); return; }
  const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(new Error('The logo could not be read.')); r.readAsDataURL(file);
});

// a private link with Copy, WhatsApp and Email (TeamLink does not send it: no email / WhatsApp is connected for this)
function ShareBox({ url, phone, email, text, subject, toast, caption }) {
  const copy = async () => { try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { window.prompt('Copy the link:', url); } };
  return (
    <div style={{ background: '#f3fbf7', border: '1px solid #cfe9dc', borderRadius: 10, padding: 12 }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: '#166534' }}>{caption || 'PRIVATE LINK FOR THE CLIENT'}</div>
      <input readOnly value={url} onFocus={(e) => e.target.select()} aria-label="The private link" style={{ width: '100%', boxSizing: 'border-box', margin: '6px 0', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 9px', font: 'inherit', fontSize: 11 }} />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Btn small primary onClick={copy}>⧉ Copy link</Btn>
        <Btn small onClick={() => window.open(`https://wa.me/${digits(phone)}?text=${encodeURIComponent(`${text} ${url}`)}`, '_blank', 'noopener')} title={phone ? '' : 'No number saved: WhatsApp will ask for one'}>WhatsApp ↗</Btn>
        <Btn small onClick={() => { window.location.href = `mailto:${encodeURIComponent(email || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(`${text} ${url}`)}`; }}>Email ↗</Btn>
      </div>
      <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 6 }}>TeamLink does not send it for you: press a button, then send the message yourself. The client needs no login.</div>
    </div>
  );
}

// ---- log a request the client sent by email / WhatsApp / phone ----------------------------------------------------------------------------------------------
function RequestModal({ meta, project, onClose, onDone, toast }) {
  const edit = !!project;
  const [clients, setClients] = useState([]);
  const [f, setF] = useState(() => (project ? { clientName: project.clientName, contactName: project.contactName, contactPhone: project.contactPhone, contactEmail: project.contactEmail, source: project.source, occasion: project.occasion, brief: project.brief, deliverable: project.deliverable, platforms: project.platforms, handles: project.handles, dueDate: project.dueDate, colors: project.colors || {}, accept: false }
    : { clientName: '', contactName: '', contactPhone: '', contactEmail: '', source: 'whatsapp', occasion: '', brief: '', deliverable: 'video', platforms: ['instagram'], handles: '', dueDate: '', colors: {}, accept: true }));
  const [logo, setLogo] = useState(undefined); // undefined = unchanged, '' = removed, data URL = new
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api.get('/clients').then((r) => setClients(Array.isArray(r.data) ? r.data : (r.data && r.data.clients) || [])).catch(() => setClients([])); }, []);
  const names = useMemo(() => clients.map((c) => c.name).filter(Boolean), [clients]);
  const pickClient = (name) => { const c = clients.find((x) => x.name === name); setF((x) => ({ ...x, clientName: name, contactName: c ? (c.contactName || x.contactName) : x.contactName, contactEmail: c ? (c.contactEmail || x.contactEmail) : x.contactEmail, contactPhone: c ? (c.contactWhatsApp || c.contactPhone || x.contactPhone) : x.contactPhone })); };
  const toggle = (k) => setF((x) => ({ ...x, platforms: x.platforms.includes(k) ? x.platforms.filter((p) => p !== k) : [...x.platforms, k] }));
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const body = { ...f, colors: f.colors && (f.colors.primary || f.colors.secondary) ? f.colors : null };
      if (logo !== undefined) body.logoDataUrl = logo;
      const r = edit ? await omni.put(`/gs/marketing/projects/${project.id}`, body) : await omni.post('/gs/marketing/projects', body);
      toast(edit ? 'Saved' : (f.accept ? 'Project started' : 'Request logged')); onDone(r.project);
    } catch (e) { setErr(errOf(e, 'It could not be saved.')); } finally { setBusy(false); }
  };
  return (
    <GsModal title={edit ? 'Edit the request' : 'Log a client request'} sub="What the client asked for, as they told you." width={640} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={busy} onClick={save}>{busy ? 'Saving…' : edit ? 'Save' : f.accept ? 'Start the project' : 'Log the request'}</Btn></>}>
      {err ? <Banner tone="error">{err}</Banner> : null}
      <div className="form-grid">
        <Field label="CLIENT (COMPANY)" full><input list="mkp-clients" value={f.clientName} maxLength={120} onChange={(e) => pickClient(e.target.value)} placeholder="Pick or type the client's name" /><datalist id="mkp-clients">{names.map((n) => <option key={n} value={n} />)}</datalist></Field>
        <Field label="CONTACT PERSON"><input value={f.contactName} maxLength={120} onChange={(e) => setF({ ...f, contactName: e.target.value })} /></Field>
        <Field label="WHATSAPP NUMBER"><input value={f.contactPhone} maxLength={30} inputMode="tel" onChange={(e) => setF({ ...f, contactPhone: e.target.value })} placeholder="+91…" /></Field>
        <Field label="EMAIL"><input value={f.contactEmail} maxLength={160} onChange={(e) => setF({ ...f, contactEmail: e.target.value })} /></Field>
        <Field label="HOW DID THE REQUEST COME?"><select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>{meta.sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></Field>
        <Field label="WHAT IS IT FOR?" full><input value={f.occasion} maxLength={120} onChange={(e) => setF({ ...f, occasion: e.target.value })} placeholder="For example: Diwali offer, Independence Day wishes" /></Field>
        <Field label="THE BRIEF" full hint="In the client's words: what they want, the message, the offer, anything to avoid."><textarea style={{ minHeight: 90 }} value={f.brief} maxLength={3000} onChange={(e) => setF({ ...f, brief: e.target.value })} /></Field>
        <Field label="THEY WANT"><select value={f.deliverable} onChange={(e) => setF({ ...f, deliverable: e.target.value })}>{meta.deliverables.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}</select></Field>
        <Field label="NEEDED BY"><input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></Field>
        <Field label="TO BE POSTED ON" full>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12 }}>{meta.platforms.map((p) => <label key={p.key} style={{ display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={f.platforms.includes(p.key)} onChange={() => toggle(p.key)} />{p.label}</label>)}</div>
        </Field>
        <Field label="THEIR PAGES / HANDLES" full hint="Where we post: page links or handles."><textarea style={{ minHeight: 50 }} value={f.handles} maxLength={600} onChange={(e) => setF({ ...f, handles: e.target.value })} /></Field>
        <Field label="THEIR LOGO" hint="PNG, JPG or WebP under 300 KB. It goes into the videos we make for them.">
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => readLogo(e.target.files && e.target.files[0]).then((d) => { setLogo(d); setErr(''); }).catch((er) => { setErr(er.message); e.target.value = ''; })} />
          {edit && project.hasLogo && logo === undefined ? <small style={{ fontSize: 10 }}>A logo is saved. Choose a file to replace it. <button type="button" className="link-btn" onClick={() => setLogo('')}>Remove it</button></small> : null}
          {logo ? <img src={logo} alt="Logo preview" style={{ maxHeight: 48, marginTop: 6, background: '#f4f6f5', borderRadius: 6, padding: 4 }} /> : null}
        </Field>
        <Field label="THEIR BRAND COLOURS (OPTIONAL)">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 11 }}>
            <label>Main <input type="color" value={(f.colors && f.colors.primary) || '#0f766e'} onChange={(e) => setF({ ...f, colors: { ...f.colors, primary: e.target.value } })} /></label>
            <label>Second <input type="color" value={(f.colors && f.colors.secondary) || '#134e4a'} onChange={(e) => setF({ ...f, colors: { ...f.colors, secondary: e.target.value } })} /></label>
            {f.colors && (f.colors.primary || f.colors.secondary) ? <button type="button" className="link-btn" onClick={() => setF({ ...f, colors: {} })}>Clear</button> : null}
          </div>
        </Field>
        {!edit ? <label style={{ gridColumn: '1 / -1', fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={f.accept} onChange={(e) => setF({ ...f, accept: e.target.checked })} />We have accepted this request: start work now (you become the owner)</label> : null}
      </div>
    </GsModal>
  );
}

// ---- a private link the client uses to write the request themselves ("request in our portal") ----------------------------------------------------------------
function InviteModal({ onClose, onDone, toast }) {
  const [f, setF] = useState({ clientName: '', contactName: '', contactPhone: '', contactEmail: '' });
  const [made, setMade] = useState(null);
  const [clients, setClients] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api.get('/clients').then((r) => setClients(Array.isArray(r.data) ? r.data : (r.data && r.data.clients) || [])).catch(() => setClients([])); }, []);
  const pick = (name) => { const c = clients.find((x) => x.name === name); setF((x) => ({ ...x, clientName: name, contactName: c ? (c.contactName || x.contactName) : x.contactName, contactEmail: c ? (c.contactEmail || x.contactEmail) : x.contactEmail, contactPhone: c ? (c.contactWhatsApp || c.contactPhone || x.contactPhone) : x.contactPhone })); };
  const make = async () => { setBusy(true); setErr(''); try { const r = await omni.post('/gs/marketing/projects/invite', f); setMade(r.project); toast('The request link is ready'); onDone(); } catch (e) { setErr(errOf(e, 'The link could not be made.')); } finally { setBusy(false); } };
  return (
    <GsModal title="Invite a client to send a request" sub="The client opens a private page, writes what they need, adds their logo and the pages we post on. No login." width={560} onClose={onClose} foot={<Btn onClick={onClose}>{made ? 'Done' : 'Cancel'}</Btn>}>
      {err ? <Banner tone="error">{err}</Banner> : null}
      {made ? <ShareBox url={`${origin()}${made.link}`} phone={made.contactPhone} email={made.contactEmail} subject="Please tell us what you need" text={`Hello${made.contactName ? ` ${made.contactName}` : ''}, please tell us what you need and add your logo here:`} toast={toast} caption={`REQUEST LINK FOR ${made.clientName.toUpperCase()}`} /> : (
        <div className="form-grid">
          <Field label="CLIENT (COMPANY)" full><input list="mkp-inv-clients" value={f.clientName} maxLength={120} onChange={(e) => pick(e.target.value)} placeholder="Pick or type the client's name" /><datalist id="mkp-inv-clients">{clients.map((c) => <option key={c.id || c.name} value={c.name} />)}</datalist></Field>
          <Field label="CONTACT PERSON"><input value={f.contactName} maxLength={120} onChange={(e) => setF({ ...f, contactName: e.target.value })} /></Field>
          <Field label="WHATSAPP NUMBER"><input value={f.contactPhone} maxLength={30} inputMode="tel" onChange={(e) => setF({ ...f, contactPhone: e.target.value })} placeholder="+91…" /></Field>
          <Field label="EMAIL" full><input value={f.contactEmail} maxLength={160} onChange={(e) => setF({ ...f, contactEmail: e.target.value })} /></Field>
          <div style={{ gridColumn: '1 / -1' }}><Btn primary disabled={busy || f.clientName.trim().length < 2} onClick={make}>{busy ? 'Making…' : 'Make the request link'}</Btn></div>
        </div>
      )}
    </GsModal>
  );
}

// ---- pick the pictures / videos to show the client --------------------------------------------------------------------------------------------------------------
function PickModal({ project, taken, onClose, onPick }) {
  const [items, setItems] = useState(null);
  const [sel, setSel] = useState([]);
  const [err, setErr] = useState('');
  useEffect(() => { omni.get('/gs/marketing/images', {}).then((d) => setItems(d.items || [])).catch((e) => setErr(errOf(e, 'The pictures could not be read.'))); }, []);
  const usable = (items || []).filter((i) => i.style !== 'clip' && ['draft', 'changes', 'approved'].includes(i.status) && !taken.includes(i.id));
  const sorted = [...usable.filter((i) => i.projectId === project.id), ...usable.filter((i) => i.projectId !== project.id)];
  const room = 8 - taken.length;
  const tog = (id) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= room ? s : [...s, id]));
  return (
    <GsModal title="Pick pictures and videos to show the client" sub={`Choose up to ${room} more. Make them first in AI Images and AI Video; the ones made for this project come first.`} width={760} onClose={onClose}
      foot={<><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={!sel.length} onClick={() => onPick(sel)}>Add {sel.length || ''} to the options</Btn></>}>
      {err ? <Banner tone="error">{err}</Banner> : null}
      {!items ? <div style={{ fontSize: 12 }}>Loading…</div> : sorted.length === 0 ? <Empty title="No pictures or videos to pick yet">Make some in AI Images or AI Video (use “Make for this project” on the project page), then come back.</Empty> : (
        <div className="mki-grid" style={{ maxHeight: 420, overflow: 'auto' }}>
          {sorted.map((i) => (
            <button type="button" key={i.id} onClick={() => tog(i.id)} className="card mki-card" style={{ textAlign: 'left', cursor: 'pointer', outline: sel.includes(i.id) ? '3px solid #0f766e' : 'none' }}>
              <MkImg id={i.id} lazy alt={i.title} video={i.kind === 'video'} controls={false} style={{ aspectRatio: String(i.aspect || '1:1').replace(':', ' / '), objectFit: 'cover', ...(i.kind === 'video' ? { background: '#000' } : {}) }} />
              <b style={{ fontSize: 11, marginTop: 6 }}>{i.title}</b>
              <small style={{ fontSize: 9.5, color: 'var(--muted)' }}>{i.kind === 'video' ? 'Video' : 'Picture'} · {i.status}{i.projectId === project.id ? ' · made for this project' : ''}</small>
              {sel.includes(i.id) ? <span className="pill live">Picked</span> : null}
            </button>
          ))}
        </div>
      )}
    </GsModal>
  );
}

// ---- "Our work": put a finished project in the portfolio clients can see (with the client's agreement) ----------------------------------------------------------
function ShowcasePanel({ p, onSaved, toast }) {
  const [f, setF] = useState({ consent: p.showcase, showName: p.showcaseClient, title: p.showcaseTitle || p.occasion || '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async (show) => {
    setBusy(true); setErr('');
    try { const r = await omni.post(`/gs/marketing/projects/${p.id}/showcase`, { show, consent: f.consent, showName: f.showName, title: f.title }); toast(r.ok || 'Saved'); onSaved(); } catch (e) { setErr(errOf(e, 'It could not be saved.')); } finally { setBusy(false); }
  };
  return (
    <Panel title="Show this to other clients" sub="New clients trust us when they see real finished work. It appears on the client pages and on the public “Our work” page." right={p.showcase ? <Pill tone="live" dot>In our portfolio</Pill> : null}>
      {err ? <Banner tone="error">{err}</Banner> : null}
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, lineHeight: 1.5 }}><input type="checkbox" style={{ marginTop: 3 }} checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} />The client agrees that we may show this work to other clients.</label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, margin: '8px 0' }}><input type="checkbox" checked={f.showName} onChange={(e) => setF({ ...f, showName: e.target.checked })} />Also show the client's name ({p.clientName}). Otherwise it says “A client”.</label>
      <Field label="HOW IT IS TITLED" full><input value={f.title} maxLength={80} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="For example: Diwali offer for a software company" /></Field>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <Btn primary disabled={busy || !f.consent} onClick={() => save(true)}>{p.showcase ? 'Save changes' : 'Add to our portfolio'}</Btn>
        {p.showcase ? <Btn disabled={busy} onClick={() => save(false)}>Take it out</Btn> : null}
        <Btn onClick={() => window.open('/our-work', '_blank', 'noopener')}>See what clients see ↗</Btn>
      </div>
    </Panel>
  );
}

// ---- one project ------------------------------------------------------------------------------------------------------------------------------------------------------
function Detail({ id, meta, onBack, onChanged }) {
  const { toast, go } = useOmni();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [modal, setModal] = useState(''); // 'edit' | 'pick' | 'send' | 'decline' | 'posted'
  const [staged, setStaged] = useState([]); // [{ itemId, label, item }]
  const [caption, setCaption] = useState('');
  const [approvedList, setApprovedList] = useState([]);
  const [accts, setAccts] = useState({ allowed: false, accounts: [] }); // the client's connected Facebook / Instagram / X accounts (for the send buttons)
  const [postFor, setPostFor] = useState(''); // 'facebook' | 'instagram' | 'x': the platform whose send button was pressed
  const [postSel, setPostSel] = useState([]);
  const [postErr, setPostErr] = useState([]);
  const [sendF, setSendF] = useState({ days: 14, message: '' });
  const [reason, setReason] = useState('');
  const [postUrl, setPostUrl] = useState('');
  const [when, setWhen] = useState({ date: new Date(Date.now() + 86400000 + 19800000).toISOString().slice(0, 10), time: '10:00' });

  const load = useCallback(() => omni.get(`/gs/marketing/projects/${id}`).then((x) => {
    setD(x); setCaption(x.project.caption || '');
    setStaged(x.options.filter((o) => o.stage === 'staged').map((o) => ({ itemId: o.itemId, label: o.label, item: o.item })));
    if (['approved', 'posted'].includes(x.project.status)) {
      omni.get('/gs/marketing/images', { status: 'approved' }).then((l) => setApprovedList(l.items || [])).catch(() => setApprovedList([]));
      omni.get('/gs/marketing/projects/accounts').then(setAccts).catch(() => setAccts({ allowed: false, accounts: [] }));
    }
  }).catch((e) => setErr(errOf(e, 'The project could not be opened.'))), [id]);
  useEffect(() => { load(); }, [load]);
  if (err && !d) return <Banner tone="error">{err} <button type="button" className="tiny-btn" onClick={onBack}>Back</button></Banner>;
  if (!d) return <div className="card panel">Loading…</div>;
  const p = d.project;
  const url = `${origin()}${p.link}`;
  const done = (r, fallback) => { toast((r && r.ok) || fallback || 'Done'); onChanged(); return load(); };
  const act = async (path, body, fallback) => { setBusy(path); setErr(''); try { const r = await omni.post(`/gs/marketing/projects/${id}/${path}`, body || {}); await done(r, fallback); return r; } catch (e) { const m = errOf(e, 'That did not work.'); setErr(m); toast(m); return null; } finally { setBusy(''); } };
  const saveStaged = async (next) => {
    setErr('');
    try { await omni.post(`/gs/marketing/projects/${id}/options`, { items: next.map((s) => ({ itemId: s.itemId, label: s.label })) }); await load(); onChanged(); } catch (e) { setErr(errOf(e, 'The options could not be saved.')); }
  };
  const chosen = d.options.find((o) => o.chosen);
  const chosenItem = chosen && approvedList.find((i) => i.id === chosen.itemId);
  const stepIdx = STEPS.findIndex((s) => s[0] === p.status);
  const presented = d.options.filter((o) => o.stage === 'presented');
  const share = (text, subject) => <ShareBox url={url} phone={p.contactPhone} email={p.contactEmail} text={text} subject={subject} toast={toast} />;
  const listText = (s) => `${d.options.length}`;
  void listText;

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <Btn small onClick={onBack}>← All projects</Btn>
        <h2 style={{ margin: 0, fontSize: 17 }}>{p.title}</h2>{statusPill(p.status)}
        {p.status === 'awaiting_client' && p.linkExpired ? <Pill tone="red">Link expired</Pill> : null}
      </div>
      {err ? <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={() => setErr('')}>Close</button></Banner> : null}

      {p.status === 'declined' ? <Banner tone="warn">Declined: {p.declinedNote}</Banner> : (
        <ol className="mk-steps" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 18, margin: '0 0 12px' }}>
          {STEPS.map(([k, label], i) => <li key={k} style={{ opacity: stepIdx >= i ? 1 : 0.45 }}><span className={`dot${stepIdx >= i ? ' done' : ''}`}>{stepIdx >= i ? '✓' : ''}</span>{label}</li>)}
        </ol>
      )}

      <div className="mk-two">
        <div>
          <Panel title="The request" right={!['posted', 'declined'].includes(p.status) ? <TinyBtn onClick={() => setModal('edit')}>Edit</TinyBtn> : null}>
            <div style={{ display: 'flex', gap: 14 }}>
              <div style={{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: 1.6 }}>
                <div><b>{p.clientName}</b>{p.contactName ? ` · ${p.contactName}` : ''}</div>
                <div style={{ color: 'var(--muted)' }}>{[p.contactPhone, p.contactEmail].filter(Boolean).join(' · ')}</div>
                <div style={{ marginTop: 6 }}><Tag>{(meta.sources.find((s) => s.key === p.source) || {}).label || 'Other'}</Tag> <Tag>{(meta.deliverables.find((x) => x.key === p.deliverable) || {}).label}</Tag> {p.platforms.map((k) => <Tag key={k} green>{(meta.platforms.find((x) => x.key === k) || {}).label || k}</Tag>)}</div>
                <div style={{ marginTop: 8 }}><b>{p.occasion}</b></div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{p.brief}</div>
                {p.handles ? <div style={{ marginTop: 6, color: 'var(--muted)', whiteSpace: 'pre-wrap' }}>Pages: {p.handles}</div> : null}
                <div style={{ marginTop: 6, color: 'var(--muted)' }}>{p.dueDate ? `Needed by ${fmtDate(p.dueDate)} · ` : ''}Received {fmtDateTime(p.createdAt)}{p.ownerName ? ` · Owner: ${p.ownerName}` : ''}</div>
              </div>
              {d.logo ? <div style={{ flex: 'none', textAlign: 'center' }}><img src={d.logo} alt="Client logo" style={{ maxWidth: 90, maxHeight: 90, background: '#f4f6f5', borderRadius: 8, padding: 6, display: 'block' }} />{p.colors ? <div style={{ display: 'flex', gap: 4, justifyContent: 'center', marginTop: 6 }}>{[p.colors.primary, p.colors.secondary].filter(Boolean).map((c) => <span key={c} title={c} style={{ width: 18, height: 18, borderRadius: 9, background: c, border: '1px solid var(--line)' }} />)}</div> : null}</div> : null}
            </div>
          </Panel>

          {p.status === 'request' ? (
            <Panel title="A new request" sub="Accept it to start work, or decline with a reason the client will see." style={{ marginTop: 14 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Btn primary disabled={!!busy} onClick={() => act('accept', {}, 'Accepted')}>✔ Accept and start</Btn>
                <Btn disabled={!!busy} onClick={() => { setReason(''); setModal('decline'); }}>Decline…</Btn>
              </div>
            </Panel>
          ) : null}

          {p.status === 'working' ? (
            <Panel title="Make and pick the options" sub="Make a few pictures and videos for this client with AI, then pick the ones to show. The client chooses one." style={{ marginTop: 14 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                <Btn small onClick={() => go('mkvideos', { project: p.id })} title="Opens AI Video with this client's logo and colours">🎬 Make a video for this client</Btn>
                <Btn small onClick={() => go('mkimages', { project: p.id })}>🖼 Make pictures</Btn>
                <Btn small onClick={() => setModal('pick')} disabled={staged.length >= 8}>＋ Pick from my pictures and videos</Btn>
              </div>
              {staged.length === 0 ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>No options yet. Show the client 3 to 5: more is harder to choose from.</div> : (
                <div className="mki-grid" style={{ marginTop: 0 }}>
                  {staged.map((s, i) => (
                    <div key={s.itemId} className="card mki-card">
                      <MkImg id={s.itemId} lazy alt={s.label} video={s.item && s.item.kind === 'video'} controls={false} style={{ aspectRatio: String((s.item && s.item.aspect) || '1:1').replace(':', ' / '), objectFit: 'cover', ...(s.item && s.item.kind === 'video' ? { background: '#000' } : {}) }} />
                      <input value={s.label} maxLength={40} aria-label="Option name" onChange={(e) => setStaged(staged.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))} onBlur={() => saveStaged(staged)} style={{ border: '1px solid var(--line)', borderRadius: 7, padding: '5px 7px', font: 'inherit', fontSize: 11, margin: '6px 0 4px' }} />
                      <div className="mk-acts" style={{ justifyContent: 'space-between' }}>
                        <span><TinyBtn disabled={i === 0} onClick={() => { const n = [...staged]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; setStaged(n); saveStaged(n); }} aria-label="Earlier">↑</TinyBtn> <TinyBtn disabled={i === staged.length - 1} onClick={() => { const n = [...staged]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; setStaged(n); saveStaged(n); }} aria-label="Later">↓</TinyBtn></span>
                        <TinyBtn onClick={() => { const n = staged.filter((_, k) => k !== i); setStaged(n); if (n.length) saveStaged(n); else omni.post(`/gs/marketing/projects/${id}/options`, { items: [] }).catch(() => load()); }}>Remove</TinyBtn>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <Field label="THE POST WORDS (CAPTION)" full hint="The client sees it with the options. It is what we post after they choose.">
                <textarea style={{ minHeight: 70 }} value={caption} maxLength={3000} onChange={(e) => setCaption(e.target.value)} onBlur={() => { if (caption !== (p.caption || '')) omni.put(`/gs/marketing/projects/${id}`, { caption }).then(() => load()).catch((e) => setErr(errOf(e, 'The caption could not be saved.'))); }} />
              </Field>
              <div style={{ marginTop: 10 }}><Btn primary disabled={!staged.length || !!busy} onClick={() => { setSendF({ days: 14, message: '' }); setModal('send'); }}>➤ Send the options to the client</Btn></div>
            </Panel>
          ) : null}

          {p.status === 'awaiting_client' ? (
            <Panel title="With the client" sub={`${presented.length} option${presented.length === 1 ? '' : 's'} shown · ${p.views ? `opened ${p.views} time${p.views === 1 ? '' : 's'}${p.viewedAt ? `, last ${fmtDateTime(p.viewedAt)}` : ''}` : 'not opened yet'} · the link works until ${fmtDateTime(p.linkExpiresAt)}`} style={{ marginTop: 14 }}>
              <div className="mki-grid" style={{ marginTop: 0 }}>
                {presented.map((o) => (
                  <div key={o.id} className="card mki-card">
                    <MkImg id={o.itemId} lazy alt={o.label} video={o.item && o.item.kind === 'video'} controls={false} style={{ aspectRatio: String((o.item && o.item.aspect) || '1:1').replace(':', ' / '), objectFit: 'cover', ...(o.item && o.item.kind === 'video' ? { background: '#000' } : {}) }} />
                    <b style={{ fontSize: 11.5, marginTop: 6 }}>{o.label}</b>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                <Btn small disabled={!!busy} onClick={() => act('extend', { days: 14 }, 'Extended')}>Extend 14 days</Btn>
                <Btn small disabled={!!busy} onClick={() => act('cancel', {}, 'Taken back')} title="The link stops showing the options and they come back to you">Take the options back</Btn>
              </div>
            </Panel>
          ) : null}

          {['approved', 'posted'].includes(p.status) ? (
            <Panel title={p.status === 'posted' ? 'Posted' : 'The client chose'} sub={`${p.decidedByName || 'The client'} chose ${chosen ? chosen.label : 'an option'} on ${fmtDateTime(p.decidedAt)}`} style={{ marginTop: 14 }}>
              {chosen ? <div style={{ maxWidth: 320 }}><MkImg id={chosen.itemId} alt={chosen.label} video={chosen.item && chosen.item.kind === 'video'} style={{ aspectRatio: String((chosen.item && chosen.item.aspect) || '1:1').replace(':', ' / '), objectFit: 'contain', background: '#000' }} /></div> : null}
              {p.decisionNote ? <div className="mk-note ok" style={{ marginTop: 10 }}><b>The client's suggestions:</b> {p.decisionNote}</div> : null}
              {p.status === 'posted' ? <div style={{ marginTop: 10, fontSize: 12 }}>Posted {fmtDateTime(p.postedAt)} by {p.postedByName}{p.postUrl ? <> · <a href={p.postUrl} target="_blank" rel="noopener noreferrer">open the post</a></> : null}</div> : null}
            </Panel>
          ) : null}

          {['approved', 'posted'].includes(p.status) ? <div style={{ marginTop: 14 }}><ShowcasePanel key={`${p.id}-${p.showcase}`} p={p} toast={toast} onSaved={() => { onChanged(); load(); }} /></div> : null}

          {p.status === 'approved' ? (
            <Panel title="Ready to post" sub="The client approved it. Post it on their pages, then mark it as posted." style={{ marginTop: 14 }}>
              <Field label="THE POST WORDS" full>
                <textarea style={{ minHeight: 70 }} value={caption} maxLength={3000} onChange={(e) => setCaption(e.target.value)} onBlur={() => { if (caption !== (p.caption || '')) omni.put(`/gs/marketing/projects/${id}`, { caption }).then(() => load()).catch((e) => setErr(errOf(e, 'The caption could not be saved.'))); }} />
              </Field>
              <div style={{ fontSize: 11, margin: '8px 0', color: 'var(--muted)' }}>Post on: {p.platforms.length ? p.platforms.map((k) => (meta.platforms.find((x) => x.key === k) || {}).label || k).join(', ') : 'no page chosen yet (edit the request)'}{p.handles ? ` · ${p.handles.replace(/\n/g, ', ')}` : ''}</div>
              <div style={{ margin: '10px 0 12px' }}>
                <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 6 }}>Send it</div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {SEND.map(([key, label, icon, color]) => {
                    const list = accts.accounts.filter((a) => a.platform === key);
                    const res = (p.autoResult || []).filter((x) => x.platform === key);
                    const ok = res.find((x) => x.ok); const bad = res.filter((x) => !x.ok).slice(-1)[0];
                    const asked = p.platforms.includes(key);
                    return (
                      <div key={key} style={{ width: 168 }}>
                        <button type="button" disabled={!accts.allowed || !list.length || !!ok || !!busy} onClick={() => { setPostFor(key); setPostSel(list.length === 1 ? [list[0].id] : []); setPostErr([]); }}
                          style={{ width: '100%', border: 'none', borderRadius: 10, padding: '10px 12px', fontWeight: 800, fontSize: 12.5, cursor: (!accts.allowed || !list.length || ok) ? 'default' : 'pointer', background: ok ? '#e8f7ef' : color, color: ok ? '#087844' : '#fff', opacity: (!accts.allowed || !list.length) && !ok ? 0.5 : 1, display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center' }}>
                          <span aria-hidden="true" style={{ fontSize: 15 }}>{icon}</span>{ok ? `${label}: posted ✓` : bad ? `Try ${label} again` : `Post to ${label}`}
                        </button>
                        <small style={{ display: 'block', fontSize: 10, marginTop: 4, color: bad && !ok ? '#9b1c1c' : 'var(--muted)', lineHeight: 1.4 }}>
                          {ok ? (ok.url ? <a href={ok.url} target="_blank" rel="noopener noreferrer">Open the post</a> : 'Posted') : bad ? bad.error : !list.length ? `No ${label} account connected` : asked ? 'The client asked for this one' : 'Not asked for by the client'}
                        </small>
                      </div>
                    );
                  })}
                </div>
                {!accts.allowed ? <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>An Admin has to allow posting from TeamLink first: AI Marketing → AI usage → “Posting to client accounts”. Until then, post by hand with the buttons below.</div> : null}
                {accts.allowed && !accts.accounts.length ? <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>No accounts are connected yet. An Admin connects the client's Facebook Page (and its Instagram) or X account in Administration → Integrations → Social Media. The client first makes your Facebook login an admin of their Page.</div> : null}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Btn small onClick={async () => { try { await navigator.clipboard.writeText(caption); toast('Words copied'); } catch { window.prompt('Copy the words:', caption); } }}>⧉ Copy the words</Btn>
                {chosen ? <Btn small onClick={() => downloadMkImg(chosen.itemId, `${p.clientName} ${chosen.label}`).catch((e) => toast(errOf(e, 'It could not be downloaded.')))}>⬇ Download the file</Btn> : null}
                {chosenItem && chosenItem.publicPath ? <Btn small onClick={async () => { const u2 = `${origin()}${chosenItem.publicPath}`; try { await navigator.clipboard.writeText(u2); toast('Link to the file copied'); } catch { window.prompt('Copy the link:', u2); } }}>🔗 Copy the file link</Btn> : null}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 12 }}>
                <Field label="PLAN IT IN THE CONTENT CALENDAR"><input type="date" value={when.date} onChange={(e) => setWhen({ ...when, date: e.target.value })} /></Field>
                <Field label="TIME"><input type="time" value={when.time} onChange={(e) => setWhen({ ...when, time: e.target.value })} /></Field>
                <Btn disabled={!!busy || !p.platforms.length || !caption.trim()} title={!p.platforms.length ? 'Pick the pages in the request first' : !caption.trim() ? 'Write the post words first' : ''} onClick={async () => {
                  setBusy('cal'); setErr('');
                  try {
                    await omni.post('/gs/marketing/calendar', { title: `${p.clientName}: ${p.occasion}`.slice(0, 120), platforms: p.platforms.filter((k) => ['facebook', 'instagram', 'linkedin', 'x', 'whatsapp'].includes(k)), text: caption, date: when.date, time: when.time, mediaUrl: chosenItem && chosenItem.publicPath && /^https:/i.test(origin()) ? `${origin()}${chosenItem.publicPath}` : '', note: `Client project. Post on: ${p.handles || p.clientName}` });
                    await omni.post(`/gs/marketing/projects/${id}/scheduled`, { date: when.date }); toast('Planned in the Content Calendar'); onChanged(); await load();
                  } catch (e) { const m = errOf(e, 'It could not be planned.'); setErr(m); toast(m); } finally { setBusy(''); }
                }}>🗓 Add to the Calendar</Btn>
              </div>
              {p.scheduledFor ? <div style={{ fontSize: 11, marginTop: 6 }}>Planned for {fmtDate(p.scheduledFor)} <button type="button" className="link-btn" onClick={() => go('mkcalendar')}>Open the Calendar</button></div> : null}
              <div style={{ marginTop: 12 }}><Btn primary disabled={!!busy} onClick={() => { setPostUrl(''); setModal('posted'); }}>✓ Mark as posted</Btn></div>
              <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 8 }}>TeamLink does not publish for you yet: it needs the Facebook, Instagram and LinkedIn apps to be approved. Post by hand, then mark it posted.</div>
            </Panel>
          ) : null}
        </div>

        <div>
          {!['declined'].includes(p.status) ? (
            <Panel title="The client's page" sub={p.status === 'invited' ? 'Send this so the client can write the request.' : p.status === 'awaiting_client' ? 'Send this so the client can choose.' : 'The client follows progress here. Same link all the way.'}>
              {share(p.status === 'invited' ? `Hello${p.contactName ? ` ${p.contactName}` : ''}, please tell us what you need and add your logo here:` : p.status === 'awaiting_client' ? `Hello${p.contactName ? ` ${p.contactName}` : ''}, please look at the options for "${p.occasion || p.title}", pick the one you like and tell us any suggestions:` : `Hello${p.contactName ? ` ${p.contactName}` : ''}, you can follow "${p.occasion || p.title}" here:`, p.status === 'awaiting_client' ? `Please choose: ${p.occasion || p.title}` : `Your request: ${p.occasion || p.title}`)}
            </Panel>
          ) : null}
          {d.made.length > 0 ? (
            <Panel title="Made for this project" sub="Pictures and videos made with this project's logo and colours." style={{ marginTop: 14 }}>
              <div className="mki-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', marginTop: 0 }}>
                {d.made.slice(0, 12).map((m) => <div key={m.id}><MkImg id={m.id} lazy alt={m.title} video={m.kind === 'video'} controls={false} style={{ aspectRatio: String(m.aspect).replace(':', ' / '), objectFit: 'cover', ...(m.kind === 'video' ? { background: '#000' } : {}) }} /><small style={{ fontSize: 9.5, color: 'var(--muted)' }}>{m.title} · {m.status}</small></div>)}
              </div>
            </Panel>
          ) : null}
          <Panel title="What happened" style={{ marginTop: 14 }}>
            <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[...d.events].reverse().map((e) => (
                <li key={e.id} style={{ display: 'flex', gap: 10, fontSize: 11.5, lineHeight: 1.5 }}>
                  <span aria-hidden="true" style={{ flex: 'none', width: 22, height: 22, borderRadius: 11, background: '#e8f7ef', color: '#087844', display: 'grid', placeItems: 'center', fontSize: 11 }}>{KIND_ICON[e.kind] || '•'}</span>
                  <div style={{ minWidth: 0 }}><div style={{ overflowWrap: 'anywhere' }}>{e.text}</div><small style={{ display: 'block', fontSize: 10, color: 'var(--muted)' }}>{e.byName ? `${e.byName} · ` : ''}{fmtDateTime(e.at)}</small></div>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
      </div>

      {postFor ? (() => {
        const info = SEND.find((s) => s[0] === postFor); const list = accts.accounts.filter((a) => a.platform === postFor);
        return (
          <GsModal title={`Post to ${info[1]}?`} sub="This goes public on the client's account as soon as you press the button." width={520} onClose={() => setPostFor('')}
            foot={<><Btn onClick={() => setPostFor('')}>Cancel</Btn><Btn primary disabled={!!busy || !postSel.length} onClick={async () => {
              setBusy('post'); setPostErr([]);
              try {
                const r = await omni.post(`/gs/marketing/projects/${id}/post`, { platform: postFor, accountIds: postSel, confirm: true });
                if (r.results && r.results.some((x) => !x.ok)) { setPostErr(r.results.filter((x) => !x.ok)); } else { toast(r.ok || 'Posted'); setPostFor(''); }
                onChanged(); await load();
              } catch (e) { const m = errOf(e, 'It could not be posted.'); setPostErr([{ name: info[1], error: m }]); } finally { setBusy(''); }
            }}>{busy === 'post' ? 'Posting…' : `Post to ${info[1]} now`}</Btn></>}>
            {postErr.length ? <Banner tone="error">{postErr.map((x) => <div key={x.name}><b>{x.name}:</b> {x.error}</div>)}</Banner> : null}
            {chosen ? <div style={{ maxWidth: 180, marginBottom: 10 }}><MkImg id={chosen.itemId} alt={chosen.label} video={chosen.item && chosen.item.kind === 'video'} controls={false} style={{ aspectRatio: String((chosen.item && chosen.item.aspect) || '1:1').replace(':', ' / '), objectFit: 'contain', background: '#000' }} /></div> : null}
            <div style={{ fontSize: 12, whiteSpace: 'pre-wrap', background: '#f4f6f5', borderRadius: 8, padding: '8px 10px', marginBottom: 10 }}>{caption || 'No words: only the picture or video is posted.'}</div>
            {postFor === 'x' && caption.length > 280 ? <Banner tone="warn">The words are {caption.length} characters; X allows 280. Shorten them first.</Banner> : null}
            <div style={{ fontSize: 11, fontWeight: 800, marginBottom: 4 }}>POST ON</div>
            {list.map((a) => (
              <label key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, padding: '4px 0' }}>
                <input type="checkbox" checked={postSel.includes(a.id)} disabled={a.status === 'Expired'} onChange={() => setPostSel((s) => (s.includes(a.id) ? s.filter((x) => x !== a.id) : [...s, a.id]))} />
                <span><b>{a.name}</b>{a.parentName ? ` · ${a.parentName}` : ''}{a.status !== 'Connected' ? ` · ${a.status}` : ''}</span>
              </label>
            ))}
          </GsModal>
        );
      })() : null}
      {modal === 'edit' ? <RequestModal meta={meta} project={p} onClose={() => setModal('')} onDone={() => { setModal(''); onChanged(); load(); }} toast={toast} /> : null}
      {modal === 'pick' ? <PickModal project={p} taken={staged.map((s) => s.itemId)} onClose={() => setModal('')} onPick={async (ids) => { setModal(''); await saveStaged([...staged, ...ids.map((itemId) => ({ itemId, label: '' }))].map((s, i) => ({ ...s, label: s.label || `Option ${String.fromCharCode(65 + i)}` }))); }} /> : null}
      {modal === 'send' ? (
        <GsModal title="Send the options to the client" sub={`${staged.length} option${staged.length === 1 ? '' : 's'}. They go on the client's private page; the client picks one and can add suggestions.`} width={520} onClose={() => setModal('')} foot={<><Btn onClick={() => setModal('')}>Cancel</Btn><Btn primary disabled={!!busy} onClick={async () => { const r = await act('send', { days: sendF.days, message: sendF.message, caption }, 'Sent'); if (r) setModal(''); }}>{busy === 'send' ? 'Sending…' : 'Show them to the client'}</Btn></>}>
          <div className="form-grid">
            <Field label="A MESSAGE FOR THE CLIENT (OPTIONAL)" full><textarea style={{ minHeight: 70 }} value={sendF.message} maxLength={500} onChange={(e) => setSendF({ ...sendF, message: e.target.value })} placeholder="For example: Here are three festive options. Tell us which one you like." /></Field>
            <Field label="THE LINK WORKS FOR"><select value={sendF.days} onChange={(e) => setSendF({ ...sendF, days: Number(e.target.value) })}>{[3, 7, 14, 30].map((n) => <option key={n} value={n}>{n} days</option>)}</select></Field>
          </div>
        </GsModal>
      ) : null}
      {modal === 'decline' ? (
        <GsModal title="Decline this request" sub="The client sees your reason on their page." width={480} onClose={() => setModal('')} foot={<><Btn onClick={() => setModal('')}>Cancel</Btn><Btn danger disabled={reason.trim().length < 5 || !!busy} onClick={async () => { const r = await act('decline', { note: reason }, 'Declined'); if (r) setModal(''); }}>Decline</Btn></>}>
          <textarea autoFocus style={{ width: '100%', minHeight: 90, border: '1px solid var(--line)', borderRadius: 10, padding: 11, font: 'inherit', fontSize: 12.5 }} value={reason} maxLength={400} onChange={(e) => setReason(e.target.value)} placeholder="For example: We cannot take this one before the festival. We can do it next month." />
        </GsModal>
      ) : null}
      {modal === 'posted' ? (
        <GsModal title="Mark as posted" sub="The client sees on their page that it is live." width={480} onClose={() => setModal('')} foot={<><Btn onClick={() => setModal('')}>Cancel</Btn><Btn primary disabled={!!busy} onClick={async () => { const r = await act('posted', { postUrl }, 'Posted'); if (r) setModal(''); }}>Mark as posted</Btn></>}>
          <Field label="LINK TO THE POST (OPTIONAL)" full><input value={postUrl} maxLength={500} onChange={(e) => setPostUrl(e.target.value)} placeholder="https://www.instagram.com/p/…" /></Field>
        </GsModal>
      ) : null}
    </div>
  );
}

export default function MkProjectsPage() {
  const { toast } = useOmni();
  const [meta, setMeta] = useState(null);
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(() => { try { return new URLSearchParams(window.location.search).get('open') || ''; } catch { return ''; } });
  const [modal, setModal] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(() => omni.get('/gs/marketing/projects', { status: tab, q }).then((d) => { setData(d); setErr(''); }).catch((e) => setErr(errOf(e, 'The projects could not be read.'))), [tab, q]);
  useEffect(() => { omni.get('/gs/marketing/projects/meta').then(setMeta).catch((e) => setErr(errOf(e, 'Client projects could not be opened.'))); }, []);
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [load, q]);
  if (err && !data) return <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={load}>Try again</button></Banner>;
  if (!meta || !data) return <div className="card panel">Loading…</div>;
  if (sel) return <Detail id={sel} meta={meta} onBack={() => { setSel(''); load(); }} onChanged={load} />;
  const counts = data.counts || {};
  const label = (arr, k) => (arr.find((x) => x.key === k) || {}).label || '';
  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="Client projects" lead="A client asks for a creative. Accept it, make options with AI, show them on one private link, and the client picks one and adds suggestions. Then post it on their pages.">
        <Btn onClick={async () => { const u2 = `${origin()}/our-work`; try { await navigator.clipboard.writeText(u2); toast('Link to “Our work” copied: send it to a new client'); } catch { window.prompt('Copy the link:', u2); } }} title="A public page with our finished projects and how fast and accurate we are">🌐 Copy the “Our work” link</Btn>
        <Btn onClick={() => setModal('invite')}>🔗 Invite a client to request</Btn>
        <Btn primary onClick={() => setModal('new')}>＋ Log a request</Btn>
      </PageHead>
      {err ? <Banner tone="error">{err}</Banner> : null}
      {(counts.request || 0) > 0 ? <Banner tone="info"><b>{counts.request} new request{counts.request === 1 ? '' : 's'}</b> waiting for you to accept or decline.</Banner> : null}
      <Panel title="Projects" right={<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search client or occasion" aria-label="Search projects" style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '6px 9px', font: 'inherit', fontSize: 11.5, minWidth: 190 }} />}>
        <Tabs value={tab} onChange={setTab} tabs={TABS.map(([k, l]) => [k, l, k ? (counts[k] || 0) : (counts.all || 0)])} />
        {data.projects.length === 0 ? (
          <Empty title={q || tab ? 'No projects here' : 'No client projects yet'} action={!q && !tab ? <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}><Btn primary onClick={() => setModal('new')}>＋ Log a request</Btn><Btn onClick={() => setModal('invite')}>🔗 Invite a client</Btn></div> : null}>
            {q || tab ? 'Nothing matches. Clear the search or pick another tab.' : 'When a client asks for a festive video or a post by email, WhatsApp or phone, log it here. Or send the client a request link so they write it themselves.'}
          </Empty>
        ) : data.projects.map((p) => (
          <div className="mk-row" key={p.id}>
            <div>
              <b>{p.title}</b> {statusPill(p.status)}{p.status === 'awaiting_client' && p.linkExpired ? <> <Pill tone="red">Link expired</Pill></> : null} <Tag>{label(meta.sources, p.source) || 'Other'}</Tag>
              <small>{p.clientName}{p.contactName ? ` · ${p.contactName}` : ''} · {label(meta.deliverables, p.deliverable)}{p.platforms.length ? ` · ${p.platforms.map((k) => label(meta.platforms, k) || k).join(', ')}` : ''}{p.dueDate ? ` · needed by ${fmtDate(p.dueDate)}` : ''}{p.ownerName ? ` · owner ${p.ownerName}` : ''}</small>
              {p.status === 'approved' ? <small style={{ color: '#087844' }}>Approved by {p.decidedByName} · ready to post</small> : null}
              {p.status === 'awaiting_client' ? <small>{p.views ? `Opened ${p.views}×` : 'Not opened yet'} · link works until {fmtDateTime(p.linkExpiresAt)}</small> : null}
            </div>
            <div className="mk-acts"><Btn small primary={p.status === 'request' || p.status === 'approved'} onClick={() => setSel(p.id)}>{p.status === 'request' ? 'Review' : 'Open'}</Btn></div>
          </div>
        ))}
      </Panel>
      {modal === 'new' ? <RequestModal meta={meta} onClose={() => setModal('')} onDone={(pr) => { setModal(''); load(); if (pr) setSel(pr.id); }} toast={toast} /> : null}
      {modal === 'invite' ? <InviteModal onClose={() => setModal('')} onDone={load} toast={toast} /> : null}
    </div>
  );
}
// eslint-disable-next-line no-unused-vars
const _unused = ConfirmModal;
