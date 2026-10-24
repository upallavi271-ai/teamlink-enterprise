// Plain-words reminder of what is still empty in a form (replaces the red "*").
// items: [[ 'the payment date', true ], ...]  -> a pair is listed while its flag is true.
// Shows nothing when everything is filled in.
export default function MissingHint({ items }) {
  const gaps = (items || []).filter((x) => x && x[1]).map((x) => x[0]);
  if (!gaps.length) return null;
  const last = gaps.length > 1 ? ` and ${gaps[gaps.length - 1]}` : '';
  const text = gaps.length > 1 ? gaps.slice(0, -1).join(', ') + last : gaps[0];
  return <div className="missing-hint" role="status" style={{ fontSize: 12.5, color: 'var(--red, #B02318)', marginTop: 6 }}>Please add {text}.</div>;
}
