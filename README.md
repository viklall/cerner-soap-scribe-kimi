# RMS Healthcare Scribe

Audio capture → AI transcription (AWS HealthScribe / OpenAI Whisper / Browser Speech) → SMART-on-FHIR writeback to Cerner.

## Quick Start

```bash
git clone https://github.com/viklall/cerner-soap-scribe-kimi.git
cd cerner-soap-scribe-kimi
npm install

# Mock mode — works immediately, no credentials needed
CERNER_MOCK_MODE=true npm start

# Or with OpenAI Whisper (needs API key)
OPENAI_API_KEY=sk-... CERNER_MOCK_MODE=true npm start

# Full mode — add AWS + Cerner creds to .env
npm start
```

Open http://localhost:8080

## Architecture

```
Browser (index.html + capture.js)
  ├─ Web Speech API → real-time live transcript
  └─ MediaRecorder → audio/webm
        ↓ POST /api/visits (audio + transcript)
server.js
        ↓
pipeline.js
  ├─ AWS HealthScribe (if creds) → structured SOAP
  ├─ OpenAI Whisper API (if key) → transcript → SOAP
  ├─ Browser Speech transcript → SOAP
  └─ None of above → stub SOAP with instructions
cerner_writeback/
  ├─ oauth.js      SMART-on-FHIR PKCE flow
  ├─ patient.js    Fetch Patient demographics from FHIR
  └─ writeback.js  POST DocumentReference to Cerner
```

## Transcription Backends

| Backend | Requires | Quality | Speed |
|---------|----------|---------|-------|
| **AWS HealthScribe** | AWS keys + S3 + IAM role | Best (structured SOAP) | Slow (~1-2 min) |
| **OpenAI Whisper** | `OPENAI_API_KEY` | Excellent | Fast (~5-10 sec) |
| **Browser Speech API** | Chrome/Edge only | Good | Real-time |
| **Stub** | Nothing | Placeholder | Instant |

Pipeline tries them in order: HealthScribe → Whisper → Browser Speech → Stub.

## Cerner OAuth

Already registered app:
- **Client ID**: `c52afd29-60bd-4ddf-800f-b175bd91be59`
- **Tenant**: `ec2458f2-1e24-41c8-b71b-0e701af7583d`
- **Redirect URI**: must match exactly (localhost or deployed URL)

Visit `/auth/cerner/login` to initiate. Requires a real CernerCare developer account.

## Mock Mode

Set `CERNER_MOCK_MODE=true` to:
- Skip real Cerner OAuth (auto-connects with test patient `12724066`)
- Skip real FHIR writeback (returns the DocumentReference payload)
- Still processes transcription normally if backend keys are provided

## Deploy to Render

1. Fork/push this repo to GitHub
2. Go to [render.com](https://render.com) → New Web Service → Connect repo
3. Set environment variables in Render dashboard:
   - `CERNER_MOCK_MODE=true` (to start)
   - `OPENAI_API_KEY` (optional, for Whisper)
   - `AWS_*` keys (optional, for HealthScribe)
4. Update `CERNER_REDIRECT_URI` in Render env vars to match your Render URL + `/callback`
5. Deploy

Or use the `render.yaml` blueprint for one-click deploy.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default 8080) |
| `AWS_ACCESS_KEY_ID` | For HealthScribe | AWS key |
| `AWS_SECRET_ACCESS_KEY` | For HealthScribe | AWS secret |
| `AWS_REGION` | For HealthScribe | AWS region |
| `AWS_S3_BUCKET` | For HealthScribe | S3 bucket |
| `AWS_ROLE_ARN` | For HealthScribe | HealthScribe IAM role |
| `OPENAI_API_KEY` | For Whisper | OpenAI API key |
| `CERNER_CLIENT_ID` | No | Already set to registered app |
| `CERNER_TENANT_ID` | No | Already set to sandbox |
| `CERNER_REDIRECT_URI` | No | Must match registered URI exactly |
| `CERNER_MOCK_MODE` | No | Set `true` to bypass real OAuth |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health + backend status |
| POST | `/api/visits` | Upload audio + transcript, get SOAP |
| GET | `/auth/cerner/login` | Start OAuth flow |
| GET | `/callback` | OAuth redirect (registered URI) |
| GET | `/api/cerner/status` | Check connection status |
| GET | `/api/patient` | Fetch patient demographics |
| POST | `/api/writeback` | Push SOAP to Cerner |
| POST | `/api/mock/connect` | Force mock connection |
