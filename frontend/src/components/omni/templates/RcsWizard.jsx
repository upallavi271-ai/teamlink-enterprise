import { useEffect, useRef, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import Combo from '../../Combo.jsx';
import { GsModal, Btn, Planned } from '../ui.jsx';
import { uploadToLibrary } from './MediaLibraryModal.jsx';
import { fmtSize } from './tplCommon.jsx';

// The 5-step "Create RCS Assistant" window (Basic, Branding, Contact, Verification, Done) with a live handset preview.
// It SAVES a real record (table OmniRcsAgent). RCS sending is planned: nothing is sent to a carrier and nothing is "verified".
// Other pages (Settings > Integrations) can import and open it: <RcsWizard onClose onCreated(agent) />.
const STEPS = ['Basic', 'Branding', 'Contact', 'Verification', 'Done'];
const CATS = ['Conversational', 'OTP', 'Promotional', 'Transactional', 'Multi-use'];
const BILL = ['Basic Message', 'Single Message', 'Conversational', 'Basic Message + SMS'];
const LIM = { cover: { w: 1440, h: 448, kb: 200, label: '1440x448' }, icon: { w: 240, h: 240, kb: 50, label: '240x240' } };
const blank = () => ({ name: '', category: '', billing: '', description: '', theme: '#11985a', cover: null, icon: null, coverNote: '', iconNote: '', contact: { name: '', mobile: '', designation: '', email: '' }, phones: [{ label: '', number: '' }], websites: [{ url: '' }], emails: [{ email: '' }], privacyUrl: '', termsUrl: '', brand: '', brandSite: '', testers: '' });

function ImageCard({ kind, title, value, note, onChange, busy, err, setErr }) {
  const input = useRef(null); const [drag, setDrag] = useState(false); const [work, setWork] = useState(false);
  const lim = LIM[kind];
  const take = async (files) => {
    const file = files && files[0]; if (!file) return;
    setErr('');
    if (!/^image\/(jpeg|png)$/.test(file.type)) { setErr(`That is ${file.type ? `a ${file.type.replace('image/', '').toUpperCase()}` : 'an unknown'} file. Use JPEG or PNG.`); return; }
    if (file.size > lim.kb * 1024) { setErr(`${file.name} is ${fmtSize(file.size)}. The limit is ${lim.kb} KB.`); return; }
    setWork(true);
    try {
      const dims = await new Promise((res) => { const u = URL.createObjectURL(file); const im = new Image(); im.onload = () => { res({ w: im.width, h: im.height }); URL.revokeObjectURL(u); }; im.onerror = () => res(null); im.src = u; });
      const it = await uploadToLibrary(file);
      const off = dims && (Math.abs(dims.w - lim.w) > 2 || Math.abs(dims.h - lim.h) > 2);
      onChange({ libraryId: it.id, name: it.name, url: it.url }, `${it.name}${dims ? ` · ${dims.w}x${dims.h}` : ''} · ${fmtSize(file.size)}${off ? ` · carriers prefer ${lim.label}` : ''}`);
    } catch (e) { setErr(errOf(e, e.message || 'The picture could not be saved.')); } finally { setWork(false); }
  };
  return (
    <div className="field"><label>{title.toUpperCase()}</label>
      <div className={`wz-drop ${kind === 'icon' ? 'sm' : ''} ${value ? 'has' : ''} ${err ? 'bad' : ''} ${drag ? 'drag' : ''} ${work ? 'busy' : ''}`} tabIndex={0} role="button" aria-label={`${title}: choose or drop an image`}
        onClick={(e) => { if (!e.target.closest('.wz-clear') && input.current) input.current.click(); }} onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && input.current) { e.preventDefault(); input.current.click(); } }}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); take(e.dataTransfer.files); }}>
        <div className={`wz-drop-prev ${kind === 'icon' ? 'icon' : ''}`}>{value ? <img src={value.url} alt={`${title} preview`} /> : <span>{kind === 'icon' ? 'Icon' : 'Cover image'}</span>}<div className="wz-drop-veil"><b>Drop to upload</b></div><div className="wz-drop-spin"><i /></div></div>
        <span className="wz-browse">{value ? 'Replace image' : 'Browse Image'}</span>
        {value ? <button type="button" className="wz-clear" onClick={(e) => { e.stopPropagation(); onChange(null, ''); }}>Remove</button> : null}
        <small>Supported formats : JPEG, PNG | Dimension {lim.label} | Max size: {lim.kb}kb</small>
        {err ? <small className="wz-ferr">{err}</small> : (value && note ? <small className="wz-fname">{note}</small> : <small>or drag an image here</small>)}
      </div>
      <input ref={input} type="file" accept="image/jpeg,image/png" style={{ display: 'none' }} onChange={(e) => { take(e.target.files); e.target.value = ''; }} />
    </div>
  );
}

