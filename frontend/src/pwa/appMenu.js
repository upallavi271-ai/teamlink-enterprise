import { useEffect, useState } from 'react';
import { isAppMode, pwaAvailable } from './pwa.js';

// ---------------------------------------------------------------------------
// WHEN THE SHORT PHONE MENU IS SHOWN (the menu itself is nav.js phoneGroupsFor).
//
//   short  = a phone-width screen (the slide-in menu) or the installed / Android app, and nobody asked for the full menu.
//   full   = the person tapped "Full menu" at the bottom of the phone menu; remembered for this session only (sessionStorage), so a
//            new visit starts short again. The computer menu is never touched.
// A separate company's copy (BRAND.separate) has no phone app, so pwaAvailable is false there and it always shows the full menu.
// ---------------------------------------------------------------------------
const FULL_KEY = 'tl_full_menu';
const EVENT = 'tl-appmenu';
const fullOn = () => { try { return sessionStorage.getItem(FULL_KEY) === '1'; } catch { return false; } };
export function setFullMenu(on) {
  try { if (on) sessionStorage.setItem(FULL_KEY, '1'); else sessionStorage.removeItem(FULL_KEY); } catch { /* the choice just is not remembered */ }
  window.dispatchEvent(new Event(EVENT));
}

// isPhoneWidth: the Shell's own "slide-in menu" test (under 900 px). Returns { phone, short, full, setFull }.
export function usePhoneMenu(isPhoneWidth) {
  const [, bump] = useState(0);
  useEffect(() => {
    const again = () => bump((n) => n + 1);
    window.addEventListener(EVENT, again);
    return () => window.removeEventListener(EVENT, again);
  }, []);
  const phone = pwaAvailable && (!!isPhoneWidth || isAppMode());
  const full = phone && fullOn();
  return { phone, full, short: phone && !full, setFull: setFullMenu };
}
