import { Icon, fmtNum } from '../../atskit/AtsKit.jsx';

// ---------------------------------------------------------------------------
// ONE JOININGS CARD PER TEAM (founder 2026-11-20): "Team A joinings", "Team B joinings" for a department split into teams
// (utils/teamJoinCards.js on the server). The viewer's own team comes first and says "your team". Same look as the number cards
// next to it; click opens the list (candidate, requirement, client, recruiter, joining date). 0 is shown as 0.
// ---------------------------------------------------------------------------
export function TeamJoinTile({ t, onDrill, prevWord }) {
  const d = t.delta || null;
  const stillWorking = t.left ? (t.stillWorking != null ? t.stillWorking : t.value) : null;
  const open = t.drill ? () => onDrill(t.drill) : undefined;
  const inner = (
    <>
      <span className={`ak-kpi-ic ak-t-${t.mine ? 'green' : 'blue'}`}><Icon name="check" size={20} /></span>
      <span className="ak-kpi-body">
        <span className="ak-kpi-label">
          {t.label}
          {t.mine && <span className="av4-tj-mine" data-testid="your-team">your team</span>}
        </span>
        <span className="ak-kpi-value" data-testid={`team-joins-value-${t.id}`}>{fmtNum(t.value)}</span>
        {t.left && (
          <span className="ak-kpi-sub av4-tj-left">
            Still working: {fmtNum(stillWorking)} · left after joining: {fmtNum(t.left.n)}
          </span>
        )}
        {d && t.value > 0 && <span className="ak-kpi-sub">{d.text}</span>}
        {!t.value && <span className="ak-kpi-sub">{d && d.prev ? `${t.zero} · ${fmtNum(d.prev)} ${prevWord || 'before'}` : t.zero}</span>}
      </span>
    </>
  );
  const cls = `ak-kpi av4-tj${t.mine ? ' is-mine' : ''}${open && t.value ? ' ak-click' : ''}`;
  return open && t.value
    ? <button type="button" className={cls} onClick={open} title={t.help}>{inner}</button>
    : <div className={cls} title={t.help}>{inner}</div>;
}
