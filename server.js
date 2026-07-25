// VERSION: 2026-07-25-CLOUDFLARE-FIX-v2
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 8080;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
const VISITS_FILE = path.join(DATA_DIR, 'visits.json');
const MAX_VISIT_HISTORY = 200;
const MOCK_MODE = process.env.CERNER_MOCK_MODE === 'true';
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const hasCloudflare = !!CF_ACCOUNT_ID && !!CF_API_TOKEN;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const hasUpstash = !!UPSTASH_URL && !!UPSTASH_TOKEN;
const D1_DATABASE_ID = process.env.CLOUDFLARE_D1_DATABASE_ID;
const hasD1 = hasCloudflare && !!D1_DATABASE_ID;

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const sessions = new Map();
let lastTranscriptionError = null;
let lastTranscriptionResult = null;

// Visit history. Tries Cloudflare D1 first (5GB free, survives redeploys),
// then Upstash Redis (256MB free, also survives redeploys), then falls back
// to the local JSON file (survives a restart, not a redeploy).
let visitHistory = [];

function d1Query(sql, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ sql: sql, params: params || [] });
    const options = {
      hostname: 'api.cloudflare.com',
      path: '/client/v4/accounts/' + CF_ACCOUNT_ID + '/d1/database/' + D1_DATABASE_ID + '/query',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + CF_API_TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 15000
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.success) {
            reject(new Error(json.errors?.[0]?.message || 'D1 query failed'));
          } else {
            resolve(json.result && json.result[0] ? json.result[0] : { results: [] });
          }
        } catch (e) {
          reject(new Error('Invalid D1 response: ' + data.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => reject(new Error('D1 request timeout')));
    req.write(body);
    req.end();
  });
}

async function ensureD1Table() {
  await d1Query('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)');
}

function upstashRequest(cmdPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(UPSTASH_URL + cmdPath);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Invalid Upstash response: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => reject(new Error('Upstash request timeout')));
    req.setTimeout(15000);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function loadVisitHistory() {
  if (hasD1) {
    try {
      await ensureD1Table();
      const result = await d1Query('SELECT value FROM kv WHERE key = ?', ['visitHistory']);
      const row = result.results && result.results[0];
      visitHistory = row ? JSON.parse(row.value) : [];
      console.log('Loaded ' + visitHistory.length + ' visits from Cloudflare D1');
      return;
    } catch (e) {
      console.error('Failed to load visit history from D1: ' + e.message);
    }
  }
  if (hasUpstash) {
    try {
      const result = await upstashRequest('/get/visitHistory');
      visitHistory = result.result ? JSON.parse(result.result) : [];
      console.log('Loaded ' + visitHistory.length + ' visits from Upstash');
      return;
    } catch (e) {
      console.error('Failed to load visit history from Upstash: ' + e.message);
    }
  }
  try {
    if (fs.existsSync(VISITS_FILE)) {
      visitHistory = JSON.parse(fs.readFileSync(VISITS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load visit history from disk: ' + e.message);
  }
}

async function saveVisitRecord(record) {
  visitHistory.unshift(record);
  visitHistory = visitHistory.slice(0, MAX_VISIT_HISTORY);

  if (hasD1) {
    try {
      await d1Query(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        ['visitHistory', JSON.stringify(visitHistory)]
      );
      return;
    } catch (e) {
      console.error('Failed to persist visit history to D1: ' + e.message);
    }
  }
  if (hasUpstash) {
    try {
      await upstashRequest('/set/visitHistory', JSON.stringify(visitHistory));
      return;
    } catch (e) {
      console.error('Failed to persist visit history to Upstash: ' + e.message);
    }
  }
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(VISITS_FILE, JSON.stringify(visitHistory));
  } catch (e) {
    console.error('Failed to persist visit history to disk: ' + e.message);
  }
}

function uuidv4() {
  return crypto.randomUUID();
}

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Cerner-Session');
}

function parseMultipart(buffer, boundary) {
  const parts = [];
  const boundaryBuffer = Buffer.from('--' + boundary);
  let start = buffer.indexOf(boundaryBuffer);

  while (start !== -1) {
    start += boundaryBuffer.length;
    let end = buffer.indexOf(boundaryBuffer, start);
    if (end === -1) break;

    let part = buffer.slice(start, end);
    if (part.length >= 2 && part[0] === 0x0D && part[1] === 0x0A) {
      part = part.slice(2);
    }
    if (part.length >= 2 && part[part.length - 2] === 0x0D && part[part.length - 1] === 0x0A) {
      part = part.slice(0, -2);
    }

    const headerEnd = part.indexOf(Buffer.from([0x0D, 0x0A, 0x0D, 0x0A]));
    if (headerEnd === -1) continue;

    const headers = part.slice(0, headerEnd).toString();
    const data = part.slice(headerEnd + 4);

    const nameMatch = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]+)"/);

    parts.push({
      name: nameMatch ? nameMatch[1] : null,
      filename: filenameMatch ? filenameMatch[1] : null,
      data: data,
      headers: headers
    });

    start = end;
  }

  return parts;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJSON(req) {
  const body = await readBody(req);
  try {
    return JSON.parse(body.toString());
  } catch {
    return {};
  }
}

