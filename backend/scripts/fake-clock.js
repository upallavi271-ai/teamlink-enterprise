// Test helper: shifts the JavaScript clock by TEST_DAY_OFFSET days (preload with NODE_OPTIONS=--require; the spawned server inherits it).
const off = Number(process.env.TEST_DAY_OFFSET || 0) * 86400000;
if (off) {
  const RealDate = Date;
  const shifted = (...a) => (a.length ? new RealDate(...a) : new RealDate(RealDate.now() + off));
  global.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [RealDate.now() + off])); }
    static now() { return RealDate.now() + off; }
  };
  void shifted;
}
