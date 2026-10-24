import { useState } from 'react';

// The nested left tree of Manage Templates: channel group -> family -> account (with counts), Flows under WhatsApp, a way to add an RCS assistant.
// Classes: .tpl-group-title .tpl-fam .tpl-fam-body .tpl-acc-btn .tpl-empty .tpl-add-flow (gs.css).
export default function TemplateNav({ tree, sel, onAccount, onFlow, onNewFlow, onNewAssistant, canWrite }) {
  const [closed, setClosed] = useState({});
  const [flowsOpen, setFlowsOpen] = useState(false);
  if (!tree) return <nav className="tpl-nav" aria-label="Templates"><div className="tpl-empty">Loading…</div></nav>;
  return (
    <nav className="tpl-nav" aria-label="Templates by channel">
      {tree.groups.map((g) => (
        <div key={g.key}>
          <div className="tpl-group-title">{g.label}</div>
          {g.families.map((f) => {
            const k = `${g.key}:${f.key}`;
            const hasSel = f.accounts.some((a) => sel.group === g.key && sel.account === a.id && sel.view !== 'flow');
            const open = closed[k] === undefined ? true : (!closed[k] || hasSel);
            return (
              <div key={k}>
                <button type="button" className={`tpl-fam ${open ? 'open' : ''}`} aria-expanded={open} onClick={() => setClosed({ ...closed, [k]: open })}>
                  <span className="tpl-fam-ic" style={{ color: g.color }}>{g.icon}</span><span className="tpl-fam-l">{f.label}</span>
                  {f.accounts.length ? <span className="tpl-fam-n">{f.accounts.length}</span> : null}
                  <span className="tpl-fam-c">{open ? '⌃' : '⌄'}</span>
                </button>
                <div className={`tpl-fam-body ${open ? 'open' : ''}`}>
                  {f.accounts.length ? f.accounts.map((a) => (
                    <button type="button" key={a.id} className={`tpl-acc-btn ${sel.group === g.key && sel.account === a.id && sel.view !== 'flow' ? 'active' : ''}`} onClick={() => onAccount(g.key, a.id)} title={a.sub}>
                      <span style={{ overflowWrap: 'anywhere', textAlign: 'left' }}>{a.name}</span><span className="tpl-acc-n">{a.count}</span>
                    </button>
                  )) : <div className="tpl-empty">Nothing connected yet</div>}
                  {g.key === 'rcs' && canWrite ? <button type="button" className="tpl-add-flow" onClick={onNewAssistant}>＋ New RCS assistant</button> : null}
                </div>
              </div>
            );
          })}
          {g.key === 'whatsapp' && (
            <>
              <button type="button" className={`tpl-fam ${flowsOpen ? 'open' : ''}`} aria-expanded={flowsOpen} onClick={() => setFlowsOpen(!flowsOpen)}>
                <span className="tpl-fam-ic">⛭</span><span className="tpl-fam-l">Flows</span><span className="tpl-fam-n">{g.flows.length}</span><span className="tpl-fam-c">{flowsOpen ? '⌃' : '⌄'}</span>
              </button>
              <div className={`tpl-fam-body ${flowsOpen ? 'open' : ''}`}>
                {g.flows.length ? g.flows.map((fl) => (
                  <button type="button" key={fl.id} className={`tpl-acc-btn ${sel.view === 'flow' && sel.flowId === fl.id ? 'active' : ''}`} onClick={() => onFlow(fl.id)}>
                    <span style={{ overflowWrap: 'anywhere', textAlign: 'left' }}>{fl.name}</span><span className="tpl-acc-n">{fl.screens}</span>
                  </button>
                )) : <div className="tpl-empty">No flows yet</div>}
                {canWrite ? <button type="button" className="tpl-add-flow" onClick={onNewFlow}>＋ New flow</button> : null}
              </div>
            </>
          )}
        </div>
      ))}
    </nav>
  );
}
