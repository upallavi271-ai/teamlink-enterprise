import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api';
import './MaterialViewer.css';

// ---------------------------------------------------------------------------
// VIEW-ONLY course material viewers — the video player and the document
// viewer used by the learner's course screen and the author's preview.
//
// A stored file is never linked to directly. POST /lms/materials/:id/view-token
// (which checks the caller is assigned to the course, or authors it) returns a
// SIGNED stream URL that expires in minutes and is bound to that one material
// and that one login; the server re-checks the assignment on every request,
// streams with Content-Disposition: inline, Cache-Control: no-store and
// nosniff, and answers 403 to anything else. On this side:
//
//   video     controlsList="nodownload noplaybackrate", no picture-in-picture,
//             no context menu, playback rate pinned to 1x; when the short-
//             lived link expires mid-video it fetches a fresh one and resumes
//             where the learner was.
//   document  a PDF is drawn page by page onto <canvas> by pdf.js INSIDE the
//             app — there is no browser PDF viewer, so no download or print
//             button; an image is drawn undraggable. Right-click, drag, copy
//             and text selection are off, Ctrl+S / Ctrl+P are swallowed while
//             it is open, and it is hidden when the page is printed.
//
// and the stream URL is never printed, linked or offered in a new tab. That is
// what a web page CAN do. It cannot stop a screenshot, a screen recording, a
// phone camera or a determined user with the browser's developer tools, and
// VIEW_ONLY_NOTE says so on the screen rather than claiming otherwise.
// ---------------------------------------------------------------------------

export const VIEW_ONLY_NOTE = 'Materials are view-only: there is no download or save option, links expire within minutes and only work for people assigned to the course. '
  + 'Screenshots and screen recording cannot be blocked by any web app, so please treat course content as confidential.';

const block = (e) => e.preventDefault();

