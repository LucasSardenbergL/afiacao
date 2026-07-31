import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@^0.93.0";
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import {
  extrairToolUseUnico,
  MODELO_PADRAO,
  statusDoErro,
  traduzirErroAnthropic,
} from "../_shared/anthropic.ts";
import { normalizarAnalise, TOOL_COPILOTO } from "./copiloto-tools.ts";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "*";

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  const __auth = await authorizeCronOrStaff(req);
  if (!__auth.ok) return __auth.response;

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

    const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
    if (!ANTHROPIC_API_KEY) {
      return new Response(
        JSON.stringify({ error: 'AI não configurada' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const systemPrompt = `Você é um copiloto comercial em tempo real para um vendedor (Farmer) de uma empresa de afiação de ferramentas industriais.

Analise a transcrição da conversa e preencha:

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
- Responda SEMPRE usando a função analisar_conversa.
- A sugestão deve ser personalizada com base no perfil do cliente.
- Limite a 1 sugestão por vez para não sobrecarregar o vendedor.
- Se o cliente é sensível a preço, foque em ROI e economia.
- Se orientado a qualidade, foque em durabilidade e precisão.
- Se orientado a produtividade, foque em ganho de tempo e eficiência.`;

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    let resposta;
    try {
      resposta = await anthropic.messages.create({
        model: MODELO_PADRAO,
        max_tokens: 1500,
        // Baixa variabilidade: é leitura de conversa em andamento, não redação.
        temperature: 0.3,
        system: systemPrompt,
        tools: [TOOL_COPILOTO],
        // `type:'tool'` sozinho não desliga chamada paralela — duas leituras da
        // mesma conversa e o consumo pegaria só a primeira.
        tool_choice: { type: 'tool', name: TOOL_COPILOTO.name, disable_parallel_tool_use: true },
        messages: [{ role: 'user', content: `Transcrição recente:\n${transcript}` }],
      });
    } catch (e: unknown) {
      const status = statusDoErro(e);
      console.error('[copilot-analyze] erro na API da Anthropic:', status, e instanceof Error ? e.message : e);
      const mapeado = traduzirErroAnthropic(status);
      return new Response(
        JSON.stringify({ error: mapeado?.mensagem ?? 'Erro na análise IA' }),
        { status: mapeado?.http ?? 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Truncou = leitura cortada no meio. A sugestão pela metade é a que a
    // vendedora leria em voz alta na ligação.
    if (resposta.stop_reason === 'max_tokens') {
      console.error('[copilot-analyze] resposta truncada');
      return new Response(
        JSON.stringify({ error: 'Análise truncada. Tente de novo.' }),
        { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ANTES: o `catch` do JSON.parse fabricava a análise inteira — intenção
    // "indiferenca", direção "neutro" e `confidence: 30` que ninguém mediu,
    // devolvidos com cara de leitura real. Uma conversa em RISCO aparecia como
    // neutra e a vendedora seguia tranquila. Agora não vem análise nenhuma.
    const extraido = extrairToolUseUnico(resposta.content);
    const analise = extraido.ok ? normalizarAnalise(extraido.input) : null;

    if (analise === null) {
      console.error(
        `[copilot-analyze] sem análise utilizável (motivo: ${extraido.ok ? 'campos inválidos' : extraido.motivo})`,
      );
      return new Response(
        JSON.stringify({ error: 'Não consegui ler a conversa agora.' }),
        { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify(analise),
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
