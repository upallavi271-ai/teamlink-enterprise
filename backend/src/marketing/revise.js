// ---------------------------------------------------------------------------
// AI MARKETING > CLIENT APPROVAL > "THE CLIENT ASKED FOR CHANGES" (2026-11-25). Owner: "when the client requests changes, the changes should be done automatically and the modified picture sent to the
// client again, instantly". This reads the client's words and edits the spec of a banner designed in TeamLink (images.js bannerSpecOf: headline, second line, sub-line, website link, who it is for, tagline,
// colours ...); the banner is then drawn again (images.js reviseBanner) and sent back (clientReview.js autoRevise).
// PLAIN CODE, NO AI SERVICE (free, the same every time, nothing leaves the server): it understands the ordinary requests a client makes of a banner and says exactly what it did:
//   * the website link: on one line (always so now), under the headline, at the bottom;     * text that is an instruction to a designer ("create a premium ... banner") left in the banner: removed;
//   * remove the sub-line / second line / website link / "who it is for" / services / prices / tagline / contact strip / badge / picture;
//   * change "X" to "Y" (the words must be on the banner), "the headline should be Y", "the link should be Y", "write Y instead of X";     * "make it blue" (and green, red, orange, purple ...);
//   * "change the picture" when the picture was chosen by TeamLink from the free stock photos (another one is taken);
//   * (2026-11-27) when the banner's picture was MADE BY THE AI, any request about the picture ("change it", "show a female doctor") asks for a NEW picture that follows the client's words (spec.heroRedo,
//     made by images.js heroPicture); the wording and the logo of the banner are drawn again exactly as they were.
// HONEST BY DESIGN: a clause it does not understand, or one that asks for something this banner cannot do, is NOT guessed at: it is listed as "unclear" so a person can do it, and the client is told
// which part was not done. Nothing is ever changed that the client's words do not name. Up to 3 automatic rounds per banner; then a person takes over (clientReview.js).
// ---------------------------------------------------------------------------
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9ऀ-෿\s]/g, ' ').replace(/\s+/g, ' ').trim();
const wordsOf = (s) => norm(s).split(' ').filter(Boolean);
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const TEXT_FIELDS = [['headline', 'the headline'], ['headline2', 'the second headline line'], ['sub', 'the sub-line'], ['chip', 'the website link'], ['audience', 'the "who it is for" words'], ['audienceTitle', 'the "who it is for" title'], ['tagline', 'the tagline'], ['cta', 'the button'], ['badge', 'the badge'], ['footer', 'the contact strip'], ['companyName', 'the company name'], ['servicesTitle', 'the services title']];
const COLOURS = { blue: '#1d4ed8', navy: '#1e3a8a', green: '#15803d', red: '#b91c1c', orange: '#c2410c', purple: '#6d28d9', violet: '#6d28d9', pink: '#be185d', teal: '#0f766e', maroon: '#7f1d1d', black: '#111827', dark: '#111827', yellow: '#a16207', gold: '#a16207' };
const REMOVE = /\b(remove|delete|take (?:it |this |that )?(?:out|away|off)|get rid of|no need (?:of|for)|(?:do not|don'?t|dont) (?:need|want|show|put|add|use)|not needed|not required|without|hide|drop)\b/i;
const LINKW = /\b(link|website|web ?site|url|web ?address|site address|chip)\b/i;

const quoted = (s) => [...String(s).matchAll(/["“”]([^"“”]{2,160})["“”]|(?:^|\s)['‘]([^'’]{2,160})['’](?=\s|$|[.,;:!?])/g)].map((m) => (m[1] || m[2]).trim());
// ---- requests about the banner's picture ----
const PICW = /\b(?:picture|photo|photograph|image|hero)s?\b/i;
const OTHER_PART = /\b(logo|text|font|words?|head ?line|heading|link|website|prices?|tag ?line|sub ?line|footer|badge|theme)\b/i; // the sentence is about something else on the banner
const PICTURE_WISH = /\b(?:change|replace|different|another|new|other|better|show(?:ing)?|make|should|want|need|add|use|put|keep|include|with|without|remove|delete|more|less|instead|smil\w*)\b/i;
// "remove the picture" / "the picture is not needed" -> the picture itself goes; "remove the mask from the picture" is a change INSIDE the picture
const DROP_PICTURE = /\b(?:remove|delete|take (?:out|off|away)|get rid of|no need (?:of|for)|(?:do not|don'?t|dont) (?:need|want|show|put|add|use)|without|hide|drop)\s+(?:the\s+|this\s+|that\s+|a\s+|any\s+)?(?:(?:main|hero|big|stock)\s+)?(?:picture|photo|photograph|image|hero)s?\b(?!\s+(?:of|with|showing)\b)|\b(?:picture|photo|photograph|image|hero)s?\b[^.]{0,20}\b(?:not needed|not required|(?:to be|should be) removed)\b/i;
// does the sentence contain a run of at least `min` consecutive words of `value` (or all of it when it is shorter)?
function mentions(sentence, value, min = 3) {
  const v = wordsOf(value); if (!v.length) return false; const s = ` ${wordsOf(sentence).join(' ')} `; const need = Math.min(min, v.length);
  for (let len = v.length; len >= need; len -= 1) for (let i = 0; i + len <= v.length; i += 1) if (s.includes(` ${v.slice(i, i + len).join(' ')} `)) return true;
  return false;
}
const looksLikePrompt = (t) => /^\s*(please\s+)?(create|make|design|generate|build|prepare|draw|write|produce)\b[^.]{0,80}\b(banner|poster|post|image|picture|design|creative|flyer|graphic|ad)\b/i.test(String(t || ''));
function setCase(found, y) { return /^[A-Z]/.test(found) && /^[a-z]/.test(y) ? y[0].toUpperCase() + y.slice(1) : y; }
function cleanY(y) { return clip(String(y || '').replace(/^[\s"“”'‘’]+|[\s"“”'‘’.,;!]+$/g, ''), 100); }

// -> { spec (the changed copy), changes: [{ key, text }], unclear: [sentence], summary: [text] }
function interpret(spec, feedback) {
  const next = JSON.parse(JSON.stringify(spec || {})); const changes = []; const unclear = [];
  const say = (key, text) => { if (!changes.some((c) => c.key === key && c.text === text)) changes.push({ key, text }); };
  const sentences = String(feedback || '').replace(/\r/g, '\n').split(/(?<=[.!?])\s+|\n+|;\s+/).map((x) => x.trim()).filter((x) => x.length >= 3);
  for (const raw of sentences) {
    const t = raw.toLowerCase(); let hit = false; const before = changes.length; let blocked = '';
    // ---- the website link ----
    if (LINKW.test(t) && !REMOVE.test(t)) {
      const hasChip = !!next.chip && next.layout === 'showcase';
      const under = /\b(?:under|below|beneath)\b\s*(?:the\s+)?(?:line\s+|heading\s+|headline\s+|title\s+)?(.*)$/i.exec(raw);
      if (under) {
        const x = norm(under[1]); const head = `${norm(next.headline)} ${norm(next.headline2)}`.trim(); const xs = x.split(' ').filter(Boolean);
        const isHeading = !x || /^(?:the\s+)?(?:head ?line|heading|title|main line|first line|big line|top line)\b/.test(x) || (xs.length >= 2 && xs.filter((w) => head.split(' ').includes(w)).length >= Math.ceil(xs.length * 0.6));
        if (!hasChip) blocked = 'this banner has no website link to move'; else if (isHeading) { if (next.chipPos !== 'under-headline') { next.chipPos = 'under-headline'; say('chipPos', 'The website link now sits right under the headline.'); } else say('chipPos', 'The website link sits right under the headline.'); hit = true; }
      } else if (/\b(?:bottom|footer|down|end|last)\b/i.test(t) && hasChip && /\b(?:at|in|to|on|back)\b/i.test(t)) { next.chipPos = 'bottom'; say('chipPos', 'The website link is at the bottom.'); hit = true; }
      if (/\b(?:one|single|1)\s*line\b|\bin a line\b|\bnot (?:in )?(?:two|2|more than one|multiple)\s*lines?\b|\bnot (?:to )?break|\b(?:do not|don'?t|dont) break|\bstraight line\b/i.test(t)) { if (hasChip) { say('chipOneLine', 'The website link is on one line.'); hit = true; } else if (!blocked) blocked = 'this banner has no website link'; }
      const setTo = /\b(?:should be|must be|to be|change(?:d)? (?:it )?to|is)\b\s*["“']?([a-z0-9][a-z0-9.\-/:_]+\.[a-z]{2,}[a-z0-9/._\-]*)["”']?\s*$/i.exec(raw);
      if (setTo && next.layout === 'showcase') { next.chip = clip(setTo[1], 40); say('chip', `The website link now reads "${next.chip}".`); hit = true; }
    }
    // ---- text that is an instruction (a prompt) or that the client asked to remove ----
    if (next.sub) {
      const promptWord = /\b(prompt|instruction)s?\b/i.test(t); const named = mentions(raw, next.sub, 3);
      if ((promptWord && (named || looksLikePrompt(next.sub))) || (named && REMOVE.test(t)) || (promptWord && /\b(sub ?line|paragraph|text|line)\b/i.test(t) && looksLikePrompt(next.sub))) { say('sub', `Removed the text "${clip(next.sub, 36)}${next.sub.length > 36 ? '…' : ''}" (it was not wording for the banner).`); next.sub = ''; hit = true; }
    }
    if (REMOVE.test(t)) {
      const rm = (key, label, apply) => { apply(); say(key, `Removed ${label}.`); hit = true; };
      if (/\b(?:prices?|pricing|price cards?|plans?|rates?)\b/.test(t) && (next.plans || []).length) rm('plans', 'the price cards', () => { next.plans = []; });
      if (/\bservices?\b/.test(t) && (next.services || []).length) rm('services', 'the services', () => { next.services = []; next.servicesTitle = ''; });
      if (/\b(?:who it is for|audience|target customers?|target)\b/.test(t) && (next.audience || next.audienceTitle)) rm('audience', 'the "who it is for" part', () => { next.audience = ''; next.audienceTitle = ''; });
      if (/\b(?:badge|offer circle)\b/.test(t) && next.badge) rm('badge', 'the badge', () => { next.badge = ''; });
      if (/\b(?:tag ?line)\b/.test(t) && next.tagline) rm('tagline', 'the tagline', () => { next.tagline = ''; });
      if (/\b(?:contact strip|footer|contact (?:details|line|info))\b/.test(t) && next.footer) rm('footer', 'the contact strip', () => { next.footer = ''; });
      if (LINKW.test(t) && next.chip) rm('chip', 'the website link', () => { next.chip = ''; });
      if (/\b(?:sub ?line|sub ?heading|small text|paragraph|description|second line of text)\b/.test(t) && next.sub) rm('sub', 'the sub-line', () => { next.sub = ''; });
      if (/\b(?:second line|2nd line|coloured line|colored line)\b/.test(t) && next.headline2) rm('headline2', 'the second headline line', () => { next.headline2 = ''; });
      if (DROP_PICTURE.test(t) && (next.photoItemId || next.heroSearch)) rm('photo', 'the picture', () => { next.photoItemId = ''; next.heroSearch = ''; next.heroFile = ''; next.heroAi = false; delete next.heroRedo; });
      const qs = quoted(raw); for (const q of qs) for (const [k] of TEXT_FIELDS) if (next[k] && norm(next[k]) === norm(q)) { rm(k, `"${clip(q, 40)}"`, () => { next[k] = ''; }); }
    }
    // ---- change X to Y, the headline should be Y ----
    const field = /\b(head ?line|heading|main line|first line|big line)\b[^.]{0,40}?\b(?:should be|must be|to be|change(?:d)? (?:it )?to|as|is|:)\s*["“']?(.{2,90}?)["”']?\s*$/i.exec(raw);
    const f2 = /\b(second line|2nd line|coloured line|colored line)\b[^.]{0,40}?\b(?:should be|must be|to be|change(?:d)? (?:it )?to|as|is|:)\s*["“']?(.{2,60}?)["”']?\s*$/i.exec(raw);
    const f3 = /\b(sub ?line|sub ?heading|small text)\b[^.]{0,40}?\b(?:should be|must be|to be|change(?:d)? (?:it )?to|as|is|:)\s*["“']?(.{2,160}?)["”']?\s*$/i.exec(raw);
    const f4 = /\btag ?line\b[^.]{0,40}?\b(?:should be|must be|to be|change(?:d)? (?:it )?to|as|is|:)\s*["“']?(.{2,60}?)["”']?\s*$/i.exec(raw);
    for (const [m, key, label, n] of [[field, 'headline', 'The headline', 90], [f2, 'headline2', 'The second headline line', 60], [f3, 'sub', 'The sub-line', 160], [f4, 'tagline', 'The tagline', 60]]) {
      if (m && cleanY(m[2]).length >= 2 && !changes.some((c) => c.key === key)) { next[key] = cleanY(m[2]).slice(0, n); say(key, `${label} now reads "${next[key]}".`); hit = true; }
    }
    if (!changes.length || changes.length === before) {
      const pairs = []; let m;
      if ((m = /\binstead of\s+["“']?(.{2,80}?)["”']?\s*$/i.exec(raw))) { const y = /^(.{2,100}?)\s+instead of\b/i.exec(raw); if (y) pairs.push([m[1], y[1].replace(/^(?:please\s+)?(?:write|use|put|make it|keep|add)\s+/i, '')]); }
      if ((m = /\b(?:change|replace|edit|correct|update|write|put|make|use|set)\s+(?:the\s+)?(?:(?:word|text|name|line)\s+)?["“']?(.{2,80}?)["”']?\s+(?:to|with|as|into|by)\s+["“']?(.{2,100}?)["”']?\s*$/i.exec(raw))) pairs.push([m[1], m[2]]);
      if ((m = /["“']?(.{2,80}?)["”']?\s+(?:should be|must be|has to be|needs to be|is wrong[, ]+(?:it )?should be)\s+["“']?(.{2,100}?)["”']?\s*$/i.exec(raw))) pairs.push([m[1], m[2]]);
      for (const [xRaw, yRaw] of pairs) {
        const x = cleanY(xRaw); const y = cleanY(yRaw); if (x.length < 2 || y.length < 1) continue;
        const re = new RegExp(x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); let done = false;
        for (const [k] of TEXT_FIELDS) { if (next[k] && re.test(next[k]) && norm(x) !== norm(y)) { next[k] = clip(next[k].replace(re, (found) => setCase(found, y)), 200); say(k, `Changed "${x}" to "${y}".`); done = true; hit = true; break; } }
        if (!done) for (const key of ['services']) { const arr = next[key] || []; const i = arr.findIndex((s) => re.test(s)); if (i >= 0) { arr[i] = clip(arr[i].replace(re, (found) => setCase(found, y)), 40); say(key, `Changed "${x}" to "${y}".`); done = true; hit = true; } }
        if (done) break;
      }
    }
    // ---- colour, picture ----
    const aboutPicture = PICW.test(t) && !OTHER_PART.test(t) && !DROP_PICTURE.test(t);
    const redo = !!next.heroAi && aboutPicture && PICTURE_WISH.test(t); // the AI made this picture: a new one is made, following the sentence
    const col = /\b(blue|navy|green|red|orange|purple|violet|pink|teal|maroon|black|dark|yellow|gold)\b/i.exec(t);
    if (!redo && col && /\b(make|use|change|set|want|colou?r|theme|background)\b/i.test(t) && !/\b(text|font|words?|letters?)\b/i.test(t) && !REMOVE.test(t)) { const name = col[1].toLowerCase(); next.colors = { ...(next.colors || {}), primary: COLOURS[name] }; say('colors', `Changed the main colour to ${name}.`); hit = true; }
    if (redo) {
      next.heroRedo = clip([next.heroRedo, raw].filter(Boolean).join(' '), 300); if (!changes.some((c) => c.key === 'photo')) say('photo', 'Made a new picture the way you described.'); hit = true;
    } else if (/\b(change|replace|different|another|new|other)\b/i.test(t) && PICW.test(t) && !REMOVE.test(t)) {
      if (next.heroSearch) { next.heroN = ((Number(next.heroN) || 0) + 1) % 20; next.heroFile = ''; say('photo', 'Chose another picture.'); hit = true; } else if (!blocked) blocked = 'the picture was chosen by a person, so it has to be changed by hand';
    }
    if (!hit || changes.length === before) unclear.push(blocked ? `${raw} (${blocked})` : raw);
  }
  return { spec: next, changes, unclear, summary: changes.map((c) => c.text) };
}

// the words sent to the client with the new picture (at most 400 characters): what was done, and what was not
function clientNote(out) {
  const done = out.summary.join(' '); const left = out.unclear.length ? ` We could not do this part yet: "${clip(out.unclear.join(' / '), 120)}". Our team will look at it.` : '';
  return clip(`We have made the changes you asked for. ${done}${left} Please look at it again.`, 400);
}

// ---- a correction, or a completely NEW design? ----------------------------------------------------------------------------------------------------------------------------------------
const NEW_DESIGN = /\b(?:completely|totally|entirely|fully)\s+(?:new|different)\b|\b(?:new|different|another|fresh)\s+(?:design|banner|layout|creative|poster|concept|template)\b|\b(?:redo|re-?do|re-?design|start (?:again|over|from scratch)|from scratch|scrap (?:it|this)|(?:do not|don'?t|dont) like (?:it|this|anything)|change everything|everything (?:is )?wrong)\b/i;
const classify = (feedback) => (NEW_DESIGN.test(String(feedback || '')) ? 'new_design' : 'correction');
const PALETTE = ['#1d4ed8', '#0f766e', '#6d28d9', '#b91c1c', '#15803d', '#c2410c'];
// a new design keeps the WORDS and changes the look: another colour, the next stock picture, the link in the other place
function variation(spec) {
  const next = JSON.parse(JSON.stringify(spec || {})); const cur = String((next.colors && next.colors.primary) || '').toLowerCase();
  const pick = PALETTE.find((c, i) => c !== cur && PALETTE.indexOf(cur) < i) || PALETTE.find((c) => c !== cur);
  next.colors = { ...(next.colors || {}), primary: pick }; const text = [`Changed the colours to a new look.`];
  if (next.heroAi) { next.heroRedo = 'a completely different picture: another scene, another angle'; text.push('Made a new picture.'); }
  else if (next.heroSearch) { next.heroN = ((Number(next.heroN) || 0) + 1) % 20; next.heroFile = ''; text.push('Chose another picture.'); }
  if (next.chip && next.layout === 'showcase') { next.chipPos = next.chipPos === 'under-headline' ? 'bottom' : 'under-headline'; text.push('Moved the website link.'); }
  return { spec: next, changes: [{ key: 'newDesign', text: `Made a new design with the same words: ${text.join(' ')}` }], unclear: [], summary: [`Made a new design with the same words: ${text.join(' ')}`] };
}

// ---- the AI reads what the plain rules did not understand ----------------------------------------------------------------------------------------------------------------------------
// Asked ONLY when the rules left something unclear (no call otherwise). The AI answers JSON; EVERYTHING it says is checked here: only the fields below, only short plain text, never an instruction to a
// designer, and a confidence under 0.6 is ignored. So the AI can only change what the banner has, in the ways listed, and the client is told what was done.
const AI_TEXT = { headline: 90, headline2: 60, sub: 160, chip: 40, audience: 200, audienceTitle: 40, tagline: 60, cta: 28, badge: 18, footer: 90, companyName: 60, servicesTitle: 50 };
const AI_SYSTEM = `You change a designed marketing banner when a client asks for corrections. You are given the banner's fields (JSON) and what the client wrote. Answer ONLY with JSON: {"classification":"correction"|"new_design","confidence":0 to 1,"changes":[{"field":"<field>","action":"set"|"clear"|"next","value":"<new text>"}],"unclear":["<a part of the request you could not do>"]}. Allowed fields: ${Object.keys(AI_TEXT).join(', ')}, chipPos (value "under-headline" or "bottom"), colorPrimary (a colour name or #rrggbb), services (value: a list of up to 8 short texts), plans (action "clear" only), photo (action "next" for another picture or "clear"). Change ONLY what the client names; keep everything else. Never write an instruction to a designer as banner text. Do not invent facts, prices or contact details: if the client gives none, leave it unclear.`;
const aiRequest = (spec, text) => ({ system: AI_SYSTEM, prompt: JSON.stringify({ banner: Object.fromEntries([...Object.keys(AI_TEXT), 'chipPos', 'services', 'layout'].filter((k) => spec[k] != null && spec[k] !== '' && !(Array.isArray(spec[k]) && !spec[k].length)).map((k) => [k, spec[k]])), client_wrote: String(text || '').slice(0, 800) }) });
function applyAi(spec, ans) {
  const out = { spec: JSON.parse(JSON.stringify(spec || {})), changes: [], unclear: [], confidence: 0, classification: 'correction' };
  if (!ans || typeof ans !== 'object') return out;
  out.confidence = Math.max(0, Math.min(1, Number(ans.confidence) || 0)); out.classification = ans.classification === 'new_design' ? 'new_design' : 'correction';
  out.unclear = (Array.isArray(ans.unclear) ? ans.unclear : []).map((x) => clip(String(x).replace(/[<>]/g, ''), 160)).filter(Boolean).slice(0, 4);
  const plain = (v, n) => clip(String(v == null ? '' : v).replace(/<[^>]*>/g, '').replace(/[<>{}]/g, ''), n);
  for (const c of (Array.isArray(ans.changes) ? ans.changes : []).slice(0, 8)) {
    if (!c || typeof c !== 'object') continue; const f = String(c.field || ''); const act = String(c.action || 'set');
    if (AI_TEXT[f]) {
      if (act === 'clear') { if (out.spec[f]) { out.spec[f] = ''; out.changes.push({ key: f, text: `Removed ${(TEXT_FIELDS.find(([k]) => k === f) || [f, f])[1]}.` }); } } else if (act === 'set') { const v = plain(c.value, AI_TEXT[f]); if (v.length >= 2 && !looksLikePrompt(v) && v !== out.spec[f]) { out.spec[f] = v; out.changes.push({ key: f, text: `${(TEXT_FIELDS.find(([k]) => k === f) || [f, f])[1][0].toUpperCase()}${(TEXT_FIELDS.find(([k]) => k === f) || [f, f])[1].slice(1)} now reads "${v}".` }); } }
    } else if (f === 'chipPos' && out.spec.chip && out.spec.layout === 'showcase' && ['under-headline', 'bottom'].includes(c.value) && out.spec.chipPos !== c.value) { out.spec.chipPos = c.value; out.changes.push({ key: 'chipPos', text: c.value === 'bottom' ? 'The website link is at the bottom.' : 'The website link now sits right under the headline.' }); }
    else if (f === 'colorPrimary') { const hex = /^#[0-9a-f]{6}$/i.test(String(c.value)) ? String(c.value) : COLOURS[String(c.value).toLowerCase()]; if (hex) { out.spec.colors = { ...(out.spec.colors || {}), primary: hex }; out.changes.push({ key: 'colors', text: `Changed the main colour to ${/^#/.test(String(c.value)) ? hex : String(c.value).toLowerCase()}.` }); } }
    else if (f === 'services' && Array.isArray(c.value)) { const list = c.value.map((x) => plain(x, 40)).filter((x) => x.length >= 2 && !looksLikePrompt(x)).slice(0, 8); if (list.length) { out.spec.services = list; out.changes.push({ key: 'services', text: 'Changed the services list.' }); } }
    else if (f === 'plans' && act === 'clear' && (out.spec.plans || []).length) { out.spec.plans = []; out.changes.push({ key: 'plans', text: 'Removed the price cards.' }); }
    else if (f === 'photo' && (act === 'next' || act === 'set') && out.spec.heroAi) { out.spec.heroRedo = plain(c.value, 240) || 'a different picture'; out.changes.push({ key: 'photo', text: 'Made a new picture the way you described.' }); }
    else if (f === 'photo' && act === 'next' && out.spec.heroSearch) { out.spec.heroN = ((Number(out.spec.heroN) || 0) + 1) % 20; out.spec.heroFile = ''; out.changes.push({ key: 'photo', text: 'Chose another picture.' }); }
    else if (f === 'photo' && act === 'clear' && (out.spec.photoItemId || out.spec.heroSearch)) { out.spec.photoItemId = ''; out.spec.heroSearch = ''; out.spec.heroFile = ''; out.changes.push({ key: 'photo', text: 'Removed the picture.' }); }
  }
  return out;
}
// rules first (free, the same every time); the AI only for what they left unclear, when opts.ask is given (a function: ({system, prompt}) -> the AI's JSON answer, or throws when no AI is ready).
// -> { spec, changes, unclear, summary, method: 'rules' | 'ai' | 'rules+ai', classification, confidence }
async function understand(spec, feedback, opts = {}) {
  const classification = classify(feedback);
  if (classification === 'new_design') return { ...variation(spec), method: 'rules', classification, confidence: 0.8 };
  const rules = interpret(spec, feedback);
  const base = { ...rules, method: 'rules', classification, confidence: !rules.changes.length ? 0 : (rules.unclear.length ? 0.7 : 1) };
  if (!opts.ask || (rules.changes.length && !rules.unclear.length)) return base;
  try {
    const ans = await opts.ask(aiRequest(rules.spec, rules.unclear.length ? rules.unclear.join(' ') : feedback));
    const ai = applyAi(rules.spec, ans);
    if (ai.classification === 'new_design' && ai.confidence >= 0.6) return { ...variation(spec), method: 'ai', classification: 'new_design', confidence: ai.confidence };
    if (ai.confidence >= 0.6 && ai.changes.length) { const changes = [...rules.changes, ...ai.changes]; return { spec: ai.spec, changes, unclear: ai.unclear, summary: changes.map((c) => c.text), method: rules.changes.length ? 'rules+ai' : 'ai', classification, confidence: Math.min(base.confidence || 1, ai.confidence) }; }
  } catch { /* no AI is ready (or it failed): the rules' answer stands */ }
  return base;
}

// ---- the LOGO on a picture that is not a banner (2026-11-25): "the logo is too short and it is right bottom placed, keep it top left and some bigger" -> images.js changeLogo (plain code, no AI model). -----------------
// -> { pos ('top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | ''), factor (times the size it has now), add, rest: [sentences that are NOT about the logo, left for a person] } | null when the words do not
// ask for anything about the logo that this can do (taking the logo off is not done here either).
const LOGOW = /\b(?:logo|brand ?mark)s?\b/i;
const POSITIONS = [['top-left', '(?:top|upper)\\s*[- ]?\\s*left|left\\s*[- ]?\\s*(?:top|upper)'], ['top-right', '(?:top|upper)\\s*[- ]?\\s*right|right\\s*[- ]?\\s*(?:top|upper)'], ['bottom-left', '(?:bottom|lower)\\s*[- ]?\\s*left|left\\s*[- ]?\\s*(?:bottom|lower)'], ['bottom-right', '(?:bottom|lower)\\s*[- ]?\\s*right|right\\s*[- ]?\\s*(?:bottom|lower)']];
const posRe = (src) => new RegExp(`\\b(?:${src})\\b`, 'gi');
const BIGGER = /\b(?:bigger|larger|enlarge[ds]?|increase[ds]?|more visible|too (?:small|short|tiny|little|low)|(?:is|are|looks?|seems?) (?:very |so |too |really )?(?:small|short|tiny))\b/i;
const SMALLER = /\b(?:smaller|reduce[ds]?|decrease[ds]?|shrink|too (?:big|large|huge)|less prominent)\b/i;
const MUCH = /\b(?:much|very|lot|double|twice|huge|far)\b/i;
// the place the client WANTS: not one described as where it is now ("it is right bottom"), not one it must leave ("from the bottom right", "instead of ...", "not ...")
function logoTarget(text) {
  const hits = [];
  for (const [key, src] of POSITIONS) { const re = posRe(src); let m = re.exec(text); while (m) { hits.push({ key, i: m.index }); m = re.exec(text); } }
  hits.sort((a, b) => a.i - b.i);
  const keep = hits.filter((h) => {
    const before = text.slice(Math.max(0, h.i - 28), h.i);
    if (/\b(?:instead of|rather than|other than|away from|from|not|off)\s+(?:the\s+)?$/i.test(before)) return false; // a place to leave
    const directive = /\b(?:keep|move|put|place|shift|set|bring|should|must|want|need|make|to)\b[^.,;]{0,24}$/i.test(before);
    const state = /\b(?:is|are|was|now|currently|placed|located|present|sitting|showing|stuck)\b[^.,;]{0,24}$/i.test(before);
    return directive || !state;
  });
  return keep.length ? keep[keep.length - 1].key : '';
}
function logoRequest(text) {
  const raw = String(text || '').trim(); if (!LOGOW.test(raw)) return null;
  if (/\b(?:remove|delete|hide|take (?:it )?(?:out|off|away)|get rid of|without|(?:do not|don'?t|dont) (?:need|want|show|put)|no need)\b[^.]{0,30}\blogo|\blogo\b[^.]{0,30}\b(?:not needed|not required|remove|delete)/i.test(raw)) return null;
  const pos = logoTarget(raw);
  let factor = 1; if (BIGGER.test(raw)) factor = MUCH.test(raw) ? 1.8 : 1.4; else if (SMALLER.test(raw)) factor = 0.75;
  const add = /\b(?:add|put|place|include|insert)\b[^.]{0,30}\blogo\b|\blogo\b[^.]{0,30}\b(?:missing|not (?:there|shown|visible|present)|absent)\b|\bno logo\b/i.test(raw);
  if (!pos && factor === 1 && !add) return null;
  const sentences = raw.replace(/\r/g, '\n').split(/(?<=[.!?])\s+|\n+|;\s+/).map((s) => s.trim()).filter((s) => s.length >= 3);
  const rest = []; let prev = false; // sentences that carry on about the logo ("Move it to the top left.") belong to it; the others are left for a person
  for (const s of sentences) { const rel = LOGOW.test(s) || (prev && (POSITIONS.some(([, src]) => posRe(src).test(s)) || BIGGER.test(s) || SMALLER.test(s))); prev = rel; if (!rel) rest.push(clip(s, 160)); }
  return { pos, factor, add, rest };
}

module.exports = { interpret, understand, classify, variation, applyAi, aiRequest, clientNote, mentions, looksLikePrompt, logoRequest, COLOURS };