// Ctrl/Cmd + S (save) and + P (print) while a material is open.
function useBlockSaveKeys() {
  useEffect(() => {
    const onKey = (e) => {
      const k = String(e.key || '').toLowerCase();
      if ((e.ctrlKey || e.metaKey) && (k === 's' || k === 'p')) e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

// Fetches a signed stream URL for one material; refresh() gets a new one.
function useViewSrc(materialId) {
  const [src, setSrc] = useState(null);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setError('');
    api.post(`/lms/materials/${materialId}/view-token`)
      .then((res) => { if (live) setSrc(res.data.src); })
      .catch((err) => { if (live) setError(err.response?.data?.error || 'Could not open this material.'); });
    return () => { live = false; };
  }, [materialId, nonce]);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { src, error, refresh };
}

// THE VIDEO PLAYER, with watch tracking when `track` is on.
//
// It reports the stretches it actually PLAYED — [from, to] pairs, cut wherever
// the learner seeks — every REPORT_MS and on pause / end / leaving, never just
// the playhead. The server credits them in order (see routes/lms.js), so a
// skip ahead earns nothing; this side only has to describe honestly what
// played.
const REPORT_MS = 10000;

export function SecureVideo({ material, startAt = 0, track = false, onProgress }) {
  const { src, error, refresh } = useViewSrc(material.id);
  useBlockSaveKeys();
  const ref = useRef(null);
  const segs = useRef([]);     // closed stretches not yet reported
  const cur = useRef(null);    // the stretch playing now: { from, last }
  const resumeAt = useRef(startAt);
  const wasPlaying = useRef(false);
  const retries = useRef(0);
  const [reportError, setReportError] = useState('');
  // Held in a ref so a parent re-render never re-arms the report timer.
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;

  const close = () => {
    const c = cur.current;
    if (c && c.last > c.from) segs.current.push([c.from, c.last]);
    cur.current = null;
  };

  const flush = useCallback((extra = {}) => {
    if (!track) return;
    const v = ref.current;
    const segments = segs.current.splice(0);
    const body = {
      segments,
      position: v ? Math.floor(v.currentTime || 0) : undefined,
      duration: v && Number.isFinite(v.duration) ? Math.floor(v.duration) : undefined,
      ...extra,
    };
    delete body.force;
    if (!segments.length && !extra.force) return;
    api.post(`/lms/materials/${material.id}/progress`, body)
      .then((res) => { setReportError(''); if (onProgressRef.current) onProgressRef.current(res.data); })
      .catch(() => {
        // Put the stretches back; the next report carries them.
        segs.current.unshift(...segments);
        setReportError('Progress could not be saved just now — it will be retried.');
      });
  }, [track, material.id]);

  // Periodic report while playing: cut the current stretch at the playhead
  // and carry on from there.
  useEffect(() => {
    if (!track) return undefined;
    const timer = setInterval(() => {
      const v = ref.current;
      if (!v || v.paused) return;
      const c = cur.current;
      if (c) {
        close();
        cur.current = { from: c.last, last: c.last };
      }
      flush();
    }, REPORT_MS);
    return () => {
      clearInterval(timer);
      close();
      flush();
    };
  }, [track, flush]);

  function onLoaded() {
    const v = ref.current;
    if (!v) return;
    // Continue from where they left off (unless that is the very end) — or,
    // after a link refresh, from where playback stopped.
    const at = resumeAt.current;
    if (at > 0 && Number.isFinite(v.duration) && at < v.duration - 3) v.currentTime = at;
    if (wasPlaying.current) { v.play().catch(() => {}); wasPlaying.current = false; }
    retries.current = 0;
    // The first report records the video's length.
    if (track) flush({ force: true });
  }

  // The signed link expired (or the network dropped): get a fresh one and
  // carry on from the same second. Bounded, so a real 403 (unassigned) stops.
  function onError() {
    const v = ref.current;
    if (retries.current >= 2) return;
    retries.current += 1;
    close();
    resumeAt.current = v ? Math.floor(v.currentTime || resumeAt.current || 0) : resumeAt.current;
    wasPlaying.current = !!(v && !v.paused);
    refresh();
  }

  function onTime() {
    const v = ref.current;
    if (!v || v.paused || v.seeking) return;
    const t = v.currentTime;
    const c = cur.current;
    if (!c) { cur.current = { from: t, last: t }; return; }
    const d = t - c.last;
    // A jump in either direction is a seek, not playback: cut the stretch.
    if (d < 0 || d > 2) { close(); cur.current = { from: t, last: t }; return; }
    c.last = t;
  }

  if (error) return <div className="error-text">{error}</div>;
  if (!src) return <div className="small-muted">Loading video…</div>;
  return (
    <div className="lms-secure" onContextMenu={block} onDragStart={block} title="View-only — downloading is disabled. Screenshots and screen recording cannot be blocked.">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={ref}
        src={src}
        controls
        controlsList="nodownload noplaybackrate noremoteplayback"
        disablePictureInPicture
        disableRemotePlayback
        playsInline
        preload="metadata"
        draggable={false}
        onContextMenu={block}
        onLoadedMetadata={onLoaded}
        onTimeUpdate={onTime}
        onSeeking={close}
        onError={onError}
        onPause={() => { close(); flush({ force: true }); }}
        onEnded={() => { close(); flush({ force: true }); }}
        onRateChange={(e) => { if (e.currentTarget.playbackRate !== 1) e.currentTarget.playbackRate = 1; }}
        className="lms-video"
      />
      {reportError && <div className="small-muted" style={{ marginTop: 6 }}>{reportError}</div>}
    </div>
  );
}

// --- PDF, drawn in the app by pdf.js ----------------------------------------
// pdf.js is loaded only when a PDF is opened. The file is fetched ONCE with
// the signed link into memory and handed to pdf.js as bytes, so an expiring
// link can never break a long read, and no URL of the file is ever put in
// the page. Each page is drawn onto a <canvas> (no text layer, so nothing to
// select or copy) and an IntersectionObserver notes each page that has been
// on screen — the "every page viewed" half of a document's completion rule.
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]).then(([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    }).catch((err) => { pdfjsPromise = null; throw err; });
  }
  return pdfjsPromise;
}

