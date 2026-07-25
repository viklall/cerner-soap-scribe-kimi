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
let visitHistoryCache = [];
let currentConsultLetter = null;
let currentAvs = null;
let currentTranscript = '';
let currentVisitDate = null;

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
  checkBackendStatus();
  checkCernerStatus();
  initSpeechRecognition();
  loadVisitHistory();
});

// ── View switching (dashboard <-> encounter) ──
function showView(view) {
  const isHome = view === 'home';
  document.getElementById('view-home').classList.toggle('hidden', !isHome);
  document.getElementById('view-encounter').classList.toggle('hidden', isHome);
  document.getElementById('breadcrumb').textContent = isHome ? 'Dashboard' : 'Encounter';

  document.getElementById('nav-home').className = isHome
    ? 'flex items-center gap-3 px-3 py-2 rounded-lg bg-indigo-600 font-medium mb-1'
    : 'flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/10 mb-1';
  document.getElementById('nav-encounter').className = isHome
    ? 'flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/10 mb-1'
    : 'flex items-center gap-3 px-3 py-2 rounded-lg bg-indigo-600 font-medium mb-1';

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function startNewEncounter() {
  currentVisitId = null;
  currentSoap = null;
  currentConsultLetter = null;
  currentAvs = null;
  currentTranscript = '';
  audioBlob = null;

  document.getElementById('review-section').classList.add('hidden');
  document.getElementById('soap-section').classList.add('hidden');
  document.getElementById('audio-preview').classList.add('hidden');
  document.getElementById('upload-btn').disabled = true;
  document.getElementById('record-status').textContent = 'Tap to start recording';
  setEncounterMode('record');
  setSoapAudio(null);
  clearLiveTranscript();
  showView('encounter');
}

// ── Document tabs ──
let activeDocTab = 'consult';

function showDocTab(tab) {
  activeDocTab = tab;
  ['consult', 'soap', 'avs', 'transcript'].forEach((t) => {
    document.getElementById('doc-' + t).classList.toggle('hidden', t !== tab);
    document.getElementById('tab-' + t).classList.toggle('active', t === tab);
  });
  document.getElementById('email-btn-label').textContent = DOC_TITLES[tab];
}

// ── Email a generated document ──
function patientLabel() {
  if (currentPatient && currentPatient.name) return currentPatient.name;
  const guessed = extractDisplayName(currentTranscript);
  return guessed || 'patient';
}

const RULE = '='.repeat(56);

// Letterhead prepended to every exported/emailed document so a note pasted
// into an email or chart still identifies who/what/when on its own.
function documentHeader(type) {
  const dateStr = currentVisitDate
    ? new Date(currentVisitDate).toLocaleString([], {
        year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
      })
    : new Date().toLocaleString();

  // A name recovered from the transcript is a speech-recognition guess, not a
  // chart lookup. This document gets emailed out of the app, so an unverified
  // identity is labelled rather than presented as if it came from the record.
  const charted = currentPatient && currentPatient.name;
  const guessed = charted ? '' : extractDisplayName(currentTranscript);
  const patientLine = charted
    ? charted
    : guessed
      ? guessed + '  [name heard in dictation - not verified against chart]'
      : '[not identified - no chart record linked]';

  const lines = [
    'RMS HEALTHCARE',
    DOC_TITLES[type].toUpperCase(),
    RULE,
    'Patient:    ' + patientLine,
    'Date:       ' + dateStr,
    'Clinician:  Ashok Lall, MD, FRCPC'
  ];
  if (currentVisitId) lines.push('Encounter:  ' + currentVisitId);
  lines.push(RULE);
  return lines.join('\n');
}

function documentBody(type) {
  if (type === 'transcript') {
    return currentTranscript || '(no transcript available)';
  }

  if (type === 'soap') {
    if (!currentSoap) return '(no SOAP note available)';
    const s = currentSoap;
    return ['SUBJECTIVE:', s.Subjective, '', 'OBJECTIVE:', s.Objective, '', 'ASSESSMENT:', s.Assessment, '', 'PLAN:', s.Plan]
      .join('\n');
  }

  if (type === 'consult') {
    if (!currentConsultLetter) return '(no consult letter available)';
    const l = currentConsultLetter;
    return CONSULT_SECTIONS
      .filter((sec) => l[sec])
      .map((sec) => sec + ':\n' + l[sec])
      .join('\n\n');
  }

  if (type === 'avs') {
    if (!currentAvs) return '(no after-visit summary available)';
    const a = currentAvs;
    return [a.greeting, '', 'WHAT WE DISCUSSED', a.whatWeDiscussed, '', 'WHAT TO DO NEXT', a.whatToDo].join('\n');
  }

  return '';
}

// Mirrors NOTE_FOOTER in server.js. Used for encounters saved before the
// consult-letter/AVS generators existed, which have no server-supplied footer.
const FALLBACK_FOOTER = 'Thanks once again for involving me in the care of this pleasant patient.\n\n' +
  'With regards,\n' +
  'Transcribed with voice dictation software.\n' +
  'Ashok Lall, MD, FRCPC\n\n' +
  'Informed consent was obtained from this patient for RMS Healthcare AI-assisted ambient charting. ' +
  'Accuracy of the note has been verified by your clinician.\n\n' +
  'This note was prepared using RMS Healthcare AI — a clinical assistant designed to save time, ' +
  'reduce charting burden, and support better care.';

function documentFooter() {
  return (currentConsultLetter && currentConsultLetter.footer) ||
    (currentAvs && currentAvs.footer) ||
    FALLBACK_FOOTER;
}

function formatDocument(type) {
  const parts = [documentHeader(type), '', documentBody(type), '', RULE];
  const footer = documentFooter();
  if (footer) parts.push(footer);
  return parts.join('\n');
}

const DOC_TITLES = {
  consult: 'Consult Letter',
  soap: 'SOAP Note',
  avs: 'After-Visit Summary',
  transcript: 'Encounter Transcript'
};

// Windows caps the whole mailto: URL near 2048 chars and silently does nothing
// past that - a full consult letter encodes to ~3200. So: send the body inline
// when it fits, otherwise put the document on the clipboard and open an empty
// draft for the user to paste into.
const MAILTO_URL_LIMIT = 1900;

// Clinic records address, blind-copied on every document sent from the app.
const ALWAYS_BCC = 'eastwesthelp1@gmail.com';

// Programmatic mailto: navigation is genuinely unreliable - some browsers drop
// location.href for external protocols, some ignore clicks on detached/hidden
// anchors, and Brave/Chrome need a registered handler. So try it, but always
// surface a real anchor the user can click, which always works.
function openMailto(url, message) {
  const fallback = document.getElementById('email-fallback');
  const link = document.getElementById('email-link');
  link.href = url;
  document.getElementById('email-fallback-msg').textContent = message ||
    'If your email program did not open automatically, click below.';
  fallback.classList.remove('hidden');

  try {
    window.location.href = url;
  } catch (e) {
    console.error('mailto navigation failed:', e);
  }
}

// Synchronous copy. navigator.clipboard.writeText is a promise, and continuing
// the mailto: handoff in its .then() lands outside the click's user-activation
// window, which browsers block - so the draft never opened. execCommand is
// deprecated but runs inline, keeping the gesture intact.
function copyToClipboardSync(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  return ok;
}

function emailDocument(type) {
  const subject = DOC_TITLES[type] + ' - ' + patientLabel();
  const body = formatDocument(type);
  const bcc = 'bcc=' + encodeURIComponent(ALWAYS_BCC);
  const fullUrl = 'mailto:?' + bcc + '&subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);

  if (fullUrl.length <= MAILTO_URL_LIMIT) {
    openMailto(fullUrl);
    return;
  }

  // Too long for a mail link, so the note goes via the clipboard instead.
  // Copy synchronously to stay inside the click's user-activation window.
  const copied = copyToClipboardSync(body);
  openMailto(
    'mailto:?' + bcc + '&subject=' + encodeURIComponent(subject),
    copied
      ? 'This ' + DOC_TITLES[type] + ' is too long to fit in a mail link, so the full note was copied to your clipboard — paste it into the draft with Ctrl+V. If your email program did not open, click below.'
      : 'This ' + DOC_TITLES[type] + ' is too long for a mail link and the clipboard was blocked — use the Copy button, then paste into the draft. If your email program did not open, click below.'
  );
}

function copyDocument(type) {
  const text = formatDocument(type);
  navigator.clipboard.writeText(text).then(
    () => {
      const btn = document.getElementById('copy-btn');
      if (!btn) return;
      btn.textContent = '✓ Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    },
    () => alert('Copy failed - your browser blocked clipboard access.')
  );
}

// ── Visit History ──
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// Fallback display label only, when no chart-verified patient name exists -
// never fed back into the clinical note itself (see generateSOAP on the server,
// which intentionally never parses identity out of speech).
function extractDisplayName(transcript) {
  if (!transcript) return '';
  const patterns = [
    /patient'?s?\s+named?\s+(?:is\s+)?/i,
    /\bname is\s+/i,
    /\bnamed\s+/i,
    /\bthis is\s+/i
  ];
  for (const pat of patterns) {
    const m = transcript.match(pat);
    if (!m) continue;
    const after = transcript.slice(m.index + m[0].length);
    const nameMatch = after.match(/^([A-Z][A-Za-z'-]*(?:\s+[A-Z][A-Za-z'-]*)*)/);
    if (nameMatch) return nameMatch[1].trim();
  }
  return '';
}

// The server's visit history file lives on Render's ephemeral disk and is wiped
// on every redeploy. Mirroring it into localStorage means a redeploy doesn't
// lose history from this browser, even though the server-side copy is gone.
const HISTORY_STORAGE_KEY = 'scribeVisitHistory';

function loadLocalHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveLocalHistory(visits) {
  try {
    // Audio is durably stored server-side (D1/Upstash); keeping it out of
    // localStorage avoids blowing past its ~5-10MB per-origin quota.
    const stripped = visits.slice(0, 200).map((v) => {
      const copy = Object.assign({}, v);
      delete copy.audioBase64;
      return copy;
    });
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(stripped));
  } catch (e) {
    console.error('Failed to save local visit history:', e);
  }
}

