import { useEffect, useRef, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Panel, Banner, Field, ConfirmModal, fmtDateTime } from '../ui.jsx';
import { useMkMeta, aiReady, TextsPreview } from '../marketing/mk.jsx';
import '../marketing/marketing.css';

// AI MARKETING > BRAND VOICE (the brand kit): who the company is, who it talks to, what it always says, how it looks and where it is on social media.
// Every AI request is told the writing parts; the "never use" words are checked on every text the AI writes; the logo and colours are for the
// AI image and video makers. Nothing is cut silently: the counters show the limits and the server says if anything was left out.
const lines = (v) => (Array.isArray(v) ? v.join('\n') : '');
const toForm = (b) => ({
  brandName: b.brandName, about: b.about, voice: b.voice, tone: b.tone, language: b.language, cta: b.cta, signOff: b.signOff,
  doWords: lines(b.doWords), avoidWords: lines(b.avoidWords), samples: (b.samples || []).join('\n\n'),
  tagline: b.tagline || '', website: b.website || '', contact: b.contact || '', audience: b.audience || '',
  industries: (b.industries || []).join(', '), keyMessages: lines(b.keyMessages), hashtags: (b.hashtags || []).join(' '),
  emoji: b.emoji || 'few', disclaimer: b.disclaimer || '',
  colors: { ...(b.colors || { primary: '#0f766e', secondary: '#134e4a', accent: '#f59e0b' }) },
  socials: { facebook: '', instagram: '', linkedin: '', x: '', ...(b.socials || {}) },
});
const words = (v) => String(v || '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
const tagWords = (v) => String(v || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
const blocks = (v) => String(v || '').split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
const rows = (v) => String(v || '').split(/\n+/).map((x) => x.trim()).filter(Boolean);
const EMOJI_WORDS = { none: 'No emoji', few: 'A few (WhatsApp and social only)', many: 'Welcome (WhatsApp and social only)' };
const LOGO_MAX = 300 * 1024;

// "12 / 20" next to a list, red when over
const Count = ({ n, max }) => <span style={{ fontSize: 10, color: n > max ? '#b3261e' : 'var(--muted)', fontWeight: n > max ? 800 : 400 }}>{n} / {max}{n > max ? ` · only the first ${max} are kept` : ''}</span>;

export default function MkBrandPage() {
  const { toast } = useOmni();
  const { meta } = useMkMeta();
  const [data, setData] = useState(null);
  const [f, setF] = useState(null);
  const [base, setBase] = useState('');
  const [logo, setLogo] = useState(null); // { dataUrl, name, at } | null
  const [logoBusy, setLogoBusy] = useState(false);
  const [askRemove, setAskRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notes, setNotes] = useState([]);
  const [trial, setTrial] = useState(null); // { variants, channels } | { error }
  const [trialBusy, setTrialBusy] = useState(false);
  const fileRef = useRef(null);

  const load = () => {
    setErr('');
    omni.get('/gs/marketing/brand').then((d) => { setData(d); const nf = toForm(d.brand); setF(nf); setBase(JSON.stringify(nf)); }).catch((e) => setErr(errOf(e, 'The brand voice could not be read.')));
    omni.get('/gs/marketing/brand/logo').then((r) => setLogo(r.logo)).catch(() => setLogo(null));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = !!f && JSON.stringify(f) !== base;
  useEffect(() => {
    if (!dirty) return undefined;
    const h = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  if (err && !data) return <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={load}>Try again</button></Banner>;
  if (!data || !f) return <div className="card panel">Loading…</div>;
  const L = data.limits || { doWords: 20, avoidWords: 30, samples: 3, sampleChars: 300, industries: 10, keyMessages: 6, keyMessageChars: 160, hashtags: 15 };
  const can = data.canEdit;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const setColor = (k, v) => setF({ ...f, colors: { ...f.colors, [k]: v } });
  const setSocial = (k) => (e) => setF({ ...f, socials: { ...f.socials, [k]: e.target.value } });

  const save = async () => {
    setBusy(true); setErr(''); setNotes([]);
    try {
      const r = await omni.put('/gs/marketing/brand', f);
      setData({ ...data, brand: r.brand }); const nf = toForm(r.brand); setF(nf); setBase(JSON.stringify(nf));
      setNotes(r.notes || []); toast(r.ok || 'Brand voice saved');
    } catch (e) { const m = errOf(e, 'It could not be saved.'); setErr(m); toast(m); } finally { setBusy(false); }
  };
  const pickLogo = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { toast('Use a PNG, JPG or WebP picture for the logo'); return; }
    if (file.size > LOGO_MAX) { toast(`The logo is ${Math.round(file.size / 1024)} KB. Use a picture under ${LOGO_MAX / 1024} KB.`); return; }
    const rd = new FileReader();
    rd.onload = async () => {
      setLogoBusy(true);
      try { const r = await omni.put('/gs/marketing/brand/logo', { dataUrl: rd.result, name: file.name }); setLogo(r.logo); toast(r.ok); } catch (x) { toast(errOf(x, 'The logo could not be saved.')); } finally { setLogoBusy(false); }
    };
    rd.onerror = () => toast('The picture could not be read.');
    rd.readAsDataURL(file);
  };
  const removeLogo = async () => {
    setAskRemove(false); setLogoBusy(true);
    try { const r = await omni.del('/gs/marketing/brand/logo'); setLogo(null); toast(r.ok); } catch (x) { toast(errOf(x, 'The logo could not be removed.')); } finally { setLogoBusy(false); }
  };
  // one short sample in the SAVED brand voice (uses one AI request of today's limit)
  const tryVoice = async () => {
    setTrialBusy(true); setTrial(null);
    const channels = ['whatsapp', meta && meta.channels.some((c) => c.key === 'linkedin') ? 'linkedin' : 'email'];
    try {
      const r = await omni.post('/gs/marketing/generate', { brief: `Introduce ${f.brandName} to people who do not know us yet, in two or three short sentences.`, goal: 'Awareness', channels, variants: 1 });
      setTrial({ variants: r.variants, channels, ai: r.ai });
    } catch (x) { setTrial({ error: errOf(x, 'The AI could not write the sample.') }); } finally { setTrialBusy(false); }
  };

  const b = data.brand;
  // how complete the kit is: the parts the AI and the image / video makers use most
  const checks = [
    ['Brand name', !!f.brandName.trim()], ['About the company', !!f.about.trim()], ['How we sound', !!f.voice.trim()], ['Who we talk to', !!f.audience.trim()],
    ['Key messages', rows(f.keyMessages).length > 0], ['Call to action', !!f.cta.trim()], ['Examples of our writing', blocks(f.samples).length > 0], ['Never-use words', words(f.avoidWords).length > 0],
    ['Logo', !!logo], ['Website or contact', !!(f.website.trim() || f.contact.trim())], ['A social media page', Object.values(f.socials).some((x) => String(x).trim())], ['Hashtags', tagWords(f.hashtags).length > 0],
  ];
  const done = checks.filter((c) => c[1]).length;
  const pct = Math.round((done / checks.length) * 100);
  const chans = trial && trial.channels && meta ? meta.channels.filter((c) => trial.channels.includes(c.key)) : [];

  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="Brand voice" lead="Your brand kit: how the company sounds, who it talks to and how it looks. The AI follows it on every message, and the image and video makers use the logo and colours.">
        <Btn primary disabled={busy || !can || !dirty} onClick={save}>{busy ? 'Saving…' : dirty ? '💾 Save brand voice' : '✓ Saved'}</Btn>
      </PageHead>
      {err ? <Banner tone="error">{err}</Banner> : null}
      {notes.length ? <Banner tone="warn"><b>Saved, with a note:</b> {notes.join(' ')}</Banner> : null}
      {!can ? <Banner tone="info">Your login can read the brand voice but not change it.</Banner> : null}
      {dirty && can ? <Banner tone="warn">You have changes that are not saved yet.</Banner> : null}

      <Panel title="How complete is your brand kit?" sub={`${done} of ${checks.length} parts filled in`} style={{ marginBottom: 14 }}>
        <div style={{ height: 8, borderRadius: 6, background: 'var(--line)', overflow: 'hidden' }} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Brand kit complete">
          <div style={{ width: `${pct}%`, height: '100%', background: pct === 100 ? '#1b8a5a' : f.colors.primary, transition: 'width .3s' }} />
        </div>
        {done < checks.length ? <div className="mk-chips" style={{ marginTop: 10 }}>{checks.filter((c) => !c[1]).map((c) => <span className="mk-chip" key={c[0]}>Missing: {c[0]}</span>)}</div> : <div style={{ fontSize: 11, marginTop: 8, color: '#1b8a5a', fontWeight: 700 }}>Everything is filled in. 🎉</div>}
      </Panel>

      <div className="mk-two">
        <Panel title="Who you are" sub="Short and plain is best.">
          <div className="form-grid">
            <Field label="BRAND NAME" full><input value={f.brandName} maxLength={80} placeholder="TeamLink" onChange={set('brandName')} disabled={!can} /></Field>
            <Field label="TAGLINE" full hint="One short line, used on images and videos."><input value={f.tagline} maxLength={120} placeholder="The right people, fast." onChange={set('tagline')} disabled={!can} /></Field>
            <Field label="ABOUT THE COMPANY" full hint="One or two lines the AI may rely on. It will not invent facts beyond this and your brief."><textarea style={{ minHeight: 84 }} value={f.about} maxLength={600} placeholder="Recruitment and HR services for companies across India." onChange={set('about')} disabled={!can} /></Field>
            <Field label="WEBSITE" hint="Starts with https://"><input value={f.website} maxLength={200} placeholder="https://www.example.com" onChange={set('website')} disabled={!can} /></Field>
            <Field label="CONTACT LINE" hint="A phone or an email the AI may use."><input value={f.contact} maxLength={120} placeholder="+91 90000 00000 · hr@example.com" onChange={set('contact')} disabled={!can} /></Field>
          </div>
        </Panel>

        <Panel title="Look and feel" sub="For the AI image and video makers, and for this preview.">
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ width: 88, height: 88, borderRadius: 12, border: '1px dashed var(--line)', display: 'grid', placeItems: 'center', background: '#fff', overflow: 'hidden' }}>
              {logo ? <img src={logo.dataUrl} alt={`${f.brandName || 'Brand'} logo`} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} /> : <span style={{ fontSize: 10, color: 'var(--muted)', textAlign: 'center' }}>No logo yet</span>}
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={pickLogo} />
              <Btn small disabled={!can || logoBusy} onClick={() => fileRef.current && fileRef.current.click()}>{logoBusy ? 'Saving…' : logo ? 'Change logo' : 'Upload logo'}</Btn>
              {logo && can ? <TinyBtn disabled={logoBusy} onClick={() => setAskRemove(true)}>Remove logo</TinyBtn> : null}
              <span style={{ fontSize: 10, color: 'var(--muted)' }}>PNG, JPG or WebP, under 300 KB. Saved at once.</span>
            </div>
          </div>
          <div className="form-grid" style={{ marginTop: 12 }}>
            {[['primary', 'MAIN COLOUR'], ['secondary', 'SECOND COLOUR'], ['accent', 'ACCENT (BUTTONS)']].map(([k, label]) => (
              <Field key={k} label={label}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="color" value={f.colors[k]} onChange={(e) => setColor(k, e.target.value)} disabled={!can} aria-label={label} style={{ width: 38, height: 30, padding: 0, border: 'none', background: 'none' }} />
                  <input value={f.colors[k]} maxLength={7} onChange={(e) => setColor(k, e.target.value)} disabled={!can} aria-label={`${label} code`} style={{ width: 90 }} />
                </div>
              </Field>
            ))}
          </div>
          {/* what a post or video frame in these colours looks like */}
          <div style={{ marginTop: 12, borderRadius: 12, padding: 16, color: '#fff', background: `linear-gradient(135deg, ${f.colors.primary}, ${f.colors.secondary})` }} aria-label="Brand preview">
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              {logo ? <img src={logo.dataUrl} alt="" style={{ width: 34, height: 34, objectFit: 'contain', background: '#fff', borderRadius: 8, padding: 3 }} /> : null}
              <b style={{ fontSize: 15 }}>{f.brandName || 'Your brand'}</b>
            </div>
            <div style={{ fontSize: 12, marginTop: 6, opacity: 0.92 }}>{f.tagline || 'Your tagline appears here.'}</div>
            <span style={{ display: 'inline-block', marginTop: 10, padding: '6px 12px', borderRadius: 20, background: f.colors.accent, color: '#111', fontSize: 11, fontWeight: 800 }}>{f.cta || 'Call to action'}</span>
          </div>
        </Panel>
      </div>

      <div className="mk-two" style={{ marginTop: 14 }}>
        <Panel title="Who you talk to and what you say" sub="The AI uses these when they fit the brief.">
          <div className="form-grid">
            <Field label="WHO WE TALK TO" full hint="For example: job seekers in healthcare and IT, and HR heads of hospitals."><textarea style={{ minHeight: 60 }} value={f.audience} maxLength={300} onChange={set('audience')} disabled={!can} /></Field>
            <Field label={<>INDUSTRIES WE HIRE FOR <Count n={words(f.industries).length} max={L.industries} /></>} full hint="Separated by commas."><input value={f.industries} onChange={set('industries')} placeholder="Medical, IT, Education, Manufacturing" disabled={!can} /></Field>
            <Field label={<>KEY MESSAGES <Count n={rows(f.keyMessages).length} max={L.keyMessages} /></>} full hint={`One per line, up to ${L.keyMessageChars} characters each. What makes you different.`}><textarea style={{ minHeight: 84 }} value={f.keyMessages} onChange={set('keyMessages')} placeholder={'Verified candidates within 7 days\nReplacement guarantee'} disabled={!can} /></Field>
          </div>
        </Panel>
        <Panel title="Social media" sub="Your pages and hashtags. The Content Calendar and social posts use them.">
          <div className="form-grid">
            <Field label="FACEBOOK PAGE"><input value={f.socials.facebook} maxLength={120} onChange={setSocial('facebook')} placeholder="facebook.com/yourpage" disabled={!can} /></Field>
            <Field label="INSTAGRAM"><input value={f.socials.instagram} maxLength={120} onChange={setSocial('instagram')} placeholder="@yourbrand" disabled={!can} /></Field>
            <Field label="LINKEDIN PAGE"><input value={f.socials.linkedin} maxLength={120} onChange={setSocial('linkedin')} placeholder="linkedin.com/company/yourbrand" disabled={!can} /></Field>
            <Field label="X (TWITTER)"><input value={f.socials.x} maxLength={120} onChange={setSocial('x')} placeholder="@yourbrand" disabled={!can} /></Field>
            <Field label={<>BRAND HASHTAGS <Count n={tagWords(f.hashtags).length} max={L.hashtags} /></>} full hint="Separated by spaces. Used only on Instagram and LinkedIn."><input value={f.hashtags} onChange={set('hashtags')} placeholder="#Hiring #JobsInHyderabad" disabled={!can} /></Field>
          </div>
        </Panel>
      </div>

      <div className="mk-two" style={{ marginTop: 14 }}>
        <Panel title="How you write" sub="Told to the AI on every message.">
          <div className="form-grid">
            <Field label="HOW WE SOUND" full hint="For example: warm, clear, no jargon, short sentences."><textarea style={{ minHeight: 70 }} value={f.voice} maxLength={400} onChange={set('voice')} disabled={!can} /></Field>
            <Field label="DEFAULT TONE"><select value={f.tone} onChange={set('tone')} disabled={!can}>{data.tones.map((t) => <option key={t}>{t}</option>)}</select></Field>
            <Field label="DEFAULT LANGUAGE"><select value={f.language} onChange={set('language')} disabled={!can}>{data.languages.map((t) => <option key={t}>{t}</option>)}</select></Field>
            <Field label="EMOJI"><select value={f.emoji} onChange={set('emoji')} disabled={!can}>{(data.emoji || ['none', 'few', 'many']).map((t) => <option key={t} value={t}>{EMOJI_WORDS[t] || t}</option>)}</select></Field>
            <Field label="DEFAULT CALL TO ACTION"><input value={f.cta} maxLength={80} placeholder="Reply YES to talk to us" onChange={set('cta')} disabled={!can} /></Field>
            <Field label="EMAIL SIGN-OFF"><input value={f.signOff} maxLength={80} placeholder="Team TeamLink" onChange={set('signOff')} disabled={!can} /></Field>
            <Field label="EMAIL DISCLAIMER" full hint="Optional. Added word for word at the end of every email."><input value={f.disclaimer} maxLength={300} placeholder="We never ask candidates for money." onChange={set('disclaimer')} disabled={!can} /></Field>
          </div>
        </Panel>
        <Panel title="Words and examples" sub="Checked on every text the AI writes.">
          <div className="form-grid">
            <Field label={<>WORDS TO USE <Count n={words(f.doWords).length} max={L.doWords} /></>} full hint="One per line or separated by commas."><textarea style={{ minHeight: 70 }} value={f.doWords} onChange={set('doWords')} placeholder={'talent\npartner'} disabled={!can} /></Field>
            <Field label={<>NEVER USE THESE WORDS <Count n={words(f.avoidWords).length} max={L.avoidWords} /></>} full hint="The AI is told not to use them, and any that slip in are flagged before approval."><textarea style={{ minHeight: 70 }} value={f.avoidWords} onChange={set('avoidWords')} placeholder={'guarantee\nfree'} disabled={!can} /></Field>
            <Field label={<>EXAMPLES OF OUR WRITING <Count n={blocks(f.samples).length} max={L.samples} /></>} full hint={`Separate them with a blank line. Up to ${L.sampleChars} characters each.`}><textarea style={{ minHeight: 120 }} value={f.samples} onChange={set('samples')} placeholder="We find the right people, fast." disabled={!can} /></Field>
          </div>
          {blocks(f.samples).some((x) => x.length > L.sampleChars) ? <div className="mk-flag">An example is longer than {L.sampleChars} characters: it will be shortened when you save.</div> : null}
        </Panel>
      </div>

      <Panel title="Try the voice" sub="The AI writes one short introduction in the saved brand voice, so you can hear how it sounds. It uses one AI request." style={{ marginTop: 14 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Btn disabled={trialBusy || !can || dirty || !b.brandName || !(meta && aiReady(meta.ai))} onClick={tryVoice}>{trialBusy ? 'Writing…' : '✦ Write a sample'}</Btn>
          <span style={{ fontSize: 10, color: 'var(--muted)' }}>{!can ? 'Your login cannot use AI writing.' : dirty ? 'Save your changes first: the sample uses the saved voice.' : !b.brandName ? 'Save a brand name first.' : meta && !aiReady(meta.ai) ? 'The AI is not ready (see AI Content for the reason).' : ''}</span>
        </div>
        {trial && trial.error ? <Banner tone="error">{trial.error}</Banner> : null}
        {trial && trial.variants && trial.variants[0] ? <div style={{ marginTop: 10 }}><TextsPreview chans={chans} texts={trial.variants[0].texts} subject={trial.variants[0].subject} />{trial.ai && trial.ai.demo ? <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 6 }}>Written by the test sandbox sample writer.</div> : null}</div> : null}
      </Panel>

      <div className="mk-preview" style={{ marginTop: 14 }}>
        <b style={{ fontSize: 11 }}>What the AI will be told</b>
        <pre>{[
          `Company: ${f.brandName || '—'}${f.tagline ? ` (${f.tagline})` : ''}`, f.voice ? `Voice: ${f.voice}` : '', `Tone: ${f.tone} · Language: ${f.language} · Emoji: ${EMOJI_WORDS[f.emoji] || f.emoji}`,
          f.audience ? `Talks to: ${f.audience}` : '', rows(f.keyMessages).length ? `Key messages: ${rows(f.keyMessages).join(' | ')}` : '',
          words(f.doWords).length ? `Use: ${words(f.doWords).join(', ')}` : '', words(f.avoidWords).length ? `Never use: ${words(f.avoidWords).join(', ')}` : '',
          f.website || f.contact ? `Own details: ${[f.website, f.contact].filter(Boolean).join(' · ')}` : '', tagWords(f.hashtags).length ? `Hashtags (Instagram, LinkedIn): ${tagWords(f.hashtags).join(' ')}` : '',
        ].filter(Boolean).join('\n')}</pre>
      </div>
      {b.updatedAt ? <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 10 }}>Last saved {fmtDateTime(b.updatedAt)}{b.updatedByName ? ` by ${b.updatedByName}` : ''}.</div> : null}
      {askRemove ? <ConfirmModal danger title="Remove the logo?" text="The image and video makers will have no logo until you upload one again." yes="Remove logo" onNo={() => setAskRemove(false)} onYes={removeLogo} /> : null}
    </div>
  );
}
