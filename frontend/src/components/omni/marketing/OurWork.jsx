import { useEffect, useState } from 'react';
import api from '../../../api';

// "OUR WORK": what a client sees to trust us before giving us a project: how fast we deliver, how often clients chose from our FIRST options (our accuracy), how often
// we posted by the date the client needed it, and real finished work with its timeline. Numbers cover all finished projects and name nobody; a percentage appears only
// once 3 projects stand behind it; work is shown only when the team marked that the client agrees (anonymous unless the client's name was ticked).
// Real data: GET /api/public/mk-work (marketing/projects.js). Used on the client's project page and on /our-work.
const dur = (h) => (h == null ? '' : h < 1 ? 'under an hour' : h < 48 ? `${Math.round(h)} hour${Math.round(h) === 1 ? '' : 's'}` : `${Math.round(h / 24)} days`);
const month = (iso) => { try { return new Date(iso).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }); } catch { return ''; } };

export default function OurWork({ P = '#0f766e', title = 'Our work' }) {
  const [d, setD] = useState(null);
  useEffect(() => { api.get('/public/mk-work').then((r) => setD(r.data)).catch(() => setD({ stats: { approved: 0 }, items: [] })); }, []);
  if (!d) return null;
  const { stats: s, items } = d;
  const tiles = [];
  if (s.approved > 0) tiles.push([String(s.delivered || s.approved), s.delivered ? 'projects delivered' : 'projects approved by clients']);
  if (s.avgHoursToOptions != null) tiles.push([dur(s.avgHoursToOptions), 'average time to our first options']);
  if (s.firstRoundPct != null) tiles.push([`${s.firstRoundPct}%`, 'chosen by clients from our first set']);
  if (s.onTimePct != null) tiles.push([`${s.onTimePct}%`, 'posted by the date the client needed it']);
  if (!tiles.length && !items.length) return null;
  const media = (it) => { const url = `/api/public/mk-work/file/${encodeURIComponent(it.key)}`; return it.type === 'video'
    ? <video src={url} controls playsInline preload="metadata" style={{ width: '100%', borderRadius: 10, background: '#000', display: 'block', maxHeight: 420 }} aria-label={it.title} /> // eslint-disable-line jsx-a11y/media-has-caption
    : <img src={url} alt={it.title} loading="lazy" style={{ width: '100%', borderRadius: 10, background: '#eef1ef', display: 'block', maxHeight: 420, objectFit: 'contain' }} />; };
  return (
    <section aria-label={title} style={{ maxWidth: 680, margin: '0 auto' }}>
      <h2 style={{ fontSize: 18, margin: '0 0 4px', fontFamily: 'inherit', color: '#1c2a24' }}>{title}</h2>
      <p style={{ margin: '0 0 12px', fontSize: 13.5, color: '#6b7a73', lineHeight: 1.55 }}>Real projects we did for clients, and how we handled them. These numbers cover every project we have finished.</p>
      {tiles.length ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 14 }}>
          {tiles.map(([v, l]) => <div key={l} style={{ background: '#fff', borderRadius: 12, padding: '12px 12px', boxShadow: '0 1px 5px rgba(0,0,0,.07)' }}><div style={{ fontSize: 23, fontWeight: 800, color: P }}>{v}</div><div style={{ fontSize: 12, color: '#54645b', lineHeight: 1.4, marginTop: 2 }}>{l}</div></div>)}
        </div>
      ) : null}
      {items.length ? (
        <div style={{ display: 'grid', gap: 14 }}>
          {items.map((it) => (
            <article key={it.key} style={{ background: '#fff', borderRadius: 14, padding: 12, boxShadow: '0 1px 6px rgba(0,0,0,.08)' }}>
              {media(it)}
              <div style={{ margin: '10px 2px 2px', fontWeight: 800, fontSize: 15 }}>{it.title}</div>
              <div style={{ fontSize: 12.5, color: '#6b7a73' }}>{it.client}{it.platforms.length ? ` · ${it.platforms.join(', ')}` : ''}{it.when ? ` · ${month(it.when)}` : ''}</div>
              <div style={{ fontSize: 12.5, marginTop: 6, color: '#1c2a24', lineHeight: 1.6 }}>
                {[it.hoursToOptions != null ? `First options in ${dur(it.hoursToOptions)}` : '', it.hoursToApproved != null ? `approved in ${dur(it.hoursToApproved)}` : '', it.hoursToPosted != null ? `posted in ${dur(it.hoursToPosted)}` : ''].filter(Boolean).join(' · ')}
                {it.rounds ? <div style={{ color: '#087844', fontWeight: 700 }}>{it.rounds === 1 ? '✔ The client chose from our first set of options' : `The client asked for ${it.rounds - 1} round${it.rounds === 2 ? '' : 's'} of changes, then approved`}</div> : null}
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