function setSoapAudio(src) {
  const audioEl = document.getElementById('soap-audio');
  const noAudioMsg = document.getElementById('no-audio-msg');
  const tab = document.getElementById('tab-transcript');
  const playbackAudio = document.getElementById('playback-audio');
  const playbackNone = document.getElementById('playback-none');

  if (src) {
    audioEl.src = src;
    audioEl.classList.remove('hidden');
    noAudioMsg.classList.add('hidden');
    tab.textContent = 'Encounter Transcript 🎧';
    playbackAudio.src = src;
    playbackAudio.classList.remove('hidden');
    playbackNone.classList.add('hidden');
  } else {
    audioEl.removeAttribute('src');
    audioEl.classList.add('hidden');
    noAudioMsg.classList.remove('hidden');
    tab.textContent = 'Encounter Transcript';
    playbackAudio.removeAttribute('src');
    playbackAudio.classList.add('hidden');
    playbackNone.classList.remove('hidden');
  }
}

// A saved encounter is a record to review, not a session to record into - swap
// the mic capture card for a playback card.
function setEncounterMode(mode, meta) {
  const isHistory = mode === 'history';
  document.getElementById('capture-card').classList.toggle('hidden', isHistory);
  document.getElementById('playback-card').classList.toggle('hidden', !isHistory);
  document.getElementById('playback-meta').textContent = isHistory ? (meta || '') : '';
}

