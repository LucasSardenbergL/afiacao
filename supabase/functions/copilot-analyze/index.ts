import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "*";

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Authenticate user
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { transcript, customerContext, currentPhase, currentIntent, bundleContext } = await req.json();

    if (!transcript || transcript.trim().length < 5) {
      return new Response(
        JSON.stringify({ error: 'Transcrição insuficiente' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) {
      return new Response(
        JSON.stringify({ error: 'AI não configurada' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const systemPrompt = `Você é um copiloto comercial em tempo real para um vendedor (Farmer) de uma empresa de afiação de ferramentas industriais.

Analise a transcrição da conversa e retorne um JSON com:

1. "intent": Uma das opções: "interesse", "objecao_preco", "objecao_tecnica", "falta_urgencia", "comparacao_concorrente", "indiferenca"
2. "phase": Uma das opções: "abertura", "diagnostico", "exploracao", "proposta", "fechamento"
3. "direction": "positivo", "neutro" ou "risco" — baseado no sentimento geral
4. "direction_reasons": Array de strings curtas explicando o sinal
5. "suggestion": Uma ÚNICA sugestão concisa (máx 3 linhas) de próxima ação para o vendedor. Pode ser:
   - Pergunta diagnóstica
   - Resposta técnica
   - Argumento econômico
   - Alternativa de abordagem
6. "suggestion_type": "pergunta_diagnostica", "resposta_tecnica", "argumento_economico", "alternativa_abordagem"
7. "confidence": 0-100 confiança na análise

Contexto do cliente:
${customerContext ? JSON.stringify(customerContext) : 'Não disponível'}

Bundle ativo:
${bundleContext ? JSON.stringify(bundleContext) : 'Nenhum'}

Fase anterior: ${currentPhase || 'desconhecida'}
Intenção anterior: ${currentIntent || 'desconhecida'}

IMPORTANTE: 
- Retorne APENAS o JSON, sem markdown.
- A sugestão deve ser personalizada com base no perfil do cliente.
- Limite a 1 sugestão por vez para não sobrecarregar o vendedor.
- Se o cliente é sensível a preço, foque em ROI e economia.
- Se orientado a qualidade, foque em durabilidade e precisão.
- Se orientado a produtividade, foque em ganho de tempo e eficiência.`;

    const response = await fetch('https://ai.lovable.dev/chat/v1', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Transcrição recente:\n${transcript}` },
        ],
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('AI error:', response.status, errText);
      return new Response(
        JSON.stringify({ error: 'Erro na análise IA' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const aiResult = await response.json();
    const content = aiResult.choices?.[0]?.message?.content || '';

    // Parse JSON from response
    let analysis;
    try {
      const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      analysis = JSON.parse(cleanContent);
    } catch {
      analysis = {
        intent: 'indiferenca',
        phase: currentPhase || 'abertura',
        direction: 'neutro',
        direction_reasons: ['Análise inconclusiva'],
        suggestion: 'Continue explorando as necessidades do cliente.',
        suggestion_type: 'pergunta_diagnostica',
        confidence: 30,
      };
    }

    return new Response(
      JSON.stringify(analysis),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error in copilot-analyze:', error);
    return new Response(
      JSON.stringify({ error: 'Erro ao processar análise' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
