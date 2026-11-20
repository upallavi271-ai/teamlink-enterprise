import './reminders.css';

// The venue / contact details the reminder messages use. All optional, flagged "needed for offline reminders" (an offline interview) or
// "needed for the reminders" (a joining). Interview: venue name, full address, map link, contact person and phone, what to carry.
// Joining: reporting time, place, address, map link, contact person and phone, HR contact, documents to bring.
// `hideAddress`: the booking window already has its own Address box.
function Field({
  k, label, ph, type = 'text', wide = false, need, value, onChange, disabled,
}) {
  return (
    <label style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <span>{label}{need}</span>
      <input type={type} disabled={disabled} placeholder={ph} value={value[k] || ''} onChange={(e) => onChange({ ...value, [k]: e.target.value })} />
    </label>
  );
}

export default function ReminderDetailsFields({
  kind = 'interview', value, onChange, hideAddress = false, disabled = false,
}) {
  const v = value || {};
  const need = <span className="rem-need">{kind === 'joining' ? ' · needed for the reminders' : ' · needed for offline reminders'}</span>;
  const p = {
    value: v, onChange, disabled, need,
  };
  return (
    <div className="rem-grid">
      {kind === 'joining' && <Field {...p} k="reportingTime" label="Reporting time" type="time" />}
      <Field {...p} k="venueName" label={kind === 'joining' ? 'Place to report to' : 'Venue name'} ph={kind === 'joining' ? 'e.g. Apollo Hospital, HR office' : 'e.g. Apollo Hospital, Block B'} />
      {!hideAddress && <Field {...p} k="address" label="Full address" ph="Street, area, city, pin code" wide />}
      <Field {...p} k="mapLink" label="Map link" ph="https://maps.app.goo.gl/..." wide />
      <Field {...p} k="contactName" label="Contact person" ph="Name" />
      <Field {...p} k="contactPhone" label="Contact phone" ph="Mobile number" />
      {kind === 'joining' && <Field {...p} k="hrContact" label="HR contact" ph="Name and phone" wide />}
      <Field {...p} k="carry" label={kind === 'joining' ? 'Documents to bring' : 'Carry (ID proof, resume ...)'} ph="Leave empty for the usual list" wide />
    </div>
  );
}
