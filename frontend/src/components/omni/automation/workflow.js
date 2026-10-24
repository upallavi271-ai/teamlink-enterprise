// ---------------------------------------------------------------------------
// OMNI-CHANNEL > AUTOMATIONS: the small helpers shared by the Automations page and the workflow editor.
// An automation is the existing "sequence": a list of steps, each with a wait before it. The editor shows it the way the prototype does, as a list of
// steps you can reorder / retype / remove, where "Wait" is a step of its own. These helpers turn one form into the other:
//   steps (server)  [{ type:'message', channel, templateKey, text, subject, waitHours } | { type:'task', kind, note, waitHours }]
//   items (editor)  [{ k:'wait', hours } | { k:'msg', channel, templateKey, text, subject } | { k:'task', kind, note }]
// ---------------------------------------------------------------------------
export const CHANNEL_WORDS = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email' };
export const TASK_WORDS = { call: 'Call task', follow_up: 'Follow-up task', ai_call: 'AI call (Planned)' };
export const MAX_STEPS = 8;

let uid = 0;
export const newKey = () => { uid += 1; return `w${uid}`; };

export const waitWords = (h) => {
  const n = Math.floor(Number(h) || 0);
  if (n <= 0) return 'right away';
  if (n % 24 === 0) return `${n / 24} day${n / 24 === 1 ? '' : 's'}`;
  return `${n} hour${n === 1 ? '' : 's'}`;
};

export function toItems(steps) {
  const out = [];
  (steps || []).forEach((s) => {
    if (Number(s.waitHours) > 0) out.push({ _k: newKey(), k: 'wait', hours: Number(s.waitHours) });
    out.push(s.type === 'task'
      ? { _k: newKey(), k: 'task', kind: s.kind || 'call', note: s.note || '' }
      : { _k: newKey(), k: 'msg', channel: s.channel || 'whatsapp', templateKey: s.templateKey || '', text: s.text || '', subject: s.subject || '' });
  });
  return out;
}

// -> { steps, trailingWait }
export function toSteps(items) {
  const steps = []; let wait = 0;
  items.forEach((it) => {
    if (it.k === 'wait') { wait += Math.max(0, Math.floor(Number(it.hours) || 0)); return; }
    const waitHours = Math.min(wait, 720); wait = 0;
    steps.push(it.k === 'task'
      ? { type: 'task', kind: it.kind, note: it.note || '', waitHours }
      : { type: 'message', channel: it.channel, templateKey: it.templateKey || '', text: it.text || '', subject: it.subject || '', waitHours });
  });
  return { steps, trailingWait: wait > 0 };
}

export const STARTER_ITEMS = () => toItems([
  { type: 'message', channel: 'whatsapp', text: 'Hi {{first_name}}, thank you for your interest. We will call you soon. {{unsubscribe}}', waitHours: 0 },
  { type: 'message', channel: 'sms', text: 'Hi {{first_name}}, we tried to reach you about the job. Please reply YES to talk. {{unsubscribe}}', waitHours: 24 },
  { type: 'task', kind: 'call', note: 'Call the person', waitHours: 24 },
]);

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// the node chain of the prototype (Trigger, Condition, Action, Wait, Branch, Goal), made from the real automation.
// focus = the editor item to open when the card is clicked (-1 = the top of the editor)
export function nodesOf(seq, tplName = {}) {
  const nodes = [{ kind: 'Trigger', tone: 'green', title: seq.trigger === 'applied' ? 'A person applies' : 'I add people myself', detail: seq.trigger === 'applied' ? 'An ATS application matched to a contact' : 'People you add with "Add people"', focus: -1 }];
  if (seq.quiet) nodes.push({ kind: 'Condition', tone: '', title: 'Quiet hours', detail: 'Messages wait until quiet hours end', focus: -1 });
  const items = toItems(seq.steps);
  let firstMsg = true;
  items.forEach((it, i) => {
    if (it.k === 'wait') { nodes.push({ kind: 'Wait', tone: 'orange', title: waitWords(it.hours), detail: seq.stopOnReply ? 'No reply by then? Next step' : 'Then the next step', focus: i }); return; }
    if (it.k === 'task') { nodes.push({ kind: 'Action', tone: 'green', title: TASK_WORDS[it.kind] || 'Task', detail: clip(it.note, 60) || 'For the owner', focus: i }); return; }
    nodes.push({ kind: 'Action', tone: 'green', title: `Send ${CHANNEL_WORDS[it.channel] || it.channel}`, detail: it.templateKey ? (tplName[it.templateKey] || 'A saved template') : (clip(it.text, 60) || 'Message'), focus: i });
    if (firstMsg && seq.stopOnReply && i < items.length - 1) nodes.push({ kind: 'Branch', tone: '', title: 'Replied?', detail: 'Yes → stop · No → next step', focus: -1 });
    firstMsg = false;
  });
  nodes.push({ kind: 'Goal', tone: 'green', title: 'Finished', detail: 'The person went through every step', focus: -1 });
  return nodes;
}

export const OUTCOME_WORDS = {
  rehearsed: 'Rehearsed (nothing sent)', sent: 'Sent', skipped: 'Skipped', blocked: 'Not sent: no credits', failed: 'Did not go', task: 'Task made', stopped: 'Stopped',
};
