import { useOmni } from '../omniContext.js';
import { PageHead, Btn, Panel, Pill } from '../ui.jsx';

// AI MARKETING > CREATE (2026-11-16, simple like Green Start): ONE place that answers "what do you want to make?". Each card opens the full tool (they all still exist, with their own
// approval and client steps); a card is shown only if this login may open that tool.
const GROUPS = [
  { title: 'Make something', sub: 'Everything you make waits for an approver before it is used.', items: [
    ['mkcontent', '✎', 'Words', 'Write WhatsApp, SMS, email and social messages in your brand voice.'],
    ['mkimages', '◩', 'A picture', 'Make marketing pictures with AI, in your brand colours and with your logo.'],
    ['mkvideos', '▶', 'A video', 'Make a short video from a prompt, your pictures or stock clips.'],
  ] },
  { title: 'Plan and send', sub: 'Nothing goes out by itself: you press Send or post it yourself.', items: [
    ['mkcalendar', '▦', 'Plan a post', 'Put the week on the calendar. The AI suggests ideas.'],
    ['mkemail', '✉', 'An email campaign', 'Subject lines, an A/B test and the email for one open job.'],
    ['mkcampaigns', '✆', 'A WhatsApp or SMS campaign', 'The words for one open job. You press Send in Campaigns.'],
  ] },
  { title: 'Sales tools', sub: 'For the leads in the CRM.', items: [
    ['mkleads', '◎', 'Lead generation', 'Every new lead scored Hot, Warm or Cold, with an owner.'],
    ['mkjourneys', '⟳', 'Workflow automation', 'Journeys for leads: the AI writes, a person approves.'],
  ] },
  { title: 'Set up', sub: 'Once, so everything sounds like your company.', items: [
    ['mkbrand', '❝', 'Brand voice', 'Tell the AI how your company sounds and looks.'],
  ] },
];

export default function MkCreatePage() {
  const { acc, go } = useOmni();
  const have = new Set((acc && Array.isArray(acc.pages) ? acc.pages : []));
  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="Create" lead="What do you want to make? Pick one." />
      {have.has('mkprojects') ? (
        <Panel title="Making it for a client?" sub="Start from the client: open their request, make the options with AI, show them on one private link." style={{ marginBottom: 14 }} right={<Btn primary onClick={() => go('mkprojects')}>Open Clients</Btn>} />
      ) : null}
      {GROUPS.map((g) => {
        const items = g.items.filter((i) => have.has(i[0]));
        if (!items.length) return null;
        return (
          <div key={g.title} style={{ marginBottom: 18 }}>
            <div className="panel-title" style={{ margin: '4px 0 2px' }}>{g.title}</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 8 }}>{g.sub}</div>
            <div className="mk-mods">
              {items.map(([id, icon, title, words]) => (
                <div key={id} className="card mk-mod live">
                  <div className="mk-mod-top"><span className="mk-mod-no" aria-hidden="true">{icon}</span><Pill tone="live" dot>Ready</Pill></div>
                  <h3>{title}</h3>
                  <p>{words}</p>
                  <div><Btn small primary onClick={() => go(id)}>Open</Btn></div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
