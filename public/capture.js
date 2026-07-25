let mediaRecorder = null;
let audioChunks = [];
let audioBlob = null;
let recordStartTime = null;
let timerInterval = null;
let currentSoap = null;
let currentVisitId = null;

// ── Check Cerner status on load ──
document.addEventListener('DOMContentLoaded', checkCernerStatus);

async function checkCernerStatus() {
  const sessionId = localStorage.getItem('cernerSession');
  if (!sessionId) return;

  try {
    const res = await fetch(`/api/cerner/status?session=${sessionId}`);
    const data = await res.json();
    updateCernerUI(data);
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

// ── Listen for OAuth success message ──
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
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
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

      // Stop all tracks
      stream.getTracks().forEach(t => t.stop());
    };

    mediaRecorder.start(100); // collect every 100ms
    recordStartTime = Date.now();

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

    // Timer
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

  // UI reset
  document.getElementById('mic-icon').classList.remove('hidden');
  document.getElementById('stop-icon').classList.add('hidden');
  document.getElementById('pulse-ring').classList.add('hidden');
  document.getElementById('pulse-ring').classList.remove('pulse-ring');
  document.getElementById('record-status').textContent = 'Recording stopped. Review and upload.';
  document.getElementById('waveform').classList.add('hidden');
}

// ── Upload & Process ──
async function uploadAudio() {
  if (!audioBlob) return;

  const formData = new FormData();
  formData.append('audio', audioBlob, 'visit-recording.webm');

  document.getElementById('loading').classList.remove('hidden');
  document.getElementById('soap-section').classList.add('hidden');

  try {
    const res = await fetch('/api/visits', {
      method: 'POST',
      body: formData
    });

    const data = await res.json();

    if (data.error) {
      throw new Error(data.error);
    }

    currentSoap = data.soap;
    currentVisitId = data.visitId;

    displaySOAP(data.soap, data.awsConfigured, data.hint);

  } catch (err) {
    alert('Processing failed: ' + err.message);
    console.error(err);
  } finally {
    document.getElementById('loading').classList.add('hidden');
  }
}

// ── Display SOAP ──
function displaySOAP(soap, awsConfigured, hint) {
  document.getElementById('soap-section').classList.remove('hidden');
  document.getElementById('soap-subjective').textContent = soap.Subjective || '(empty)';
  document.getElementById('soap-objective').textContent = soap.Objective || '(empty)';
  document.getElementById('soap-assessment').textContent = soap.Assessment || '(empty)';
  document.getElementById('soap-plan').textContent = soap.Plan || '(empty)';
  document.getElementById('soap-transcript').textContent = soap.transcript || '(no transcript)';

  const modeBadge = document.getElementById('soap-mode');
  if (soap.mode === 'aws-healthscribe') {
    modeBadge.textContent = 'AWS HealthScribe';
    modeBadge.className = 'text-xs px-2 py-1 rounded bg-emerald-100 text-emerald-700 font-medium';
  } else {
    modeBadge.textContent = 'Stub Mode';
    modeBadge.className = 'text-xs px-2 py-1 rounded bg-amber-100 text-amber-700 font-medium';
    if (hint) {
      const hintEl = document.createElement('p');
      hintEl.className = 'text-xs text-amber-600 mt-2';
      hintEl.textContent = '💡 ' + hint;
      modeBadge.parentElement.appendChild(hintEl);
    }
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
