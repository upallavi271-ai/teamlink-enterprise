// ---------------------------------------------------------------------------
// A SMALL, STRICT XML READER + EXCLUSIVE CANONICAL XML + XML-DSIG CHECK, for SAML 2.0 sign-in (utils/atsPlus/sso.js). No package:
// the app adds no dependency for this. It reads only what a SAML response is: elements, attributes, text, CDATA, comments.
// A DOCTYPE / ENTITY is refused (no XXE), so are unknown entities.
//
//   parse(xml)                      -> the root element { name, prefix, local, attrs, children, parent, ns }
//   c14n(el, { exclude })           Exclusive XML Canonicalization 1.0 (without comments) of one element
//   verifySignature(root, certPem)  -> { ok, refId, error }: the enveloped signature of the Response or of the ONE Assertion,
//                                      digest (SHA-256 / SHA-1) and RSA signature checked with the IdP certificate
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const NS_DS = 'http://www.w3.org/2000/09/xmldsig#';
const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decode(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    if (ENT[e] === undefined) throw new Error(`Unknown entity &${e};`);
    return ENT[e];
  });
}
function split(qname) { const i = qname.indexOf(':'); return i < 0 ? { prefix: '', local: qname } : { prefix: qname.slice(0, i), local: qname.slice(i + 1) }; }
function parse(xml) {
  const src = String(xml || '');
  if (/<!DOCTYPE|<!ENTITY/i.test(src)) throw new Error('A DOCTYPE is not allowed.');
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  const root = { children: [] }; let cur = root; let m;
  while ((m = re.exec(src))) {
    if (m[0].startsWith('<!--') || m[0].startsWith('<?')) continue; // eslint-disable-line no-continue
    if (m[1] !== undefined) { if (cur !== root) cur.children.push({ type: 'text', value: m[1], parent: cur }); continue; } // eslint-disable-line no-continue
    if (m[2]) { if (cur.name !== m[2]) throw new Error(`Bad XML: </${m[2]}> does not close <${cur.name}>.`); cur = cur.parent || root; continue; } // eslint-disable-line no-continue
    if (m[3]) {
      const el = { type: 'el', name: m[3], ...split(m[3]), attrs: [], children: [], parent: cur === root ? null : cur, ns: {} };
      const ar = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g; let a;
      while ((a = ar.exec(m[4] || ''))) {
        const name = a[1]; const value = decode(a[3] !== undefined ? a[3] : a[4]);
        if (name === 'xmlns') el.ns[''] = value;
        else if (name.startsWith('xmlns:')) el.ns[name.slice(6)] = value;
        else el.attrs.push({ name, ...split(name), value });
      }
      (cur === root ? root.children : cur.children).push(el);
      if (!m[5]) cur = el;
      continue; // eslint-disable-line no-continue
    }
    if (m[6] !== undefined) {
      if (cur === root) { if (m[6].trim()) throw new Error('Bad XML: text outside the root.'); continue; } // eslint-disable-line no-continue
      cur.children.push({ type: 'text', value: decode(m[6]), parent: cur });
    }
  }
  if (cur !== root) throw new Error('Bad XML: an element is not closed.');
  const els = root.children.filter((c) => c.type === 'el');
  if (els.length !== 1) throw new Error('Bad XML: one root element expected.');
  return els[0];
}
function lookup(el, prefix) { for (let e = el; e; e = e.parent) if (Object.prototype.hasOwnProperty.call(e.ns, prefix)) return e.ns[prefix]; return prefix === 'xml' ? 'http://www.w3.org/XML/1998/namespace' : (prefix === '' ? '' : null); }
const nsOf = (el) => lookup(el, el.prefix);
const attrNs = (el, a) => (a.prefix ? lookup(el, a.prefix) : '');
function children(el, local, ns) { return el.children.filter((c) => c.type === 'el' && c.local === local && (!ns || nsOf(c) === ns)); }
function all(el, local, ns, out = []) { if (el.type === 'el') { if (el.local === local && (!ns || nsOf(el) === ns)) out.push(el); el.children.forEach((c) => all(c, local, ns, out)); } return out; }
function text(el) { return el.children.map((c) => (c.type === 'text' ? c.value : text(c))).join(''); }
const escT = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
const escA = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');

// Exclusive c14n: each element renders the namespaces it (or its attributes) visibly uses, when not already rendered above it.
function c14n(el, { exclude = null, inclusive = [] } = {}) {
  function render(e, rendered) {
    if (e === exclude) return '';
    if (e.type === 'text') return escT(e.value);
    const used = new Set([e.prefix]);
    e.attrs.forEach((a) => { if (a.prefix && a.prefix !== 'xml') used.add(a.prefix); });
    inclusive.forEach((p) => { if (lookup(e, p === '#default' ? '' : p) !== null) used.add(p === '#default' ? '' : p); });
    const mine = { ...rendered }; const decls = [];
    [...used].sort().forEach((p) => {
      const uri = lookup(e, p);
      if (uri === null || p === 'xml') return;
      if (p === '' && uri === '' && (rendered[''] === undefined || rendered[''] === '')) return;
      if (rendered[p] === uri) return;
      mine[p] = uri; decls.push(p === '' ? ` xmlns="${escA(uri)}"` : ` xmlns:${p}="${escA(uri)}"`);
    });
    const attrs = e.attrs.map((a) => ({ a, ns: attrNs(e, a) || '' })).sort((x, y) => (x.ns === y.ns ? (x.a.local < y.a.local ? -1 : x.a.local > y.a.local ? 1 : 0) : (x.ns < y.ns ? -1 : 1)))
      .map(({ a }) => ` ${a.name}="${escA(a.value)}"`).join('');
    return `<${e.name}${decls.join('')}${attrs}>${e.children.map((c) => render(c, mine)).join('')}</${e.name}>`;
  }
  return render(el, {});
}

