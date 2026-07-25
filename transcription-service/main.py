#!/usr/bin/env python3
"""
Kimi-Audio Transcription Service
Local speech-to-text using Moonshot AI's Kimi-Audio-7B-Instruct
No API keys needed. Runs entirely on your hardware.
"""

import os
import io
import sys
import tempfile
import subprocess
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import torch
import torchaudio
from transformers import AutoModelForCausalLM, AutoTokenizer

# ── Config ──
MODEL_ID = os.getenv("KIMI_MODEL_ID", "moonshotai/Kimi-Audio-7B-Instruct")
DEVICE = os.getenv("KIMI_DEVICE", "auto")  # auto, cuda, cpu
PORT = int(os.getenv("KIMI_PORT", "8000"))

app = FastAPI(title="Kimi-Audio Transcription Service")

# Global model cache
_model = None
_tokenizer = None

def get_device():
    if DEVICE == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    return DEVICE

def load_model():
    global _model, _tokenizer
    if _model is not None:
        return _model, _tokenizer

    print(f"[Kimi-Audio] Loading model {MODEL_ID} on {get_device()}...")
    print("[Kimi-Audio] This may take a few minutes on first run (downloading ~14GB weights)")

    dtype = torch.float16 if get_device() == "cuda" else torch.float32

    _tokenizer = AutoTokenizer.from_pretrained(
        MODEL_ID,
        trust_remote_code=True,
        cache_dir="./cache"
    )

    _model = AutoModelForCausalLM.from_pretrained(
        MODEL_ID,
        torch_dtype=dtype,
        device_map=get_device(),
        trust_remote_code=True,
        cache_dir="./cache"
    )

    print("[Kimi-Audio] Model loaded successfully")
    return _model, _tokenizer

@app.on_event("startup")
async def startup():
    load_model()

# ── Convert audio to 16kHz mono WAV (Kimi-Audio expects this) ──
def preprocess_audio(audio_path: str) -> str:
    output_path = audio_path.replace(Path(audio_path).suffix, "_16k.wav")

    # Use ffmpeg if available, otherwise torchaudio
    try:
        subprocess.run([
            "ffmpeg", "-y", "-i", audio_path,
            "-ar", "16000", "-ac", "1", "-acodec", "pcm_s16le",
            output_path
        ], check=True, capture_output=True)
        return output_path
    except (subprocess.CalledProcessError, FileNotFoundError):
        # Fallback to torchaudio
        waveform, sr = torchaudio.load(audio_path)
        if waveform.shape[0] > 1:
            waveform = waveform.mean(dim=0, keepdim=True)
        if sr != 16000:
            resampler = torchaudio.transforms.Resample(sr, 16000)
            waveform = resampler(waveform)
        torchaudio.save(output_path, waveform, 16000)
        return output_path

# ── Transcription endpoint ──
class TranscriptResponse(BaseModel):
    transcript: str
    model: str
    device: str
    duration_seconds: Optional[float] = None

@app.post("/transcribe", response_model=TranscriptResponse)
async def transcribe(audio: UploadFile = File(...)):
    if not audio.content_type or not audio.content_type.startswith("audio/"):
        raise HTTPException(400, detail="File must be an audio file")

    model, tokenizer = load_model()

    # Save uploaded file
    suffix = Path(audio.filename).suffix or ".webm"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await audio.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        # Preprocess to 16kHz mono WAV
        wav_path = preprocess_audio(tmp_path)

        # Build the prompt for transcription
        # Kimi-Audio-7B-Instruct uses a specific chat template for audio tasks
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "audio", "audio_url": wav_path},
                    {"type": "text", "text": "Transcribe this medical visit audio accurately. Include speaker labels if multiple people are speaking."}
                ]
            }
        ]

        text = tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True
        )

        inputs = tokenizer(text, return_tensors="pt").to(model.device)

        # Generate
        with torch.no_grad():
            outputs = model.generate(
                **inputs,
                max_new_tokens=2048,
                do_sample=False,
                temperature=0.0,
                top_p=1.0,
            )

        # Decode
        response_text = tokenizer.decode(outputs[0][inputs.input_ids.shape[1]:], skip_special_tokens=True)

        # Get audio duration
        info = torchaudio.info(wav_path)
        duration = info.num_frames / info.sample_rate

        return TranscriptResponse(
            transcript=response_text.strip(),
            model=MODEL_ID,
            device=get_device(),
            duration_seconds=round(duration, 2)
        )

    except Exception as e:
        raise HTTPException(500, detail=f"Transcription failed: {str(e)}")
    finally:
        # Cleanup
        for p in [tmp_path, tmp_path.replace(suffix, "_16k.wav")]:
            if os.path.exists(p):
                os.remove(p)

@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": MODEL_ID,
        "device": get_device(),
        "loaded": _model is not None
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
