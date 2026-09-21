/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// The whole API, with the Anthropic client stubbed.
//
// Same process, same routes, same middleware, same permission engine — only
// the model is replaced, by one that does exactly what the question tells it
// to. Ask it "TOOL search_requirements {}" and it calls that tool with that
// input and then reports the raw tool result back as its answer.
//
// That makes the agent's permission boundary provable with curl: sign in as a
// candidate, tell the stub to call an ATS tool, and read the refusal come back
// over HTTP through the real /api/ai/ask.
//
// It is a TEST server. It is never started by npm start, never wired into
// src/index.js, and it needs a key in the credential store only because the
// real configuration check runs unchanged.
//
//   PORT=4551 node backend/test/stubServer.js
// ---------------------------------------------------------------------------

const path = require('path');
const Module = require('module');

class StubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
class StubAnthropic {
  // eslint-disable-next-line class-methods-use-this
  get messages() {
    return {
      create: async (req) => {
        const last = req.messages[req.messages.length - 1];
        // A tool_result came back: report it verbatim so curl can read it.
        if (Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result')) {
          const block = last.content.find((b) => b.type === 'tool_result');
          return {
            content: [{ type: 'text', text: block.content }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        }
        const question = typeof last.content === 'string' ? last.content : '';
        const m = /^TOOL\s+(\S+)\s*(\{[\s\S]*\})?$/.exec(question.trim());
        if (!m) {
          return {
            content: [{ type: 'text', text: `stub: say "TOOL <name> {json}". Offered: ${(req.tools || []).map((t) => t.name).join(', ')}` }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        }
        let input = {};
        try { input = m[2] ? JSON.parse(m[2]) : {}; } catch { input = {}; }
        return {
          content: [{ type: 'tool_use', id: 'tu_stub', name: m[1], input }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    };
  }
}
['AuthenticationError', 'RateLimitError', 'NotFoundError', 'PermissionDeniedError',
  'APIConnectionError', 'APIConnectionTimeoutError'].forEach((n) => {
  StubAnthropic[n] = class extends StubError {};
});

const STUB_ID = path.join(__dirname, '__stub_anthropic_server__');
require.cache[STUB_ID] = { id: STUB_ID, filename: STUB_ID, loaded: true, exports: StubAnthropic };
const realResolve = Module._resolveFilename;
Module._resolveFilename = function patched(request, ...rest) {
  if (request === '@anthropic-ai/sdk') return STUB_ID;
  return realResolve.call(this, request, ...rest);
};

console.log('[stub] Anthropic SDK replaced by a scripted stub — no network call is made.');
require('../src/index.js');
