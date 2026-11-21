// TeamLink extension: reads the LinkedIn profile on the screen (only what is shown; nothing is sent until "Add" is pressed in the popup).
(function () {
  const text = (sel) => { const el = document.querySelector(sel); return el ? el.innerText.replace(/\s+/g, ' ').trim() : ''; };
  function read() {
    const name = text('h1');
    const headline = text('.text-body-medium.break-words');
    const place = text('.text-body-small.inline.t-black--light.break-words');
    let currentCompany = '';
    const exp = document.querySelector('#experience');
    const expBox = exp && exp.closest('section');
    const first = expBox && expBox.querySelector('li .t-14.t-normal span[aria-hidden="true"]');
    if (first) currentCompany = first.innerText.split('·')[0].trim();
    const skills = [];
    const sk = document.querySelector('#skills');
    const skBox = sk && sk.closest('section');
    if (skBox) skBox.querySelectorAll('li .t-bold span[aria-hidden="true"]').forEach((s) => { const v = s.innerText.trim(); if (v && skills.length < 25) skills.push(v); });
    return { profileUrl: window.location.href.split('?')[0], name, headline, location: place, currentCompany, skills };
  }
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg && msg.type === 'teamlink-read-profile') reply(read());
    return true;
  });
}());
