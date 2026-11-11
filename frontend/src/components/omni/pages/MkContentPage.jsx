import { useCallback, useEffect, useRef, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Panel, Banner, Field, Tabs, Empty, Tag, ConfirmModal, fmtDateTime } from '../ui.jsx';
import { useMkMeta, MkStatus, AiBanner, TextsEditor, aiLabel } from '../marketing/mk.jsx';

// AI MARKETING > AI CONTENT (module 1): a short brief -> up to three versions per channel in the brand voice -> pick / edit / rewrite one message ->
// save -> ask for approval. Only approved words reach the Content Library (and so the campaign screens). Nothing is sent or posted from here.
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const autoTitle = (brief) => String(brief || '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ').slice(0, 70);
const fromItem = (it) => ({ id: it.id, title: it.title, channels: it.channels, texts: it.texts, subject: it.subject, status: it.status, note: it.note, decidedByName: it.decidedByName, ai: it.ai, variants: it.variants, canEdit: it.canEdit, canSubmit: it.canSubmit, inLibrary: it.inLibrary, libraryId: it.libraryId, tone: it.tone, language: it.language });
const BLANK = { brief: '', goal: 'Awareness', audience: '', cta: '', tone: '', language: '', channels: ['whatsapp', 'sms', 'email'], variants: 3 };