function serveStatic(reqPath, res) {
  const filePath = path.join(__dirname, 'public', reqPath === '/' ? 'index.html' : reqPath);

  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
}

// ── Cloudflare Transcription (raw binary, NOT base64 JSON) ──
async function transcribeWithCloudflare(audioBuffer) {
  return new Promise((resolve, reject) => {
    // Cloudflare Whisper expects RAW BINARY audio, not base64 JSON
    // Send audio/webm bytes directly in the body

    console.log('[Cloudflare] Sending ' + audioBuffer.length + ' bytes of raw audio/webm');

    const options = {
      hostname: 'api.cloudflare.com',
      path: '/client/v4/accounts/' + CF_ACCOUNT_ID + '/ai/run/@cf/openai/whisper',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + CF_API_TOKEN,
        'Content-Type': 'audio/webm',
        'Content-Length': audioBuffer.length
      },
      timeout: 120000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('[Cloudflare] Response status: ' + res.statusCode);
        console.log('[Cloudflare] Response body: ' + data.slice(0, 500));
        try {
          const json = JSON.parse(data);
          console.log('[Cloudflare] FULL RESPONSE: ' + JSON.stringify(json).slice(0, 1000));
          if (!json.success) {
            const errMsg = json.errors?.[0]?.message || JSON.stringify(json.errors) || 'Cloudflare transcription failed';
            console.error('[Cloudflare] API error: ' + errMsg);
            reject(new Error(errMsg));
          } else {
            // Cloudflare may return result.text or result.transcript or result.words
            const result = json.result || {};
            const text = result.text || result.transcript || (result.words ? result.words.map(w => w.word).join(' ') : '') || '';
            console.log('[Cloudflare] Extracted text (' + text.length + ' chars): ' + text.slice(0, 100));
            resolve(text);
          }
        } catch (e) {
          console.error('[Cloudflare] JSON parse error: ' + e.message);
          console.error('[Cloudflare] Raw response: ' + data.slice(0, 500));
          reject(new Error('Invalid response: ' + data.slice(0, 200)));
        }
      });
    });

    req.on('error', (err) => {
      console.error('[Cloudflare] Request error: ' + err.message);
      reject(err);
    });
    req.on('timeout', () => {
      console.error('[Cloudflare] Request timeout');
      reject(new Error('Cloudflare request timeout'));
    });
    req.write(audioBuffer);
    req.end();
  });
}

