// AI MARKETING > AI VIDEO: the video drawn on a <canvas> and recorded IN THE BROWSER (MediaRecorder): no server software and no cost.
//   intro  : brand colours, logo, headline, tagline
//   scenes : approved PICTURES (moving: zoom in, zoom out or pan) and the person's own video CLIPS (real footage, e.g. made with the Gemini app),
//            each with its caption on a band in the main colour and the logo small in a corner
//   outro  : the call to action in the accent colour, website / contact, logo
// Scenes cross-fade. The same drawFrame() is used for the live preview and for the recording, so the video is exactly what was previewed.
// A clip plays in its own scene (its video element is played while that scene runs); its sound can be kept (WebAudio feeds the recording).

export const FORMATS = {
  '1:1': { label: 'Square post (1:1)', w: 1080, h: 1080 },
  '4:5': { label: 'Instagram portrait (4:5)', w: 1080, h: 1350 },
  '9:16': { label: 'Reel / Story (9:16)', w: 720, h: 1280 },
  '16:9': { label: 'LinkedIn / YouTube (16:9)', w: 1280, h: 720 },
};
export const MOTIONS = { mixed: 'Mixed (zoom in, pan, zoom out)', in: 'Zoom in', out: 'Zoom out', pan: 'Pan sideways', tour: 'Dashboard tour (glide across a screenshot, best with 6 seconds or more)' };

// DASHBOARD TOUR (2026-11-24): the free "camera" for a screenshot of a dashboard or any busy screen. It looks at the whole screen, glides into the top left (the numbers),
// sweeps to the top right, drops to the lower part (charts, lists) and pulls back, each move eased in and out, with a short rest at every stop. Pure maths on the picture: no model, no cost.
// Each stop is [share of the scene when the camera is there, zoom (1 = the whole picture), centre x, centre y] (centre as a share of the picture, 0..1).
const TOUR = [
  [0.00, 1.00, 0.50, 0.50], [0.10, 1.00, 0.50, 0.50],
  [0.34, 1.60, 0.27, 0.30], [0.42, 1.60, 0.27, 0.30],
  [0.58, 1.60, 0.73, 0.32], [0.64, 1.60, 0.73, 0.32],
  [0.78, 1.50, 0.50, 0.72], [0.83, 1.50, 0.50, 0.72],
  [1.00, 1.00, 0.50, 0.50],
];
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
// where the camera is at p (0..1 through the scene); an odd picture is mirrored, so two dashboards in a row do not move the same way
export function tourAt(p, idx = 0) {
  const t = Math.min(1, Math.max(0, Number.isFinite(p) ? p : 0));
  let i = 1; while (i < TOUR.length - 1 && t > TOUR[i][0]) i++;
  const a = TOUR[i - 1]; const b = TOUR[i];
  const k = b[0] === a[0] ? 1 : easeInOut((t - a[0]) / (b[0] - a[0]));
  const cx = a[2] + (b[2] - a[2]) * k;
  return { z: a[1] + (b[1] - a[1]) * k, cx: idx % 2 ? 1 - cx : cx, cy: a[3] + (b[3] - a[3]) * k };
}
// where to draw a picture of iw x ih on a W x H frame for that camera (the camera never leaves the picture)
export function tourRect(W, H, iw, ih, cam) {
  const base = Math.max(W / iw, H / ih) * cam.z; const w = iw * base; const h = ih * base;
  const x = Math.min(0, Math.max(W - w, W / 2 - cam.cx * w)); const y = Math.min(0, Math.max(H - h, H / 2 - cam.cy * h));
  return { x, y, w, h };
}
const FADE = 0.6;
const INTRO = 2.6;
const OUTRO = 3.2;

// the best recording type this browser has: MP4 (H.264) when it can, otherwise WebM; with sound when the video has clips' sound to keep
export function recordType(withAudio = false) {
  if (typeof MediaRecorder === 'undefined') return null;
  const sup = (t) => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } };
  const audio = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus'];
  const plain = ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return (withAudio ? [...audio, ...plain] : plain).find(sup) || null;
}

