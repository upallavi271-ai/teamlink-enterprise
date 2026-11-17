import { useRef } from 'react';

// ---------------------------------------------------------------------------
// MY DASHBOARD LAYOUT (2026-11-17, founder audit: drag-and-drop widgets).
// Each login can move the ATS dashboard cards (plain HTML5 drag and drop, or
// the arrow buttons) and hide / show them. Saved per login on the server:
// GET (inside /api/dashboard/ats/home as cardLayout) · PUT · DELETE
// /api/dashboard/ats/home/layout (backend/src/utils/dashboardLayout.js).
//
// The page has SECTIONS (the KPI row, the "Needs attention" row, …) and each
// section has CARDS. A section moves up / down among the sections; a card
// moves left / right inside its own row (so the page keeps its shape).
// The layout is { order: [id…], hidden: [id…] }: the relative order of the
// ids that are on the page; an id the page does not have today is kept, a
// card the role gets later shows up in its usual place.
// ---------------------------------------------------------------------------

export const cardKey = (s) => String(s).replace(/[^A-Za-z0-9:_.-]/g, '_').slice(0, 80);

// The default list, re-ordered by the saved order: the places the saved ids
// take in the default list are refilled in the saved order; every other item
// keeps its own place.
export function arrange(items, order) {
  if (!order || !order.length) return items;
  const pos = new Map(order.map((id, i) => [id, i]));
  const known = items.filter((x) => pos.has(x.id)).sort((a, b) => pos.get(a.id) - pos.get(b.id));
  let k = 0;
  return items.map((x) => (pos.has(x.id) ? known[k++] : x)); // eslint-disable-line no-plusplus
}

// Move `id` onto `target` (drag and drop) inside one list of ids.
export function moveOnto(ids, id, target) {
  const from = ids.indexOf(id);
  const to = ids.indexOf(target);
  if (from < 0 || to < 0 || from === to) return ids;
  const out = ids.filter((x) => x !== id);
  const at = out.indexOf(target);
  out.splice(from < to ? at + 1 : at, 0, id);
  return out;
}
// Move `id` one place (dir -1 / +1) inside one list of ids.
export function moveBy(ids, id, dir) {
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return ids;
  const out = [...ids];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

// The bar on top of a section or card while the person is arranging.
function EditBar({
  label, kind, group, id, drag, setDrag, onMove, onHide, prevLabel, nextLabel, boxRef,
}) {
  const vertical = kind === 'section';
  return (
    <div
      className="av4-lay-bar"
      draggable
      onDragStart={(e) => {
        e.stopPropagation();
        try { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; } catch { /* old browsers */ }
        try { if (boxRef.current) e.dataTransfer.setDragImage(boxRef.current, 24, 16); } catch { /* not supported */ }
        setDrag({ kind, group, id });
      }}
      onDragEnd={() => setDrag(null)}
      title="Drag to move"
      data-testid={`lay-bar-${id}`}
    >
      <span className="av4-lay-grip" aria-hidden="true">⠿</span>
      <span className="av4-lay-name">{label}</span>
      <span className="av4-lay-tools">
        <button type="button" className="btn btn-sm" onClick={() => onMove(-1)} disabled={!prevLabel} aria-label={`Move ${label} ${vertical ? 'up' : 'left'}`} title={prevLabel ? `Before ${prevLabel}` : ''}>{vertical ? '↑' : '←'}</button>
        <button type="button" className="btn btn-sm" onClick={() => onMove(1)} disabled={!nextLabel} aria-label={`Move ${label} ${vertical ? 'down' : 'right'}`} title={nextLabel ? `After ${nextLabel}` : ''}>{vertical ? '↓' : '→'}</button>
        {onHide && <button type="button" className="btn btn-sm" onClick={onHide} aria-label={`Hide ${label}`}>Hide</button>}
      </span>
      {drag && drag.id !== id && drag.group === group && <span className="av4-lay-drop small-muted">Drop here</span>}
    </div>
  );
}

// One box that can be dragged (a section or a card). Not arranging: just its children.
export function LayoutBox({
  kind, id, group, label, editing, drag, setDrag, onDropOnto, onMove, onHide, prevLabel, nextLabel, className = '', children,
}) {
  const ref = useRef(null);
  const sameGroup = !!(drag && drag.group === group && drag.kind === kind && drag.id !== id);
  return (
    <div
      ref={ref}
      className={`${className}${editing ? ' is-arranging' : ''}${sameGroup ? ' is-target' : ''}${drag && drag.id === id ? ' is-dragging' : ''}`}
      data-card={id}
      onDragOver={editing ? (e) => {
        if (!sameGroup) return;
        e.preventDefault(); e.stopPropagation();
        try { e.dataTransfer.dropEffect = 'move'; } catch { /* old browsers */ }
      } : undefined}
      onDrop={editing ? (e) => {
        if (!sameGroup) return;
        e.preventDefault(); e.stopPropagation();
        onDropOnto(drag.id, id);
        setDrag(null);
      } : undefined}
    >
      {editing && (
        <EditBar
          label={label} kind={kind} group={group} id={id} drag={drag} setDrag={setDrag} onMove={onMove} onHide={onHide}
          prevLabel={prevLabel} nextLabel={nextLabel} boxRef={ref}
        />
      )}
      {children}
    </div>
  );
}

// The "Customise" line above the cards: start / stop arranging, Reset layout, the hidden cards.
export function LayoutBar({
  editing, setEditing, hiddenCards, onShow, onReset, readOnly, msg, busy, customised,
}) {
  if (readOnly) return null;
  return (
    <div className={`av4-lay-top${editing ? ' is-on' : ''}`} data-testid="layout-bar">
      {!editing ? (
        <>
          {hiddenCards.length > 0 && <span className="small-muted">{`${hiddenCards.length} ${hiddenCards.length === 1 ? 'card' : 'cards'} hidden`}</span>}
          <button type="button" className="btn btn-sm" onClick={() => setEditing(true)} title="Move or hide the cards on your dashboard">Customise</button>
        </>
      ) : (
        <>
          <span className="av4-lay-help">Drag a card by its bar, or use the arrows. Hide what you do not need. Only you see this layout.</span>
          {hiddenCards.length > 0 && (
            <span className="av4-lay-hidden">
              <span className="small-muted">Hidden:</span>
              {hiddenCards.map((c) => (
                <button key={c.id} type="button" className="btn btn-sm" onClick={() => onShow(c.id)} title={`Show ${c.label} again`}>{`+ ${c.label}`}</button>
              ))}
            </span>
          )}
          {msg && <span className="small-muted" role="status">{msg}</span>}
          <button type="button" className="btn btn-sm" disabled={busy || !customised} onClick={onReset}>Reset layout</button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing(false)}>Done</button>
        </>
      )}
    </div>
  );
}