// ── Clinical finding vocabulary: transcript keywords -> narrative phrase + category ──
// Order matters where phrases overlap (e.g. 'high blood pressure' before 'blood pressure')
// so the more specific match wins and the vaguer one is skipped.
const CLINICAL_FINDINGS = [
  { keys: ['chest pain'], phrase: 'chest pain', category: 'cardiac' },
  { keys: ['shortness of breath', 'trouble breathing', 'breathing'], phrase: 'shortness of breath', category: 'respiratory' },
  { keys: ['cough'], phrase: 'cough', category: 'respiratory' },
  { keys: ['sore throat'], phrase: 'sore throat', category: 'viral' },
  { keys: ['congestion', 'runny nose', 'stuffy nose', 'cold'], phrase: 'cold/upper respiratory symptoms', category: 'viral' },
  { keys: ['fever'], phrase: 'fever', category: 'viral' },
  { keys: ['body ache', 'body aches', 'myalgia'], phrase: 'body aches', category: 'viral' },
  { keys: ['headache'], phrase: 'headache', category: 'headache' },
  { keys: ['dizzy', 'dizziness'], phrase: 'dizziness', category: 'dizziness' },
  { keys: ['nausea'], phrase: 'nausea', category: 'gi' },
  { keys: ['vomit', 'vomiting'], phrase: 'vomiting', category: 'gi' },
  { keys: ['heartburn', 'acid reflux', 'gerd'], phrase: 'heartburn/reflux symptoms', category: 'gerd' },
  { keys: ['high blood pressure', 'hypertension', 'elevated bp'], phrase: 'elevated blood pressure', category: 'hypertension' },
  { keys: ['blood pressure', ' bp '], phrase: 'blood pressure concerns', category: 'bp_general' },
  { keys: ['diabetes'], phrase: 'diabetes', category: 'endocrine' },
  { keys: ['depression', 'depressed mood'], phrase: 'depressed mood', category: 'depression' },
  { keys: ['anxiety', 'anxious'], phrase: 'anxiety', category: 'anxiety' },
  { keys: ['insomnia', 'trouble sleeping', "can't sleep", 'difficulty sleeping'], phrase: 'sleep difficulty', category: 'insomnia' },
  { keys: ['fatigue', 'tired all the time', 'low energy'], phrase: 'fatigue', category: 'fatigue' },
  { keys: ['back pain'], phrase: 'back pain', category: 'back_pain' },
  { keys: ['joint pain'], phrase: 'joint pain', category: 'joint_pain' },
  { keys: ['ear pain', 'earache'], phrase: 'ear pain', category: 'ear_pain' },
  { keys: ['rash'], phrase: 'skin rash', category: 'rash' },
  { keys: ['urinary', 'burning urination', 'painful urination'], phrase: 'urinary symptoms', category: 'uti' },
  { keys: ['pain', 'hurt'], phrase: 'pain', category: 'pain' }
];

// When the key on the left is found, drop the vaguer/overlapping category on the right
// (e.g. "chest pain" already covers "pain" - listing both would be redundant).
const SUPPRESSES = {
  hypertension: ['bp_general'],
  cardiac: ['pain'],
  back_pain: ['pain'],
  joint_pain: ['pain'],
  ear_pain: ['pain']
};

// Acute/safety-relevant findings lead the note regardless of the order they were
// mentioned in - a real note doesn't bury "chest pain" under "sleep difficulty"
// just because sleep came up first in conversation.
const CATEGORY_PRIORITY = [
  'cardiac', 'respiratory', 'hypertension', 'depression', 'dizziness', 'anxiety',
  'headache', 'gi', 'uti', 'endocrine', 'gerd', 'back_pain', 'joint_pain',
  'ear_pain', 'fatigue', 'insomnia', 'rash', 'bp_general', 'viral', 'pain'
];
function byClinicalPriority(a, b) {
  return CATEGORY_PRIORITY.indexOf(a) - CATEGORY_PRIORITY.indexOf(b);
}