const ALGS = { 'http://www.w3.org/2001/04/xmlenc#sha256': 'sha256', 'http://www.w3.org/2000/09/xmldsig#sha1': 'sha1', 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256': 'RSA-SHA256', 'http://www.w3.org/2000/09/xmldsig#rsa-sha1': 'RSA-SHA1' };
function idOf(el) { const a = el.attrs.find((x) => ['ID', 'Id', 'id'].includes(x.name)); return a ? a.value : null; }
function verifyOne(sig, root, certPem) {
  const si = children(sig, 'SignedInfo', NS_DS)[0]; if (!si) return { ok: false, error: 'No SignedInfo.' };
  const refs = children(si, 'Reference', NS_DS); if (refs.length !== 1) return { ok: false, error: 'Exactly one Reference expected.' };
  const uri = (refs[0].attrs.find((a) => a.name === 'URI') || {}).value || '';
  if (!uri.startsWith('#')) return { ok: false, error: 'The Reference must point at an ID.' };
  const target = sig.parent;
  if (!target || idOf(target) !== uri.slice(1)) return { ok: false, error: 'The signature does not sign the element it sits in.' };
  // only the Response or the ONE Assertion may be the signed element (no wrapping)
  const assertions = all(root, 'Assertion');
  if (assertions.length !== 1) return { ok: false, error: 'Exactly one Assertion expected.' };
  if (target !== root && target !== assertions[0]) return { ok: false, error: 'The signed element is not the Response or the Assertion.' };
  const tr = children(refs[0], 'Transforms', NS_DS)[0];
  const transforms = tr ? children(tr, 'Transform', NS_DS).map((t) => (t.attrs.find((a) => a.name === 'Algorithm') || {}).value) : [];
  if (transforms.some((t) => !['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'].includes(t))) return { ok: false, error: 'Unsupported transform.' };
  const incl = tr ? children(tr, 'Transform', NS_DS).flatMap((t) => all(t, 'InclusiveNamespaces').map((n) => ((n.attrs.find((a) => a.name === 'PrefixList') || {}).value || '').split(/\s+/).filter(Boolean))).flat() : [];
  const dm = ALGS[(children(refs[0], 'DigestMethod', NS_DS)[0] || { attrs: [] }).attrs.find((a) => a.name === 'Algorithm')?.value];
  if (!['sha256', 'sha1'].includes(dm)) return { ok: false, error: 'Unsupported digest.' };
  const digest = crypto.createHash(dm).update(c14n(target, { exclude: sig, inclusive: incl }), 'utf8').digest('base64');
  const want = text(children(refs[0], 'DigestValue', NS_DS)[0] || { children: [] }).replace(/\s+/g, '');
  if (digest !== want) return { ok: false, error: 'The signed content was changed (digest does not match).' };
  const cm = (children(si, 'CanonicalizationMethod', NS_DS)[0] || { attrs: [] }).attrs.find((a) => a.name === 'Algorithm')?.value;
  if (cm !== 'http://www.w3.org/2001/10/xml-exc-c14n#') return { ok: false, error: 'Unsupported canonicalization.' };
  const sm = ALGS[(children(si, 'SignatureMethod', NS_DS)[0] || { attrs: [] }).attrs.find((a) => a.name === 'Algorithm')?.value];
  if (!['RSA-SHA256', 'RSA-SHA1'].includes(sm)) return { ok: false, error: 'Unsupported signature method.' };
  const sv = text(children(sig, 'SignatureValue', NS_DS)[0] || { children: [] }).replace(/\s+/g, '');
  let key;
  try { key = crypto.createPublicKey(certPem.includes('BEGIN') ? certPem : `-----BEGIN CERTIFICATE-----\n${certPem.replace(/\s+/g, '').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`); } catch (e) { return { ok: false, error: 'The IdP certificate is not valid.' }; }
  const ok = crypto.verify(sm, Buffer.from(c14n(si), 'utf8'), key, Buffer.from(sv, 'base64'));
  return ok ? { ok: true, refId: uri.slice(1), signed: target === root ? 'Response' : 'Assertion' } : { ok: false, error: 'The signature does not match the IdP certificate.' };
}
function verifySignature(root, certPem) {
  const sigs = all(root, 'Signature', NS_DS).filter((s) => s.parent === root || (s.parent && s.parent.local === 'Assertion'));
  if (!sigs.length) return { ok: false, error: 'The SAML response is not signed.' };
  let last = null;
  for (const s of sigs) { const r = verifyOne(s, root, certPem); if (r.ok) return r; last = r; }
  return last;
}

module.exports = { parse, c14n, verifySignature, children, all, text, nsOf, idOf, NS_DS };
