/* =====================================================================
   TEAMLINK - AI interview add-on (founder 2026-10-30: "candidate ai interview
   attend ayetappudu live capture correct ga tisukovadam ledhuuu and background
   voices ostunna adhii 2 times warning evadam ledhuu ... score candidate kii
   kuda kanipinchaliii ... ai suuggest chyaliii inetrview complete ayinakaa").

   Added to the Job Portal's pages by the TeamLink proxy (backend/src/utils/
   jobPortalEmbed.js), served by the TeamLink router inside the portal
   (embed/teamlink-integration.mjs GET /tl-addon/interview.js). The portal's
   own code is NOT changed: everything here wraps what the page already
   exposes (window.AIIV, window.TLVI, window.TL, tlIntegrityWarn,
   tlProctorStop) and leaves the originals running.

   1. LIVE CAPTURE THAT KEEPS GOING. The page makes a new browser speech
      recogniser for each answer and restarts it once when it ends, swallowing
      every failure - so one failed restart, a "network" or "no-speech" end,
      left the rest of the answer uncaptured, and the score is computed from
      that text. The recogniser the page creates is now a stand-in around the
      real one: it restarts after every unplanned end (backing off, a fresh
      recogniser when the old one will not start), keeps words that were still
      "in progress" when the browser cut the session, and tells the candidate
      plainly when this browser cannot capture speech (use Chrome).
   2. A BACKGROUND VOICE WHILE ANSWERING. The page checks for noise only when
      the room should be silent, and the voice check learns every voice heard
      during an answer as the candidate's own - so a voice in the background
      while the candidate answered never warned. Here the candidate's voice is
      learned from the start of their first answers; afterwards a sustained
      voice far from it (a different person) is reported to the portal's
      own integrity endpoint, which keeps the one strike counter: warning 1/2,
      then the interview is stopped at 2/2 - the server decides, not this file.
      Approximate by nature (no speaker model): it needs ~3 seconds of a clearly
      different voice before it says anything.
   3. THE RESULT FOR THE CANDIDATE. The closing screen now shows the score, and
      per question what was missing and what to change, plus three tips
      (GET /api/tl-interview/:id/coach - written by AI when the portal has a
      model, by rules otherwise). The same result opens again from
      #/tl-interview-result/<interview id>.
   4. The last answer recordings finish uploading before the interview is
      closed (they used to arrive after it, too late to be used).
   ===================================================================== */
