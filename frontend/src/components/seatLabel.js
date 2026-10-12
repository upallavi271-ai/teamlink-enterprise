// How a seat is worded in a picker (Add Employee, Edit employee, Positions):
// plain words for a 15-20 year old - free, taken, or leaving soon.
//
//   EDU-10 · Education 10 · free
//   EDU-8  · Education 8 · Supriya leaves 14 Oct - free after that
//   EDU-1  · held by Ravi
//
// `r` is a seat option from the server: { code, name, holder, vacant, mine, onNotice, freesOn, previousSeat }.
export function niceDay(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(String(iso))) return '';
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function seatOptionLabel(r) {
  const base = `${r.code}${r.name ? ` · ${r.name}` : ''}`;
  if (r.mine) return `${base} · their seat now`;
  if (r.onNotice) {
    return `${base} · ${r.holder || 'the holder'} ${r.freesOn ? `leaves ${niceDay(r.freesOn)} - free after that` : 'is on notice (no last day set yet)'}`;
  }
  if (r.holder) return `${base} · held by ${r.holder}`;
  return `${base} · free${r.previousSeat ? ' (their old seat)' : ''}`;
}

// The line under the picker: how many seats can be taken today.
export function seatSummary(list, department) {
  const free = list.filter((r) => !r.holder && !r.onNotice).length;
  const leaving = list.filter((r) => r.onNotice).length;
  return `${free} of ${list.length} free in ${department}${leaving ? `, ${leaving} more free soon (holder leaving)` : ''}.`;
}
