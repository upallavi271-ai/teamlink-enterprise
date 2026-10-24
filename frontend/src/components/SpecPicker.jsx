import { useSpecTree, deptOptionsOf, specName, qualName } from '../utils/specMaster';
import Combo from './Combo.jsx';

// ---------------------------------------------------------------------------
// QUALIFICATION + SPECIALIZATION — two dropdowns that follow the Department
// (spec D, 2026-10-03). Options come from the Admin's master list
// (Administration -> Master lists); switched-off values are not offered, but
// a value already saved stays visible so it is never silently lost.
// Picking a specialization fills its qualification. The record's old free
// text shows as "Old value" until it is mapped.
//
//   <SpecPicker department="Medical" qualificationId={..} specialisationId={..}
//     oldValue="Dermatologist" onChange={({ qualificationId, specialisationId }) => …} />
// ---------------------------------------------------------------------------
export default function SpecPicker({
  department, qualificationId = '', specialisationId = '', oldValue = '', onChange, disabled = false, wrapClass = 'grid-2',
  // Typed values (2026-10-14): what was typed when the list had no match. canAdd = the BDE team / Admin (it joins the shared list).
  qualificationCustom = '', specialisationCustom = '', canAdd = false,
}) {
  const tree = useSpecTree();
  const d = deptOptionsOf(tree, department);
  const quals = d.qualifications || [];
  const specs = d.specialisations || [];
  if (tree && !quals.length && !specs.length && !department) {
    return oldValue ? <div className="small-muted" style={{ margin: '-4px 0 8px' }}>{`Specialization (old value): ${oldValue}`}</div> : null;
  }
  const specList = qualificationId ? specs.filter((s) => s.qualificationId === qualificationId) : specs;
  const qualKnown = !qualificationId || quals.some((q) => q.id === qualificationId);
  const specKnown = !specialisationId || specs.some((s) => s.id === specialisationId);
  const isQual = (id) => quals.some((q) => q.id === id);
  const isSpec = (id) => specs.some((s) => s.id === id);
  const pickQual = (id) => {
    if (id && !isQual(id)) { onChange({ qualificationId: '', qualificationCustom: id, specialisationId: '', specialisationCustom: specialisationId ? '' : specialisationCustom }); return; }
    const keep = specs.find((s) => s.id === specialisationId);
    onChange({ qualificationId: id, qualificationCustom: '', specialisationId: keep && (!id || keep.qualificationId === id) ? specialisationId : '' });
  };
  const pickSpec = (id) => {
    if (id && !isSpec(id)) { onChange({ specialisationId: '', specialisationCustom: id }); return; }
    const s = specs.find((x) => x.id === id);
    onChange({ qualificationId: s && s.qualificationId ? s.qualificationId : qualificationId, qualificationCustom: s && s.qualificationId ? '' : qualificationCustom, specialisationId: id, specialisationCustom: '' });
  };
  const cl = canAdd ? 'Add' : 'Use';
  const fields = (
    <>
        <label className="field">
          <span>Qualification</span>
          <Combo value={qualificationId || qualificationCustom || ''} disabled={disabled || !tree} allowCustom customLabel={cl} onChange={(e) => pickQual(e.target.value)}>
            <option value="">{tree ? 'Not picked' : 'Loading…'}</option>
            {!qualKnown && <option value={qualificationId}>(switched off)</option>}
            {quals.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
          </Combo>
        </label>
        <label className="field">
          <span>Specialization</span>
          <Combo value={specialisationId || specialisationCustom || ''} disabled={disabled || !tree} allowCustom customLabel={cl} onChange={(e) => pickSpec(e.target.value)}>
            <option value="">{tree ? 'Not picked' : 'Loading…'}</option>
            {!specKnown && <option value={specialisationId}>(switched off)</option>}
            {qualificationId
              ? specList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)
              // No qualification picked yet: the list grouped by qualification.
              : [...quals.map((q) => ({ q, list: specs.filter((s) => s.qualificationId === q.id) })),
                { q: null, list: specs.filter((s) => !quals.some((q) => q.id === s.qualificationId)) }]
                .filter((g) => g.list.length)
                .map((g) => (g.q
                  ? <optgroup key={g.q.id} label={g.q.name}>{g.list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>
                  : g.list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)))}
          </Combo>
          {(qualificationCustom || specialisationCustom) && !canAdd && (
            <small className="small-muted" style={{ display: 'block', marginTop: 3 }}>{`${[qualificationCustom, specialisationCustom].filter(Boolean).join(' · ')} is your own value — not in the list yet. It stays on this requirement.`}</small>
          )}
          {oldValue && !specialisationId && !specialisationCustom && (
            <small className="small-muted" style={{ display: 'block', marginTop: 3 }}>{`Old value: "${oldValue}" — not mapped yet`}</small>
          )}
        </label>
    </>
  );
  // wrapClass={null}: the two fields go straight into the parent's grid.
  return wrapClass ? <div className={wrapClass}>{fields}</div> : fields;
}

// "MD · Dermatology", or the old free text until it is mapped.
export function SpecLabel({ qualificationId, specialisationId, oldValue }) {
  const tree = useSpecTree();
  if (specialisationId || qualificationId) {
    const text = [qualName(tree, qualificationId), specName(tree, specialisationId)].filter(Boolean).join(' · ');
    return text || (tree ? 'Switched off in Master lists' : '…');
  }
  return oldValue ? `${oldValue} (not in the list)` : '';
}
