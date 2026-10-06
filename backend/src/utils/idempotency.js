// ---------------------------------------------------------------------------
// ONE CLICK = ONE RECORD (Save & Post spec §25 #8–9, 2026-10-05).
//
// A form sends a one-time key per opening (header "Idempotency-Key"). The
// first request with that key does the work; any other request with the same
// key — a double click, a second Save & Post, a network retry — gets the SAME
// answer back instead of creating a second record. Parallel requests are
// safe: the key is claimed with a unique insert (AppSetting primary key), so
// only one of them can win; the others wait for its answer.
//
// Keys are per login and per scope, kept 24 hours (AppSetting "idem.*").
// A request whose work fails releases its key, so fixing the form and
// pressing Save again works.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const PREFIX = 'idem.';
const KEEP_MS = 24 * 3600 * 1000;
const WAIT_MS = 15000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function claim(key, user) {
  try {
    await prisma.appSetting.create({ data: { key, value: JSON.stringify({ state: 'pending', at: Date.now() }), updatedById: user.id, updatedByName: user.name || null } });
    return true;
  } catch (err) {
    if (err && err.code === 'P2002') return false;
    throw err;
  }
}

function idempotent(scope) {
  return async (req, res, next) => {
    const raw = String(req.get('idempotency-key') || '').trim();
    if (!raw || !req.user) return next();
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(raw)) return res.status(400).json({ error: 'This form cannot be sent safely. Close it, open it again and save.' });
    const key = `${PREFIX}${scope}.${req.user.id}.${raw}`;
    try {
      let mine = await claim(key, req.user);
      if (!mine) {
        // The same key again: answer with the first request's result.
        const until = Date.now() + WAIT_MS;
        while (Date.now() < until) {
          // eslint-disable-next-line no-await-in-loop
          const row = await prisma.appSetting.findUnique({ where: { key } });
          if (!row) { // the first one failed and let go: this one may try
            // eslint-disable-next-line no-await-in-loop
            mine = await claim(key, req.user);
            if (mine) break;
          } else {
            let v = null;
            try { v = JSON.parse(row.value); } catch { v = null; }
            if (v && v.state === 'done') {
              res.set('Idempotent-Replay', 'true');
              return res.status(v.status || 200).json({ ...(v.body || {}), duplicateRequest: true });
            }
          }
          // eslint-disable-next-line no-await-in-loop
          await sleep(200);
        }
        if (!mine) return res.status(409).json({ error: 'This job is still being saved. Wait a moment — it will appear once.' });
      }
    } catch (err) {
      return next(err);
    }

    // Remember this request's answer (or let the key go if it failed).
    const send = res.json.bind(res);
    res.json = (body) => {
      const ok = res.statusCode >= 200 && res.statusCode < 300 && body && body.id;
      const done = ok
        ? prisma.appSetting.update({ where: { key }, data: { value: JSON.stringify({ state: 'done', status: res.statusCode, body }) } })
        : prisma.appSetting.delete({ where: { key } });
      done.catch(() => {});
      return send(body);
    };
    // Lazy clean-up of old keys.
    prisma.appSetting.deleteMany({ where: { key: { startsWith: PREFIX }, updatedAt: { lt: new Date(Date.now() - KEEP_MS) } } }).catch(() => {});
    return next();
  };
}

module.exports = { idempotent };
