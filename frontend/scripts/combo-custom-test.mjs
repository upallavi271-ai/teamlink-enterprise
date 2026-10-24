// Standalone behaviour test for Combo / MultiPick "type your own value" (2026-10-14).
// No browser and no jsdom: esbuild bundles the real components and a tiny DOM stub runs them under react-dom.
//   run (in frontend/):  node scripts/combo-custom-test.mjs
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import os from 'os';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ----------------------------------------------------------------- DOM stub
const dom = (() => {
  class N {
    constructor() { this.childNodes = []; this.parentNode = null; this._l = []; }
    get firstChild() { return this.childNodes[0] || null; }
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
    get nextSibling() { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) + 1] || null; }
    get previousSibling() { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) - 1] || null; }
    get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
    get ownerDocument() { return doc; }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
    insertBefore(c, ref) {
      if (!ref) return this.appendChild(c);
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = this; this.childNodes.splice(this.childNodes.indexOf(ref), 0, c); return c;
    }
    removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
    addEventListener(type, f, cap) { this._l.push({ type, f, cap: cap === true || (cap && cap.capture) || false }); }
    removeEventListener(type, f) { this._l = this._l.filter((x) => !(x.type === type && x.f === f)); }
    contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
    get textContent() { return this.childNodes.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(''); }
    set textContent(t) { this.childNodes.forEach((c) => { c.parentNode = null; }); this.childNodes = []; if (t) this.appendChild(new T(String(t))); }
  }
  class T extends N {
    constructor(d) { super(); this.nodeType = 3; this.nodeName = '#text'; this.data = d; }
    get nodeValue() { return this.data; } set nodeValue(v) { this.data = String(v); }
    get textContent() { return this.data; } set textContent(v) { this.data = String(v); }
  }
  class E extends N {
    constructor(tag) { super(); this.nodeType = 1; this.localName = tag.toLowerCase(); this.nodeName = this.tagName = tag.toUpperCase(); this.attrs = {}; this.style = {}; this._value = ''; this._checked = false; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this._value = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    hasAttribute(k) { return k in this.attrs; }
    get value() { return this._value; } set value(v) { this._value = String(v); }
    get type() { return this.attrs.type || (this.localName === 'input' ? 'text' : ''); }
    get checked() { return this._checked; } set checked(v) { this._checked = !!v; }
    get className() { return this.attrs.class || ''; } set className(v) { this.attrs.class = String(v); }
    getBoundingClientRect() { return { left: 10, right: 210, top: 10, bottom: 40, width: 200, height: 30 }; }
    focus() { doc.activeElement = this; }
    blur() { if (doc.activeElement === this) doc.activeElement = doc.body; }
  }
  const doc = new N();
  doc.nodeType = 9; doc.nodeName = '#document';
  doc.createElement = (t) => new E(t);
  doc.createElementNS = (ns, t) => new E(t);
  doc.createTextNode = (d) => new T(d);
  doc.documentElement = new E('html');
  doc.body = new E('body'); doc.oninput = null;
  doc.activeElement = doc.body;
  doc.defaultView = null;
  return { doc, N, T, E };
})();
const { doc, E } = dom;
globalThis.window = globalThis;
globalThis.addEventListener = () => {}; globalThis.removeEventListener = () => {};
globalThis.document = doc;
doc.defaultView = globalThis;
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node-stub' }, configurable: true });
globalThis.innerWidth = 1200; globalThis.innerHeight = 800;
globalThis.matchMedia = () => ({ matches: false });
globalThis.HTMLIFrameElement = class HTMLIFrameElement {}; globalThis.HTMLElement = E; globalThis.Element = E; globalThis.Node = dom.N;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);

// Dispatch like a browser: capture listeners top-down, then bubble listeners bottom-up.
function fire(node, type, props = {}) {
  const ev = {
    type, target: node, bubbles: true, defaultPrevented: false, timeStamp: Date.now(), isTrusted: true,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...props,
  };
  const path = []; for (let n = node; n; n = n.parentNode) path.push(n);
  [...path].reverse().forEach((n) => n._l.filter((l) => l.type === type && l.cap).forEach((l) => l.f({ ...ev, currentTarget: n })));
  path.forEach((n) => n._l.filter((l) => l.type === type && !l.cap).forEach((l) => l.f({ ...ev, currentTarget: n })));
  return ev;
}
const nativeSet = Object.getOwnPropertyDescriptor(E.prototype, 'value').set;

// ---------------------------------------------------------------- bundle
const esbuild = require('esbuild');
const out = path.join(os.tmpdir(), `combo-custom-test-${process.pid}.cjs`);
await esbuild.build({
  entryPoints: [path.join(here, 'combo-custom-test.entry.jsx')], bundle: true, platform: 'node', format: 'cjs', outfile: out,
  loader: { '.css': 'empty', '.jsx': 'jsx' }, jsx: 'automatic', logLevel: 'error', nodePaths: [path.join(here, '..', 'node_modules')],
  define: { 'process.env.NODE_ENV': '"development"' },
});
const M = require(out);
const { React, createRoot, act, ComboHarness, MultiHarness } = M;

