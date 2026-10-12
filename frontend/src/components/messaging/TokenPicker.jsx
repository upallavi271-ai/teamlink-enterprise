import { useState } from 'react';
import './messaging.css';

// "Add a detail": buttons that drop {{name}}, {{interviewAt}} … into the text
// where the cursor is. Plain words on the buttons, never the code.
export default function TokenPicker({ tokens, onPick, startOpen = false }) {
  const [open, setOpen] = useState(startOpen);
  if (!tokens) return null;
  const groups = [...new Set(tokens.map((t) => t.group))];
  return (
    <div>
      <button type="button" className="btn btn-sm" onClick={() => setOpen((o) => !o)}>{open ? 'Hide details' : '＋ Add a detail (name, job, date…)'}</button>
      {open && (
        <div className="msg-tokens">
          {groups.map((g) => (
            <span key={g} style={{ display: 'contents' }}>
              <span className="msg-group">{g}</span>
              {tokens.filter((t) => t.group === g).map((t) => (
                <button key={t.key} type="button" className="msg-token" title={`Example: ${t.sample}`} onClick={() => onPick(t.key)}>{t.label}</button>
              ))}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// Insert {{key}} into a controlled textarea at the cursor.
export function insertToken(ref, value, setValue, key) {
  const el = ref && ref.current;
  const piece = `{{${key}}}`;
  if (!el) { setValue(`${value || ''}${piece}`); return; }
  const a = el.selectionStart == null ? (value || '').length : el.selectionStart;
  const b = el.selectionEnd == null ? a : el.selectionEnd;
  const next = `${(value || '').slice(0, a)}${piece}${(value || '').slice(b)}`;
  setValue(next);
  setTimeout(() => { try { el.focus(); el.setSelectionRange(a + piece.length, a + piece.length); } catch { /* ignore */ } }, 0);
}