export default function MkContentPage() {
  const { acc, go, toast } = useOmni();
  const { meta, err } = useMkMeta();
  const [brand, setBrand] = useState(null);
  const [form, setForm] = useState(BLANK);
  const [gen, setGen] = useState(null);
  const [busyGen, setBusyGen] = useState(false);
  const [ed, setEd] = useState(null);
  const [list, setList] = useState(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState('');
  const [reviseBusy, setReviseBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [del, setDel] = useState(null);
  const edRef = useRef(null);

  const load = useCallback(() => omni.get('/gs/marketing/items').then(setList).catch((e) => setMsg(errOf(e, 'The saved content could not be read.'))), []);
  useEffect(() => { load(); omni.get('/gs/marketing/brand').then((b) => setBrand(b.brand)).catch(() => setBrand({ brandName: '', avoidWords: [] })); }, [load]);
  if (err) return <Banner tone="error">{err}</Banner>;
  if (!meta || !brand || !list) return <div className="card panel">Loading…</div>;

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const toggle = (k) => setForm({ ...form, channels: form.channels.includes(k) ? form.channels.filter((x) => x !== k) : [...form.channels, k] });
  const flagsOf = (key, text) => (brand.avoidWords || []).filter((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(w)}($|[^\\p{L}\\p{N}])`, 'iu').test(text || ''));
  const chansOf = (keys) => meta.channels.filter((c) => (keys || []).includes(c.key));
  const locked = !!(ed && ed.id && !ed.canEdit);

  const write = async () => {
    setBusyGen(true); setMsg(''); setGen(null);
    try {
      const r = await omni.post('/gs/marketing/generate', { ...form, itemId: ed && ed.id ? ed.id : undefined });
      setGen({ ...r, channels: form.channels }); toast('The AI versions are ready');
    } catch (e) { const m = errOf(e, 'The AI could not write it.'); setMsg(m); toast(m); } finally { setBusyGen(false); }
  };
  const useVersion = (v) => {
    if (locked) { toast('This content is waiting for approval and cannot be changed now'); return; }
    setEd((cur) => ({
      ...(cur && cur.id ? cur : { id: '', status: 'draft', note: '', canEdit: true, canSubmit: true }),
      title: (cur && cur.title) || autoTitle(form.brief), channels: gen.channels, texts: { ...v.texts }, subject: v.subject || '', ai: gen.ai, variants: gen.variants, tone: gen.used && gen.used.tone, language: gen.used && gen.used.language,
    }));
    setTimeout(() => { if (edRef.current) edRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
  };
  const open = (it) => {
    setEd(fromItem(it)); setGen(null); setMsg('');
    setForm((f) => ({ ...f, brief: it.brief || f.brief, goal: it.goal || f.goal, audience: it.audience || '', cta: it.cta || '', tone: it.tone || '', language: it.language || '', channels: it.channels.length ? it.channels : f.channels }));
    setTimeout(() => { if (edRef.current) edRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
  };
  const revise = async (channel, instruction) => {
    setReviseBusy(true); setMsg('');
    try {
      const r = await omni.post('/gs/marketing/revise', { channel, text: ed.texts[channel], instruction, itemId: ed.id || undefined });
      setEd((cur) => ({ ...cur, texts: { ...cur.texts, [channel]: r.text } })); toast('Rewritten. Read it, then save.');
    } catch (e) { const m = errOf(e, 'The AI could not rewrite it.'); setMsg(m); toast(m); } finally { setReviseBusy(false); }
  };
  const save = async (andSubmit) => {
    if (!ed.title.trim()) { toast('Give this content a name first'); return; }
    const bad = chansOf(ed.channels).find((c) => (ed.texts[c.key] || '').length > c.limit);
    if (bad) { toast(`The ${bad.label} version is over its limit`); return; }
    const withFlags = chansOf(ed.channels).find((c) => flagsOf(c.key, ed.texts[c.key]).length);
    if (andSubmit && withFlags && !window.confirm(`The ${withFlags.label} message has words your brand voice says never to use. Ask for approval anyway?`)) return;
    setBusy(andSubmit ? 'submit' : 'save'); setMsg('');
    try {
      const body = { title: ed.title.trim(), brief: form.brief, goal: form.goal, audience: form.audience, cta: form.cta, tone: ed.tone || form.tone, language: ed.language || form.language, channels: ed.channels, texts: ed.texts, subject: ed.subject || '', variants: ed.variants || [], ai: ed.ai };
      const r = ed.id ? await omni.put(`/gs/marketing/items/${ed.id}`, body) : await omni.post('/gs/marketing/items', body);
      let item = r.item;
      if (andSubmit) { const s = await omni.post(`/gs/marketing/items/${item.id}/submit`); item = s.item; toast(s.ok); } else toast(r.withdrawn ? 'Saved. The earlier approval was withdrawn: ask for approval again.' : 'Saved');
      setEd(fromItem(item)); await load();
    } catch (e) { const m = errOf(e, 'It could not be saved.'); setMsg(m); toast(m); } finally { setBusy(''); }
  };
  const submitFromList = async (it) => {
    setBusy(it.id);
    try { const s = await omni.post(`/gs/marketing/items/${it.id}/submit`); toast(s.ok); if (ed && ed.id === it.id) setEd(fromItem(s.item)); await load(); } catch (e) { toast(errOf(e, 'It could not be sent.')); } finally { setBusy(''); }
  };
  const remove = async () => {
    const it = del; setDel(null);
    try { await omni.del(`/gs/marketing/items/${it.id}`); toast('Deleted'); if (ed && ed.id === it.id) setEd(null); await load(); } catch (e) { toast(errOf(e, 'It could not be deleted.')); }
  };

  const items = list.items;
  const shown = filter ? items.filter((i) => i.status === filter) : items;
  const cnt = (s) => items.filter((i) => i.status === s).length;
  const edChans = ed ? chansOf(ed.channels) : [];

  return (
    <div>
      <PageHead eyebrow="AI Marketing · module 1" title="AI Content" lead="Write a short brief. The AI writes up to three versions for each channel in your brand voice. You choose, edit, and ask for approval.">
        <Btn onClick={() => { setEd(null); setGen(null); setForm(BLANK); setMsg(''); }}>+ New</Btn>
      </PageHead>
      <AiBanner ai={meta.ai} />
      {!brand.brandName && <Banner tone="warn"><b>The brand voice is not set yet.</b> The AI writes in it, so set it first. <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={() => go('mkbrand')}>Set up the brand voice →</button></Banner>}
      {msg ? <Banner tone="error">{msg}</Banner> : null}

      <div className="mk-two">
        <Panel title="1 · The brief" sub={brand.brandName ? `Writing for ${brand.brandName}` : undefined}>
          <div className="form-grid">
            <Field label="WHAT IS THIS MESSAGE ABOUT?" full hint="Give the facts: what, when, where, for whom. The AI will not invent prices, dates or links."><textarea style={{ minHeight: 110 }} value={form.brief} maxLength={1500} onChange={set('brief')} placeholder="We are running a walk-in hiring drive for engineers in Hyderabad this Saturday, 10 am to 4 pm. Bring your resume." /></Field>
            <Field label="GOAL"><select value={form.goal} onChange={set('goal')}>{meta.goals.map((g) => <option key={g}>{g}</option>)}</select></Field>
            <Field label="WHO IS IT FOR?"><input value={form.audience} maxLength={200} onChange={set('audience')} placeholder="Engineers with 2+ years" /></Field>
            <Field label="CALL TO ACTION"><input value={form.cta} maxLength={80} onChange={set('cta')} placeholder={brand.cta || 'Reply YES to register'} /></Field>
            <Field label="TONE"><select value={form.tone} onChange={set('tone')}><option value="">Brand default ({brand.tone || 'Warm & confident'})</option>{meta.tones.map((t) => <option key={t}>{t}</option>)}</select></Field>
            <Field label="LANGUAGE"><select value={form.language} onChange={set('language')}><option value="">Brand default ({brand.language || 'English'})</option>{meta.languages.map((t) => <option key={t}>{t}</option>)}</select></Field>
            <Field label="HOW MANY VERSIONS"><select value={form.variants} onChange={(e) => setForm({ ...form, variants: Number(e.target.value) })}>{[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}</select></Field>
            <Field label="CHANNELS" full hint="WhatsApp, SMS and RCS get the opt-out line and email gets the unsubscribe tag automatically. Social is saved text only: nothing is posted from here.">
              <div className="mk-ch-pick">{meta.channels.map((c) => <label key={c.key} className={form.channels.includes(c.key) ? 'on' : ''}><input type="checkbox" checked={form.channels.includes(c.key)} onChange={() => toggle(c.key)} />{c.label}</label>)}</div>
            </Field>
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Btn primary disabled={busyGen || !meta.canWrite || form.brief.trim().length < 10 || !form.channels.length || !brand.brandName} onClick={write}>{busyGen ? 'Writing…' : '✦ Write with AI'}</Btn>
            <span style={{ fontSize: 10, color: 'var(--muted)' }}>{form.brief.trim().length < 10 ? 'Write at least a sentence.' : !form.channels.length ? 'Pick at least one channel.' : ''}</span>
          </div>
        </Panel>

        <Panel title="2 · The AI versions" sub={gen ? `Written by ${aiLabel(gen.ai)} in ${gen.ai.ms} ms · ${gen.used.tone} · ${gen.used.language}` : 'Press "Write with AI" to see them here.'}>
          {!gen ? <Empty title={busyGen ? 'The AI is writing…' : 'No versions yet'}>{busyGen ? 'This can take a few seconds.' : 'Each version takes a different angle. Pick the one you like, then edit it below.'}</Empty> : (
            <div className="mk-variants">
              {gen.variants.map((v) => {
                const first = chansOf(gen.channels).find((c) => v.texts[c.key]);
                const fl = [...new Set(Object.values(v.flags || {}).flat())];
                return (
                  <div className={`mk-var${ed && ed.texts && first && ed.texts[first.key] === v.texts[first.key] ? ' on' : ''}`} key={v.id}>
                    <b>{v.angle}</b>
                    {first && <div className="mk-var-text">{first.label}: {v.texts[first.key]}</div>}
                    <small style={{ color: 'var(--muted)', fontSize: 10 }}>{Object.keys(v.texts).length} channel version{Object.keys(v.texts).length === 1 ? '' : 's'}</small>
                    {fl.length > 0 && <div className="mk-flag">Never-use words: <b>{fl.join(', ')}</b></div>}
                    <Btn small primary onClick={() => useVersion(v)}>Use this version</Btn>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      </div>

      {ed && (
        <div ref={edRef} style={{ marginTop: 14 }}>
          <Panel title="3 · Edit, save and ask for approval" sub={ed.id ? 'This content is saved.' : 'Not saved yet.'} right={ed.id ? <MkStatus status={ed.status} /> : null}>
            {ed.status === 'changes' && ed.note ? <div className="mk-note">Sent back{ed.decidedByName ? ` by ${ed.decidedByName}` : ''}: {ed.note}</div> : null}
            {ed.status === 'waiting' ? <Banner tone="info">This content is waiting for approval, so it cannot be changed now.</Banner> : null}
            {ed.status === 'approved' ? <div className="mk-note ok">Approved{ed.decidedByName ? ` by ${ed.decidedByName}` : ''} and in the Content Library. If you change it, the approval is withdrawn and you must ask again.</div> : null}
            <div className="form-grid" style={{ marginBottom: 10 }}>
              <Field label="NAME OF THIS CONTENT" full><input value={ed.title} maxLength={80} disabled={locked} onChange={(e) => setEd({ ...ed, title: e.target.value })} placeholder="Hyderabad walk-in drive" /></Field>
            </div>
            <TextsEditor chans={edChans} texts={ed.texts} subject={ed.subject} onTexts={(t) => setEd({ ...ed, texts: t })} onSubject={(s) => setEd({ ...ed, subject: s })} flagsOf={flagsOf} readOnly={locked || !meta.canWrite} onRevise={revise} reviseBusy={reviseBusy} />
            {ed.ai && ed.ai.provider ? <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 10 }}>First written by {aiLabel(ed.ai)}. Everything you change by hand is yours.</div> : null}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
              <Btn disabled={!!busy || locked || !meta.canWrite} onClick={() => save(false)}>{busy === 'save' ? 'Saving…' : '💾 Save'}</Btn>
              <Btn primary disabled={!!busy || locked || !meta.canWrite || ed.status === 'approved'} onClick={() => save(true)}>{busy === 'submit' ? 'Sending…' : 'Save and ask for approval →'}</Btn>
              {ed.status === 'approved' && ed.libraryId && acc && acc.pages && acc.pages.includes('campaigns') ? <Btn onClick={() => go('campaigns', { content: ed.libraryId })}>Use in a campaign →</Btn> : null}
            </div>
          </Panel>
        </div>
      )}

      <Panel title="Your AI content" sub="Saved content and where it stands" style={{ marginTop: 14 }} right={<span className="pill live">{items.length} item{items.length === 1 ? '' : 's'}</span>}>
        <Tabs value={filter} onChange={setFilter} tabs={[['', 'All', items.length], ['draft', 'Saved', cnt('draft')], ['waiting', 'Waiting', cnt('waiting')], ['changes', 'Changes needed', cnt('changes')], ['approved', 'Approved', cnt('approved')]]} />
        {shown.length === 0 ? <Empty title="Nothing here yet">{items.length ? 'Nothing with that status.' : 'Write a brief above and press “Write with AI”.'}</Empty> : shown.map((it) => (
          <div className="mk-row" key={it.id}>
            <div>
              <b>{it.title}</b> <MkStatus status={it.status} />{it.inLibrary ? <> <Tag green title="Approved words are in the Content Library for campaigns">In the Content Library</Tag></> : null}
              <small>{chansOf(it.channels).map((c) => c.label).join(' · ')} · saved {fmtDateTime(it.updatedAt)}{!it.mine && it.createdByName ? ` · by ${it.createdByName}` : ''}{it.department ? ` · ${it.department}` : ''}{it.ai && it.ai.demo ? ' · sample writer' : ''}</small>
              {it.status === 'changes' && it.note ? <div className="mk-note">Sent back by {it.decidedByName}: {it.note}</div> : null}
            </div>
            <div className="mk-acts">
              <TinyBtn onClick={() => open(it)}>{it.canEdit ? '✎ Open' : '👁 Look'}</TinyBtn>
              {it.canSubmit ? <TinyBtn disabled={busy === it.id} onClick={() => submitFromList(it)}>Ask for approval</TinyBtn> : null}
              {it.canDelete ? <TinyBtn onClick={() => setDel(it)} title="Delete" aria-label={`Delete ${it.title}`}>🗑</TinyBtn> : null}
            </div>
          </div>
        ))}
      </Panel>
      {del ? <ConfirmModal danger title={`Delete "${del.title}"?`} text={del.status === 'approved' ? 'It is also taken out of the Content Library. Campaigns already made from it keep their words.' : 'It is removed from your AI content.'} yes="Delete" onNo={() => setDel(null)} onYes={remove} /> : null}
    </div>
  );
}
