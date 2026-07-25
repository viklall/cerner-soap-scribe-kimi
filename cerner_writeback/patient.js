const axios = require('axios');
const { getSession } = require('./oauth');

const CERNER_FHIR_BASE = `https://fhir-ehr.cerner.com/r4/ec2458f2-1e24-41c8-b71b-0e701af7583d`;

// ── GET /api/patient ──
async function getDemographics(req, res) {
  const sid = req.headers['x-cerner-session'] || req.query.session;
  const session = sid ? getSession(sid) : null;

  if (!session) {
    return res.status(401).json({
      error: 'Not connected to Cerner',
      hint: 'Visit /auth/cerner/login first, or enable CERNER_MOCK_MODE=true'
    });
  }

  // Mock mode
  if (session.mock) {
    return res.json({
      mock: true,
      patient: {
        id: session.patient,
        name: [{ use: 'official', text: 'Test Patient', family: 'Patient', given: ['Test'] }],
        gender: 'unknown',
        birthDate: '1980-01-01',
        telecom: [{ system: 'phone', value: '(555) 123-4567' }],
        address: [{ text: '123 Mock St, Test City, TS 12345' }]
      }
    });
  }

  try {
    const response = await axios.get(
      `${CERNER_FHIR_BASE}/Patient/${session.patient}`,
      {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Accept': 'application/fhir+json'
        }
      }
    );

    const p = response.data;
    const name = p.name?.[0];
    const fullName = name ? `${name.given?.join(' ') || ''} ${name.family || ''}`.trim() : 'Unknown';
    const phone = p.telecom?.find(t => t.system === 'phone')?.value || 'N/A';
    const address = p.address?.[0]?.text || `${p.address?.[0]?.line?.join(', ') || ''}, ${p.address?.[0]?.city || ''}, ${p.address?.[0]?.state || ''} ${p.address?.[0]?.postalCode || ''}`;

    res.json({
      id: p.id,
      name: fullName,
      gender: p.gender,
      birthDate: p.birthDate,
      phone,
      address,
      raw: p
    });

  } catch (err) {
    console.error('[Patient] FHIR error:', err.response?.data || err.message);
    res.status(500).json({
      error: 'Failed to fetch patient demographics',
      details: err.response?.data || err.message
    });
  }
}

module.exports = { getDemographics };
