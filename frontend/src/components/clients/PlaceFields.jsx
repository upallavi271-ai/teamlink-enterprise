// ---------------------------------------------------------------------------
// WHERE THE CLIENT IS — Country -> State -> District / City -> Pincode
// (user, 2026-10-09). Every list is a plain dropdown; the last choice of each
// is "Other…", which opens a text box so a place that is not in the list can
// be typed. Telangana and Andhra Pradesh come first (utils/indiaPlaces.js; the
// 28 states + 8 union territories, districts copied from the Job Portal).
//
// The form keeps TEXT in form.country / form.state / form.location /
// form.pincode, exactly as before, so nothing on the server changes and a
// value that "Fill from a file" put there lands in the right dropdown (or in
// "Other…" with its text) with no extra step. A saved place that is not in the
// list re-opens as "Other…" with the text in the box.
//
// `Field` is ClientForm's own wrapper (label, red/green marks), passed in so
// the file-fill marks keep working on these four fields.
// ---------------------------------------------------------------------------
import { useState } from 'react';
import { INDIA_STATE_LIST, UNION_TERRITORIES, districtsOf, matchState, matchDistrict } from '../../utils/indiaPlaces';

const OTHER = '__other__';
const isIndia = (c) => !String(c || '').trim() || /^india$/i.test(String(c).trim());

export default function PlaceFields({ Field, form, set, errors = {} }) {
  const [countryOther, setCountryOther] = useState(false);
  const [stateOther, setStateOther] = useState(false);
  const [districtOther, setDistrictOther] = useState(false);

  // --- Country ---
  const india = isIndia(form.country) && !countryOther;
  const countrySelect = india ? 'India' : OTHER;

  // --- State (India only) ---
  const stateHit = matchState(form.state);
  const stateIsOther = !!String(form.state || '').trim() ? !stateHit : stateOther;
  const stateSelect = stateIsOther ? OTHER : stateHit;
  // The district list is the picked state's. With "Other…" (or no) state there is none.
  const districts = stateHit && !stateIsOther ? districtsOf(stateHit) : [];
  const districtHit = stateHit ? matchDistrict(stateHit, form.location) : '';
  const districtIsOther = !!String(form.location || '').trim() ? !districtHit : districtOther;
  const districtSelect = districtIsOther ? OTHER : districtHit;

  const pickCountry = (v) => {
    if (v === OTHER) { setCountryOther(true); set({ country: '', state: '', location: '' }); return; }
    setCountryOther(false); set({ country: 'India' });
  };
  const pickState = (v) => {
    if (v === OTHER) { setStateOther(true); set({ state: '', location: '' }); setDistrictOther(false); return; }
    setStateOther(false); setDistrictOther(false);
    // A new state clears a district that belongs to the old one.
    set({ state: v, location: v && matchDistrict(v, form.location) ? form.location : '' });
  };
  const pickDistrict = (v) => {
    if (v === OTHER) { setDistrictOther(true); set({ location: '' }); return; }
    setDistrictOther(false); set({ location: v });
  };

  return (
    <>
      <Field id="country" label="Country">
        <select value={countrySelect} onChange={(e) => pickCountry(e.target.value)}>
          <option value="India">India</option>
          <option value={OTHER}>Other country…</option>
        </select>
        {!india && (
          <input value={form.country || ''} placeholder="Type the country" onChange={(e) => set({ country: e.target.value })} />
        )}
      </Field>

      {india ? (
        <Field id="state" label="State">
          <select value={stateSelect} onChange={(e) => pickState(e.target.value)}>
            <option value="">Pick a state</option>
            {INDIA_STATE_LIST.filter((s) => !UNION_TERRITORIES.includes(s)).map((s) => <option key={s} value={s}>{s}</option>)}
            <optgroup label="Union territories">
              {UNION_TERRITORIES.map((s) => <option key={s} value={s}>{s}</option>)}
            </optgroup>
            <option value={OTHER}>Other…</option>
          </select>
          {stateIsOther && (
            <input value={form.state || ''} placeholder="Type the state" onChange={(e) => set({ state: e.target.value })} />
          )}
        </Field>
      ) : (
        <Field id="state" label="State / region">
          <input value={form.state || ''} placeholder="Type the state or region" onChange={(e) => set({ state: e.target.value })} />
        </Field>
      )}

      {india && districts.length > 0 ? (
        <Field id="location" label="District / City">
          <select value={districtSelect} onChange={(e) => pickDistrict(e.target.value)}>
            <option value="">Pick a district or city</option>
            {districts.map((d) => <option key={d} value={d}>{d}</option>)}
            <option value={OTHER}>Other…</option>
          </select>
          {districtIsOther && (
            <input value={form.location || ''} placeholder="Type the city, town or area" onChange={(e) => set({ location: e.target.value })} />
          )}
        </Field>
      ) : (
        <Field id="location" label="District / City" hint={india && !stateHit ? 'Pick the state first to get its list.' : undefined}>
          <input value={form.location || ''} placeholder="Type the city, town or area" onChange={(e) => set({ location: e.target.value })} />
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
