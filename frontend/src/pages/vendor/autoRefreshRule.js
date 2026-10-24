// The pure rule behind useAutoRefresh.js (no React here, so a plain Node test can run it).
export const EVERY_MS = 60000;
export const FOCUS_MIN_MS = 15000;
// Should the list ask the server again now? A hidden tab never asks; the minute timer asks when the data is a minute old; coming back to the
// tab (or focusing the window) asks when the data is older than 15 seconds.
export function shouldRefresh({ hidden, now, last, reason, every = EVERY_MS, focusMin = FOCUS_MIN_MS }) {
  if (hidden) return false;
  if (reason === 'focus') return now - last >= focusMin;
  return now - last >= every;
}
export const clock = (d) => (d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '');