function PdfCanvasViewer({ src, onPages }) {
  const host = useRef(null);
  const [state, setState] = useState({ loading: true, error: '', pages: 0 });
  const seen = useRef(new Set());
  const onPagesRef = useRef(onPages);
  onPagesRef.current = onPages;

  useEffect(() => {
    let cancelled = false;
    let doc = null;
    let observer = null;
    const el = host.current;
    seen.current = new Set();
    (async () => {
      try {
        const [lib, bytes] = await Promise.all([
          loadPdfjs(),
          fetch(src, { credentials: 'omit', cache: 'no-store' }).then((r) => {
            if (!r.ok) throw new Error(r.status === 403 ? 'This link has expired or you are not assigned to this course — reopen the material.' : 'Could not load this document.');
            return r.arrayBuffer();
          }),
        ]);
        if (cancelled) return;
        doc = await lib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
        if (cancelled) return;
        setState({ loading: false, error: '', pages: doc.numPages });
        if (onPagesRef.current) onPagesRef.current({ pageCount: doc.numPages, pagesViewed: 0 });
        observer = new IntersectionObserver((entries) => {
          let grew = false;
          entries.forEach((en) => {
            if (en.isIntersecting && en.intersectionRatio >= 0.5) {
              const n = Number(en.target.dataset.page);
              if (!seen.current.has(n)) { seen.current.add(n); grew = true; }
            }
          });
          if (grew && onPagesRef.current) onPagesRef.current({ pageCount: doc.numPages, pagesViewed: seen.current.size });
        }, { root: el, threshold: [0.5] });
        const width = Math.max(320, (el.clientWidth || 800) - 24);
        for (let i = 1; i <= doc.numPages; i += 1) {
          if (cancelled) return;
          // eslint-disable-next-line no-await-in-loop
          const page = await doc.getPage(i);
          const base = page.getViewport({ scale: 1 });
          const scale = width / base.width;
          const ratio = window.devicePixelRatio || 1;
          const vp = page.getViewport({ scale: scale * ratio });
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(vp.width);
          canvas.height = Math.floor(vp.height);
          canvas.style.width = `${Math.floor(vp.width / ratio)}px`;
          canvas.style.height = `${Math.floor(vp.height / ratio)}px`;
          canvas.className = 'lms-pdf-page';
          canvas.dataset.page = String(i);
          canvas.setAttribute('aria-label', `Page ${i} of ${doc.numPages}`);
          canvas.addEventListener('contextmenu', block);
          canvas.addEventListener('dragstart', block);
          el.appendChild(canvas);
          // eslint-disable-next-line no-await-in-loop
          await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
          observer.observe(canvas);
        }
      } catch (err) {
        if (!cancelled) setState({ loading: false, error: err.message || 'Could not display this document.', pages: 0 });
      }
    })();
    return () => {
      cancelled = true;
      if (observer) observer.disconnect();
      if (doc) doc.destroy().catch(() => {});
      if (el) el.innerHTML = '';
    };
  }, [src]);

  return (
    <>
      {state.loading && <div className="small-muted" style={{ padding: 10 }}>Loading document…</div>}
      {state.error && <div className="error-text" style={{ padding: 10 }}>{state.error}</div>}
      <div ref={host} className="lms-pdf-host" onContextMenu={block} onDragStart={block} />
    </>
  );
}

// THE DOCUMENT VIEWER. A PDF is drawn in the app by pdf.js; an image is drawn
// undraggable. `onPages` hears ({ pageCount, pagesViewed }) for a PDF.
export function SecureDocument({ material, onPages }) {
  const { src, error } = useViewSrc(material.id);
  useBlockSaveKeys();
  if (error) return <div className="error-text">{error}</div>;
  if (!src) return <div className="small-muted">Loading document…</div>;
  const isPdf = material.mimeType === 'application/pdf';
  return (
    <div
      className="lms-secure lms-doc"
      onContextMenu={block}
      onCopy={block}
      onCut={block}
      onDragStart={block}
      title="View-only — downloading, copying and printing are disabled. Screenshots and screen recording cannot be blocked."
    >
      {isPdf ? (
        <PdfCanvasViewer src={src} onPages={onPages} />
      ) : (
        <img
          src={src}
          alt={material.title}
          draggable={false}
          onContextMenu={block}
          className="lms-img"
        />
      )}
    </div>
  );
}
