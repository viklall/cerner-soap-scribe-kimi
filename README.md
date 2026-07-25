# RMS Healthcare Scribe

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/viklall/cerner-soap-scribe-kimi)

Audio capture → AI transcription → SMART-on-FHIR writeback to Cerner.

## Deploy (2 minutes)

Click the **Deploy to Render** button above. The app deploys automatically with mock mode enabled — no credentials needed to demo.

Your URL will be `https://cerner-soap-scribe.onrender.com` (or whatever you name it).

## Run Locally

```bash
git clone https://github.com/viklall/cerner-soap-scribe-kimi.git
cd cerner-soap-scribe-kimi
npm install
CERNER_MOCK_MODE=true npm start
# Open http://localhost:8080
```

## What It Does

1. **Record audio** in the browser
2. **Live transcript** appears as you speak (Chrome/Edge Web Speech API)
3. **Generate SOAP note** — uses real transcription if configured, otherwise stub
4. **Connect to Cerner** — mock mode works instantly; real OAuth available
5. **Patient demographics** panel
6. **Write back** SOAP as FHIR DocumentReference

## Transcription Options

| Backend | How to Enable | Cost | Speed | Quality |
|---------|--------------|------|-------|---------|
| **Browser Speech** | Nothing — works in Chrome/Edge | Free | Real-time | Good |
| **OpenAI Whisper** | Add `OPENAI_API_KEY` to env | ~$0.006/min | ~5 sec | Excellent |
| **AWS HealthScribe** | Add AWS keys + S3 + IAM role | ~$0.05/min | ~1-2 min | Best (structured SOAP) |
| **Stub** | Default when nothing else configured | Free | Instant | Placeholder |

Pipeline tries: HealthScribe → Whisper → Browser Speech → Stub.

## Add Real Transcription

### OpenAI Whisper (Recommended)

1. Get an API key: [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Add to your environment:
   ```bash
   export OPENAI_API_KEY=sk-your-key
   npm start
   ```
   Or in Render dashboard → Environment → Add `OPENAI_API_KEY`

### AWS HealthScribe (Enterprise)

Requires AWS account, S3 bucket, IAM role with HealthScribe permissions.

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_REGION=us-east-1
export AWS_S3_BUCKET=...
export AWS_ROLE_ARN=...
npm start
```

## Real Cerner OAuth

1. Remove `CERNER_MOCK_MODE=true`
2. Update `CERNER_REDIRECT_URI` to match your exact URL + `/callback`
3. Visit `/auth/cerner/login`
4. Sign in with your CernerCare developer account

Already registered app:
- **Client ID:** `c52afd29-60bd-4ddf-800f-b175bd91be59`
- **Tenant:** `ec2458f2-1e24-41c8-b71b-0e701af7583d`

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default 8080) |
| `OPENAI_API_KEY` | For Whisper | OpenAI API key |
| `AWS_ACCESS_KEY_ID` | For HealthScribe | AWS key |
| `AWS_SECRET_ACCESS_KEY` | For HealthScribe | AWS secret |
| `AWS_REGION` | For HealthScribe | AWS region |
| `AWS_S3_BUCKET` | For HealthScribe | S3 bucket |
| `AWS_ROLE_ARN` | For HealthScribe | IAM role |
| `CERNER_CLIENT_ID` | No | Pre-registered app ID |
| `CERNER_TENANT_ID` | No | Pre-registered tenant |
| `CERNER_REDIRECT_URI` | No | Must match registered URI exactly |
| `CERNER_MOCK_MODE` | No | `true` = skip real OAuth |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Status + backend config |
| POST | `/api/visits` | Upload audio, get SOAP |
| GET | `/auth/cerner/login` | Start OAuth |
| GET | `/callback` | OAuth redirect |
| GET | `/api/cerner/status` | Connection status |
| GET | `/api/patient` | Patient demographics |
| POST | `/api/writeback` | Push SOAP to Cerner |

## Local Development with Real Dependencies

The repo includes a full Express server (`server-full.js` pattern in git history) with all npm packages. The current `server.js` is zero-dependency for easy deployment. To use the full version with real FHIR calls:

```bash
npm install
# Use the full server (requires all deps installed)
```

## License

Apache 2.0
