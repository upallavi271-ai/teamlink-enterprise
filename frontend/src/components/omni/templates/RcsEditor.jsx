import { useRef, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { Btn, Planned } from '../ui.jsx';
import MediaLibraryModal, { uploadToLibrary } from './MediaLibraryModal.jsx';
import { PromptModal, copyText } from './tplCommon.jsx';
import { RcsPhone, RCS_TYPES, RCS_ACTIONS, MAX_ACTIONS, blankCard, newAction, prepForm, stripIds, payloadOf } from './rcsShared.jsx';

// The RCS editor (full width): fields on the left, Visual Preview / JSON Payload on the right. Saved in our own table; nothing is sent.
const Counter = ({ len, rec, max }) => <div className="rcs-count"><span className="rcs-rec">{rec ? `${rec} characters reads best` : ''}</span><span>{len}/{max}</span></div>;

function Drop({ media, onChange, ro, onPickLib }) {
  const input = useRef(null);
  const { toast } = useOmni();
  const take = async (files) => {
    const file = files && files[0]; if (!file) return;
    if (!/^image\//.test(file.type)) { toast('Choose an image file'); return; }
    if (file.size > 2 * 1024 * 1024) { toast('Keep the image under 2 MB: carriers reject larger media'); return; }
    try { const it = await uploadToLibrary(file); onChange({ libraryId: it.id, name: it.name, url: it.url }); toast(`${file.name} attached`); } catch (e) { toast(errOf(e, e.message || 'The picture could not be saved.')); }
  };
  if (media) return <><div className="rcs-media"><img src={media.url} alt="" />{!ro ? <button type="button" className="rcs-media-x" title="Remove image" onClick={() => onChange(null)}>✕</button> : null}</div><div className="rcs-note">{media.name} · Best at 1440x720, up to 2 MB</div></>;
  if (ro) return <div className="rcs-note">No image.</div>;
  return (
    <>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={(e) => { take(e.target.files); e.target.value = ''; }} />
      <button type="button" className="rcs-drop" onClick={() => input.current && input.current.click()} onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('drag'); }} onDragLeave={(e) => e.currentTarget.classList.remove('drag')} onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove('drag'); take(e.dataTransfer.files); }}>
        <span className="rcs-drop-ic">☁</span><b><i>Choose a file</i> or drop one here</b><small>JPG or PNG · landscape works best</small>
      </button>
      <div className="rcs-note">Best at 1440x720, up to 2 MB. <button type="button" className="mp-gate-link" onClick={onPickLib}>Or pick one from the Library</button></div>
    </>
  );
}

