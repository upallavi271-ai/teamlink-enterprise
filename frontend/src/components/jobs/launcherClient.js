// ---------------------------------------------------------------------------
// TeamLink Launcher: the small helper on the recruiter's own PC (teamlink-launcher/, 127.0.0.1:47831).
//   pingLauncher()                      -> { ok, version, boards } or null when it is not running
//   openWithLauncher(board, fields)     -> { ok, message } | { ok:false, error }   (opens the board in the person's Chrome; the person signs in and presses
//                                          the green button on the page; the Launcher types the saved requirement; the person presses the board's own Post)
// Only the board's name and the requirement's text boxes are sent, and only to this PC. No password, no login, nothing is sent to the board by TeamLink.
// ---------------------------------------------------------------------------
const BASE = 'http://127.0.0.1:47831';

async function call(path, init, ms = 2500) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${BASE}${path}`, { ...init, signal: ctl.signal });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch { return null; } finally { clearTimeout(t); }
}

export async function pingLauncher() {
  const r = await call('/ping');
  return r && r.status === 200 && r.body && r.body.app === 'teamlink-launcher' ? r.body : null;
}

export async function openWithLauncher(board, fields) {
  const r = await call('/open', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ board, fields: (fields || []).map((f) => ({ label: f.label, value: f.value })) }),
  }, 40000);
  if (!r) return { ok: false, error: 'The Launcher is not running on this PC. Start it (teamlink-launcher\\Start-Launcher.cmd) and try again.' };
  if (r.status !== 200 || !r.body || !r.body.ok) return { ok: false, error: (r.body && r.body.error) || 'The Launcher could not open it.' };
  return { ok: true, message: r.body.message };
}
