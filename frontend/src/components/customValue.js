// Shared helpers for "type your own value" in Combo and MultiPick (2026-10-14).
export const CUSTOM_MAX = 80;

// Trim, collapse spaces, drop anything that looks like HTML, cap the length.
// Capitalisation is kept exactly as typed.
export function cleanCustom(text, max = CUSTOM_MAX) {
  return String(text == null ? '' : text)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

// The existing option a typed text really means (case / spacing insensitive), or null.
export function sameOption(options, text) {
  const k = String(text).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!k) return null;
  return options.find((o) => o.value !== '' && (String(o.label).toLowerCase().replace(/\s+/g, ' ').trim() === k
    || String(o.value).toLowerCase().replace(/\s+/g, ' ').trim() === k)) || null;
}

// -> { value, existing } or { error }. validateCustom(text) may return an error string.
export function resolveCustom(options, raw, validateCustom) {
  const text = cleanCustom(raw);
  if (!text) return { error: '' };
  const hit = sameOption(options, text);
  if (hit) return { value: hit.value, existing: true };
  if (validateCustom) {
    const bad = validateCustom(text);
    if (bad) return { error: typeof bad === 'string' ? bad : 'That value is not allowed.' };
  }
  return { value: text, existing: false };
}
