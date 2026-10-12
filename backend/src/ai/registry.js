// ---------------------------------------------------------------------------
// THE TOOL REGISTRY (spec 10) - one place that knows every action the AI Agent
// can take. Adding an action = adding ONE file under src/ai/tools/ that calls
// defineTool({...}); nothing else changes (the loader below picks it up).
//
// Each tool declares:
//   name           snake_case id, the key the intent layer resolves to
//   module         'ats' | 'hrms' | 'accounts'
//   label          plain words for the confirm card and the tool list
//   description    one sentence
//   parameters     { field: { type, required, description } }   the schema
//   permission     { product, module, feature, action } - a can() check, the
//                  same feature/action the route it replays is guarded by -
//                  or an async (ctx) => true/false/{ok,message}
//   roles          optional async (user) => true|false|message for rules a
//                  feature grant alone cannot express (HR/Admin only, ...)
//   selfService    true = a plain employee may use it (their OWN leave)
//   confirm        'always' | 'default' | 'never' | (params) => one of those
//                  always  = high-impact (spec 12): the Confirm card is shown
//                            whatever the role's "execute without confirm"
//   impact         why it is high-impact (shown on the card)
//   validate       async (ctx, input) => done | clarify | refuse | redirect
//   rules          async (ctx, params) => { ok, message }  business rules,
//                  re-run when Confirm is pressed
//   execute        async (ctx, params) => { ok, message, data }  calls the
//                  EXISTING route as the logged-in user (ctx.api)
//   verify         async (ctx, params, result) => { ok, message, evidence }
//                  re-reads through the same service
//   audit          string | (params, result) => text for the audit row
//   examples       a few phrasings (the full list is intent/phrasings.json)
//   status         'ready' (default) | 'unavailable' + unavailableReason
//                  (the backend route does not exist yet: the tool is listed,
//                  understood and permission-checked, but it never writes)
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const TOOLS = new Map();
const MODULES = ['ats', 'hrms', 'accounts'];
const CONFIRM = ['always', 'default', 'never'];

function problems(spec) {
  const p = [];
  const need = (k, test) => { if (!test(spec[k])) p.push(`"${k}" is missing or wrong`); };
  need('name', (v) => typeof v === 'string' && /^[a-z][a-z0-9_]+$/.test(v));
  need('module', (v) => MODULES.includes(v));
  need('label', (v) => typeof v === 'string' && v.length > 2);
  need('description', (v) => typeof v === 'string' && v.length > 5);
  need('parameters', (v) => v && typeof v === 'object');
  need('permission', (v) => (v && typeof v === 'object' && v.module && v.feature && v.action) || typeof v === 'function');
  need('confirm', (v) => CONFIRM.includes(v) || typeof v === 'function');
  need('validate', (v) => typeof v === 'function');
  need('audit', (v) => typeof v === 'string' || typeof v === 'function');
  need('examples', (v) => Array.isArray(v) && v.length >= 1);
  const unavailable = spec.status === 'unavailable';
  if (unavailable) {
    if (!spec.unavailableReason) p.push('"unavailableReason" is needed for an unavailable tool');
  } else {
    need('execute', (v) => typeof v === 'function');
    need('verify', (v) => typeof v === 'function');
  }
  return p;
}

function defineTool(spec) {
  const bad = problems(spec);
  if (bad.length) throw new Error(`AI tool "${spec && spec.name}" is not valid: ${bad.join('; ')}`);
  if (TOOLS.has(spec.name)) throw new Error(`AI tool "${spec.name}" is defined twice`);
  TOOLS.set(spec.name, Object.freeze({
    status: 'ready', selfService: false, impact: null, rules: null, roles: null, ...spec,
  }));
  return TOOLS.get(spec.name);
}

let loaded = false;
function loadAll() {
  if (loaded) return;
  loaded = true;
  const dir = path.join(__dirname, 'tools');
  fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.startsWith('_')).sort().forEach((f) => {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    require(path.join(dir, f));
  });
}

function getTool(name) { loadAll(); return TOOLS.get(name) || null; }
function allTools() { loadAll(); return [...TOOLS.values()]; }

// The confirm level for THIS set of parameters.
function confirmLevel(tool, params) {
  const c = typeof tool.confirm === 'function' ? tool.confirm(params || {}) : tool.confirm;
  return CONFIRM.includes(c) ? c : 'always';
}

// What the tool list and the report show (no functions).
function describe(tool) {
  return {
    name: tool.name,
    module: tool.module,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    confirm: typeof tool.confirm === 'function' ? 'depends on the details' : tool.confirm,
    impact: tool.impact,
    status: tool.status,
    unavailableReason: tool.unavailableReason || null,
    selfService: !!tool.selfService,
    examples: tool.examples,
  };
}

module.exports = { defineTool, getTool, allTools, confirmLevel, describe, problems };