// -------------------------------------------------------------- helpers
let pass = 0; let fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass += 1; console.log(`  ok    ${name}`); } else { fail += 1; console.log(`  FAIL  ${name} ${extra}`); } };
const all = (root, pred, acc = []) => { root.childNodes.forEach((c) => { if (c.nodeType === 1) { if (pred(c)) acc.push(c); all(c, pred, acc); } }); return acc; };
const byRole = (root, role) => all(root, (n) => n.attrs.role === role);
const options = () => byRole(doc.body, 'option').map((n) => n.textContent);
const input = (root) => all(root, (n) => n.localName === 'input' && n.attrs.role === 'combobox')[0];

async function mount(el) {
  const host = new E('div'); doc.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(el); });
  return { host, unmount: async () => { await act(async () => { root.unmount(); }); doc.body.removeChild(host); } };
}
const type = async (node, text) => { await act(async () => { nativeSet.call(node, text); fire(node, 'input'); }); };
const key = async (node, k) => { await act(async () => { fire(node, 'keydown', { key: k }); }); };
const open = async (node) => { await act(async () => { fire(node, 'mousedown'); }); };

// ---------------------------------------------------------------- tests
console.log('Combo');
{
  const probe = { calls: [] };
  const m = await mount(React.createElement(ComboHarness, { probe, allowCustom: true }));
  const inp = input(m.host);
  await open(inp);
  check('opens with the list', options().join('|') === 'Pick|Java|Python|Frontend', options().join('|'));
  await type(inp, 'React');
  check('typing React with no match shows the custom row', options().join('|') === 'Use “React”', options().join('|'));
  check('custom row is an option', byRole(doc.body, 'option').length === 1);
  await key(inp, 'Enter');
  check('Enter with no match selects the custom value', probe.value === 'React' && probe.calls[probe.calls.length - 1] === 'React', JSON.stringify(probe));
  check('chosen custom value is shown in the input', input(m.host).attrs.value === 'React' || input(m.host).value === 'React', String(input(m.host).value));
  // reopen: shows 'Your own: React'
  await open(input(m.host));
  check('reopen shows Your own: React', options().includes('Your own: React'), options().join('|'));
  await type(input(m.host), 'jav');
  check('list still filterable after reopen', options().join('|').startsWith('Java') && !options().includes('Your own: React'), options().join('|'));
  await key(input(m.host), 'Enter');
  check('Enter picks the first match when there is one', probe.value === 'Java', probe.value);
  await m.unmount();
}
{
  const probe = { calls: [] };
  const m = await mount(React.createElement(ComboHarness, { probe, allowCustom: true }));
  const inp = input(m.host);
  await open(inp); await type(inp, 'pyTHON');
  check('case-insensitive match shows the existing option, no duplicate custom row', options().join('|') === 'Python', options().join('|'));
  await key(inp, 'Enter');
  check('case-insensitive match selects the existing option', probe.value === 'Python', probe.value);
  await m.unmount();
}
{
  const probe = { calls: [] };
  const m = await mount(React.createElement(ComboHarness, { probe, allowCustom: true }));
  const inp = input(m.host);
  await open(inp); await type(inp, '  Go   <b>Lang</b>  ');
  const rowsNow = options();
  check('typed text is cleaned (spaces, HTML)', rowsNow.length === 1 && rowsNow[0] === 'Use “Go Lang”', rowsNow.join('|'));
  const row = byRole(doc.body, 'option')[0];
  await act(async () => { fire(row, 'click'); });
  check('clicking the custom row selects the cleaned text', probe.value === 'Go Lang', probe.value);
  await m.unmount();
}
{
  const probe = { calls: [] };
  const m = await mount(React.createElement(ComboHarness, { probe, allowCustom: true }));
  const inp = input(m.host);
  await open(inp); await type(inp, 'x'.repeat(200));
  const label = options()[0] || '';
  check('custom value is capped at 80 characters', label === `Use “${'x'.repeat(80)}”`, String(label.length));
  await m.unmount();
}
{
  const probe = { calls: [] };
  const m = await mount(React.createElement(ComboHarness, { probe, allowCustom: true, validateCustom: (t) => (/\d/.test(t) ? 'No digits please' : '') }));
  const inp = input(m.host);
  await open(inp); await type(inp, 'abc1'); await key(inp, 'Enter');
  check('validateCustom blocks a bad value', probe.value === '' && probe.calls.length === 0, JSON.stringify(probe));
  check('validateCustom shows its message', all(doc.body, (n) => n.attrs.role === 'alert').some((n) => n.textContent === 'No digits please'));
  await m.unmount();
}
{
  const probe = { calls: [] }; let made = null;
  const m = await mount(React.createElement(ComboHarness, { probe, allowCustom: true, customLabel: 'Add', onCreateOption: async (t) => { made = t; return `${t}!`; } }));
  const inp = input(m.host);
  await open(inp); await type(inp, 'Svelte');
  check('shared list says Add', options()[0] === 'Add “Svelte”', options().join('|'));
  await key(inp, 'Enter'); await act(async () => { await Promise.resolve(); });
  check('onCreateOption runs and its value is used', made === 'Svelte' && probe.value === 'Svelte!', JSON.stringify({ made, probe }));
  await m.unmount();
}
{
  const probe = { calls: [] };
  const m = await mount(React.createElement(ComboHarness, { probe }));
  const inp = input(m.host);
  await open(inp); await type(inp, 'React');
  const lb = byRole(doc.body, 'listbox')[0];
  check('allowCustom=false still shows No match', !!lb && lb.textContent === 'No match' && options().length === 0, lb && lb.textContent);
  await key(inp, 'Enter');
  check('allowCustom=false: Enter selects nothing', probe.value === '' && probe.calls.length === 0, JSON.stringify(probe));
  await m.unmount();
}
{
  const probe = { calls: [] };
  const m = await mount(React.createElement(ComboHarness, { probe, allowCustom: true }));
  const inp = input(m.host);
  await open(inp);
  await key(inp, 'ArrowDown'); await key(inp, 'Enter');
  check('keyboard: arrows + Enter pick an option', probe.value === 'Java', probe.value);
  await open(input(m.host)); await key(input(m.host), 'Escape');
  check('keyboard: Escape closes the list', byRole(doc.body, 'listbox').length === 0);
  await m.unmount();
}

