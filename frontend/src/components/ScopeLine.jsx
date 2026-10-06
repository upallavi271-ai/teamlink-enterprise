// ---------------------------------------------------------------------------
// "Scope: My Team · 12 candidates" (§43).
//
// Every ATS list used to say only how MANY rows it had — "12 candidates in
// your scope" — which tells the reader the length but not the reason. The
// label is computed once by utils/scope.js scopeLabel() and arrives on the
// session, so no two screens can word it differently and it can never
// disagree with what the API actually returns.
// ---------------------------------------------------------------------------
import { Help } from './ui/Guide.jsx';

const AREA_TIP = 'Your area = the jobs and people you are allowed to see. It comes from your role and your team.';

export default function ScopeLine({ user, count, noun, inline = false }) {
  const label = user && user.scope ? user.scope.label : null;
  // Never a bare zero (also covers the moment before the list has loaded):
  // with no rows the line is just "Your area: <label>".
  const rows = Number(count) > 0 ? `${Number(count).toLocaleString('en-IN')} ${noun}${count === 1 ? '' : 's'}` : '';
  if (!label) return rows ? <>{rows} in your area</> : null;
  return (
    <>
      {!inline && <b className="scope-tag">Your area: {label}<Help text={AREA_TIP} /></b>}
      {inline && <span className="scope-tag-inline">Your area: {label}<Help text={AREA_TIP} /></span>}
      {rows ? <>{' · '}{rows}</> : null}
    </>
  );
}
