const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

// ── Configuration ──
const AWS_REGION = process.env.AWS_REGION;
const S3_BUCKET = process.env.AWS_S3_BUCKET;
const ACCESS_KEY = process.env.AWS_ACCESS_KEY_ID;
const SECRET_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

const hasAwsCreds = ACCESS_KEY && SECRET_KEY && AWS_REGION && S3_BUCKET;
const hasOpenAI = !!OPENAI_KEY;

if (hasAwsCreds) {
  AWS.config.update({ region: AWS_REGION, accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY });
}

const healthScribe = hasAwsCreds ? new AWS.HealthScribe() : null;
const s3 = hasAwsCreds ? new AWS.S3() : null;

// ── Generate SOAP from transcript ──
function generateSOAP(transcript, visitId, source) {
  const date = new Date().toISOString().split('T')[0];

  if (!transcript || transcript.length < 10) {
    return {
      Subjective: `Patient presents for visit on ${date}. Chief complaint documented.`,
      Objective: `Vital signs and physical exam findings to be documented.`,
      Assessment: `Clinical assessment pending provider review.`,
      Plan: `1. Review visit documentation\n2. Verify findings\n3. Follow up as indicated`,
      transcript: transcript || '[No transcript available]',
      mode: source || 'stub',
      note: `Generated from ${source || 'stub'}. Visit ID: ${visitId}`
    };
  }

  // Simple keyword-based extraction (placeholder for real NLP)
  const lower = transcript.toLowerCase();

  let subjective = '';
  if (lower.includes('pain') || lower.includes('hurt')) subjective += 'Patient reports pain. ';
  if (lower.includes('headache')) subjective += 'Patient reports headache. ';
  if (lower.includes('fever')) subjective += 'Patient reports fever. ';
  if (lower.includes('cough')) subjective += 'Patient reports cough. ';
  if (lower.includes('nausea')) subjective += 'Patient reports nausea. ';
  if (!subjective) subjective = 'Patient presents with concerns as documented in transcript.';

  let objective = 'Physical examination performed. ';
  if (lower.includes('blood pressure') || lower.includes('bp')) objective += 'Vital signs reviewed. ';
  if (lower.includes('heart') || lower.includes('lungs')) objective += 'Cardiopulmonary assessment completed. ';

  let assessment = 'Assessment based on clinical presentation and documented findings.';
  if (lower.includes('viral') || lower.includes('infection')) assessment = 'Likely viral illness. ';
  if (lower.includes('chronic')) assessment = 'Chronic condition management. ';

  let plan = '1. Continue current management\n2. Follow up as needed\n3. Patient education provided';
  if (lower.includes('prescription') || lower.includes('medication')) plan += '\n4. Prescription sent to pharmacy';
  if (lower.includes('referral')) plan += '\n5. Referral placed';
  if (lower.includes('lab') || lower.includes('blood work')) plan += '\n6. Labs ordered';

  return {
    Subjective: subjective.trim(),
    Objective: objective.trim(),
    Assessment: assessment.trim(),
    Plan: plan,
    transcript: transcript,
    mode: source || 'generated',
    note: `Generated from ${source || 'transcript'}. Visit ID: ${visitId}`
  };
}

// ── OpenAI Whisper Transcription ──
async function transcribeWithWhisper(filePath) {
  if (!hasOpenAI) throw new Error('OpenAI API key not configured');

  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));
  form.append('model', 'whisper-1');
  form.append('response_format', 'text');

  const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
    headers: {
      ...form.getHeaders(),
      'Authorization': `Bearer ${OPENAI_KEY}`
    },
    maxBodyLength: Infinity,
    timeout: 120000
  });

  return response.data;
}

// ── Upload to S3 ──
async function uploadToS3(filePath, key) {
  if (!s3) throw new Error('S3 not configured');
  const body = fs.readFileSync(filePath);
  await s3.putObject({ Bucket: S3_BUCKET, Key: key, Body: body, ContentType: 'audio/webm' }).promise();
  return `s3://${S3_BUCKET}/${key}`;
}

// ── Start HealthScribe Job ──
async function startHealthScribeJob(s3Uri, jobName) {
  if (!healthScribe) throw new Error('HealthScribe not configured');
  const params = {
    MedicalScribeJobName: jobName,
    DataAccessRoleArn: process.env.AWS_ROLE_ARN || `arn:aws:iam::000000000000:role/HealthScribeRole`,
    InputDataConfig: { S3Uri: s3Uri },
    OutputDataConfig: { S3Uri: `s3://${S3_BUCKET}/output/` },
    Settings: { ShowSpeakerLabels: true, MaxSpeakerLabels: 2, EnableSegmentation: true }
  };
  const result = await healthScribe.startMedicalScribeJob(params).promise();
  return result.MedicalScribeJob.JobId;
}

