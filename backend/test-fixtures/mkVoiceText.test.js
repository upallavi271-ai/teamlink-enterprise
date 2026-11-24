// The words handed to the video voice-over reach the voice untouched (only white space is tidied). Regression: every letter "s" was dropped.
//   node backend/test-fixtures/mkVoiceText.test.js
const assert = require('node:assert/strict');
const V = require('../src/marketing/meetingVoice');
assert.equal(V.cleanText('Hello,  this is Dr Rao Skin Clinic.\n  Healthy skin starts here.'), 'Hello, this is Dr Rao Skin Clinic. Healthy skin starts here.');
assert.equal(V.cleanText('sss  Sunscreen is simple'), 'sss Sunscreen is simple');
assert.equal(V.cleanText(null), '');
assert.equal(V.cleanText('a'.repeat(400)).length, 320);
console.log('mkVoiceText: all passed');