const ASSESSMENT_BY_CATEGORY = {
  cardiac: 'Reported chest pain warrants prompt evaluation to rule out a cardiac cause.',
  respiratory: 'Respiratory symptoms reported; warrants further evaluation.',
  viral: 'Symptom pattern is consistent with a viral illness/upper respiratory infection, pending provider confirmation.',
  headache: 'Headache reported; further evaluation warranted if severe, sudden-onset, or accompanied by other neurological symptoms.',
  dizziness: 'Dizziness reported; further evaluation may be warranted.',
  gi: 'Gastrointestinal symptoms reported.',
  gerd: 'Reflux/heartburn symptoms reported.',
  hypertension: 'Hypertension noted; blood pressure management indicated.',
  bp_general: 'Blood pressure concern reported; vitals to be reviewed and hypertension evaluated if elevated.',
  endocrine: 'Diabetes reported; glycemic control to be reviewed.',
  depression: 'Depressed mood reported; screen for severity and safety (e.g. suicidal ideation) as clinically indicated.',
  anxiety: 'Anxiety symptoms reported; further evaluation may be warranted.',
  insomnia: 'Sleep difficulty reported.',
  fatigue: 'Fatigue reported; broad differential to be considered by provider.',
  back_pain: 'Back pain reported.',
  joint_pain: 'Joint pain reported.',
  ear_pain: 'Ear pain reported.',
  rash: 'Skin rash reported.',
  uti: 'Urinary symptoms reported; possible urinary tract infection.',
  pain: 'Pain reported; further characterization needed to guide management.'
};

const PLAN_BY_CATEGORY = {
  cardiac: 'Obtain EKG and cardiac workup as indicated; consider urgent referral if symptoms are acute or severe.',
  respiratory: 'Assess respiratory status; consider pulmonary evaluation if symptoms persist or worsen.',
  viral: 'Recommend rest, fluids, and OTC symptomatic care (analgesics/antipyretics/decongestants as appropriate).',
  headache: 'Recommend analgesics (e.g. acetaminophen/ibuprofen) as appropriate; reassess if headache is severe, sudden-onset, or worsening.',
  dizziness: 'Evaluate for underlying cause (e.g. orthostatic hypotension, inner ear); advise caution with activities requiring balance until resolved.',
  gi: 'Maintain hydration; antiemetic as needed; reassess if symptoms persist beyond 48 hours.',
  gerd: 'Recommend dietary modification and OTC acid reducer as appropriate; further workup if persistent.',
  hypertension: 'Monitor blood pressure; consider antihypertensive therapy per provider assessment.',
  bp_general: 'Check and document blood pressure; evaluate for hypertension if elevated.',
  endocrine: 'Monitor blood glucose; review current diabetes management plan.',
  depression: 'Administer depression screening (e.g. PHQ-9) as appropriate; assess safety and consider behavioral health referral.',
  anxiety: 'Consider anxiety screening (e.g. GAD-7); discuss coping strategies and behavioral health referral if indicated.',
  insomnia: 'Review sleep hygiene; consider further workup if persistent.',
  fatigue: 'Consider basic labs (e.g. CBC, TSH) if fatigue is persistent or unexplained.',
  back_pain: 'Recommend activity modification and analgesics as appropriate; evaluate for red-flag symptoms (numbness, weakness, bowel/bladder changes).',
  joint_pain: 'Consider NSAIDs as appropriate; further evaluation if persistent or associated with swelling.',
  ear_pain: 'Ear exam recommended; consider treatment for otitis media/externa if indicated.',
  rash: 'Visual skin exam recommended; consider allergy or dermatologic evaluation if persistent or worsening.',
  uti: 'Obtain urinalysis; consider empiric treatment per provider assessment.',
  pain: 'Analgesics as appropriate; identify pain source for targeted treatment.'
};

function joinWithAnd(items) {
  if (items.length === 1) return items[0];
  if (items.length === 2) return items[0] + ' and ' + items[1];
  return items.slice(0, -1).join(', ') + ', and ' + items[items.length - 1];
}

