const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 8080;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const MOCK_MODE = process.env.CERNER_MOCK_MODE === 'true';

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const sessions = new Map();

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

function generateStubSOAP(visitId) {
  const date = new Date().toISOString().split('T')[0];
  return {
    Subjective: 'Patient presents for visit on ' + date + '. Chief complaint documented from audio transcript.',
    Objective: 'Vital signs and physical exam findings extracted from conversation. Audio file ID: ' + visitId + '.',
    Assessment: 'Clinical assessment pending provider review.',
    Plan: '1. Review transcript\n2. Verify findings\n3. Follow up as indicated',
    transcript: '[No transcript available - stub mode]',
    mode: 'stub',
    note: 'This is a STUB SOAP note. Add OPENAI_API_KEY for real transcription. Visit ID: ' + visitId
  };
}

const routes = {};

routes['GET /api/health'] = async (req, res) => {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    mockMode: MOCK_MODE,
    awsConfigured: false,
    cloudflareConfigured: !!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN),
    openaiConfigured: !!process.env.OPENAI_API_KEY
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

  const fileName = visitId + '-' + audioPart.filename;
  const filePath = path.join(UPLOAD_DIR, fileName);
  fs.writeFileSync(filePath, audioPart.data);

  console.log('[' + visitId + '] Received audio: ' + audioPart.filename + ' (' + audioPart.data.length + ' bytes)');

  const transcript = transcriptPart ? transcriptPart.data.toString() : null;
  if (transcript) console.log('[' + visitId + '] Browser transcript: ' + transcript.length + ' chars');

  const soap = generateStubSOAP(visitId);

  return {
    visitId: visitId,
    soap: soap,
    fileName: audioPart.filename,
    awsConfigured: false,
    cloudflareConfigured: !!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN),
    openaiConfigured: !!process.env.OPENAI_API_KEY,
    source: 'stub',
    hint: 'Set OPENAI_API_KEY for Whisper transcription, or AWS credentials for HealthScribe'
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
  console.log('Cloudflare: ' + (process.env.CLOUDFLARE_ACCOUNT_ID ? 'configured' : 'not configured'));
  console.log('OpenAI: ' + (process.env.OPENAI_API_KEY ? 'configured' : 'not configured'));
});
