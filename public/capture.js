let mediaRecorder = null;
let audioChunks = [];
let audioBlob = null;
let recordStartTime = null;
let timerInterval = null;
let currentSoap = null;
let currentVisitId = null;
let recognition = null;
let transcriptBuffer = '';
let currentPatient = null;
let currentSource = null;
let currentHint = null;

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
  checkBackendStatus();
  checkCernerStatus();
  initSpeechRecognition();
});

// ── Backend Status ──
async function checkBackendStatus() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    const el = document.getElementById('backend-status');
    const parts = [];
    if (data.workerConfigured) parts.push('Worker');
    if (data.cloudflareConfigured) parts.push('Cloudflare');
    if (data.openaiConfigured) parts.push('OpenAI');
    if (data.awsConfigured) parts.push('AWS');
    if (data.mockMode) parts.push('Mock');
    el.textContent = parts.length ? parts.join(' · ') : 'Browser Speech only';
  } catch (e) {}
}

// ── Web Speech API ──
function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.log('Web Speech API not supported');
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = (event) => {
    let interim = '';
    let final = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        final += transcript + ' ';
      } else {
        interim += transcript;
      }
    }
    if (final) {
      transcriptBuffer += final;
      appendLiveTranscript(final, true);
    }
    if (interim) {
      appendLiveTranscript(interim, false);
    }
  };

  recognition.onerror = (e) => {
    console.error('Speech recognition error:', e.error);
  };
}

function appendLiveTranscript(text, isFinal) {
  const box = document.getElementById('live-transcript-box');
  const el = document.getElementById('live-transcript');
  box.classList.remove('hidden');

  if (isFinal) {
    const span = document.createElement('span');
    span.className = 'transcript-line';
    span.textContent = text + ' ';
    el.appendChild(span);
  } else {
    // Remove previous interim
    const interim = el.querySelector('.interim');
    if (interim) interim.remove();
    const span = document.createElement('span');
    span.className = 'interim text-slate-400';
    span.textContent = text;
    el.appendChild(span);
  }

  el.scrollTop = el.scrollHeight;
}

function clearLiveTranscript() {
  transcriptBuffer = '';
  document.getElementById('live-transcript').innerHTML = '';
  document.getElementById('live-transcript-box').classList.add('hidden');
}

// ── Cerner Status ──
async function checkCernerStatus() {
  const sessionId = localStorage.getItem('cernerSession');
  if (!sessionId) return;

  try {
    const res = await fetch(`/api/cerner/status?session=${sessionId}`);
    const data = await res.json();
    updateCernerUI(data);
    if (data.connected) fetchPatientData(sessionId);
  } catch (e) {
    console.error('Cerner status check failed:', e);
  }
}

function updateCernerUI(data) {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');

  if (data.connected) {
    dot.className = 'w-2 h-2 rounded-full bg-emerald-500';
    text.textContent = `Cerner: ${data.patient}${data.mock ? ' (mock)' : ''}`;
  } else {
    dot.className = 'w-2 h-2 rounded-full bg-slate-400';
    text.textContent = 'Cerner: Not connected';
    document.getElementById('patient-panel').classList.add('hidden');
  }
}

// ── Fetch Patient Demographics ──
async function fetchPatientData(sessionId) {
  try {
    const res = await fetch(`/api/patient?session=${sessionId}`);
    const data = await res.json();

    if (data.error) return;

    currentPatient = data;
    document.getElementById('patient-panel').classList.remove('hidden');
    document.getElementById('pt-name').textContent = data.name || 'Unknown';
    document.getElementById('pt-dob').textContent = data.birthDate ? `DOB: ${data.birthDate}` : '';
    document.getElementById('pt-gender').textContent = (data.gender || '').toUpperCase();
    document.getElementById('pt-phone').textContent = data.phone || '';
    document.getElementById('pt-mrn').textContent = `MRN: ${data.id || 'N/A'}`;
    document.getElementById('pt-address').textContent = data.address || '';

    if (data.mock) {
      document.getElementById('pt-mock-badge').classList.remove('hidden');
    }
  } catch (e) {
    console.error('Patient fetch failed:', e);
  }
}

