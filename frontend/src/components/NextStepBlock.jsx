import { useState } from 'react';
import ContactPanel from './ContactPanel.jsx';
import FollowUpOutcome from './FollowUpOutcome.jsx';

// ---------------------------------------------------------------------------
// "WHERE IS THIS, AND WHAT DO I DO?" (§28, and §41's five facts).
//
// Four lines and ONE BUTTON, at the top of a record:
//
//   CURRENT STAGE   Client Review
//   OWNER           BDE — Ravi
//   NEXT STEP       Get client decision
//   DUE             Today 4:00 PM
//   [ Contact ]
//
// The button opens the Contact panel, and when that closes it goes straight on
// to "What happened? / What next?" — so the two halves of a follow-up are one
// motion rather than two things the user has to remember to do in order.
// ---------------------------------------------------------------------------
export default function NextStepBlock({
  stageLabel, owner, ownerRole, nextAction, due, dueTime, status,
  candidateId, candidateName, phone, email, role, client, applicationId, followUpId,
  onDone,
}) {
  const [contacting, setContacting] = useState(false);
  const [outcome, setOutcome] = useState(null);

  const late = status === 'Overdue';
  const dueText = due ? `${due}${dueTime ? ` ${dueTime}` : ''}` : 'No date set';

  return (
    <div className={`next-step${late ? ' is-late' : ''}`}>
      <div className="next-step-facts">
        <div><span className="k">Current stage</span><span>{stageLabel || '—'}</span></div>
        <div><span className="k">Owner</span><span>{owner || '—'}{ownerRole ? ` — ${ownerRole}` : ''}</span></div>
        <div><span className="k">Next step</span><span>{nextAction || '—'}</span></div>
        <div>
          <span className="k">Due</span>
          <span className={late ? 'fu-num-bad' : undefined}>
            {late ? '🔴 ' : ''}{dueText}
          </span>
        </div>
      </div>
      <button className="btn btn-primary" onClick={() => setContacting(true)}>
        Contact {candidateName ? candidateName.split(' ')[0] : ''}
      </button>

      {contacting && (
        <ContactPanel
          candidateId={candidateId}
          name={candidateName}
          phone={phone}
          email={email}
          role={role}
          client={client}
          applicationId={applicationId}
          onClose={() => setContacting(false)}
          // Straight on to the second half — the user does not have to find it.
          onContacted={(res) => {
            setContacting(false);
            if (followUpId) setOutcome({ contactMode: res.method });
            else if (onDone) onDone();
          }}
        />
      )}

      {outcome && followUpId && (
        <FollowUpOutcome
          followUpId={followUpId}
          who={candidateName}
          context="candidate"
          contactMode={outcome.contactMode}
          onClose={() => setOutcome(null)}
          onSaved={() => { setOutcome(null); if (onDone) onDone(); }}
        />
      )}
    </div>
  );
}