// ── Generate SOAP ──
// patientName should come from the verified chart/visit context (e.g. Cerner FHIR lookup),
// never parsed from the transcript itself - voice transcription is unreliable for proper
// nouns and misidentifying a patient in a real EHR writeback is a genuine safety risk.
function generateSOAP(transcript, visitId, source, patientName) {
  const date = new Date().toISOString().split('T')[0];

  if (!transcript || transcript.length < 10) {
    return {
      Subjective: (patientName ? 'Patient: ' + patientName + '. ' : '') + 'Patient presents for visit on ' + date + '. Chief complaint documented.',
      Objective: 'Vital signs and physical exam findings to be documented.',
      Assessment: 'Clinical assessment pending provider review.',
      Plan: '1. Review visit documentation\n2. Verify findings\n3. Follow up as indicated',
      transcript: transcript || '[No transcript available]',
      mode: source || 'stub',
      note: 'Generated from ' + (source || 'stub') + '. Visit ID: ' + visitId
    };
  }

  const lower = transcript.toLowerCase();

  const foundPhrases = [];
  const foundCategories = [];
  const matchedKeys = [];
  CLINICAL_FINDINGS.forEach(function (finding) {
    var alreadyCovered = finding.keys.some(function (key) { return matchedKeys.indexOf(key) !== -1; });
    var isMatch = !alreadyCovered && finding.keys.some(function (key) { return lower.includes(key); });
    if (isMatch) {
      foundPhrases.push(finding.phrase);
      foundCategories.push(finding.category);
      matchedKeys.push.apply(matchedKeys, finding.keys);
    }
  });
  Object.keys(SUPPRESSES).forEach(function (winner) {
    if (foundCategories.indexOf(winner) === -1) return;
    SUPPRESSES[winner].forEach(function (loser) {
      var idx = foundCategories.indexOf(loser);
      if (idx !== -1) {
        foundCategories.splice(idx, 1);
        foundPhrases.splice(idx, 1);
      }
    });
  });

  let subjective = '';
  if (patientName) subjective += 'Patient: ' + patientName + '. ';
  subjective += foundPhrases.length
    ? 'Patient reports ' + joinWithAnd(foundPhrases) + '. '
    : 'Patient presents with concerns as documented in transcript. ';
  subjective += 'Transcript: "' + transcript + '"';
  subjective = subjective.trim();

  let objective = 'Physical exam and vital signs to be confirmed by provider; not directly captured via voice transcription. ';
  if (lower.includes('blood pressure') || lower.includes(' bp ')) objective += 'Blood pressure was discussed and should be documented from the visit. ';
  if (lower.includes('heart') || lower.includes('lungs') || foundCategories.indexOf('respiratory') !== -1 || foundCategories.indexOf('cardiac') !== -1) {
    objective += 'Cardiopulmonary exam indicated given reported symptoms. ';
  }

  // "viral" fires from any single symptom in its cluster (fever/cough/congestion/sore
  // throat/body aches); only assert a viral-syndrome assessment when 2+ of those
  // co-occur, otherwise a lone symptom gets a more honest, non-presumptive line.
  const viralClusterSize = foundCategories.filter(function (c) { return c === 'viral'; }).length;

  const uniqueCategories = foundCategories
    .filter(function (c, i) { return foundCategories.indexOf(c) === i; })
    .sort(byClinicalPriority);

  const assessment = uniqueCategories.length
    ? uniqueCategories.map(function (c) {
        if (c === 'viral' && viralClusterSize < 2) {
          return 'Isolated symptom reported that may be viral in origin, but is nonspecific on its own; further history needed to narrow the differential.';
        }
        return ASSESSMENT_BY_CATEGORY[c];
      }).join(' ')
    : 'Assessment based on clinical presentation and documented findings; pending provider review.';

  const planItems = uniqueCategories.map(function (c) { return PLAN_BY_CATEGORY[c]; });
  if (lower.includes('prescription') || lower.includes('medication')) planItems.push('Prescription sent to pharmacy.');
  if (lower.includes('referral')) planItems.push('Referral placed.');
  if (lower.includes('lab') || lower.includes('blood work')) planItems.push('Labs ordered.');
  planItems.push('Follow up as needed.');
  planItems.push('Patient education provided regarding reported symptoms.');
  const plan = planItems.map(function (item, i) { return (i + 1) + '. ' + item; }).join('\n');

  return {
    Subjective: subjective,
    Objective: objective.trim(),
    Assessment: assessment,
    Plan: plan,
    transcript: transcript,
    mode: source || 'generated',
    note: 'Generated from ' + (source || 'transcript') + '. Visit ID: ' + visitId
  };
}

const routes = {};

routes['GET /api/version'] = async (req, res) => {
  return {
    version: '2026-07-25-v2',
    cloudflareConfigured: hasCloudflare,
    mockMode: MOCK_MODE,
    timestamp: new Date().toISOString()
  };
};