(function () {
  'use strict';
  if (window.__tlInterviewAddon) return;
  window.__tlInterviewAddon = true;

  var API_BASE = function () { return String(window.TL_API_BASE || '/api').replace(/\/+$/, ''); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var A = function () { return window.AIIV || null; };
  var session = function () { var s = window.TL && window.TL.__aiivSession; var a = A(); return s && (!a || !a.appId || s.appId === a.appId) ? s : null; };

  /* ------------------------------------------------------------------ *
   * a small notice at the top of the screen (plain words, no figures)
   * ------------------------------------------------------------------ */
  var noticeShown = {};
  function notice(key, text) {
    if (noticeShown[key]) return;
    noticeShown[key] = true;
    var el = document.createElement('div');
    el.className = 'tladd-note';
    el.setAttribute('role', 'alert');
    el.innerHTML = '<span>' + esc(text) + '</span><button type="button" aria-label="Close">×</button>';
    el.querySelector('button').onclick = function () { el.remove(); };
    document.body.appendChild(el);
  }

  /* ================================================================== *
   * 1. live capture that keeps going
   * ================================================================== */
  function wrapRecognition(Real) {
    if (!Real || Real.__tlWrapped) return Real;
    function TLSpeech() {
      var self = this;
      self.lang = 'en-IN'; self.continuous = false; self.interimResults = false; self.maxAlternatives = 1;
      self.onresult = null; self.onerror = null; self.onend = null; self.onstart = null;
      self._stopped = true; self._fails = 0; self._interim = ''; self._net = []; self._inner = null;
      self._make();
    }
    TLSpeech.prototype._make = function () {
      var self = this;
      var r = new Real();
      self._inner = r;
      r.onstart = function (e) { if (self.onstart) self.onstart(e); };
      r.onresult = function (e) {
        self._fails = 0;
        var last = e.results && e.results.length ? e.results[e.results.length - 1] : null;
        self._interim = last && !last.isFinal && last[0] ? String(last[0].transcript || '') : '';
        if (self.onresult) self.onresult(e);
      };
      r.onerror = function (ev) {
        var err = ev && ev.error;
        if (err === 'not-allowed' || err === 'service-not-allowed' || err === 'audio-capture') {
          self._stopped = true;
          if (self.onerror) self.onerror(ev);
          if (err === 'audio-capture') notice('mic', 'Your microphone could not be heard. Check that it is connected and not used by another app, then continue.');
          return;
        }
        if (err === 'network') {
          var now = Date.now();
          self._net = self._net.filter(function (t) { return now - t < 60000; }).concat(now);
          if (self._net.length >= 3) notice('net', 'Live capture cannot reach the speech service in this browser. For the best result, open this interview in Google Chrome or Microsoft Edge.');
        }
        /* no-speech, aborted, network: the end handler below starts it again */
      };
      r.onend = function () {
        /* words still "in progress" when the browser cut the session are kept, as a finished line */
        if (self._interim && !self._stopped && self.onresult) {
          var t = self._interim; self._interim = '';
          var res = { isFinal: true, length: 1, 0: { transcript: t, confidence: 0 } };
          try { self.onresult({ resultIndex: 0, results: { length: 1, 0: res } }); } catch (e) { /* the page's handler */ }
        }
        if (self._stopped) { if (self.onend) self.onend(); return; }
        var delay = Math.min(2000, 150 * (1 + self._fails));
        self._fails += 1;
        setTimeout(function () {
          if (self._stopped) return;
          try { self._apply(); self._inner.start(); } catch (e) {
            try { self._make(); self._apply(); self._inner.start(); } catch (e2) { /* tried again on the next end */ }
          }
        }, delay);
      };
    };
    TLSpeech.prototype._apply = function () {
      var r = this._inner;
      r.lang = this.lang; r.continuous = this.continuous; r.interimResults = this.interimResults;
      try { r.maxAlternatives = this.maxAlternatives; } catch (e) { /* not in every browser */ }
    };
    TLSpeech.prototype.start = function () { this._stopped = false; this._fails = 0; this._apply(); this._inner.start(); };
    /* a deliberate stop (Submit, time up, mute): no restart, and no late words carried into the next answer */
    TLSpeech.prototype.stop = function () { this._stopped = true; this._interim = ''; try { this._inner.stop(); } catch (e) { /* already stopped */ } };
    TLSpeech.prototype.abort = function () { this._stopped = true; this._interim = ''; try { this._inner.abort(); } catch (e) { /* already stopped */ } };
    TLSpeech.__tlWrapped = true;
    return TLSpeech;
  }
  try {
    if (window.webkitSpeechRecognition) window.webkitSpeechRecognition = wrapRecognition(window.webkitSpeechRecognition);
    if (window.SpeechRecognition) window.SpeechRecognition = wrapRecognition(window.SpeechRecognition);
  } catch (e) { /* the page's own recogniser keeps working */ }

  /* a browser that cannot capture speech at all: say so before the first question */
  setInterval(function () {
    var a = A();
    if (!a || !a.started) return;
    if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) {
      notice('nosr', 'Live capture does not work in this browser, so your answers may not be scored. Please open this interview in Google Chrome or Microsoft Edge.');
    }
  }, 2000);

  /* ================================================================== *
   * 2. a background voice while the candidate answers
   * ================================================================== */
  var V = {
    ctx: null, an: null, src: null, buf: null, stream: null,
    base: [], baseHz: 0, frames: [], lastReport: 0, busy: false, timer: null,
  };
  var LEARN = 40;          // voiced frames (100 ms each) learned as the candidate's own voice
  var FAR = 7;             // semitones from the candidate's voice that count as "another voice"
  var WINDOW = 30;         // the last 3 seconds
  var NEED_ODD = 18;       // of which this many frames must be the other voice
  var NEED_VOICED = 20;    // and this many voiced at all
  var COOLDOWN = 20000;

  function pitch(full, fullRate) {
    /* every second sample: a quarter of the work, still well above a voice's pitch */
    var buf = new Float32Array(Math.floor(full.length / 2)), rate = fullRate / 2, n = buf.length, rms = 0, i;
    for (i = 0; i < n; i++) buf[i] = full[i * 2];
    for (i = 0; i < n; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / n);
    if (rms < 0.02) return null;
    var minLag = Math.floor(rate / 400), maxLag = Math.min(Math.floor(rate / 70), n - 1);
    var best = 0, bestLag = -1, corr = [];
    for (var lag = minLag; lag <= maxLag; lag++) {
      /* normalised over the overlapping part only, so a clean voice reads ~1 at any pitch */
      var xy = 0, xx = 0, yy = 0;
      for (i = 0; i < n - lag; i++) { xy += buf[i] * buf[i + lag]; xx += buf[i] * buf[i]; yy += buf[i + lag] * buf[i + lag]; }
      var s = xy / (Math.sqrt(xx * yy) || 1);
      corr.push(s);
      if (s > best) best = s;
    }
    /* the FIRST strong peak, not the highest one: a voice also correlates at two and three times its period, and taking
       those would read the candidate an octave low - a "different voice" that is really the same person */
    for (var k = 1; k < corr.length - 1; k++) {
      if (corr[k] >= best * 0.9 && corr[k] >= corr[k - 1] && corr[k] >= corr[k + 1]) { bestLag = minLag + k; best = corr[k]; break; }
    }
    if (bestLag < 0 || best < 0.6) return { hz: 0, clarity: best, rms: rms };
    return { hz: rate / bestLag, clarity: best, rms: rms };
  }
  function median(xs) { var s = xs.slice().sort(function (a, b) { return a - b; }); return s.length ? s[Math.floor(s.length / 2)] : 0; }

  function ensureAnalyser() {
    var a = A();
    if (!a || !a.stream || !a.audioCtx) return false;
    if (V.stream === a.stream && V.an) return true;
    try {
      V.ctx = a.audioCtx; V.stream = a.stream;
      V.src = V.ctx.createMediaStreamSource(a.stream);
      V.an = V.ctx.createAnalyser(); V.an.fftSize = 2048;
      V.src.connect(V.an);
      V.buf = new Float32Array(V.an.fftSize);
      return true;
    } catch (e) { V.an = null; return false; }
  }

  function report(info) {
    var s = session(), a = A();
    if (!s || !window.TL || !window.TL.api || V.busy) return;
    V.busy = true; V.lastReport = Date.now();
    var seq = typeof window.tlCurrentQuestionNo === 'function' ? window.tlCurrentQuestionNo() : undefined;
    window.TL.api.post('/ai-interviews/' + encodeURIComponent(s.interviewId) + '/integrity', {
      type: 'additional_voice', confidence: Math.min(0.95, info.share),
      evidence: { detector: 'teamlink-answer-voice', sustainedMs: info.ms, samples: info.voiced, agreeing: info.odd, pitchHz: info.hz, baselineHz: V.baseHz, questionSeq: seq, note: 'another voice while the candidate was answering' },
    }).then(function (r) {
      V.busy = false;
      if (!r) return;
      if (r.action === 'warn' && typeof window.tlIntegrityWarn === 'function') window.tlIntegrityWarn(r.strike, r.message);
      else if (r.action === 'suspend' || r.action === 'suspended') {
        if (typeof window.tlIntegrityWarn === 'function') window.tlIntegrityWarn(r.strike, r.message);
        if (typeof window.tlProctorStop === 'function') window.tlProctorStop('additional_voice', r.message, r.retakeAvailableAt);
      }
      /* 'noted' (same moment as the last warning) and 'ignored' change nothing, as on the portal's own checks */
    }, function () { V.busy = false; /* a failed report invents no strike */ });
    if (a) a.__tlVoiceReports = (a.__tlVoiceReports || 0) + 1;
  }

  function tick() {
    var a = A();
    if (!a || a.phase !== 'interview') { V.frames = []; return; }
    if (!a.listening || a.ending || a.micOff) { V.frames = []; return; }
    if (!ensureAnalyser()) return;
    V.an.getFloatTimeDomainData(V.buf);
    var p = pitch(V.buf, V.ctx.sampleRate);
    var f = { voiced: !!(p && p.hz && p.clarity >= 0.85), hz: p ? p.hz : 0 };
    if (f.voiced && V.base.length < LEARN) {
      V.base.push(f.hz);
      if (V.base.length === LEARN) V.baseHz = median(V.base);
      return;
    }
    if (!V.baseHz) return;
    f.odd = f.voiced && Math.abs(12 * Math.log(f.hz / V.baseHz) / Math.LN2) >= FAR;
    /* the candidate's own voice drifts a little over an interview: follow it slowly */
    if (f.voiced && !f.odd && Math.abs(12 * Math.log(f.hz / V.baseHz) / Math.LN2) <= 3) V.baseHz = V.baseHz * 0.98 + f.hz * 0.02;
    V.frames.push(f);
    if (V.frames.length > WINDOW) V.frames.shift();
    if (V.frames.length < WINDOW || Date.now() - V.lastReport < COOLDOWN) return;
    var voiced = 0, odd = 0, hz = [];
    V.frames.forEach(function (x) { if (x.voiced) voiced += 1; if (x.odd) { odd += 1; hz.push(x.hz); } });
    if (voiced >= NEED_VOICED && odd >= NEED_ODD) {
      report({ share: odd / WINDOW, ms: odd * 100, voiced: voiced, odd: odd, hz: Math.round(median(hz)) });
      V.frames = [];
    }
  }
  V.timer = setInterval(tick, 100);

  /* ================================================================== *
   * 4. the last recordings land before the interview is closed
   * ================================================================== */
  (function wrapFinish() {
    var tries = 0;
    var t = setInterval(function () {
      tries += 1;
      var TL = window.TL;
      if (TL && typeof TL.finishAiSession === 'function' && !TL.finishAiSession.__tl) {
        var orig = TL.finishAiSession;
        var wrapped = function (rec, ses) {
          var self = this, args = arguments;
          if (ses && ses.interviewId) { window.__tlLastInterviewId = ses.interviewId; try { sessionStorage.setItem('tlLastInterviewId', ses.interviewId); } catch (e) { /* private window */ } }
          var wait = window.TLVI && window.TLVI.uploads && window.TLVI.uploads.drained
            ? Promise.race([window.TLVI.uploads.drained(), new Promise(function (r) { setTimeout(r, 45000); })]) : Promise.resolve();
          return wait.then(function () { return orig.apply(self, args); });
        };
        wrapped.__tl = true;
        TL.finishAiSession = wrapped;
        clearInterval(t);
      } else if (tries > 120) clearInterval(t);
    }, 500);
  })();

  /* ================================================================== *
   * 3. the result for the candidate
   * ================================================================== */
  function styles() {
    if (document.getElementById('tladd-css')) return;
    var css = ''
      + '.tladd-note{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:99999;max-width:min(640px,calc(100vw - 32px));background:#fff7ed;color:#7c2d12;border:1px solid #fdba74;border-radius:10px;padding:10px 40px 10px 14px;font:14px/1.45 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.12)}'
      + '.tladd-note button{position:absolute;right:8px;top:6px;border:0;background:none;font-size:20px;cursor:pointer;color:inherit}'
      + '.tlcoach{text-align:left;margin:18px auto 6px;max-width:760px;font:14px/1.5 system-ui,sans-serif;color:#0f172a}'
      + '.tlcoach h3{font-size:18px;margin:0 0 8px}.tlcoach .tlc-score{display:flex;gap:16px;align-items:center;flex-wrap:wrap;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:14px 16px}'
      + '.tlcoach .tlc-big{font-size:34px;font-weight:800;color:#166534}.tlcoach .tlc-subs{display:flex;gap:10px;flex-wrap:wrap}.tlcoach .tlc-sub{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:4px 10px;font-size:13px}'
      + '.tlcoach ol{padding-left:0;list-style:none;margin:14px 0 0;display:grid;gap:10px}.tlcoach li{border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;background:#fff}'
      + '.tlcoach .tlc-q{font-weight:600}.tlcoach .tlc-chip{float:right;font-weight:700;border-radius:999px;padding:1px 10px;font-size:12px}.tlc-hi{background:#dcfce7;color:#166534}.tlc-mid{background:#fef9c3;color:#854d0e}.tlc-lo{background:#fee2e2;color:#991b1b}'
      + '.tlcoach .tlc-miss{color:#991b1b;margin-top:6px}.tlcoach .tlc-fix{color:#1e3a8a;margin-top:4px}.tlcoach details{margin-top:6px;color:#475569}'
      + '.tlcoach .tlc-tips{background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:10px 16px;margin-top:14px}.tlcoach .tlc-small{color:#64748b;font-size:12px;margin-top:8px}'
      + '.tlcoach-over{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:99998;overflow:auto;padding:24px 16px}.tlcoach-over .tlcoach{background:#fff;border-radius:14px;padding:18px;margin:0 auto}'
      + '.tlcoach-over .tlc-close{float:right;border:1px solid #cbd5e1;background:#fff;border-radius:8px;padding:4px 10px;cursor:pointer}';
    var s = document.createElement('style'); s.id = 'tladd-css'; s.textContent = css; document.head.appendChild(s);
  }
  var tone = function (n) { return n >= 75 ? 'tlc-hi' : n >= 45 ? 'tlc-mid' : 'tlc-lo'; };
  function render(el, d) {
    var subs = [['Technical', d.scores.technical], ['Behaviour', d.scores.behavioral], ['Communication', d.scores.communication], ['Job match', d.scores.jobMatch]]
      .filter(function (x) { return x[1] != null; }).map(function (x) { return '<span class="tlc-sub">' + esc(x[0]) + ': <b>' + x[1] + '%</b></span>'; }).join('');
    el.innerHTML = '<h3>Your interview result</h3>'
      + '<div class="tlc-score"><div class="tlc-big">' + esc(d.overall) + '%</div><div><div>Answered <b>' + d.answered + '</b> of <b>' + d.asked + '</b> questions'
      + (d.job ? ' for <b>' + esc(d.job) + '</b>' : '') + '.</div><div class="tlc-subs">' + subs + '</div></div></div>'
      + (d.contentScored ? '' : '<p class="tlc-miss">Your spoken answers were not captured as text, so the score could not judge what you said. Use Google Chrome and a quiet room next time.</p>')
      + '<ol>' + d.questions.map(function (q) {
        return '<li><span class="tlc-chip ' + tone(q.score) + '">' + q.score + '%</span><div class="tlc-q">Q' + q.seq + '. ' + esc(q.question) + '</div>'
          + '<div class="tlc-miss"><b>Where it went wrong:</b> ' + esc(q.mistake) + '</div>'
          + '<div class="tlc-fix"><b>What to change:</b> ' + esc(q.suggestion) + '</div>'
          + (q.yourAnswer ? '<details><summary>What we heard you say</summary>' + esc(q.yourAnswer) + '</details>' : '')
          + '</li>';
      }).join('') + '</ol>'
      + '<div class="tlc-tips"><b>Tips for your next interview</b><ul>' + d.tips.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>'
      + '<div class="tlc-small">' + (d.engine === 'model' ? 'Suggestions written by AI from your answers.' : 'Suggestions made from your scores and answers.')
      + ' You can open this result again at any time from this link: <a href="#/tl-interview-result/' + esc(d.interviewId) + '">your interview result</a>.</div>';
  }
  function load(el, id, tries) {
    fetch(API_BASE() + '/tl-interview/' + encodeURIComponent(id) + '/coach', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
      .then(function (x) {
        if (x.status === 200) { render(el, x.body); return; }
        if (x.status === 409 && tries < 20) { el.innerHTML = '<p>' + esc((x.body.error && x.body.error.message) || 'Preparing your result…') + '</p>'; setTimeout(function () { load(el, id, tries + 1); }, 3000); return; }
        el.innerHTML = '<p>' + esc((x.body && x.body.error && x.body.error.message) || 'Your result could not be loaded. Please try again later.') + '</p>';
      }, function () {
        if (tries < 5) { setTimeout(function () { load(el, id, tries + 1); }, 3000); return; }
        el.innerHTML = '<p>Your result could not be loaded. Please check your internet and open this page again.</p>';
      });
  }
  /* the closing screen: the portal's own text, then the result */
  (function wrapComplete() {
    var tries = 0;
    var t = setInterval(function () {
      tries += 1;
      var T = window.TLVI;
      if (T && typeof T.completeHtml === 'function' && !T.completeHtml.__tl) {
        var orig = T.completeHtml;
        var wrapped = function () {
          var html = orig.apply(this, arguments);
          styles();
          var id = window.__tlLastInterviewId || (function () { try { return sessionStorage.getItem('tlLastInterviewId'); } catch (e) { return null; } })();
          if (!id) return html;
          setTimeout(function () { var el = document.getElementById('tlCoach'); if (el && !el.dataset.loaded) { el.dataset.loaded = '1'; load(el, id, 0); } }, 50);
          return html.replace('<div class="tlvi-actions">', '<div class="tlcoach" id="tlCoach"><p>Preparing your result…</p></div><div class="tlvi-actions">');
        };
        wrapped.__tl = true;
        T.completeHtml = wrapped;
        clearInterval(t);
      } else if (tries > 120) clearInterval(t);
    }, 500);
  })();
  /* the same result again later: #/tl-interview-result/<id> */
  function openFromHash() {
    var m = /^#\/tl-interview-result\/([A-Za-z0-9_-]+)/.exec(location.hash || '');
    if (!m) return;
    styles();
    var over = document.getElementById('tlCoachOver');
    if (!over) {
      over = document.createElement('div'); over.id = 'tlCoachOver'; over.className = 'tlcoach-over';
      over.innerHTML = '<div class="tlcoach"><button type="button" class="tlc-close">Close</button><div id="tlCoachBody"><p>Loading your result…</p></div></div>';
      over.querySelector('.tlc-close').onclick = function () { over.remove(); try { history.back(); } catch (e) { /* stays */ } };
      document.body.appendChild(over);
    }
    load(document.getElementById('tlCoachBody'), m[1], 0);
  }
  window.addEventListener('hashchange', openFromHash);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', openFromHash); else openFromHash();

  /* for tests */
  window.__tlInterviewAddonTest = { wrapRecognition: wrapRecognition, pitch: pitch, V: V, tick: tick };
})();
