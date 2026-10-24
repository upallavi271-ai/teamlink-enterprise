import Combo from '../Combo.jsx';

// ---------------------------------------------------------------------------
// A DROPDOWN YOU CAN TYPE YOUR OWN VALUE INTO (user, 2026-10-14).
// One input with a caret: type letters to search; when what you need is not in the list the last row says
// 'Use “…”' and picking it (or pressing Enter) saves your own text. No separate "Other" box any more.
// options: plain strings. value: the stored text. onChange(text).
// otherLabel / typeLabel are kept so old callers still compile; they are not shown.
// ---------------------------------------------------------------------------
export default function ComboOther({ value, onChange, options, otherLabel = 'Other', disabled = false, className = '', placeholder, validateCustom, onCreateOption, customLabel }) {
  const list = options.filter((x) => x !== otherLabel);
  return (
    <Combo
      className={className}
      value={String(value || '')}
      disabled={disabled}
      placeholder={placeholder || 'Select or type your own'}
      allowCustom
      customLabel={customLabel}
      validateCustom={validateCustom}
      onCreateOption={onCreateOption}
      onChange={(e) => onChange(e.target.value)}
    >
      {list.map((x) => <option key={x} value={x}>{x}</option>)}
    </Combo>
  );
}
