const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

// Railway sits in front of the app, so the real protocol and client address
// come from its proxy headers. Needed for the Secure cookie and the login limit.
app.set('trust proxy', 1);

// ===== RAILWAY VOLUME SETUP =====
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Only photos and videos. The extension decides the Content-Type the file is
// served with, so an uploaded .html page could otherwise run as this site.
// HEIC is what iPhones save photos as.
const ALLOWED_UPLOADS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif', '.mp4', '.mov', '.webm', '.3gp'];

const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, UPLOAD_DIR); },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname).toLowerCase());
  }
});
const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const okType = /^(image|video)\//.test(file.mimetype);
    if (okType && ALLOWED_UPLOADS.includes(ext)) cb(null, true);
    else cb(new Error('Only photos (JPG, PNG, HEIC, WEBP) and videos (MP4, MOV, WEBM) can be uploaded.'));
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', (req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); }, express.static(UPLOAD_DIR));

const DB_FILE = path.join(DATA_DIR, 'db.json');
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({
    properties: [],
    alerts: [],
    // Added Website Content fields
    settings: {
      whatsapp: '0685353186',
      email: 'avukilerooms@gmail.com',
      logo: '',
      aboutUs: 'Working hand in hand with Vusani Ikhaya Properties to make property rentals and sales easy.',
      terms: '1. All listings must be verified. 2. No fraudulent activity allowed. 3. Fees must be paid before approval.',
      privacy: 'We respect your privacy and do not share your personal information with third parties.'
    },
    creds: { user: 'admin', pass: 'admin123' }
  }, null, 2));
}

function readDB() {
  const db = JSON.parse(fs.readFileSync(DB_FILE));
  if (!Array.isArray(db.alerts)) db.alerts = [];
  return db;
}
function writeDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }

// ===== HELPERS =====

// A South African WhatsApp number as wa.me wants it: 27 and nine digits.
// Only a number actually shaped like a local one (10 digits, leading 0) is
// turned into +27; anything else that is not already 27... is refused rather
// than guessed, so a typo fails here instead of messaging a stranger.
function saWhatsApp(input) {
  const d = String(input || '').replace(/\D/g, '');
  if (/^0\d{9}$/.test(d)) return '27' + d.slice(1);
  if (/^27\d{9}$/.test(d)) return d;
  return null;
}

function priceOf(p) { return Number(String(p.price || '').replace(/[^\d.]/g, '')) || 0; }

