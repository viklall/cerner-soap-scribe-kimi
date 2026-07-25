# RMS Healthcare Scribe

Audio capture → AI transcription (Kimi-Audio / AWS HealthScribe / OpenAI Whisper / Browser Speech) → SMART-on-FHIR writeback to Cerner.

## Quick Start — 3 Options

### Option 1: Mock Mode (zero setup, works immediately)

```bash
git clone https://github.com/viklall/cerner-soap-scribe-kimi.git
cd cerner-soap-scribe-kimi
npm install
CERNER_MOCK_MODE=true npm start
# Open http://localhost:8080
```

Record audio → get stub SOAP → mock Cerner writeback. Full loop, no credentials.

### Option 2: Kimi-Audio Local Transcription (free, private, your hardware)

**Requires:** Python 3.10+, ~14GB disk space, 8GB+ RAM (GPU recommended)

```bash
# Terminal 1: Start Kimi-Audio transcription service
cd transcription-service
pip install -r requirements.txt
python main.py
# Service runs on http://localhost:8000

# Terminal 2: Start the main app
cd ..
KIMI_TRANSCRIPTION_URL=http://localhost:8000 CERNER_MOCK_MODE=true npm start
```

Record audio → Kimi-Audio transcribes locally → real SOAP note → mock Cerner writeback.

**Docker (both services together):**

```bash
docker-compose up --build
# Main app: http://localhost:8080
# Kimi-Audio: http://localhost:8000
```

### Option 3: Full Production (AWS HealthScribe + Real Cerner)

```bash
# .env
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
AWS_S3_BUCKET=...
AWS_ROLE_ARN=...
CERNER_CLIENT_ID=c52afd29-60bd-4ddf-800f-b175bd91be59
CERNER_TENANT_ID=ec2458f2-1e24-41c8-b71b-0e701af7583d
CERNER_REDIRECT_URI=http://localhost:8080/callback

npm start
```

## Architecture

```
Browser (index.html + capture.js)
  ├─ Web Speech API → real-time live transcript
  └─ MediaRecorder → audio/webm
        ↓ POST /api/visits (audio + transcript)
server.js
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

Pipeline tries them in order: HealthScribe → Kimi-Audio → Whisper → Browser Speech → Stub.

## Kimi-Audio Setup

Kimi-Audio is Moonshot AI's open-source speech model (Apache 2.0). It runs entirely on your hardware — no API keys, no data leaves your machine.

### Manual Setup

```bash
cd transcription-service

# Create virtual environment
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Run the service (downloads ~14GB model on first run)
python main.py
```

**Hardware requirements:**
- **Minimum:** 8GB RAM, CPU only (slow but works)
- **Recommended:** 16GB RAM, NVIDIA GPU with 8GB+ VRAM
- **Optimal:** 24GB RAM, NVIDIA GPU with 16GB+ VRAM

The model caches to `./cache/` after first download.

### Docker Setup

```bash
# Make sure Docker has GPU support (NVIDIA Container Toolkit) for GPU acceleration
docker-compose up --build

# Or run just the transcription service
docker build -t kimi-audio ./transcription-service
docker run -p 8000:8000 -v kimi-cache:/app/cache --gpus all kimi-audio
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `KIMI_PORT` | `8000` | Service port |
| `KIMI_DEVICE` | `auto` | `cuda`, `cpu`, or `auto` |
| `KIMI_MODEL_ID` | `moonshotai/Kimi-Audio-7B-Instruct` | HuggingFace model ID |

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

1. Push repo to GitHub
2. Go to [render.com](https://render.com) → New Web Service → connect repo
3. Set environment variables:
   - `CERNER_MOCK_MODE=true`
   - `KIMI_TRANSCRIPTION_URL` (if running Kimi-Audio separately)
   - `OPENAI_API_KEY` (optional)
4. Update `CERNER_REDIRECT_URI` to your Render URL + `/callback`
5. Deploy

**Note:** Render free tier has limited RAM. Kimi-Audio needs ~14GB for the model. Use OpenAI Whisper or browser speech for Render deployment, or upgrade to a paid plan.

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
