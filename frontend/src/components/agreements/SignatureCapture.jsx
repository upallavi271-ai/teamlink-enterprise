// ---------------------------------------------------------------------------
// SIGNATURE CAPTURE — the three e-sign options, one output.
//
//   Type    the name, rendered in a signature font (three styles to pick)
//   Draw    a pad for finger / mouse / stylus (pointer events, so touch works)
//   Upload  a PNG or JPG of a signature
//
// Whichever is used, the parent gets the same thing back through onChange:
//   { method: 'typed' | 'drawn' | 'uploaded', blob: Blob (PNG/JPG) | null }
// so the server stores and prints one kind of signature image.
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from 'react';
import './agreements.css';

const FONTS = [
  ['Classic', "'Segoe Script', 'Brush Script MT', 'Lucida Handwriting', cursive"],
  ['Flowing', "'Brush Script MT', 'Segoe Script', cursive"],
  ['Neat', "'Lucida Handwriting', 'Segoe Print', 'Comic Sans MS', cursive"],
];

function typedToBlob(name, font) {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 260;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#1f2a44';
    let size = 110;
    ctx.font = `${size}px ${font}`;
    while (ctx.measureText(name).width > canvas.width - 60 && size > 30) {
      size -= 6;
      ctx.font = `${size}px ${font}`;
    }
    ctx.textBaseline = 'middle';
    ctx.fillText(name, 30, canvas.height / 2);
    canvas.toBlob((b) => resolve(b), 'image/png');
  });
}

function DrawPad({ onBlob }) {
  const ref = useRef(null);
  const drawing = useRef(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const canvas = ref.current;
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1f2a44';
  }, []);

  const pos = (e) => {
    const r = ref.current.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  function down(e) {
    e.preventDefault();
    ref.current.setPointerCapture?.(e.pointerId);
    drawing.current = true;
    const ctx = ref.current.getContext('2d');
    const [x, y] = pos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 0.1, y + 0.1);
    ctx.stroke();
  }
  function move(e) {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = ref.current.getContext('2d');
    const [x, y] = pos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  }
  function up() {
    if (!drawing.current) return;
    drawing.current = false;
    setDirty(true);
    ref.current.toBlob((b) => onBlob(b), 'image/png');
  }
  function clear() {
    const canvas = ref.current;
    const ctx = canvas.getContext('2d');
    const r = canvas.getBoundingClientRect();
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, r.width, r.height);
    setDirty(false);
    onBlob(null);
  }
  return (
    <div>
      <canvas
        ref={ref}
        className="sig-pad"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={up}
        aria-label="Signature pad — draw your signature"
      />
      <div className="sig-row">
        <span className="small-muted">{dirty ? 'Looks good? Save it below.' : 'Sign inside the box with your finger, mouse or stylus.'}</span>
        <button type="button" className="btn btn-sm" onClick={clear}>Clear</button>
      </div>
    </div>
  );
}

export default function SignatureCapture({ name, onChange, disabled = false }) {
  const [method, setMethod] = useState('typed');
  const [font, setFont] = useState(FONTS[0][1]);
  const [upload, setUpload] = useState(null);
  const [preview, setPreview] = useState('');

  // Typed: re-render the image whenever the name or style changes.
  useEffect(() => {
    let live = true;
    if (method !== 'typed') return undefined;
    const n = String(name || '').trim();
    if (n.length < 2) { onChange({ method, blob: null }); return undefined; }
    typedToBlob(n, font).then((b) => { if (live) onChange({ method: 'typed', blob: b }); });
    return () => { live = false; };
  }, [method, name, font]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (method !== 'uploaded' || !upload) { setPreview(''); return undefined; }
    const url = URL.createObjectURL(upload);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [method, upload]);

  function pick(m) {
    setMethod(m);
    if (m === 'uploaded') onChange({ method: m, blob: upload });
    if (m === 'drawn') onChange({ method: m, blob: null });
  }

  return (
    <div className={`sig-capture${disabled ? ' is-disabled' : ''}`}>
      <div className="sig-tabs" role="tablist">
        {[['typed', 'Type'], ['drawn', 'Draw'], ['uploaded', 'Upload']].map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={method === k} className={`sig-tab${method === k ? ' on' : ''}`} onClick={() => pick(k)} disabled={disabled}>
            {label}
          </button>
        ))}
      </div>

      {method === 'typed' && (
        <div>
          <div
            className="sig-typed"
            // Shrink long names so the whole signature shows, as it will in the image.
            style={{ fontFamily: font, fontSize: `${Math.max(18, Math.min(42, Math.round(560 / Math.max(8, String(name || 'Your name').trim().length))))}px` }}
          >
            {String(name || '').trim() || 'Your name'}
          </div>
          <div className="sig-fonts">
            {FONTS.map(([label, f]) => (
              <button key={label} type="button" className={`sig-font${font === f ? ' on' : ''}`} style={{ fontFamily: f }} onClick={() => setFont(f)}>
                {label}
              </button>
            ))}
          </div>
          <div className="small-muted">Your typed name, in the style you choose, is your signature.</div>
        </div>
      )}

      {method === 'drawn' && <DrawPad onBlob={(b) => onChange({ method: 'drawn', blob: b })} />}

      {method === 'uploaded' && (
        <div>
          <input
            type="file"
            accept="image/png,image/jpeg"
            disabled={disabled}
            onChange={(e) => { const f = e.target.files[0] || null; setUpload(f); onChange({ method: 'uploaded', blob: f }); }}
          />
          {preview && <img className="sig-preview" src={preview} alt="Uploaded signature preview" />}
          <div className="small-muted">A clear PNG or JPG of the signature on white paper, up to 5 MB.</div>
        </div>
      )}
    </div>
  );
}