// ── Connect to Cerner ──
function connectCerner() {
  const width = 600, height = 700;
  const left = (screen.width - width) / 2;
  const top = (screen.height - height) / 2;

  window.open(
    '/auth/cerner/login',
    'cerner-oauth',
    `width=${width},height=${height},left=${left},top=${top}`
  );
}

window.addEventListener('message', (e) => {
  if (e.data?.type === 'cerner-connected') {
    checkCernerStatus();
  }
});

// ── Record / Stop ──
async function toggleRecord() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    stopRecording();
  } else {
    await startRecording();
  }
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    const recorderOptions = { audioBitsPerSecond: 128000 };
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
      recorderOptions.mimeType = 'audio/webm;codecs=opus';
    }
    mediaRecorder = new MediaRecorder(stream, recorderOptions);
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
      const url = URL.createObjectURL(audioBlob);
      const preview = document.getElementById('audio-preview');
      preview.src = url;
      preview.classList.remove('hidden');
      document.getElementById('upload-btn').disabled = false;
      stream.getTracks().forEach(t => t.stop());
    };

    mediaRecorder.start(100);
    recordStartTime = Date.now();

    // Start speech recognition
    if (recognition) {
      try { recognition.start(); } catch(e) {}
    }

    // UI updates
    document.getElementById('mic-icon').classList.add('hidden');
    document.getElementById('stop-icon').classList.remove('hidden');
    document.getElementById('pulse-ring').classList.remove('hidden');
    document.getElementById('pulse-ring').classList.add('pulse-ring');
    document.getElementById('record-status').textContent = 'Recording... tap to stop';
    document.getElementById('waveform').classList.remove('hidden');
    document.getElementById('timer').classList.remove('hidden');
    document.getElementById('audio-preview').classList.add('hidden');
    document.getElementById('upload-btn').disabled = true;
    document.getElementById('review-section').classList.add('hidden');
    document.getElementById('soap-section').classList.add('hidden');
    clearLiveTranscript();

    timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - recordStartTime) / 1000);
      const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const secs = String(elapsed % 60).padStart(2, '0');
      document.getElementById('timer').textContent = `${mins}:${secs}`;
    }, 1000);

  } catch (err) {
    alert('Microphone access denied or not available: ' + err.message);
  }
}

function stopRecording() {
  if (!mediaRecorder) return;
  mediaRecorder.stop();
  clearInterval(timerInterval);

  if (recognition) {
    try { recognition.stop(); } catch(e) {}
  }

  document.getElementById('mic-icon').classList.remove('hidden');
  document.getElementById('stop-icon').classList.add('hidden');
  document.getElementById('pulse-ring').classList.add('hidden');
  document.getElementById('pulse-ring').classList.remove('pulse-ring');
  document.getElementById('record-status').textContent = 'Recording stopped. Review and upload.';
  document.getElementById('waveform').classList.add('hidden');
}

// ── Upload & Transcribe ──
async function uploadAudio() {
  if (!audioBlob) return;

  const formData = new FormData();
  formData.append('audio', audioBlob, 'visit-recording.webm');
  if (transcriptBuffer.trim()) {
    formData.append('transcript', transcriptBuffer.trim());
  }
  if (currentPatient && currentPatient.name) {
    formData.append('patientName', currentPatient.name);
  }

  document.getElementById('loading').classList.remove('hidden');
  document.getElementById('review-section').classList.add('hidden');
  document.getElementById('soap-section').classList.add('hidden');

  try {
    const res = await fetch('/api/visits', {
      method: 'POST',
      body: formData
    });

    const data = await res.json();

    if (data.error) throw new Error(data.error);

    currentVisitId = data.visitId;
    currentSource = data.source;
    currentHint = data.hint;

    document.getElementById('review-transcript').value = data.transcript || '';
    document.getElementById('review-source').textContent = data.source ? 'Source: ' + data.source : '';
    document.getElementById('review-section').classList.remove('hidden');

  } catch (err) {
    alert('Transcription failed: ' + err.message);
    console.error(err);
  } finally {
    document.getElementById('loading').classList.add('hidden');
  }
}

