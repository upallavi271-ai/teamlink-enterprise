import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import api from '../api';
import './missedItems.css';

// ---------------------------------------------------------------------------
// MY MISSED ITEMS (user, 2026-10-12: "Vallu emina todos leka follow-ups miss ayithe, reminder msg Recruiter ki, TL ki kuda vellali").
// The box the reminder points to: what I missed - follow-ups, calls not made, tasks and to-dos, candidates waiting for my check, interview
// feedback not recorded, late steps - each with an Open button. Only my own rows (GET /api/pending-work/my-missed). Used on my dashboard
// (widget type 'missed') and on My reports -> My follow-ups.
// Four colours: red = late, green = nothing missed.
// ---------------------------------------------------------------------------
const SHOW = 4;

function Group({ g }) {
  const [all, setAll] = useState(false);
  const rows = all ? g.items : g.items.slice(0, SHOW);
  return (
    <div className="msd-group">
      <div className="msd-gh">{g.label} <span className="msd-n">{g.n}</span></div>
      <ul className="msd-list">
        {rows.map((i) => (
          <li key={i.key} className="msd-row">
            <span className="msd-t">
              {i.title}
              {i.sub && <small>{i.sub}</small>}
            </span>
            <span className={`msd-late${i.daysLate ? '' : ' is-today'}`}>{i.daysLate ? `${i.daysLate} ${i.daysLate === 1 ? 'day' : 'days'} late` : 'due today'}</span>
            <Link className="btn btn-sm" to={i.link}>Open</Link>
          </li>
        ))}
      </ul>
      {g.n > SHOW && <button type="button" className="link-btn msd-more" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${g.n}`}</button>}
    </div>
  );
}

export default function MissedItemsBox() {
  const [st, setSt] = useState({ loading: true, data: null, error: '' });
  const location = useLocation();
  useEffect(() => {
    let live = true;
    api.get('/pending-work/my-missed')
      .then((r) => { if (live) setSt({ loading: false, data: r.data, error: '' }); })
      .catch((e) => { if (live) setSt({ loading: false, data: null, error: e.response?.data?.error || 'Could not load your missed items. Please try again.' }); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (st.data && location.hash === '#missed-items') {
      const el = document.getElementById('missed-items');
      if (el) el.scrollIntoView({ behavior: 'auto', block: 'start' });
    }
  }, [st.data, location.hash]);

  const d = st.data;
  return (
    <section className="msd" id="missed-items" aria-label="My missed items">
      <div className="msd-head">
        <h3>My missed items</h3>
        {d && (d.total ? <span className="msd-pill is-red">{d.total}</span> : <span className="msd-pill is-green">All caught up</span>)}
      </div>
      {st.loading && <div className="small-muted">Looking at your list…</div>}
      {st.error && <div className="notice red">{st.error}</div>}
      {d && !d.total && <p className="msd-ok"><span aria-hidden="true">✓</span> Nothing missed. You are on time.</p>}
      {d && d.total > 0 && (
        <>
          <p className="msd-sum">{String(d.summary || '').replace(/\s*Open your list\.\s*$/, '')}</p>
          {d.groups.map((g) => <Group key={g.kind} g={g} />)}
        </>
      )}
    </section>
  );
}
