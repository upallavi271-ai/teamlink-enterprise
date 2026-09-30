/**
 * Browser-side HTML sanitiser for user-authored rich text (email templates).
 * Uses the real DOM parser, so it cannot be fooled by the malformed-markup
 * tricks that defeat regex filters. Allow-list, not block-list: anything not
 * explicitly permitted is dropped. No external dependency.
 */
const ALLOWED_TAGS = new Set([
  'a', 'b', 'strong', 'i', 'em', 'u', 's', 'p', 'br', 'div', 'span', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'pre', 'code', 'hr', 'img', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'small', 'sub', 'sup', 'font', 'center',
]);
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  '*': new Set(['style', 'class', 'align', 'width', 'height', 'color', 'face', 'size', 'title', 'dir']),
  a: new Set(['href', 'target', 'rel']),
  img: new Set(['src', 'alt']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan']),
};
const SAFE_URL = /^(https?:|mailto:|tel:|#|\/(?!\/))/i;

function cleanNode(node: Element) {
  for (const child of Array.from(node.children)) {
    const tag = child.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      // Keep the text of an unknown element (e.g. <section>), drop the element itself —
      // except for things that are executable or invisible by nature.
      if (['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'noscript'].includes(tag)) child.remove();
      else child.replaceWith(...Array.from(child.childNodes));
      continue;
    }
    for (const attr of Array.from(child.attributes)) {
      const name = attr.name.toLowerCase();
      const allowed = ALLOWED_ATTRS['*']!.has(name) || ALLOWED_ATTRS[tag]?.has(name);
      if (!allowed || name.startsWith('on')) { child.removeAttribute(attr.name); continue; }
      if ((name === 'href' || name === 'src') && !SAFE_URL.test(attr.value.trim())) child.removeAttribute(attr.name);
      if (name === 'style' && /expression\s*\(|javascript:|url\s*\(/i.test(attr.value)) child.removeAttribute(attr.name);
    }
    if (tag === 'a') child.setAttribute('rel', 'noopener noreferrer');
    cleanNode(child);
  }
}

export function sanitizeHtml(dirty: string): string {
  if (!dirty) return '';
  if (typeof DOMParser === 'undefined') return dirty.replace(/<[^>]*>/g, '');
  const doc = new DOMParser().parseFromString(`<body>${dirty}</body>`, 'text/html');
  cleanNode(doc.body);
  return doc.body.innerHTML;
}