routes['GET /api/health'] = async (req, res) => {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    mockMode: MOCK_MODE,
    cloudflareConfigured: hasCloudflare,
    cloudflareAccountId: CF_ACCOUNT_ID ? CF_ACCOUNT_ID.slice(0, 8) + '...' : null,
    openaiConfigured: !!process.env.OPENAI_API_KEY,
    upstashConfigured: hasUpstash,
    d1Configured: hasD1
  };
};

// ── DEBUG: Test Cloudflare connection ──
routes['GET /api/test-cloudflare'] = async (req, res) => {
  if (!hasCloudflare) {
    return { error: 'Cloudflare not configured', hint: 'Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN' };
  }

  // Send a tiny silent audio test (1 second of silence as base64)
  const silentWav = Buffer.from('UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=', 'base64');

  try {
    const result = await transcribeWithCloudflare(silentWav);
    return { success: true, transcript: result, message: 'Cloudflare connection works' };
  } catch (err) {
    return { success: false, error: err.message };
  }
};

// ── DEBUG: Last transcription log ──
routes['GET /api/debug'] = async (req, res) => {
  return {
    cloudflareConfigured: hasCloudflare,
    lastError: lastTranscriptionError,
    lastResult: lastTranscriptionResult,
    env: {
      accountIdSet: !!CF_ACCOUNT_ID,
      tokenSet: !!CF_API_TOKEN,
      accountIdPrefix: CF_ACCOUNT_ID ? CF_ACCOUNT_ID.slice(0, 8) : null
    }
  };
};

routes['POST /api/visits'] = async (req, res) => {
  const contentType = req.headers['content-type'] || '';
  const visitId = uuidv4();

  if (!contentType.includes('multipart/form-data')) {
    res.writeHead(400);
    return { error: 'Expected multipart/form-data' };
  }

  const boundary = contentType.split('boundary=')[1];
  if (!boundary) {
    res.writeHead(400);
    return { error: 'Missing boundary' };
  }

  const body = await readBody(req);
  const parts = parseMultipart(body, boundary);

  const audioPart = parts.find(p => p.name === 'audio' && p.filename);
  const transcriptPart = parts.find(p => p.name === 'transcript');
  const patientNamePart = parts.find(p => p.name === 'patientName');

  if (!audioPart) {
    res.writeHead(400);
    return { error: 'No audio file uploaded' };
  }

  console.log('[' + visitId + '] Audio: ' + audioPart.filename + ' (' + audioPart.data.length + ' bytes)');
  console.log('[' + visitId + '] Cloudflare configured: ' + hasCloudflare);

  // Stash the raw audio on disk keyed by visitId, so /api/soap (a separate later
  // request with no audio of its own) can pick it up once the note is generated
  // and the visit is actually persisted.
  try {
    fs.writeFileSync(path.join(UPLOAD_DIR, visitId + '.webm'), audioPart.data);
  } catch (e) {
    console.error('[' + visitId + '] Failed to stash audio: ' + e.message);
  }

  let transcript = transcriptPart ? transcriptPart.data.toString() : null;
  let source = 'browser-speech';
  let cloudflareError = null;

  // Try Cloudflare Whisper
  if (!transcript && hasCloudflare) {
    try {
      console.log('[' + visitId + '] Calling Cloudflare Whisper...');
      transcript = await transcribeWithCloudflare(audioPart.data);
      source = 'cloudflare-whisper';
      lastTranscriptionResult = { visitId, transcript: transcript.slice(0, 100), source };
      console.log('[' + visitId + '] SUCCESS: ' + transcript.length + ' chars');
    } catch (err) {
      console.error('[' + visitId + '] Cloudflare FAILED: ' + err.message);
      cloudflareError = err.message;
      lastTranscriptionError = { visitId, error: err.message, time: new Date().toISOString() };
    }
  }

  const patientName = patientNamePart ? patientNamePart.data.toString().trim() : '';

  return {
    visitId: visitId,
    transcript: transcript,
    patientName: patientName,
    fileName: audioPart.filename,
    cloudflareConfigured: hasCloudflare,
    cloudflareError: cloudflareError,
    source: source,
    hint: hasCloudflare ? null : 'Set CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN for free Whisper'
  };
};

