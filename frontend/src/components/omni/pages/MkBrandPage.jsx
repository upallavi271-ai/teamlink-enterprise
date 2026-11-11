import { useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, Panel, Banner, Field, fmtDateTime } from '../ui.jsx';
import '../marketing/marketing.css';

// AI MARKETING > BRAND VOICE: how the company sounds. Every AI request is told this; the "never use" words are checked on every text the AI writes.
const lines = (v) => (Array.isArray(v) ? v.join('\n') : '');
export default function MkBrandPage() {
  const { toast } = useOmni();
  const [data, setData] = useState(null);
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    omni.get('/gs/marketing/brand').then((d) => {
      setData(d); const b = d.brand;
      setF({ brandName: b.brandName, about: b.about, voice: b.voice, tone: b.tone, language: b.language, cta: b.cta, signOff: b.signOff, doWords: lines(b.doWords), avoidWords: lines(b.avoidWords), samples: (b.samples || []).join('\n\n') });
    }).catch((e) => setErr(errOf(e, 'The brand voice could not be read.')));
  }, []);
  if (err && !data) return <Banner tone="error">{err}</Banner>;
  if (!data || !f) return <div className="card panel">Loading…</div>;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const r = await omni.put('/gs/marketing/brand', f);
      setData({ ...data, brand: r.brand }); toast(r.ok || 'Brand voice saved');
    } catch (e) { const m = errOf(e, 'It could not be saved.'); setErr(m); toast(m); } finally { setBusy(false); }
  };
  const b = data.brand;
  const words = (v) => String(v || '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="Brand voice" lead="Tell the AI how your company sounds. It follows this on every message it writes.">
        <Btn primary disabled={busy || !data.canEdit} onClick={save}>💾 Save brand voice</Btn>
      </PageHead>
      {err ? <Banner tone="error">{err}</Banner> : null}
      {!data.canEdit ? <Banner tone="info">Your login can read the brand voice but not change it.</Banner> : null}
      <div className="mk-two">
        <Panel title="Who you are" sub="Short and plain is best.">
          <div className="form-grid">
            <Field label="BRAND NAME" full><input value={f.brandName} maxLength={80} placeholder="TeamLink" onChange={set('brandName')} disabled={!data.canEdit} /></Field>
            <Field label="ABOUT THE COMPANY" full hint="One or two lines the AI may rely on. It will not invent facts beyond this and your brief."><textarea style={{ minHeight: 84 }} value={f.about} maxLength={600} placeholder="Recruitment and HR services for companies across India." onChange={set('about')} disabled={!data.canEdit} /></Field>
            <Field label="HOW WE SOUND" full hint="For example: warm, clear, no jargon, short sentences."><textarea style={{ minHeight: 70 }} value={f.voice} maxLength={400} onChange={set('voice')} disabled={!data.canEdit} /></Field>
            <Field label="DEFAULT TONE"><select value={f.tone} onChange={set('tone')} disabled={!data.canEdit}>{data.tones.map((t) => <option key={t}>{t}</option>)}</select></Field>
            <Field label="DEFAULT LANGUAGE"><select value={f.language} onChange={set('language')} disabled={!data.canEdit}>{data.languages.map((t) => <option key={t}>{t}</option>)}</select></Field>
            <Field label="DEFAULT CALL TO ACTION"><input value={f.cta} maxLength={80} placeholder="Reply YES to talk to us" onChange={set('cta')} disabled={!data.canEdit} /></Field>
            <Field label="EMAIL SIGN-OFF"><input value={f.signOff} maxLength={80} placeholder="Team TeamLink" onChange={set('signOff')} disabled={!data.canEdit} /></Field>
          </div>
        </Panel>
        <Panel title="Words and examples" sub="Checked on every text the AI writes.">
          <div className="form-grid">
            <Field label="WORDS TO USE" full hint="One per line or separated by commas."><textarea style={{ minHeight: 70 }} value={f.doWords} onChange={set('doWords')} placeholder={'talent\npartner'} disabled={!data.canEdit} /></Field>
            <Field label="NEVER USE THESE WORDS" full hint="The AI is told not to use them, and any that slip in are flagged before approval."><textarea style={{ minHeight: 70 }} value={f.avoidWords} onChange={set('avoidWords')} placeholder={'guarantee\nfree'} disabled={!data.canEdit} /></Field>
            <Field label="EXAMPLES OF OUR WRITING · up to 3, separate with a blank line" full><textarea style={{ minHeight: 120 }} value={f.samples} onChange={set('samples')} placeholder="We find the right people, fast." disabled={!data.canEdit} /></Field>
          </div>
          <div className="mk-preview" style={{ marginTop: 12 }}>
            <b style={{ fontSize: 11 }}>What the AI will be told</b>
            <pre>{[`Company: ${f.brandName || '—'}`, f.voice ? `Voice: ${f.voice}` : '', `Tone: ${f.tone} · Language: ${f.language}`, words(f.doWords).length ? `Use: ${words(f.doWords).join(', ')}` : '', words(f.avoidWords).length ? `Never use: ${words(f.avoidWords).join(', ')}` : ''].filter(Boolean).join('\n')}</pre>
          </div>
          {b.updatedAt ? <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 10 }}>Last saved {fmtDateTime(b.updatedAt)}{b.updatedByName ? ` by ${b.updatedByName}` : ''}.</div> : null}
        </Panel>
      </div>
    </div>
  );
}
