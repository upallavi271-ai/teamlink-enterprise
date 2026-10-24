import { useEffect, useRef, useState } from 'react';
import { GsModal, Btn } from '../ui.jsx';

// Small pieces shared by the Templates page, the Content Studio and the Library picker.
export const LANGS = [['en_US', 'English (US)'], ['hi', 'Hindi'], ['te', 'Telugu']];
export const langWord = (c) => (LANGS.find((l) => l[0] === c) || [c, c || 'English (US)'])[1];
export const langCode = (c) => String(c || 'en_US').toUpperCase();

export function useDebounced(value, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

// "5 minutes ago" for the RCS gallery
export function ago(iso) {
  if (!iso) return 'just now';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24); if (d < 31) return `${d} day${d === 1 ? '' : 's'} ago`;
  const mo = Math.floor(d / 30); return `${mo} month${mo === 1 ? '' : 's'} ago`;
}
export const fmtSize = (n) => { const b = Number(n) || 0; if (b < 1024) return `${b} B`; if (b < 1048576) return `${Math.round(b / 1024)} KB`; return `${(b / 1048576).toFixed(1)} MB`; };
export function copyText(text) {
  try { if (navigator.clipboard) { navigator.clipboard.writeText(text).catch(() => {}); return true; } } catch { /* below */ }
  try { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); document.body.removeChild(t); return true; } catch { return false; }
}
export const absUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : `${window.location.origin}${u || ''}`);

export function Toggle({ on, onClick, disabled, label }) {
  return <button type="button" className={`toggle ${on ? 'on' : ''}`} role="switch" aria-checked={!!on} aria-label={label} disabled={disabled} onClick={onClick} style={{ cursor: disabled ? 'default' : 'pointer', border: 0, opacity: disabled ? 0.6 : 1 }}><span /></button>;
}

// the prototype's one-question dialog (uiPrompt): a label, a text box, an inline red sentence, Cancel + one green button; Enter submits
export function PromptModal({ title, sub, label, initial = '', placeholder, okLabel = 'OK', validate, onCancel, onOk }) {
  const [v, setV] = useState(initial);
  const [err, setErr] = useState('');
  const ref = useRef(null);
  useEffect(() => { if (ref.current) { ref.current.focus(); ref.current.select(); } }, []);
  const submit = () => { const e = validate ? validate(v) : ''; if (e) { setErr(e); return; } onOk(v.trim()); };
  return (
    <GsModal title={title} sub={sub} width={440} onClose={onCancel} foot={<><Btn onClick={onCancel}>Cancel</Btn><Btn primary onClick={submit}>{okLabel}</Btn></>}>
      <div className="field"><label>{String(label || '').toUpperCase()}</label>
        <input ref={ref} value={v} placeholder={placeholder} onChange={(e) => { setV(e.target.value); setErr(''); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }} />
        {err && <div className="ui-dlg-err" style={{ color: 'var(--red)', fontSize: 10, fontWeight: 700 }}>{err}</div>}
      </div>
    </GsModal>
  );
}

// The small row under a WhatsApp template: for every sender number, can it use this template now?  chips: [{ numberId, label, tone, word, reason? }]
// (Approved / In review / Not sent yet ...). Server: outreach/tplWaba.js. The same template is meant for every number; this shows where Meta has approved it.
export function AccountChips({ chips, big }) {
  if (!chips || !chips.length) return null;
  return (
    <div className="tpl-acct-chips" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: big ? 6 : 4 }}>
      {chips.map((c) => <span key={c.numberId} className={`pill ${c.tone}`} title={c.reason || ''} style={{ fontSize: big ? 10 : 9 }}>{c.label}: {c.word}</span>)}
    </div>
  );
}
