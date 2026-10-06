import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../../api';
import CareersChrome, { daysAgo } from './CareersChrome.jsx';

// /careers — "Find your next job". Search, filters with counts (options come
// from the server, computed on the jobs matching every OTHER filter, so they
// cascade and a zero option never shows), newest first. Every filter lives in
// the address bar, so a search can be shared as a link. ?src= (the board a
// visitor came from) is carried to the job page and lands on the application.

const FILTERS = [
  { key: 'exp', label: 'Experience' },
  { key: 'mode', label: 'Work type' },
  { key: 'type', label: 'Job type' },
  { key: 'dept', label: 'Department' },
  { key: 'loc', label: 'City' },
  { key: 'posted', label: 'Posted' },
];
const KEYS = ['q', 'loc', 'exp', 'mode', 'type', 'dept', 'posted', 'sort'];

export default function CareersPortal() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState(params.get('q') || '');
  const [loc, setLoc] = useState(params.get('loc') || '');
  const [showFilters, setShowFilters] = useState(false);

  const query = useMemo(() => {
    const o = {};
    KEYS.forEach((k) => { if (params.get(k)) o[k] = params.get(k); });
    return o;
  }, [params]);
  const src = params.get('src') || '';

  useEffect(() => { document.title = 'Jobs — TeamLink Consultants'; }, []);
  useEffect(() => {
    let live = true;
    setError('');
    api.get('/public/careers/jobs', { params: query })
      .then((r) => { if (live) setData(r.data); })
      .catch((e) => { if (live) setError(e.response?.data?.error || 'Jobs could not be loaded. Please check your internet and try again.'); });
    return () => { live = false; };
  }, [query]);

  function setParam(key, value) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: false });
  }
  function search(e) {
    e.preventDefault();
    const next = new URLSearchParams(params);
    ['q', 'loc'].forEach((k) => next.delete(k));
    if (q.trim()) next.set('q', q.trim());
    if (loc.trim()) next.set('loc', loc.trim());
    if (!q.trim()) next.delete('sort');
    setParams(next);
  }
  function clearAll() {
    setQ(''); setLoc('');
    setParams(src ? { src } : {});
  }

  const active = FILTERS.filter((f) => query[f.key]);
  const anyFilter = active.length > 0 || !!query.q;
  const jobLink = (id) => `/careers/${id}${src ? `?src=${encodeURIComponent(src)}` : ''}`;

  return (
    <CareersChrome>
      <section className="jp-hero">
        <div className="jp-wrap">
          <h1>Find your next job</h1>
          <p>Open jobs from TeamLink Consultants. Apply in two minutes — no account needed.</p>
          <form className="jp-search" onSubmit={search} role="search">
            <label className="jp-sr" htmlFor="jpQ">Job title or skill</label>
            <input id="jpQ" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Job title or skill (e.g. Java, Teacher)" maxLength={120} />
            <label className="jp-sr" htmlFor="jpLoc">City</label>
            <input id="jpLoc" value={loc} onChange={(e) => setLoc(e.target.value)} placeholder="City (e.g. Hyderabad)" maxLength={80} />
            <button className="jp-btn jp-btn-primary" type="submit">Search jobs</button>
          </form>
        </div>
      </section>

      <div className="jp-wrap jp-results">
        <aside className={`jp-filters${showFilters ? ' is-open' : ''}`} aria-label="Filters">
          <div className="jp-filters-head">
            <h2>Filters</h2>
            {anyFilter && <button type="button" className="jp-link" onClick={clearAll}>Clear all</button>}
          </div>
          {data && FILTERS.map((f) => {
            const opts = (data.facets && data.facets[f.key]) || [];
            const cur = query[f.key];
            if (!opts.length && !cur) return null;
            return (
              <fieldset key={f.key} className="jp-facet">
                <legend>{f.label}</legend>
                {cur && !opts.some((o) => o.value === cur) && (
                  <button type="button" className="jp-chip is-on" onClick={() => setParam(f.key, '')}>{cur} ✕</button>
                )}
                {opts.map((o) => (
                  <button
                    type="button"
                    key={o.value}
                    className={`jp-chip${cur === o.value ? ' is-on' : ''}`}
                    aria-pressed={cur === o.value}
                    onClick={() => setParam(f.key, cur === o.value ? '' : o.value)}
                  >
                    {o.label} <span className="jp-chip-n">{o.count}</span>
                  </button>
                ))}
              </fieldset>
            );
          })}
        </aside>

        <section className="jp-list" aria-live="polite">
          <div className="jp-list-head">
            <div>
              <b>{data ? `${data.total} ${data.total === 1 ? 'job' : 'jobs'}` : 'Loading jobs…'}</b>
              {data && anyFilter && data.totalOpen !== data.total && <span className="jp-muted">{` of ${data.totalOpen} open`}</span>}
            </div>
            <div className="jp-list-tools">
              <button type="button" className="jp-btn jp-btn-ghost jp-only-phone" onClick={() => setShowFilters((v) => !v)}>
                {showFilters ? 'Hide filters' : `Filters${active.length ? ` (${active.length})` : ''}`}
              </button>
              {query.q && (
                <div className="jp-sort" role="group" aria-label="Sort">
                  <button type="button" className={query.sort !== 'relevant' ? 'is-on' : ''} onClick={() => setParam('sort', '')}>Newest</button>
                  <button type="button" className={query.sort === 'relevant' ? 'is-on' : ''} onClick={() => setParam('sort', 'relevant')}>Best match</button>
                </div>
              )}
            </div>
          </div>

          {active.length > 0 && (
            <div className="jp-active">
              {active.map((f) => {
                const opt = ((data && data.facets[f.key]) || []).find((o) => o.value === query[f.key]);
                return (
                  <button type="button" key={f.key} className="jp-chip is-on" onClick={() => setParam(f.key, '')}>
                    {`${f.label}: ${opt ? opt.label : query[f.key]}`} ✕
                  </button>
                );
              })}
            </div>
          )}

          {error && <div className="jp-note is-red" role="alert">{error}</div>}

          {data && data.jobs.map((j) => (
            <article key={j.id} className="jp-card">
              <Link to={jobLink(j.slug || j.id)} className="jp-card-main">
                <h3>{j.title}</h3>
                <div className="jp-card-co">{j.company}{j.location ? ` · ${j.location}` : ''}</div>
                <div className="jp-meta">
                  {j.experience && <span>💼 {j.experience}</span>}
                  {j.workMode && <span>🏠 {j.workMode}</span>}
                  {j.employmentType && <span>🕒 {j.employmentType}</span>}
                  {j.salary && <span>💰 {j.salary}</span>}
                  {j.openings > 1 && <span>👥 {j.openings} openings</span>}
                </div>
                {j.snippet && <p className="jp-snippet">{j.snippet}</p>}
                {j.skills.length > 0 && <div className="jp-skills">{j.skills.slice(0, 7).join(' · ')}</div>}
              </Link>
              <div className="jp-card-foot">
                <span className="jp-muted">{daysAgo(j.postedAt)}</span>
                <Link className="jp-btn jp-btn-primary" to={jobLink(j.slug || j.id)}>View &amp; apply</Link>
              </div>
            </article>
          ))}

          {data && data.jobs.length === 0 && (
            <div className="jp-empty">
              {anyFilter ? (
                <>
                  <b>No jobs match your search.</b>
                  <p>Try fewer filters or another word.</p>
                  <button type="button" className="jp-btn jp-btn-primary" onClick={clearAll}>Show all jobs</button>
                </>
              ) : (
                <>
                  <b>No open jobs right now.</b>
                  <p>New jobs are added every week — please check again soon.</p>
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </CareersChrome>
  );
}