function siteUrl(req) {
  return (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

// ===== EMAIL HEADS-UP TO THE ADMIN =====
// An email when something is waiting for the admin: a new listing to approve,
// or a new alert sign-up. Sent through a Gmail account with an App Password
// (SMTP_USER + SMTP_PASS on Railway), to NOTIFY_EMAIL, or else to the email
// address in the admin's Settings. Without SMTP_USER and SMTP_PASS nothing is
// sent and the site works as before. A failed email is logged and never stops
// the listing or the sign-up from being saved.

const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const emailOn = () => Boolean(SMTP_USER && SMTP_PASS);
const notifyTo = () => process.env.NOTIFY_EMAIL || readDB().settings.email || SMTP_USER;
let mailer = null;

function notifyAdmin(req, subject, lines) {
  if (!emailOn()) return;
  if (!mailer) {
    const port = Number(process.env.SMTP_PORT || 465);
    mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
  }
  const oneLine = s => String(s).replace(/[\r\n]+/g, ' ').trim();
  mailer.sendMail({
    from: `"Soweto & Roodepoort Properties" <${SMTP_USER}>`,
    to: notifyTo(),
    subject: oneLine(subject),
    text: [...lines, '', `Open the admin: ${siteUrl(req)}/admin.html`].join('\n')
  }).catch(err => console.error(`Admin email failed (${oneLine(subject)}): ${err.message}`));
}

// A small in-memory limit per client address. Enough to stop someone guessing
// the admin password or flooding the alert sign-up from one place.
function rateLimit(max, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (recent.length >= max) return res.status(429).json({ success: false, message: 'Too many attempts. Please wait a few minutes and try again.' });
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}

// ===== ADMIN AUTH =====
// Passwords are stored as scrypt hashes. A plain password left over from
// before this change still works once and is replaced by its hash on that login.

function hashPassword(pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(String(pass), salt, 64).toString('hex')}`;
}

function checkPassword(pass, stored) {
  if (typeof stored !== 'string') return false;
  if (!stored.startsWith('scrypt$')) {
    const a = Buffer.from(String(pass)), b = Buffer.from(stored);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const [, salt, hash] = stored.split('$');
  const given = crypto.scryptSync(String(pass), salt, 64);
  return crypto.timingSafeEqual(given, Buffer.from(hash, 'hex'));
}

const DEFAULT_PASSWORD = 'admin123';
const SESSION_COOKIE = 'admin_session';
const SESSION_MS = 12 * 60 * 60 * 1000;
const sessions = new Map(); // token -> expiresAt (a restart signs the admin out)

function readCookie(req, name) {
  const found = String(req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith(name + '='));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : null;
}

function setSessionCookie(req, res, token, maxAgeMs) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (req.secure) parts.push('Secure');
  res.set('Set-Cookie', parts.join('; '));
}

function requireAdmin(req, res, next) {
  const token = readCookie(req, SESSION_COOKIE);
  const expires = token && sessions.get(token);
  if (!expires || expires < Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ success: false, message: 'Please log in.' });
  }
  next();
}

app.post('/api/admin/login', rateLimit(10, 15 * 60 * 1000), (req, res) => {
  const db = readDB();
  const { user, pass } = req.body || {};
  if (user !== db.creds.user || !checkPassword(pass, db.creds.pass)) {
    return res.status(401).json({ success: false });
  }
  if (!String(db.creds.pass).startsWith('scrypt$')) {
    db.creds.pass = hashPassword(pass);
    writeDB(db);
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_MS);
  setSessionCookie(req, res, token, SESSION_MS);
  res.json({ success: true, mustChangePassword: pass === DEFAULT_PASSWORD });
});

// Everything else under /api/admin needs a logged-in session.
app.use('/api/admin', requireAdmin);

app.get('/api/admin/me', (req, res) => res.json({ success: true, emailNotifications: emailOn() ? notifyTo() : null }));

app.post('/api/admin/logout', (req, res) => {
  sessions.delete(readCookie(req, SESSION_COOKIE));
  setSessionCookie(req, res, '', 0);
  res.json({ success: true });
});

// ===== API ROUTES =====

// Get Dashboard Stats (100% Live)
app.get('/api/admin/stats', (req, res) => {
  const db = readDB();
  const props = db.properties;

  const stats = {
    total: props.length,
    pending: props.filter(p => p.status === 'Pending Approval').length,
    approved: props.filter(p => p.status === 'Approved').length,
    rented: props.filter(p => p.status === 'Taken' && p.type === 'Rent').length,
    sold: props.filter(p => p.status === 'Taken' && p.type === 'Sale').length,
    alerts: db.alerts.length,
    revenue: props.reduce((sum, p) => {
      if (p.feePlan === 'Once-off (R50)') return sum + 50;
      if (p.feePlan === 'Placement Fee') return sum + 1000; // Example placement fee
      if (p.feePlan === 'Gold Membership') return sum + 150;
      if (p.feePlan === 'Premium Membership') return sum + 250;
      return sum;
    }, 0)
  };
  res.json(stats);
});

app.get('/api/properties', (req, res) => {
  const db = readDB();
  let props = db.properties.filter(p => p.status === 'Approved');
  if (req.query.type) props = props.filter(p => p.type === req.query.type);
  res.json(props);
});

app.post('/api/properties', (req, res, next) => {
  upload.fields([{ name: 'images', maxCount: 10 }, { name: 'video', maxCount: 1 }])(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ success: false, message: 'Each photo or video must be smaller than 50 MB.' });
    if (err && err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ success: false, message: 'You can upload up to 10 photos and 1 video.' });
    if (err) return res.status(400).json({ success: false, message: err.message });
    next();
  });
}, (req, res) => {
  const db = readDB();
  const files = req.files || {};
  const images = files['images'] ? files['images'].map(f => `/uploads/${f.filename}`) : [];
  const video = files['video'] ? `/uploads/${files['video'][0].filename}` : null;

  const newProp = {
    id: Date.now(),
    status: 'Pending Approval',
    feePlan: 'None', // Default until Admin sets it
    type: req.body.type,
    title: req.body.title,
    region: req.body.region,
    suburb: req.body.suburb,
    streetAddress: req.body.streetAddress || '',
    propType: req.body.propType,
    price: req.body.price,
    beds: req.body.beds,
    baths: req.body.baths,
    parking: req.body.parking,
    petFriendly: req.body.petFriendly,
    childFriendly: req.body.childFriendly,
    name: req.body.name,
    whatsapp: req.body.whatsapp,
    description: req.body.description,
    images: images,
    video: video,
    availableDate: req.body.availableDate || '',
    date: new Date().toLocaleDateString()
  };

  if (req.body.type === 'Rent') newProp.deposit = req.body.deposit;
  else newProp.erf = req.body.erf;

  db.properties.push(newProp);
  writeDB(db);
  res.json({ success: true, message: 'Property submitted for approval!' });

  const price = `R${priceOf(newProp).toLocaleString('en-ZA').replace(/\s/g, ' ')}${newProp.type === 'Rent' ? ' a month' : ''}`;
  notifyAdmin(req, `New listing to approve: ${newProp.propType || 'Property'} in ${newProp.suburb || newProp.region || 'unknown area'}`, [
    `A new listing is waiting for your approval.`,
    '',
    `${newProp.type === 'Sale' ? 'For sale' : 'To rent'}: ${newProp.title || '(no title)'}`,
    `${newProp.propType || 'Property'} in ${newProp.suburb || '-'}, ${newProp.region || '-'}`,
    `Price: ${price}`,
    `Photos: ${images.length}${video ? ', plus a video' : ''}`,
    `Listed by: ${newProp.name || '(no name given)'}`,
    '',
    `Approve or decline it under Properties Pending Approval on the dashboard. When you approve it, anyone waiting for a place like it will pop up to be sent a WhatsApp.`
  ]);
});

// Each listing carries how many alert subscribers it matches and has not been
// sent to yet, so the admin can see who is waiting to hear about it.
app.get('/api/admin/properties', (req, res) => {
  const db = readDB();
  res.json(db.properties.map(p => ({
    ...p,
    alertsWaiting: db.alerts.filter(a => alertMatches(a, p) && !(a.sent || []).includes(p.id)).length
  })));
});

app.put('/api/admin/properties/:id', (req, res) => {
  const db = readDB();
  const id = parseInt(req.params.id);
  db.properties = db.properties.map(p => p.id === id ? { ...p, ...req.body } : p);
  writeDB(db);
  res.json({ success: true });
});

app.delete('/api/admin/properties/:id', (req, res) => {
  const db = readDB();
  db.properties = db.properties.filter(p => p.id !== parseInt(req.params.id));
  writeDB(db);
  res.json({ success: true });
});

app.post('/api/admin/upload-logo', (req, res, next) => {
  upload.single('logo')(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message });
    next();
  });
}, (req, res) => {
  if (!req.file) return res.status(400).json({ success: false });
  const db = readDB();
  db.settings.logo = `/uploads/${req.file.filename}`;
  writeDB(db);
  res.json({ success: true, logo: db.settings.logo });
});

app.get('/api/settings', (req, res) => res.json(readDB().settings));

// Update Settings & Content. Only the fields sent are changed, so saving the
// content page cannot blank the WhatsApp number and the other way round.
app.post('/api/admin/settings', (req, res) => {
  const db = readDB();
  for (const key of ['whatsapp', 'email', 'aboutUs', 'terms', 'privacy']) {
    if (typeof req.body[key] === 'string') db.settings[key] = req.body[key];
  }
  writeDB(db);
  res.json({ success: true });
});

app.post('/api/admin/creds', (req, res) => {
  const db = readDB();
  const { currentPass, user, pass } = req.body || {};
  if (!checkPassword(currentPass, db.creds.pass)) {
    return res.status(400).json({ success: false, message: 'Your current password is not right.' });
  }
  if (!user || String(pass || '').length < 8 || pass === DEFAULT_PASSWORD) {
    return res.status(400).json({ success: false, message: 'Choose a username and a new password of at least 8 characters.' });
  }
  db.creds = { user: String(user).trim(), pass: hashPassword(pass) };
  writeDB(db);
  res.json({ success: true });
});

// ===== WHATSAPP ALERTS =====
// A renter or buyer leaves their number and what they are looking for. When a
// listing is approved, the admin dashboard shows who it matches, each with a
// ready-written WhatsApp message the admin sends from their own phone. Nothing
// is sent automatically and no number is used for anything else.

const MAX_ALERTS_PER_NUMBER = 5;

function alertMatches(a, p) {
  if (p.status !== 'Approved') return false;
  if (a.type && a.type !== p.type) return false;
  if (a.region && a.region !== p.region) return false;
  if (a.suburb && a.suburb !== p.suburb) return false;
  if (a.propType && a.propType !== p.propType) return false;
  if (a.maxPrice && priceOf(p) > a.maxPrice) return false;
  return true;
}

function describeAlert(a) {
  const what = a.propType || (a.type === 'Sale' ? 'Any property for sale' : 'Any place to rent');
  const where = a.suburb || a.region || 'Soweto & Roodepoort';
  const price = a.maxPrice ? `, up to R${a.maxPrice.toLocaleString('en-ZA').replace(/\s/g, ' ')}` : '';
  return `${what} in ${where}${price}`;
}

function alertMessage(a, p, site) {
  const page = p.type === 'Sale' ? 'buy.html' : 'rent.html';
  const price = `R${priceOf(p).toLocaleString('en-ZA').replace(/\s/g, ' ')}${p.type === 'Rent' ? ' a month' : ''}`;
  return [
    `Hi ${a.name || 'there'}, a new place matches your alert on Soweto & Roodepoort Properties:`,
    '',
    `${p.propType || 'Property'} in ${p.suburb}, ${price}`,
    `${p.beds || '-'} bed, ${p.baths || '-'} bath`,
    '',
    `See it here: ${site}/${page}?listing=${p.id}`,
    '',
    `To stop these alerts, reply STOP or tap: ${site}/stop-alerts.html?t=${a.token}`
  ].join('\n');
}

app.post('/api/alerts', rateLimit(10, 60 * 60 * 1000), (req, res) => {
  const b = req.body || {};
  const whatsapp = saWhatsApp(b.whatsapp);
  if (!whatsapp) return res.status(400).json({ success: false, field: 'whatsapp', message: 'Enter a South African WhatsApp number, like 082 123 4567.' });
  if (b.consent !== true) return res.status(400).json({ success: false, field: 'consent', message: 'Tick the box to agree to receive WhatsApp alerts.' });
  if (!['Rent', 'Sale'].includes(b.type)) return res.status(400).json({ success: false, message: 'Choose rent or buy.' });

  // One line of plain text: these end up in WhatsApp messages and email subjects.
  const clean = (v, max) => String(v || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const alert = {
    type: b.type,
    region: ['Soweto', 'Roodepoort'].includes(b.region) ? b.region : '',
    suburb: clean(b.suburb, 60),
    propType: clean(b.propType, 60),
    maxPrice: Math.max(0, parseInt(b.maxPrice, 10) || 0),
  };

  const db = readDB();
  const mine = db.alerts.filter(a => a.whatsapp === whatsapp);
  const same = mine.find(a => ['type', 'region', 'suburb', 'propType', 'maxPrice'].every(k => a[k] === alert[k]));
  if (same) return res.json({ success: true, message: `You already have this alert: ${describeAlert(same)}.` });
  if (mine.length >= MAX_ALERTS_PER_NUMBER) {
    return res.status(400).json({ success: false, message: `You already have ${MAX_ALERTS_PER_NUMBER} alerts. Stop one from a message we sent you before adding another.` });
  }

  const saved = {
    id: Date.now(),
    token: crypto.randomBytes(16).toString('hex'),
    whatsapp,
    name: clean(b.name, 40),
    ...alert,
    consentText: clean(b.consentText, 500),
    createdAt: new Date().toISOString(),
    sent: []
  };
  db.alerts.push(saved);
  writeDB(db);
  res.json({ success: true, message: `Done. We will WhatsApp you when a match is listed: ${describeAlert(saved)}.` });

  // Listings already live that fit are worth sending now, not at the next approval.
  const liveMatches = db.properties.filter(p => alertMatches(saved, p));
  notifyAdmin(req, `New WhatsApp alert sign-up: ${saved.type === 'Sale' ? 'Buy' : 'Rent'}, ${describeAlert(saved)}`, [
    `${saved.name || 'Someone'} wants to hear about new places on WhatsApp.`,
    '',
    `Looking to ${saved.type === 'Sale' ? 'buy' : 'rent'}: ${describeAlert(saved)}`,
    '',
    liveMatches.length
      ? `${liveMatches.length} live ${liveMatches.length === 1 ? 'listing already fits' : 'listings already fit'}: ${liveMatches.slice(0, 5).map(p => `${p.propType || 'property'} in ${p.suburb}`).join('; ')}${liveMatches.length > 5 ? '; and more' : ''}. Open Property Management and tap Alerts on ${liveMatches.length === 1 ? 'it' : 'each'} to send it to them now.`
      : `Nothing live fits yet. When you approve a listing that does, they will pop up to be sent a WhatsApp.`
  ]);
});

// Stopping removes every alert on that number, not just the one in the link,
// because "stop" means stop. The data is deleted, not flagged.
app.post('/api/alerts/stop', (req, res) => {
  const token = String((req.body || {}).token || '');
  const db = readDB();
  const found = token && db.alerts.find(a => a.token === token);
  if (!found) return res.json({ success: true, removed: 0 });
  const before = db.alerts.length;
  db.alerts = db.alerts.filter(a => a.whatsapp !== found.whatsapp);
  writeDB(db);
  res.json({ success: true, removed: before - db.alerts.length });
});

app.get('/api/admin/alerts', (req, res) => {
  const db = readDB();
  res.json(db.alerts.map(a => ({
    id: a.id, name: a.name, whatsapp: a.whatsapp, createdAt: a.createdAt,
    lookingFor: `${a.type === 'Sale' ? 'Buy' : 'Rent'}: ${describeAlert(a)}`,
    sentCount: (a.sent || []).length
  })));
});

app.delete('/api/admin/alerts/:id', (req, res) => {
  const db = readDB();
  db.alerts = db.alerts.filter(a => a.id !== parseInt(req.params.id));
  writeDB(db);
  res.json({ success: true });
});

// Who this listing matches, each with the message and a wa.me link ready to tap.
app.get('/api/admin/properties/:id/matches', (req, res) => {
  const db = readDB();
  const p = db.properties.find(x => x.id === parseInt(req.params.id));
  if (!p) return res.status(404).json({ success: false, message: 'Listing not found.' });
  const site = siteUrl(req);
  res.json(db.alerts.filter(a => alertMatches(a, p)).map(a => {
    const message = alertMessage(a, p, site);
    return {
      alertId: a.id,
      name: a.name,
      whatsapp: a.whatsapp,
      lookingFor: describeAlert(a),
      sent: (a.sent || []).includes(p.id),
      link: `https://wa.me/${a.whatsapp}?text=${encodeURIComponent(message)}`
    };
  }));
});

app.post('/api/admin/alerts/:id/sent', (req, res) => {
  const db = readDB();
  const a = db.alerts.find(x => x.id === parseInt(req.params.id));
  const propertyId = parseInt((req.body || {}).propertyId);
  if (!a || !propertyId) return res.status(404).json({ success: false });
  a.sent = Array.from(new Set([...(a.sent || []), propertyId]));
  writeDB(db);
  res.json({ success: true });
});

// A bad request (broken JSON, for one) gets a short answer, not Express's
// default page, which printed the server's file paths and stack trace.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ success: false, message: err.status === 400 ? 'That request could not be read.' : 'Something went wrong. Please try again.' });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
