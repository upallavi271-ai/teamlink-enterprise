// ---------------------------------------------------------------------------
// PAGE STRUCTURE SNAPSHOT (a help for fixing a broken selector; NOT a copy of the page).
//
// When a step cannot find its element, the run saves the SHAPE of the page: tags, ids, names, roles, labels and the wording
// of buttons and labels, so a person can see what the site calls things now. It NEVER holds:
//   * a value typed in any box (no "value" attribute, no textarea / select content, no hidden inputs)
//   * the text of headings, paragraphs, links, table cells or list items (that is where names and job text live)
//   * the query string of a link or the address query (only the path)
//   * an e-mail address or a long number (replaced by [email] / [number] in anything that is kept)
// The result is plain indented pseudo-HTML text, saved next to the screenshots (same private folder, same protected route).
// ---------------------------------------------------------------------------
const MAX_LINES = 500;

// Runs INSIDE the page. Kept as one self-contained function so it can be passed to page.evaluate.
function inPage(max) {
  const KEEP_TAGS = new Set(['form', 'input', 'select', 'textarea', 'button', 'a', 'label', 'legend', 'fieldset', 'table', 'thead', 'th', 'iframe', 'dialog', 'nav', 'main', 'header', 'footer', 'section', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4']);
  const TEXT_TAGS = new Set(['button', 'label', 'legend', 'th']);
  const ATTRS = ['id', 'name', 'type', 'role', 'aria-label', 'placeholder', 'data-testid', 'data-test', 'for', 'autocomplete', 'contenteditable', 'disabled', 'required', 'aria-haspopup', 'aria-expanded'];
  const redact = (t) => String(t).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]').replace(/\d{5,}/g, '[number]');
  const lines = [];
  const walk = (el, depth) => {
    if (lines.length >= max || depth > 14) return;
    const tag = el.tagName.toLowerCase();
    if (['script', 'style', 'noscript', 'svg', 'path', 'meta', 'link', 'head', 'template'].includes(tag)) return;
    const hasId = el.id || el.getAttribute('role') || el.getAttribute('data-testid') || el.getAttribute('aria-label');
    const interesting = KEEP_TAGS.has(tag) || hasId;
    let shown = false;
    if (interesting) {
      if (tag === 'input' && String(el.getAttribute('type') || '').toLowerCase() === 'hidden') return;
      const parts = [tag];
      ATTRS.forEach((a) => {
        const v = el.getAttribute(a);
        if (v !== null && v !== '') parts.push(`${a}="${redact(v).slice(0, 60)}"`);
      });
      const cls = (el.getAttribute('class') || '').split(/\s+/).filter((c) => c && c.length <= 24 && !/\d{3,}/.test(c)).slice(0, 3);
      if (cls.length) parts.push(`class="${cls.join(' ')}"`);
      if (tag === 'a') {
        try { const u = new URL(el.getAttribute('href') || '', location.href); parts.push(`href="${redact(u.pathname).slice(0, 60)}"`); } catch (e) { /* no href */ }
      }
      let text = '';
      if (TEXT_TAGS.has(tag)) text = redact((el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 40);
      if (tag === 'input' && ['submit', 'button'].includes(String(el.getAttribute('type') || '').toLowerCase())) text = redact(String(el.value || '')).slice(0, 40);
      try { if (el.offsetParent === null && tag !== 'body' && getComputedStyle(el).position !== 'fixed') parts.push('hidden'); } catch (e) { /* ignore */ }
      lines.push(`${'  '.repeat(Math.min(depth, 12))}<${parts.join(' ')}>${text ? ` ${text}` : ''}`);
      shown = true;
    }
    if (['textarea', 'select', 'input', 'script'].includes(tag)) return;
    Array.from(el.children).forEach((c) => walk(c, shown ? depth + 1 : depth));
  };
  if (document.body) walk(document.body, 0);
  return lines;
}

// -> a string (plain text) or null
async function capture(page, { portal = '', step = '' } = {}) {
  try {
    const lines = await page.evaluate(inPage, MAX_LINES);
    let path = '';
    try { path = new URL(page.url()).pathname; } catch { path = ''; }
    const head = [
      '<!-- TeamLink page structure snapshot. Tags, ids, names, roles and button / label wording only.',
      '     No typed values, no headings, no paragraph or link text, no query strings. -->',
      `<!-- portal: ${String(portal).slice(0, 30)}  step: ${String(step).slice(0, 60)}  page path: ${path.slice(0, 80)}  taken: ${new Date().toISOString()} -->`,
    ];
    return `${head.join('\n')}\n${lines.join('\n')}\n${lines.length >= MAX_LINES ? '<!-- cut at 500 lines -->\n' : ''}`;
  } catch {
    return null;
  }
}

module.exports = { capture, inPage, MAX_LINES };
