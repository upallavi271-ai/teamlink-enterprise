import { useEffect, useRef, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { Pill, Banner, TinyBtn, Btn } from '../ui.jsx';
import './marketing.css';

// Shared parts of the AI Marketing screens (Omni-Channel > AI Marketing). Wording rule of Omni-Channel: the word "Draft" is never shown to people.
export const MK_STATUS = {
  draft: ['draft', 'Saved, not sent for approval'],
  waiting: ['warn', 'Waiting for approval'],
  changes: ['red', 'Changes needed'],
  approved: ['live', 'Approved'],
};
export const MkStatus = ({ status }) => { const [tone, words] = MK_STATUS[status] || ['draft', status]; return <Pill tone={tone} dot>{words}</Pill>; };

export function useMkMeta() {
  const [meta, setMeta] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let on = true;
    omni.get('/gs/marketing/meta').then((m) => { if (on) setMeta(m); }).catch((e) => { if (on) setErr(errOf(e, 'AI Marketing could not be opened.')); });
    return () => { on = false; };
  }, []);
  return { meta, err };
}

// what the AI is, said plainly: the test sandbox only has an offline sample writer
export function AiBanner({ ai }) {
  const t = ai && (ai.text || ai);
  if (!t) return null;
  if (t.demo) return <Banner tone="test"><b>Test sandbox.</b> The AI here is an offline sample writer: it builds simple example messages from your brief and sends nothing anywhere. The live app uses the real AI model.</Banner>;
  if (!t.ready) {
    // the advice depends on which model the server uses: Claude's own reason already says where its key goes
    const how = t.provider === 'claude' ? ''
      : t.provider === 'ollama' ? ' The server uses the local AI (Ollama): start it on the server, or an Admin can switch the server to Claude (AI_PROVIDER=claude) and add the key in Administration > Integrations > AI Assistant.'
        : ' An Admin can connect it in Administration > Integrations > AI Assistant.';
    return <Banner tone="error"><b>AI is not ready.</b> {t.reason || 'The AI model is not connected.'}{how}</Banner>;
  }
  return null;
}
// true when "Write with AI" can work: a real model is ready, or the sandbox sample writer is in use
export const aiReady = (ai) => { const t = ai && (ai.text || ai); return !t || !!t.ready || !!t.demo; };
export const aiLabel = (ai) => (!ai ? '' : ai.demo ? 'Sample writer (test sandbox)' : `${ai.provider || 'AI'}${ai.model ? ` · ${ai.model}` : ''}`);

// one editable text per channel (texts = { channel: text }); `channels` come from the meta (key, label, icon, color, limit, hint)
export function TextsEditor({ chans, texts, subject, onTexts, onSubject, flagsOf, readOnly, onRevise, reviseBusy }) {
  const [active, setActive] = useState(chans[0] && chans[0].key);
  const [instr, setInstr] = useState('');
  const [copied, setCopied] = useState('');
  useEffect(() => { if (!chans.some((c) => c.key === active)) setActive(chans[0] && chans[0].key); }, [chans]); // eslint-disable-line react-hooks/exhaustive-deps
  const ch = chans.find((c) => c.key === active) || chans[0];
  if (!ch) return null;
  const text = texts[ch.key] || '';
  // copy the words of this channel (email: the subject line first), e.g. to paste into a template or a social post
  const copy = async () => {
    const words = ch.key === 'email' && subject ? `${subject}\n\n${text}` : text;
    try { await navigator.clipboard.writeText(words); setCopied(ch.key); } catch { setCopied('fail'); }
    setTimeout(() => setCopied(''), 2000);
  };
  const over = text.length > ch.limit;
  const flags = flagsOf ? flagsOf(ch.key, text) : [];
  const chips = ['Shorter', 'More urgent', 'Friendlier', 'More formal'];
  return (
    <div>
      <div className="mk-ed-tabs" role="tablist" aria-label="Channels">
        {chans.map((c) => <button type="button" key={c.key} role="tab" aria-selected={c.key === ch.key} className={`mk-ed-tab${c.key === ch.key ? ' on' : ''}`} onClick={() => setActive(c.key)}><i style={{ background: c.color }}>{c.icon}</i>{c.label}{(texts[c.key] || '').length > c.limit ? <span style={{ color: '#b3261e' }}>!</span> : null}</button>)}
      </div>
      {ch.key === 'email' && (
        <div className="field" style={{ marginBottom: 8 }}><label>EMAIL SUBJECT</label><input value={subject || ''} disabled={readOnly} maxLength={200} onChange={(e) => onSubject(e.target.value)} placeholder="Subject line" /></div>
      )}
      <textarea style={{ width: '100%', minHeight: 150, border: '1px solid var(--line)', borderRadius: 10, padding: 11, font: 'inherit', fontSize: 12.5 }} value={text} disabled={readOnly} onChange={(e) => onTexts({ ...texts, [ch.key]: e.target.value })} placeholder={`The ${ch.label} message…`} aria-label={`${ch.label} message`} />
      <div className={`mk-count${over ? ' over' : ''}`}><span>{text.length.toLocaleString('en-IN')} / {ch.limit.toLocaleString('en-IN')} characters{over ? ' · too long' : ''}</span><span>{ch.hint}{ch.send ? '' : ' · saved text only, nothing is posted from here'} <TinyBtn disabled={!text.trim()} onClick={copy} aria-label={`Copy the ${ch.label} message`}>{copied === ch.key ? '✓ Copied' : copied === 'fail' ? 'Copy blocked' : '⧉ Copy'}</TinyBtn></span></div>
      {flags.length > 0 && <div className="mk-flag">Your brand voice says never to use: <b>{flags.join(', ')}</b>. Change the words before you ask for approval.</div>}
      {!readOnly && onRevise && (
        <div className="mk-revise">
          {chips.map((c) => <TinyBtn key={c} disabled={reviseBusy || !text.trim()} onClick={() => onRevise(ch.key, c)}>{c}</TinyBtn>)}
          <input className="mk-instr" value={instr} onChange={(e) => setInstr(e.target.value)} placeholder="Or say what to change…" aria-label="What should the AI change" maxLength={200} />
          <Btn small disabled={reviseBusy || !text.trim() || instr.trim().length < 3} onClick={() => { onRevise(ch.key, instr.trim()); setInstr(''); }}>{reviseBusy ? 'Rewriting…' : '✦ Rewrite'}</Btn>
        </div>
      )}
    </div>
  );
}

