import { useEffect, useMemo, useRef, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import Combo from '../../Combo.jsx';
import { Btn, Pill, Planned, fmtDate } from '../ui.jsx';
import PhonePreview, { BTN_ICON } from './PhonePreview.jsx';
import MediaLibraryModal, { uploadToLibrary } from './MediaLibraryModal.jsx';
import { check, mapping, slug, VARS, VAR_WORDS, SAMPLE, LIMITS } from './policy.js';
import { LANGS, Toggle, useDebounced, PromptModal, fmtSize, AccountChips } from './tplCommon.jsx';

// The create / view / edit form of a WhatsApp, SMS or Email template (and a saved voice script), with the prototype's layout: Template Configuration on the left,
// Live Preview + the check + the WhatsApp approval card on the right. Saved through the template hub (server: /gs/templates/outreach).
const ACTIONS = [
  { key: 'reply', label: 'Custom Reply', ico: '💬', limit: 5, def: '' },
  { key: 'url', label: 'Visit Website', ico: '🌐', limit: 2, def: '' },
  { key: 'phone', label: 'Call phone number', ico: '📞', limit: 1, def: '' },
  { key: 'whatsapp', label: 'Call on WhatsApp', ico: '📱', limit: 1, def: '' },
  { key: 'code', label: 'Copy Offer Code', ico: '🏷', limit: 1, def: '' },
  { key: 'flow', label: 'Complete flow', ico: '📋', limit: 1, def: 'Start Survey' },
  { key: 'order', label: 'Order Details', ico: '🧾', limit: 1, def: '' },
];
const DIAL = [['IN', '+91'], ['US', '+1'], ['GB', '+44'], ['AE', '+971'], ['SG', '+65'], ['AU', '+61'], ['DE', '+49']];
const HEADERS = { whatsapp: [['none', 'None'], ['text', 'Text'], ['image', 'Image'], ['video', 'Video'], ['document', 'Document'], ['location', 'Location']], email: [['none', 'None'], ['image', 'Banner Image']], sms: [] };
const MEDIA_KINDS = { image: ['image'], video: ['video'], document: ['document'] };
const MEDIA_SPEC = { image: 'JPG or PNG (max 5 MB)', video: 'A video link (MP4 or a YouTube link)', document: 'PDF (max 5 MB)' };
const APPROVALS = [['draft', 'Not sent to Meta'], ['pending', 'In review'], ['approved', 'Approved'], ['rejected', 'Rejected']];
let bid = 1;
const withIds = (bs) => (bs || []).map((b) => ({ ...b, id: b.id || `b${bid++}` }));
const cleanButtons = (bs) => (bs || []).map(({ id, ...b }) => b); // eslint-disable-line no-unused-vars

export function formFromItem(item, ch, acc) {
  const ex = (item && item.extra) || {};
  const job = !acc || acc.kind !== 'hr';
  return {
    channel: ch, name: item ? item.name : '', category: item ? (item.category || 'Utility') : (ch === 'sms' || job ? 'Marketing' : 'Utility'), language: (item && (item.waLanguage || item.language)) || 'en_US',
    subject: item ? item.subject || '' : '', body: item ? item.body || '' : '', headerType: ex.headerType || 'none', headerText: ex.headerText || '', headerMedia: ex.headerMedia || null,
    location: ex.location || { name: '', address: '', lat: '', lng: '' }, footer: ex.footer || '', callPermission: !!ex.callPermission, buttons: withIds(ex.buttons), prevLayout: null,
    dltTemplateId: item ? item.dltTemplateId || '' : '', senderId: item ? item.senderId || '' : '', approval: item && item.wa ? ({ None: 'draft', Pending: 'pending', Approved: 'approved', Rejected: 'rejected' })[item.wa.status] || 'draft' : 'draft',
  };
}
const layoutOf = (f) => ({ headerType: f.headerType, headerText: f.headerText, headerMedia: f.headerMedia, location: f.location, footer: f.footer, callPermission: f.callPermission, buttons: cleanButtons(f.buttons) });
const policyIn = (f) => ({ name: f.name, category: f.category, body: f.body, headerType: f.headerType, headerText: f.headerText, headerHasMedia: !!(f.headerMedia && (f.headerMedia.libraryId || f.headerMedia.url)), locationName: f.location && f.location.name, footer: f.footer, buttons: f.buttons, callPermission: f.callPermission });

// ---- the Meta policy check panel (.mp-*) ------------------------------------------------------------------
function PolicyPanel({ pol, touched, reveal, f }) {
  const vis = pol.issues.filter((v) => reveal || touched[v.field]);
  const vErr = vis.filter((v) => v.severity === 'error'); const vWarn = vis.filter((v) => v.severity === 'warn');
  const blocking = pol.errors; const started = reveal || Object.keys(touched).length > 0;
  let tone; let head; let sub;
  if (!started) { tone = 'idle'; head = 'Not checked yet'; sub = 'Start filling in the template. Each box is checked against WhatsApp\'s rules as you go.'; } else if (vErr.length) { tone = 'fail'; head = 'Will be refused by Meta'; sub = `${vErr.length} blocking issue${vErr.length === 1 ? '' : 's'} to fix${blocking > vErr.length ? ` · ${blocking - vErr.length} more in boxes you have not filled in yet` : ''}.`; } else if (blocking) { tone = 'idle'; head = 'Still to complete'; sub = `Nothing wrong so far. ${blocking} required box${blocking === 1 ? '' : 'es'} left to fill in.`; } else if (vWarn.length) { tone = 'warn'; head = 'Can be sent, with advice'; sub = `${vWarn.length} piece${vWarn.length === 1 ? '' : 's'} of advice. You can still send it.`; } else { tone = 'pass'; head = 'Meets the rules'; sub = 'No issues found. Ready to send to Meta.'; }
  return (
    <div className={`mp-card mp-${tone}`}>
      <div className="mp-head"><span className={`mp-badge mp-${tone}`}>{{ idle: '○', pass: '✓', warn: '!', fail: '✕' }[tone]}</span><div><b>{head}</b><small>{sub}</small></div></div>
      {vis.length ? <ul className="mp-list">{vis.map((v, i) => <li key={i} className={`mp-item mp-${v.severity}`}><span className="mp-code">{v.code}</span><div><b>{v.rule}</b><span>{v.message}</span><em>{v.severity === 'info' ? '' : 'Fix: '}{v.fix}</em></div></li>)}</ul>
        : (started && !blocking ? <div className="mp-ok">Name, variables, length limits, category and content rules all pass.</div> : null)}
      <div className="mp-meter"><span>Body {f.body.length}/{LIMITS.body}</span><span>Footer {f.footer.length}/{LIMITS.footer}</span><span>Buttons {f.buttons.length}/{LIMITS.buttons}</span></div>
    </div>
  );
}
function PlainCheck({ chk, f }) {
  const probs = (chk && chk.problems) || [];
  const empty = !f.name && !f.body;
  const tone = empty ? 'idle' : (probs.length ? 'fail' : 'pass');
  return (
    <div className={`mp-card mp-${tone}`}>
      <div className="mp-head"><span className={`mp-badge mp-${tone}`}>{{ idle: '○', pass: '✓', fail: '✕' }[tone]}</span><div><b>{empty ? 'Not checked yet' : (probs.length ? 'Fix these to save' : 'Looks good')}</b><small>{empty ? 'Start writing; the rules are checked as you go.' : (probs.length ? `${probs.length} thing${probs.length === 1 ? '' : 's'} to fix.` : (chk && chk.ready ? 'Ready to use in a campaign.' : (chk && chk.why) || 'Saved templates can be used in campaigns.'))}</small></div></div>
      {probs.length ? <ul className="mp-list">{probs.map((p, i) => <li key={i} className="mp-item mp-error"><span className="mp-code">RULE</span><div><span>{p}</span></div></li>)}</ul> : null}
      {chk && chk.ready === false && chk.why && !probs.length && !empty ? <div className="mp-gate" style={{ marginTop: 8 }}>{chk.why}</div> : null}
    </div>
  );
}

export default function TemplateForm({ ch, account, item, mode, meta, flows, onBack, onSaved, onMode, onReview, onFlowsChanged }) {
  const { toast, dept } = useOmni();
  const isNew = !item;
  const ro = mode === 'view';
  const canEditThis = isNew ? true : !!item.canEdit;
  const isOutreach = isNew || item.source === 'outreach';
  const [f, setF] = useState(() => formFromItem(item, ch, { kind: meta && meta.staffOnly ? 'hr' : '' }));
  const [snap, setSnap] = useState(() => JSON.stringify(formFromItem(item, ch, { kind: meta && meta.staffOnly ? 'hr' : '' })));
  const [touched, setTouched] = useState({});
  const [reveal, setReveal] = useState(false);
  const [chk, setChk] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [lib, setLib] = useState(null); // 'image' | 'video' | 'document' while the Library window is open
  const [menu, setMenu] = useState(false);
  const [prompt, setPrompt] = useState(null); // { kind: 'newflow', btn }
  const [drag, setDrag] = useState(null);
  const bodyRef = useRef(null);
  const [meterr, setMeterr] = useState('');
  const set = (patch, field) => { setF((o) => ({ ...o, ...patch })); if (field) setTouched((t) => ({ ...t, [field]: true })); setErr(''); };

  // the instant policy answer (WhatsApp) and the server's plain-words check (everything), the second a moment after typing stops
  const pol = useMemo(() => check(policyIn(f)), [f]);
  const dbk = useDebounced(JSON.stringify({ n: f.name, c: f.channel, cat: f.category, s: f.subject, b: f.body, d: f.dltTemplateId, si: f.senderId, l: layoutOf(f), lang: f.language }), 400);
  useEffect(() => {
    if (!isOutreach || ro) return undefined;
    let live = true;
    omni.post('/gs/templates/check', { name: f.name, channel: f.channel, category: f.category, subject: f.subject, body: f.body, dltTemplateId: f.dltTemplateId, senderId: f.senderId, promotional: f.category === 'Marketing', waLanguage: f.language, extra: layoutOf(f) })
      .then((r) => { if (live) setChk(r); }).catch(() => {});
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbk, ro]);

  const map = useMemo(() => mapping(f.body), [f.body]);
  const insertVar = (v) => {
    const el = bodyRef.current; const tag = `{{${v}}}`;
    if (!el) { set({ body: `${f.body}${tag}` }, 'body'); return; }
    const a = el.selectionStart == null ? f.body.length : el.selectionStart; const b = el.selectionEnd == null ? a : el.selectionEnd;
    set({ body: `${f.body.slice(0, a)}${tag}${f.body.slice(b)}` }, 'body');
    setTimeout(() => { el.focus(); el.setSelectionRange(a + tag.length, a + tag.length); }, 0);
  };

  // ---- header ----
  const headerOptions = HEADERS[f.channel] || [];
  const setHeader = (t) => set({ headerType: t, headerMedia: ['image', 'video', 'document'].includes(t) ? f.headerMedia : null, headerText: t === 'text' ? f.headerText : '' }, 'header');
  const pickFile = async (files) => {
    const file = files && files[0]; if (!file) return;
    const okType = { image: /^image\/(png|jpeg|webp)$/, document: /^application\/pdf$/ }[f.headerType];
    if (okType && !okType.test(file.type)) { setMeterr(`"${file.name}" is ${file.type || 'an unknown type'}. This header accepts ${MEDIA_SPEC[f.headerType]}.`); return; }
    if (!okType) { setMeterr('A video is added as a link: use "Choose from the Library" and save the video link there.'); return; }
    try { setMeterr(''); const it = await uploadToLibrary(file, { department: dept || '' }); set({ headerMedia: { libraryId: it.id, name: it.name, url: it.url } }, 'header'); toast(`${file.name} attached`); } catch (e) { setMeterr(errOf(e, e.message || 'The file could not be saved.')); }
  };

  // ---- call permission ----
  const toggleCall = () => {
    if (ro) return;
    if (!f.callPermission) set({ callPermission: true, prevLayout: { category: f.category, headerType: f.headerType, buttons: f.buttons, headerMedia: f.headerMedia }, category: 'Marketing', headerType: 'text', headerMedia: null, buttons: [] }, 'category');
    else { const p = f.prevLayout || {}; set({ callPermission: false, category: p.category || f.category, headerType: p.headerType || 'none', buttons: p.buttons || [], headerMedia: p.headerMedia || null, prevLayout: null }, 'category'); }
  };

  // ---- buttons ----
  const count = (k) => f.buttons.filter((b) => b.type === k).length;
  const addAction = (k) => {
    const t = ACTIONS.find((a) => a.key === k);
    if (f.buttons.length >= LIMITS.buttons) { toast(`Maximum ${LIMITS.buttons} buttons reached`); return; }
    if (count(k) >= t.limit) { toast(`${t.label} is limited to ${t.limit}`); return; }
    set({ buttons: [...f.buttons, { id: `b${bid++}`, type: k, label: t.def, url: '', phone: '', country: '+91', code: '', flow: '' }] }, 'buttons'); setMenu(false);
  };
  const updBtn = (id, patch) => set({ buttons: f.buttons.map((b) => (b.id === id ? { ...b, ...patch } : b)) }, 'buttons');
  const delBtn = (id) => set({ buttons: f.buttons.filter((b) => b.id !== id) }, 'buttons');
  const dropOn = (id) => { if (!drag || drag === id) { setDrag(null); return; } const list = [...f.buttons]; const from = list.findIndex((b) => b.id === drag); const to = list.findIndex((b) => b.id === id); const [m] = list.splice(from, 1); list.splice(to, 0, m); set({ buttons: list }, 'buttons'); setDrag(null); };
  const newFlow = async (name) => {
    try { const r = await omni.post('/gs/templates/flows', { name }); toast(`"${r.flow.name}" created`); updBtn(prompt.btn, { flow: r.flow.name }); setPrompt(null); if (onFlowsChanged) onFlowsChanged(); } catch (e) { toast(errOf(e, 'The flow could not be made.')); }
  };

  // ---- save ----
  const blockers = chk ? chk.problems || [] : [];
  const payload = () => ({
    name: f.name, channel: f.channel, subject: f.channel === 'email' ? f.subject : '', body: f.body, category: f.category, promotional: f.category === 'Marketing', waLanguage: f.language,
    dltTemplateId: f.channel === 'sms' ? f.dltTemplateId : '', senderId: f.channel === 'sms' ? f.senderId : '', extra: layoutOf(f),
    ...(meta && meta.isAdmin && f.channel === 'whatsapp' ? { waApprovalStatus: f.approval } : {}),
  });
  const save = async () => {
    setReveal(true);
    if (blockers.length) { setErr(blockers[0]); return; }
    setBusy(true); setErr('');
    try {
      if (!isOutreach) {
        await omni.put(`/gs/templates/other/${encodeURIComponent(item.key)}`, { name: f.name, subject: f.subject, body: f.body });
        toast(`Changes saved to "${f.name}"`); onSaved(item.key); return;
      }
      if (isNew) { const r = await omni.post('/gs/templates/outreach', payload()); toast(`"${f.name}" saved`); onSaved(r.template && r.template.id); } else {
        const r = await omni.put(`/gs/templates/outreach/${item.id}`, payload());
        toast(r.resubmit ? `Saved. WhatsApp must approve "${f.name}" again, so it is back to "Not sent to Meta".` : `Changes saved to "${f.name}"`); onSaved(item.id);
      }
    } catch (e) { setErr(errOf(e, 'It could not be saved.')); const p = e.response && e.response.data && e.response.data.problems; if (p && p.length) setErr(p[0]); } finally { setBusy(false); }
  };
  const cancel = () => { setF(JSON.parse(snap)); setReveal(false); setTouched({}); setErr(''); onMode('view'); toast('Changes discarded'); };
  const startEdit = () => { setSnap(JSON.stringify(f)); onMode('edit'); };

  // ---- Meta ----
  const [metaBusy, setMetaBusy] = useState(false); const [metaMsg, setMetaMsg] = useState('');
  const metaCall = async (what) => {
    setMetaBusy(true); setMetaMsg('');
    try { const r = await omni.post(`/gs/templates/outreach/${item.id}/${what}`); toast(what === 'submit' ? 'Sent to Meta for review' : 'Status copied from Meta'); onSaved(item.id, true); return r; } catch (e) { setMetaMsg(errOf(e, 'Meta could not be reached.')); return null; } finally { setMetaBusy(false); }
  };
  // the SAME template for every number: one answer per WhatsApp account (server: outreach/tplWaba.js)
  const [waAcc, setWaAcc] = useState(null);
  const itemId = item && item.id;
  const loadAcct = () => { if (f.channel === 'whatsapp' && itemId && isOutreach) omni.get(`/gs/templates/outreach/${itemId}/accounts`).then(setWaAcc).catch(() => setWaAcc(null)); };
  useEffect(() => { loadAcct(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [itemId, item && item.statusWord, item && item.updatedAt]);
  const acctCall = async (what) => {
    setMetaBusy(true); setMetaMsg('');
    try {
      const r = await omni.post(`/gs/templates/outreach/${itemId}/${what}`);
      const bad = (r.results || []).filter((x) => x.action === 'failed');
      toast(bad.length ? `Done, but ${bad.length} account${bad.length === 1 ? '' : 's'} did not answer: ${bad[0].error}` : (what === 'submit-all' ? "Sent to Meta for every number's WhatsApp account" : 'Status copied from Meta for every account'));
      if (bad.length) setMetaMsg(bad.map((x) => `${(x.numbers || []).join(', ')}: ${x.error}`).join(' | '));
      loadAcct(); onSaved(itemId, true);
    } catch (e) { setMetaMsg(errOf(e, 'Meta could not be reached.')); } finally { setMetaBusy(false); }
  };
  const setApproval = async (v) => {
    try { await omni.put(`/gs/templates/outreach/${item.id}`, { waApprovalStatus: v }); toast('Approval status saved'); onSaved(item.id, true); } catch (e) { setMetaMsg(errOf(e, 'It could not be saved.')); }
  };

  const wa = f.channel === 'whatsapp';
  const hdrOpts = headerOptions;
  const used = f.buttons.length;
  const label = { whatsapp: 'WHATSAPP', sms: 'SMS', email: 'EMAIL' }[f.channel] || '';
  const acct = account ? account.name : '';
  const status = item && item.statusWord ? item : null;
  const segs = Math.max(1, Math.ceil(f.body.length / 160));
  const waNow = meta && meta.whatsapp ? meta.whatsapp : {};

  const head = !isNew ? (
    <div className="tpl-edit-head">
      <div className="tpl-edit-id">
        <button type="button" className="tpl-edit-back" onClick={onBack} aria-label="Back to templates">←</button>
        <div>
          <div className="tpl-edit-name"><span style={{ overflowWrap: 'anywhere' }}>{f.name || item.name}</span>{status ? <Pill tone={status.statusTone}>{String(status.statusWord).toUpperCase()}</Pill> : null}</div>
          <div className="tpl-edit-sub">Channel: <span className="pill live">{{ whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email' }[f.channel]}</span> · {acct}{item.sourceWord && item.source !== 'outreach' ? ` · ${item.sourceWord}` : ''}</div>
        </div>
      </div>
      <div className="tpl-edit-acts">
        {ro ? (canEditThis ? <Btn className="tpl-editbtn" onClick={startEdit}>✎ Edit Template</Btn> : <span style={{ fontSize: 10, color: 'var(--muted)', maxWidth: 260 }}>{item.readOnlyWhy || 'You can look at this template but not change it.'}</span>)
          : <><Btn onClick={cancel}>✕ Cancel</Btn><Btn className="tpl-save" disabled={busy} onClick={save}>💾 Save Changes</Btn></>}
      </div>
    </div>
  ) : (
    <>
      <button type="button" className="ca-back" onClick={onBack}>← Back</button>
      <h2 style={{ margin: '2px 0 3px', fontSize: 19 }}>Create {{ whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email' }[f.channel]} Template</h2>
      <p style={{ fontSize: 10, color: 'var(--muted)', margin: '0 0 16px' }}>Creating for: <span className="pill live" style={{ marginLeft: 2 }}>{acct}</span></p>
    </>
  );

  return (
    <div>
      {head}
      <div className="tpl-two">
        <div className={`tpl-config${ro ? ' tpl-readonly' : ''}`}>
          <b style={{ fontSize: 13 }}>Template Configuration</b>
          <p style={{ fontSize: 10, color: 'var(--muted)', margin: '3px 0 0' }}>{ro ? 'View the details of this template.' : (isNew ? 'Define the content, variables, and settings for your template.' : 'Modify the details below to update your template.')}</p>
          <fieldset disabled={ro} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <div className="tpl-form-grid">
              <div className="full"><label>{label ? `${label} ` : ''}TEMPLATE NAME</label><input value={f.name} placeholder="welcome_alert_v1 (a name for your team)" onChange={(e) => set({ name: e.target.value }, 'name')} />
                {wa ? <div className="tpl-hint">{f.name && !/^[a-z0-9_]+$/.test(f.name) ? `Sent to Meta as "${slug(f.name)}". ` : ''}Meta keeps lowercase letters, numbers and underscores only; we change it for you.</div> : null}</div>
              <div><label>CATEGORY</label>
                <select disabled={f.callPermission} value={f.category} onChange={(e) => set({ category: e.target.value }, 'category')} style={f.callPermission ? { background: 'var(--surface-2)', color: 'var(--muted)' } : undefined}>{['Utility', 'Marketing', 'Authentication'].map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}</select>
                {f.callPermission ? <div className="tpl-hint" style={{ color: '#946012' }}>Category is locked to MARKETING for call permission templates.</div> : <div className="tpl-hint">Marketing = promotes something (needs a way to stop). Utility = an update about something they did.</div>}</div>
              <div><label>LANGUAGE</label><select value={f.language} onChange={(e) => set({ language: e.target.value }, 'language')}>{LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>

              {f.channel === 'email' ? <div className="full"><label>SUBJECT</label><input value={f.subject} placeholder="A new job for you, {{name}}" onChange={(e) => set({ subject: e.target.value }, 'subject')} /><div className="tpl-hint">Required: an email needs a subject.</div></div> : null}

              {hdrOpts.length && isOutreach ? (f.callPermission ? (
                <div className="full"><label>HEADER · Optional</label><input placeholder="e.g. Important Update" value={f.headerText} onChange={(e) => set({ headerText: e.target.value, headerType: 'text' }, 'header')} /></div>
              ) : (
                <>
                  <div className="full"><label>HEADER · Optional</label><select value={f.headerType} onChange={(e) => setHeader(e.target.value)}>{hdrOpts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
                  {f.headerType === 'text' ? <div className="full"><label>HEADER TEXT</label><input maxLength={60} placeholder="e.g. Special Offer" value={f.headerText} onChange={(e) => set({ headerText: e.target.value }, 'header')} /><div className="tpl-hint">{f.headerText.length}/60 characters. One variable allowed.</div></div> : null}
                  {f.headerType === 'location' ? (
                    <div className="full"><div className="th-loc">
                      {[['name', 'LOCATION NAME', 'City Care Hospital'], ['address', 'ADDRESS', 'Banjara Hills, Hyderabad'], ['lat', 'LATITUDE', '17.4126'], ['lng', 'LONGITUDE', '78.4392']].map(([k, l, ph]) => <div key={k}><label>{l}</label><input placeholder={ph} value={f.location[k] || ''} onChange={(e) => set({ location: { ...f.location, [k]: e.target.value } }, 'header')} /></div>)}
                      <div className="full th-note">WhatsApp shows this pin as the message header.</div></div></div>
                  ) : null}
                  {['image', 'video', 'document'].includes(f.headerType) ? (
                    <div className="full">
                      {!ro ? (
                        <div className="th-drop" tabIndex={0} role="button" onClick={() => setLib(f.headerType)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setLib(f.headerType); } }}
                          onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('drag'); }} onDragLeave={(e) => e.currentTarget.classList.remove('drag')} onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove('drag'); pickFile(e.dataTransfer.files); }}>
                          <div className="th-drop-ico">🖼</div><div className="th-drop-main">Click to choose from the Library, or drag a file here</div><div className="th-drop-sub">{MEDIA_SPEC[f.headerType]}</div>
                        </div>
                      ) : null}
                                      {f.headerMedia ? (
                        <div className="th-file"><span className="th-thumb">{f.headerType === 'image' && f.headerMedia.url ? <img src={f.headerMedia.url} alt="" /> : (f.headerType === 'video' ? '▶' : '📄')}</span><span className="th-file-meta"><b>{f.headerMedia.name}</b><span>Kept in the Library</span></span>{!ro ? <button type="button" className="th-file-x" title="Remove file" onClick={() => set({ headerMedia: null }, 'header')}>✕</button> : null}</div>
                      ) : null}
                      {meterr ? <div className="th-err">{meterr}</div> : null}
                      {wa ? <div className="th-note">Sending a picture, video or document header to Meta from this screen is not built yet: save it here and add it in Meta Business Manager, or use a text header.</div> : null}
                    </div>
                  ) : null}
                </>
              )) : null}

              <div className="full"><label>MESSAGE BODY</label>
                <textarea ref={bodyRef} value={f.body} onChange={(e) => set({ body: e.target.value }, 'body')} placeholder="Hi {{name}}, ..." />
                <div className="tpl-hint">{f.callPermission ? 'Use the words below as variables.' : 'Use the words below as variables. Click one to put it in the message.'} {f.body.length}{wa ? `/${LIMITS.body}` : ''} letters{f.channel === 'sms' ? ` · ${segs} text message${segs === 1 ? '' : 's'}` : ''}.</div>
                {!ro ? <div className="tpl-var-chips">{VARS.map((v) => <button type="button" key={v} className="tpl-var-chip" onClick={() => insertVar(v)} title={`Example: ${SAMPLE[v]}`}>{`{{${v}}}`} <span>{VAR_WORDS[v]}</span></button>)}</div> : null}
                {wa && map.params.length ? (
                  <div className="tpl-map"><b>WhatsApp numbers these for you</b>{map.params.map((p) => <div key={p.index}><code>{`{{${p.index}}}`}</code> = {p.words} <span>(example: {p.example})</span></div>)}<div className="tpl-map-text">{map.text}</div></div>
                ) : null}
              </div>

              {wa || f.channel === 'email' ? <div className="full"><label>FOOTER TEXT · Optional</label><input value={f.footer} placeholder="e.g. Reply STOP to unsubscribe" onChange={(e) => set({ footer: e.target.value }, 'footer')} /><div className="tpl-hint">Short text at the bottom of your message. Max 60 characters ({f.footer.length}/60).</div></div> : null}

              {f.channel === 'sms' ? (
                <>
                  <div><label>DLT TEMPLATE NUMBER · Optional</label><input inputMode="numeric" value={f.dltTemplateId} placeholder="1107162345678901234" onChange={(e) => set({ dltTemplateId: e.target.value }, 'dlt')} /><div className="tpl-hint">10 to 25 digits, from your DLT portal. Needed before a promotion SMS can go.</div></div>
                  <div><label>SENDER ID · Optional</label><input value={f.senderId} placeholder="GRNSRT" onChange={(e) => set({ senderId: e.target.value }, 'sender')} /><div className="tpl-hint">3 to 11 letters or numbers, no spaces.</div></div>
                </>
              ) : null}

              {wa && isOutreach ? (
                <div className="full" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid #dcecdf', paddingTop: 14 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><span style={{ fontSize: 16 }}>📞</span><div><b style={{ fontSize: 10, display: 'block' }}>Call Permission Request</b><small style={{ fontSize: 9, color: 'var(--muted)' }}>Ask the person&apos;s permission to receive calls from your business.</small></div></div>
                  <Toggle on={f.callPermission} onClick={toggleCall} disabled={ro} label="Call permission request" />
                </div>
              ) : null}
              {wa && isOutreach && f.callPermission ? <div className="full tpl-cp-note">Only one button is supported for this type of template and the button text is not editable.<Planned>Sending a call-permission template to Meta from this screen is planned; you can save it here.</Planned></div> : null}

              {wa && isOutreach && !f.callPermission ? (
                <div className="full" style={{ borderTop: '1px solid #dcecdf', paddingTop: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                    <div><b style={{ fontSize: 10 }}>Buttons · Optional</b> <span className="ta-cap">{used}/{LIMITS.buttons}</span><div className="tpl-hint" style={{ marginTop: 2 }}>Drive interactions. More than 3 buttons will appear as a list.</div></div>
                    {!ro ? (
                      <div className="ta-wrap">
                        <button type="button" className="btn" onClick={() => setMenu(!menu)} aria-expanded={menu}>＋ Add Action ⌄</button>
                        <div className={`ta-menu${menu ? ' show' : ''}`}>
                          {ACTIONS.map((t) => { const u = count(t.key); const full = u >= t.limit || used >= LIMITS.buttons; return <button type="button" key={t.key} className="ta-item" disabled={full} onClick={() => addAction(t.key)}><span className="ta-ico">{t.ico}</span><span>{t.label}</span><span className="ta-count">{u}/{t.limit}</span></button>; })}
                        </div>
                      </div>
                    ) : null}
                  </div>
                  {used ? (
                    <div className="ta-rows">
                      {f.buttons.map((b) => {
                        const t = ACTIONS.find((a) => a.key === b.type);
                        return (
                          <div key={b.id} className={`ta-row${drag === b.id ? ' dragging' : ''}`} draggable={!ro} onDragStart={() => setDrag(b.id)} onDragEnd={() => setDrag(null)} onDragOver={(e) => e.preventDefault()} onDrop={() => dropOn(b.id)}>
                            <span className="ta-grip" title="Drag to reorder">⠿</span>
                            <div className="ta-fields">
                              <div className="ta-field"><label>Action type</label>
                                <Combo value={b.type} onChange={(e) => { const nt = e.target.value; if (nt !== b.type && f.buttons.filter((x) => x.type === nt).length >= ACTIONS.find((a) => a.key === nt).limit) { toast(`${ACTIONS.find((a) => a.key === nt).label} is limited to ${ACTIONS.find((a) => a.key === nt).limit}`); return; } updBtn(b.id, { type: nt, label: b.label || ACTIONS.find((a) => a.key === nt).def }); }}>
                                  {ACTIONS.map((x) => { const blocked = x.key !== b.type && f.buttons.filter((y) => y.type === x.key).length >= x.limit; return <option key={x.key} value={x.key} disabled={blocked}>{x.label}{blocked ? ' (limit reached)' : ''}</option>; })}
                                </Combo></div>
                              <div className="ta-field"><label>Button text</label><input value={b.label} maxLength={25} placeholder="Button label" onChange={(e) => updBtn(b.id, { label: e.target.value })} /></div>
                              {b.type === 'url' ? <div className="ta-field"><label>Website URL</label><div className="ta-prefixed"><span className="ta-pre">🌐</span><input placeholder="https://website.com" value={b.url} onChange={(e) => updBtn(b.id, { url: e.target.value })} /></div></div> : null}
                              {b.type === 'phone' ? <div className="ta-field"><label>Phone number</label><div className="ta-phone"><select value={b.country || '+91'} onChange={(e) => updBtn(b.id, { country: e.target.value })}>{DIAL.map(([c, d]) => <option key={c} value={d}>{c} {d}</option>)}</select><input placeholder="9876543210" value={b.phone} onChange={(e) => updBtn(b.id, { phone: e.target.value })} /></div></div> : null}
                              {b.type === 'code' ? <div className="ta-field"><label>Offer code</label><div className="ta-prefixed"><span className="ta-pre">🏷</span><input placeholder="SAVE20" value={b.code} onChange={(e) => updBtn(b.id, { code: e.target.value })} /></div></div> : null}
                            </div>
                            {!ro ? <button type="button" className="ta-del" title="Remove button" onClick={() => delBtn(b.id)}>🗑</button> : null}
                            {b.type === 'flow' ? (
                              <div className="ta-flow">
                                <label style={{ display: 'block', fontSize: '8.5px', fontWeight: 850, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--muted)' }}>Linked flow</label>
                                {b.flow ? <div className="ta-flow-picked">✓ {b.flow}{!ro ? <button type="button" className="th-file-x" style={{ marginLeft: 'auto' }} title="Unlink" onClick={() => updBtn(b.id, { flow: '' })}>✕</button> : null}</div> : (
                                  <>
                                    <div className="ta-flow-btns">
                                      <button type="button" className="ta-flow-btn" onClick={() => setPrompt({ kind: 'newflow', btn: b.id })}>＋ Create New Flow</button>
                                      <div style={{ minWidth: 0 }}><Combo value="" placeholder="⧉ Select Existing Flow" onChange={(e) => e.target.value && updBtn(b.id, { flow: e.target.value })}><option value="">Select Existing Flow</option>{(flows || []).map((x) => <option key={x.id} value={x.name}>{x.name}</option>)}</Combo></div>
                                    </div>
                                    <div className="ta-flow-warn">You must select or create a flow for this button to work.</div>
                                  </>
                                )}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : <div className="ta-empty">{ro ? 'No buttons on this template.' : 'No buttons added yet. Click "Add Action" to start.'}</div>}
                </div>
              ) : null}
              {!isOutreach ? <div className="full tpl-hint" style={{ color: '#946012' }}>This template is shared with {item.where ? item.where.join(' / ') : 'other parts of TeamLink'}. Only its name, subject and words are changed here; headers and buttons are for Omni-Channel templates.</div> : null}
            </div>
          </fieldset>
        </div>

        <div className="tpl-rail">
          <div className="card panel">
            <b style={{ fontSize: 13 }}>Live Preview</b>
            <p style={{ fontSize: 9, color: 'var(--muted)', margin: '3px 0 12px' }}>{ro ? 'How this template looks on mobile.' : (isNew ? 'Real-time preview of your message.' : 'Real-time preview of your edits.')} Shown with example values.</p>
            <div style={{ display: 'flex', justifyContent: 'center' }}><PhonePreview f={{ ...f, buttons: f.buttons }} /></div>
          </div>
          <div className="card panel">
            <b style={{ fontSize: 13 }}>{wa ? 'Meta policy check' : 'Template check'}</b>
            <p style={{ fontSize: 9, color: 'var(--muted)', margin: '3px 0 10px' }}>{wa ? 'Checked against WhatsApp Business template rules before you send it. This is our reading of Meta\'s rules, not Meta\'s verdict.' : 'The TeamLink rules for this kind of message (opt-out line, words you may use, subject).'}</p>
            {wa ? <PolicyPanel pol={pol} touched={touched} reveal={reveal || !isNew} f={f} /> : <PlainCheck chk={chk} f={f} />}
          </div>
          {wa && !isNew && isOutreach ? (
            <div className="card panel">
              <b style={{ fontSize: 13 }}>WhatsApp approval</b>
              <p style={{ fontSize: 9, color: 'var(--muted)', margin: '3px 0 10px' }}>A WhatsApp template can only be used in a campaign after WhatsApp has approved it.</p>
              <div className="mp-status-cell" style={{ marginBottom: 8 }}>{item.statusWord === 'In review' ? <span className="mp-spin" /> : null}<Pill tone={item.statusTone}>{item.statusWord}</Pill>{item.extra && (item.extra.review || item.extra.meta) ? <button type="button" className="mp-review-btn" onClick={() => onReview(item)}>{item.statusWord === 'Rejected' ? 'Why?' : 'Details'}</button> : null}</div>
              {item.ready ? <div className="mp-ok">Approved: this template can be used in campaigns.</div> : <div className="mp-gate">{item.readyWhy || 'Not approved yet, so it cannot be used.'}</div>}
              {!waNow.connected ? <div className="mp-gate" style={{ marginTop: 8 }}>{waNow.why || 'Not connected: Administration > Integrations > WhatsApp Business.'}</div> : (!waNow.wabaReady ? <div className="mp-gate" style={{ marginTop: 8 }}>{waNow.why}</div> : null)}
              {metaMsg ? <div className="th-err" style={{ marginTop: 8 }}>{metaMsg}</div> : null}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                {canEditThis ? <Btn primary disabled={metaBusy || !waNow.wabaReady || pol.errors > 0 || !ro} title={pol.errors ? 'Fix the issues in the check first' : (!ro ? 'Save your changes first' : '')} onClick={() => metaCall('submit')}>Send to Meta for review</Btn> : null}
                <Btn disabled={metaBusy || !waNow.wabaReady || !(item.extra && item.extra.meta)} onClick={() => metaCall('sync')}>↻ Check with Meta</Btn>
              </div>
              {waAcc && waAcc.chips && waAcc.chips.length ? (
                <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px dashed var(--line)' }}>
                  <label style={{ display: 'block', fontSize: 8.5, fontWeight: 850, letterSpacing: '.08em', color: 'var(--muted)' }}>WHICH NUMBERS CAN USE IT</label>
                  <AccountChips chips={waAcc.chips} big />
                  <div className="tpl-hint" style={{ marginTop: 6 }}>{waAcc.summary.approved} of {waAcc.summary.numbers} number{waAcc.summary.numbers === 1 ? '' : 's'} can send this template now. The same template is used by every number; each WhatsApp account needs Meta&apos;s own approval of it (numbers of one account share it).</div>
                  {waAcc.summary.approved < waAcc.summary.numbers ? (waAcc.canFix
                    ? <div className="tpl-hint">Press <b>Send to every number&apos;s WhatsApp account</b>: it is sent once for each account. Meta then reviews it (minutes to a day). Press <b>Check all accounts with Meta</b> later to see the answer.</div>
                    : <div className="tpl-hint">Some numbers cannot send it yet. Ask an Admin to send it to every number&apos;s WhatsApp account.</div>) : null}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                    {waAcc.canFix && canEditThis ? <Btn primary disabled={metaBusy || pol.errors > 0 || !ro || !waAcc.accounts.some((a) => a.connected)} title={pol.errors ? 'Fix the issues in the check first' : (!ro ? 'Save your changes first' : '')} onClick={() => acctCall('submit-all')}>Send to every number&apos;s WhatsApp account</Btn> : null}
                    {canEditThis ? <Btn disabled={metaBusy || !waAcc.accounts.some((a) => a.connected)} onClick={() => acctCall('check-all')}>↻ Check all accounts with Meta</Btn> : null}
                  </div>
                </div>
              ) : null}
              {pol.errors > 0 && ro ? <div className="tpl-hint" style={{ marginTop: 6 }}>{pol.errors} issue{pol.errors === 1 ? '' : 's'} in the check must be fixed before this can go to Meta.</div> : null}
              {meta && meta.isAdmin ? (
                <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px dashed var(--line)' }}>
                  <label style={{ display: 'block', fontSize: 8.5, fontWeight: 850, letterSpacing: '.08em', color: 'var(--muted)' }}>RECORD THE APPROVAL (ADMIN)</label>
                  <div style={{ display: 'flex', gap: 8, marginTop: 5 }}>
                    <select className="select" value={f.approval} onChange={(e) => set({ approval: e.target.value })} style={{ height: 34, flex: 1 }}>{APPROVALS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                    <Btn onClick={() => setApproval(f.approval)}>Save status</Btn>
                  </div>
                  <div className="tpl-hint">Only record what WhatsApp itself says (Meta Business Manager). Nothing here is approved automatically.</div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {err ? <div role="alert" style={{ background: '#fdeced', border: '1px solid #f4c9cc', color: '#9b1c1c', borderRadius: 10, padding: '9px 12px', fontSize: 11, margin: '12px 0 0' }}>{err}</div> : null}
      {isNew ? (
        <button type="button" className="btn primary" style={{ width: '100%', height: 46, marginTop: 16, fontSize: 12 }} disabled={busy} onClick={save}>{reveal && blockers.length ? `Fix ${blockers.length} issue${blockers.length === 1 ? '' : 's'} to save` : 'Save template'}</button>
      ) : (
        <div className="tpl-edit-foot">
          <span>{ro ? `Last updated ${item.updatedAt ? fmtDate(item.updatedAt) : '—'}${wa ? ' · Changing an approved WhatsApp template sends it back to "Not sent to Meta": WhatsApp must approve it again.' : ''}` : (wa ? 'Saving changes to an approved template sends it back to "Not sent to Meta": WhatsApp must approve it again.' : 'Save your changes.')}</span>
          <div>{ro ? (canEditThis ? <Btn className="tpl-editbtn" onClick={startEdit}>✎ Edit Template</Btn> : null) : <><Btn onClick={cancel}>✕ Cancel</Btn><Btn className="tpl-save" disabled={busy} onClick={save}>{reveal && blockers.length ? `Fix ${blockers.length} to save` : '💾 Save Changes'}</Btn></>}</div>
        </div>
      )}
      {lib ? <MediaLibraryModal title={`Choose a ${lib === 'document' ? 'document' : lib}`} types={MEDIA_KINDS[lib]} multiple={false} onClose={() => setLib(null)} onPick={(p) => { if (p[0]) set({ headerMedia: { libraryId: p[0].id, name: p[0].name, url: p[0].url.replace(/^https?:\/\/[^/]+(?=\/api\/)/, '') } }, 'header'); }} /> : null}
      {prompt && prompt.kind === 'newflow' ? <PromptModal title="New WhatsApp Flow" label="Flow name" initial="Customer survey" okLabel="Create flow" validate={(v) => (!v.trim() ? 'Give the flow a name.' : ((flows || []).some((x) => x.name.toLowerCase() === v.trim().toLowerCase()) ? 'A flow with that name already exists.' : ''))} onCancel={() => setPrompt(null)} onOk={newFlow} /> : null}
    </div>
  );
}
export { fmtSize, BTN_ICON };