function mergeHistories(serverVisits, localVisits) {
  const byId = new Map();
  localVisits.forEach((v) => byId.set(v.visitId, v));
  serverVisits.forEach((v) => byId.set(v.visitId, v));
  return Array.from(byId.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function loadVisitHistory() {
  const localVisits = loadLocalHistory();
  try {
    const res = await fetch('/api/visits/list');
    const data = await res.json();
    visitHistoryCache = mergeHistories(data.visits || [], localVisits);
  } catch (e) {
    console.error('Failed to load visit history from server, using local cache:', e);
    visitHistoryCache = localVisits;
  }
  saveLocalHistory(visitHistoryCache);
  renderEncounterTable();
  updateStats();
}

function displayNameFor(v) {
  if (v.patientName) return escapeHtml(v.patientName);
  const guessed = extractDisplayName(v.transcript);
  return guessed
    ? escapeHtml(guessed) + ' <span class="text-slate-400 font-normal text-xs">(from transcript)</span>'
    : '<span class="text-slate-400">Unknown patient</span>';
}

function chiefComplaintFor(v) {
  // The consult letter's DIAGNOSES line is the most "chief complaint"-shaped
  // thing we generate; fall back to the raw transcript when it isn't there.
  if (v.consultLetter && v.consultLetter.DIAGNOSES) {
    return v.consultLetter.DIAGNOSES.split('\n')
      .map((l) => l.replace(/^\d+\.\s*/, ''))
      .join(', ');
  }
  return v.transcript || '';
}

function updateStats() {
  const count = visitHistoryCache.length;
  document.getElementById('stat-completed').textContent = count;
  // 18 min saved per encounter (matches the "Per Encounter" tile), shown in hours.
  document.getElementById('stat-time-saved').textContent = ((count * 18) / 60).toFixed(1);
}

function renderEncounterTable() {
  const tbody = document.getElementById('encounter-tbody');
  const empty = document.getElementById('encounter-empty');
  const query = (document.getElementById('encounter-search').value || '').toLowerCase();

  const rows = visitHistoryCache.filter((v) => {
    if (!query) return true;
    return ((v.patientName || '') + ' ' + (v.transcript || '') + ' ' + chiefComplaintFor(v))
      .toLowerCase().includes(query);
  });

  tbody.innerHTML = '';
  empty.classList.toggle('hidden', rows.length > 0);

  rows.forEach((v, i) => {
    const tr = document.createElement('tr');
    tr.className = 'border-t border-slate-100 hover:bg-slate-50 cursor-pointer';
    tr.onclick = () => loadHistoryItem(v.visitId);

    const dateStr = v.createdAt
      ? new Date(v.createdAt).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '';
    const num = String(rows.length - i).padStart(3, '0');

    tr.innerHTML =
      '<td class="px-5 py-3 text-indigo-600 font-medium whitespace-nowrap"># ' + num + '</td>' +
      '<td class="px-5 py-3 font-medium text-slate-700">' + displayNameFor(v) + '</td>' +
      '<td class="px-5 py-3 text-slate-600">' + escapeHtml(chiefComplaintFor(v).slice(0, 90)) + '</td>' +
      '<td class="px-5 py-3"><span class="text-xs px-2 py-1 rounded bg-emerald-100 text-emerald-700 font-medium">Completed</span></td>' +
      '<td class="px-5 py-3 text-slate-500 whitespace-nowrap">' + escapeHtml(dateStr) + '</td>';

    tbody.appendChild(tr);
  });
}

function loadHistoryItem(visitId) {
  const v = visitHistoryCache.find((x) => x.visitId === visitId);
  if (!v) return;

  currentVisitId = v.visitId;
  currentSoap = v.soap;
  currentConsultLetter = v.consultLetter || null;
  currentAvs = v.avs || null;
  currentTranscript = v.transcript || '';
  currentVisitDate = v.createdAt || null;
  currentSource = v.source;

  showView('encounter');
  document.getElementById('review-section').classList.add('hidden');

  const metaBits = [];
  if (v.createdAt) metaBits.push(new Date(v.createdAt).toLocaleString());
  if (v.source) metaBits.push(v.source);
  setEncounterMode('history', metaBits.join(' · '));

  displaySOAP(v.soap, v.source, null);
  setSoapAudio(v.audioBase64 ? 'data:' + (v.audioMimeType || 'audio/webm') + ';base64,' + v.audioBase64 : null);
}

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
    setSoapAudio(null);
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
    currentConsultLetter = data.consultLetter || null;
    currentAvs = data.avs || null;
    currentTranscript = transcript;
    currentVisitDate = new Date().toISOString();
    displaySOAP(data.soap, data.source, currentHint);
    setSoapAudio(audioBlob ? URL.createObjectURL(audioBlob) : null);
    loadVisitHistory();

  } catch (err) {
    alert('SOAP generation failed: ' + err.message);
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate SOAP Note';
  }
}

