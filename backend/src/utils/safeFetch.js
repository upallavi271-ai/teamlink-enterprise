// ---------------------------------------------------------------------------
// SSRF GUARD (security fix 2026-10-13). Any server-side call to a URL that an
// Admin can type or store (job-board feeds, e-sign provider base address, link
// targets) must pass assertSafeUrl() first: only http / https, and the host may
// not be, or resolve to, a loopback / private / link-local / metadata address
// (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, ::1, fc00::/7,
// fe80::/10, 0.0.0.0, IPv4-mapped forms). Redirects must be re-checked by the
// caller (use fetchPublic(), which follows them by hand, max 3, re-checking each).
// Set ALLOW_PRIVATE_FETCH=1 only for local development.
// ---------------------------------------------------------------------------
const dns = require('dns').promises;
const net = require('net');

function isPrivateIp(ip) {
  const v = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIPv4(v)) {
    const [a, b] = v.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(v)) {
    if (v === '::1' || v === '::') return true;
    const m = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIp(m[1]);
    const h = v.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (h) { const x = parseInt(h[1], 16); const y = parseInt(h[2], 16); return isPrivateIp(`${x >> 8}.${x & 255}.${y >> 8}.${y & 255}`); }
    return /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  }
  return true; // not an IP at all: refuse
}

async function assertSafeUrl(urlLike) {
  let u;
  try { u = new URL(String(urlLike)); } catch { throw Object.assign(new Error('That address is not a valid web address.'), { code: 'SSRF_BAD_URL' }); }
  if (!['http:', 'https:'].includes(u.protocol)) throw Object.assign(new Error('Only http and https addresses are allowed.'), { code: 'SSRF_SCHEME' });
  if (/^(1|true|yes)$/i.test(String(process.env.ALLOW_PRIVATE_FETCH || ''))) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.localhost$|\.internal$|\.local$/i.test(host)) throw Object.assign(new Error('That address points inside this network and is not allowed.'), { code: 'SSRF_PRIVATE' });
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw Object.assign(new Error('That web address could not be found.'), { code: 'SSRF_DNS' });
  if (addrs.some(isPrivateIp)) throw Object.assign(new Error('That address points inside this network and is not allowed.'), { code: 'SSRF_PRIVATE' });
  return u;
}

// fetch() that checks the address and every redirect hop, with a size cap on the body read by callers via res.
async function fetchPublic(urlLike, init = {}, hops = 3) {
  let url = String(urlLike);
  for (let i = 0; i <= hops; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await assertSafeUrl(url);
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(url, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location'), url).href; continue; }
    return res;
  }
  throw Object.assign(new Error('Too many redirects.'), { code: 'SSRF_REDIRECTS' });
}

module.exports = { assertSafeUrl, fetchPublic, isPrivateIp };
