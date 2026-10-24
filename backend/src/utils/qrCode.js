// ---------------------------------------------------------------------------
// TINY LOCAL QR CODE GENERATOR (no library, no external service).
//
// Used by the WhatsApp "QR-link prototype" screen: the worker gets a QR *string* from WhatsApp and the
// Integrations screen needs a picture of it. Byte mode, error-correction level L or M, versions 1-40.
// Algorithm after ISO/IEC 18004 (Reed-Solomon over GF(256)/0x11D, 8 masks, standard penalty rules).
//
//   encode(text, { ecc: 'L' | 'M' })  -> { size, version, mask, modules: boolean[][] }   (true = dark)
//   toSvg(text, { ecc, border, scale }) -> '<svg ...>'  (self-contained string)
//   capacity(version, ecc)             -> max bytes
//   _internals                         -> used by the self-check in scripts/comm-automation-test.js
// ---------------------------------------------------------------------------

const ECC_PER_BLOCK = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
};
const NUM_BLOCKS = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
};
const FORMAT_BITS = { L: 1, M: 0 };

function rawModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const na = Math.floor(ver / 7) + 2;
    r -= (25 * na - 10) * na - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
function dataCodewords(ver, ecc) {
  return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ecc][ver] * NUM_BLOCKS[ecc][ver];
}
// Bytes of payload that fit (byte mode: 4 mode bits + 8/16 count bits).
function capacity(ver, ecc) {
  const countBits = ver <= 9 ? 8 : 16;
  return Math.floor((dataCodewords(ver, ecc) * 8 - 4 - countBits) / 8);
}

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11D);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}
function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  data.forEach((b) => {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  });
  return result;
}

function bitsOf(bytes, ver, ecc) {
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i -= 1) bits.push((val >>> i) & 1); };
  put(0x4, 4);
  put(bytes.length, ver <= 9 ? 8 : 16);
  bytes.forEach((b) => put(b, 8));
  const cap = dataCodewords(ver, ecc) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) put(pad, 8);
  const out = new Array(bits.length / 8).fill(0);
  bits.forEach((bit, i) => { out[i >>> 3] |= bit << (7 - (i & 7)); });
  return out;
}

function interleave(data, ver, ecc) {
  const nb = NUM_BLOCKS[ecc][ver];
  const eccLen = ECC_PER_BLOCK[ecc][ver];
  const raw = Math.floor(rawModules(ver) / 8);
  const shortBlocks = nb - (raw % nb);
  const shortLen = Math.floor(raw / nb);
  const blocks = [];
  const div = rsDivisor(eccLen);
  for (let i = 0, k = 0; i < nb; i += 1) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1));
    k += dat.length;
    const e = rsRemainder(dat, div);
    if (i < shortBlocks) dat.push(0);
    blocks.push({ dat, e, all: dat.concat(e) });
  }
  const out = [];
  for (let i = 0; i < blocks[0].all.length; i += 1) {
    blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= shortBlocks) out.push(b.all[i]); });
  }
  return { codewords: out, blocks, shortBlocks, shortLen, eccLen };
}

function alignPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const r = [6];
  for (let pos = ver * 4 + 10; r.length < n; pos -= step) r.splice(1, 0, pos);
  return r;
}

function build(codewords, ver, ecc) {
  const size = ver * 4 + 17;
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setF = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true; };
  const bit = (v, i) => ((v >>> i) & 1) !== 0;

  for (let i = 0; i < size; i += 1) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
  const finder = (x, y) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx; const yy = y + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) setF(xx, yy, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const ap = alignPositions(ver);
  ap.forEach((px, i) => ap.forEach((py, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) return;
    for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) setF(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const formatBits = (mask) => {
    const data = (FORMAT_BITS[ecc] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i += 1) setF(8, i, bit(bits, i));
    setF(8, 7, bit(bits, 6)); setF(8, 8, bit(bits, 7)); setF(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i += 1) setF(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i += 1) setF(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i += 1) setF(8, size - 15 + i, bit(bits, i));
    setF(8, size - 8, true);
  };
  formatBits(0); // reserve the area
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const c = bit(bits, i); const a = size - 11 + (i % 3); const b = Math.floor(i / 3);
      setF(a, b, c); setF(b, a, c);
    }
  }
  // zig-zag data placement
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && i < codewords.length * 8) { mod[y][x] = bit(codewords[i >>> 3], 7 - (i & 7)); i += 1; }
      }
    }
  }
  const invert = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => ((((x * y) % 2) + ((x * y) % 3)) % 2) === 0, (x, y) => ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0,
  ];
  const applyMask = (m) => {
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (!fn[y][x] && invert[m](x, y)) mod[y][x] = !mod[y][x];
  };
  const penalty = () => {
    let p = 0;
    const lines = [];
    for (let a = 0; a < size; a += 1) {
      lines.push(mod[a].slice());
      lines.push(mod.map((row) => row[a]));
    }
    lines.forEach((line) => {
      let run = 1;
      for (let k = 1; k <= size; k += 1) {
        if (k < size && line[k] === line[k - 1]) run += 1;
        else { if (run >= 5) p += 3 + (run - 5); run = 1; }
      }
      const s = line.map((v) => (v ? '1' : '0')).join('');
      ['10111010000', '00001011101'].forEach((pat) => { for (let at = s.indexOf(pat); at !== -1; at = s.indexOf(pat, at + 1)) p += 40; });
    });
    for (let y = 0; y < size - 1; y += 1) for (let x = 0; x < size - 1; x += 1) {
      const c = mod[y][x];
      if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) p += 3;
    }
    let dark = 0;
    mod.forEach((row) => row.forEach((v) => { if (v) dark += 1; }));
    p += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    return p;
  };
  let best = 0; let bestP = Infinity;
  for (let m = 0; m < 8; m += 1) {
    applyMask(m); formatBits(m);
    const p = penalty();
    if (p < bestP) { best = m; bestP = p; }
    applyMask(m);
  }
  applyMask(best); formatBits(best);
  return { size, mask: best, modules: mod, fn };
}

function encode(text, { ecc = 'L' } = {}) {
  if (!ECC_PER_BLOCK[ecc]) throw new Error('ecc must be L or M');
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));
  let ver = 1;
  while (ver <= 40 && capacity(ver, ecc) < bytes.length) ver += 1;
  if (ver > 40) throw new Error('Text is too long for a QR code');
  const { codewords } = interleave(bitsOf(bytes, ver, ecc), ver, ecc);
  const b = build(codewords, ver, ecc);
  return { size: b.size, version: ver, mask: b.mask, modules: b.modules, ecc };
}

function toSvg(text, { ecc = 'L', border = 4, scale = 6 } = {}) {
  const q = encode(text, { ecc });
  const dim = q.size + border * 2;
  const parts = [];
  for (let y = 0; y < q.size; y += 1) {
    for (let x = 0; x < q.size; x += 1) if (q.modules[y][x]) parts.push(`M${x + border},${y + border}h1v1h-1z`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim * scale}" height="${dim * scale}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${parts.join('')}" fill="#000"/></svg>`;
}

module.exports = { encode, toSvg, capacity, _internals: { rsDivisor, rsRemainder, interleave, bitsOf, dataCodewords, rawModules, alignPositions, build } };
