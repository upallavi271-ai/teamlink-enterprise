import { useId, useState } from 'react';

// ---------------------------------------------------------------------------
// "INSIGHTS": every chart and tile of the Candidates page (the count tiles, the pipeline steps, Needs attention, Top requirements,
// Quick actions, the donut, the funnel, by location and by source) in ONE section under the table. Closed until opened;
// the choice is remembered per person. The children are drawn only while it is open.
// ---------------------------------------------------------------------------
export default function InsightsFold({ uid, children, note }) {
  const key = `tl.candidates.insights.${uid || 'anon'}`;
  const id = useId().replace(/:/g, '');
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(key) === '1'; } catch { return false; } });
  const toggle = () => setOpen((o) => { const n = !o; try { localStorage.setItem(key, n ? '1' : '0'); } catch { /* not remembered */ } return n; });
  return (
    <section className="cv4-fold" aria-label="Insights">
      <button type="button" className="cv4-fold-head" aria-expanded={open} aria-controls={`ins-${id}`} onClick={toggle}>
        <span aria-hidden="true" className="cv4-fold-caret">{open ? '▾' : '▸'}</span>
        <b>Insights</b>
        <span className="small-muted">{note || 'Pipeline steps, needs attention, top requirements, by location and by source'}</span>
      </button>
      {open && <div id={`ins-${id}`} className="cv4-fold-body">{children}</div>}
    </section>
  );
}
