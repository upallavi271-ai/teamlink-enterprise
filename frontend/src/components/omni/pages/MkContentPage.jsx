import { useCallback, useEffect, useRef, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { getState } from '../omniStore.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Panel, Banner, Field, Tabs, Empty, Tag, ConfirmModal, fmtDateTime } from '../ui.jsx';
import { useMkMeta, MkStatus, AiBanner, TextsEditor, TextsPreview, aiLabel, aiReady, ClientChip } from '../marketing/mk.jsx';
import ClientReviewModal from '../marketing/ClientReviewModal.jsx';

// AI MARKETING > AI CONTENT (module 1): a short brief -> up to three versions per channel in the brand voice -> pick / edit / rewrite one message ->
// save -> ask for approval. Only approved words reach the Content Library (and so the campaign screens). Nothing is sent or posted from here.
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const autoTitle = (brief) => String(brief || '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ').slice(0, 70);
const fromItem = (it) => ({ id: it.id, title: it.title, channels: it.channels, texts: it.texts, subject: it.subject, status: it.status, note: it.note, decidedByName: it.decidedByName, ai: it.ai, variants: it.variants, canEdit: it.canEdit, canSubmit: it.canSubmit, inLibrary: it.inLibrary, libraryId: it.libraryId, tone: it.tone, language: it.language });
const BLANK = { brief: '', goal: 'Awareness', audience: '', cta: '', tone: '', language: '', channels: ['whatsapp', 'sms', 'email'], variants: 3 };
// ready-made briefs for the messages a staffing company sends most; the [square brackets] are for the facts only the writer knows
const STARTERS = [
  { label: 'Job opening', goal: 'Hiring', audience: 'Candidates with the right skills', cta: 'Reply YES to apply', brief: 'We are hiring a [job title] for [company / client type] in [city]. Experience: [years]. Salary: [range]. Apply by [date].' },
  { label: 'Walk-in drive', goal: 'Event / webinar', audience: 'Job seekers in [city]', cta: 'Reply YES to register', brief: 'Walk-in hiring drive for [roles] at [venue, city] on [day, date], [start time] to [end time]. Bring your resume and an ID proof.' },
  { label: 'Interview reminder', goal: 'Reminder / follow-up', audience: 'Shortlisted candidates', cta: 'Reply YES to confirm', brief: 'Reminder: your interview for [job title] with [client] is on [date] at [time], [online link / address]. Keep your resume ready.' },
  { label: 'Joining welcome', goal: 'Announcement', audience: 'Candidates who accepted the offer', cta: '', brief: 'Congratulations on joining [client] as [job title] on [date]. Report at [address] at [time] with [documents].' },
  { label: 'Client outreach', goal: 'Lead generation', audience: 'HR heads at [industry] companies', cta: 'Reply to book a 15-minute call', brief: 'We help [industry] companies hire [roles] in [time frame], with a [replacement guarantee / no hire, no fee] promise.' },
];
// what "unsaved changes" compares: the words a person can lose
const snap = (e) => (e ? JSON.stringify([e.title, e.texts, e.subject, e.channels]) : '');

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
  const [edBase, setEdBase] = useState(''); // the editor as it was last saved / opened ('' = never saved)
  const [picked, setPicked] = useState(''); // the AI version now in the editor
  const [undo, setUndo] = useState(null); // { channel, text } before the last AI rewrite
  const [leave, setLeave] = useState(null); // { go: fn } waiting for "leave without saving?"
  const [flagAsk, setFlagAsk] = useState(''); // channel label with never-use words, waiting for "ask for approval anyway?"
  const [toClient, setToClient] = useState(null); // the item being sent to a client
  const [q, setQ] = useState('');
  const [onlyMine, setOnlyMine] = useState(false);
  const edRef = useRef(null);
  const dirty = !!ed && (ed.canEdit !== false) && snap(ed) !== edBase;
  // closing the tab with unsaved words asks first (the browser's own question)
  useEffect(() => {
    if (!dirty) return undefined;
    const h = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);
  const guard = (fn) => { if (dirty) setLeave({ go: fn }); else fn(); };

  const [loadErr, setLoadErr] = useState('');
  const load = useCallback(() => omni.get('/gs/marketing/items').then((l) => { setList(l); setLoadErr(''); }).catch((e) => setLoadErr(errOf(e, 'The saved content could not be read.'))), []);
  // a failed read is said as a failure: it is never shown as "the brand voice is not set" or as an empty list
  const loadBrand = useCallback(() => omni.get('/gs/marketing/brand').then((b) => setBrand(b.brand)).catch((e) => setLoadErr(errOf(e, 'The brand voice could not be read.'))), []);
  useEffect(() => { load(); loadBrand(); }, [load, loadBrand]);
  if (err) return <Banner tone="error">{err}</Banner>;
  if (!meta || !brand || !list) {
    if (loadErr) return <Banner tone="error">{loadErr} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={() => { setLoadErr(''); if (!list) load(); if (!brand) loadBrand(); }}>Try again</button></Banner>;
    return <div className="card panel">Loading…</div>;
  }

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
  const toEditor = () => setTimeout(() => { if (edRef.current) edRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
  const applyVersion = (v) => {
    setEd((cur) => ({
      ...(cur && cur.id ? cur : { id: '', status: 'draft', note: '', canEdit: true, canSubmit: true }),
      title: (cur && cur.title) || autoTitle(form.brief), channels: gen.channels, texts: { ...v.texts }, subject: v.subject || '', ai: gen.ai, variants: gen.variants, tone: gen.used && gen.used.tone, language: gen.used && gen.used.language,
    }));
    setPicked(v.id); setUndo(null); toEditor();
  };
  const useVersion = (v) => {
    if (locked) { toast('This content is waiting for approval and cannot be changed now'); return; }
    // switching between AI versions of the same brief is free; hand edits made to saved content ask first
    if (ed && ed.id && dirty) guard(() => applyVersion(v)); else applyVersion(v);
  };
  const openNow = (it) => {
    const e = fromItem(it);
    setEd(e); setEdBase(snap(e)); setGen(null); setMsg(''); setPicked(''); setUndo(null);
    setForm((f) => ({ ...f, brief: it.brief || f.brief, goal: it.goal || f.goal, audience: it.audience || '', cta: it.cta || '', tone: it.tone || '', language: it.language || '', channels: it.channels.length ? it.channels : f.channels }));
    toEditor();
  };
  const open = (it) => { if (ed && ed.id === it.id) { toEditor(); return; } guard(() => openNow(it)); };
  const startNew = () => guard(() => { setEd(null); setEdBase(''); setGen(null); setForm(BLANK); setMsg(''); setPicked(''); setUndo(null); });
  // a copy of any visible item becomes a new, unsaved draft (the copy needs its own approval)
  const copyItem = (it) => guard(() => {
    const e = { ...fromItem(it), id: '', status: 'draft', note: '', decidedByName: '', canEdit: true, canSubmit: true, inLibrary: false, libraryId: null, title: `${it.title} (copy)`.slice(0, 80) };
    setEd(e); setEdBase(''); setGen(null); setPicked(''); setUndo(null); setMsg('');
    setForm((f) => ({ ...f, brief: it.brief || f.brief, goal: it.goal || f.goal, audience: it.audience || '', cta: it.cta || '', channels: it.channels.length ? it.channels : f.channels }));
    toast('A copy is open below. Save it to keep it.'); toEditor();
  });
  const pickStarter = (s) => {
    if (form.brief.trim()) { toast('Clear the brief box first, then pick a starter'); return; }
    setForm((f) => ({ ...f, brief: s.brief, goal: s.goal, audience: s.audience, cta: s.cta }));
    toast('Starter filled in: replace the [square brackets] with your facts');
  };
  const revise = async (channel, instruction) => {
    setReviseBusy(true); setMsg('');
    try {
      const before = ed.texts[channel];
      const r = await omni.post('/gs/marketing/revise', { channel, text: before, instruction, itemId: ed.id || undefined });
      setEd((cur) => ({ ...cur, texts: { ...cur.texts, [channel]: r.text } })); setUndo({ channel, text: before }); toast('Rewritten. Read it, then save.');
    } catch (e) { const m = errOf(e, 'The AI could not rewrite it.'); setMsg(m); toast(m); } finally { setReviseBusy(false); }
  };
  const undoRevise = () => { if (!undo) return; setEd((cur) => ({ ...cur, texts: { ...cur.texts, [undo.channel]: undo.text } })); setUndo(null); toast('The AI rewrite was undone'); };
  const save = async (andSubmit, flagsOk = false) => {
    if (!ed.title.trim()) { toast('Give this content a name first'); return; }
    const bad = chansOf(ed.channels).find((c) => (ed.texts[c.key] || '').length > c.limit);
    if (bad) { toast(`The ${bad.label} version is over its limit`); return; }
    const withFlags = chansOf(ed.channels).find((c) => flagsOf(c.key, ed.texts[c.key]).length);
    if (andSubmit && withFlags && !flagsOk) { setFlagAsk(withFlags.label); return; }
    setBusy(andSubmit ? 'submit' : 'save'); setMsg('');
    try {
      // the workspace (department) picked in the switcher goes with new content, so that department's Team Lead can approve it
      const body = { title: ed.title.trim(), brief: form.brief, goal: form.goal, audience: form.audience, cta: form.cta, tone: ed.tone || form.tone, language: ed.language || form.language, channels: ed.channels, texts: ed.texts, subject: ed.subject || '', variants: ed.variants || [], ai: ed.ai, ...(!ed.id && getState().dept ? { department: getState().dept } : {}) };
      const r = ed.id ? await omni.put(`/gs/marketing/items/${ed.id}`, body) : await omni.post('/gs/marketing/items', body);
      let item = r.item;
      if (andSubmit) { const s = await omni.post(`/gs/marketing/items/${item.id}/submit`); item = s.item; toast(s.ok); } else toast(r.withdrawn ? 'Saved. The earlier approval was withdrawn: ask for approval again.' : 'Saved');
      const saved = fromItem(item); setEd(saved); setEdBase(snap(saved)); setUndo(null); await load();
    } catch (e) { const m = errOf(e, 'It could not be saved.'); setMsg(m); toast(m); } finally { setBusy(''); }
  };
  const submitFromList = async (it) => {
    setBusy(it.id);
    try { const s = await omni.post(`/gs/marketing/items/${it.id}/submit`); toast(s.ok); if (ed && ed.id === it.id) { const e = fromItem(s.item); setEd(e); setEdBase(snap(e)); } await load(); } catch (e) { toast(errOf(e, 'It could not be sent.')); } finally { setBusy(''); }
  };
  const remove = async () => {
    const it = del; setDel(null);
    try { await omni.del(`/gs/marketing/items/${it.id}`); toast('Deleted'); if (ed && ed.id === it.id) { setEd(null); setEdBase(''); } await load(); } catch (e) { toast(errOf(e, 'It could not be deleted.')); }
  };

  const items = list.items;
  const needle = q.trim().toLowerCase();
  const found = items.filter((i) => (!onlyMine || i.mine) && (!needle || `${i.title} ${i.brief || ''}`.toLowerCase().includes(needle)));
  const shown = filter ? found.filter((i) => i.status === filter) : found;
  const cnt = (s) => found.filter((i) => i.status === s).length;
  const edChans = ed ? chansOf(ed.channels) : [];

  return (
    <div>
      <PageHead eyebrow="AI Marketing · module 1" title="AI Content" lead="Write a short brief. The AI writes up to three versions for each channel in your brand voice. You choose, edit, and ask for approval.">
        <Btn onClick={startNew}>+ New</Btn>
      </PageHead>
      <AiBanner ai={meta.ai} />
      {!brand.brandName && <Banner tone="warn"><b>The brand voice is not set yet.</b> The AI writes in it, so set it first. <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={() => go('mkbrand')}>Set up the brand voice →</button></Banner>}
      {msg ? <Banner tone="error">{msg}</Banner> : null}
      {loadErr ? <Banner tone="error">{loadErr} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={() => { setLoadErr(''); load(); }}>Try again</button></Banner> : null}

      <div className="mk-two">
        <Panel title="1 · The brief" sub={brand.brandName ? `Writing for ${brand.brandName}` : undefined}>
          {meta.canWrite && (
            <div className="mk-revise" style={{ marginBottom: 10 }} aria-label="Brief starters">
              <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 700 }}>START FROM:</span>
              {STARTERS.map((s) => <TinyBtn key={s.label} onClick={() => pickStarter(s)} title={s.brief}>{s.label}</TinyBtn>)}
            </div>
          )}
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
            <Btn primary disabled={busyGen || !meta.canWrite || form.brief.trim().length < 10 || !form.channels.length || !brand.brandName || !aiReady(meta.ai)} onClick={write}>{busyGen ? 'Writing…' : '✦ Write with AI'}</Btn>
            <span style={{ fontSize: 10, color: 'var(--muted)' }}>{!meta.canWrite ? 'Your login can read AI content, not write it.' : !brand.brandName ? 'Set up the brand voice first.' : !aiReady(meta.ai) ? 'The AI is not ready: see the red note above.' : form.brief.trim().length < 10 ? 'Write at least a sentence.' : !form.channels.length ? 'Pick at least one channel.' : ''}</span>
          </div>
        </Panel>

        <Panel title="2 · The AI versions" sub={gen ? `Written by ${aiLabel(gen.ai)} in ${gen.ai.ms} ms · ${gen.used.tone} · ${gen.used.language}` : 'Press "Write with AI" to see them here.'}>
          {!gen ? <Empty title={busyGen ? 'The AI is writing…' : 'No versions yet'}>{busyGen ? 'This can take a few seconds.' : 'Each version takes a different angle. Pick the one you like, then edit it below.'}</Empty> : (
            <div className="mk-variants">
              {gen.variants.map((v) => {
                const fl = [...new Set(Object.values(v.flags || {}).flat())];
                const on = picked === v.id;
                return (
                  <div className={`mk-var${on ? ' on' : ''}`} key={v.id}>
                    <b>{v.angle}</b>
                    {/* every channel of this version, one tab each (not only the first channel) */}
                    <TextsPreview chans={chansOf(gen.channels)} texts={v.texts} subject={v.subject} />
                    <small style={{ color: 'var(--muted)', fontSize: 10 }}>{Object.keys(v.texts).length} channel version{Object.keys(v.texts).length === 1 ? '' : 's'}</small>
                    {fl.length > 0 && <div className="mk-flag">Never-use words: <b>{fl.join(', ')}</b></div>}
                    <Btn small primary={!on} onClick={() => useVersion(v)}>{on ? '✓ In the editor' : 'Use this version'}</Btn>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      </div>

      {ed && (
        <div ref={edRef} style={{ marginTop: 14 }}>
          <Panel title="3 · Edit, save and ask for approval" sub={!ed.id ? 'Not saved yet.' : dirty ? 'You have changes that are not saved.' : 'This content is saved.'} right={ed.id ? <MkStatus status={ed.status} /> : null}>
            {ed.status === 'changes' && ed.note ? <div className="mk-note">Sent back{ed.decidedByName ? ` by ${ed.decidedByName}` : ''}: {ed.note}</div> : null}
            {ed.status === 'waiting' ? <Banner tone="info">This content is waiting for approval, so it cannot be changed now.</Banner> : null}
            {ed.status === 'approved' ? <div className="mk-note ok">Approved{ed.decidedByName ? ` by ${ed.decidedByName}` : ''} and in the Content Library. If you change it, the approval is withdrawn and you must ask again.</div> : null}
            <div className="form-grid" style={{ marginBottom: 10 }}>
              <Field label="NAME OF THIS CONTENT" full><input value={ed.title} maxLength={80} disabled={locked} onChange={(e) => setEd({ ...ed, title: e.target.value })} placeholder="Hyderabad walk-in drive" /></Field>
            </div>
            <TextsEditor chans={edChans} texts={ed.texts} subject={ed.subject} onTexts={(t) => setEd({ ...ed, texts: t })} onSubject={(s) => setEd({ ...ed, subject: s })} flagsOf={flagsOf} readOnly={locked || !meta.canWrite} onRevise={revise} reviseBusy={reviseBusy} />
            {undo && !locked ? <div style={{ marginTop: 8 }}><TinyBtn onClick={undoRevise}>↶ Undo the last AI rewrite ({(chansOf([undo.channel])[0] || {}).label || undo.channel})</TinyBtn></div> : null}
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
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
          <input className="search" style={{ flex: '1 1 220px', maxWidth: 360 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or brief" aria-label="Search your AI content" />
          <label style={{ fontSize: 11, display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />Only mine</label>
        </div>
        <Tabs value={filter} onChange={setFilter} tabs={[['', 'All', found.length], ['draft', 'Saved', cnt('draft')], ['waiting', 'Waiting', cnt('waiting')], ['changes', 'Changes needed', cnt('changes')], ['approved', 'Approved', cnt('approved')]]} />
        {shown.length === 0 ? <Empty title="Nothing here yet">{!items.length ? 'Write a brief above and press “Write with AI”.' : (needle || onlyMine) ? 'Nothing matches the search.' : 'Nothing with that status.'}</Empty> : shown.map((it) => (
          <div className="mk-row" key={it.id}>
            <div>
              <b>{it.title}</b> <MkStatus status={it.status} /> <ClientChip cr={it.clientReview} />{it.inLibrary ? <> <Tag green title="Approved words are in the Content Library for campaigns">In the Content Library</Tag></> : null}
              <small>{chansOf(it.channels).map((c) => c.label).join(' · ')} · saved {fmtDateTime(it.updatedAt)}{!it.mine && it.createdByName ? ` · by ${it.createdByName}` : ''}{it.department ? ` · ${it.department}` : ''}{it.ai && it.ai.demo ? ' · sample writer' : ''}</small>
              {it.status === 'changes' && it.note ? <div className="mk-note">Sent back by {it.decidedByName}: {it.note}</div> : null}
            </div>
            <div className="mk-acts">
              <TinyBtn onClick={() => open(it)}>{it.canEdit ? '✎ Open' : '👁 Look'}</TinyBtn>
              {it.canSubmit ? <TinyBtn disabled={busy === it.id} onClick={() => submitFromList(it)}>Ask for approval</TinyBtn> : null}
              {it.canSubmit && it.canEdit ? <TinyBtn onClick={() => setToClient(it)} title="The client approves it instead of your team: it becomes Approved only when the client says yes">➤ Ask client to approve</TinyBtn> : null}
              {it.clientHold ? <TinyBtn onClick={() => setToClient(it)}>Client…</TinyBtn> : null}
              {meta.canWrite ? <TinyBtn onClick={() => copyItem(it)} title="Make a new draft from these words" aria-label={`Make a copy of ${it.title}`}>⧉ Copy</TinyBtn> : null}
              {it.status === 'approved' && it.canEdit ? <TinyBtn onClick={() => setToClient(it)}>{it.clientReview && it.clientReview.status !== 'revoked' ? 'Client…' : '➤ Send to client'}</TinyBtn> : null}
              {it.canDelete ? <TinyBtn onClick={() => setDel(it)} title="Delete" aria-label={`Delete ${it.title}`}>🗑</TinyBtn> : null}
            </div>
          </div>
        ))}
      </Panel>
      {toClient ? <ClientReviewModal kind="content" item={toClient} onClose={() => setToClient(null)} onChanged={load} toast={toast} /> : null}
      {leave ? <ConfirmModal danger title="Leave without saving?" text="The changes in the editor are not saved and will be lost." yes="Leave without saving" onNo={() => setLeave(null)} onYes={() => { const fn = leave.go; setLeave(null); fn(); }} /> : null}
      {flagAsk ? <ConfirmModal title="Never-use words found" text={`The ${flagAsk} message has words your brand voice says never to use. Ask for approval anyway?`} yes="Ask for approval anyway" onNo={() => setFlagAsk('')} onYes={() => { setFlagAsk(''); save(true, true); }} /> : null}
      {del ? <ConfirmModal danger title={`Delete "${del.title}"?`} text={del.status === 'approved' ? 'It is also taken out of the Content Library. Campaigns already made from it keep their words.' : 'It is removed from your AI content.'} yes="Delete" onNo={() => setDel(null)} onYes={remove} /> : null}
    </div>
  );
}
