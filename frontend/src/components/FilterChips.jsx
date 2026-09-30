import './HierarchyFilter.css';

// ---------------------------------------------------------------------------
// ACTIVE FILTER CHIPS (spec §22) — "Filters: Department = Medical × | TL = Keerthana ×  Clear All"
//
//   <FilterChips
//     filters={[{ key: 'department', label: 'Department', value: 'Medical', onRemove: () => … }]}
//     onClearAll={() => …}          // optional; omit to hide "Clear All"
//   />
//
// Renders nothing when no filter is active. Items with an empty value are
// skipped, so a page can pass every filter it has and let this decide.
// hierarchyChips() in HierarchyFilter.jsx builds the Department / Section /
// TL / Recruiter items for you.
// ---------------------------------------------------------------------------
export default function FilterChips({ filters = [], onClearAll, label = 'Filters:', className = '' }) {
  const list = (filters || []).filter((f) => f && f.value !== '' && f.value !== null && f.value !== undefined && f.value !== false);
  if (!list.length) return null;
  return (
    <div className={`filter-chips${className ? ` ${className}` : ''}`} role="group" aria-label="Active filters">
      <span className="filter-chips-lead">{label}</span>
      {list.map((f, i) => (
        <span key={f.key || `${f.label}-${i}`} className="filter-chips-item">
          {i > 0 && <span className="filter-chips-sep" aria-hidden="true">|</span>}
          <span className="filter-chips-chip">
            <span className="filter-chips-k">{f.label}</span>
            <span className="filter-chips-eq"> = </span>
            <b className="filter-chips-v">{String(f.value)}</b>
            {f.onRemove && (
              <button type="button" className="filter-chips-x" onClick={f.onRemove} aria-label={`Remove ${f.label} filter`} title={`Remove ${f.label}`}>
                ×
              </button>
            )}
          </span>
        </span>
      ))}
      {onClearAll && (
        <button type="button" className="filter-chips-clear" onClick={onClearAll}>Clear All</button>
      )}
    </div>
  );
}
