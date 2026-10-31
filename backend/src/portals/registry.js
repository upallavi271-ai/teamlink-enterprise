// ---------------------------------------------------------------------------
// PORTAL REGISTRY: portal key -> adapter class (the adapter pattern).
//
//   get(portal)             the class (or null)
//   create(portal, args)    a new adapter instance
//   meta(portal)            { key, name, automation, kind, ... }
//   register(key, Class)    add a portal: see docs/job-publishing/PLAYWRIGHT.md ("How to add a portal")
//
// The adapters are loaded lazily so the API server does not load Playwright just to list the portals.
// ---------------------------------------------------------------------------
const loaders = {
  naukri: () => require('./naukri/NaukriAdapter'), // eslint-disable-line global-require
  foundit: () => require('./foundit/FounditAdapter'), // eslint-disable-line global-require
  shine: () => require('./shine/ShineAdapter'), // eslint-disable-line global-require
  linkedin: () => require('./linkedin/LinkedInAdapter'), // eslint-disable-line global-require
  career: () => require('./career/InternalCareerAdapter'), // eslint-disable-line global-require
  telegram: () => require('./telegram/TelegramAdapter'), // eslint-disable-line global-require
  facebook: () => require('./facebook/FacebookAdapter'), // eslint-disable-line global-require
  instagram: () => require('./instagram/InstagramAdapter'), // eslint-disable-line global-require
  threads: () => require('./threads/ThreadsAdapter'), // eslint-disable-line global-require
  linkedinpost: () => require('./linkedinpost/LinkedInPostAdapter'), // eslint-disable-line global-require
};
const custom = new Map(); // tests / future portals

function register(key, cls) { custom.set(key, cls); }
function unregister(key) { custom.delete(key); }
function get(portal) {
  if (custom.has(portal)) return custom.get(portal);
  return loaders[portal] ? loaders[portal]() : null;
}
function create(portal, args) {
  const Cls = get(portal);
  if (!Cls) throw new Error(`No adapter for portal "${portal}"`);
  return new Cls({ portal, ...args });
}
function meta(portal) {
  const Cls = get(portal);
  return Cls && Cls.meta ? Cls.meta : null;
}
const keys = () => [...new Set([...Object.keys(loaders), ...custom.keys()])];

module.exports = {
  get, create, meta, register, unregister, keys,
};
