import { useCallback, useEffect, useRef, useState } from 'react';

// The phone menu (user, 2026-10-12: "mobile lo sidebar open close laaga
// pettali"). Below DRAWER_MQ the sidebar is a slide-in drawer; this hook owns
// everything that is not markup:
//   - open / close state (always closed on load, never remembered)
//   - closes on Escape, on a route change, on a left swipe, and when the
//     screen grows past the breakpoint (so no backdrop or scroll lock is left)
//   - locks the page scroll while open (html.tl-nav-open, styled in MobileNav.css)
//   - moves focus into the drawer on open, keeps Tab inside it, and puts focus
//     back on the Menu button on close
// The breakpoint matches the one in styles.css (max-width:900px).

export const DRAWER_MQ = '(max-width: 900px)';
export const PHONE_MQ = '(max-width: 640px)';

export function useMediaQuery(query) {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false);
  const [match, setMatch] = useState(get);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    if (mq.addEventListener) mq.addEventListener('change', on); else mq.addListener(on);
    // Belt and braces: some browsers are late with the 'change' event on a rotate.
    window.addEventListener('resize', on);
    window.addEventListener('orientationchange', on);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', on); else mq.removeListener(on);
      window.removeEventListener('resize', on);
      window.removeEventListener('orientationchange', on);
    };
  }, [query]);
  return match;
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';

export default function useMobileDrawer(routeKey) {
  const isMobile = useMediaQuery(DRAWER_MQ);
  const [open, setOpen] = useState(false);
  const drawerRef = useRef(null);
  const toggleRef = useRef(null);
  const closeRef = useRef(null);
  const wasOpen = useRef(false);

  const openDrawer = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);

  // Past the breakpoint (rotate / resize) the drawer is just the desktop sidebar.
  useEffect(() => { if (!isMobile) setOpen(false); }, [isMobile]);
  // Any navigation closes it.
  useEffect(() => { setOpen(false); }, [routeKey]);

  useEffect(() => {
    if (!open) return undefined;
    const root = document.documentElement;
    root.classList.add('tl-nav-open');
    const t = setTimeout(() => { if (closeRef.current) closeRef.current.focus(); }, 30);

    function onKey(e) {
      if (e.key === 'Escape') { setOpen(false); return; }
      if (e.key !== 'Tab' || !drawerRef.current) return;
      const list = Array.from(drawerRef.current.querySelectorAll(FOCUSABLE))
        .filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      const at = document.activeElement;
      if (!drawerRef.current.contains(at)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey);
      root.classList.remove('tl-nav-open');
    };
  }, [open]);

  // Back to the Menu button after it closes (not on first load).
  useEffect(() => {
    if (wasOpen.current && !open) {
      const a = document.activeElement;
      const inside = drawerRef.current && drawerRef.current.contains(a);
      if (toggleRef.current && (inside || !a || a === document.body)) toggleRef.current.focus();
    }
    wasOpen.current = open;
  }, [open]);

  // Swipe left on the drawer closes it.
  const swipe = useRef(null);
  const touch = {
    onTouchStart: (e) => { const t = e.touches[0]; swipe.current = { x: t.clientX, y: t.clientY }; },
    onTouchEnd: (e) => {
      const s = swipe.current; swipe.current = null;
      if (!s) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      if (dx < -60 && Math.abs(dx) > Math.abs(dy) * 1.5) setOpen(false);
    },
  };

  return { isMobile, open: isMobile && open, openDrawer, close, drawerRef, toggleRef, closeRef, touch };
}
