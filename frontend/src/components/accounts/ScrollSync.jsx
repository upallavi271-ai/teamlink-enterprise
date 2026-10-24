// ---------------------------------------------------------------------------
// SCROLL SYNC (Accounts spec S1.1) — a wide table with a horizontal scrollbar
// that is always on screen:
//   * a TOP bar just above the header row; once the page is scrolled it sticks
//     directly below the sticky page header(s);
//   * a BOTTOM bar (position: sticky; bottom: 0) while the table is on screen;
//   * both synced two ways with the table's own scrollLeft (trackpad,
//     shift + wheel and the bars all move the same thing);
//   * the header row (<thead>) follows the page down, under the top bar, and
//     the TOTAL row (<tfoot>) stays visible just above the bottom bar — both
//     only while the table is on screen, and never past its own rows;
//   * widths re-measured on resize, on column / row changes and on `deps`.
// The bars hide when the table is off screen or does not overflow.
//
//   <ScrollSync className="my-wrap" deps={[columns, rows.length]}>
//     <table>…<thead/>…<tbody/>…<tfoot/></table>
//   </ScrollSync>
//
// Props
//   children        the table (or anything wider than the box)
//   className       classes for the scrolling box (e.g. 'tbl-wrap my-tbl')
//   deps            extra values that should trigger a re-measure
//   top             px from the top of the window where the top bar sticks;
//                   default: auto = below `.topbar` and every element marked
//                   data-sticky-head (the page's own sticky header)
//   stickyHead      keep <thead> on screen while scrolling (default true)
//   stickyFoot      keep <tfoot> on screen while scrolling (default true)
//   label           tooltip on the bars (default 'Scroll the table sideways')
//   fit             (2026-10-14) THE STABLE MODE, used by Invoices and the Office
//                   expense table. The box is the ONE scroller of the table: as
//                   tall as the room under the app's sticky bars, with a native
//                   position: sticky header and TOTAL row, so the browser
//                   scrolls them on its compositor - no script runs while the
//                   page scrolls and nothing can lag, flicker or overlap. The
//                   old JS lift (translateY on every scroll event) is not used.
//   bodyRef         optional ref that receives the scrolling box element
// ---------------------------------------------------------------------------
import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
} from 'react';
import './ScrollSync.css';

// Where the sticky bars end: the app top bar plus any sticky bar under it
// (e.g. the Office filter bar), from their CSS top + height - not from where
// they are right now, so the number does not change while the page scrolls.
function stickyBottom() {
  let bottom = 0;
  const els = [document.querySelector('.topbar'), ...document.querySelectorAll('[data-sticky-head]')];
  els.forEach((el) => {
    if (!el) return;
    const cs = window.getComputedStyle(el);
    if (cs.position !== 'sticky' && cs.position !== 'fixed') return;
    const h = el.offsetHeight;
    if (h > 0) bottom = Math.max(bottom, (parseFloat(cs.top) || 0) + h);
  });
  return Math.round(bottom);
}

function autoTop() {
  let bottom = 0;
  const els = [document.querySelector('.topbar'), ...document.querySelectorAll('[data-sticky-head]')];
  els.forEach((el) => {
    if (!el) return;
    const cs = window.getComputedStyle(el);
    if (cs.position !== 'sticky' && cs.position !== 'fixed') return;
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.top < window.innerHeight / 2) bottom = Math.max(bottom, r.bottom);
  });
  return Math.round(bottom);
}

