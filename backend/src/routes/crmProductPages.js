// ---------------------------------------------------------------------------
// THE LEAD'S PAGES FOR OUR PRODUCTS (no login; signed links that expire - crm/productSales.js). Mounted inside routes/crmPublic.js.
//   GET  /demo/:token                    the sample demo: each product the lead wants, with ITS OWN video part and its features,
//                                        and three buttons: I'm interested (opens the AI meeting) · Talk to a person · Later
//   GET  /demo/:token/video/:key         that product's video (streamed with ranges, so it can be skipped through)
//   POST /demo/:token/event              { kind: open|play|interested|person|later, product?, seconds? } -> the lead's timeline
//   GET  /meet/:token                    the AI meeting room: slides (what it is, features, plans) + the AI talking (text or voice)
//   GET  /meet/:token/state              the conversation so far
//   POST /meet/:token/say                { text } -> the AI's answer
//   POST /meet/:token/end                { decision: yes|later|no }
// Every page says plainly that the assistant is an AI. Nothing here needs or sets a login.
// ---------------------------------------------------------------------------
const express = require('express');
const fs = require('fs');
const PS = require('../crm/productSales');

const router = express.Router();
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const noStore = (res) => { res.set('Cache-Control', 'private, no-store'); res.set('X-Robots-Tag', 'noindex'); };
const CSS = `*{box-sizing:border-box}body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f6fb;color:#16233f;margin:0}
.top{background:#13294b;color:#fff;padding:14px 20px;display:flex;align-items:center;gap:12px}.top b{font-size:18px}.top span{opacity:.75;font-size:13px}
.wrap{max-width:1100px;margin:0 auto;padding:18px 16px 60px}.card{background:#fff;border:1px solid #e1e6ef;border-radius:14px;padding:18px;margin-bottom:16px;box-shadow:0 3px 14px rgba(20,40,80,.05)}
h1{font-size:22px;margin:4px 0 6px}h2{font-size:18px;margin:0 0 6px}p{line-height:1.55;color:#40506b;margin:6px 0}ul{margin:8px 0 0;padding-left:20px;line-height:1.6;color:#2b3a55}
video{width:100%;border-radius:10px;background:#000;max-height:520px}.btns{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}
.b{border:0;border-radius:9px;padding:11px 18px;font-size:15px;cursor:pointer}.b1{background:#16a34a;color:#fff}.b2{background:#fff;border:1px solid #c9d2e3;color:#13294b}.b3{background:#fff;border:1px solid #e5c8c8;color:#9b1c1c}
.muted{color:#6b7891;font-size:13px}.plans{display:flex;gap:10px;flex-wrap:wrap}.plan{border:1px solid #e1e6ef;border-radius:10px;padding:10px 12px;min-width:150px}`;
const shell = (title, body, script = '') => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><div class="top"><b>TeamLink</b><span>${esc(title)}</span></div><div class="wrap">${body}</div>${script ? `<script>${script}</script>` : ''}</body></html>`;
const expired = (res) => { res.set('Content-Type', 'text/html; charset=utf-8'); return res.status(404).send(shell('Link expired', '<div class="card"><h1>This link has expired</h1><p>Please reply to our message and we will send you a fresh one.</p></div>')); };
const plansHtml = (p) => { const pl = (p.plans || []).filter((x) => x.name); return pl.length ? `<div class="plans">${pl.map((x) => `<div class="plan"><b>${esc(x.name)}</b><div class="muted">${x.price ? `${esc(x.price)} ${esc(x.unit || '')}` : 'Price on request'}</div>${x.includes ? `<div class="muted">${esc(x.includes)}</div>` : ''}</div>`).join('')}</div>` : ''; };

// ---- the demo ----
router.get('/demo/:token', async (req, res) => {
  const d = await PS.demoForToken(req.params.token).catch(() => null);
  noStore(res);
  if (!d || !d.products.length) return expired(res);
  const t = esc(req.params.token);
  const hi = d.lead.contactName ? `Hello ${esc(String(d.lead.contactName).split(' ')[0])},` : 'Hello,';
  const cards = d.products.map((p) => `<div class="card"><h2>${esc(p.name)}</h2><p>${esc(p.tagline || '')}</p>
    ${p.hasVideo ? `<video controls preload="metadata" playsinline data-key="${esc(p.key)}" src="${p.videoFile ? `/api/crm-public/demo/${t}/video/${esc(p.key)}` : esc(p.videoUrl)}"></video>` : (p.demoUrl ? `<p><a href="${esc(p.demoUrl)}" target="_blank" rel="noopener">Open the live demo</a></p>` : '')}
    <p>${esc(p.about || '')}</p><ul>${(p.features || []).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>${plansHtml(p) ? `<h2 style="margin-top:14px">Plans</h2>${plansHtml(p)}` : ''}</div>`).join('');
  const body = `<div class="card"><h1>${hi} here is your demo</h1><p>${esc(d.lead.company ? `Made for ${d.lead.company}.` : '')} Watch at your own pace. If it looks right, press <b>I'm interested</b>: our AI assistant will walk you through it and answer your questions right away.</p></div>${cards}
  <div class="card"><h2>What next?</h2><div class="btns"><button class="b b1" onclick="ev('interested')">I'm interested - start the AI meeting</button><button class="b b2" onclick="ev('person')">Talk to a person</button><button class="b b3" onclick="ev('later')">Later</button></div><p class="muted" id="msg"></p></div>`;
  const script = `const T=${JSON.stringify(req.params.token)};function post(k,x){return fetch('/api/crm-public/demo/'+T+'/event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({kind:k},x||{}))}).then(r=>r.json()).catch(()=>({}))}
post('open');document.querySelectorAll('video').forEach(v=>{let sent=false;v.addEventListener('play',()=>{if(!sent){sent=true;post('play',{product:v.dataset.key})}})});
async function ev(k){const m=document.getElementById('msg');const r=await post(k);if(k==='interested'&&r.meetUrl){location.href=r.meetUrl;return}m.textContent=k==='person'?'Thank you - someone from our team will call you shortly.':'Thank you. You can come back to this page any time.'}`;
  res.set('Content-Type', 'text/html; charset=utf-8');
  return res.send(shell('Product demo', body, script));
});
router.get('/demo/:token/video/:key', async (req, res) => {
  const d = await PS.demoForToken(req.params.token).catch(() => null);
  const p = d && d.products.find((x) => x.key === String(req.params.key).toUpperCase());
  const file = p && PS.videoPathOf(p);
  if (!file) return res.status(404).end();
  noStore(res);
  return res.sendFile(file, { acceptRanges: true, headers: { 'Content-Type': 'video/mp4' } });
});
router.post('/demo/:token/event', async (req, res) => {
  const b = req.body || {};
  const out = await PS.demoEvent(req.params.token, String(b.kind || ''), { product: b.product, seconds: Number(b.seconds) || 0 }).catch(() => ({ error: 'failed' }));
  return res.status(out.error ? 400 : 200).json(out);
});

