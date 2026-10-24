// A small per-login rate limit for the SEND endpoints (a runaway screen or a script cannot flood a SIM / a number).
// Sliding window, in memory. 429 with a plain sentence. Default: 40 sends a minute per login; TL_COMM_SEND_LIMIT overrides.
const hits = new Map();

function limiter({ perMinute } = {}) {
  return (req, res, next) => {
    const max = Number(perMinute || process.env.TL_COMM_SEND_LIMIT) || 40;
    const key = (req.user && req.user.id) || req.ip || 'anon';
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < 60000);
    if (list.length >= max) {
      res.setHeader('Retry-After', '30');
      return res.status(429).json({ error: `Too many messages in a minute (limit ${max}). Wait a little and try again.` });
    }
    list.push(now);
    hits.set(key, list);
    if (hits.size > 5000) { for (const [k, v] of hits) if (!v.some((t) => now - t < 60000)) hits.delete(k); }
    return next();
  };
}

module.exports = { limiter };
