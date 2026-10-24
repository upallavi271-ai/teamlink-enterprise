import { useMemo } from 'react';
import MultiPick from '../MultiPick.jsx';
import { prefToList, listToPref, ANY_LOCATION, placeInList } from './jobLocations.js';

// ---------------------------------------------------------------------------
// PLACES ON A JOB, ONE CONTROL (user, 2026-10-14): "Location details must be clear; if I choose Other there must be an option to type it."
//   - a searchable list of places (type letters to filter), chips for the chosen ones, Remote / Any location buttons
//   - "Other (type it)" at the end of the list: a box "Type the place" + Add (Enter adds)
//   - a place typed by the client manager (BDE) team or an Admin also joins the shared list (everyone is offered it later);
//     anybody else's typed place stays on this job only and shows "not in the list"
//   - one plain line under the field: "Location: Hyderabad, Pune, Remote"
// multi (default): the Preferred locations of a job, stored as "Hyderabad, Pune" / "Remote" / "" (any).
// single:          the Work location, one place, stored as the place's name.
// places: the result of useJobLocations() (shared by every picker on the form).
// ---------------------------------------------------------------------------
export default function LocationPicker({ places, value, onChange, single = false, disabled = false, placeholder, searchPlaceholder = 'Type a city or office' }) {
  const list = single ? (String(value || '').trim() ? [String(value).trim()] : []) : prefToList(value);
  const specials = useMemo(() => (single ? [] : places.special), [single, places.special]);
  const pushOut = (next) => {
    if (single) onChange(next[0] || '');
    else onChange(listToPref(next) === 'Any' ? '' : listToPref(next));
  };
  const summary = single
    ? (list.length ? list[0] : 'not chosen yet')
    : (list.length ? list.join(', ') : ANY_LOCATION);
  return (
    <div className="locpick">
      <MultiPick
        options={places.options}
        special={specials}
        value={list}
        single={single}
        loading={places.loading}
        disabled={disabled}
        placeholder={placeholder || (single ? 'Pick the place of work' : 'Any location')}
        searchPlaceholder={searchPlaceholder}
        emptyText="No places yet. Type the place."
        notInList={(v) => !places.loading && v !== ANY_LOCATION && !placeInList(places.options, v)}
        // Type your own place: the client manager (BDE) team and Admin add it to the shared list ('Add'); for anybody else it is kept on this job only ('Use').
        allowCustom={!disabled}
        customLabel={places.canAdd ? 'Add' : 'Use'}
        onCreateOption={places.canAdd ? ((name) => places.add(name)) : null}
        onChange={pushOut}
      />
      <div className="locpick-sum">{`Location: ${summary}`}</div>
    </div>
  );
}
