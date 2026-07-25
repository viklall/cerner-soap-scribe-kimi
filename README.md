# RMS Healthcare Scribe

Audio capture → AWS HealthScribe transcription/SOAP generation → SMART-on-FHIR writeback to Cerner.

## Quick Start

```bash
cd cerner-soap-scribe
npm install

# Option A: Mock mode (no AWS, no Cerner login)
CERNER_MOCK_MODE=true npm start

# Option B: Full mode (requires AWS credentials + Cerner login)
cp .env.example .env
# Edit .env with your AWS keys and Cerner creds
npm start
```

Open http://localhost:8080

## Architecture

```
Browser (index.html + capture.js)
  ↓ POST /api/visits (audio/webm)
server.js
  ↓
pipeline.js
  ├─ Has AWS creds? → Upload S3 → HealthScribe → SOAP
  └─ No creds? → Stub SOAP (explains what's needed)
cerner_writeback/
  ├─ oauth.js      SMART-on-FHIR PKCE flow
  └─ writeback.js  POST DocumentReference to Cerner FHIR
```

## Cerner OAuth

Already registered app:
- **Client ID**: `c52afd29-60bd-4ddf-800f-b175bd91be59`
- **Tenant**: `ec2458f2-1e24-41c8-b71b-0e701af7583d`
- **Redirect URI**: `http://localhost:8080/callback`

Visit `/auth/cerner/login` to initiate. Requires a real CernerCare developer account.

## AWS HealthScribe

Requires:
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION` (e.g., `us-east-1`)
- `AWS_S3_BUCKET`
- `AWS_ROLE_ARN` (IAM role with HealthScribe permissions)

Without these, the pipeline returns a stub SOAP note with instructions.

## Mock Mode

Set `CERNER_MOCK_MODE=true` to:
- Skip real Cerner OAuth (auto-connects with test patient `12724066`)
- Skip real FHIR writeback (returns the DocumentReference payload)
- Still requires AWS creds for real transcription, or uses stub mode

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| POST | `/api/visits` | Upload audio, get SOAP |
| GET | `/auth/cerner/login` | Start OAuth flow |
| GET | `/callback` | OAuth redirect (registered URI) |
| GET | `/auth/cerner/callback` | Alias |
| GET | `/api/cerner/status` | Check connection status |
| POST | `/api/writeback` | Push SOAP to Cerner |
| POST | `/api/mock/connect` | Force mock connection |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default 8080) |
| `AWS_ACCESS_KEY_ID` | For real transcription | AWS key |
| `AWS_SECRET_ACCESS_KEY` | For real transcription | AWS secret |
| `AWS_REGION` | For real transcription | AWS region |
| `AWS_S3_BUCKET` | For real transcription | S3 bucket |
| `AWS_ROLE_ARN` | For real transcription | HealthScribe IAM role |
| `CERNER_CLIENT_ID` | No | Already set to registered app |
| `CERNER_TENANT_ID` | No | Already set to sandbox |
| `CERNER_REDIRECT_URI` | No | Must match registered URI |
| `CERNER_MOCK_MODE` | No | Set `true` to bypass real OAuth |
