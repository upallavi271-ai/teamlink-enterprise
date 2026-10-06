// One section of the one-page Office & Accounts: a numbered heading that
// collapses, a line of context, the section's own controls on the right. The
// open / closed state is remembered per browser (a convenience only — the page
// works the same without it). `openSignal` changes when the page jumps here
// (an old ?tab= link), which opens it.
import { useEffect, useState } from 'react';
import InfoTip from './InfoTip.jsx';

const KEY = (id) => `oe-sec-open-${id}`;
function readOpen(id, dflt) {
  try {
    const v = window.localStorage.getItem(KEY(id));
    return v == null ? dflt : v === '1';
  } catch { return dflt; }
}

export default function Section({
  id, n, title, sub, info, right, children, defaultOpen = true, openSignal,
}) {
  const [open, setOpen] = useState(() => readOpen(id, defaultOpen));
  useEffect(() => { if (openSignal) setOpen(true); }, [openSignal]);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try { window.localStorage.setItem(KEY(id), next ? '1' : '0'); } catch { /* per-browser convenience only */ }
  };
  return (
    <section id={`oe-sec-${id}`} className={`oe-sec${open ? '' : ' closed'}`} aria-labelledby={`oe-sec-${id}-t`}>
      <div className="oe-sec-hd">
        <button type="button" className="oe-sec-tg" onClick={toggle} aria-expanded={open} aria-controls={`oe-sec-${id}-b`}>
          <span className="oe-sec-car" aria-hidden="true" />
          {n && <span className="oe-sec-n" aria-hidden="true">{n}</span>}
          <span className="oe-sec-t" id={`oe-sec-${id}-t`}>{title}</span>
        </button>
        {info && <InfoTip text={info} />}
        {sub && <span className="oe-sec-sub">{sub}</span>}
        {right && open && <div className="oe-sec-r">{right}</div>}
      </div>
      {open && <div className="oe-sec-bd" id={`oe-sec-${id}-b`}>{children}</div>}
    </section>
  );
}
