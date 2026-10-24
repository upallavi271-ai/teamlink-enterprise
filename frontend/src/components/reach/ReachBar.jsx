import ReachBulkBar from './ReachBulkBar.jsx';
import { useReachRights } from './reachKit.js';

// The sticky bar of the Progress board: the same bar as the list, contact group only.
//   items    what is ticked        total   people on the board (for "Select all N")
export default function ReachBar({
  items, total, onSelectAll, onClear, onDone, note,
}) {
  const rights = useReachRights();
  if (!items.length || !rights.loaded || !rights.one) return null;
  const n = new Set(items.map((x) => x.id)).size;
  return (
    <ReachBulkBar
      selected={n}
      items={items}
      selectAll={total > n && onSelectAll ? { label: `Select all ${total.toLocaleString('en-IN')}`, onClick: onSelectAll } : null}
      onCancel={onClear}
      onDone={onDone}
      note={note}
    />
  );
}