// ── Display SOAP ──
// Section order for the consult letter, matching the clinic's preferred layout.
const CONSULT_SECTIONS = [
  'DIAGNOSES',
  'RECOMMENDATIONS',
  'HISTORY OF PRESENTING ILLNESS',
  'MEDICATIONS',
  'PHYSICAL EXAMINATION',
  'ASSESSMENT'
];

function renderConsultLetter(letter) {
  const el = document.getElementById('doc-consult');
  el.innerHTML = '';
  if (!letter) {
    el.innerHTML = '<p class="text-slate-400 text-sm">No consult letter available for this encounter.</p>';
    return;
  }

  CONSULT_SECTIONS.forEach((section) => {
    if (!letter[section]) return;
    const wrap = document.createElement('div');
    wrap.innerHTML =
      '<h3 class="font-semibold text-slate-700 text-sm tracking-wide">' + escapeHtml(section) + ':</h3>' +
      '<p class="text-slate-600 mt-1 whitespace-pre-wrap">' + escapeHtml(letter[section]) + '</p>';
    el.appendChild(wrap);
  });

  if (letter.footer) {
    const footer = document.createElement('div');
    footer.className = 'pt-4 mt-4 border-t border-slate-100';
    footer.innerHTML = '<p class="text-slate-500 text-sm whitespace-pre-wrap">' + escapeHtml(letter.footer) + '</p>';
    el.appendChild(footer);
  }
}

