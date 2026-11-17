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

// the team's own preview from Leads > Our products (crm/productSales.js staffVideoLink, signed for 6 hours)
router.get('/product-video/:token', async (req, res) => {
  const v = PS.readToken(req.params.token, 'pv');
  if (!v) return res.status(404).end();
  const p = (await PS.products({ all: true }).catch(() => [])).find((x) => x.key === v.p[0]);
  const file = p && PS.videoPathOf(p);
  if (!file) return res.status(404).end();
  noStore(res);
  return res.sendFile(file, { acceptRanges: true, headers: { 'Content-Type': 'video/mp4' } });
});

// ---- the demo ----
// "Talk to a person" and "trial" are shared by the demo, the meeting and the quote page (crm/productDeals.js)
const PERSON_JS = `async function person(){const box=document.getElementById('book');box.style.display='block';box.innerHTML='Loading free times…';const r=await fetch('/api/crm-public/slots/'+T).then(r=>r.json()).catch(()=>({}));if(!r.days){box.textContent=r.error||'Please try again.';return}
box.innerHTML='<h2>Pick a time for a call</h2><p class="muted">India time. Our team will call you.</p><div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0">'+r.days.map((d,i)=>'<button class="b b2" onclick="pickDay('+i+')">'+d.label+'</button>').join('')+'</div><div id="times"></div><input id="ph" placeholder="Phone to call (optional)" style="padding:10px;border:1px solid #c9d2e3;border-radius:9px;width:100%;max-width:280px;margin-top:8px">';window.DAYS=r.days}
function pickDay(i){const d=DAYS[i];document.getElementById('times').innerHTML=d.times.length?d.times.map(t=>'<button class="b b2" style="margin:3px" onclick="bookIt(\\''+d.day+'\\',\\''+t+'\\')">'+t+'</button>').join(''):'<p class="muted">No free time that day.</p>'}
async function bookIt(day,time){const r=await fetch('/api/crm-public/book/'+T,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({day,time,phone:(document.getElementById('ph')||{}).value||''})}).then(r=>r.json()).catch(()=>({}));document.getElementById('book').innerHTML=r.ok?'<h2>Booked ✓</h2><p>'+r.day+' at '+r.time+' (India time). We will call you then.</p>':'<p>'+(r.error||'Please try again.')+'</p>'}
async function trial(){const r=await fetch('/api/crm-public/trial/'+T,{method:'POST'}).then(r=>r.json()).catch(()=>({}));const m=document.getElementById('tmsg');if(m)m.textContent=r.ok?'Thank you - our team will set up your trial account and send you the login, usually within one working day.':(r.error||'Please try again.')}`;
router.get('/demo/:token', async (req, res) => {
  const d = await PS.demoForToken(req.params.token).catch(() => null);
  noStore(res);
  if (!d || !d.products.length) return expired(res);
  const t = esc(req.params.token);
  const hi = d.lead.contactName ? `Hello ${esc(String(d.lead.contactName).split(' ')[0])},` : 'Hello,';
  const cards = d.products.map((p) => `<div class="card"><h2>${d.pick ? `<label style="cursor:pointer"><input type="checkbox" class="pk" value="${esc(p.key)}" style="width:20px;height:20px;vertical-align:middle"> ` : ''}${esc(p.name)}${d.pick ? '</label>' : ''}</h2><p>${esc(p.tagline || '')}</p>
    ${p.hasVideo ? `<video controls preload="metadata" playsinline data-key="${esc(p.key)}" src="${p.videoFile ? `/api/crm-public/demo/${t}/video/${esc(p.key)}` : esc(p.videoUrl)}"></video>` : (p.demoUrl ? `<p><a href="${esc(p.demoUrl)}" target="_blank" rel="noopener">Open the live demo</a></p>` : '')}
    <p>${esc(p.about || '')}</p><ul>${(p.features || []).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>${plansHtml(p) ? `<h2 style="margin-top:14px">Plans</h2>${plansHtml(p)}` : ''}</div>`).join('');
  const body = `<div class="card"><h1>${hi} here is your demo</h1><p>${esc(d.lead.company ? `Made for ${d.lead.company}.` : '')} Watch at your own pace.${d.pick ? ' <b>Tick the products you need</b>, then' : ' If it looks right,'} press <b>I'm interested</b>: our AI assistant will walk you through it and answer your questions right away.</p></div>${cards}
  <div class="card"><h2>What next?</h2><div class="btns"><button class="b b1" onclick="ev('interested')">I'm interested - start the AI meeting</button><button class="b b2" onclick="person()">Talk to a person</button><button class="b b2" onclick="trial()">Request a trial account</button><button class="b b3" onclick="ev('later')">Later</button></div><p class="muted" id="msg"></p><p class="muted" id="tmsg"></p><div id="book" class="card" style="display:none;margin-top:12px"></div></div>`;
  const script = `const T=${JSON.stringify(req.params.token)};const PICK=${d.pick ? 'true' : 'false'};function post(k,x){return fetch('/api/crm-public/demo/'+T+'/event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({kind:k},x||{}))}).then(r=>r.json()).catch(()=>({}))}
post('open');document.querySelectorAll('video').forEach(v=>{let sent=false;v.addEventListener('play',()=>{if(!sent){sent=true;post('play',{product:v.dataset.key})}})});
async function ev(k){const m=document.getElementById('msg');let x={};if(k==='interested'&&PICK){const p=[...document.querySelectorAll('.pk:checked')].map(c=>c.value);if(!p.length){m.textContent='Please tick at least one product you need.';return}x={products:p}}const r=await post(k,x);if(k==='interested'&&r.meetUrl){location.href=r.meetUrl;return}m.textContent='Thank you. You can come back to this page any time.'}
${PERSON_JS}`;
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
  const out = await PS.demoEvent(req.params.token, String(b.kind || ''), { product: b.product, products: Array.isArray(b.products) ? b.products.slice(0, 6) : undefined, seconds: Number(b.seconds) || 0 }).catch(() => ({ error: 'failed' }));
  return res.status(out.error ? 400 : 200).json(out);
});

