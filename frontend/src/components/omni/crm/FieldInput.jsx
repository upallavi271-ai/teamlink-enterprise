import Combo from '../../Combo.jsx';
import MultiPick from '../../MultiPick.jsx';

// ONE input for one custom field, by its type. value: a string; an array for the multi-choice type; 'yes' for a ticked checkbox.
// Dropdowns are searchable (Combo / MultiPick). Used by the Add / Edit customer box and the public Web Form.
export default function FieldInput({ field, value, onChange, disabled, id }) {
  const v = value == null ? '' : value;
  const set = (x) => onChange(x);
  switch (field.type) {
    case 'dropdown':
      return <Combo id={id} value={v} onChange={(e) => set(e.target.value)} disabled={disabled}><option value="">-- Select --</option>{(field.options || []).map((o) => <option key={o} value={o}>{o}</option>)}</Combo>;
    case 'multi':
      return <MultiPick id={id} options={(field.options || []).map((o) => ({ value: o, label: o }))} value={Array.isArray(v) ? v : []} onChange={set} disabled={disabled} placeholder="-- Select --" />;
    case 'longtext':
      return <textarea id={id} value={v} maxLength={2000} disabled={disabled} onChange={(e) => set(e.target.value)} style={{ minHeight: 70 }} />;
    case 'checkbox':
      return <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}><input id={id} type="checkbox" checked={v === 'yes'} disabled={disabled} onChange={(e) => set(e.target.checked ? 'yes' : '')} style={{ width: 16, height: 16 }} /> Yes</label>;
    case 'date':
      return <input id={id} type="date" value={v} disabled={disabled} onChange={(e) => set(e.target.value)} />;
    case 'datetime':
      return <input id={id} type="datetime-local" value={v} disabled={disabled} onChange={(e) => set(e.target.value)} />;
    case 'number':
    case 'currency':
      return <input id={id} inputMode="decimal" value={v} disabled={disabled} placeholder={field.type === 'currency' ? '₹ amount' : 'Number'} onChange={(e) => set(e.target.value)} />;
    case 'email':
      return <input id={id} type="email" value={v} maxLength={160} disabled={disabled} placeholder="name@example.com" onChange={(e) => set(e.target.value)} />;
    case 'phone':
      return <input id={id} inputMode="tel" value={v} maxLength={20} disabled={disabled} placeholder="+91…" onChange={(e) => set(e.target.value)} />;
    case 'url':
      return <input id={id} inputMode="url" value={v} maxLength={300} disabled={disabled} placeholder="https://" onChange={(e) => set(e.target.value)} />;
    default:
      return <input id={id} value={v} maxLength={200} disabled={disabled} onChange={(e) => set(e.target.value)} />;
  }
}
