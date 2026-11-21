import { useEffect, useRef, useState } from 'react';
import Combo from '../../Combo.jsx';
import omni, { errOf } from '../omniApi.js';
import { Banner, Btn, Field, Pill } from '../ui.jsx';
import PhonePreview from '../templates/PhonePreview.jsx';

// CAMPAIGN STEP 3, WhatsApp: the TYPE of the message (Text | Image | Video | Document | Carousel) and, for a picture / video / document, the file, its caption and the exact phone preview.
// The file goes up to /gs/campaigns/media (outreach/campaignMedia.js checks WhatsApp's own limits; the checks here only save a round trip). A business-started message can only carry the file
// through an APPROVED Meta template whose header is that kind of file; "Free message" is a caption message for people who wrote to you in the last 24 hours (Meta's rule, not ours).
const TYPES = [['text', 'Text'], ['image', 'Image'], ['video', 'Video'], ['document', 'Document'], ['carousel', 'Carousel']];
const RULES = {
  image: { accept: '.jpg,.jpeg,.png,image/jpeg,image/png', mb: 5, words: 'a JPG or PNG picture up to 5 MB', mimes: { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' } },
  video: { accept: '.mp4,.3gp,video/mp4,video/3gpp', mb: 16, words: 'an MP4 or 3GP video up to 16 MB (H.264 video, AAC sound)', mimes: { mp4: 'video/mp4', '3gp': 'video/3gpp' } },
  document: {
    accept: '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt', mb: 25, words: 'a PDF, Word, Excel, PowerPoint or TXT file up to 25 MB',
    mimes: { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', txt: 'text/plain' },
  },
};
const sizeWords = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export default function WaMediaPick({ f, set, tplList }) {
  const type = f.mediaType || 'text';
  const media = f.media || null;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [url, setUrl] = useState('');
  const urlOf = useRef('');
  const setLocal = (u) => { if (urlOf.current && urlOf.current !== u) URL.revokeObjectURL(urlOf.current); urlOf.current = u; setUrl(u); };
  useEffect(() => () => { if (urlOf.current) URL.revokeObjectURL(urlOf.current); }, []);
  // a campaign opened for editing has a file on the server but nothing local to show yet
  useEffect(() => {
    if (!media || !media.id || urlOf.current) return undefined;
    let on = true;
    omni.blob(`/gs/campaigns/media/${media.id}/file`).then((b) => { if (on) setLocal(URL.createObjectURL(b)); }).catch(() => {});
    return () => { on = false; };
  }, [media && media.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickType = (t) => {
    if (t === type) return;
    setErr(''); setLocal('');
    set('mediaType', t);
    set('media', null);
    set('templates', { ...f.templates, whatsapp: undefined });
  };
  const upload = async (file) => {
    setErr('');
    const rule = RULES[type];
    if (!file || !rule) return;
    const ext = String(file.name.split('.').pop() || '').toLowerCase();
    const mime = rule.mimes[ext] || (Object.values(rule.mimes).includes(file.type) ? file.type : '');
    if (!mime) { setErr(`For a ${type} WhatsApp takes ${rule.words}. This file is not one.`); return; }
    if (file.size > rule.mb * 1048576) { setErr(`A ${type} can be at most ${rule.mb} MB. This one is ${sizeWords(file.size)}.`); return; }
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const r = await omni.post(`/gs/campaigns/media?filename=${encodeURIComponent(file.name)}`, buf, { headers: { 'Content-Type': mime }, transformRequest: [(d) => d] });
      setLocal(URL.createObjectURL(file));
      set('media', { ...(media || {}), id: r.media.id, kind: r.media.kind, name: r.media.name, size: r.media.size, mode: (media && media.mode) || 'template', caption: (media && media.caption) || '' });
    } catch (e) { setErr(errOf(e, 'The file could not be uploaded.')); } finally { setBusy(false); }
  };
  const patch = (o) => set('media', { ...media, ...o });
  const mode = (media && media.mode) || 'template';
  const list = (tplList || []).filter((t) => (t.extra && t.extra.headerType) === type);
  const tpl = list.find((t) => t.id === f.templates.whatsapp) || null;

  // the exact phone message
  let pv = null;
  if (media) {
    const body = mode === 'caption' ? (media.caption || '') : (tpl ? tpl.body : '');
    pv = { channel: 'whatsapp', headerType: type, headerMedia: { url, name: media.name }, body, footer: mode === 'template' && tpl ? (tpl.extra && tpl.extra.footer) || '' : '', buttons: mode === 'template' && tpl ? (tpl.extra && tpl.extra.buttons) || [] : [] };
  }
  return (
    <div className="card panel" style={{ marginBottom: 14 }}>
      <div className="panel-title">WhatsApp message type</div>
      <div className="checks" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0' }} role="group" aria-label="WhatsApp message type">
        {TYPES.map(([k, w]) => (
          <button key={k} type="button" className={`check${type === k ? ' on' : ''}`} aria-pressed={type === k} disabled={k === 'carousel'}
            title={k === 'carousel' ? 'Carousel needs a Meta carousel template. The connected WhatsApp number does not have carousel templates set up yet, so it is not offered.' : ''}
            style={k === 'carousel' ? { opacity: 0.5, cursor: 'not-allowed' } : undefined} onClick={() => pickType(k)}>{w}{k === 'carousel' ? ' (not available)' : ''}</button>
        ))}
      </div>
      {type === 'text' ? <p style={{ fontSize: 10.5, color: 'var(--muted)', margin: 0 }}>Text: the words of the approved WhatsApp message, as before. Pick Image, Video or Document to send a file with it.</p> : (
        <div>
          <div className="form-grid">
            <Field label="HOW IT GOES OUT" full hint="Outside the 24 hours WhatsApp lets a business start a chat only with an approved template. That is the normal choice for a campaign.">
              <div style={{ display: 'grid', gap: 6 }}>
                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11.5 }}><input type="radio" name="wamode" checked={mode === 'template'} onChange={() => { if (media) patch({ mode: 'template' }); else set('media', null); }} /><span><b>Approved template</b> with the {type} in its header. Works for everyone on the list.</span></label>
                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11.5 }}><input type="radio" name="wamode" checked={mode === 'caption'} onChange={() => { if (media) { patch({ mode: 'caption' }); set('templates', { ...f.templates, whatsapp: undefined }); } }} disabled={!media} /><span><b>Free message with a caption.</b> Only people who wrote to you in the last 24 hours get it; the others fail with the reason and can be retried later.</span></label>
              </div>
            </Field>
            <Field label={`${type.toUpperCase()} FILE`} full hint={`WhatsApp takes ${RULES[type].words}.`}>
              <input type="file" accept={RULES[type].accept} disabled={busy} onChange={(e) => { const x = e.target.files && e.target.files[0]; if (x) upload(x); e.target.value = ''; }} aria-label={`Choose a ${type} file`} />
            </Field>
          </div>
          {busy && <p style={{ fontSize: 11 }}>Uploading and checking the file…</p>}
          {err && <Banner tone="error">{err}</Banner>}
          {media && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '8px 0', fontSize: 11.5 }}>
              <Pill tone="live">{type === 'image' ? 'Picture' : (type === 'video' ? 'Video' : 'Document')} ready</Pill><span>{media.name} · {sizeWords(media.size || 0)}</span>
              <Btn small onClick={() => { setLocal(''); set('media', null); set('templates', { ...f.templates, whatsapp: undefined }); }}>Remove</Btn>
            </div>
          )}
          {url && media && (
            <div className="preview" style={{ marginBottom: 10 }}>
              <div className="preview-head">Preview of your file</div>
              <div className="preview-body" style={{ textAlign: 'center' }}>
                {type === 'image' && <img src={url} alt={media.name} style={{ maxWidth: '100%', maxHeight: 260, borderRadius: 8 }} />}
                {type === 'video' && <video src={url} controls style={{ maxWidth: '100%', maxHeight: 260, borderRadius: 8 }} />}
                {type === 'document' && <div style={{ padding: 14, fontSize: 12 }}>📄 <b>{media.name}</b></div>}
              </div>
            </div>
          )}
          {mode === 'template' ? (
            <div className="cmp-tpl-row">
              <Field label={`WHATSAPP MESSAGE WITH A ${type.toUpperCase()} HEADER`} hint="Only approved messages whose header is this kind of file are listed. Make or edit them in Manage Templates (header type + the name Meta approved).">
                <Combo value={f.templates.whatsapp || ''} onChange={(e) => set('templates', { ...f.templates, whatsapp: e.target.value || undefined })}>
                  <option value="">Pick the message</option>
                  {list.map((x) => <option key={x.id} value={x.id}>{x.name}{x.ready ? '' : ` (not ready: ${x.why})`}</option>)}
                </Combo>
              </Field>
            </div>
          ) : (
            <Field label="CAPTION (UNDER THE FILE)" full hint="You can use {{name}}. Keep it short and honest.">
              <textarea rows={3} maxLength={1000} value={(media && media.caption) || ''} disabled={!media} placeholder="Hello {{name}}, here is our brochure." onChange={(e) => patch({ caption: e.target.value })} />
            </Field>
          )}
          {mode === 'template' && !list.length && <p style={{ fontSize: 10.5, color: '#9b6d12', margin: '4px 0 8px' }}>No approved WhatsApp message with a {type} header exists yet. Make one in Manage Templates (header: {type}), submit it to Meta, and mark it approved.</p>}
          {pv && (
            <div style={{ marginTop: 10 }}>
              <div className="panel-title" style={{ marginBottom: 6 }}>Exactly how it looks on WhatsApp</div>
              <div style={{ maxWidth: 280 }}><PhonePreview f={pv} /></div>
              <p style={{ fontSize: 10, color: 'var(--muted)', marginTop: 6 }}>{mode === 'template' ? 'The words come from the approved message (sample values: Anita ...). Each person gets their own name.' : 'Each person gets their own name in the caption.'}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
