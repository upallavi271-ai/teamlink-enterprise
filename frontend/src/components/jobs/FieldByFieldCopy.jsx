import { useRef, useState } from 'react';
import './fieldByFieldCopy.css';

// ---------------------------------------------------------------------------
// FIELD BY FIELD, WITHOUT COMING BACK (founder, 2026-10-23): "Shine has no place to paste the whole JD, so I fill each box by hand. Copy the
// fields one by one so that on the site I only press Win+V, pick the field and click - no going back to TeamLink again and again."
//
// ONE press puts every field on the clipboard, one after the other. Windows keeps them in its clipboard history (Win+V, up to 25 items,
// newest on top), so the fields are copied LAST to FIRST: the first box of the site's form ends up on top of the Win+V list.
// Nothing leaves this computer: it only uses the browser's own copy. Used by every by-hand site (Naukri, Shine, Indeed, LinkedIn).
// fields = [{ label, value }] in the order the site asks for them (the server's per-site order).
// ---------------------------------------------------------------------------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX = 25; // what Windows clipboard history keeps
const GAP_MS = 450; // long enough for Windows to record each copy as its own item

async function put(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
const isWindows = () => typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent || '');

export default function FieldByFieldCopy({ fields = [], siteName = 'the site' }) {
  const list = (fields || []).filter((f) => f && String(f.value == null ? '' : f.value).trim() !== '').slice(0, MAX);
  const [st, setSt] = useState({ n: 0, running: false, done: false, err: '' });
  const live = useRef(true);
  if (!list.length) return null;
  const win = isWindows();

  async function run() {
    live.current = true;
    setSt({ n: 0, running: true, done: false, err: '' });
    for (let i = list.length - 1, n = 0; i >= 0; i -= 1, n += 1) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await put(String(list[i].value));
      if (!ok) { setSt({ n, running: false, done: false, err: 'The browser did not allow copying. Click anywhere on this TeamLink page, then press the button again.' }); return; }
      setSt({ n: n + 1, running: true, done: false, err: '' });
      // eslint-disable-next-line no-await-in-loop
      await wait(GAP_MS);
    }
    setSt({ n: list.length, running: false, done: true, err: '' });
  }

  return (
    <div className="fbf" role="group" aria-label="Copy every field">
      <div className="fbf-head"><b>Fill {siteName} without coming back here</b></div>
      <ol className="fbf-steps">
        <li>Press the button. Every field is copied, one after the other (takes a few seconds).</li>
        <li>On {siteName}: click a box, press <kbd>Win</kbd> + <kbd>V</kbd>, click the matching item.</li>
        <li>Next box: <kbd>Win</kbd> + <kbd>V</kbd> again, pick the next one. The list below is the same order (1 is on top).</li>
      </ol>
      {win
        ? <div className="fbf-tip">First time only: press <kbd>Win</kbd> + <kbd>V</kbd>. If Windows asks, click <b>Turn on</b>. Then come back and press the button.</div>
        : <div className="fbf-tip">Win + V is a Windows shortcut and this computer is not Windows. Use the Copy button beside each field instead.</div>}
      <div className="fbf-row">
        <button type="button" className="btn btn-primary" disabled={st.running} onClick={run}>
          {st.running ? `Copying ${st.n} of ${list.length}…` : st.done ? '✓ Copy again' : `Copy all ${list.length} fields, one by one`}
        </button>
        {st.done && <span className="fbf-ok" role="status">{`✓ ${list.length} fields are ready. Open ${siteName} and use Win + V.`}</span>}
      </div>
      {st.err && <div className="fbf-bad" role="alert">{st.err}</div>}
      <ol className="fbf-list" aria-label="The order in Win + V">
        {list.map((f) => (
          <li key={f.key || f.label}><b>{f.label}</b><span>{String(f.value).replace(/\s+/g, ' ').slice(0, 70)}{String(f.value).length > 70 ? '…' : ''}</span></li>
        ))}
      </ol>
    </div>
  );
}
