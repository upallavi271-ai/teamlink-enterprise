import { useSpecTree, deptOptionsOf, specName, qualName } from '../utils/specMaster';

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
}) {
  const tree = useSpecTree();
  const d = deptOptionsOf(tree, department);
  const quals = d.qualifications || [];
  const specs = d.specialisations || [];
  if (tree && !quals.length && !specs.length) {
    return oldValue ? <div className="small-muted" style={{ margin: '-4px 0 8px' }}>{`Specialization (old value): ${oldValue}`}</div> : null;
  }
  const specList = qualificationId ? specs.filter((s) => s.qualificationId === qualificationId) : specs;
  const qualKnown = !qualificationId || quals.some((q) => q.id === qualificationId);
  const specKnown = !specialisationId || specs.some((s) => s.id === specialisationId);
  const pickQual = (id) => {
    const keep = specs.find((s) => s.id === specialisationId);
    onChange({ qualificationId: id, specialisationId: keep && (!id || keep.qualificationId === id) ? specialisationId : '' });
  };
  const pickSpec = (id) => {
    const s = specs.find((x) => x.id === id);
    onChange({ qualificationId: s && s.qualificationId ? s.qualificationId : qualificationId, specialisationId: id });
  };
  const fields = (
    <>
        <label className="field">
          <span>Qualification</span>
          <select value={qualificationId || ''} disabled={disabled || !tree} onChange={(e) => pickQual(e.target.value)}>
            <option value="">{tree ? 'Not picked' : 'Loading…'}</option>
            {!qualKnown && <option value={qualificationId}>(switched off)</option>}
            {quals.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Specialization</span>
          <select value={specialisationId || ''} disabled={disabled || !tree} onChange={(e) => pickSpec(e.target.value)}>
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
          </select>
          {oldValue && !specialisationId && (
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
  return oldValue ? `${oldValue} (old value — not mapped yet)` : '';
}
