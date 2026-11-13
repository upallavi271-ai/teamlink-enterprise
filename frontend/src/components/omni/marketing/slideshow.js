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
export const MOTIONS = { mixed: 'Mixed (zoom in, pan, zoom out)', in: 'Zoom in', out: 'Zoom out', pan: 'Pan sideways' };
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
  const scenes = [{ type: 'intro', dur: INTRO }, ...items.map((p, i) => ({ type: p.kind === 'clip' ? 'clip' : 'pic', idx: i, dur: p.kind === 'clip' ? Math.max(1, Math.min(clipSec, p.len || clipSec)) : secPer })), { type: 'outro', dur: OUTRO }];
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
    const dir = s.idx % 2 ? -1 : 1;
    let z = 1.0 + 0.09 * p; let dx = 0;
    if (mode === 'out') z = 1.1 - 0.1 * p;
    else if (mode === 'pan') { z = 1.12; dx = dir * (p - 0.5) * W * 0.06; }
    else dx = dir * (p - 0.5) * W * 0.02;
    const base = Math.max(W / img.width, H / img.height) * z;
    const w = img.width * base; const h = img.height * base;
    ctx.drawImage(img, (W - w) / 2 + dx, (H - h) / 2, w, h);
  }
  overlay(ctx, W, H, lt, pic, d);
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
  overlay(ctx, W, H, lt, pic, d);
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
function drawScene(ctx, W, H, s, lt, d) {
  if (s.type === 'intro') drawIntro(ctx, W, H, lt, d);
  else if (s.type === 'outro') drawOutro(ctx, W, H, lt, d);
  else if (s.type === 'clip') drawClip(ctx, W, H, lt, s, d);
  else drawPic(ctx, W, H, lt, s, d);
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

// play (preview) or record. Returns a stop() function; onDone(blob|null, why) is called at the end.
export function play(canvas, d, { secPer, clipSec = 6, record = false, onProgress, onDone }) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width; const H = canvas.height;
  const tl = timeline(d.pics, secPer, clipSec);
  const videos = (d.videos || []).filter(Boolean);
  const hasClips = d.pics.some((p) => p.kind === 'clip');
  const sound = !!d.sound && hasClips;
  let rec = null; const chunks = []; let stopped = false;
  const type = record ? recordType(sound) : null;
  videos.forEach((v) => { try { v.pause(); v.currentTime = 0; } catch { /* ignore */ } });
  let dest = null;
  if (sound) { try { dest = wireAudio(videos, record); } catch { dest = null; muteAll(videos); } } else muteAll(videos);
  if (record) {
    if (!type || !canvas.captureStream) { onDone(null, 'This browser cannot record video. Use a recent Chrome or Edge.'); return () => {}; }
    const vs = canvas.captureStream(30);
    const stream = dest && dest.stream.getAudioTracks().length ? new MediaStream([...vs.getVideoTracks(), ...dest.stream.getAudioTracks()]) : vs;
    rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 6000000 });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => { stopClips(videos); onDone(stopped ? null : new Blob(chunks, { type: type.split(';')[0] })); };
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
    else { stopClips(videos); onDone && onDone(null); }
  };
  requestAnimationFrame(tick);
  return () => { stopped = true; stopClips(videos); if (rec && rec.state !== 'inactive') rec.stop(); else if (onDone && !rec) onDone(null); };
}
