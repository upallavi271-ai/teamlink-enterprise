// ---------------------------------------------------------------------------
// IS THIS PDF REALLY DIGITALLY SIGNED, AND BY WHOM? (founder 2026-10-31: the two DigiLocker copies of an agreement -
// "digilocker tho chesthey, adhi valid ani raavali")
//
// Reads every signature in a PDF (no extra package: a small DER reader + node's crypto) and says, per signature:
//   unchanged    the bytes it signs reach the end of the file (nothing was added or edited after this signature)
//   digestOk     SHA-x of the signed bytes = the "message digest" sealed inside the signature
//   signatureOk  that sealed part verifies with the signer's own certificate (the maths of the signature holds)
//   signer       the certificate's name (CN) - for DigiLocker / Aadhaar eSign, the person's Aadhaar name
//   issuer       who issued the certificate (e.g. a licensed CA such as eMudhra / NSDL / C-DAC)
//   signedAt     the signing time inside the signature, when present
// valid = unchanged && digestOk && signatureOk on the LAST signature.
//
// NOT checked here: that the issuing CA chains up to India's root (CCA). Adobe Acrobat Reader does that; the screen says so.
// A "merged" or printed PDF that only SHOWS signature boxes has no signature at all and is reported as such.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

// ---- a minimal DER reader ----------------------------------------------------
function readTlv(buf, pos) {
  const tag = buf[pos];
  let len = buf[pos + 1];
  let off = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i += 1) len = (len * 256) + buf[off + i];
    off += n;
  }
  return { tag, start: pos, hdr: off - pos, len, end: off + len, value: buf.subarray(off, off + len), raw: buf.subarray(pos, off + len) };
}
function children(node) {
  const out = [];
  let p = 0;
  const v = node.value;
  while (p < v.length) { const c = readTlv(v, p); out.push(c); p = c.end; }
  return out;
}
function oidOf(node) {
  const b = node.value;
  const parts = [Math.floor(b[0] / 40), b[0] % 40];
  let n = 0;
  for (let i = 1; i < b.length; i += 1) { n = (n * 128) + (b[i] & 0x7f); if (!(b[i] & 0x80)) { parts.push(n); n = 0; } }
  return parts.join('.');
}
const DIGESTS = { '2.16.840.1.101.3.4.2.1': 'sha256', '2.16.840.1.101.3.4.2.2': 'sha384', '2.16.840.1.101.3.4.2.3': 'sha512', '1.3.14.3.2.26': 'sha1' };
const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
const OID_SIGNING_TIME = '1.2.840.113549.1.9.5';

function timeOf(node) {
  const s = node.value.toString('latin1');
  // UTCTime (0x17) has a 2-digit year, GeneralizedTime (0x18) a 4-digit one
  const m = (node.tag === 0x18 ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?/ : /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?/).exec(s);
  if (!m) return null;
  let y = Number(m[1]); if (m[1].length === 2) y += y < 50 ? 2000 : 1900;
  return new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0))).toISOString();
}
const cnOf = (dn) => { const m = /(?:^|\n|,\s*)CN=([^\n,]+)/.exec(String(dn || '')); return m ? m[1].trim() : (String(dn || '').split('\n')[0] || '').trim(); };