function Actions({ list, setList, max, ro }) {
  const { toast } = useOmni();
  const add = () => { if (list.length >= max) { toast(`RCS allows at most ${max} suggested actions here`); return; } setList([...list, newAction()]); };
  const upd = (id, p) => setList(list.map((a) => (a.id === id ? { ...a, ...p } : a)));
  return (
    <>
      <div className="rcs-sec-head"><b>Suggested Actions ({list.length}/{max})</b>{!ro ? <button type="button" className="rcs-add" onClick={add}>＋ Add</button> : null}</div>
      {list.length ? (
        <div className="rcsa-list">{list.map((a, i) => {
          const spec = RCS_ACTIONS.find((x) => x.key === a.type) || RCS_ACTIONS[0];
          return (
            <div className="rcsa-row" key={a.id}>
              <div className="rcsa-head"><span className="rcsa-grip">⠿</span> BUTTON {i + 1}{!ro ? <button type="button" className="rcsa-del" title="Remove" onClick={() => setList(list.filter((x) => x.id !== a.id))}>🗑</button> : null}</div>
              <div className="rcsa-grid">
                <div className="rcsa-f"><label>Label</label><input maxLength={25} value={a.label} placeholder="Yes, Interested" onChange={(e) => upd(a.id, { label: e.target.value })} /></div>
                <div className="rcsa-f"><label>Action</label><select value={a.type} onChange={(e) => upd(a.id, { type: e.target.value })}>{RCS_ACTIONS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></div>
                {spec.field ? <div className="rcsa-f full"><label>{spec.field.label}</label><input value={a[spec.field.key] || ''} placeholder={spec.field.ph} onChange={(e) => upd(a.id, { [spec.field.key]: e.target.value })} /></div> : null}
              </div>
            </div>
          );
        })}</div>
      ) : <div className="rcs-none">No actions yet: people will only be able to read the message.</div>}
    </>
  );
}

function CardFields({ c, setC, max, ro, pickLib }) {
  const s = (p) => setC({ ...c, ...p });
  return (
    <>
      <div className="rcs-f"><label>Card Title</label><input maxLength={80} value={c.title} placeholder="New openings this week" onChange={(e) => s({ title: e.target.value })} /><Counter len={c.title.length} rec={40} max={80} /></div>
      <div className="rcs-f"><label>Description</label><textarea className="rcs-ta" maxLength={2000} value={c.description} placeholder="Walk in on Saturday and meet the hiring team." onChange={(e) => s({ description: e.target.value })} /><Counter len={c.description.length} rec={112} max={2000} /></div>
      <div className="rcs-two">
        <div className="rcs-f"><label>Orientation</label><select value={c.orientation || ''} onChange={(e) => s({ orientation: e.target.value })}><option value="" /><option value="vertical">Vertical</option><option value="horizontal">Horizontal</option></select></div>
        <div className="rcs-f"><label>Media Height</label><select value={c.mediaHeight || ''} onChange={(e) => s({ mediaHeight: e.target.value })}><option value="" /><option value="short">Short (112px)</option><option value="medium">Medium (168px)</option><option value="tall">Tall (264px)</option></select></div>
      </div>
      <div className="rcs-f"><label>Upload Image</label><Drop media={c.media} ro={ro} onChange={(m) => s({ media: m })} onPickLib={pickLib} /></div>
      <Actions list={c.actions} setList={(l) => s({ actions: l })} max={max} ro={ro} />
    </>
  );
}

export default function RcsEditor({ template, agent, mode, canWrite, onBack, onSaved, onMode }) {
  const { toast } = useOmni();
  const type = template.type;
  const [form, setForm] = useState(() => prepForm(type, template.form));
  const [snap, setSnap] = useState(() => JSON.stringify(prepForm(type, template.form)));
  const [tab, setTab] = useState('visual');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [rename, setRename] = useState(false);
  const [lib, setLib] = useState(null); // null | 'main' | card index
  const ro = mode === 'view' || !canWrite;
  const max = MAX_ACTIONS[type];
  const pill = (RCS_TYPES.find((t) => t.key === type) || RCS_TYPES[0]).pill;
  const payload = JSON.stringify(payloadOf(type, form), null, 2);

  const save = async () => {
    setBusy(true); setErr('');
    try { const r = await omni.put(`/gs/templates/rcs/templates/${template.id}`, { form: stripIds(type, form) }); toast(`"${template.name}" saved on ${agent.name}`); onSaved(r.template); onMode('view'); } catch (e) { const m = errOf(e, 'It could not be saved.'); setErr(m); toast(m); } finally { setBusy(false); }
  };
  const cancel = () => { setForm(JSON.parse(snap)); setErr(''); onBack(); };
  const edit = () => { setSnap(JSON.stringify(form)); onMode('edit'); };
  const renameTo = async (v) => {
    try { const r = await omni.put(`/gs/templates/rcs/templates/${template.id}`, { name: v }); onSaved(r.template); setRename(false); toast('Renamed'); } catch (e) { toast(errOf(e, 'It could not be renamed.')); setRename(false); }
  };
  const setCard = (i, c) => setForm({ ...form, cards: form.cards.map((x, k) => (k === i ? c : x)) });

  let fields;
  if (type === 'text') {
    fields = (
      <>
        <div className="rcs-f"><label>Message Text</label><textarea className="rcs-ta lg" maxLength={2000} value={form.text} placeholder="Hello! We have a new job for you." onChange={(e) => setForm({ ...form, text: e.target.value })} /><div className="rcs-count end"><span>{form.text.length}/2000</span></div></div>
        <Actions list={form.actions} setList={(l) => setForm({ ...form, actions: l })} max={max} ro={ro} />
      </>
    );
  } else if (type === 'card') fields = <CardFields c={form} setC={(c) => setForm(c)} max={max} ro={ro} pickLib={() => setLib('main')} />;
  else {
    fields = (
      <>
        {form.cards.map((c, i) => (
          <section className="rcs-cardbox" key={i}>
            <div className="rcs-cardbox-head">CARD {i + 1}{!ro && form.cards.length > 1 ? <button type="button" className="rcsa-del" title="Remove this card" onClick={() => setForm({ ...form, cards: form.cards.filter((_, k) => k !== i) })}>🗑</button> : null}</div>
            <CardFields c={c} setC={(x) => setCard(i, x)} max={max} ro={ro} pickLib={() => setLib(i)} />
          </section>
        ))}
        {!ro ? (form.cards.length < 10 ? <button type="button" className="rcs-addcard" onClick={() => setForm({ ...form, cards: [...form.cards, blankCard()] })}>＋ Add another card</button> : <div className="rcs-none">A carousel carries at most 10 cards.</div>) : null}
      </>
    );
  }
  return (
    <div>
      <div className="rcs-ed-head">
        <button type="button" className="tpl-edit-back" onClick={onBack} aria-label="Back">←</button>
        <div className="rcs-ed-id"><div className="rcs-ed-name"><span style={{ overflowWrap: 'anywhere' }}>📢 {template.name}</span>{canWrite ? <button type="button" className="rcs-ren" onClick={() => setRename(true)} title="Rename">✎</button> : null}</div><span className="rcs-ed-pill">{pill}</span></div>
        <div className="rcs-ed-acts" style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {mode === 'view' ? (canWrite ? <button type="button" className="set-cta" onClick={edit}>✎ Edit Template</button> : null) : <><Btn onClick={cancel}>Cancel</Btn><button type="button" className="set-cta" disabled={busy} onClick={save}>💾 Save Template</button></>}
        </div>
      </div>
      {err ? <div role="alert" style={{ background: '#fdeced', border: '1px solid #f4c9cc', color: '#9b1c1c', borderRadius: 10, padding: '9px 12px', fontSize: 11, margin: '0 0 12px' }}>{err}</div> : null}
      <Planned>RCS sending is planned: nothing is sent. Saving keeps this template ready for when RCS is switched on.</Planned>
      <div className="rcs-ed-body">
        <fieldset disabled={ro} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}><div className="rcs-ed-form">{fields}</div></fieldset>
        <aside className="rcs-ed-prev">
          <div className="rcs-prev-tabs"><button type="button" className={tab === 'visual' ? 'on' : ''} onClick={() => setTab('visual')}>📱 Visual Preview</button><button type="button" className={tab === 'json' ? 'on' : ''} onClick={() => setTab('json')}>{'{}'} JSON Payload</button></div>
          {tab === 'visual' ? <RcsPhone type={type} form={form} agentName={agent.name} /> : <pre className="rp-json">{payload}</pre>}
          {tab === 'json' ? <button type="button" className="btn" style={{ width: '100%', marginTop: 10 }} onClick={() => { copyText(payload); toast('Payload copied'); }}>⧉ Copy payload</button> : null}
        </aside>
      </div>
      {rename ? <PromptModal title="Rename template" label="Template name" initial={template.name} okLabel="Rename" validate={(v) => (v.trim().length < 2 ? 'Give the template a name.' : '')} onCancel={() => setRename(false)} onOk={renameTo} /> : null}
      {lib !== null ? <MediaLibraryModal title="Choose a picture" types={['image']} multiple={false} onClose={() => setLib(null)} onPick={(p) => { if (!p[0]) return; const m = { libraryId: p[0].id, name: p[0].name, url: p[0].url.replace(/^https?:\/\/[^/]+(?=\/api\/)/, '') }; if (lib === 'main') setForm({ ...form, media: m }); else setCard(lib, { ...form.cards[lib], media: m }); }} /> : null}
    </div>
  );
}
