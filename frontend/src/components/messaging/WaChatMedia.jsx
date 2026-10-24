import { useEffect, useState } from 'react';
import api from '../../api';
import { sizeLabel } from './waChatLogic.js';

// A picture, a PDF / document or a voice note that came in a WhatsApp chat.
// The bytes are fetched with the login (GET /api/wa-chats/media/:id checks the login and the chat's owner on EVERY request): nothing is public,
// and the browser only ever sees a temporary local address (blob:) for it.
async function errorText(e) {
  try {
    const d = e.response && e.response.data;
    if (d && typeof d.text === 'function') return JSON.parse(await d.text());
    return d || {};
  } catch { return {}; }
}

function useFile(id, enabled) {
  const [s, setS] = useState({ url: '', loading: !!enabled, note: '', pending: false });
  useEffect(() => {
    if (!enabled) return undefined;
    let dead = false; let made = ''; let timer = null; let tries = 0;
    const go = () => {
      api.get(`/wa-chats/media/${id}`, { responseType: 'blob' })
        .then((r) => { if (dead) return; made = URL.createObjectURL(r.data); setS({ url: made, loading: false, note: '', pending: false }); })
        .catch(async (e) => {
          if (dead) return;
          const body = await errorText(e);
          // "not here yet" (still being fetched from WhatsApp): look again in a moment
          if (e.response && e.response.status === 409 && body.status === 'pending' && tries < 10) { tries += 1; setS({ url: '', loading: true, note: '', pending: true }); timer = setTimeout(go, 2000); return; }
          setS({ url: '', loading: false, note: body.error || 'The file could not be opened.', pending: false });
        });
    };
    go();
    return () => { dead = true; clearTimeout(timer); if (made) URL.revokeObjectURL(made); };
  }, [id, enabled]);
  return s;
}

function Download({ id, name, label = 'Download' }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.get(`/wa-chats/media/${id}`, { params: { download: 1 }, responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url; a.download = name || 'file';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) { setErr((await errorText(e)).error || 'The file could not be downloaded.'); } finally { setBusy(false); }
  };
  return (
    <span>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={go}>{busy ? 'Getting it…' : label}</button>
      {err && <span className="wc-media-err"> {err}</span>}
    </span>
  );
}

export default function WaChatMedia({ media }) {
  const m = media;
  const stored = m.status === 'stored';
  const pending = m.status === 'pending';
  const isVisual = ['image', 'sticker'].includes(m.kind);
  const isSound = ['voice', 'audio'].includes(m.kind);
  const file = useFile(m.id, (stored || pending) && (isVisual || isSound || m.kind === 'video'));
  if (!stored && !pending) {
    return <div className="wc-file wc-file-bad" role="note">📎 {m.name || 'A file'} - {m.note || 'This file could not be saved.'}</div>;
  }
  if (isVisual) {
    if (file.note) return <div className="wc-file wc-file-bad">🖼️ {file.note}</div>;
    if (!file.url) return <div className="wc-file">🖼️ Getting the picture…</div>;
    return <a href={file.url} target="_blank" rel="noreferrer" className="wc-img-link" title="Open the picture"><img className="wc-img" src={file.url} alt={m.name || 'Picture they sent'} /></a>;
  }
  if (isSound) {
    if (file.note) return <div className="wc-file wc-file-bad">🎤 {file.note}</div>;
    return (
      <div className="wc-voice">
        <span aria-hidden="true">🎤</span> {m.kind === 'voice' ? 'Voice note' : 'Audio'}
        {file.url ? <audio controls preload="none" src={file.url} /> : <span className="small-muted"> getting it…</span>}
      </div>
    );
  }
  if (m.kind === 'video') {
    if (file.note) return <div className="wc-file wc-file-bad">🎞️ {file.note}</div>;
    return file.url ? <video className="wc-img" controls preload="none" src={file.url} /> : <div className="wc-file">🎞️ Getting the video…</div>;
  }
  return (
    <div className="wc-file">
      <span className="wc-file-ico" aria-hidden="true">📄</span>
      <span className="wc-file-name"><b>{m.name || 'Document'}</b><small>{sizeLabel(m.size)}{m.mime ? ` · ${m.mime.split('/').pop()}` : ''}</small></span>
      {stored ? <Download id={m.id} name={m.name} /> : <span className="small-muted">getting it…</span>}
    </div>
  );
}
