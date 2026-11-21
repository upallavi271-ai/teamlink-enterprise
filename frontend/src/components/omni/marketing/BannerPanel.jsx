import { useEffect, useMemo, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { Btn, Panel, Field } from '../ui.jsx';
import { MkImg } from './mk.jsx';

// AI MARKETING > AI IMAGES > BANNERS: a designed banner (headline fitted to the space, sub-line, offer badge, button, logo on a plate, contact strip, optionally over one of your pictures).
// Free: designed on the server (marketing/banner.js), no AI service. The result is saved like any picture: ask for approval, then it can be picked in a campaign (Communication > Campaigns).
const empty = { size: '16:9', layout: 'bold', headline: '', sub: '', cta: '', badge: '', footer: '', photoItemId: '', title: '' };

export default function BannerPanel({ projectId = '', pictures = [], onMade, toast }) {
  const [meta, setMeta] = useState(null);
  const [f, setF] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [made, setMade] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { omni.get('/gs/marketing/banners/meta').then(setMeta).catch(() => setMeta(null)); }, []);
  const usable = useMemo(() => (pictures || []).filter((p) => p.kind !== 'video' && ['approved', 'draft', 'changes'].includes(p.status) && p.style !== 'banner'), [pictures]);
  if (!meta) return null;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const go = async () => {
    setErr('');
    if (f.headline.trim().length < 3) { setErr('Write the banner headline first (a few words).'); return; }
    setBusy(true);
    try {
      const r = await omni.post('/gs/marketing/banners', { ...f, projectId: projectId || undefined });
      setMade(r.item); toast('Banner made. Check it, then ask for approval.'); if (onMade) onMade();
    } catch (e) { setErr(errOf(e, 'The banner could not be made.')); } finally { setBusy(false); }
  };
  return (
    <Panel title="Design a banner" sub="A professional banner in your brand colours and logo: headline, offer badge, button and contact line. Free." style={{ marginBottom: 14 }}
      right={<Btn small onClick={() => setOpen(!open)}>{open ? 'Hide' : '＋ New banner'}</Btn>}>
      {open ? (
        <div>
          {err ? <div role="alert" style={{ color: '#b91c1c', fontSize: 12, marginBottom: 8 }}>{err}</div> : null}
          <div className="mk-form-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 10 }}>
            <Field label="HEADLINE"><input value={f.headline} maxLength={90} onChange={set('headline')} placeholder="Diwali offer: 30% off all plans" /></Field>
            <Field label="SUB-LINE (OPTIONAL)"><input value={f.sub} maxLength={160} onChange={set('sub')} placeholder="Verified candidates, delivered faster" /></Field>
            <Field label="BUTTON WORDS (OPTIONAL)"><input value={f.cta} maxLength={28} onChange={set('cta')} placeholder="Book a free demo" /></Field>
            <Field label="OFFER BADGE (OPTIONAL)"><input value={f.badge} maxLength={18} onChange={set('badge')} placeholder="30% OFF" /></Field>
            <Field label="CONTACT LINE (OPTIONAL)"><input value={f.footer} maxLength={90} onChange={set('footer')} placeholder="Your website and phone (brand voice is used if empty)" /></Field>
            <Field label="NAME (OPTIONAL)"><input value={f.title} maxLength={80} onChange={set('title')} placeholder="Diwali web banner" /></Field>
            <Field label="SIZE"><select value={f.size} onChange={set('size')}>{meta.sizes.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></Field>
            <Field label="LAYOUT"><select value={f.layout} onChange={set('layout')}>{meta.layouts.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></Field>
            <Field label="PICTURE IN THE BANNER (OPTIONAL)"><select value={f.photoItemId} onChange={set('photoItemId')}><option value="">None: brand colours and shapes</option>{usable.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></Field>
          </div>
          <div style={{ marginTop: 10 }}><Btn primary disabled={busy} onClick={go}>{busy ? 'Designing…' : '✦ Design the banner'}</Btn></div>
          {made ? <div style={{ marginTop: 12 }}><MkImg id={made.id} alt={made.title} style={{ maxHeight: 320, objectFit: 'contain', background: '#111', borderRadius: 8 }} /><div style={{ fontSize: 11, marginTop: 4 }}>{made.title}: saved in your pictures below. Press <b>Ask for approval</b> on it.</div></div> : null}
        </div>
      ) : <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Banners are designed for the web, YouTube, LinkedIn, Instagram and Stories. An approved banner can be picked in a campaign and goes out with the messages.</div>}
    </Panel>
  );
}
