const axios = require('axios');
const { getSession } = require('./oauth');

const CERNER_FHIR_BASE = `https://fhir-ehr.cerner.com/r4/ec2458f2-1e24-41c8-b71b-0e701af7583d`;

// ── POST /api/writeback ──
async function postNote(req, res) {
  const { visitId, soap, sessionId } = req.body;

  if (!soap) {
    return res.status(400).json({ error: 'Missing SOAP note data' });
  }

  const sid = sessionId || req.headers['x-cerner-session'];
  const session = sid ? getSession(sid) : null;

  if (!session) {
    return res.status(401).json({
      error: 'Not connected to Cerner',
      hint: 'Visit /auth/cerner/login first, or enable CERNER_MOCK_MODE=true'
    });
  }

  const documentReference = buildDocumentReference(soap, session.patient);

  // In mock mode, just return the payload without hitting Cerner
  if (session.mock) {
    console.log(`[Writeback] MOCK mode — returning DocumentReference payload`);
    return res.json({
      success: true,
      mock: true,
      patient: session.patient,
      documentReference,
      message: 'Mock writeback successful. In production, this would POST to Cerner FHIR.'
    });
  }

  try {
    const response = await axios.post(
      `${CERNER_FHIR_BASE}/DocumentReference`,
      documentReference,
      {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/fhir+json',
          'Accept': 'application/fhir+json'
        }
      }
    );

    console.log(`[Writeback] DocumentReference created: ${response.data.id}`);
    res.json({
      success: true,
      documentReferenceId: response.data.id,
      patient: session.patient,
      fhirResponse: response.data
    });

  } catch (err) {
    console.error('[Writeback] FHIR error:', err.response?.data || err.message);
    res.status(500).json({
      error: 'FHIR writeback failed',
      details: err.response?.data || err.message
    });
  }
}

// ── Build FHIR DocumentReference ──
function buildDocumentReference(soap, patientId) {
  const now = new Date().toISOString();

  const soapText = [
    '## SUBJECTIVE',
    soap.Subjective || '',
    '',
    '## OBJECTIVE',
    soap.Objective || '',
    '',
    '## ASSESSMENT',
    soap.Assessment || '',
    '',
    '## PLAN',
    soap.Plan || ''
  ].join('\n');

  return {
    resourceType: 'DocumentReference',
    status: 'current',
    type: {
      coding: [{
        system: 'http://loinc.org',
        code: '11506-3',
        display: 'Progress note'
      }],
      text: 'SOAP Note'
    },
    subject: {
      reference: `Patient/${patientId}`
    },
    date: now,
    author: [{
      display: 'RMS Healthcare Scribe'
    }],
    content: [{
      attachment: {
        contentType: 'text/markdown',
        data: Buffer.from(soapText).toString('base64'),
        title: `SOAP Note - ${now.split('T')[0]}`,
        creation: now
      }
    }],
    context: {
      encounter: [{
        display: 'Office Visit'
      }],
      period: {
        start: now,
        end: now
      }
    }
  };
}

module.exports = { postNote, buildDocumentReference };
