// ---------------------------------------------------------------------------
// ONE CHECKBOX LIST FOR A COMMA-SEPARATED SCOPE COLUMN.
//
// "departments ki kindha check box kuda ivvu — evariki enni departments add
// cheskovalo, anni cheskovadaniki."
//
// Department, team and client scope are all stored the same way: a
// comma-separated string on the User row (atsScopeDepartments,
// atsScopeTeams, atsScopeClients), which utils/scope.js reads. A free-text box
// meant an administrator had to know the exact spelling of every department
// and type the commas themselves — one typo and the scope silently matched
// nothing. Ticking boxes cannot be misspelt.
//
// The VALUE stays the comma-separated string, so nothing downstream changes:
// the same PUT body, the same column, the same scope rule.
//
// Lived in pages/Employees.jsx as a local helper for the Edit Scope dialog
// that moved to Administration -> Users. It is here so both screens use one
// copy rather than growing a second.
// ---------------------------------------------------------------------------

export function csvList(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export default function ScopeChecklist({
  label, hint, options, value, onChange, empty = 'Nothing to choose from yet.',
}) {
  const selected = csvList(value);

  function toggle(name, on) {
    const next = on ? [...selected, name] : selected.filter((s) => s !== name);
    onChange([...new Set(next)].join(','));
  }

  // Anything already on the record that is NOT in the option list still has to
  // be visible and removable — a department that was renamed or deleted after
  // the scope was set would otherwise be invisible AND permanent.
  const known = new Set(options.map((o) => o.value));
  const orphans = selected.filter((s) => !known.has(s));

  return (
    <div className="field">
      <label>{label}</label>
      {hint && <div className="small-muted" style={{ marginBottom: 6 }}>{hint}</div>}
      {options.length === 0 && orphans.length === 0
        ? <div className="empty-mini">{empty}</div>
        : (
          <div className="scope-checks">
            {options.map((o) => (
              <label key={o.value} className="scope-check">
                <input
                  type="checkbox"
                  checked={selected.includes(o.value)}
                  onChange={(e) => toggle(o.value, e.target.checked)}
                />
                {o.label}
              </label>
            ))}
            {orphans.map((o) => (
              <label key={o} className="scope-check scope-check-orphan" title="No longer on the master list — untick to remove it">
                <input type="checkbox" checked onChange={(e) => toggle(o, e.target.checked)} />
                {o}
              </label>
            ))}
          </div>
        )}
      <div className="small-muted" style={{ marginTop: 6 }}>
        {selected.length === 0
          ? 'Nothing ticked — falls back to their own department and team.'
          : `${selected.length} selected: ${selected.join(', ')}`}
      </div>
    </div>
  );
}
