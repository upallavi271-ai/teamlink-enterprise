// ---------------------------------------------------------------------------
// THE FILLER. Runs INSIDE the page (page.evaluate), so it must not use anything outside itself.
//
// It reads each box on the page the way a person does - by the words next to it (label, placeholder, name) - and types the saved
// requirement into the matching box. Rules, on purpose:
//   * only EMPTY boxes are filled; nothing is ever overwritten, deleted or submitted;
//   * never a password, e-mail, phone, search, captcha, file or hidden box; no button is ever pressed;
//   * a drop-down is chosen only when one of its options clearly matches;
//   * what it did not recognise is listed, so the person fills it with the Copy buttons in TeamLink.
// fields: [{ label: 'Job title', value: '...' }, ...]   (the labels TeamLink uses: Job title, Location, Experience, Skills, ...)
// returns { filled: [labels], left: [labels] }
// ---------------------------------------------------------------------------
export function fillInPage(fields) {
  const WORDS = {
    'Job title': ['job title', 'designation', 'position title', 'role title', 'title', 'role', 'position'],
    'Job description': ['job description', 'about the job', 'job details', 'description', 'jd'],
    Responsibilities: ['responsibilit', 'roles and resp', 'duties'],
    Location: ['job location', 'work location', 'location', 'city'],
    Experience: ['work experience', 'years of exp', 'experience', 'exp'],
    Skills: ['key skills', 'skills required', 'skills', 'skill'],
    'Good to have skills': ['good to have', 'preferred skills', 'nice to have'],
    Education: ['education', 'qualification'],
    Qualifications: ['qualification'],
    'Salary range': ['salary', 'ctc', 'compensation', 'pay'],
    Openings: ['vacanc', 'openings', 'no. of positions', 'number of positions', 'positions'],
    'Employment type': ['employment type', 'job type', 'type of job'],
    'Work mode': ['work mode', 'work from', 'remote', 'work type'],
    'How to apply': ['apply link', 'application url', 'apply url', 'apply'],
  };
  const BLOCK = /(search|password|e-?mail|phone|mobile|captcha|otp|company|organi[sz]ation|first name|last name|username|login|coupon|zip|pin ?code)/;
  const norm = (s) => String(s || '').toLowerCase().replace(/[*:_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const visible = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 4 && r.height > 4 && st.visibility !== 'hidden' && st.display !== 'none'; };
  const textOf = (el) => (el ? norm(el.textContent) : '');

  // the box's OWN words: its label, placeholder, name ...
  function ownHint(el) {
    const parts = [];
    parts.push(el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('title'), el.getAttribute('data-testid'));
    const by = el.getAttribute('aria-labelledby');
    if (by) by.split(/\s+/).forEach((id) => parts.push(textOf(document.getElementById(id))));
    if (el.labels) Array.from(el.labels).forEach((l) => parts.push(textOf(l)));
    const wrap = el.closest('label');
    if (wrap) parts.push(textOf(wrap).slice(0, 80));
    return norm(parts.filter(Boolean).join(' | '));
  }
  // the text right above / left of the box: ONLY used when the box's own words say nothing we know
  function nearHint(el) {
    const parts = [];
    let node = el;
    for (let up = 0; up < 2 && node; up += 1) {
      const sib = node.previousElementSibling;
      if (sib) { const t = textOf(sib); if (t && t.length < 90) parts.push(t); }
      node = node.parentElement;
    }
    return norm(parts.join(' | '));
  }
  const allWords = Object.values(WORDS).flat();

  const controls = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"], [role="textbox"]')).filter((el) => {
    if (!visible(el)) return false;
    if (el.disabled || el.readOnly) return false;
    if (el.tagName === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (!['text', 'number', 'url', ''].includes(t)) return false;
    }
    return true;
  }).map((el) => {
    const own = ownHint(el);
    const hint = allWords.some((w) => own.includes(w)) ? own : norm(own + ' | ' + nearHint(el));
    return { el, hint };
  }).filter((c) => !BLOCK.test(c.hint));

  const isEmpty = (el) => {
    if (el.tagName === 'SELECT') return !el.value || el.selectedIndex <= 0;
    if (el.isContentEditable) return !(el.textContent || '').trim();
    return !String(el.value || '').trim();
  };
  function setValue(el, value) {
    el.focus();
    if (el.tagName === 'SELECT') {
      const want = norm(value);
      const opt = Array.from(el.options).find((o) => norm(o.textContent) === want)
        || Array.from(el.options).find((o) => want && norm(o.textContent).includes(want))
        || Array.from(el.options).find((o) => want && want.includes(norm(o.textContent)) && norm(o.textContent).length > 2);
      if (!opt) return false;
      el.value = opt.value;
    } else if (el.isContentEditable) {
      try { document.execCommand('selectAll', false, null); document.execCommand('insertText', false, value); } catch (e) { el.textContent = value; }
    } else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    el.style.outline = '2px solid #1fa855';
    return true;
  }

  const used = new Set();
  const filled = [];
  const left = [];
  // the longest texts first, so the description does not take the title box
  const order = [...fields].sort((a, b) => String(b.value).length - String(a.value).length);
  order.forEach((f) => {
    const words = WORDS[f.label];
    if (!words || !String(f.value || '').trim()) { left.push(f.label); return; }
    const longText = String(f.value).length > 160 || /description|responsibilit/i.test(f.label);
    let best = null;
    controls.forEach((c) => {
      if (used.has(c.el) || !isEmpty(c.el)) return;
      let score = 0;
      words.forEach((w) => { if (c.hint.includes(w)) score = Math.max(score, w.length); });
      if (!score) return;
      const isArea = c.el.tagName === 'TEXTAREA' || c.el.isContentEditable || c.el.getAttribute('role') === 'textbox';
      if (longText && !isArea) score -= 3;
      if (!longText && isArea && !/skill/i.test(f.label)) score -= 2;
      if (score > 0 && (!best || score > best.score)) best = { c, score };
    });
    if (best && setValue(best.c.el, String(f.value))) { used.add(best.c.el); filled.push(f.label); } else left.push(f.label);
  });
  return { filled, left };
}
