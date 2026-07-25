const crypto = require('crypto');
const axios = require('axios');

// In-memory session store (replace with Redis in production)
const sessions = new Map();

const CLIENT_ID = process.env.CERNER_CLIENT_ID || 'c52afd29-60bd-4ddf-800f-b175bd91be59';
const TENANT_ID = process.env.CERNER_TENANT_ID || 'ec2458f2-1e24-41c8-b71b-0e701af7583d';
const REDIRECT_URI = process.env.CERNER_REDIRECT_URI || 'http://localhost:8080/callback';
const MOCK_MODE = process.env.CERNER_MOCK_MODE === 'true';

const CERNER_AUTH_URL = `https://authorization.cerner.com/tenants/${TENANT_ID}/protocols/oauth2/profiles/smart-v1/personas/provider/authorize`;
const CERNER_TOKEN_URL = `https://authorization.cerner.com/tenants/${TENANT_ID}/protocols/oauth2/profiles/smart-v1/token`;
const CERNER_FHIR_BASE = `https://fhir-ehr.cerner.com/r4/ec2458f2-1e24-41c8-b71b-0e701af7583d`;

// ── PKCE Helpers ──
function base64URLEncode(str) {
  return str.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest();
}

// ── Step 1: Initiate Authorization ──
function authorize(req, res) {
  if (MOCK_MODE) {
    const mockToken = 'mock_' + crypto.randomUUID();
    sessions.set('mock-session', {
      access_token: mockToken,
      patient: '12724066', // Cerner sandbox test patient
      expires_at: Date.now() + 3600000,
      mock: true
    });
    return res.json({
      connected: true,
      patient: '12724066',
      mode: 'mock',
      message: 'Mock mode active. No real Cerner login required.'
    });
  }

  const codeVerifier = base64URLEncode(crypto.randomBytes(32));
  const codeChallenge = base64URLEncode(sha256(codeVerifier));
  const state = base64URLEncode(crypto.randomBytes(16));

  // Store verifier for callback
  sessions.set(state, { codeVerifier, createdAt: Date.now() });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'launch/patient patient/*.read user/*.read openid profile online_access documentreference.write',
    state: state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    aud: CERNER_FHIR_BASE  // SMART v1 requires aud parameter
  });

  const authUrl = `${CERNER_AUTH_URL}?${params.toString()}`;
  console.log(`[OAuth] Redirecting to Cerner: ${authUrl}`);
  res.redirect(authUrl);
}

// ── Step 2: Handle Callback ──
async function callback(req, res) {
  const { code, state, error, error_description } = req.query;

  if (error) {
    console.error(`[OAuth] Cerner error: ${error} - ${error_description}`);
    return res.status(400).json({ error, error_description });
  }

  if (!code || !state) {
    return res.status(400).json({ error: 'Missing code or state parameter' });
  }

  const session = sessions.get(state);
  if (!session) {
    return res.status(400).json({ error: 'Invalid or expired state parameter' });
  }

  try {
    const tokenResponse = await axios.post(
      CERNER_TOKEN_URL,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: session.codeVerifier
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, patient, expires_in } = tokenResponse.data;

    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, {
      access_token,
      patient,
      expires_at: Date.now() + (expires_in * 1000),
      mock: false
    });

    console.log(`[OAuth] Token obtained for patient: ${patient}`);

    // Return success page with JS that stores session and closes/redirects
    res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Cerner Connected</title></head>
      <body style="font-family:sans-serif;max-width:600px;margin:50px auto;text-align:center">
        <h1>✅ Connected to Cerner</h1>
        <p>Patient ID: <code>${patient}</code></p>
        <p>Session: <code>${sessionId}</code></p>
        <script>
          localStorage.setItem('cernerSession', '${sessionId}');
          setTimeout(() => { window.opener?.postMessage({type:'cerner-connected',patient:'${patient}'},'*'); window.close(); }, 2000);
        </script>
        <p><small>You can close this window.</small></p>
      </body>
      </html>
    `);

    // Clean up state
    sessions.delete(state);

  } catch (err) {
    console.error('[OAuth] Token exchange failed:', err.response?.data || err.message);
    res.status(500).json({
      error: 'Token exchange failed',
      details: err.response?.data || err.message
    });
  }
}

// ── Status Check ──
function status(req, res) {
  const sessionId = req.headers['x-cerner-session'] || req.query.session;

  if (!sessionId) {
    return res.json({ connected: false });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.json({ connected: false, error: 'Session not found' });
  }

  if (session.expires_at < Date.now()) {
    sessions.delete(sessionId);
    return res.json({ connected: false, error: 'Session expired' });
  }

  res.json({
    connected: true,
    patient: session.patient,
    mock: session.mock || false,
    expires_in: Math.floor((session.expires_at - Date.now()) / 1000)
  });
}

// ── Get Session (internal) ──
function getSession(sessionId) {
  return sessions.get(sessionId);
}

module.exports = { authorize, callback, status, getSession, sessions };