// ---- the AI meeting ----
router.get('/meet/:token', async (req, res) => {
  const m = await PS.meetingFor(req.params.token).catch(() => null);
  noStore(res);
  if (!m) return expired(res);
  const slides = m.products.map((p) => `<div class="card"><h2>${esc(p.name)}</h2><p>${esc(p.tagline || '')}</p><p>${esc(p.about || '')}</p><ul>${(p.features || []).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>${plansHtml(p) ? `<h2 style="margin-top:12px">Plans</h2>${plansHtml(p)}` : ''}</div>`).join('');
  const body = `<style>.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:860px){.grid{grid-template-columns:1fr}}#log{height:420px;overflow:auto;display:flex;flex-direction:column;gap:8px}.ai,.me{padding:9px 12px;border-radius:12px;max-width:88%;line-height:1.5}.ai{background:#eef3ff;align-self:flex-start}.me{background:#16a34a;color:#fff;align-self:flex-end}.row{display:flex;gap:8px;margin-top:10px}.row input{flex:1;padding:11px;border:1px solid #c9d2e3;border-radius:9px;font-size:15px}</style>
  <div class="card"><h1>Meeting with TeamLink's AI assistant</h1><p class="muted">You are talking to an AI assistant. It answers from TeamLink's product information; anything it cannot confirm, our team will answer. The conversation is saved so our team can follow up.</p></div>
  <div class="grid"><div>${slides}</div><div><div class="card"><div id="log"></div><div class="row"><input id="q" placeholder="Type your question…" onkeydown="if(event.key==='Enter')say()"><button class="b b2" id="mic" title="Speak">🎤</button><button class="b b1" onclick="say()">Send</button></div>
  <label class="muted" style="display:block;margin-top:8px"><input type="checkbox" id="voice" checked> Read the answers aloud</label></div>
  <div class="card" id="endcard"><h2>When you are done</h2><div class="btns"><button class="b b1" onclick="end('yes')">Yes, I want to go ahead</button><button class="b b2" onclick="end('later')">I need some time</button><button class="b b3" onclick="end('no')">Not for us right now</button></div><p class="muted" id="emsg"></p></div></div></div>`;
  const script = `const T=${JSON.stringify(req.params.token)};const log=document.getElementById('log');
function add(who,t){const d=document.createElement('div');d.className=who==='ai'?'ai':'me';d.textContent=t;log.appendChild(d);log.scrollTop=log.scrollHeight}
function speak(t){try{if(!document.getElementById('voice').checked||!window.speechSynthesis)return;const u=new SpeechSynthesisUtterance(t);u.lang='en-IN';speechSynthesis.cancel();speechSynthesis.speak(u)}catch(e){}}
fetch('/api/crm-public/meet/'+T+'/state').then(r=>r.json()).then(s=>{(s.transcript||[]).forEach(x=>add(x.who,x.text));if(s.status!=='Open'){document.getElementById('emsg').textContent='This meeting has ended. Thank you!'}else{const last=(s.transcript||[]).slice(-1)[0];if(last&&last.who==='ai')speak(last.text)}});
let busy=false;async function say(){const i=document.getElementById('q');const t=i.value.trim();if(!t||busy)return;busy=true;i.value='';add('me',t);add('ai','…');
try{const r=await fetch('/api/crm-public/meet/'+T+'/say',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t})}).then(r=>r.json());log.lastChild.textContent=r.reply||r.error||'Sorry, please try again.';speak(r.reply||'')}catch(e){log.lastChild.textContent='Connection problem - please try again.'}busy=false}
async function end(d){const r=await fetch('/api/crm-public/meet/'+T+'/end',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision:d})}).then(r=>r.json()).catch(()=>({}));document.getElementById('emsg').textContent=d==='yes'?'Thank you! Our team will send you the proposal shortly.':d==='later'?'No problem - we will check back with you in a few days.':'Thank you for your time. You can reach us any time.';}
const SR=window.SpeechRecognition||window.webkitSpeechRecognition;const mic=document.getElementById('mic');if(!SR){mic.style.display='none'}else{mic.onclick=()=>{const r=new SR();r.lang='en-IN';r.interimResults=false;mic.textContent='…';r.onresult=e=>{document.getElementById('q').value=e.results[0][0].transcript;say()};r.onend=()=>{mic.textContent='🎤'};r.start()}}`;
  res.set('Content-Type', 'text/html; charset=utf-8');
  return res.send(shell('AI meeting', body, script));
});
router.get('/meet/:token/state', async (req, res) => {
  const m = await PS.meetingFor(req.params.token).catch(() => null);
  noStore(res);
  if (!m) return res.status(404).json({ error: 'This meeting link has expired.' });
  return res.json({ status: m.meeting.status, transcript: m.meeting.transcript.map((x) => ({ who: x.who, text: x.text })) });
});
router.post('/meet/:token/say', async (req, res) => {
  const out = await PS.meetingSay(req.params.token, (req.body || {}).text).catch(() => ({ error: 'Sorry - please try again.' }));
  return res.status(out.error ? 400 : 200).json(out);
});
router.post('/meet/:token/end', async (req, res) => {
  const out = await PS.meetingEnd(req.params.token, String((req.body || {}).decision || '')).catch(() => ({ error: 'Sorry - please try again.' }));
  return res.status(out.error ? 400 : 200).json(out);
});

module.exports = router;
