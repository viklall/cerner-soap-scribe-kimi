export default {
  async fetch(request, env) {
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check
    if (request.method === 'GET') {
      return new Response(JSON.stringify({
        status: 'ok',
        model: '@cf/openai/whisper',
        binding: 'AI'
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Transcription endpoint
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    try {
      // Get audio data from request
      const audioBuffer = await request.arrayBuffer();

      if (!audioBuffer || audioBuffer.byteLength === 0) {
        return new Response(JSON.stringify({ error: 'No audio data received' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Convert to base64 for Workers AI
      const base64Audio = btoa(String.fromCharCode(...new Uint8Array(audioBuffer)));

      // Call Workers AI Whisper
      const response = await env.AI.run('@cf/openai/whisper', {
        audio: base64Audio
      });

      return new Response(JSON.stringify({
        transcript: response.text,
        word_count: response.word_count,
        vtt: response.vtt
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
};
