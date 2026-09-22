// ---------------------------------------------------------------------------
// "Scope: My Team · 12 candidates" (§43).
//
// Every ATS list used to say only how MANY rows it had — "12 candidates in
// your scope" — which tells the reader the length but not the reason. The
// label is computed once by utils/scope.js scopeLabel() and arrives on the
// session, so no two screens can word it differently and it can never
// disagree with what the API actually returns.
// ---------------------------------------------------------------------------
export default function ScopeLine({ user, count, noun, inline = false }) {
  const label = user && user.scope ? user.scope.label : null;
  const rows = `${count} ${noun}${count === 1 ? '' : 's'}`;
  if (!label) return <>{rows} in your scope</>;
  return (
    <>
      {!inline && <b className="scope-tag">Scope: {label}</b>}
      {inline && <span className="scope-tag-inline">Scope: {label}</span>}
      {' · '}{rows}
    </>
  );
}
