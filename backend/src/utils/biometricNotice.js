// ---------------------------------------------------------------------------
// "THE BIOMETRIC MACHINE IS LATE" NOTICE for the Attendance screen (founder, 2026-11-18).
//
// What happened: Luhitha b thumbed at 09:16 and the Attendance screen still said "Not in yet", because the machine had been
// reaching TeamLink badly since the day before (silent from 15:44 to 18:33, then one call every ~3 minutes instead of every
// 10 seconds), so her punches arrived in one batch at 09:23. Nothing was lost - but nothing on the screen said the machine was
// the reason, and it looked like her thumb had not worked.
//
// This reads two facts TeamLink already has and says so in plain words, only while it is true:
//   * the machine has gone quiet      BiometricDevice.lastSeenAt is older than OFFLINE_MIN (it normally calls every 10 s);
//   * punches are arriving late       a punch received in the last WINDOW_MIN minutes reached TeamLink more than LATE_SEC after
//                                     the thumb press (BiometricPunchLog.createdAt - punchAt; normally 2-4 seconds).
// Nothing is written and nothing is guessed: no device registered / inactive / never connected = no notice.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const OFFLINE_MIN = 5; // the machine calls every 10 s; five minutes of silence is a real gap
const LATE_SEC = 90; // punches normally arrive in 2-4 s
const WINDOW_MIN = 30; // a late arrival keeps the notice up for this long, then it clears by itself

const IST = 'Asia/Kolkata';
const hhmm = (d) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: IST });
// The machine stamps punches in IST (TimeZone=330 in utils/biometricDevice.js optionsReply): "2026-11-18 09:16:14" is IST.
const punchTime = (s) => new Date(`${String(s).replace(' ', 'T')}+05:30`);
const ago = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return 'less than a minute ago';
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}${r ? ` ${r} min` : ''} ago`;
  return `${Math.floor(h / 24)} days ago`;
};
const mins = (sec) => Math.max(1, Math.round(sec / 60));

async function deviceNotice(now = new Date()) {
  const devices = await prisma.biometricDevice.findMany({ where: { status: 'Active' } });
  const live = devices.filter((d) => d.lastSeenAt); // never connected = not set up yet, not "late"
  if (!live.length) return { show: false };

  // The worst device speaks: silent first, then late. (One machine in practice.)
  const silent = live
    .map((d) => ({ d, age: now - new Date(d.lastSeenAt).getTime() }))
    .filter((x) => x.age > OFFLINE_MIN * 60000)
    .sort((a, b) => b.age - a.age)[0];
  if (silent) {
    const when = new Date(silent.d.lastSeenAt);
    return {
      show: true,
      kind: 'offline',
      title: 'The biometric machine is not reporting',
      message: `It last contacted TeamLink ${ago(silent.age)} (${hhmm(when)}). Thumb punches made since then will appear when it reconnects, so someone who has punched can still show "Not in yet". Check the machine's network cable or Wi-Fi and power, then restart it if needed.`,
      lastSeenAt: when.toISOString(),
      lastPunchAt: silent.d.lastPunchAt || null,
      checkedAt: now.toISOString(),
    };
  }

  const since = new Date(now.getTime() - WINDOW_MIN * 60000);
  const rows = await prisma.biometricPunchLog.findMany({
    where: { deviceSerial: { in: live.map((d) => d.serialNumber) }, createdAt: { gte: since } },
    select: { punchAt: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  let worst = null;
  let lateCount = 0;
  rows.forEach((r) => {
    const sec = (new Date(r.createdAt).getTime() - punchTime(r.punchAt).getTime()) / 1000;
    if (!(sec > LATE_SEC)) return;
    lateCount += 1;
    if (!worst || sec > worst.sec) worst = { sec, punchAt: r.punchAt, received: r.createdAt };
  });
  if (worst) {
    return {
      show: true,
      kind: 'late',
      title: 'Biometric punches are arriving late',
      message: `The machine is sending punches to TeamLink late: one pressed at ${hhmm(punchTime(worst.punchAt))} reached TeamLink at ${hhmm(worst.received)}, ${mins(worst.sec)} minutes later. Someone who has just punched may show "Not in yet" for a few minutes. Nothing is lost; the punch keeps its real time.`,
      lateCount,
      worstLagMinutes: mins(worst.sec),
      lastSeenAt: new Date(live[0].lastSeenAt).toISOString(),
      checkedAt: now.toISOString(),
    };
  }
  return { show: false };
}

module.exports = { deviceNotice, OFFLINE_MIN, LATE_SEC, WINDOW_MIN };
