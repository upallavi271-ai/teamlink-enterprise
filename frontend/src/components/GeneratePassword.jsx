import { useState } from 'react';

// "Generate a strong password" for the reset-password forms (Super Admin / Admin / HR hand a starting password to a person).
// The existing password of anybody is stored hashed and can NEVER be read back (nobody, not even the Super Admin, can see it) - so the way to
// "know" a login's password is to set a new one: this makes a random one, shows it HERE once so it can be copied and given to the person, and puts
// it in the form. The person must change it at the next sign-in (the server enforces that).
const PICK = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; // no look-alikes (0 O 1 l I)
function make(len = 12) {
  const c = window.crypto || window.msCrypto;
  const buf = new Uint32Array(len);
  c.getRandomValues(buf);
  let out = Array.from(buf, (n) => PICK[n % PICK.length]).join('');
  // always one capital, one small letter and one digit
  if (!/[A-Z]/.test(out)) out = `K${out.slice(1)}`;
  if (!/[a-z]/.test(out)) out = `${out.slice(0, 1)}k${out.slice(2)}`;
  if (!/\d/.test(out)) out = `${out.slice(0, 2)}7${out.slice(3)}`;
  return out;
}

export default function GeneratePassword({ onGenerate }) {
  const [shown, setShown] = useState('');
  const [copied, setCopied] = useState(false);
  const generate = () => { const p = make(); setShown(p); setCopied(false); onGenerate(p); };
  const copy = async () => { try { await navigator.clipboard.writeText(shown); setCopied(true); } catch { setCopied(false); } };
  return (
    <div style={{ margin: '6px 0 10px' }}>
      <button type="button" className="btn btn-sm" onClick={generate}>Generate a strong password</button>
      {shown && (
        <span style={{ marginLeft: 10 }}>
          <code style={{ fontFamily: 'Consolas, "Courier New", monospace', fontSize: 14, background: 'var(--bg-soft, #f3f6fb)', padding: '3px 8px', borderRadius: 6 }}>{shown}</code>
          <button type="button" className="btn btn-sm" style={{ marginLeft: 6 }} onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
          <span className="small-muted" style={{ marginLeft: 8 }}>Shown only here. Give it to the person; they change it at their next sign-in.</span>
        </span>
      )}
    </div>
  );
}
