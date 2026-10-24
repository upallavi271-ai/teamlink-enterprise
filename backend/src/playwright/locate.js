// ---------------------------------------------------------------------------
// SELECTOR ENTRIES (the "self-healing" building block).
//
// A page setting (src/portals/selectors/<portal>.json) lists SEVERAL ways to find one thing on a page. Each way is an
// "entry", and the runner tries them IN ORDER; the first visible one wins. An entry is either
//
//   a string                      a CSS or Playwright selector:   "button:has-text('Post Job')", "role=button[name='Post']", "text=Logout"
//   an object, ONE of these keys  { "role": "button", "name": "Post Job" }      by ARIA role (+ accessible name)
//                                 { "label": "Job title" }                      by the text of its <label>
//                                 { "text": "Post Job" }                        by visible text
//                                 { "placeholder": "Job title" }                by placeholder
//                                 { "testId": "post-job" }                      by data-testid
//                                 { "css": "input[name='jobTitle']" }           plain CSS
//
// Role / label / text entries survive a redesign better than CSS, so each step should hold both kinds. The FIRST entry
// is the "main" selector: when it does not match and a later one does, the run records "selector drift" (see
// BasePortal.noteSelector and docs/job-publishing/PLAYWRIGHT.md). Nothing here ever guesses: an entry that is not in the
// file is never tried.
// ---------------------------------------------------------------------------
const KINDS = ['role', 'label', 'text', 'placeholder', 'testId', 'css'];

const fill = (s, vars) => String(s == null ? '' : s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined ? String(vars[k]) : m));

// 'role' | 'label' | 'text' | 'placeholder' | 'testId' | 'css' | 'selector' (a plain string)  |  null (not a valid entry)
function kindOf(entry) {
  if (typeof entry === 'string') return entry.trim() ? 'selector' : null;
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) return KINDS.find((x) => entry[x] !== undefined && entry[x] !== null && entry[x] !== '') || null;
  return null;
}

// The family an entry belongs to, for the coverage report: role / label / text / css. A string that starts with
// "role=" / "text=" / "label=", or that matches by visible text (":has-text("), counts as that family; the rest is css.
function family(entry) {
  const k = kindOf(entry);
  if (!k) return null;
  if (k === 'selector') {
    const s = String(entry).trim();
    if (/^role=/i.test(s)) return 'role';
    if (/^label=/i.test(s)) return 'label';
    if (/^text=/i.test(s) || s.includes(':has-text(') || s.includes(':text(')) return 'text';
    return 'css';
  }
  return ['role', 'label', 'text'].includes(k) ? k : 'css';
}

// A short, safe description for logs and the screen (never a value typed by anyone).
function describe(entry, vars) {
  const k = kindOf(entry);
  if (!k) return '(invalid entry)';
  if (k === 'selector') return fill(entry, vars).slice(0, 120);
  if (k === 'role') return `role ${entry.role}${entry.name ? ` "${fill(entry.name, vars)}"` : ''}`.slice(0, 120);
  return `${k} "${fill(entry[k], vars)}"`.slice(0, 120);
}

// -> a Playwright Locator (not yet resolved).  `esc` quotes a value for a string selector (BasePortal passes its own).
function build(page, entry, vars, esc = (s) => s) {
  const k = kindOf(entry);
  if (!k) throw new Error('not a valid selector entry');
  if (k === 'selector') {
    const s = String(entry).replace(/\{(\w+)\}/g, (m, key) => (vars && vars[key] !== undefined ? esc(vars[key]) : m));
    return page.locator(s);
  }
  if (k === 'css') return page.locator(fill(entry.css, vars));
  if (k === 'role') {
    const o = {};
    if (entry.name !== undefined) o.name = fill(entry.name, vars);
    if (entry.exact) o.exact = true;
    return page.getByRole(entry.role, o);
  }
  const opts = entry.exact ? { exact: true } : {};
  if (k === 'label') return page.getByLabel(fill(entry.label, vars), opts);
  if (k === 'text') return page.getByText(fill(entry.text, vars), opts);
  if (k === 'placeholder') return page.getByPlaceholder(fill(entry.placeholder, vars), opts);
  return page.getByTestId(fill(entry.testId, vars));
}

// Is this list well formed? -> list of problems (plain words)
function check(list, label) {
  const out = [];
  const arr = list == null ? [] : (Array.isArray(list) ? list : [list]);
  arr.forEach((e, i) => { if (!kindOf(e)) out.push(`${label}: entry ${i + 1} is not a selector`); });
  return out;
}

module.exports = {
  KINDS, kindOf, family, describe, build, check, fill,
};
