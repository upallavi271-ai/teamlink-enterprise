// ---------------------------------------------------------------------------
// AI MARKETING > VIDEO ROBUSTNESS (2026-11-21). Videos made in the browser are recorded as MP4 only when the browser can; many (Firefox, some Chrome) record WebM, which WhatsApp, Instagram and most
// mail apps cannot play. So a WebM video is made into a normal MP4 (H.264 + AAC, even size, "faststart" so it plays while it loads) when it is saved, with ffmpeg (free). If ffmpeg is not
// there, or fails, the WebM is kept as it was and nothing is lost: the item then shows that WhatsApp needs an MP4. A WebM from the browser also has no length in its header; the MP4 has.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const FFMPEG = () => process.env.FFMPEG_PATH || 'ffmpeg';
const ffArgs = (src, dst) => ['-y', '-v', 'error', '-i', src, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-r', '30', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', dst];

// -> Buffer (the MP4) | null (not possible: the caller keeps the original)
async function toMp4(buf, { timeoutMs = 180000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-mp4-'));
  const src = path.join(dir, 'in.webm'); const dst = path.join(dir, 'out.mp4');
  try {
    fs.writeFileSync(src, buf);
    const ok = await new Promise((resolve) => {
      let ff;
      try { ff = spawn(FFMPEG(), ffArgs(src, dst), { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }); } catch { resolve(false); return; }
      const t = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* gone */ } resolve(false); }, timeoutMs);
      ff.on('error', () => { clearTimeout(t); resolve(false); }); // ffmpeg is not installed
      ff.on('close', (code) => { clearTimeout(t); resolve(code === 0); });
    });
    if (!ok || !fs.existsSync(dst)) return null;
    const out = fs.readFileSync(dst);
    return out.length > 1000 && out.slice(4, 8).toString('ascii') === 'ftyp' ? out : null;
  } catch { return null; } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp is cleaned by the system anyway */ } }
}

module.exports = { toMp4, ffArgs };
