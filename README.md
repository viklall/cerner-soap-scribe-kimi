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
| **Cloudflare Worker** | Deploy included worker | **Free** (10K Neurons/day) | ~5 sec | Excellent |
| **Cloudflare REST API** | Account ID + API token | **Free** (10K Neurons/day) | ~5 sec | Excellent |
| **OpenAI Whisper** | `OPENAI_API_KEY` | ~$0.006/min | ~5 sec | Excellent |
| **AWS HealthScribe** | AWS keys + S3 + IAM role | ~$0.05/min | ~1-2 min | Best (structured SOAP) |
| **Browser Speech** | Nothing — Chrome/Edge only | Free | Real-time | Good |
| **Stub** | Default fallback | Free | Instant | Placeholder |

Pipeline tries: HealthScribe → Worker → Cloudflare → OpenAI → Browser Speech → Stub.

## Add Real Transcription (Free)

### Option A: Cloudflare Worker (Recommended — No API Token)

The repo includes a ready-to-deploy Cloudflare Worker that handles transcription. No API token needed — it uses Workers AI binding.

**1. Deploy the Worker:**

```bash
cd cloudflare-worker
npm install
npx wrangler deploy
```

You'll get a URL like: `https://whisper-transcriber.YOUR_SUBDOMAIN.workers.dev`

**2. Add the URL to your app:**

In Render dashboard → Environment:
```
TRANSCRIPTION_URL=https://whisper-transcriber.YOUR_SUBDOMAIN.workers.dev
```

Or locally:
```bash
export TRANSCRIPTION_URL=https://whisper-transcriber.YOUR_SUBDOMAIN.workers.dev
export CERNER_MOCK_MODE=true
node server.js
```

**Free tier:** 10,000 Neurons/day = ~20 minutes of audio.

### Option B: Cloudflare REST API (Also Free)

If you don't want to deploy a Worker, use the REST API directly.

1. **Get Account ID:** [dash.cloudflare.com](https://dash.cloudflare.com) → right sidebar
2. **Create API Token:** My Profile → API Tokens → Create Token → Workers AI template
3. **Add to app:**
   ```bash
   export CLOUDFLARE_ACCOUNT_ID=your_account_id
   export CLOUDFLARE_API_TOKEN=your_token
   npm start
   ```

### Option C: OpenAI Whisper (Paid)

```bash
export OPENAI_API_KEY=sk-your-key
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
| `TRANSCRIPTION_URL` | For Worker | Your deployed Worker URL |
| `CLOUDFLARE_ACCOUNT_ID` | For Cloudflare REST | Cloudflare account ID |
| `CLOUDFLARE_API_TOKEN` | For Cloudflare REST | Workers AI API token |
| `OPENAI_API_KEY` | For OpenAI | OpenAI API key |
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

## License

Apache 2.0