// ---- the AI meeting ----
const LANG_OPTS = Object.entries(PS.LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
router.get('/meet/:token', async (req, res) => {
  const m = await PS.meetingFor(req.params.token).catch(() => null);
  noStore(res);
  if (!m) return expired(res);
  const t = esc(req.params.token);
  const slides = m.products.map((p) => `<div class="card"><h2>${esc(p.name)}</h2>${p.videoFile && PS.videoPathOf(p) ? `<video controls preload="metadata" playsinline src="/api/crm-public/meet/${t}/video/${esc(p.key)}"></video>` : ''}<p>${esc(p.tagline || '')}</p><p>${esc(p.about || '')}</p><ul>${(p.features || []).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>${plansHtml(p) ? `<h2 style="margin-top:12px">Plans</h2>${plansHtml(p)}` : ''}</div>`).join('');
  // the quote builder shown after "Yes, I want to go ahead": a plan per product, how many people, yearly or monthly
  const qrows = m.products.map((p) => { const pl = (p.plans || []).filter((x) => x.name && x.price); if (!pl.length) return ''; return `<div style="margin:8px 0"><b>${esc(p.name)}</b><br><select data-k="${esc(p.key)}" class="qp" style="padding:8px;border-radius:8px;border:1px solid #c9d2e3;margin-top:4px">${pl.map((x) => `<option value="${esc(x.name)}" data-u="${esc(x.unit || '')}">${esc(x.name)} - ${esc(x.price)} ${esc(x.unit || '')}</option>`).join('')}</select> <input type="number" min="1" class="qn" data-k="${esc(p.key)}" placeholder="How many people" style="padding:8px;border-radius:8px;border:1px solid #c9d2e3;width:150px"></div>`; }).join('');
  const body = `<style>.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:860px){.grid{grid-template-columns:1fr}}#log{height:420px;overflow:auto;display:flex;flex-direction:column;gap:8px}.ai,.me{padding:9px 12px;border-radius:12px;max-width:88%;line-height:1.5}.ai{background:#eef3ff;align-self:flex-start}.me{background:#16a34a;color:#fff;align-self:flex-end}.row{display:flex;gap:8px;margin-top:10px}.row input{flex:1;padding:11px;border:1px solid #c9d2e3;border-radius:9px;font-size:15px}</style>
  <div class="card"><h1>Meeting with TeamLink's AI assistant</h1><p class="muted">You are talking to an AI assistant. It answers from TeamLink's product information; anything it cannot confirm, our team will answer. The conversation is saved so our team can follow up.</p>
  <label class="muted">Language: <select id="lang" style="padding:6px;border-radius:8px">${LANG_OPTS}</select></label></div>
  <div class="grid"><div>${slides}</div><div><div class="card"><div id="log"></div><div class="row"><input id="q" placeholder="Type your question…" onkeydown="if(event.key==='Enter')say()"><button class="b b2" id="mic" title="Speak">🎤</button><button class="b b1" onclick="say()">Send</button></div>
  <label class="muted" style="display:block;margin-top:8px"><input type="checkbox" id="voice" checked> Read the answers aloud</label></div>
  <div class="card" id="endcard"><h2>When you are done</h2><div class="btns"><button class="b b1" onclick="end('yes')">Yes, I want to go ahead</button><button class="b b2" onclick="end('later')">I need some time</button><button class="b b3" onclick="end('no')">Not for us right now</button></div>
  <div class="btns"><button class="b b2" onclick="person()">Talk to a person</button><button class="b b2" onclick="trial()">Request a trial account</button></div><p class="muted" id="emsg"></p><p class="muted" id="tmsg"></p><div id="book" class="card" style="display:none;margin-top:12px"></div>
  <div id="quote" style="display:none;margin-top:12px"><h2>Get your price now</h2>${qrows || '<p class="muted">Our team will send you the quote.</p>'}${qrows ? '<label class="muted">Billing: <select id="bill" style="padding:6px;border-radius:8px"><option value="yearly">Yearly</option><option value="monthly">Monthly (10% more)</option></select></label><div class="btns"><button class="b b1" onclick="makeQuote()">Show my quote</button></div><p class="muted" id="qmsg"></p>' : ''}</div></div></div></div>`;
  const script = `const T=${JSON.stringify(req.params.token)};const log=document.getElementById('log');const L=document.getElementById('lang');try{const s=localStorage.getItem('tl-lang');if(s)L.value=s}catch(e){}L.onchange=()=>{try{localStorage.setItem('tl-lang',L.value)}catch(e){}};
function add(who,t){const d=document.createElement('div');d.className=who==='ai'?'ai':'me';d.textContent=t;log.appendChild(d);log.scrollTop=log.scrollHeight}
function voiceFor(l){const vs=(window.speechSynthesis&&speechSynthesis.getVoices())||[];const same=vs.filter(v=>v.lang&&v.lang.replace('_','-').toLowerCase().startsWith(l.slice(0,2)));return same.find(v=>/natural|neural|google|online/i.test(v.name))||same.find(v=>v.lang.replace('_','-')===l)||same[0]||null}
function speak(t){try{if(!document.getElementById('voice').checked||!window.speechSynthesis)return;const u=new SpeechSynthesisUtterance(t);u.lang=L.value;const v=voiceFor(L.value);if(v)u.voice=v;speechSynthesis.cancel();speechSynthesis.speak(u)}catch(e){}}
if(window.speechSynthesis)speechSynthesis.onvoiceschanged=()=>{};
fetch('/api/crm-public/meet/'+T+'/state').then(r=>r.json()).then(s=>{(s.transcript||[]).forEach(x=>add(x.who,x.text));if(s.status!=='Open'){document.getElementById('emsg').textContent='This meeting has ended. Thank you!';if(s.decision==='yes')document.getElementById('quote').style.display='block'}else{const last=(s.transcript||[]).slice(-1)[0];if(last&&last.who==='ai')speak(last.text)}});
let busy=false;async function say(){const i=document.getElementById('q');const t=i.value.trim();if(!t||busy)return;busy=true;i.value='';add('me',t);add('ai','…');
try{const r=await fetch('/api/crm-public/meet/'+T+'/say',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t,lang:L.value})}).then(r=>r.json());log.lastChild.textContent=r.reply||r.error||'Sorry, please try again.';speak(r.reply||'')}catch(e){log.lastChild.textContent='Connection problem - please try again.'}busy=false}
async function end(d){await fetch('/api/crm-public/meet/'+T+'/end',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision:d})}).then(r=>r.json()).catch(()=>({}));document.getElementById('emsg').textContent=d==='yes'?'Thank you! You can see your price right here, or our team will send the proposal shortly.':d==='later'?'No problem - we will check back with you in a few days.':'Thank you for your time. You can reach us any time.';if(d==='yes')document.getElementById('quote').style.display='block'}
async function makeQuote(){const items=[...document.querySelectorAll('.qp')].map(s=>{const n=document.querySelector('.qn[data-k="'+s.dataset.k+'"]');return {key:s.dataset.k,plan:s.value,qty:Number(n&&n.value)||0}});const r=await fetch('/api/crm-public/meet/'+T+'/quote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items,billing:document.getElementById('bill').value})}).then(r=>r.json()).catch(()=>({}));if(r.url){location.href=r.url;return}document.getElementById('qmsg').textContent=r.error||'Please try again.'}
document.querySelectorAll('.qp').forEach(s=>{const f=()=>{const u=(s.selectedOptions[0]||{}).dataset||{};const n=document.querySelector('.qn[data-k="'+s.dataset.k+'"]');if(n)n.style.display=/employee|recruiter|user|seat/i.test(u.u||'')?'':'none'};s.onchange=f;f()});
const SR=window.SpeechRecognition||window.webkitSpeechRecognition;const mic=document.getElementById('mic');if(!SR){mic.style.display='none'}else{mic.onclick=()=>{const r=new SR();r.lang=L.value;r.interimResults=false;mic.textContent='…';r.onresult=e=>{document.getElementById('q').value=e.results[0][0].transcript;say()};r.onend=()=>{mic.textContent='🎤'};r.start()}}
${PERSON_JS}`;
  res.set('Content-Type', 'text/html; charset=utf-8');
  return res.send(shell('AI meeting', body, script));
});
router.get('/meet/:token/video/:key', async (req, res) => {
  const v = PS.readToken(req.params.token, 'meet');
  const key = String(req.params.key).toUpperCase();
  if (!v || !(v.p || []).includes(key)) return res.status(404).end();
  const p = (await PS.products({ all: true }).catch(() => [])).find((x) => x.key === key);
  const file = p && PS.videoPathOf(p);
  if (!file) return res.status(404).end();
  noStore(res);
  return res.sendFile(file, { acceptRanges: true, headers: { 'Content-Type': 'video/mp4' } });
});
router.get('/meet/:token/state', async (req, res) => {
  const m = await PS.meetingFor(req.params.token).catch(() => null);
  noStore(res);
  if (!m) return res.status(404).json({ error: 'This meeting link has expired.' });
  return res.json({ status: m.meeting.status, decision: m.meeting.decision || null, transcript: m.meeting.transcript.map((x) => ({ who: x.who, text: x.text })) });
});
router.post('/meet/:token/say', async (req, res) => {
  const out = await PS.meetingSay(req.params.token, (req.body || {}).text, String((req.body || {}).lang || '')).catch(() => ({ error: 'Sorry - please try again.' }));
  return res.status(out.error ? 400 : 200).json(out);
});
router.post('/meet/:token/end', async (req, res) => {
  const out = await PS.meetingEnd(req.params.token, String((req.body || {}).decision || '')).catch(() => ({ error: 'Sorry - please try again.' }));
  return res.status(out.error ? 400 : 200).json(out);
});

// ---- quote, trial, booking a call (crm/productDeals.js) ----
const PD = require('../crm/productDeals');
router.post('/meet/:token/quote', async (req, res) => {
  const out = await PD.quoteByMeeting(req.params.token, req.body || {}).catch(() => ({ error: 'Sorry - please try again.' }));
  return res.status(out.error ? 400 : 200).json(out);
});
router.post('/trial/:token', async (req, res) => {
  const out = await PD.requestTrial(req.params.token).catch(() => ({ error: 'Sorry - please try again.' }));
  return res.status(out.error ? 400 : 200).json(out);
});
router.get('/slots/:token', async (req, res) => {
  noStore(res);
  const out = await PD.slots(req.params.token).catch(() => ({ error: 'Sorry - please try again.' }));
  return res.status(out.error ? 400 : 200).json(out);
});
router.post('/book/:token', async (req, res) => {
  const out = await PD.book(req.params.token, req.body || {}).catch(() => ({ error: 'Sorry - please try again.' }));
  return res.status(out.error ? 400 : 200).json(out);
});
const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
function quotePage(d, token, words) {
  const q = d.quote;
  const rows = q.items.map((x) => `<tr><td>${esc(x.product)}<div class="muted">${esc(x.plan)} · ${esc(x.price)} ${esc(x.unit || '')}</div></td><td>${x.qtyKind ? `${x.qty} ${esc(x.qtyKind)}` : '-'}</td><td>${x.months === 12 ? '12 months' : 'per month'}</td><td style="text-align:right">${inr(x.amount)}</td></tr>`).join('');
  const pay = d.settings.paymentText || d.settings.paymentLink ? `<div class="card"><h2>How to pay</h2>${d.settings.paymentText ? `<p style="white-space:pre-wrap">${esc(d.settings.paymentText)}</p>` : ''}${d.settings.paymentLink ? `<div class="btns"><a class="b b1" style="text-decoration:none" href="${esc(d.settings.paymentLink)}" target="_blank" rel="noopener">Pay ${inr(q.total)} online</a></div>` : ''}<p class="muted">Please mention ${esc(q.number)} with the payment.</p></div>` : '<div class="card"><h2>Next step</h2><p>Our team will send you the payment details and set up your account.</p></div>';
  const top = `<div class="card"><h1>Quote ${esc(q.number)}</h1><p>${d.lead && d.lead.company ? `For ${esc(d.lead.company)}. ` : ''}Valid till ${esc(d.validTill)}. Prices from TeamLink's price list.</p>
  <table style="width:100%;border-collapse:collapse;margin-top:10px" cellpadding="8"><tr style="background:#f4f6fb"><th align="left">Product</th><th align="left">People</th><th align="left">Billing</th><th align="right">Amount</th></tr>${rows}
  <tr><td colspan="3" align="right">Subtotal</td><td align="right">${inr(q.subtotal)}</td></tr><tr><td colspan="3" align="right">GST 18%</td><td align="right">${inr(q.gst)}</td></tr><tr><td colspan="3" align="right"><b>Total</b></td><td align="right"><b>${inr(q.total)}</b></td></tr></table></div>`;
  if (words !== undefined) return top + words + (q.status === 'Accepted' ? pay : '');
  if (q.status === 'Accepted') return `${top}<div class="card"><p>You accepted this quote. Thank you!</p></div>${pay}`;
  if (q.status === 'Declined') return `${top}<div class="card"><p>This quote was declined. Reply to our message if you would like a new one.</p></div>`;
  if (d.expired) return `${top}<div class="card"><p>This quote has expired. Please ask us for a fresh one.</p></div>`;
  return `${top}<div class="card"><h2>Your decision</h2><form method="post" action="/api/crm-public/quote/${esc(token)}" class="btns"><button class="b b1" name="decision" value="accept">Accept the quote</button><button class="b b3" name="decision" value="decline">Decline</button></form>
  <div class="btns"><button class="b b2" onclick="person()">Talk to a person first</button><button class="b b2" onclick="trial()">Request a trial account</button></div><p class="muted" id="tmsg"></p><div id="book" class="card" style="display:none;margin-top:12px"></div></div>`;
}
router.get('/quote/:token', async (req, res) => {
  const d = await PD.quoteFor(req.params.token).catch(() => null);
  noStore(res);
  if (!d) return expired(res);
  res.set('Content-Type', 'text/html; charset=utf-8');
  return res.send(shell(`Quote ${d.quote.number}`, quotePage(d, req.params.token), `const T=${JSON.stringify(req.params.token)};${PERSON_JS}`));
});
router.post('/quote/:token', express.urlencoded({ extended: false, limit: '2kb' }), async (req, res) => {
  const out = await PD.decideQuote(req.params.token, String((req.body || {}).decision || '')).catch(() => ({ error: 'Sorry - please try again.' }));
  const d = await PD.quoteFor(req.params.token).catch(() => null);
  noStore(res);
  if (!d) return expired(res);
  res.set('Content-Type', 'text/html; charset=utf-8');
  if (out.already) return res.send(shell(`Quote ${d.quote.number}`, quotePage(d, req.params.token), `const T=${JSON.stringify(req.params.token)};${PERSON_JS}`));
  const words = out.error ? `<div class="card"><p>${esc(out.error)}</p></div>` : (out.status === 'Accepted' ? '<div class="card"><h2>Thank you - you have accepted the quote ✓</h2><p>Our team will contact you to set up your account.</p></div>' : '<div class="card"><p>Thank you for letting us know. Our team may call to understand how we can help better.</p></div>');
  return res.status(out.error ? 400 : 200).send(shell(`Quote ${d.quote.number}`, quotePage(d, req.params.token, words), `const T=${JSON.stringify(req.params.token)};${PERSON_JS}`));
});

module.exports = router;

