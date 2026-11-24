// AI Marketing: the Cloudflare picture service now uses FLUX.2 [klein] 4B (multipart, real sizes) with FLUX.1 schnell at 8 steps as the safe fallback, and the pictures are described the way FLUX likes (marketing/images.js).
//   node backend/test-fixtures/mkImageQuality.test.js     (throw-away copy of prisma/sandbox.db; fetch is a stand-in: nothing is sent to Cloudflare)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-imgq-'));
const tmp = path.join(work, 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1';
process.env.UPLOAD_DIR = path.join(work, 'uploads');
fs.mkdirSync(path.join(process.env.UPLOAD_DIR, 'mk-images'), { recursive: true });

const Img = require('../src/marketing/images');
const { cfOne, fluxPrompt, DEFAULT_MODEL, FALLBACK_MODEL, resetKlein } = Img.cloudflareImage;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////', 'base64');
const c = (model) => ({ provider: 'cloudflare', account: 'a'.repeat(32), key: 'tok-secret', model });

(async () => {
  const calls = []; let plan = [];
  global.fetch = async (url, opts) => { // a stand-in for Cloudflare: answers come from `plan`, one per call
    const form = typeof FormData !== 'undefined' && opts.body instanceof FormData;
    calls.push({ url, form, headers: opts.headers, fields: form ? Object.fromEntries([...opts.body.entries()]) : JSON.parse(opts.body) });
    const a = plan.shift();
    const body = JSON.stringify(a.json);
    return { ok: a.status === 200, status: a.status, headers: { get: () => 'application/json' }, text: async () => body, arrayBuffer: async () => Buffer.from(body) };
  };
  const ok = (buf) => ({ status: 200, json: { success: true, result: { image: buf.toString('base64') } } });
  const bad = (status, message, code) => ({ status, json: { success: false, errors: [{ message, ...(code ? { code } : {}) }] } });

  // 1. the default model is FLUX.2 klein, and it is asked as multipart with the real size of the shape (no square that is cropped)
  assert.equal(DEFAULT_MODEL, '@cf/black-forest-labs/flux-2-klein-4b'); assert.equal(FALLBACK_MODEL, '@cf/black-forest-labs/flux-1-schnell');
  plan = [ok(PNG)]; resetKlein();
  let r = await cfOne(c(DEFAULT_MODEL), 'a smiling recruiter', '16:9');
  assert.equal(calls.length, 1); assert.ok(calls[0].url.endsWith('/ai/run/@cf/black-forest-labs/flux-2-klein-4b'), calls[0].url);
  assert.equal(calls[0].form, true, 'FLUX.2 is sent as multipart form data');
  assert.deepEqual(calls[0].fields, { prompt: 'a smiling recruiter', width: '1024', height: '576' }, 'real 16:9 size');
  assert.ok(!('Content-Type' in calls[0].headers) && calls[0].headers.Authorization === 'Bearer tok-secret', 'no JSON content type (fetch sets the multipart boundary); the token is only in the header');
  assert.equal(r.model, DEFAULT_MODEL); assert.equal(r.mime, 'image/png', 'the picture type is read from the picture itself'); assert.ok(Buffer.isBuffer(r.buf) && r.buf.length === PNG.length);
  plan = [ok(JPG)]; r = await cfOne(c(DEFAULT_MODEL), 'x', '9:16'); assert.equal(r.mime, 'image/jpeg'); assert.deepEqual([calls[1].fields.width, calls[1].fields.height], ['576', '1024']);
  console.log('PASS FLUX.2 klein is the default: multipart, the real size of each shape, the picture type read from the picture');

  // 2. a failure of the model itself falls back to FLUX.1 schnell at 8 steps, once; klein is then left alone for 30 minutes
  calls.length = 0; plan = [bad(400, 'invalid input'), ok(JPG)]; resetKlein();
  r = await cfOne(c(DEFAULT_MODEL), 'a hiring poster', '1:1');
  assert.equal(calls.length, 2); assert.ok(calls[1].url.endsWith('/flux-1-schnell'), calls[1].url); assert.deepEqual(calls[1].fields, { prompt: 'a hiring poster', steps: 8 }, 'schnell now runs 8 steps (it was 4)');
  assert.equal(r.model, FALLBACK_MODEL);
  calls.length = 0; plan = [ok(JPG)]; r = await cfOne(c(DEFAULT_MODEL), 'again', '1:1');
  assert.equal(calls.length, 1); assert.ok(calls[0].url.endsWith('/flux-1-schnell'), 'klein is not tried again for 30 minutes after a model failure');
  calls.length = 0; plan = [ok(PNG), ok(PNG)]; resetKlein(); r = await cfOne(c(DEFAULT_MODEL), 'back to klein after a reset', '1:1'); assert.ok(calls[0].url.endsWith('/flux-2-klein-4b'));
  // a picture that does not come back (no image in the answer) is a model failure too
  calls.length = 0; plan = [{ status: 200, json: { success: true, result: {} } }, ok(JPG)]; resetKlein(); r = await cfOne(c(DEFAULT_MODEL), 'empty answer', '1:1'); assert.equal(calls.length, 2); assert.equal(r.model, FALLBACK_MODEL);
  console.log('PASS a model failure (bad input or no picture) falls back to schnell at 8 steps and klein rests for 30 minutes');

  // 3. what is the person's to see is NOT hidden by a fallback: the free daily allowance, a refused token, too many requests, no network
  for (const [label, fail, code, status] of [['daily allowance', bad(429, 'You have used your daily free allocation of 10,000 neurons'), 'provider_daily', 429], ['refused token', bad(403, 'Authentication error'), 'provider', 403], ['too many', bad(429, 'rate limited'), 'provider', 429]]) {
    calls.length = 0; plan = [fail]; resetKlein();
    await assert.rejects(() => cfOne(c(DEFAULT_MODEL), 'x', '1:1'), (e) => e.status === status && (!code || code === 'provider' || e.code === code), label);
    assert.equal(calls.length, 1, `${label}: no second try with the other model`);
  }
  global.fetch = async () => { throw new Error('socket hang up'); }; resetKlein();
  await assert.rejects(() => cfOne(c(DEFAULT_MODEL), 'x', '1:1'), (e) => e.code === 'unreachable', 'no network is said as it is');
  console.log('PASS the free daily allowance, a refused token, "too many" and no network are shown as they are, never hidden by a fallback');

  // 4. an Admin who typed a model keeps it: schnell now 8 steps, others get the size
  global.fetch = async (url, opts) => { calls.push({ url, form: opts.body instanceof FormData, fields: JSON.parse(opts.body) }); return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ success: true, result: { image: JPG.toString('base64') } }), arrayBuffer: async () => JPG }; };
  calls.length = 0; await cfOne(c('@cf/black-forest-labs/flux-1-schnell'), 'a', '4:5'); assert.deepEqual(calls[0].fields, { prompt: 'a', steps: 8 });
  calls.length = 0; await cfOne(c('@cf/stabilityai/stable-diffusion-xl-base-1.0'), 'a', '4:5'); assert.deepEqual(calls[0].fields, { prompt: 'a', width: 768, height: 960 }); assert.equal(calls[0].form, false);
  console.log('PASS a model typed by an Admin is kept (schnell 8 steps, other models get the size as JSON)');

  // 5. the picture is described the way FLUX likes: one paragraph, camera and light, composition for the shape, a clean image instead of "no text", people described positively
  const brand = { colors: { primary: '#0b6b4d', secondary: '#f59e0b', accent: '#ffffff' } };
  let p = fluxPrompt({ prompt: 'Freshers at a job fair in Hyderabad.', style: 'photo', aspect: '4:5', useColors: true }, brand);
  assert.ok(p.startsWith('Freshers at a job fair in Hyderabad.'), p); assert.ok(!/\n/.test(p), 'one paragraph, not a list');
  for (const t of ['professional advertising photograph', 'shallow depth of field', 'vertical portrait frame', 'uncluttered', 'Colour palette: #0b6b4d, #f59e0b and #ffffff', 'A clean image: no lettering, no logos, no watermarks', 'Indian', 'Professional marketing quality']) assert.ok(p.includes(t), `the words lack "${t}": ${p}`);
  assert.ok(!/Do not put any words/i.test(p) && !/\bdo not\b/i.test(p), 'no "do not ..." sentences (FLUX tends to draw what it is told not to)');
  p = fluxPrompt({ prompt: 'A team meeting', style: 'illustration', aspect: '16:9', headline: 'We are hiring' }, brand);
  assert.ok(p.includes('wide horizontal banner') && p.includes('polished modern vector illustration') && p.includes('headline "We are hiring"') && !p.includes('Colour palette') && !p.includes('A clean image: no lettering'), p);
  for (const s of ['photo', 'illustration', 'graphic', 'poster', '3d']) assert.ok(fluxPrompt({ prompt: 'x', style: s, aspect: '1:1' }, brand).length > 150, s);
  assert.ok(fluxPrompt({ prompt: 'x', style: 'unknown', aspect: 'weird' }, { }).includes('square frame'), 'an unknown style or shape still gives a good prompt');
  console.log('PASS the FLUX words: one paragraph, camera and light by style, composition for the shape, colours, a clean image (or the exact headline), no "do not" sentences');

  console.log('image quality tests: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
