// The honest "AI reading is not switched on" provider: it never invents anything. The upload still works; Accounts types the details.
const { OcrError } = require('../errors');

function make(reason) {
  return {
    name: 'not-configured',
    async status() { return { ready: false, provider: 'none', model: null, reason: reason || 'AI bill reading is not switched on.' }; },
    async read() { throw new OcrError(reason || 'AI bill reading is not switched on.', 'not-configured', false); },
  };
}
module.exports = { make };
