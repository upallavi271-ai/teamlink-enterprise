// AI Marketing video robustness: a WebM is kept as it was when ffmpeg is missing (nothing is lost); the MP4 conversion uses H.264 + AAC with even sides and faststart; the voice-over text path.
//   node backend/test-fixtures/mkVideoFix.test.js     (throw-away copy of prisma/sandbox.db)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-vfix-'));
const tmp = path.join(work, 'copy.db'); fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1'; process.env.UPLOAD_DIR = path.join(work, 'uploads');
process.env.FFMPEG_PATH = path.join(work, 'no-such-ffmpeg');
const VF = require('../src/marketing/videoFix');
const Img = require('../src/marketing/images');
const MV = require('../src/marketing/meetingVoice');

(async () => {
  const args = VF.ffArgs('in.webm', 'out.mp4').join(' ');
  assert.match(args, /libx264/); assert.match(args, /yuv420p/); assert.match(args, /aac/); assert.match(args, /\+faststart/); assert.match(args, /trunc\(iw\/2\)\*2/);
  assert.equal(await VF.toMp4(Buffer.alloc(5000, 1)), null, 'no ffmpeg: nothing is converted and nothing throws');
  const real = await require('../src/db').user.findFirst({ select: { id: true } });
  const admin = { id: real ? real.id : 'u', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
  await Img.ensure();
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4000, 7)]);
  const r = await Img.saveVideo(admin, webm, 'video/webm;codecs=vp9', { title: 'Browser video', aspect: '9:16', scenes: 2, seconds: 8 });
  assert.ok(r.item, JSON.stringify(r)); assert.equal(r.item.mime, 'video/webm', 'kept as a WebM when it cannot be converted');
  assert.equal((await Img.saveVideo(admin, Buffer.alloc(10), 'video/webm', {})).status, 400);
  // the voice-over: empty words are refused; a language the server has no voice for says so (no voice engines in this copy)
  assert.equal((await MV.speakAny('en', '   ')).status, 400);
  assert.equal((await MV.speakAny('xx', 'Hello')).status, 400);
  const v = await MV.speakAny('te', 'నమస్కారం');
  assert.ok((v.error && [502, 503].includes(v.status)) || v.wav, JSON.stringify(v).slice(0, 120));
  console.log('mkVideoFix: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