function Rows({ title, list, keys, labels, phs, onChange }) {
  return (
    <section className="wz-sec">
      <div className="wz-sec-head"><h4>{title}</h4>{list.length < 5 ? <button type="button" className="tiny-btn" onClick={() => onChange([...list, Object.fromEntries(keys.map((k) => [k, '']))])}>＋ Add</button> : null}</div>
      {list.map((r, i) => (
        <div className="wz-grid2" key={i} style={{ marginBottom: 8 }}>
          {keys.map((k, j) => (
            <div className="field" key={k}><label>{labels[j]}{j === keys.length - 1 && i > 0 ? <button type="button" className="wz-x" onClick={() => onChange(list.filter((_, x) => x !== i))} title="Remove">✕</button> : null}</label>
              <input value={r[k]} placeholder={phs[j]} onChange={(e) => onChange(list.map((x, y) => (y === i ? { ...x, [k]: e.target.value } : x)))} /></div>
          ))}
        </div>
      ))}
    </section>
  );
}

export default function RcsWizard({ onClose, onCreated }) {
  const { toast } = useOmni();
  const [d, setD] = useState(blank);
  const [step, setStep] = useState(1);
  const [errs, setErrs] = useState([[], [], [], []]);
  const [busy, setBusy] = useState(false);
  const [fileErr, setFileErr] = useState({});
  const [top, setTop] = useState('');
  const set = (p) => setD((o) => ({ ...o, ...p }));
  const data = () => ({ ...d, testers: String(d.testers || '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean) });

  useEffect(() => {
    const t = setTimeout(() => { omni.post('/gs/templates/rcs/agents/check', { data: data() }).then((r) => setErrs(r.byStep || [[], [], [], []])).catch(() => {}); }, 250);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d]);
  const stepErr = (n) => (errs[n - 1] && errs[n - 1][0]) || '';
  const stepOk = (n) => !stepErr(n);
  const canJump = (n) => { for (let i = 1; i < n; i += 1) if (i <= 4 && !stepOk(i)) return false; return true; };
  const jump = (n) => { if (n <= step || canJump(n)) setStep(n); };
  const next = async () => {
    if (step < 5) { setStep(step + 1); return; }
    setBusy(true); setTop('');
    try { const r = await omni.post('/gs/templates/rcs/agents', { data: data() }); toast(`"${r.agent.name}" saved. RCS sending is planned, so nothing was sent to a carrier.`); if (onCreated) onCreated(r.agent); onClose(); } catch (e) { setTop(errOf(e, 'It could not be saved.')); } finally { setBusy(false); }
  };
  const firstBad = [1, 2, 3, 4].find((n) => !stepOk(n));
  const hint = step <= 4 ? stepErr(step) : (firstBad ? stepErr(firstBad) : '');
  const disabled = step <= 4 ? !stepOk(step) : (!!firstBad || busy);
  const c = d.contact;

  let body;
  if (step === 1) {
    body = (
      <>
        <div className="field"><label>ASSISTANT NAME <span className="wz-count">{d.name.length} / 40</span></label><input maxLength={40} value={d.name} placeholder="Unique name for the assistant (e.g. Teamlink Medical)" onChange={(e) => set({ name: e.target.value })} /></div>
        <div className="field" style={{ marginTop: 16 }}><label>ASSISTANT CATEGORY</label><Combo value={d.category} onChange={(e) => set({ category: e.target.value })}><option value="">Select Category</option>{CATS.map((x) => <option key={x}>{x}</option>)}</Combo></div>
        <div className="field" style={{ marginTop: 16 }}><label>BILLING CATEGORY</label><Combo value={d.billing} onChange={(e) => set({ billing: e.target.value })}><option value="">Select Billing Category</option>{BILL.map((x) => <option key={x}>{x}</option>)}</Combo></div>
        <div className="field" style={{ marginTop: 16 }}><label>DESCRIPTION <span className="wz-count">{d.description.length} / 100</span></label><textarea maxLength={100} value={d.description} placeholder="Brief description of the assistant (e.g. Teamlink Medical sends interview invitations and updates.)" onChange={(e) => set({ description: e.target.value })} /></div>
      </>
    );
  } else if (step === 2) {
    body = (
      <>
        <div className="field"><label>THEME COLOR</label>
          <div className="wz-color"><span className="wz-swatch" style={{ background: /^#[0-9a-fA-F]{6}$/.test(d.theme) ? d.theme : '#ccc' }} /><input className="wz-hex" value={d.theme} maxLength={7} onChange={(e) => set({ theme: e.target.value })} aria-label="Theme colour as a six-digit hex value" /><input type="color" aria-label="Pick a colour" value={/^#[0-9a-fA-F]{6}$/.test(d.theme) ? d.theme : '#11985a'} onChange={(e) => set({ theme: e.target.value })} style={{ width: 28, height: 28, border: 0, background: 'none' }} /></div>
          <span className="wz-hint">Used for the agent header and action buttons on the handset.</span></div>
        <div style={{ marginTop: 16 }}><ImageCard kind="cover" title="Cover Image" value={d.cover} note={d.coverNote} err={fileErr.cover} setErr={(m) => setFileErr((o) => ({ ...o, cover: m }))} onChange={(m, n) => set({ cover: m, coverNote: n })} /></div>
        <div style={{ marginTop: 16 }}><ImageCard kind="icon" title="Icon Image" value={d.icon} note={d.iconNote} err={fileErr.icon} setErr={(m) => setFileErr((o) => ({ ...o, icon: m }))} onChange={(m, n) => set({ icon: m, iconNote: n })} /></div>
      </>
    );
  } else if (step === 3) {
    body = (
      <>
        <section className="wz-sec"><div className="wz-sec-head"><h4>Contact Person Details</h4></div>
          <div className="wz-grid2">
            <div className="field"><label>FULL NAME</label><input value={c.name} placeholder="Brand contact full name (e.g. Gaurav)" onChange={(e) => set({ contact: { ...c, name: e.target.value } })} /></div>
            <div className="field"><label>MOBILE NUMBER</label><input inputMode="tel" value={c.mobile} placeholder="98765 43210" onChange={(e) => set({ contact: { ...c, mobile: e.target.value } })} /></div>
            <div className="field"><label>DESIGNATION</label><input value={c.designation} placeholder="Manager" onChange={(e) => set({ contact: { ...c, designation: e.target.value } })} /></div>
            <div className="field"><label>OFFICIAL EMAIL ID</label><input type="email" value={c.email} placeholder="name@company.com" onChange={(e) => set({ contact: { ...c, email: e.target.value } })} /></div>
          </div></section>
        <Rows title="Business Phone Numbers" list={d.phones} keys={['label', 'number']} labels={['DISPLAY NAME', 'PHONE NUMBER']} phs={['Label for phone number (e.g. Support Phone)', '+91 90000 00000']} onChange={(l) => set({ phones: l })} />
        <Rows title="Business Websites" list={d.websites} keys={['url']} labels={['URL']} phs={['https://www.example.com']} onChange={(l) => set({ websites: l })} />
        <Rows title="Business Emails" list={d.emails} keys={['email']} labels={['EMAIL ADDRESS']} phs={['contact@example.com']} onChange={(l) => set({ emails: l })} />
        <section className="wz-sec"><div className="wz-sec-head"><h4>Business Security</h4></div>
          <div className="wz-grid2">
            <div className="field"><label>PRIVACY POLICY URL</label><input value={d.privacyUrl} placeholder="https://www.example.com/privacy" onChange={(e) => set({ privacyUrl: e.target.value })} /></div>
            <div className="field"><label>TERMS &amp; CONDITIONS URL</label><input value={d.termsUrl} placeholder="https://www.example.com/terms" onChange={(e) => set({ termsUrl: e.target.value })} /></div>
          </div></section>
      </>
    );
  } else if (step === 4) {
    const n = String(d.testers || '').split(/[\n,]+/).filter((x) => x.trim()).length;
    body = (
      <>
        <section className="wz-sec"><div className="wz-sec-head"><h4>Carrier Verification</h4></div>
          <div className="field"><label>REGISTERED BRAND NAME</label><input value={d.brand} placeholder="Legal entity name (e.g. Teamlink Consultants OPC Pvt. Ltd.)" onChange={(e) => set({ brand: e.target.value })} /></div>
          <div className="field" style={{ marginTop: 14 }}><label>BRAND WEBSITE · Optional</label><input value={d.brandSite} placeholder="https://www.example.com" onChange={(e) => set({ brandSite: e.target.value })} /></div>
          <div className="field" style={{ marginTop: 14 }}><label>TEST DEVICE NUMBERS · Optional <span className="wz-count">{n} added</span></label><textarea value={d.testers} placeholder="+91 98765 43210" onChange={(e) => set({ testers: e.target.value })} /><span className="wz-hint">One per line or separated by commas. Kept ready for testing once RCS is switched on.</span></div>
        </section>
        <section className="wz-sec"><div className="wz-sec-head"><h4>What happens next</h4></div>
          <ol className="wz-steps-list"><li>The assistant is saved here and appears under RCS in Manage Templates.</li><li>Sending it to a carrier for review is planned and not built: nothing is sent now.</li><li>Once RCS is switched on, the carrier reviews the brand, branding pictures and contact details (usually 3 to 5 working days).</li><li>Your test devices stay on the list for that time.</li></ol>
          <p style={{ fontSize: 10, color: 'var(--muted)', marginTop: 8 }}>RCS is cleared by the carrier under your telecom subscription. There is no Meta review on this channel.</p></section>
      </>
    );
  } else {
    const rows = [['Assistant name', d.name], ['Category', d.category], ['Billing', d.billing], ['Description', d.description], ['Theme colour', d.theme], ['Branding', `Cover ${d.cover ? '✓' : '✗'} · Icon ${d.icon ? '✓' : '✗'}`], ['Contact person', `${c.name} · ${c.designation}`], ['Contact email', c.email], ['Business phones', d.phones.filter((p) => p.number).map((p) => `${p.label ? `${p.label}: ` : ''}${p.number}`).join(', ')], ['Business websites', d.websites.filter((w) => w.url).map((w) => w.url).join(', ')], ['Business emails', d.emails.filter((w) => w.email).map((w) => w.email).join(', ')], ['Privacy policy', d.privacyUrl], ['Terms & conditions', d.termsUrl], ['Registered brand', d.brand], ['Test devices', String(d.testers || '').split(/[\n,]+/).filter((x) => x.trim()).length || 'None']];
    body = (
      <div>
        <div className="wz-done"><div className="wz-done-ic">✓</div><h3>Ready to save</h3><p>Check the details below, then save the assistant. RCS sending is planned, so it is kept here and nothing is sent to a carrier.</p></div>
        <section className="wz-sec"><div className="wz-sec-head"><h4>Summary</h4><button type="button" className="tiny-btn" onClick={() => setStep(1)}>Edit</button></div>
          <div className="wz-summary">{rows.map(([k, v]) => <div className="wz-sum-row" key={k}><small>{k}</small><b>{v || '—'}</b></div>)}</div></section>
        {top ? <div role="alert" style={{ color: '#b3261e', fontSize: 11, fontWeight: 700 }}>{top}</div> : null}
      </div>
    );
  }

  const first = (list, k) => (list[0] && list[0][k]) || '';
  const theme = /^#[0-9a-fA-F]{6}$/.test(d.theme) ? d.theme : '#11985a';
  return (
    <GsModal title="Create RCS Assistant" sub="Conversational agent for RCS Business Messaging." width={960} onClose={onClose} bodyStyle={{ maxHeight: '78vh' }}>
      <div className="wz-steps" role="tablist">
        {STEPS.map((l, i) => { const n = i + 1; return <span key={l} style={{ display: 'contents' }}><button type="button" className={`wz-step ${step === n ? 'active' : ''} ${n < step ? 'done' : ''}`} onClick={() => jump(n)}><span className="wz-num">{n < step ? '✓' : n}</span>{l}</button>{n < STEPS.length ? <div className="wz-line" /> : null}</span>; })}
      </div>
      <Planned>RCS sending is planned: this saves your assistant here. Nothing is sent to a carrier, and nothing is marked verified.</Planned>
      <div className="wz-body">
        <div className="wz-form">{body}</div>
        <div className="wz-preview">
          <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 8 }}>Live preview, updates as you type</div>
          <div className="rcs-phone" style={{ height: 430 }}>
            <div className="rcs-phone-top" style={{ background: theme }}>{d.icon ? <img src={d.icon.url} alt="" style={{ width: 22, height: 22, borderRadius: '50%', objectFit: 'cover' }} /> : null}<span style={{ textTransform: 'uppercase', overflowWrap: 'anywhere' }}>{d.name || 'Assistant name'}</span></div>
            <div className="rcs-banner" style={d.cover ? { backgroundImage: `url(${d.cover.url})` } : undefined} />
            <div className="wz-prev-card"><div className="rcs-logo">{d.icon ? <img src={d.icon.url} alt="" /> : null}</div>
              <h4 style={{ overflowWrap: 'anywhere' }}>{d.name || 'Assistant name'}</h4><p style={{ overflowWrap: 'anywhere' }}>{d.description || 'A short description of what this assistant does.'}</p>
              <div className="rcs-contact"><span>📞</span><div><b>{first(d.phones, 'number') || '+00 000 000 000'}</b><small>{first(d.phones, 'label') || 'Phone'}</small></div></div>
              <div className="rcs-contact"><span>🌐</span><div><b style={{ overflowWrap: 'anywhere' }}>{first(d.websites, 'url') || 'www.example.com'}</b><small>Website</small></div></div>
              <div className="rcs-contact"><span>✉</span><div><b style={{ overflowWrap: 'anywhere' }}>{first(d.emails, 'email') || 'contact@example.com'}</b><small>Email</small></div></div>
            </div>
          </div>
        </div>
      </div>
      <div className="wz-foot">
        <Btn disabled={step === 1} onClick={() => setStep(step - 1)}>Back</Btn>
        <div className="wz-hint-wrap"><span className="wz-hint-msg" style={{ display: hint ? 'block' : 'none' }}>{hint}</span></div>
        <Btn primary disabled={disabled} title={hint} onClick={next}>{step === 5 ? (busy ? 'Saving…' : 'Save Assistant') : 'Next'}</Btn>
      </div>
    </GsModal>
  );
}