// Separate step so the clinician can review/correct the raw transcript (speech-to-text
// reliably mishears names and specific terms) before it's turned into a clinical note.
routes['POST /api/soap'] = async (req, res) => {
  const body = await readJSON(req);
  const transcript = (body.transcript || '').toString();
  const visitId = body.visitId || uuidv4();
  const patientName = (body.patientName || '').toString().trim();
  const source = body.source || 'generated';

  const soap = generateSOAP(transcript, visitId, source, patientName);

  let audioBase64 = null;
  const audioPath = path.join(UPLOAD_DIR, visitId + '.webm');
  try {
    if (fs.existsSync(audioPath)) {
      audioBase64 = fs.readFileSync(audioPath).toString('base64');
      fs.unlinkSync(audioPath);
    }
  } catch (e) {
    console.error('[' + visitId + '] Failed to read/embed stashed audio: ' + e.message);
  }

  await saveVisitRecord({
    visitId: visitId,
    patientName: patientName,
    transcript: transcript,
    soap: soap,
    source: source,
    audioBase64: audioBase64,
    audioMimeType: audioBase64 ? 'audio/webm' : null,
    createdAt: new Date().toISOString()
  });

  return {
    visitId: visitId,
    soap: soap,
    source: source
  };
};

routes['GET /api/visits/list'] = async (req, res) => {
  return { visits: visitHistory };
};

routes['GET /auth/cerner/login'] = async (req, res) => {
  if (MOCK_MODE) {
    const mockToken = 'mock_' + uuidv4();
    const mockSessionId = 'mock-session-' + Date.now();
    sessions.set(mockSessionId, {
      access_token: mockToken,
      patient: '12724066',
      expires_at: Date.now() + 3600000,
      mock: true
    });

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!DOCTYPE html><html><head><title>Cerner Connected</title></head>' +
      '<body style="font-family:sans-serif;max-width:600px;margin:50px auto;text-align:center">' +
      '<h1>Connected to Cerner (Mock)</h1><p>Patient ID: <code>12724066</code></p>' +
      '<script>localStorage.setItem("cernerSession","' + mockSessionId + '");' +
      'setTimeout(function(){window.opener&&window.opener.postMessage({type:"cerner-connected",patient:"12724066"},"*");window.close();},1500);</script>' +
      '</body></html>');
    return null;
  }

  const CLIENT_ID = process.env.CERNER_CLIENT_ID || 'c52afd29-60bd-4ddf-800f-b175bd91be59';
  const TENANT_ID = process.env.CERNER_TENANT_ID || 'ec2458f2-1e24-41c8-b71b-0e701af7583d';
  const REDIRECT_URI = process.env.CERNER_REDIRECT_URI || ('http://localhost:' + PORT + '/callback');
  const CERNER_FHIR_BASE = 'https://fhir-ehr.cerner.com/r4/' + TENANT_ID;

  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('base64url');

  sessions.set(state, { codeVerifier: codeVerifier, createdAt: Date.now() });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'launch/patient patient/*.read user/*.read openid profile online_access documentreference.write',
    state: state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    aud: CERNER_FHIR_BASE
  });

  const authUrl = 'https://authorization.cerner.com/tenants/' + TENANT_ID + '/protocols/oauth2/profiles/smart-v1/personas/provider/authorize?' + params.toString();
  res.writeHead(302, { Location: authUrl });
  res.end();
  return null;
};

async function handleCallback(req, res) {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error, error_description: url.searchParams.get('error_description') }));
    return null;
  }

  if (!code || !state) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing code or state' }));
    return null;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!DOCTYPE html><html><head><title>Cerner Connected</title></head>' +
    '<body style="font-family:sans-serif;max-width:600px;margin:50px auto;text-align:center">' +
    '<h1>Connected to Cerner</h1><p>Session established.</p>' +
    '<script>window.opener&&window.opener.postMessage({type:"cerner-connected"},"*");setTimeout(function(){window.close();},2000);</script>' +
    '</body></html>');
  return null;
}

