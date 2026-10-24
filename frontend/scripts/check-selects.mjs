// check-selects: fails (exit 1) when a native <select> with MORE THAN 6 options, or with dynamic
// options (a .map(), {expressions}), is added in frontend/src outside the allow-list below.
// Use <Combo> (components/Combo.jsx, also exported as components/SearchSelect.jsx) instead: same
// props as <select>, but you can type to search. Run: npm run check:selects
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
// Files allowed to keep a native <select> (path relative to src, forward slashes). Empty on purpose.
const ALLOW = new Set([]);
const MAX_STATIC = 6;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.jsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const bad = [];
for (const file of walk(SRC)) {
  const rel = path.relative(SRC, file).split(path.sep).join('/');
  if (ALLOW.has(rel)) continue;
  const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const re = /<select(?=[\s>])[\s\S]*?<\/select>/g;
  let m;
  while ((m = re.exec(text))) {
    const block = m[0];
    const line = text.slice(0, m.index).split('\n').length;
    const inner = block.slice(block.indexOf('>') + 1);
    const options = (inner.match(/<option[\s>]/g) || []).length;
    const dynamic = /\.map\(|\{[^}]*\}\s*<option|\?\s*<option/.test(inner) || /<option[^>]*>\s*\{/.test(inner);
    if (dynamic || options > MAX_STATIC) bad.push(`${rel}:${line}  (${dynamic ? 'dynamic options' : options + ' options'})`);
  }
}
if (bad.length) {
  console.error('Native <select> found where a searchable dropdown is required:\n  ' + bad.join('\n  '));
  console.error('\nUse <Combo> from components/Combo.jsx (same props as <select>), or add the file to ALLOW in scripts/check-selects.mjs with a reason.');
  process.exit(1);
}
console.log('check-selects: OK (no native <select> with more than 6 or dynamic options).');