// items: [{ kind: 'image' | 'clip', len }] -> the scenes with their start and length (a clip plays for at most clipSec, and never past its own end)
export function timeline(items, secPer, clipSec = 6) {
  const scenes = [{ type: 'intro', dur: INTRO }, ...items.map((p, i) => ({ type: p.kind === 'clip' ? 'clip' : 'pic', idx: i, dur: p.kind === 'clip' ? (p.voiceSec ? Math.max(3, p.voiceSec + 0.9) : Math.max(1, Math.min(clipSec, p.len || clipSec))) : Math.max(secPer, p.voiceSec ? p.voiceSec + 0.6 : 0) })), { type: 'outro', dur: OUTRO }];
  let t = 0;
  scenes.forEach((s) => { s.start = t; t += s.dur; });
  return { scenes, total: t };
}

const ease = (x) => 1 - (1 - Math.min(1, Math.max(0, x))) ** 3;
function wrap(ctx, text, maxW, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  words.forEach((w) => { const next = cur ? `${cur} ${w}` : w; if (ctx.measureText(next).width > maxW && cur) { lines.push(cur); cur = w; } else cur = next; });
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = `${lines[maxLines - 1].replace(/\s+\S*$/, '')}…`; }
  return lines;
}
function textBlock(ctx, text, x, y, maxW, size, color, maxLines = 3, weight = 800, align = 'center') {
  ctx.font = `${weight} ${size}px "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'top';
  const lines = wrap(ctx, text, maxW, maxLines);
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * size * 1.18));
  return lines.length * size * 1.18;
}
function gradient(ctx, W, H, a, b) {
  const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, a); g.addColorStop(1, b);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function logoAt(ctx, logo, x, y, maxW, maxH, plate) {
  if (!logo) return;
  const r = Math.min(maxW / logo.width, maxH / logo.height);
  const w = logo.width * r; const h = logo.height * r;
  if (plate) { const p = Math.round(Math.min(w, h) * 0.18) + 6; ctx.fillStyle = 'rgba(255,255,255,0.92)'; roundRect(ctx, x - p, y - p, w + p * 2, h + p * 2, p); ctx.fill(); }
  ctx.drawImage(logo, x, y, w, h);
}

function drawIntro(ctx, W, H, lt, d) {
  const { colors } = d.brand;
  gradient(ctx, W, H, colors.primary, colors.secondary);
  const k = ease(lt / 0.8); const m = Math.min(W, H);
  ctx.globalAlpha *= k;
  if (d.logo) logoAt(ctx, d.logo, W / 2 - m * 0.11, H * 0.2 + (1 - k) * 30, m * 0.22, m * 0.16, true);
  const used = textBlock(ctx, d.headline || d.brand.brandName, W / 2, H * 0.42 + (1 - k) * 40, W * 0.84, Math.round(m * 0.085), '#ffffff', 3);
  if (d.tagline) textBlock(ctx, d.tagline, W / 2, H * 0.42 + used + m * 0.03 + (1 - k) * 40, W * 0.8, Math.round(m * 0.042), 'rgba(255,255,255,0.88)', 2, 600);
}
// the caption band and the corner logo, shared by pictures and clips
function overlay(ctx, W, H, lt, pic, d) {
  const { colors } = d.brand; const m = Math.min(W, H);
  if (pic.caption) {
    ctx.font = `800 ${Math.round(m * 0.05)}px "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
    const lines = wrap(ctx, pic.caption, W * 0.84, 2);
    const bandH = lines.length * m * 0.05 * 1.18 + m * 0.06;
    const k = ease((lt - 0.2) / 0.6);
    ctx.save(); ctx.globalAlpha *= 0.88 * k; ctx.fillStyle = colors.primary; ctx.fillRect(0, H - bandH, W, bandH); ctx.restore();
    ctx.save(); ctx.globalAlpha *= k; textBlock(ctx, pic.caption, W / 2, H - bandH + m * 0.03, W * 0.84, Math.round(m * 0.05), '#ffffff', 2); ctx.restore();
  }
  if (d.logo) logoAt(ctx, d.logo, W - m * 0.04 - m * 0.13, m * 0.04, m * 0.13, m * 0.09, true);
}
// a picture that moves: zoom in, zoom out or pan (Mixed alternates them picture by picture)
function drawPic(ctx, W, H, lt, s, d) {
  const img = d.images[s.idx]; const pic = d.pics[s.idx];
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (img) {
    const p = lt / s.dur;
    const mode = d.motion && d.motion !== 'mixed' ? d.motion : ['in', 'pan', 'out', 'pan'][s.idx % 4];
    if (mode === 'tour') {
      const r = tourRect(W, H, img.width, img.height, tourAt(p, s.idx));
      ctx.drawImage(img, r.x, r.y, r.w, r.h);
    } else {
      const dir = s.idx % 2 ? -1 : 1;
      let z = 1.0 + 0.09 * p; let dx = 0;
      if (mode === 'out') z = 1.1 - 0.1 * p;
      else if (mode === 'pan') { z = 1.12; dx = dir * (p - 0.5) * W * 0.06; }
      else dx = dir * (p - 0.5) * W * 0.02;
      const base = Math.max(W / img.width, H / img.height) * z;
      const w = img.width * base; const h = img.height * base;
      ctx.drawImage(img, (W - w) / 2 + dx, (H - h) / 2, w, h);
    }
  }
  overlay(ctx, W, H, lt, pic, d);
}