function renderAVS(avs) {
  const el = document.getElementById('doc-avs');
  el.innerHTML = '';
  if (!avs) {
    el.innerHTML = '<p class="text-slate-400 text-sm">No after-visit summary available for this encounter.</p>';
    return;
  }

  const parts = [
    ['', avs.greeting],
    ['What we discussed', avs.whatWeDiscussed],
    ['What to do next', avs.whatToDo]
  ];

  parts.forEach(([heading, body]) => {
    if (!body) return;
    const wrap = document.createElement('div');
    wrap.innerHTML =
      (heading ? '<h3 class="font-semibold text-slate-700 text-sm uppercase tracking-wide">' + escapeHtml(heading) + '</h3>' : '') +
      '<p class="text-slate-600 mt-1 whitespace-pre-wrap">' + escapeHtml(body) + '</p>';
    el.appendChild(wrap);
  });

  if (avs.footer) {
    const footer = document.createElement('div');
    footer.className = 'pt-4 mt-4 border-t border-slate-100';
    footer.innerHTML = '<p class="text-slate-500 text-sm whitespace-pre-wrap">' + escapeHtml(avs.footer) + '</p>';
    el.appendChild(footer);
  }
}

function displaySOAP(soap, source, hint) {
  document.getElementById('soap-section').classList.remove('hidden');
  document.getElementById('soap-subjective').textContent = soap.Subjective || '(empty)';
  document.getElementById('soap-objective').textContent = soap.Objective || '(empty)';
  document.getElementById('soap-assessment').textContent = soap.Assessment || '(empty)';
  document.getElementById('soap-plan').textContent = soap.Plan || '(empty)';
  document.getElementById('soap-transcript').textContent = soap.transcript || currentTranscript || '(no transcript)';
  document.getElementById('soap-footer').textContent =
    (currentConsultLetter && currentConsultLetter.footer) || (currentAvs && currentAvs.footer) || '';

  renderConsultLetter(currentConsultLetter);
  renderAVS(currentAvs);
  showDocTab('consult');

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
