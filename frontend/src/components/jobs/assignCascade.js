import { hierarchyOptions } from '../HierarchyFilter.jsx';

// ---------------------------------------------------------------------------
// ASSIGNMENT CASCADE (ATS review #3 §10): Department → Section → TL →
// Recruiter, for the requirement's assignment pickers. The people come from
// GET /requirements/assignable-people (already scoped to who this login may
// assign); the structure from GET /ats/hierarchy (the same tree every
// HierarchyFilter uses). Choosing Section A leaves Section B's TLs and
// recruiters out; choosing a TL leaves only the recruiters of the section(s)
// that TL leads. Where the tree knows nobody (people who never sat in a
// seat), it falls back to the department, then to everyone assignable —
// never an empty list. The person already on the record is always kept.
//
//   const { sections, tls, recruiters } = assignCascade(tree.data, people,
//     { department, section, tlId, keep: [currentTlId, currentRecruiterId] });
// ---------------------------------------------------------------------------
const roleOf = (t) => t.atsRole || t.role;
const deptOf = (t) => t.atsDepartment || t.department || '';
const idsOf = (list) => new Set((list || []).map((x) => String(x.value || '')).filter((v) => v.startsWith('id:')).map((v) => v.slice(3)));

export function assignCascade(tree, people, { department = '', section = '', tlId = '', keep = [], keepTlId = '' } = {}) {
  const everyone = people || [];
  const allTls = everyone.filter((t) => roleOf(t) === 'TL');
  const allRecs = everyone.filter((t) => roleOf(t) === 'RECRUITER');
  const dep = ((tree && tree.departments) || []).find((d) => d.id === department);
  const sections = dep && (dep.sections || []).length > 1 ? dep.sections : [];
  const sec = sections.find((s) => s.id === section) ? section : '';
  const o = dep ? hierarchyOptions(tree, { department, section: sec, tl: tlId ? `id:${tlId}` : '', recruiter: '' }) : null;

  const withKept = (list, pool, allowKeep = true) => {
    const have = new Set(list.map((x) => x.id));
    // An explicit Section choice is a real narrowing: nothing is kept past it.
    if (sec || !allowKeep) return list;
    return [...list, ...pool.filter((x) => keep.includes(x.id) && !have.has(x.id))];
  };
  const narrow = (pool, treeIds) => {
    const byTree = treeIds ? pool.filter((x) => treeIds.has(x.id)) : [];
    if (byTree.length) return byTree;
    const byDept = department ? pool.filter((x) => deptOf(x) === department) : [];
    return byDept.length ? byDept : pool;
  };

  const tls = withKept(narrow(allTls, o ? idsOf(o.tls) : null), allTls);
  const recTree = o ? idsOf([...(o.people || []), ...(o.loose || [])]) : null;
  // A newly chosen TL narrows the recruiters for real too (the record's own
  // TL — keepTlId — still shows the record's own recruiters).
  const recruiters = withKept(narrow(allRecs, recTree), allRecs, !tlId || tlId === keepTlId);
  return { sections, section: sec, tls, recruiters };
}