// ---- EXPLAINER over REAL FOOTAGE (2026-11-24): a free stock clip plays behind the words (looped while the voice speaks); the title slides in at the top and the rows come in one by one, timed to the voice ----
function overlayExplain(ctx, W, H, lt, pic, d) {
  const { colors } = d.brand; const m = Math.min(W, H);
  const gt = ctx.createLinearGradient(0, 0, 0, H * 0.34); gt.addColorStop(0, 'rgba(0,0,0,0.62)'); gt.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = gt; ctx.fillRect(0, 0, W, H * 0.34);
  const gb = ctx.createLinearGradient(0, H * 0.4, 0, H); gb.addColorStop(0, 'rgba(0,0,0,0)'); gb.addColorStop(1, 'rgba(0,0,0,0.78)'); ctx.fillStyle = gb; ctx.fillRect(0, H * 0.4, W, H * 0.6);
  const k = ease(lt / 0.6);
  if (pic.title) {
    ctx.save(); ctx.globalAlpha *= k; ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = m * 0.02;
    ctx.fillStyle = colors.accent; ctx.fillRect(m * 0.06, m * 0.07 + (1 - k) * 24, m * 0.012, m * 0.1);
    textBlock(ctx, pic.title, m * 0.095, m * 0.07 + (1 - k) * 24, W - m * 0.17, Math.round(m * 0.066), '#ffffff', 3, 800, 'left');
    ctx.restore();
  }
  const rows = (pic.rows || []).slice(0, 4);
  const total = Math.max(3, pic.voiceSec || 6);
  const rh = m * 0.118; const gap = m * 0.018; const x0 = m * 0.06; const rw = W - m * 0.12;
  const startY = H - m * 0.1 - rows.length * (rh + gap);
  rows.forEach((r, i) => {
    const t0 = 0.7 + (i * (total - 1.4)) / Math.max(1, rows.length);
    const kk = ease((lt - t0) / 0.5); if (kk <= 0) return;
    const y = startY + i * (rh + gap) + (1 - kk) * 34;
    ctx.save(); ctx.globalAlpha *= kk;
    ctx.fillStyle = 'rgba(255,255,255,0.95)'; roundRect(ctx, x0, y, rw, rh, rh * 0.2); ctx.fill();
    const lw = m * 0.2; ctx.fillStyle = colors.accent; roundRect(ctx, x0 + m * 0.014, y + m * 0.014, lw, rh - m * 0.028, (rh - m * 0.028) / 2); ctx.fill();
    ctx.fillStyle = '#10211a'; ctx.font = '800 ' + Math.round(m * 0.03) + 'px "Segoe UI", Roboto, Helvetica, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(r.label || '').slice(0, 10), x0 + m * 0.014 + lw / 2, y + rh / 2 + 1);
    ctx.textBaseline = 'top'; ctx.fillStyle = '#17302a';
    const tx = x0 + m * 0.014 + lw + m * 0.025; const tw = rw - (tx - x0) - m * 0.02;
    ctx.font = '700 ' + Math.round(m * 0.036) + 'px "Segoe UI", Roboto, Helvetica, Arial, sans-serif'; const lines = wrap(ctx, r.text, tw, 2);
    const th = lines.length * m * 0.036 * 1.2; ctx.textAlign = 'left';
    lines.forEach((l, li) => ctx.fillText(l, tx, y + (rh - th) / 2 + li * m * 0.036 * 1.2));
    ctx.restore();
  });
  if (d.logo) logoAt(ctx, d.logo, W - m * 0.04 - m * 0.13, m * 0.04, m * 0.13, m * 0.09, true);
}
// real footage: the clip's own video element (played while this scene runs), covering the frame
function drawClip(ctx, W, H, lt, s, d) {
  const v = d.videos && d.videos[s.idx]; const pic = d.pics[s.idx];
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (v && v.readyState >= 2 && v.videoWidth) {
    const base = Math.max(W / v.videoWidth, H / v.videoHeight);
    const w = v.videoWidth * base; const h = v.videoHeight * base;
    ctx.drawImage(v, (W - w) / 2, (H - h) / 2, w, h);
  }
  if (pic.rows && pic.rows.length) overlayExplain(ctx, W, H, lt, pic, d); else overlay(ctx, W, H, lt, pic, d);
}
function drawOutro(ctx, W, H, lt, d) {
  const { colors } = d.brand; const m = Math.min(W, H);
  gradient(ctx, W, H, colors.secondary, colors.primary);
  const k = ease(lt / 0.8);
  ctx.globalAlpha *= k;
  if (d.logo) logoAt(ctx, d.logo, W / 2 - m * 0.1, H * 0.16, m * 0.2, m * 0.14, true);
  // the call to action on a pill in the accent colour
  const cta = d.cta || 'Talk to us';
  ctx.font = `800 ${Math.round(m * 0.06)}px "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  const lines = wrap(ctx, cta, W * 0.78, 2);
  const pillW = Math.min(W * 0.86, Math.max(...lines.map((l) => ctx.measureText(l).width)) + m * 0.1);
  const pillH = lines.length * m * 0.06 * 1.18 + m * 0.06;
  const py = H * 0.44 + (1 - k) * 30;
  ctx.fillStyle = colors.accent; roundRect(ctx, (W - pillW) / 2, py, pillW, pillH, pillH / 2.4); ctx.fill();
  textBlock(ctx, cta, W / 2, py + m * 0.03, W * 0.78, Math.round(m * 0.06), '#111111', 2);
  let y = py + pillH + m * 0.05;
  (d.footer || []).filter(Boolean).slice(0, 2).forEach((line) => { y += textBlock(ctx, line, W / 2, y, W * 0.84, Math.round(m * 0.036), 'rgba(255,255,255,0.92)', 1, 600) + m * 0.01; });
}

// ---- the PRESENTER (2026-11-24): a friendly illustrated doctor in the corner whose mouth moves with the voice (the loudness of the spoken sentence, 25 times a second), blinks and nods a little.
// It is drawn here, free: no paid avatar service. Shown only on the scenes that have a spoken sentence.
function drawPresenter(ctx, W, H, lt, d, idx) {
  const v = d.voices && d.voices[idx]; if (!v) return;
  const env = v.env; const open = env && env.length ? env[Math.min(env.length - 1, Math.floor(lt * ENV_FPS))] || 0 : 0;
  const m = Math.min(W, H); const R = m * 0.115; const cx = W - R * 1.25; const cy = H - R * 2.15 - (d.pics[idx] && d.pics[idx].caption ? m * 0.12 : 0);
  const nod = Math.sin(lt * 2.2) * R * 0.025;
  ctx.save(); ctx.translate(cx, cy + nod);
  // shoulders and white coat
  ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.ellipse(0, R * 1.55, R * 1.25, R * 0.8, 0, Math.PI, 0); ctx.fill();
  ctx.fillStyle = '#0f766e'; ctx.beginPath(); ctx.moveTo(-R * 0.28, R * 0.95); ctx.lineTo(0, R * 1.45); ctx.lineTo(R * 0.28, R * 0.95); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#334155'; ctx.lineWidth = Math.max(2, R * 0.045); ctx.beginPath(); ctx.arc(-R * 0.5, R * 1.25, R * 0.3, 0.2, Math.PI - 0.2); ctx.stroke(); // stethoscope
  // neck, face, hair, ears
  ctx.fillStyle = '#e8b896'; ctx.fillRect(-R * 0.2, R * 0.7, R * 0.4, R * 0.4);
  ctx.fillStyle = '#2b1d16'; ctx.beginPath(); ctx.ellipse(0, -R * 0.12, R * 0.98, R * 1.02, 0, Math.PI, 0); ctx.fill();
  ctx.fillStyle = '#f1c7a5'; ctx.beginPath(); ctx.ellipse(-R * 0.93, R * 0.1, R * 0.12, R * 0.2, 0, 0, Math.PI * 2); ctx.ellipse(R * 0.93, R * 0.1, R * 0.12, R * 0.2, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#f5cfae'; ctx.beginPath(); ctx.ellipse(0, R * 0.12, R * 0.86, R * 0.98, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#2b1d16'; ctx.beginPath(); ctx.ellipse(0, -R * 0.55, R * 0.9, R * 0.5, 0, Math.PI, 0); ctx.fill();
  // eyes (they blink about every 3 seconds), brows
  const blink = (lt % 3.1) > 3.0 ? 0.12 : 1;
  ctx.fillStyle = '#ffffff'; [-1, 1].forEach((sx) => { ctx.beginPath(); ctx.ellipse(sx * R * 0.34, -R * 0.02, R * 0.17, R * 0.13 * blink, 0, 0, Math.PI * 2); ctx.fill(); });
  ctx.fillStyle = '#1f2937'; [-1, 1].forEach((sx) => { ctx.beginPath(); ctx.ellipse(sx * R * 0.34, -R * 0.02, R * 0.075, R * 0.075 * blink, 0, 0, Math.PI * 2); ctx.fill(); });
  ctx.strokeStyle = '#2b1d16'; ctx.lineWidth = Math.max(2, R * 0.05); ctx.lineCap = 'round';
  [-1, 1].forEach((sx) => { ctx.beginPath(); ctx.moveTo(sx * R * 0.18, -R * 0.26); ctx.quadraticCurveTo(sx * R * 0.36, -R * 0.36, sx * R * 0.54, -R * 0.26); ctx.stroke(); });
  // nose and the mouth: closed = a gentle smile, open = an oval as tall as the voice is loud
  ctx.strokeStyle = '#d9a283'; ctx.lineWidth = Math.max(2, R * 0.04); ctx.beginPath(); ctx.moveTo(0, R * 0.05); ctx.quadraticCurveTo(R * 0.07, R * 0.22, -R * 0.03, R * 0.27); ctx.stroke();
  const my = R * 0.5; const mw = R * 0.34;
  if (open < 0.06) { ctx.strokeStyle = '#8a3b3b'; ctx.lineWidth = Math.max(2, R * 0.05); ctx.beginPath(); ctx.moveTo(-mw, my); ctx.quadraticCurveTo(0, my + R * 0.16, mw, my); ctx.stroke(); }
  else { const mh = R * (0.07 + 0.3 * Math.min(1, open)); ctx.fillStyle = '#7a2330'; ctx.beginPath(); ctx.ellipse(0, my + mh * 0.4, mw * (0.8 + 0.2 * Math.min(1, open)), mh, 0, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.ellipse(0, my + mh * 0.05, mw * 0.62, mh * 0.28, 0, 0, Math.PI); ctx.fill(); }
  ctx.restore();
}
function drawScene(ctx, W, H, s, lt, d) {
  if (s.type === 'intro') drawIntro(ctx, W, H, lt, d);
  else if (s.type === 'outro') drawOutro(ctx, W, H, lt, d);
  else if (s.type === 'clip') drawClip(ctx, W, H, lt, s, d);
  else { drawPic(ctx, W, H, lt, s, d); if (d.presenter) drawPresenter(ctx, W, H, lt, d, s.idx); }
}
export function sceneIndex(tl, t) {
  const i = tl.scenes.findIndex((s) => t >= s.start && t < s.start + s.dur);
  return i < 0 ? tl.scenes.length - 1 : i;
}

// one frame at time t (seconds)
export function drawFrame(ctx, W, H, t, d, tl) {
  const { scenes } = tl;
  const i = sceneIndex(tl, t);
  const s = scenes[i]; const lt = Math.min(s.dur, Math.max(0, t - s.start));
  ctx.save(); ctx.globalAlpha = 1;
  if (i > 0 && lt < FADE) {
    const p = scenes[i - 1];
    drawScene(ctx, W, H, p, p.dur, d); // the scene before, as it ended (a clip holds its last frame)
    ctx.globalAlpha = lt / FADE;
  }
  drawScene(ctx, W, H, s, lt, d);
  ctx.restore();
}

// ---- the voice-over (2026-11-21): each scene's caption is spoken by the server's free voice; the scene lasts as long as the sentence (timeline: voiceSec) and the sound goes to the recording ----
function ensureAC() {
  const Ctor = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!Ctor) return null;
  if (!AC) AC = new Ctor();
  if (AC.state === 'suspended') AC.resume().catch(() => {});
  return AC;
}
/** Decode the spoken sentences (wav bytes per scene, or null) -> AudioBuffer per scene. */
export async function decodeVoices(buffers) {
  const c = ensureAC();
  if (!c) throw new Error('This browser cannot play sound.');
  const list = await Promise.all(buffers.map((b) => (b ? c.decodeAudioData(b.slice(0)) : null)));
  list.forEach((ab) => { if (ab) ab.env = envelopeOf(ab); }); // how loud the voice is, 25 times a second: the presenter's mouth follows it
  return list;
}
const ENV_FPS = 25;
function envelopeOf(ab) {
  const data = ab.getChannelData(0); const step = Math.max(1, Math.floor(ab.sampleRate / ENV_FPS)); const n = Math.ceil(data.length / step);
  const env = new Float32Array(n); let peak = 0.0001;
  for (let i = 0; i < n; i += 1) { let sum = 0; const from = i * step; const to = Math.min(data.length, from + step); for (let j = from; j < to; j += 1) sum += data[j] * data[j]; env[i] = Math.sqrt(sum / Math.max(1, to - from)); if (env[i] > peak) peak = env[i]; }
  for (let i = 0; i < n; i += 1) env[i] = Math.min(1, env[i] / (peak * 0.75)); // 0 = silent, 1 = the loudest part
  for (let i = 1; i < n; i += 1) env[i] = env[i] * 0.65 + env[i - 1] * 0.35; // a little smoothing so the mouth does not flutter
  return env;
}

// ---- the clips' sound: one shared AudioContext; each clip's element is wired ONCE (the browser allows only one source per element) ----------------
let AC = null;
function wireAudio(videos, toRecorder) {
  const Ctor = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!Ctor) return null;
  if (!AC) AC = new Ctor();
  if (AC.state === 'suspended') AC.resume().catch(() => {});
  const dest = toRecorder ? AC.createMediaStreamDestination() : null;
  videos.forEach((v) => {
    if (!v) return;
    if (!v.__mkSrc) v.__mkSrc = AC.createMediaElementSource(v);
    try { v.__mkSrc.disconnect(); } catch { /* it was not connected */ }
    // recording: the sound goes to the recording only (the computer stays quiet); preview: to the speakers
    v.__mkSrc.connect(toRecorder ? dest : AC.destination);
    v.muted = false;
  });
  return dest;
}
const muteAll = (videos) => videos.forEach((v) => { if (v) v.muted = true; });
const stopClips = (videos) => videos.forEach((v) => { if (v) { try { v.pause(); } catch { /* ignore */ } } });
const stopVoices = (list) => { list.forEach((v) => { try { v.stop(); } catch { /* already ended */ } }); list.length = 0; };

// play (preview) or record. Returns a stop() function; onDone(blob|null, why) is called at the end.
export function play(canvas, d, { secPer, clipSec = 6, record = false, onProgress, onDone }) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width; const H = canvas.height;
  const tl = timeline(d.pics, secPer, clipSec);
  const videos = (d.videos || []).filter(Boolean);
  const hasClips = d.pics.some((p) => p.kind === 'clip');
  const sound = !!d.sound && hasClips;
  const voices = d.voices || [];
  const hasVoice = voices.some(Boolean);
  const voiceSrc = [];
  let rec = null; const chunks = []; let stopped = false;
  const type = record ? recordType(sound || hasVoice) : null;
  videos.forEach((v) => { try { v.pause(); v.currentTime = 0; } catch { /* ignore */ } });
  let dest = null;
  if (sound) { try { dest = wireAudio(videos, record); } catch { dest = null; muteAll(videos); } } else muteAll(videos);
  if (hasVoice && record) { const c = ensureAC(); if (c) dest = dest || c.createMediaStreamDestination(); }
  if (record) {
    if (!type || !canvas.captureStream) { onDone(null, 'This browser cannot record video. Use a recent Chrome or Edge.'); return () => {}; }
    const vs = canvas.captureStream(30);
    const stream = dest && dest.stream.getAudioTracks().length ? new MediaStream([...vs.getVideoTracks(), ...dest.stream.getAudioTracks()]) : vs;
    rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 6000000 });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => { stopClips(videos); stopVoices(voiceSrc); onDone(stopped ? null : new Blob(chunks, { type: type.split(';')[0] })); };
    drawFrame(ctx, W, H, 0, d, tl);
    rec.start(250);
  }
  const t0 = performance.now();
  let lastI = -1;
  const enter = (i) => {
    // a new scene: the clip before it stops where it is (its last frame is kept for the cross-fade); a clip scene starts its clip from the beginning
    const prev = tl.scenes[lastI];
    if (prev && prev.type === 'clip') { const pv = d.videos[prev.idx]; if (pv) { try { pv.pause(); } catch { /* ignore */ } } }
    const s = tl.scenes[i];
    if (s.type === 'clip') { const v = d.videos[s.idx]; if (v) { try { v.currentTime = 0; const pr = v.play(); if (pr && pr.catch) pr.catch(() => {}); } catch { /* ignore */ } } }
    if ((s.type === 'pic' || s.type === 'clip') && voices[s.idx] && AC) { // this scene's sentence
      try { const src = AC.createBufferSource(); src.buffer = voices[s.idx]; src.connect(record && dest ? dest : AC.destination); src.start(0); voiceSrc.push(src); } catch { /* the video goes on without it */ }
    }
    lastI = i;
  };
  const tick = () => {
    if (stopped) return;
    const t = (performance.now() - t0) / 1000;
    const tc = Math.min(t, tl.total - 0.001);
    const i = sceneIndex(tl, tc);
    if (i !== lastI) enter(i);
    drawFrame(ctx, W, H, tc, d, tl);
    if (onProgress) onProgress(Math.min(1, t / tl.total), t);
    if (t < tl.total) requestAnimationFrame(tick);
    else if (rec) setTimeout(() => rec.state !== 'inactive' && rec.stop(), 200); // the last frame is held a moment so it is recorded
    else { stopClips(videos); stopVoices(voiceSrc); onDone && onDone(null); }
  };
  requestAnimationFrame(tick);
  return () => { stopped = true; stopClips(videos); stopVoices(voiceSrc); if (rec && rec.state !== 'inactive') rec.stop(); else if (onDone && !rec) onDone(null); };
}
