import { useCallback, useEffect, useRef, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { Panel, Btn, Banner, Field, TinyBtn } from '../ui.jsx';

// "🎞 Free stock clips": real moving footage from Pexels, free. Search in plain words, press "Use this clip": it is saved as a draft clip
// (credit kept), then ready to mix into a video below (raw footage needs no approval).
export default function StockClipPanel({ toast, onMade }) {
  const [meta, setMeta] = useState(null);
  const [q, setQ] = useState('');
  const [orient, setOrient] = useState('portrait');
  const [res, setRes] = useState(null); // { items, page, hasMore, query }
  const [busy, setBusy] = useState(''); // 'search' | 'more' | <video id>
  const [err, setErr] = useState('');
  const [added, setAdded] = useState({}); // video id -> true
  const alive = useRef(true);

  const loadMeta = useCallback(() => omni.get('/gs/marketing/stock/meta').then((d) => alive.current && setMeta(d)).catch((e) => alive.current && setErr(errOf(e, 'Stock clips could not be checked.'))), []);
  useEffect(() => { alive.current = true; loadMeta(); return () => { alive.current = false; }; }, [loadMeta]);

  const search = (page = 1) => {
    if (q.trim().length < 2) { setErr('Type what you want to see, for example "nurse hospital" or "team meeting".'); return; }
    setErr(''); setBusy(page > 1 ? 'more' : 'search');
    omni.get('/gs/marketing/stock/search', { q: q.trim(), orientation: orient, page })
      .then((d) => { if (!alive.current) return; setRes((cur) => (page > 1 && cur ? { ...d, items: [...cur.items, ...d.items] } : d)); })
      .catch((e) => alive.current && setErr(errOf(e, 'The search did not work. Try again.')))
      .finally(() => alive.current && setBusy(''));
  };
  const use = (v) => {
    setErr(''); setBusy(v.id);
    omni.post('/gs/marketing/stock/import', { id: v.id, query: res ? res.query : q.trim() })
      .then(() => { if (!alive.current) return; setAdded((a) => ({ ...a, [v.id]: true })); toast('Clip saved under Your clips. It is ready: mix it into a video.'); loadMeta(); if (onMade) onMade(); })
      .catch((e) => alive.current && setErr(errOf(e, 'The clip could not be saved.')))
      .finally(() => alive.current && setBusy(''));
  };

  if (!meta) return err ? <Banner tone="error">{err}</Banner> : null;
  const ready = meta.ready;
  return (
    <Panel title="🎞 Free stock clips" sub={`Real moving video of people, offices, hospitals and cities${meta.source ? ` from ${meta.source}` : ''}. Free. Search, press Use this clip, then mix it into your video. Raw footage needs no approval; the finished video does.`} style={{ marginBottom: 14 }}>
      {!ready ? <Banner tone="warn">{meta.reason}</Banner> : null}
      {err ? <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={() => setErr('')}>Close</button></Banner> : null}
      <form onSubmit={(e) => { e.preventDefault(); search(1); }} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="WHAT DO YOU WANT TO SEE?">
          <input value={q} maxLength={80} disabled={!ready} onChange={(e) => setQ(e.target.value)} placeholder="nurse hospital, team meeting, office handshake" style={{ minWidth: 220 }} />
        </Field>
        <Field label="SHAPE">
          <select value={orient} disabled={!ready} onChange={(e) => setOrient(e.target.value)}>
            <option value="portrait">Tall (Reels, Status)</option>
            <option value="landscape">Wide (YouTube, LinkedIn)</option>
            <option value="square">Square</option>
            <option value="">Any</option>
          </select>
        </Field>
        <Btn primary disabled={!ready || busy === 'search'} onClick={() => search(1)}>{busy === 'search' ? 'Searching…' : '🔎 Search'}</Btn>
      </form>
      {ready ? <div style={{ fontSize: 11, opacity: 0.7, marginTop: 6 }}>{meta.left} of {meta.perDay} clips left today for you. Clips are 2 to {meta.maxSeconds} seconds. The photographer is credited on every clip.</div> : null}
      {res ? (
        res.items.length === 0 ? <div style={{ marginTop: 12, fontSize: 12 }}>Nothing found for “{res.query}”. Try other words, for example a simpler one like “doctor” or “office”.</div> : (
          <div style={{ marginTop: 12 }}>
            <div className="mki-grid">
              {res.items.map((v) => (
                <div key={v.id} className="mki-card">
                  <div style={{ position: 'relative', background: '#111', borderRadius: 8, overflow: 'hidden', aspectRatio: v.width && v.height ? `${v.width} / ${v.height}` : '9 / 16', maxHeight: 260 }}>
                    {v.thumb ? <img src={v.thumb} alt={`Stock clip by ${v.author}`} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} /> : null}
                    <span style={{ position: 'absolute', right: 6, bottom: 6, background: 'rgba(0,0,0,.7)', color: '#fff', fontSize: 10, padding: '2px 6px', borderRadius: 6 }}>{v.seconds}s</span>
                  </div>
                  <div style={{ fontSize: 11, margin: '6px 0' }}>by {v.author}{v.pageUrl ? <> · <a href={v.pageUrl} target="_blank" rel="noopener noreferrer">preview on {res.source || meta.source || 'the source'}</a></> : null}</div>
                  {added[v.id] ? <span className="pill live">Saved</span> : <TinyBtn disabled={!!busy || meta.left <= 0} onClick={() => use(v)}>{busy === v.id ? 'Saving…' : '＋ Use this clip'}</TinyBtn>}
                </div>
              ))}
            </div>
            {res.hasMore ? <div style={{ marginTop: 10 }}><Btn disabled={busy === 'more'} onClick={() => search((res.page || 1) + 1)}>{busy === 'more' ? 'Loading…' : 'Show more'}</Btn></div> : null}
          </div>
        )
      ) : null}
    </Panel>
  );
}
