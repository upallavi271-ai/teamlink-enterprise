// TeamLink helper (NOT part of the Green Start zip). Loaded with NODE_OPTIONS=--require so Green Start's API listens on 127.0.0.1 only.
// The product's own main.ts listens on 0.0.0.0 (every network card); this keeps it private to this computer WITHOUT editing its source.
const net = require('net');
const orig = net.Server.prototype.listen;
net.Server.prototype.listen = function patchedListen(...args) {
  if (args.length >= 2 && typeof args[0] === 'number' && args[1] === '0.0.0.0') args[1] = '127.0.0.1';
  return orig.apply(this, args);
};
