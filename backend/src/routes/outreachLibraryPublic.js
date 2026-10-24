// PUBLIC share link of a Library file (no login): GET /api/public/outreach/library/:token/:name
// The token is 48 unguessable hex letters; the name in the address is only for people (it does not decide anything). A deleted item, a link item or a wrong token
// all get the same plain 404. The file is sent with its stored type (never guessed from the name), "nosniff", and a sandbox policy so it can never run as a page.
const express = require('express');
const { rateLimit } = require('../utils/publicRateLimit');
const Lib = require('../outreach/library');

const router = express.Router();
const lim = rateLimit({ bucket: 'outreach-library', max: 600, windowMs: 10 * 60000 });

router.get('/library/:token/:name', lim, (req, res, next) => {
  Lib.publicFile(req.params.token, req.params.name).then((f) => {
    if (!f) return res.status(404).type('text/plain').send('This link does not work (the file may have been removed).');
    const safe = String(f.name || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 100) || 'file';
    res.set({
      'Content-Type': f.mime,
      'Content-Disposition': `${f.inline ? 'inline' : 'attachment'}; filename="${safe}"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      'Cache-Control': 'public, max-age=300',
      'X-Robots-Tag': 'noindex',
    });
    return res.sendFile(f.path, (err) => { if (err && !res.headersSent) next(err); });
  }).catch(next);
});

module.exports = router;
