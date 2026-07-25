const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');

// ── Configuration ──
const AWS_REGION = process.env.AWS_REGION;
const S3_BUCKET = process.env.AWS_S3_BUCKET;
const ACCESS_KEY = process.env.AWS_ACCESS_KEY_ID;
const SECRET_KEY = process.env.AWS_SECRET_ACCESS_KEY;

const hasAwsCreds = ACCESS_KEY && SECRET_KEY && AWS_REGION && S3_BUCKET;

if (hasAwsCreds) {
  AWS.config.update({ region: AWS_REGION, accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY });
}

const healthScribe = hasAwsCreds ? new AWS.HealthScribe() : null;
const s3 = hasAwsCreds ? new AWS.S3() : null;

// ── Stub / Fallback SOAP Generator ──
function generateStubSOAP(transcript, visitId) {
  const date = new Date().toISOString().split('T')[0];
  return {
    Subjective: `Patient presents for visit on ${date}. Chief complaint documented from audio transcript.`,
    Objective: `Vital signs and physical exam findings extracted from conversation. Audio file ID: ${visitId}.`,
    Assessment: `Clinical assessment pending provider review. Transcript length: ${transcript?.length || 0} chars.`,
    Plan: `1. Review transcript\n2. Verify findings\n3. Follow up as indicated`,
    transcript: transcript || '[No transcript available - stub mode]',
    mode: 'stub',
    note: `This is a STUB SOAP note. To use real AWS HealthScribe, provide AWS credentials and S3 bucket. Visit ID: ${visitId}`
  };
}

// ── Upload to S3 ──
async function uploadToS3(filePath, key) {
  if (!s3) throw new Error('S3 not configured');
  const body = fs.readFileSync(filePath);
  await s3.putObject({ Bucket: S3_BUCKET, Key: key, Body: body, ContentType: 'audio/wav' }).promise();
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
    Settings: {
      ShowSpeakerLabels: true,
      MaxSpeakerLabels: 2,
      EnableSegmentation: true
    }
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
  // Parse output URI to find the JSON results
  const prefix = outputUri.replace(`s3://${S3_BUCKET}/`, '');
  const list = await s3.listObjectsV2({ Bucket: S3_BUCKET, Prefix: prefix }).promise();

  const summaryKey = list.Contents?.find(c => c.Key.endsWith('summary.json'))?.Key;
  if (!summaryKey) throw new Error('No summary.json found in output');

  const obj = await s3.getObject({ Bucket: S3_BUCKET, Key: summaryKey }).promise();
  return JSON.parse(obj.Body.toString());
}

// ── Main Process ──
async function process(filePath, visitId) {
  const fileName = path.basename(filePath);

  // If no AWS creds, return stub immediately with helpful error
  if (!hasAwsCreds) {
    console.warn(`[${visitId}] AWS credentials missing — returning stub SOAP note.`);
    console.warn(`  Required: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_S3_BUCKET`);
    return {
      visitId,
      soap: generateStubSOAP(null, visitId),
      fileName,
      awsConfigured: false,
      hint: 'Set AWS credentials in .env to enable real HealthScribe transcription'
    };
  }

  try {
    // 1. Upload to S3
    const s3Key = `uploads/${visitId}/${fileName}`;
    const s3Uri = await uploadToS3(filePath, s3Key);
    console.log(`[${visitId}] Uploaded to ${s3Uri}`);

    // 2. Start HealthScribe job
    const jobId = await startHealthScribeJob(s3Uri, `scribe-${visitId}`);
    console.log(`[${visitId}] Started HealthScribe job: ${jobId}`);

    // 3. Poll for completion
    const jobResult = await pollJobCompletion(jobId);
    console.log(`[${visitId}] HealthScribe job completed`);

    // 4. Fetch and parse results
    const results = await fetchResults(jobResult.MedicalScribeJob.OutputDataConfig.S3Uri);

    // 5. Extract SOAP sections
    const soap = {
      Subjective: results.ClinicalDocumentation?.Sections?.find(s => s.SectionName === 'SUBJECTIVE')?.Summary || '',
      Objective: results.ClinicalDocumentation?.Sections?.find(s => s.SectionName === 'OBJECTIVE')?.Summary || '',
      Assessment: results.ClinicalDocumentation?.Sections?.find(s => s.SectionName === 'ASSESSMENT')?.Summary || '',
      Plan: results.ClinicalDocumentation?.Sections?.find(s => s.SectionName === 'PLAN')?.Summary || '',
      transcript: results.Transcript?.ClinicalNote?.Sections?.map(s => s.Summary).join('\n') || '',
      mode: 'aws-healthscribe',
      note: `Generated by AWS HealthScribe. Job ID: ${jobId}`
    };

    return { visitId, soap, fileName, awsConfigured: true, jobId };

  } catch (err) {
    console.error(`[${visitId}] AWS HealthScribe failed: ${err.message}`);
    console.warn(`[${visitId}] Falling back to stub mode.`);
    return {
      visitId,
      soap: generateStubSOAP(null, visitId),
      fileName,
      awsConfigured: true,
      awsError: err.message,
      hint: 'Check AWS credentials, S3 bucket permissions, and HealthScribe IAM role'
    };
  }
}

module.exports = { process };
