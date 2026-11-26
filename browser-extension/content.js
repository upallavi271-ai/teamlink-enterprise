// TeamLink extension: reads the profile on the screen (only what is shown; nothing is sent until "Add" is pressed in the popup).
// LinkedIn keeps its own reader; Naukri (incl. Resdex), Shine and foundit use parsers.js (extension 2.0, 2026-11-26).
(function () {
  const text = (sel) => { const el = document.querySelector(sel); return el ? el.innerText.replace(/\s+/g, ' ').trim() : ''; };
  function readLinkedin() {
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
    return { site: 'linkedin', profileUrl: window.location.href.split('?')[0], name, headline, location: place, currentCompany, skills };
  }
  function readBoard() {
    const links = [...document.querySelectorAll('a[href^="mailto:"], a[href^="tel:"]')];
    const page = {
      url: window.location.href,
      title: document.title,
      h1: text('h1') || text('[class*="candidateName"]') || text('[class*="name"]'),
      text: document.body ? document.body.innerText : '',
      mailtos: links.filter((a) => a.href.startsWith('mailto:')).map((a) => decodeURIComponent(a.href.slice(7).split('?')[0])),
      tels: links.filter((a) => a.href.startsWith('tel:')).map((a) => a.href.slice(4)),
    };
    return window.TLParsers ? window.TLParsers.read(page) : null;
  }
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg && msg.type === 'teamlink-read-profile') reply(/(^|\.)linkedin\.com$/i.test(window.location.hostname) ? readLinkedin() : readBoard());
    return true;
  });
}());
