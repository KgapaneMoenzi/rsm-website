'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const store = require('./lib/store').create();
const mailer = require('./lib/mailer');

const PROD = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;
const MAX_FILE = 5 * 1024 * 1024; // 5 MB (the site shrinks photos before upload, so real files are far smaller)

/* ------------------------------ configuration ------------------------------ */
function die(msg) {
  console.error('\nCONFIG ERROR: ' + msg + '\n');
  process.exit(1);
}

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
let SESSION_SECRET = process.env.SESSION_SECRET || '';

if (PROD) {
  if (store.kind === 'local') die('DATABASE_URL is not set. Add your Neon connection string.');
  if (ADMIN_PASSWORD.length < 10) die('ADMIN_PASSWORD must be set and at least 10 characters.');
  if (SESSION_SECRET.length < 32) die('SESSION_SECRET must be set and at least 32 characters.');
} else {
  if (!SESSION_SECRET) SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  if (!ADMIN_PASSWORD) {
    ADMIN_PASSWORD = 'dev-' + crypto.randomBytes(4).toString('hex');
    console.log('DEV admin password (not set in env): ' + ADMIN_PASSWORD);
  }
}

/* ---------------------------------- helpers ---------------------------------- */
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const clean = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROOMS = ['Bachelor Room', 'Single Room', 'Sharing Room'];
const UNIVERSITIES = ['University of Mpumalanga (UMP)', 'Other University'];
const STATUSES = ['new', 'contacted', 'accepted', 'declined'];

function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { ext: 'png', type: 'image/png' };
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP')
    return { ext: 'webp', type: 'image/webp' };
  return null;
}

// keeps line breaks (unlike clean) for the optional note the landlord writes in the acceptance email
const cleanNote = (s) =>
  String(s == null ? '' : s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, 1000);

function normalisePhone(raw) {
  const p = String(raw || '').replace(/[\s\-().]/g, '');
  if (/^(\+?27)\d{9}$/.test(p)) return '0' + p.slice(-9);
  if (/^0\d{9}$/.test(p)) return p;
  return null;
}

/* ----------------------------- admin session cookie ----------------------------- */
const COOKIE = 'rsm_admin';
const SESSION_MS = 8 * 60 * 60 * 1000;
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');

