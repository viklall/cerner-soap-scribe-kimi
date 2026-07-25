# RMS Healthcare Scribe

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/viklall/cerner-soap-scribe-kimi)

Audio capture → AI transcription (Kimi-Audio / AWS HealthScribe / OpenAI Whisper / Browser Speech) → SMART-on-FHIR writeback to Cerner.

## Quick Start — 30 Seconds

Click the **Deploy to Render** button above, or run locally:

```bash
git clone https://github.com/viklall/cerner-soap-scribe-kimi.git
cd cerner-soap-scribe-kimi
CERNER_MOCK_MODE=true node server.js
# Open http://localhost:8080
```

No `npm install` needed — the server runs on pure Node.js built-ins.

## What You Get

1. **Record audio** in your browser (Chrome/Edge for best experience)
2. **Live transcript** appears as you speak (Web Speech API)
3. **SOAP note** generated automatically
4. **Connect to Cerner** — mock mode works instantly, real OAuth available
5. **Patient demographics** panel populates
6. **Write back** the SOAP note as a FHIR DocumentReference

## Architecture

```
Browser (index.html + capture.js)
  ├─ Web Speech API → real-time live transcript
  └─ MediaRecorder → audio/webm
        ↓ POST /api/visits (audio + transcript)
server.js (zero-dependency, pure Node.js)
        ↓
pipeline.js (tries in order)
  ├─ AWS HealthScribe (if AWS creds) → structured SOAP
  ├─ Kimi-Audio local (if KIMI_TRANSCRIPTION_URL) → transcript → SOAP
  ├─ OpenAI Whisper API (if OPENAI_API_KEY) → transcript → SOAP
  ├─ Browser Speech transcript → SOAP
  └─ None of above → stub SOAP with instructions
cerner_writeback/
  ├─ oauth.js      SMART-on-FHIR PKCE flow
  ├─ patient.js    Fetch Patient demographics from FHIR
  └─ writeback.js  POST DocumentReference to Cerner
```

## Transcription Backends

| Backend | Requires | Quality | Speed | Cost | Privacy |
|---------|----------|---------|-------|------|---------|
| **AWS HealthScribe** | AWS keys + S3 + IAM role | Best (structured SOAP) | Slow (~1-2 min) | ~$0.05/min | AWS cloud |
| **Kimi-Audio (local)** | Python + ~14GB model | Excellent | Medium (~30-60s CPU, ~5-10s GPU) | Free | 100% local |
| **OpenAI Whisper** | `OPENAI_API_KEY` | Excellent | Fast (~5-10 sec) | ~$0.006/min | OpenAI cloud |
| **Browser Speech** | Chrome/Edge only | Good | Real-time | Free | Browser local |
| **Stub** | Nothing | Placeholder | Instant | Free | N/A |

## Deploy to Render (Permanent URL)

1. Click **Deploy to Render** button at the top of this README
2. Create a Render account (or log in)
3. The service deploys automatically from this repo
4. Set these environment variables in the Render dashboard:
   - `CERNER_MOCK_MODE=true` (start here)
   - `OPENAI_API_KEY` (optional, for Whisper)
   - `AWS_*` keys (optional, for HealthScribe)
5. Update `CERNER_REDIRECT_URI` to match your Render URL + `/callback`
6. Every push to `main` auto-deploys via GitHub Actions

## Kimi-Audio Local Setup (Free, Private)

```bash
cd transcription-service
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python main.py
# Service runs on http://localhost:8000
```

Then start the main app:
```bash
KIMI_TRANSCRIPTION_URL=http://localhost:8000 CERNER_MOCK_MODE=true node server.js
```

**Hardware:** 8GB RAM minimum (CPU), 16GB+ recommended (GPU).

## Docker (Everything Together)

```bash
docker-compose up --build
# Main app: http://localhost:8080
# Kimi-Audio: http://localhost:8000
```

## Real Cerner OAuth

1. Remove `CERNER_MOCK_MODE=true`
2. Update `CERNER_REDIRECT_URI` to your exact URL
3. Visit `/auth/cerner/login`
4. Log in with your CernerCare developer account
5. Patient panel populates with real sandbox data

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default 8080) |
| `KIMI_TRANSCRIPTION_URL` | For Kimi-Audio | Local service URL |
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

## License

Apache 2.0. Kimi-Audio model weights are Apache 2.0 licensed by Moonshot AI.