export default function ScrollSync({
  children, className = '', deps = [], top, stickyHead = true, stickyFoot = true, label = 'Scroll the table sideways',
  fit = false, bodyRef,
}) {
  const wrap = useRef(null);
  const body = useRef(null);
  const topBar = useRef(null);
  const botBar = useRef(null);
  const [w, setW] = useState({ sw: 0, cw: 0, bw: 0 });
  const [stickTop, setStickTop] = useState(typeof top === 'number' ? top : 0);
  const frame = useRef(0);

  const overflow = w.sw > w.cw + 1;

  const measure = useCallback(() => {
    const b = body.current;
    if (!b) return;
    // The bars are as wide as the box; their content is made so that a bar and
    // the table run out of scrolling at the same point.
    const bw = wrap.current ? wrap.current.clientWidth : b.offsetWidth;
    const next = { sw: b.scrollWidth, cw: b.clientWidth, bw };
    setW((cur) => (cur.sw === next.sw && cur.cw === next.cw && cur.bw === next.bw ? cur : next));
  }, []);

  // Keep the header / TOTAL rows on screen (translateY on their cells; a sticky
  // th cannot stick to the page from inside an overflow-x box).
  const place = useCallback(() => {
    frame.current = 0;
    const b = body.current;
    if (!b) return;
    const t = typeof top === 'number' ? top : (fit ? stickyBottom() : autoTop());
    setStickTop((cur) => (cur === t ? cur : t));
    // fit: the header / TOTAL rows are native sticky - nothing to move.
    if (fit) return;
    const table = b.querySelector('table');
    if (!table) return;
    const thead = table.tHead;
    const tfoot = table.tFoot;
    const br = b.getBoundingClientRect();
    const tbH = topBar.current && overflow ? topBar.current.offsetHeight + 4 : 0;
    const bbH = botBar.current && overflow ? botBar.current.offsetHeight + 6 : 0;
    const headH = thead ? thead.offsetHeight : 0;
    const footH = tfoot ? tfoot.offsetHeight : 0;
    const room = Math.max(0, table.offsetHeight - headH - footH);
    if (thead) {
      let dy = 0;
      if (stickyHead) {
        const natural = br.top + thead.offsetTop;
        dy = Math.max(0, Math.min(room, t + tbH - natural));
      }
      const v = dy ? `translateY(${Math.round(dy)}px)` : '';
      [...thead.rows].forEach((row) => [...row.cells].forEach((c) => { if (c.style.transform !== v) c.style.transform = v; }));
      thead.classList.toggle('tlss-lifted', dy > 0);
    }
    if (tfoot) {
      let dy = 0;
      if (stickyFoot) {
        const naturalBottom = br.top + tfoot.offsetTop + footH;
        const limit = window.innerHeight - bbH;
        dy = Math.min(0, Math.max(-room, limit - naturalBottom));
      }
      const v = dy ? `translateY(${Math.round(dy)}px)` : '';
      [...tfoot.rows].forEach((row) => [...row.cells].forEach((c) => { if (c.style.transform !== v) c.style.transform = v; }));
      tfoot.classList.toggle('tlss-lifted', dy < 0);
    }
  }, [top, overflow, stickyHead, stickyFoot, fit]);
  // Once per frame; a timer backs the frame up (a frame never comes while the
  // window is hidden, and the rows must still be right when it shows again).
  const schedule = useCallback(() => {
    if (frame.current) return;
    let done = false;
    const run = () => { if (done) return; done = true; window.cancelAnimationFrame(raf); clearTimeout(tm); place(); };
    const raf = window.requestAnimationFrame(run);
    const tm = setTimeout(run, 60);
    frame.current = { cancel: () => { done = true; window.cancelAnimationFrame(raf); clearTimeout(tm); } };
  }, [place]);

  // Two-way scrollLeft sync. The echo a move causes finds the others already
  // at the same place, so it stops there (no loop).
  const from = (src) => () => {
    const x = src === 'body' ? body.current?.scrollLeft : (src === 'top' ? topBar.current?.scrollLeft : botBar.current?.scrollLeft);
    if (x == null) return;
    [['body', body], ['top', topBar], ['bot', botBar]].forEach(([k, r]) => {
      if (k !== src && r.current && Math.abs(r.current.scrollLeft - x) > 0.5) r.current.scrollLeft = x;
    });
  };

  useLayoutEffect(() => { measure(); schedule(); });
  useEffect(() => {
    const b = body.current;
    if (!b) return undefined;
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { measure(); schedule(); }) : null;
    if (ro) { ro.observe(b); const t = b.querySelector('table'); if (t) ro.observe(t); }
    const mo = new MutationObserver(() => { measure(); schedule(); });
    mo.observe(b, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    // The lifted rows follow the page, so the old mode needs the scroll events;
    // fit mode does not listen to scrolling at all.
    if (!fit) window.addEventListener('scroll', schedule, true);
    return () => {
      ro?.disconnect(); mo.disconnect();
      window.removeEventListener('resize', schedule);
      if (!fit) window.removeEventListener('scroll', schedule, true);
      if (frame.current) frame.current.cancel();
      frame.current = 0;
    };
  }, [measure, schedule, fit]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { measure(); schedule(); }, deps);

  // The bars follow the table's width only - never the scroll position - so
  // they cannot appear / disappear (and push the table) while the page scrolls.
  const showBars = overflow;
  useEffect(() => { if (bodyRef) bodyRef.current = body.current; });
  // A bar that comes back into view starts where the table is.
  useEffect(() => {
    if (!showBars || !body.current) return;
    const x = body.current.scrollLeft;
    [topBar, botBar].forEach((r) => { if (r.current) r.current.scrollLeft = x; });
  }, [showBars, w.sw]);
  const inner = <div className="tlss-inner" style={{ width: Math.max(0, w.sw - w.cw + w.bw) }} />;
  return (
    <div ref={wrap} className={`tlss${showBars ? ' tlss-on' : ''}${fit ? ' tlss-fit' : ''}`} style={{ '--tlss-top': `${stickTop}px`, '--tlss-room': `${stickTop + 70}px` }}>
      <div ref={topBar} className="tlss-bar tlss-top" onScroll={from('top')} title={label} aria-hidden="true" hidden={!showBars}>
        {inner}
      </div>
      <div ref={body} className={`tlss-body ${className}`.trim()} onScroll={from('body')}>
        {children}
      </div>
      <div ref={botBar} className="tlss-bar tlss-bot" onScroll={from('bot')} title={label} aria-hidden="true" hidden={!showBars}>
        {inner}
      </div>
    </div>
  );
}
