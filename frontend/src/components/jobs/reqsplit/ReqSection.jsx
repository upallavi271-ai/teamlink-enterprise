// One LETTERED section of the classic Add / Edit job form (2026-10-14): a plain heading "A. Basic Information" and its fields.
// Always open, no counters, no collapsing (the user asked for the classic look). `n` is the section number (1 = A, 2 = B ...).
// The other props are accepted and ignored so the callers did not have to change.
export default function ReqSection({ id, n, title, bad = false, children }) {
  const letter = String.fromCharCode(64 + (Number(n) || 1));
  return (
    <section id={`rf-sec-${id}`} className={`rf-plain${bad ? ' bad' : ''}`}>
      <h3 className="rf-lh">{`${letter}. ${title}`}{bad && <span className="cf-bang" aria-label="has a problem"> !</span>}</h3>
      <div id={`rf-body-${id}`} className="rf-plain-body">{children}</div>
    </section>
  );
}
