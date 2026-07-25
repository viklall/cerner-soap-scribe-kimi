const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const pipeline = require('./pipeline');
const oauth = require('./cerner_writeback/oauth');
const writeback = require('./cerner_writeback/writeback');

const app = express();
const PORT = process.env.PORT || 8080;
const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${uuidv4()}-${file.originalname}`)
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// ── Health ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Upload & Process ──
app.post('/api/visits', upload.single('audio'), async (req, res) => {
  const visitId = uuidv4();
  const filePath = req.file?.path;

  if (!filePath) return res.status(400).json({ error: 'No audio file uploaded' });

  console.log(`[${visitId}] Received audio: ${req.file.originalname} (${req.file.size} bytes)`);

  try {
    const result = await pipeline.process(filePath, visitId);
    res.json({ visitId, ...result });
  } catch (err) {
    console.error(`[${visitId}] Pipeline error:`, err.message);
    res.status(500).json({ error: err.message, visitId });
  }
});

// ── Cerner OAuth ──
app.get('/auth/cerner/login', oauth.authorize);
app.get('/callback', oauth.callback);           // exact match for registered redirect
app.get('/auth/cerner/callback', oauth.callback); // alias for convenience

app.get('/api/cerner/status', oauth.status);

// ── Writeback ──
app.post('/api/writeback', writeback.postNote);

// ── Mock mode helpers ──
app.post('/api/mock/connect', (req, res) => {
  if (process.env.CERNER_MOCK_MODE !== 'true') {
    return res.status(403).json({ error: 'Mock mode not enabled. Set CERNER_MOCK_MODE=true' });
  }
  req.session = req.session || {};
  req.session.cerner = {
    access_token: 'mock_token_' + uuidv4(),
    patient: 'mock-patient-123',
    expires_at: Date.now() + 3600000
  };
  res.json({ connected: true, patient: req.session.cerner.patient, mode: 'mock' });
});

app.listen(PORT, () => {
  console.log(`🩺 Cerner SOAP Scribe running on http://localhost:${PORT}`);
  console.log(`   OAuth login: http://localhost:${PORT}/auth/cerner/login`);
  console.log(`   Mock mode:   ${process.env.CERNER_MOCK_MODE === 'true' ? 'ENABLED' : 'disabled'}`);
});
