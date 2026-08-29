import { createClient } from "npm:@supabase/supabase-js@2";
import { consumirCota, headersDeCota } from "../_shared/ia-cota.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const MAX_AUDIO_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_AUDIO_TYPES = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/x-m4a'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Authentication
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Não autorizado' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace('Bearer ', '');
    const { data, error: authError } = await supabaseAuth.auth.getClaims(token);
    const claims = data?.claims as Record<string, unknown> | undefined ?? {};
    if (authError || !data?.claims) {
      console.error('Auth error:', authError);
      return new Response(
        JSON.stringify({ error: 'Token inválido' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const ELEVENLABS_API_KEY = Deno.env.get('ELEVENLABS_API_KEY');
    if (!ELEVENLABS_API_KEY) {
      console.error('ELEVENLABS_API_KEY not configured');
      return new Response(
        JSON.stringify({ error: 'Serviço de transcrição não configurado' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const formData = await req.formData();
    const audioFile = formData.get('audio') as File;

    if (!audioFile) {
      return new Response(
        JSON.stringify({ error: 'Arquivo de áudio não fornecido' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate file size
    if (audioFile.size > MAX_AUDIO_SIZE) {
      return new Response(
        JSON.stringify({ error: 'Arquivo muito grande (máximo 10MB)' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate audio type (strip codec suffix like ";codecs=opus")
    const baseType = (audioFile.type || '').split(';')[0].trim();
    if (baseType && !ALLOWED_AUDIO_TYPES.includes(baseType)) {
      return new Response(
        JSON.stringify({ error: 'Formato de áudio não suportado' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // COTA — depois da validação (requisição malformada não queima cota do
    // usuário) e antes da ElevenLabs. O gate acima só exige JWT VÁLIDO, e o
    // cadastro em /auth é aberto: sem isto, qualquer conta recém-criada —
    // inclusive customer com is_approved=false, barrado em toda a UI —
    // esgota o orçamento da ORGANIZAÇÃO repetindo áudios de até 10MB.
    // Mesmo par que identify-tool/copilot-analyze/analyze-services já usam.
    const userId = typeof claims.sub === 'string' ? claims.sub : '';
    if (!userId) {
      return new Response(
        JSON.stringify({ error: 'Token inválido' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseCota = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const cota = await consumirCota(
      supabaseCota,
      userId,
      'elevenlabs-transcribe',
      'transcrições de áudio',
    );
    if (!cota.permitido) {
      return new Response(
        JSON.stringify({ error: cota.mensagem }),
        {
          status: cota.http,
          headers: { ...corsHeaders, ...headersDeCota(cota), 'Content-Type': 'application/json' },
        }
      );
    }

    console.log('Received audio file:', audioFile.name, 'size:', audioFile.size, 'type:', audioFile.type);

    const apiFormData = new FormData();
    apiFormData.append('file', audioFile);
    apiFormData.append('model_id', 'scribe_v2');
    apiFormData.append('language_code', 'por');

    const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
      },
      body: apiFormData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('ElevenLabs API error:', response.status, errorText);
      return new Response(
        JSON.stringify({ error: 'Erro no serviço de transcrição' }),
        { status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const transcription = await response.json();

    return new Response(
      JSON.stringify({
        text: transcription.text || '',
        words: transcription.words || [],
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error in elevenlabs-transcribe:', error);
    return new Response(
      JSON.stringify({ error: 'Erro ao processar transcrição' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