// an AI picture shown in the app: fetched with the login (an <img src> cannot carry it) and shown from a blob address that is freed afterwards
// video = true for an AI Video slideshow (shown with the player's controls; `muted` thumbnails in pickers)
// lazy: the file is fetched only when the tile scrolls into view (a page with many video clips must not download every clip at once)
export function MkImg({ id, alt, style, onClick, video, controls = true, lazy = false }) {
  const [src, setSrc] = useState('');
  const [bad, setBad] = useState(false);
  const [seen, setSeen] = useState(!lazy || typeof IntersectionObserver === 'undefined');
  const holder = useRef(null);
  useEffect(() => {
    if (seen) return undefined;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin: '300px' });
    if (holder.current) io.observe(holder.current);
    return () => io.disconnect();
  }, [seen]);
  useEffect(() => {
    if (!seen) return undefined;
    let url = ''; let on = true;
    setSrc(''); setBad(false);
    omni.blob(`/gs/marketing/images/${id}/file`).then((b) => { if (!on) return; url = URL.createObjectURL(b); setSrc(url); }).catch(() => { if (on) setBad(true); });
    return () => { on = false; if (url) URL.revokeObjectURL(url); };
  }, [id, seen]);
  const box = { background: '#f1f5f2', borderRadius: 10, display: 'block', width: '100%', objectFit: 'cover', ...style };
  if (bad) return <div style={{ ...box, display: 'grid', placeItems: 'center', fontSize: 10, color: 'var(--muted)', minHeight: 80 }}>Picture not found</div>;
  if (!src) return <div ref={holder} style={{ ...box, minHeight: 80 }} aria-busy="true" />;
  if (video) return <video src={src} style={box} controls={controls} muted={!controls} playsInline preload="metadata" aria-label={alt || 'Video'} onClick={onClick} />; // eslint-disable-line jsx-a11y/media-has-caption
  return <img src={src} alt={alt || ''} style={box} onClick={onClick} />;
}
export async function downloadMkImg(id, name) {
  const b = await omni.blob(`/gs/marketing/images/${id}/file`);
  const url = URL.createObjectURL(b);
  const a = document.createElement('a'); a.href = url; a.download = `${String(name || 'picture').replace(/[^\w\- ]+/g, '').slice(0, 60) || 'picture'}.${(b.type || 'image/png').split('/')[1].replace('jpeg', 'jpg')}`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// the client approval badge on a card (marketing/clientReview.js); nothing for an item that was never sent or whose link was cancelled
export function ClientChip({ cr }) {
  if (!cr || cr.status === 'revoked') return null;
  const decide = cr.mode === 'decide'; // the client is the approver (their answer is the approval)
  const stale = cr.outdated && cr.status !== 'sent';
  const [tone, words] = stale ? ['warn', 'Changed after the client saw it']
    : cr.status === 'approved' ? ['live', `✔ ${decide ? 'Approved by the client' : 'Client approved'}${cr.decidedByName ? `: ${cr.decidedByName}` : ''}`]
      : cr.status === 'changes' ? ['red', '↩ Client asked for changes']
        : cr.status === 'expired' ? ['draft', 'Client link expired']
          : ['warn', cr.outdated ? 'Changed after the link was made' : decide ? '⏳ Waiting for the client to approve' : '⏳ Waiting for the client'];
  return <Pill tone={tone} dot title={`${cr.clientName}${cr.comment ? `: ${cr.comment}` : ''}`}>{words}</Pill>;
}

// a read-only look at the words of every channel (approvals, lists)
export function TextsPreview({ chans, texts, subject }) {
  const have = chans.filter((c) => texts[c.key]);
  const [active, setActive] = useState(have[0] && have[0].key);
  useEffect(() => { if (!have.some((c) => c.key === active)) setActive(have[0] && have[0].key); }, [have.map((c) => c.key).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const ch = have.find((c) => c.key === active) || have[0];
  if (!ch) return <div style={{ fontSize: 11, color: 'var(--muted)' }}>No text.</div>;
  return (
    <div className="mk-preview">
      <div className="mk-ed-tabs" style={{ margin: 0 }}>{have.map((c) => <button type="button" key={c.key} className={`mk-ed-tab${c.key === ch.key ? ' on' : ''}`} onClick={() => setActive(c.key)}><i style={{ background: c.color }}>{c.icon}</i>{c.label}</button>)}</div>
      {ch.key === 'email' && subject ? <div style={{ fontSize: 11, marginTop: 8 }}><span style={{ color: 'var(--muted)' }}>Subject: </span><b>{subject}</b></div> : null}
      <pre>{texts[ch.key]}</pre>
    </div>
  );
}
