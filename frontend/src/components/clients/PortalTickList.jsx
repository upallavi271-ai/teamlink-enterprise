// The tick-box list of "what can this client person do?" (user, 2026-10-09).
// Replaces the three choose-one cards. Used by the Add popup and by "Change what
// they can do" on Client 360 -> Portal access. The server (routes/portalLogins.js
// + utils/clientPortalTypes.js) is the judge; this only draws and fills the boxes.
//
//   - "See our jobs and candidates" is the base: ticking Shortlist / Interview /
//     Feedback ticks it for you and locks it while one of them is on.
//   - Select all / Clear, and small "Fill like Reviewer / Viewer / Billing" links.
const GROUPS = [['Look', 'What they can see'], ['Do', 'What they can do']];
const PRESET_WORDS = { REVIEWER: 'Reviewer', VIEWER: 'Viewer', BILLING: 'Billing' };

export default function PortalTickList({
  list = [], presets = [], needsView = [], value = [], onChange, disabled = false,
}) {
  const on = new Set(value);
  const lockedView = needsView.some((k) => on.has(k));
  const keys = list.map((c) => c.key);

  function set(next) {
    const s = new Set(next);
    if (needsView.some((k) => s.has(k))) s.add('VIEW');
    onChange(keys.filter((k) => s.has(k)));
  }
  function toggle(k) {
    if (disabled) return;
    if (k === 'VIEW' && lockedView) return;
    const s = new Set(value);
    if (s.has(k)) s.delete(k); else s.add(k);
    set([...s]);
  }

  return (
    <div className="tlpa-ticks">
      <div className="tlpa-tickbar">
        <span className="small-muted">Start from:</span>
        {presets.map((t) => (
          <button type="button" key={t.value} className="tlpa-linkbtn" disabled={disabled} onClick={() => set(t.perms)}>
            Fill like {PRESET_WORDS[t.value] || t.label}
          </button>
        ))}
        <span className="tlpa-tickspacer" />
        <button type="button" className="tlpa-linkbtn" disabled={disabled} onClick={() => set(keys)}>Select all</button>
        <button type="button" className="tlpa-linkbtn" disabled={disabled} onClick={() => onChange([])}>Clear</button>
      </div>

      {GROUPS.map(([g, title]) => {
        const rows = list.filter((c) => c.group === g);
        if (!rows.length) return null;
        return (
          <fieldset className="tlpa-tickgroup" key={g}>
            <legend>{title}</legend>
            {rows.map((c) => {
              const locked = c.key === 'VIEW' && lockedView;
              const checked = on.has(c.key);
              return (
                <label className={`tlpa-tick${checked ? ' on' : ''}${locked ? ' locked' : ''}`} key={c.key}>
                  <input type="checkbox" checked={checked} disabled={disabled || locked} onChange={() => toggle(c.key)} />
                  <span className="tlpa-ticktext">
                    <b>{c.label}</b>
                    <span>{locked ? 'Needed for the boxes you ticked below, so it stays ticked.' : c.hint}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        );
      })}

      <div className={`tlpa-tickcount${value.length ? '' : ' bad'}`}>
        {value.length
          ? `${value.length} ticked`
          : 'Nothing ticked yet.'}
      </div>
    </div>
  );
}
