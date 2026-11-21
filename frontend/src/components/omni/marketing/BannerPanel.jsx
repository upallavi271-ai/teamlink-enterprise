import { useEffect, useMemo, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { Btn, Panel, Field } from '../ui.jsx';
import { MkImg } from './mk.jsx';

// AI MARKETING > AI IMAGES > BANNERS: a designed banner (headline fitted to the space, sub-line, offer badge, button, logo on a plate, contact strip, optionally over one of your pictures).
// Free: designed on the server (marketing/banner.js), no AI service. The result is saved like any picture: ask for approval, then it can be picked in a campaign (Communication > Campaigns).
const empty = {
  size: '16:9', layout: 'showcase', headline: '', sub: '', cta: '', badge: '', footer: '', photoItemId: '', title: '',
  companyName: '', headline2: '', servicesTitle: '', servicesText: '', plans: [{ name: '', price: '', unit: '' }, { name: '', price: '', unit: '' }, { name: '', price: '', unit: '' }], audienceTitle: '', audience: '', chip: '',
};

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
  const show = f.layout === 'showcase';
  const setPlan = (i, k) => (e) => setF({ ...f, plans: f.plans.map((p, j) => (j === i ? { ...p, [k]: e.target.value } : p)) });
  const go = async () => {
    setErr('');
    if (f.headline.trim().length < 3) { setErr('Write the banner headline first (a few words).'); return; }
    setBusy(true);
    try {
      const { servicesText, ...rest } = f;
      const r = await omni.post('/gs/marketing/banners', { ...rest, services: servicesText.split(/\r?\n/).map((x) => x.trim()).filter(Boolean), projectId: projectId || undefined });
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
            <Field label={show ? 'HEADLINE (WHITE)' : 'HEADLINE'}><input value={f.headline} maxLength={90} onChange={set('headline')} placeholder={show ? 'AI-Powered' : 'Diwali offer: 30% off all plans'} /></Field>
            {show ? <Field label="HEADLINE, SECOND LINE (COLOUR)"><input value={f.headline2} maxLength={60} onChange={set('headline2')} placeholder="Digital Marketing" /></Field> : null}
            <Field label="SUB-LINE (OPTIONAL)"><input value={f.sub} maxLength={160} onChange={set('sub')} placeholder="Verified candidates, delivered faster" /></Field>
            <Field label="BUTTON WORDS (OPTIONAL)"><input value={f.cta} maxLength={28} onChange={set('cta')} placeholder="Book a free demo" /></Field>
            <Field label={show ? 'CENTRE CHIP TEXT WHEN NO PICTURE (E.G. AI)' : 'OFFER BADGE (OPTIONAL)'}><input value={f.badge} maxLength={18} onChange={set('badge')} placeholder="30% OFF" /></Field>
            <Field label="CONTACT LINE (OPTIONAL)"><input value={f.footer} maxLength={90} onChange={set('footer')} placeholder="Your website and phone (brand voice is used if empty)" /></Field>
            <Field label="COMPANY NAME ON THE BANNER (EMPTY = YOUR BRAND NAME)"><input value={f.companyName} maxLength={60} onChange={set('companyName')} placeholder="TeamLink Consultants" /></Field>
            <Field label="NAME (OPTIONAL)"><input value={f.title} maxLength={80} onChange={set('title')} placeholder="Diwali web banner" /></Field>
            <Field label="SIZE"><select value={f.size} onChange={set('size')}>{meta.sizes.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></Field>
            <Field label="LAYOUT"><select value={f.layout} onChange={set('layout')}>{meta.layouts.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></Field>
            <Field label={show ? 'HERO PICTURE (OPTIONAL: e.g. an AI picture of a laptop and charts)' : 'PICTURE IN THE BANNER (OPTIONAL)'}><select value={f.photoItemId} onChange={set('photoItemId')}><option value="">None: brand colours and shapes</option>{usable.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></Field>
          </div>
          {show ? (
            <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
              <div className="mk-form-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 10 }}>
                <Field label="SERVICES TITLE (OPTIONAL)"><input value={f.servicesTitle} maxLength={50} onChange={set('servicesTitle')} placeholder="Our Digital Marketing Services" /></Field>
                <Field label="WEBSITE CHIP (OPTIONAL)"><input value={f.chip} maxLength={40} onChange={set('chip')} placeholder="tmlink.in" /></Field>
                <Field label="WHO IT IS FOR: TITLE (OPTIONAL)"><input value={f.audienceTitle} maxLength={40} onChange={set('audienceTitle')} placeholder="Target Customers:" /></Field>
                <Field label="WHO IT IS FOR: WORDS (OPTIONAL)"><input value={f.audience} maxLength={200} onChange={set('audience')} placeholder="Doctors, Clinics, Hospitals, IT Companies…" /></Field>
              </div>
              <Field label="SERVICES: ONE PER LINE, UP TO 8 (EACH GETS AN ICON)"><textarea rows={4} value={f.servicesText} onChange={(e) => setF({ ...f, servicesText: e.target.value })} placeholder={['Social Media Marketing', 'SEO', 'Google Business Profile Management', 'AI Content Creation'].join('\n')} /></Field>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', marginBottom: 4 }}>PRICE CARDS (OPTIONAL, UP TO 3)</div>
                {f.plans.map((p, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 6 }}>
                    <input value={p.name} maxLength={24} onChange={setPlan(i, 'name')} placeholder={['Basic', 'Growth', 'Premium'][i]} />
                    <input value={p.price} maxLength={20} onChange={setPlan(i, 'price')} placeholder={['₹3,999', '₹7,999', '₹14,999'][i]} />
                    <input value={p.unit} maxLength={16} onChange={setPlan(i, 'unit')} placeholder="/ Month" />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <div style={{ marginTop: 10 }}><Btn primary disabled={busy} onClick={go}>{busy ? 'Designing…' : '✦ Design the banner'}</Btn></div>
          {made ? <div style={{ marginTop: 12 }}><MkImg id={made.id} alt={made.title} style={{ maxHeight: 320, objectFit: 'contain', background: '#111', borderRadius: 8 }} /><div style={{ fontSize: 11, marginTop: 4 }}>{made.title}: saved in your pictures below. Press <b>Ask for approval</b> on it.</div></div> : null}
        </div>
      ) : <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Banners are designed for the web, YouTube, LinkedIn, Instagram and Stories. An approved banner can be picked in a campaign and goes out with the messages.</div>}
    </Panel>
  );
}
