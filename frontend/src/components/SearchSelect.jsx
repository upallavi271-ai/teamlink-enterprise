// SearchSelect — the name to use in new code for "a <select> you can type into".
//
// It IS components/Combo.jsx (one implementation, no fork), so it takes the
// same props as a native <select>: value, onChange (handed an event-like
// { target: { value, name } }), name, id, disabled, required, className,
// aria-*, and <option> / <optgroup> children. Add `creatable` only for fields
// that store a free string. Switching a call site is renaming the tag.
//
// (components/accounts/SearchSelect.jsx is a different, older employee picker
// with its own props; it is kept for the accounts screens.)
import Combo from './Combo.jsx';

export default Combo;