console.log('MultiPick');
const clickToggle = async (host) => { const ctl = all(host, (n) => n.attrs.role === 'combobox')[0]; await act(async () => { fire(ctl, 'click'); }); };
const search = (host) => all(host, (n) => n.localName === 'input' && /mpk-search/.test(n.attrs.class || ''))[0];
const chips = (host) => all(host, (n) => /(^| )mpk-chip( |$)/.test(n.attrs.class || '')).map((n) => n.textContent);
{
  const probe = {};
  const m = await mount(React.createElement(MultiHarness, { probe, allowCustom: true }));
  check('no extra text link toggles (one box with a caret)', all(m.host, (n) => n.localName === 'button' && /mpk-toggle/.test(n.attrs.class || '')).length === 0 && all(m.host, (n) => /mpk-caret/.test(n.attrs.class || '')).length === 1);
  await clickToggle(m.host);
  await type(search(m.host), 'React');
  const opts = byRole(m.host, 'option').map((n) => n.textContent);
  check('typing React shows the custom row', opts.join('|') === 'Use “React”', opts.join('|'));
  await key(search(m.host), 'Enter');
  check('Enter selects it and it becomes a chip', JSON.stringify(probe.value) === '["React"]' && chips(m.host)[0].startsWith('React'), JSON.stringify(probe.value) + chips(m.host).join(','));
  await type(search(m.host), 'java');
  await key(search(m.host), 'Enter');
  check('Enter picks the first match and adds a second chip', JSON.stringify(probe.value) === '["React","Java"]', JSON.stringify(probe.value));
  await type(search(m.host), 'PYTHON');
  const o2 = byRole(m.host, 'option').map((n) => n.textContent);
  check('case-insensitive match: no custom row, the existing option', o2.join('|') === 'Python', o2.join('|'));
  await type(search(m.host), 'react');
  const o3 = byRole(m.host, 'option').map((n) => n.textContent);
  check('a value already chosen is not offered again as a new custom row', !o3.some((t) => t.startsWith('Use ')), o3.join('|'));
  await m.unmount();
}
{
  const probe = {};
  const m = await mount(React.createElement(MultiHarness, { probe }));
  await clickToggle(m.host);
  await type(search(m.host), 'React');
  const opts = byRole(m.host, 'option').map((n) => n.textContent);
  check('allowCustom=false: no custom row, says nothing matches', opts.length === 0 && /Nothing matches/.test(m.host.textContent) || /Nothing matches/.test(doc.body.textContent), opts.join('|'));
  await key(search(m.host), 'Enter');
  check('allowCustom=false: Enter adds nothing', JSON.stringify(probe.value) === '[]', JSON.stringify(probe.value));
  await m.unmount();
}
{
  const probe = {};
  const m = await mount(React.createElement(MultiHarness, { probe, allowCustom: true, single: true, customLabel: 'Add', onCreateOption: async (t) => t.toUpperCase() }));
  await clickToggle(m.host);
  await type(search(m.host), 'Kokapet'); await key(search(m.host), 'Enter'); await act(async () => { await Promise.resolve(); });
  check('single + shared list: onCreateOption value replaces the choice', JSON.stringify(probe.value) === '["KOKAPET"]', JSON.stringify(probe.value));
  await m.unmount();
}

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.unlinkSync(out); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
