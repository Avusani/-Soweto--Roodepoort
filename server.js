const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, uploadDir); },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB_FILE = 'db.json';
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({
    properties: [],
    settings: { whatsapp: '0685353186', email: 'avukilerooms@gmail.com', logo: '' },
    creds: { user: 'admin', pass: 'admin123' }
  }, null, 2));
}

function readDB() { return JSON.parse(fs.readFileSync(DB_FILE)); }
function writeDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }

app.get('/api/properties', (req, res) => {
  const db = readDB();
  let props = db.properties.filter(p => p.status === 'Approved');
  if (req.query.type) props = props.filter(p => p.type === req.query.type);
  res.json(props);
});

app.post('/api/properties', upload.fields([{ name: 'images', maxCount: 10 }, { name: 'video', maxCount: 1 }]), (req, res) => {
  const db = readDB();
  const images = req.files['images'] ? req.files['images'].map(f => `/uploads/${f.filename}`) : [];
  const video = req.files['video'] ? `/uploads/${req.files['video'][0].filename}` : null;
  
  const newProp = {
    id: Date.now(),
    status: 'Pending Approval',
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

  if (req.body.type === 'Rent') {
    newProp.deposit = req.body.deposit;
  } else {
    newProp.erf = req.body.erf;
  }

  db.properties.push(newProp);
  writeDB(db);
  res.json({ success: true, message: 'Property submitted for approval!' });
});

app.post('/api/admin/login', (req, res) => {
  const db = readDB();
  if (req.body.user === db.creds.user && req.body.pass === db.creds.pass) res.json({ success: true });
  else res.status(401).json({ success: false });
});

app.get('/api/admin/properties', (req, res) => res.json(readDB().properties));

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

app.post('/api/admin/upload-logo', upload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false });
  const db = readDB();
  db.settings.logo = `/uploads/${req.file.filename}`;
  writeDB(db);
  res.json({ success: true, logo: db.settings.logo });
});

app.get('/api/settings', (req, res) => res.json(readDB().settings));

app.post('/api/admin/settings', (req, res) => {
  const db = readDB();
  db.settings.whatsapp = req.body.whatsapp;
  db.settings.email = req.body.email;
  writeDB(db);
  res.json({ success: true });
});

app.post('/api/admin/creds', (req, res) => {
  const db = readDB();
  db.creds = req.body;
  writeDB(db);
  res.json({ success: true });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
