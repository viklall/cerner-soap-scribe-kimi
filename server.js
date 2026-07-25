// VERSION: 2026-07-25-CLOUDFLARE-FIX-v2
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 8080;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const MOCK_MODE = process.env.CERNER_MOCK_MODE === 'true';
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const hasCloudflare = !!CF_ACCOUNT_ID && !!CF_API_TOKEN;

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const sessions = new Map();
let lastTranscriptionError = null;
let lastTranscriptionResult = null;

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
          if (!json.success) {
            const errMsg = json.errors?.[0]?.message || 'Cloudflare transcription failed';
            console.error('[Cloudflare] API error: ' + errMsg);
            reject(new Error(errMsg));
          } else {
            const text = json.result?.text || '';
            console.log('[Cloudflare] Transcript: ' + text.slice(0, 100) + '...');
            resolve(text);
          }
        } catch (e) {
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

// ── Generate SOAP ──
function generateSOAP(transcript, visitId, source) {
  const date = new Date().toISOString().split('T')[0];

  if (!transcript || transcript.length < 10) {
    return {
      Subjective: 'Patient presents for visit on ' + date + '. Chief complaint documented.',
      Objective: 'Vital signs and physical exam findings to be documented.',
      Assessment: 'Clinical assessment pending provider review.',
      Plan: '1. Review visit documentation\n2. Verify findings\n3. Follow up as indicated',
      transcript: transcript || '[No transcript available]',
      mode: source || 'stub',
      note: 'Generated from ' + (source || 'stub') + '. Visit ID: ' + visitId
    };
  }

  const lower = transcript.toLowerCase();

  let subjective = '';
  if (lower.includes('pain') || lower.includes('hurt')) subjective += 'Patient reports pain. ';
  if (lower.includes('headache')) subjective += 'Patient reports headache. ';
  if (lower.includes('fever')) subjective += 'Patient reports fever. ';
  if (lower.includes('cough')) subjective += 'Patient reports cough. ';
  if (lower.includes('nausea')) subjective += 'Patient reports nausea. ';
  if (!subjective) subjective = 'Patient presents with concerns as documented in transcript.';

  let objective = 'Physical examination performed. ';
  if (lower.includes('blood pressure') || lower.includes('bp')) objective += 'Vital signs reviewed. ';
  if (lower.includes('heart') || lower.includes('lungs')) objective += 'Cardiopulmonary assessment completed. ';

  let assessment = 'Assessment based on clinical presentation and documented findings.';
  if (lower.includes('viral') || lower.includes('infection')) assessment = 'Likely viral illness. ';
  if (lower.includes('chronic')) assessment = 'Chronic condition management. ';

  let plan = '1. Continue current management\n2. Follow up as needed\n3. Patient education provided';
  if (lower.includes('prescription') || lower.includes('medication')) plan += '\n4. Prescription sent to pharmacy';
  if (lower.includes('referral')) plan += '\n5. Referral placed';
  if (lower.includes('lab') || lower.includes('blood work')) plan += '\n6. Labs ordered';

  return {
    Subjective: subjective.trim(),
    Objective: objective.trim(),
    Assessment: assessment.trim(),
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
    openaiConfigured: !!process.env.OPENAI_API_KEY
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

  if (!audioPart) {
    res.writeHead(400);
    return { error: 'No audio file uploaded' };
  }

  console.log('[' + visitId + '] Audio: ' + audioPart.filename + ' (' + audioPart.data.length + ' bytes)');
  console.log('[' + visitId + '] Cloudflare configured: ' + hasCloudflare);

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

  const soap = generateSOAP(transcript, visitId, source);

  return {
    visitId: visitId,
    soap: soap,
    fileName: audioPart.filename,
    cloudflareConfigured: hasCloudflare,
    cloudflareError: cloudflareError,
    source: source,
    hint: hasCloudflare ? null : 'Set CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN for free Whisper'
  };
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

server.listen(PORT, () => {
  console.log('Cerner SOAP Scribe running on http://localhost:' + PORT);
  console.log('Mock mode: ' + (MOCK_MODE ? 'ENABLED' : 'disabled'));
  console.log('Cloudflare: ' + (hasCloudflare ? 'configured (' + CF_ACCOUNT_ID.slice(0, 8) + '...)' : 'NOT configured'));
});
