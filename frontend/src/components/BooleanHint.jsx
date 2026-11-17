// The small line under the Candidates search box (ATS audit 2026-11-17): how to write a boolean search, and whether the box is
// reading the text as one. The server decides (routes/candidates.js searchCtxOf); this only mirrors its rule to say so at once.
export const looksBoolean = (s) => {
  const t = String(s || '');
  return !!t.trim() && (/(^|[\s()])(AND|OR|NOT)(?=$|[\s()"])/.test(t) || /["()]/.test(t) || /(^|\s)-[^\s-]/.test(t));
};

export default function BooleanHint({ text, mode, error }) {
  const on = looksBoolean(text);
  if (on && error) return <span style={{ color: 'var(--red, #b91c1c)' }}>{`Boolean search: ${error} Searching the plain words instead.`}</span>;
  return (
    <span title={'Example: (java OR kotlin) AND "spring boot" NOT intern. Searches name, skills, designation, current company, location and resume text. Capital AND / OR / NOT; -word also means NOT.'}>
      {on || mode === 'boolean' ? <b>Boolean search on · </b> : null}
      Boolean search: AND OR NOT &quot;phrase&quot; ( )
    </span>
  );
}
