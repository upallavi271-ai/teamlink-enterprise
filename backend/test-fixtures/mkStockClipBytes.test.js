// A free stock clip as bytes (the moving background of an explainer scene): nothing is saved, only the source's own address is used, shape falls back, size is capped.
//   node backend/test-fixtures/mkStockClipBytes.test.js   (a local fake Pixabay; no outside call)
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-clip-'));
const tmp = path.join(work, 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1';

const mp4 = Buffer.concat([Buffer.from('00000018667479706d703432', 'hex'), Buffer.alloc(2048, 7)]);
const big = Buffer.concat([Buffer.from('00000018667479706d703432', 'hex'), Buffer.alloc(13 * 1024 * 1024, 1)]);
const searches = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/videos/') {
    searches.push(u.searchParams.get('q'));
    const base = `http://127.0.0.1:${server.address().port}`;
    const hit = (id, w, h, sec, file) => ({ id, duration: sec, user: 'Some Author', pageURL: `${base}/p/${id}`, videos: { medium: { url: `${base}/${file}`, width: w, height: h, size: 1000, thumbnail: `${base}/t.jpg` } } });
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ totalHits: 3, hits: [hit(1, 1920, 1080, 12, 'big.mp4'), hit(2, 1080, 1920, 10, 'clip.mp4'), hit(3, 1280, 720, 1, 'clip.mp4')] }));
  }
  if (u.pathname === '/api/') { const base = `http://127.0.0.1:${server.address().port}`; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ hits: [{ largeImageURL: `${base}/big.jpg`, webformatURL: `${base}/web.jpg`, user: 'Photo Author', pageURL: `${base}/p/9` }] })); }
  if (u.pathname === '/big.jpg') { res.statusCode = 429; return res.end('slow down'); }
  if (u.pathname === '/web.jpg') { res.setHeader('Content-Type', 'image/jpeg'); return res.end(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 5)])); }
  if (u.pathname === '/clip.mp4') { res.setHeader('Content-Type', 'video/mp4'); return res.end(mp4); }
  if (u.pathname === '/big.mp4') { res.setHeader('Content-Type', 'video/mp4'); return res.end(big); }
  res.statusCode = 404; return res.end('no');
});
server.listen(0, '127.0.0.1', async () => {
  try {
    process.env.MK_PIXABAY_API = `http://127.0.0.1:${server.address().port}`;
    const IS = require('../src/utils/integrationStore');
    IS.readConfig = async (channel) => (channel === 'stock-pixabay' ? { values: { 'Pixabay API key': 'testkey' } } : { values: {} });
    const Stock = require('../src/marketing/stockclips');
    const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
    const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id;
    const r = await Stock.clipBytes(admin, { q: 'nurse hospital', shape: 'portrait', n: 0 });
    assert.ok(r.buf && r.mime === 'video/mp4' && r.buf.length > 1000, JSON.stringify(r).slice(0, 200)); console.log('PASS  a clip of the wanted shape comes back as MP4 bytes');
    assert.equal(r.seconds, 10); assert.equal(r.author, 'Some Author'); console.log('PASS  the author and length are kept (credit)');
    const r2 = await Stock.clipBytes(admin, { q: 'nurse hospital', shape: 'portrait', n: 0 });
    assert.equal(searches.length, 1); console.log('PASS  the same search is answered from the cache (one call to the source)');
    const r3 = await Stock.clipBytes(admin, { q: 'doctor patient', shape: 'landscape', n: 0 });
    assert.ok(r3.error && r3.status === 502, JSON.stringify(r3).slice(0, 200)); console.log('PASS  the only landscape clip is over the 12 MB cap, so it is never downloaded (plain words, no crash)');
    const r4 = await Stock.clipBytes(admin, { q: 'doctor patient', shape: '', n: 1 });
    assert.ok(r4.buf && r4.buf.length < 13 * 1024 * 1024); console.log('PASS  with any shape, a clip that fits is found and downloaded');
    const ph = await Stock.photo(admin, { q: 'dentist clinic', shape: 'landscape', n: 0 });
    assert.ok(ph.buf && ph.mime === 'image/jpeg' && ph.author === 'Photo Author', JSON.stringify(ph).slice(0, 200)); console.log('PASS  a photo the source refuses in the big size (429) is taken in the smaller size instead of failing');
    const bad = await Stock.clipBytes(admin, { q: 'x' });
    assert.ok(bad.error && bad.status === 400); console.log('PASS  words that are too short are refused in plain words');
    const none = await Stock.clipBytes({ id: 'nobody', name: 'x', role: 'CLIENT', atsRole: 'CLIENT' }, { q: 'nurse hospital' });
    assert.ok(none.error && none.status === 403); console.log('PASS  a login that may not use AI Marketing is refused');
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* db open */ }
    server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500);
  } catch (e) { console.error(e); process.exitCode = 1; server.close(() => process.exit(1)); setTimeout(() => process.exit(1), 500); }
});