// ── Generate SOAP from (possibly edited) transcript ──
async function generateSoapFromTranscript() {
  const transcript = document.getElementById('review-transcript').value.trim();
  const btn = document.getElementById('generate-soap-btn');

  btn.disabled = true;
  btn.textContent = 'Generating...';
  document.getElementById('soap-section').classList.add('hidden');

  try {
    const res = await fetch('/api/soap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: transcript,
        visitId: currentVisitId,
        patientName: currentPatient && currentPatient.name ? currentPatient.name : '',
        source: currentSource
      })
    });

    const data = await res.json();

    if (data.error) throw new Error(data.error);

    currentSoap = data.soap;
    displaySOAP(data.soap, data.source, currentHint);

  } catch (err) {
    alert('SOAP generation failed: ' + err.message);
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate SOAP Note';
  }
}

// ── Display SOAP ──
function displaySOAP(soap, source, hint) {
  document.getElementById('soap-section').classList.remove('hidden');
  document.getElementById('soap-subjective').textContent = soap.Subjective || '(empty)';
  document.getElementById('soap-objective').textContent = soap.Objective || '(empty)';
  document.getElementById('soap-assessment').textContent = soap.Assessment || '(empty)';
  document.getElementById('soap-plan').textContent = soap.Plan || '(empty)';
  document.getElementById('soap-transcript').textContent = soap.transcript || '(no transcript)';

  const modeBadge = document.getElementById('soap-mode');
  const sourceLabel = document.getElementById('soap-source');

  sourceLabel.textContent = source ? `Source: ${source}` : '';

  if (source === 'aws-healthscribe') {
    modeBadge.textContent = 'AWS HealthScribe';
    modeBadge.className = 'text-xs px-2 py-1 rounded bg-emerald-100 text-emerald-700 font-medium';
  } else if (source === 'openai-whisper') {
    modeBadge.textContent = 'OpenAI Whisper';
    modeBadge.className = 'text-xs px-2 py-1 rounded bg-blue-100 text-blue-700 font-medium';
  } else if (source === 'browser-speech') {
    modeBadge.textContent = 'Browser Speech';
    modeBadge.className = 'text-xs px-2 py-1 rounded bg-indigo-100 text-indigo-700 font-medium';
  } else if (source === 'worker' || source === 'cloudflare-whisper') {
    modeBadge.textContent = 'Cloudflare Whisper';
    modeBadge.className = 'text-xs px-2 py-1 rounded bg-orange-100 text-orange-700 font-medium';
  } else {
    modeBadge.textContent = 'Stub Mode';
    modeBadge.className = 'text-xs px-2 py-1 rounded bg-amber-100 text-amber-700 font-medium';
  }

  if (hint) {
    let hintEl = document.getElementById('soap-hint');
    if (!hintEl) {
      hintEl = document.createElement('p');
      hintEl.id = 'soap-hint';
      hintEl.className = 'text-xs text-amber-600 mt-2';
      modeBadge.parentElement.appendChild(hintEl);
    }
    hintEl.textContent = '💡 ' + hint;
  }
}

// ── Writeback to Cerner ──
async function writebackToCerner() {
  if (!currentSoap) return;

  const sessionId = localStorage.getItem('cernerSession');
  const btn = document.getElementById('writeback-btn');
  const status = document.getElementById('writeback-status');

  btn.disabled = true;
  btn.textContent = 'Writing...';
  status.textContent = '';

  try {
    const res = await fetch('/api/writeback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visitId: currentVisitId,
        soap: currentSoap,
        sessionId: sessionId
      })
    });

    const data = await res.json();

    if (data.success) {
      btn.textContent = '✓ Written to Cerner';
      btn.className = 'px-6 py-2 bg-slate-400 text-white rounded-lg font-medium cursor-default';
      status.textContent = data.mock 
        ? `Mock writeback successful. Patient: ${data.patient}`
        : `DocumentReference created: ${data.documentReferenceId}`;
      status.className = 'text-sm text-emerald-600 mt-2';
    } else {
      throw new Error(data.error || 'Unknown error');
    }

  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Write to Cerner';
    status.textContent = 'Error: ' + err.message;
    status.className = 'text-sm text-red-500 mt-2';
  }
}