routes['GET /callback'] = async (req, res) => {
  return handleCallback(req, res);
};

routes['GET /auth/cerner/callback'] = async (req, res) => {
  return handleCallback(req, res);
};

routes['GET /api/cerner/status'] = async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const sessionId = url.searchParams.get('session');

  if (!sessionId) return { connected: false };

  const session = sessions.get(sessionId);
  if (!session) return { connected: false, error: 'Session not found' };
  if (session.expires_at < Date.now()) {
    sessions.delete(sessionId);
    return { connected: false, error: 'Session expired' };
  }

  return {
    connected: true,
    patient: session.patient,
    mock: session.mock || false,
    expires_in: Math.floor((session.expires_at - Date.now()) / 1000)
  };
};

routes['GET /api/patient'] = async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const sessionId = url.searchParams.get('session');
  const session = sessionId ? sessions.get(sessionId) : null;

  if (!session) {
    res.writeHead(401);
    return { error: 'Not connected to Cerner', hint: 'Visit /auth/cerner/login first' };
  }

  if (session.mock) {
    return {
      mock: true,
      id: session.patient,
      name: 'Test Patient',
      gender: 'unknown',
      birthDate: '1980-01-01',
      phone: '(555) 123-4567',
      address: '123 Mock St, Test City, TS 12345'
    };
  }

  res.writeHead(501);
  return { error: 'Real FHIR patient fetch requires axios (install dependencies)' };
};

routes['POST /api/writeback'] = async (req, res) => {
  const body = await readJSON(req);
  const soap = body.soap;
  const sessionId = body.sessionId;

  if (!soap) {
    res.writeHead(400);
    return { error: 'Missing SOAP note data' };
  }

  const session = sessionId ? sessions.get(sessionId) : null;
  if (!session) {
    res.writeHead(401);
    return { error: 'Not connected to Cerner', hint: 'Visit /auth/cerner/login first' };
  }

  if (session.mock) {
    return {
      success: true,
      mock: true,
      patient: session.patient,
      message: 'Mock writeback successful. In production, this would POST to Cerner FHIR.'
    };
  }

  res.writeHead(501);
  return { error: 'Real writeback requires axios (install dependencies)' };
};

routes['POST /api/mock/connect'] = async (req, res) => {
  if (!MOCK_MODE) {
    res.writeHead(403);
    return { error: 'Mock mode not enabled' };
  }
  const mockToken = 'mock_' + uuidv4();
  const mockSessionId = 'mock-session-' + Date.now();
  sessions.set(mockSessionId, {
    access_token: mockToken,
    patient: '12724066',
    expires_at: Date.now() + 3600000,
    mock: true
  });
  return {
    connected: true,
    patient: '12724066',
    sessionId: mockSessionId,
    mode: 'mock'
  };
};

const server = http.createServer(async (req, res) => {
  setCORS(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost:' + PORT);
  const routeKey = req.method + ' ' + url.pathname;

  if (routes[routeKey]) {
    try {
      const result = await routes[routeKey](req, res);
      if (result !== null) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      }
    } catch (err) {
      console.error('[' + routeKey + '] Error:', err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
    return;
  }

  serveStatic(url.pathname, res);
});

loadVisitHistory().then(() => {
  server.listen(PORT, () => {
    console.log('Cerner SOAP Scribe running on http://localhost:' + PORT);
    console.log('Mock mode: ' + (MOCK_MODE ? 'ENABLED' : 'disabled'));
    console.log('Cloudflare: ' + (hasCloudflare ? 'configured (' + CF_ACCOUNT_ID.slice(0, 8) + '...)' : 'NOT configured'));
    console.log('D1: ' + (hasD1 ? 'configured' : 'NOT configured'));
    console.log('Upstash: ' + (hasUpstash ? 'configured' : 'NOT configured'));
    if (!hasD1 && !hasUpstash) console.log('WARNING: no backing store configured - visit history will not survive redeploys');
  });
});
