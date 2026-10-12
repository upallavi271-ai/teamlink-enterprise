// ---------------------------------------------------------------------------
// OPTIONAL model help for "Identify Action" - only when the words did not decide
// it AND a language model is actually configured (Ollama locally, or Claude with
// the key from Administration -> Integrations). With no model, or in the test
// sandbox, this returns null and the deterministic path answers on its own.
//
// The model is trusted for NOTHING. It may only suggest a tool NAME from the
// registry and a few plain slots; the pipeline then runs the suggestion through
// the same permission check, validation, business rules and Confirm card as a
// typed request. Anything not in the registry is dropped here.
// ---------------------------------------------------------------------------

const ai = require('../../utils/ai');
const registry = require('../registry');
const { STAGE_LABELS } = require('../../utils/atsVocab');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function promptFor(tools) {
  return [
    'You turn ONE user message into the name of ONE action from the list below, as a single JSON object. You never carry anything out.',
    'Reply with ONLY: {"tool": "<name or null>", "names": ["<person / client / job names exactly as written>"], "dates": ["YYYY-MM-DD"], "time": "HH:MM or null", "amount": <number or null>, "stage": "<STAGE_CODE or null>"}',
    'If the message is not clearly one of these actions, use {"tool": null}. The message may be English, Telugu or Hindi, or a mix written in English letters.',
    `Stage codes: ${Object.keys(STAGE_LABELS).join(', ')}.`,
    'ACTIONS:',
    ...tools.map((t) => `- ${t.name}: ${t.description}`),
  ].join('\n');
}

// -> async (text, user) => { tool, slots } | null     (or null when no model is set up)
async function make() {
  let status;
  try { status = await ai.checkStatus(); } catch { return null; }
  if (!status || !status.available || status.modelPulled === false) return null;
  return async (text, user) => {
    const tools = registry.allTools().filter((t) => t.status === 'ready');
    let out;
    try {
      out = await ai.chatJson(promptFor(tools), [{ role: 'user', content: String(text).slice(0, 600) }]);
    } catch { return null; }
    if (!out || typeof out !== 'object') return null;
    const tool = tools.find((t) => t.name === out.tool);
    if (!tool) return null;
    const slots = {};
    if (Array.isArray(out.names)) slots.names = out.names.map((n) => String(n).slice(0, 80)).filter(Boolean).slice(0, 4);
    if (Array.isArray(out.dates)) slots.dates = out.dates.filter((d) => DATE_RE.test(String(d))).slice(0, 3);
    if (out.time && TIME_RE.test(String(out.time))) slots.time = String(out.time);
    if (out.amount != null && Number.isFinite(Number(out.amount)) && Number(out.amount) >= 0) slots.amount = Number(out.amount);
    if (out.stage && STAGE_LABELS[String(out.stage)]) slots.stages = [String(out.stage)];
    return { tool: tool.name, slots };
  };
}

module.exports = { make, promptFor };
