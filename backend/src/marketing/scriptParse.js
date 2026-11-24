// ---------------------------------------------------------------------------
// AI MARKETING > a SCRIPT pasted as CONTENT, and no quotation marks (2026-11-24).
// Owner: "the videos are giving quotation marks, and they keep pictures as the video: it should be real video clips". People paste a script written elsewhere (ChatGPT, Gemini) into the
// CONTENT box:  **Scene 1 – Introduction (0–5 sec)** / Visual: a doctor in a clinic / Voiceover: "Is your skin troubling you?"  Until now every line of it was painted on a picture (the labels,
// the asterisks and the quotation marks included). Now:
//   parseScript(content)  reads it scene by scene: the VOICEOVER is what is said (and the short title on the screen), the VISUAL describes the picture and finds the real stock footage, a
//                         "Text on screen" line is the title if there is one. Not a script (fewer than two "Scene N" headings) -> null, and the content is used line by line as before.
//   plain(text)           markdown marks and quotation marks removed (apostrophes stay): used on every scene title and spoken line, the AI's and the person's.
// ---------------------------------------------------------------------------
const SCENE = /^\s*(?:scene|shot|slide)\s*\d+\b.*$/i;
const LABEL = /^\s*(visual|video|shot|b-?\s?roll|background|footage|voice\s*-?\s*over|vo|narration|narrator|presenter|dialogue|audio|say|text\s+on\s+screen|on-?\s?screen\s+text|caption|title|text|super)\s*[:\-–—]\s*(.*)$/i;
const FIELD = (name) => {
  const n = name.toLowerCase().replace(/[\s-]+/g, '');
  if (/^(visual|video|shot|broll|background|footage)$/.test(n)) return 'visual';
  if (/^(voiceover|vo|narration|narrator|presenter|dialogue|audio|say)$/.test(n)) return 'say';
  return 'text';
};
const STOP = new Set(['with', 'that', 'this', 'from', 'into', 'their', 'while', 'where', 'about', 'showing', 'shows', 'show', 'scene', 'shot', 'then', 'there', 'being', 'very', 'over', 'under', 'next', 'close', 'closeup', 'wide', 'view', 'screen', 'camera']);

// markdown marks and quotation marks removed; apostrophes stay (single quotes only when they wrap the whole text)
const plain = (t) => {
  let s = String(t == null ? '' : t).replace(/\*\*|__|`/g, '').replace(/^\s*#+\s*/gm, '').replace(/\s+/g, ' ').trim();
  s = s.replace(/["“”„«»]/g, '').replace(/\s+/g, ' ').trim();
  return s.replace(/^[‘'’]+|[‘'’]+$/g, '').trim();
};
const firstSentence = (s) => { const m = /^(.+?[.!?])(?:\s|$)/.exec(s); return (m ? m[1] : s).trim(); };
const cut = (s, n) => { if (s.length <= n) return s; const c = s.slice(0, n); const i = c.lastIndexOf(' '); return (i > n * 0.5 ? c.slice(0, i) : c).replace(/[,;:\s-]+$/, ''); };
// two to four plain English words from the visual, to look for real footage with
const searchFrom = (visual) => visual.replace(/[^A-Za-z ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w.toLowerCase())).slice(0, 4).join(' ');

function parseScript(content) {
  const lines = String(content || '').replace(/\r/g, '').replace(/\*\*|__/g, '').split('\n');
  const blocks = []; let cur = null; let field = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (SCENE.test(line)) { cur = { head: line, visual: '', say: '', text: '' }; blocks.push(cur); field = ''; continue; }
    if (!cur) continue;
    const m = LABEL.exec(line);
    if (m) { field = FIELD(m[1]); cur[field] = `${cur[field]} ${m[2]}`.trim(); continue; }
    if (field) cur[field] = `${cur[field]} ${line}`.trim(); // the voice-over often starts on the next line
  }
  if (blocks.length < 2) return null;
  const scenes = blocks.map((b) => {
    const say = plain(b.say); const text = plain(b.text); const visual = plain(b.visual);
    const caption = cut(text || firstSentence(say) || plain(b.head.replace(/^\s*(?:scene|shot|slide)\s*\d+\s*[-–—:.]?\s*/i, '').replace(/\([^)]*\)/g, '')), 80); // 80 = the studio's own limit for a scene title: a title is not cut in the middle of a sentence ("...connects freshers with growing" live 24 Nov)
    return { caption, say: say.slice(0, 420), imagePrompt: (visual || caption || 'A friendly scene').slice(0, 400), search: searchFrom(visual) || searchFrom(caption) || 'office team' };
  }).filter((s) => s.say || s.caption).slice(0, 8);
  return scenes.length >= 2 ? scenes : null;
}

// the AI's own scene titles and spoken lines carry no quotation marks either
function tidyScenes(p) {
  if (p && Array.isArray(p.scenes)) p.scenes.forEach((s) => { s.caption = plain(s.caption); s.say = plain(s.say); });
  return p;
}

module.exports = { parseScript, plain, tidyScenes };
