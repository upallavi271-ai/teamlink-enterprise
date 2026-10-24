// ---------------------------------------------------------------------------
// WHERE THE CLIENT IS — Country -> State -> District / City -> Pincode
// (user, 2026-10-09; typing added 2026-10-15). Every list is a dropdown you can ALSO TYPE INTO: pick from the
// list, or type a place that is not there (another country, a state, a town). Telangana and Andhra Pradesh come
// first (utils/indiaPlaces.js; the 28 states + 8 union territories, districts copied from the Job Portal).
//
// The form keeps TEXT in form.country / form.state / form.location / form.pincode, exactly as before, so nothing
// on the server changes and a value that "Fill from a file" put there shows in the right box.
//
// `Field` is ClientForm's own wrapper (label, red/green marks), passed in so the file-fill marks keep working.
// ---------------------------------------------------------------------------
import { INDIA_STATE_LIST, UNION_TERRITORIES, districtsOf, matchState, matchDistrict } from '../../utils/indiaPlaces';
import Combo from '../Combo.jsx';

const isIndia = (c) => !String(c || '').trim() || /^india$/i.test(String(c).trim());

// THE LOCATION BOX (2026-10-22) - "Location (city / branch)", at the TOP of the form next to the company name. The same company can be a
// client at several places (Palnadu Hospital at Narasaraopet, at Guntur ...), each its own client with its own agreement; the Location is
// what tells them apart. It is the same value as the old "District / City" (form.location, Client.location), so nothing else changes.
// Type-to-search: the districts of the picked state, and the places already added for this company name ("Already added").
// Never a required star; when a client with this name exists the form asks for it in plain words.
export function LocationField({ Field, form, set, errors = {}, usedPlaces = [] }) {
  const india = isIndia(form.country);
  const stateHit = matchState(form.state);
  const districts = india && stateHit ? districtsOf(stateHit) : [];
  const used = [...new Set((usedPlaces || []).map((x) => String(x || '').trim()).filter(Boolean))];
  const rest = districts.filter((d) => !used.some((u) => u.toLowerCase() === d.toLowerCase()));
  const pick = (v) => set({ location: (stateHit && matchDistrict(stateHit, v)) || v });
  return (
    <Field
      id="location"
      label="Location (city / branch)"
      error={errors.location}
      hint={used.length ? `Already added for this name: ${used.join(', ')}.` : 'Where this client is. The same company can have more than one place, so write which one.'}
    >
      <Combo allowCustom value={form.location || ''} onChange={(e) => pick(e.target.value)} placeholder="Pick or type the city or branch">
        <option value="">Pick or type a place</option>
        {used.length > 0 && <optgroup label="Already added for this name">{used.map((d) => <option key={`u-${d}`} value={d}>{d}</option>)}</optgroup>}
        {rest.map((d) => <option key={d} value={d}>{d}</option>)}
      </Combo>
    </Field>
  );
}

export default function PlaceFields({ Field, form, set, errors = {} }) {
  // --- Country ---
  const india = isIndia(form.country);

  // --- State (India only) ---
  const stateHit = matchState(form.state);
  // The district list is the picked state's. With a typed (unlisted) or no state there is none.
  const pickCountry = (v) => {
    if (isIndia(v)) { set({ country: 'India' }); return; }
    // A typed country: the India state / district no longer apply.
    set({ country: v, ...(india ? { state: '' } : {}) });
  };
  const pickState = (v) => {
    const hit = matchState(v);
    // A new state clears a district that belongs to the OLD state; a branch or place the user wrote is kept.
    const wasOldDistrict = stateHit && form.location && matchDistrict(stateHit, form.location);
    const keep = !wasOldDistrict || (hit && matchDistrict(hit, form.location));
    set({ state: hit || v, location: keep ? form.location : '' });
  };

  return (
    <>
      <Field id="country" label="Country">
        <Combo allowCustom value={india ? 'India' : form.country} onChange={(e) => pickCountry(e.target.value)} placeholder="Pick or type a country">
          <option value="India">India</option>
        </Combo>
      </Field>

      {india ? (
        <Field id="state" label="State">
          <Combo allowCustom value={form.state || ''} onChange={(e) => pickState(e.target.value)} placeholder="Pick or type a state">
            <option value="">Pick a state</option>
            {INDIA_STATE_LIST.filter((s) => !UNION_TERRITORIES.includes(s)).map((s) => <option key={s} value={s}>{s}</option>)}
            <optgroup label="Union territories">
              {UNION_TERRITORIES.map((s) => <option key={s} value={s}>{s}</option>)}
            </optgroup>
          </Combo>
        </Field>
      ) : (
        <Field id="state" label="State / region">
          <input value={form.state || ''} placeholder="Type the state or region" onChange={(e) => set({ state: e.target.value })} />
        </Field>
      )}

      <Field id="pincode" label="Pincode" error={errors.pincode}>
        <input
          value={form.pincode || ''}
          inputMode="numeric"
          maxLength={6}
          placeholder="e.g. 500072"
          onChange={(e) => set({ pincode: e.target.value.replace(/\D/g, '').slice(0, 6) })}
        />
      </Field>
    </>
  );
}