function makeToken() {
  const exp = String(Date.now() + SESSION_MS);
  return exp + '.' + sign(exp);
}
function validToken(t) {
  if (!t) return false;
  const [exp, sig] = String(t).split('.');
  if (!exp || !sig) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(exp));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(exp) > Date.now();
}
function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
function setSession(res, token, maxAgeMs) {
  const flags = ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=' + Math.floor(maxAgeMs / 1000)];
  if (PROD) flags.push('Secure');
  res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; ${flags.join('; ')}`);
}

function requireAdmin(req, res, next) {
  if (!validToken(getCookie(req, COOKIE))) return res.status(401).json({ error: 'Please log in.' });
  // CSRF defence on top of SameSite=Strict: changing requests must carry a custom header
  if (!['GET', 'HEAD'].includes(req.method) && req.get('x-admin') !== '1')
    return res.status(403).json({ error: 'Forbidden.' });
  next();
}

/* ----------------------------------- app ----------------------------------- */
const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy; needed for correct client IPs in rate limits
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ['https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        mediaSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

app.use(['/api', '/admin'], (req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));

/* ------------------------------ student application ------------------------------ */
// Mobile networks put many students behind one IP, so limits are generous and
// the strict one only counts applications that actually went through.
const applyFloodLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a few minutes and try again.' },
});
const applyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 25,
  skipFailedRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many applications from this connection. Please try again later.' },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE, files: 1, fields: 12, fieldSize: 2000 },
  fileFilter: (req, file, cb) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.mimetype)) req.badType = true;
    cb(null, !req.badType);
  },
});

function receiveId(req, res, next) {
  upload.single('idPicture')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE')
      return res.status(413).json({ error: 'That photo is too large. Please use a photo under 5 MB.' });
    return res.status(400).json({ error: 'We could not read your upload. Please try again.' });
  });
}

app.post('/api/apply', applyFloodLimiter, applyLimiter, receiveId, async (req, res) => {
  try {
    const b = req.body || {};

    // Honeypot: real people never fill this hidden field. Pretend success so bots learn nothing.
    if (clean(b.website)) return res.json({ ok: true });

    const name = clean(b.name);
    const studentNumber = clean(b.studentNum);
    const university = clean(b.university);
    const room = clean(b.room);
    const phone = normalisePhone(b.phone);
    const email = clean(b.email).toLowerCase();

    if (name.length < 2 || name.length > 100) return fail(res, 'Please enter your full name.');
    if (!/^[A-Za-z0-9\- ]{3,30}$/.test(studentNumber))
      return fail(res, 'Please enter a valid student number (letters and numbers only).');
    if (!UNIVERSITIES.includes(university)) return fail(res, 'Please choose a university from the list.');
    if (!phone) return fail(res, 'Please enter a valid South African phone number, e.g. 063 123 4567.');
    if (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
      return fail(res, 'Please enter a valid email address so we can confirm your application.');
    if (!ROOMS.includes(room)) return fail(res, 'Please choose a room type.');
    if (!['on', 'true', '1', 'yes'].includes(clean(b.consent).toLowerCase()))
      return fail(res, 'Please tick the box to agree that we may use your details and ID.');

    if (req.badType || !req.file) return fail(res, 'Please upload a clear ID photo (JPG or PNG).');
    const img = sniffImage(req.file.buffer); // trust the file's real bytes, not the label the browser sent
    if (!img) return fail(res, 'That file is not a valid JPG or PNG photo.');

    const saved = await store.save(
      { name, studentNumber, university, phone, email, room },
      { buffer: req.file.buffer, type: img.type, ext: img.ext }
    );
    // Reply to the student first; emails go out in the background and can never lose the application
    res.json({ ok: true, emailed: mailer.enabled });
    mailer
      .notifyNewApplication({ name, studentNumber, university, phone, email, room, createdAt: saved.createdAt })
      .catch((e) => console.error('email error:', e.message));
  } catch (e) {
    console.error('apply failed:', e.message);
    res.status(500).json({ error: 'Something went wrong on our side. Please try again in a moment.' });
  }
});
const fail = (res, error) => res.status(400).json({ error });

/* ------------------------------ public availability ------------------------------ */
// Public on purpose, but it only ever reveals "places left" for room types whose total the landlord has set.
const availLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });

app.get('/api/availability', availLimiter, async (req, res) => {
  try {
    const [cap, taken] = await Promise.all([store.getCapacity(), store.acceptedCounts()]);
    const rooms = {};
    for (const room of ROOMS) {
      const total = cap[room] || 0;
      if (total > 0) rooms[room] = { left: Math.max(0, total - (taken[room] || 0)) };
    }
    res.set('Cache-Control', 'public, max-age=30');
    res.json({ rooms });
  } catch (e) {
    console.error('availability failed:', e.message);
    res.json({ rooms: {} }); // never break the public page over this
  }
});

/* ----------------------------------- admin ----------------------------------- */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait 15 minutes and try again.' },
});

app.use('/api/admin', express.json({ limit: '8kb' }));

app.post('/api/admin/login', loginLimiter, (req, res) => {
  const pw = req.body && req.body.password;
  if (typeof pw !== 'string' || !safeEqual(pw, ADMIN_PASSWORD))
    return res.status(401).json({ error: 'Wrong password.' });
  setSession(res, makeToken(), SESSION_MS);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  setSession(res, '', 0);
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ ok: true }));

app.get('/api/admin/applications', requireAdmin, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ applications: await store.list() });
  } catch (e) {
    console.error('list failed:', e.message);
    res.status(500).json({ error: 'Could not load applications.' });
  }
});

app.get('/api/admin/applications/:id/id', requireAdmin, async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(404).end();
    const f = await store.getId(req.params.id);
    if (!f) return res.status(404).end();
    res.set({
      'Content-Type': f.type,
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    });
    res.send(f.buffer);
  } catch (e) {
    console.error('id fetch failed:', e.message);
    res.status(500).end();
  }
});

// Sends the "you have been accepted" email. Returns what happened so the admin page can say so truthfully.
async function sendAcceptance(id, note, force) {
  if (!mailer.enabled) return 'off';
  const a = await store.getForNotify(id);
  if (!a) return 'missing';
  if (!a.email) return 'no-email';
  if (a.acceptedEmailedAt && !force) return 'already-sent';
  try {
    await mailer.sendAccepted(a, note);
    await store.markAcceptedEmailed(id);
    return 'sent';
  } catch (e) {
    console.error('acceptance email failed:', e.message);
    return 'failed';
  }
}

app.patch('/api/admin/applications/:id', requireAdmin, async (req, res) => {
  try {
    const status = req.body && req.body.status;
    if (!UUID.test(req.params.id) || !STATUSES.includes(status))
      return res.status(400).json({ error: 'Invalid request.' });
    const ok = await store.setStatus(req.params.id, status);
    if (!ok) return res.status(404).json({ error: 'Not found.' });
    let email = null;
    if (status === 'accepted' && req.body.notify === true)
      email = await sendAcceptance(req.params.id, cleanNote(req.body.note), false);
    res.json({ ok: true, email });
  } catch (e) {
    console.error('status failed:', e.message);
    res.status(500).json({ error: 'Could not update.' });
  }
});

// How many places the landlord has per room type (editable on the admin page)
app.get('/api/admin/rooms', requireAdmin, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ capacity: await store.getCapacity() });
  } catch (e) {
    console.error('rooms failed:', e.message);
    res.status(500).json({ error: 'Could not load room totals.' });
  }
});

app.put('/api/admin/rooms', requireAdmin, async (req, res) => {
  try {
    const { room, total } = req.body || {};
    if (!ROOMS.includes(room) || !Number.isInteger(total) || total < 0 || total > 500)
      return res.status(400).json({ error: 'Enter a whole number from 0 to 500.' });
    await store.setCapacity(room, total);
    res.json({ ok: true });
  } catch (e) {
    console.error('rooms save failed:', e.message);
    res.status(500).json({ error: 'Could not save.' });
  }
});

app.post('/api/admin/applications/:id/accept-email', requireAdmin, async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Not found.' });
    const email = await sendAcceptance(req.params.id, cleanNote(req.body && req.body.note), true);
    res.json({ ok: true, email });
  } catch (e) {
    console.error('accept-email failed:', e.message);
    res.status(500).json({ error: 'Could not send the email.' });
  }
});

app.delete('/api/admin/applications/:id', requireAdmin, async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Not found.' });
    const ok = await store.remove(req.params.id);
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'Not found.' });
  } catch (e) {
    console.error('delete failed:', e.message);
    res.status(500).json({ error: 'Could not delete.' });
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

/* ------------------------------------ site ------------------------------------ */
app.use(
  express.static(path.join(__dirname, 'public'), {
    extensions: ['html'], // /admin -> admin.html
    setHeaders: (res, file) => {
      // HTML always revalidates so pushed updates show immediately; images may be cached a day
      res.setHeader('Cache-Control', file.endsWith('.html') ? 'no-cache' : 'public, max-age=86400');
    },
  })
);

app.use((err, req, res, next) => {
  console.error('unhandled:', err.message);
  res.status(500).json({ error: 'Something went wrong.' });
});

store
  .init()
  .then(() => {
    app.listen(PORT, () =>
      console.log(`RSM site running on port ${PORT} (storage: ${store.kind}, email alerts: ${mailer.enabled ? 'on' : 'off'})`)
    );
  })
  .catch((e) => die('Could not start the database: ' + e.message));