// One signature's CMS blob, checked against the bytes it covers.
function checkCms(der, signedBytes) {
  const out = { digestOk: false, signatureOk: false, signer: null, issuer: null, signedAt: null, digest: null, error: null };
  try {
    const ci = readTlv(der, 0);
    const sd = readTlv(children(ci)[1].value, 0); // [0] EXPLICIT -> SignedData
    const parts = children(sd);
    const certsNode = parts.find((c) => c.tag === 0xa0);
    const signerInfos = parts.filter((c) => c.tag === 0x31).pop();
    const si = children(children(signerInfos)[0]);
    const digestAlg = DIGESTS[oidOf(children(si[2])[0])];
    if (!digestAlg) throw new Error('unknown digest algorithm');
    out.digest = digestAlg;
    const attrsNode = si.find((c) => c.tag === 0xa0);
    const sigNode = si.filter((c) => c.tag === 0x04).pop();
    const certs = certsNode ? children(certsNode).map((c) => { try { return new crypto.X509Certificate(c.raw); } catch { return null; } }).filter(Boolean) : [];
    if (attrsNode) {
      let md = null;
      children(attrsNode).forEach((a) => {
        const [oid, set] = children(a);
        const o = oidOf(oid);
        const v = children(set)[0];
        if (o === OID_MESSAGE_DIGEST) md = v.value;
        if (o === OID_SIGNING_TIME) out.signedAt = timeOf(v);
      });
      const actual = crypto.createHash(digestAlg).update(signedBytes).digest();
      out.digestOk = !!md && Buffer.compare(md, actual) === 0;
      // the signature is over the attributes re-encoded as a SET (tag 0x31 instead of [0])
      const toVerify = Buffer.concat([Buffer.from([0x31]), attrsNode.raw.subarray(1)]);
      const signer = certs.find((c) => { try { return crypto.verify(digestAlg, toVerify, c.publicKey, sigNode.value); } catch { return false; } });
      out.signatureOk = !!signer;
      const named = signer || certs.find((c) => !c.ca) || certs[0];
      if (named) { out.signer = cnOf(named.subject); out.issuer = cnOf(named.issuer); }
    } else {
      // no signed attributes: the signature is directly over the content digest
      const signer = certs.find((c) => { try { return crypto.verify(digestAlg, signedBytes, c.publicKey, sigNode.value); } catch { return false; } });
      out.digestOk = !!signer; out.signatureOk = !!signer;
      if (signer) { out.signer = cnOf(signer.subject); out.issuer = cnOf(signer.issuer); }
    }
  } catch (e) { out.error = String(e.message || e).slice(0, 120); }
  return out;
}

// buf: the whole PDF. Returns { signed, count, valid, last, signatures: [...] }.
function inspect(buf) {
  const text = buf.toString('latin1');
  const sigs = [];
  for (const m of text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)) {
    const [a, b, c, d] = m.slice(1).map(Number);
    if (a !== 0 || b <= 0 || c <= b || c + d > buf.length) continue; // not a sane signature range
    const hex = buf.subarray(b, c).toString('latin1').replace(/[<>\s]/g, '').replace(/(00)+$/, '');
    const der = Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex');
    const signedBytes = Buffer.concat([buf.subarray(a, a + b), buf.subarray(c, c + d)]);
    // the name written into the signature dictionary (DigiLocker writes the Aadhaar name there too)
    const near = text.slice(Math.max(0, m.index - 1500), Math.min(text.length, m.index + 1500));
    const dictName = (/\/Name\s*\(([^)]{1,120})\)/.exec(near) || [])[1] || null;
    const r = checkCms(der, signedBytes);
    sigs.push({
      unchanged: c + d === buf.length,
      digestOk: r.digestOk, signatureOk: r.signatureOk,
      signer: r.signer || dictName, issuer: r.issuer, signedAt: r.signedAt, digest: r.digest, error: r.error,
    });
  }
  const last = sigs[sigs.length - 1] || null;
  return {
    signed: sigs.length > 0,
    count: sigs.length,
    valid: !!(last && last.unchanged && last.digestOk && last.signatureOk),
    last,
    signatures: sigs,
  };
}

// THE WORDS ON THE PAGES, roughly (founder 2026-10-31: "agreement proper ithey ney kadha, active vachi green tick vasthadhi"):
// enough to find "Agreement No. AGR0009" in a copy eSigned in DigiLocker. Our agreement PDF (pdfkit) writes its text as hex strings
// inside Flate streams, and DigiLocker keeps those streams. Returns '' when nothing readable is found (a scan, another generator).
function textOf(buf) {
  const zlib = require('zlib'); // eslint-disable-line global-require
  const s = buf.toString('latin1');
  const parts = [];
  const re = /stream\r?\n/g;
  let m;
  let budget = 40 * 1024 * 1024; // inflated bytes at most
  while ((m = re.exec(s)) && budget > 0) {
    const st = m.index + m[0].length;
    const en = s.indexOf('endstream', st);
    if (en < 0) break;
    let out = null;
    try { out = zlib.inflateSync(buf.subarray(st, en), { maxOutputLength: Math.min(budget, 8 * 1024 * 1024) }); } catch { out = null; }
    if (out) {
      budget -= out.length;
      const t = out.toString('latin1');
      if (/\b(Tj|TJ)\b/.test(t)) {
        for (const h of t.matchAll(/<([0-9a-fA-F]{2,})>/g)) if (h[1].length % 2 === 0) parts.push(Buffer.from(h[1], 'hex').toString('latin1'));
        for (const l of t.matchAll(/\(((?:\\.|[^\\)])*)\)/g)) parts.push(l[1]);
      }
    }
    re.lastIndex = en + 9; // past "endstream"
  }
  return parts.join('');
}

module.exports = { inspect, textOf };
