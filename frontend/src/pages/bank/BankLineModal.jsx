// The "Bank statement line" window: one statement line, opened in place from the Bank statements table
// (and from Hand loans' "View line"). Read only. A centred window over a dimmed page; close with the ×,
// the Close button, Escape or a click on the dimmed part. Focus stays inside it while it is open and goes
// back to the row (or button) that opened it. It scrolls inside on a small screen.
//
// What it says comes from ./bankLineMessage.js (pure, tested): the nine facts and the sentence in the box.
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { money2, fmtD } from '../invoices/invFormat';
import { DASH, lineModel } from './bankLineMessage';
import './bank-s6.css';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const moneyOrDash = (v) => (v == null ? DASH : money2(v));
const dateOrDash = (v) => (v && v !== DASH ? fmtD(v) : DASH);

export default function BankLineModal({
  row, bank, detail = null, loading = false, failed = false, onClose, returnFocusTo = null, extraRows = [],
}) {
  const m = lineModel({
    row, bank, detail, loading, failed,
  });
  const box = useRef(null);
  const closeBtn = useRef(null);
  const titleId = useId();
  const noteId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Open: remember where focus was, move it into the window, stop the page behind from scrolling.
  // Close: give focus back to the row / button that opened it.
  useEffect(() => {
    const opener = returnFocusTo || document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (closeBtn.current) closeBtn.current.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape closes; Tab / Shift+Tab never leave the window (a focus trap).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeRef.current(); return; }
      if (e.key !== 'Tab' || !box.current) return;
      const items = [...box.current.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (!box.current.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  const out = m.direction === 'out';
  const rows = [
    ['Date', <span className="s6-mono">{dateOrDash(m.date)}</span>],
    ['Account', m.account],
    ['Narration on the statement', <span className="s6-mono">{m.narration}</span>],
    ...(m.moneyOut !== undefined ? [['Money out', <span className="s6-mono s6-red">{moneyOrDash(m.moneyOut)}</span>]] : []),
    ...(m.moneyIn !== undefined ? [['Money in', <span className="s6-mono s6-green">{moneyOrDash(m.moneyIn)}</span>]] : []),
    ['Balance after', <span className="s6-mono">{moneyOrDash(m.balanceAfter)}</span>],
    ...extraRows,
    ['Filed as', m.loading ? 'Loading…' : m.filedAs],
    ['Amount filed', m.loading ? 'Loading…' : <span className="s6-mono">{moneyOrDash(m.amountFiled)}</span>],
  ];

  return createPortal(
    <div className="s6-overlay top bkl-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} className="s6-modal narrow bkl-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={noteId}>
        <div className="s6-modal-head">
          <div>
            <h3 id={titleId}>{m.title}</h3>
            <div className="s6-sub">{[m.subtitle[0], m.subtitle[1], dateOrDash(m.subtitle[2])].join(' · ')}</div>
          </div>
          <button ref={closeBtn} type="button" className="s6-x" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="s6-modal-body">
          <div className="s6-kv dashed" data-direction={out ? 'out' : 'in'}>
            {rows.map(([k, v]) => (
              <div className="s6-kv-row" key={k}><span>{k}</span><span>{v}</span></div>
            ))}
          </div>
          <div id={noteId} className={`s6-dash bkl-note ${m.message.tone}`} role={m.message.tone === 'amber' ? 'status' : undefined} style={{ marginBottom: 0 }}>
            <span>
              <b>{m.message.title}</b>
              {m.message.text ? ` ${m.message.text}` : ''}
            </span>
          </div>
        </div>
        <div className="s6-modal-foot">
          <button type="button" className="s6-btn s6-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