// ── Poll Job Status ──
async function pollJobCompletion(jobId, maxAttempts = 60) {
  if (!healthScribe) throw new Error('HealthScribe not configured');
  for (let i = 0; i < maxAttempts; i++) {
    const result = await healthScribe.getMedicalScribeJob({ MedicalScribeJobName: jobId }).promise();
    const status = result.MedicalScribeJob.MedicalScribeJobStatus;
    if (status === 'COMPLETED') return result;
    if (status === 'FAILED') throw new Error(`HealthScribe job failed: ${result.MedicalScribeJob.FailureReason}`);
    console.log(`  Job ${jobId} status: ${status} (attempt ${i + 1}/${maxAttempts})`);
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('HealthScribe job timed out');
}

// ── Fetch Results from S3 ──
async function fetchResults(outputUri) {
  if (!s3) throw new Error('S3 not configured');
  const prefix = outputUri.replace(`s3://${S3_BUCKET}/`, '');
  const list = await s3.listObjectsV2({ Bucket: S3_BUCKET, Prefix: prefix }).promise();
  const summaryKey = list.Contents?.find(c => c.Key.endsWith('summary.json'))?.Key;
  if (!summaryKey) throw new Error('No summary.json found in output');
  const obj = await s3.getObject({ Bucket: S3_BUCKET, Key: summaryKey }).promise();
  return JSON.parse(obj.Body.toString());
}

// ── Main Process ──
async function process(filePath, visitId, browserTranscript = null) {
  const fileName = path.basename(filePath);
  let transcript = browserTranscript;
  let source = 'browser-speech';

  // 1. Try AWS HealthScribe first if configured
  if (hasAwsCreds) {
    try {
      const s3Key = `uploads/${visitId}/${fileName}`;
      const s3Uri = await uploadToS3(filePath, s3Key);
      console.log(`[${visitId}] Uploaded to ${s3Uri}`);

      const jobId = await startHealthScribeJob(s3Uri, `scribe-${visitId}`);
      console.log(`[${visitId}] Started HealthScribe job: ${jobId}`);

      const jobResult = await pollJobCompletion(jobId);
      console.log(`[${visitId}] HealthScribe job completed`);

      const results = await fetchResults(jobResult.MedicalScribeJob.OutputDataConfig.S3Uri);

      transcript = results.Transcript?.ClinicalNote?.Sections?.map(s => s.Summary).join('\n') || '';
      source = 'aws-healthscribe';

      const soap = {
        Subjective: results.ClinicalDocumentation?.Sections?.find(s => s.SectionName === 'SUBJECTIVE')?.Summary || '',
        Objective: results.ClinicalDocumentation?.Sections?.find(s => s.SectionName === 'OBJECTIVE')?.Summary || '',
        Assessment: results.ClinicalDocumentation?.Sections?.find(s => s.SectionName === 'ASSESSMENT')?.Summary || '',
        Plan: results.ClinicalDocumentation?.Sections?.find(s => s.SectionName === 'PLAN')?.Summary || '',
        transcript: transcript,
        mode: 'aws-healthscribe',
        note: `Generated by AWS HealthScribe. Job ID: ${jobId}`
      };

      return { visitId, soap, fileName, awsConfigured: true, jobId, source };
    } catch (err) {
      console.error(`[${visitId}] AWS HealthScribe failed: ${err.message}`);
      console.warn(`[${visitId}] Falling back...`);
    }
  }

  // 2. Try OpenAI Whisper if no AWS or AWS failed
  if (!transcript && hasOpenAI) {
    try {
      console.log(`[${visitId}] Trying OpenAI Whisper...`);
      transcript = await transcribeWithWhisper(filePath);
      source = 'openai-whisper';
      console.log(`[${visitId}] Whisper transcript: ${transcript.length} chars`);
    } catch (err) {
      console.error(`[${visitId}] Whisper failed: ${err.message}`);
    }
  }

  // 3. Generate SOAP from whatever transcript we have
  const soap = generateSOAP(transcript, visitId, source);

  return {
    visitId,
    soap,
    fileName,
    awsConfigured: hasAwsCreds,
    openaiConfigured: hasOpenAI,
    source,
    hint: hasAwsCreds ? null : (hasOpenAI ? null : 'Set OPENAI_API_KEY for Whisper transcription, or AWS credentials for HealthScribe')
  };
}

module.exports = { process };
