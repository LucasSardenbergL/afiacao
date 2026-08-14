import { createClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@^0.93.0";
import {
  extrairToolUseUnico,
  MODELO_PADRAO,
  statusDoErro,
  traduzirErroAnthropic,
} from "../_shared/anthropic.ts";
import {
  normalizarArgumentacao,
  normalizarPerguntas,
  TOOL_ARGUMENTO,
  TOOL_PERGUNTAS,
} from "./argumento-tools.ts";
import { blocoCliente, REGRA_DADO_AUSENTE } from "./argumento-helpers.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

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

    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not configured");
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    const { bundle, customer, customerProfile, mode } = await req.json();

    // ─── MODE: diagnostic_questions ─────────────────────────────
    if (mode === 'diagnostic_questions') {
      const systemPrompt = `Você é um consultor especialista em venda consultiva (SPIN Selling) para o setor de afiação industrial e ferramentas de corte.

Gere perguntas diagnósticas estruturadas para validar hipóteses técnicas antes de ofertar um bundle.

METODOLOGIA SPIN:
- Situação: Confirmar padrão atual com base no histórico de compra
- Problema: Identificar possível fricção técnica relacionada ao bundle
- Implicação: Explorar impacto financeiro ou operacional da fricção
- Direcionamento: Preparar o cliente para considerar o bundle

PERFIL DO CLIENTE: ${customerProfile}
- Se "sensivel_preco": foque perguntas em custos, desperdício, ROI
- Se "orientado_qualidade": foque em acabamento, precisão, conformidade
- Se "orientado_produtividade": foque em tempo de parada, velocidade, eficiência
- Se "misto": balance entre custo e qualidade

REGRAS:
- Máximo 4 perguntas principais (1 por tipo SPIN)
- 1 variação alternativa por perfil para cada pergunta
- Perguntas abertas que estimulem reflexão
- Baseadas em dados reais do cliente
- Linguagem técnica mas acessível

${REGRA_DADO_AUSENTE}

Retorne EXATAMENTE um JSON (sem markdown, sem code blocks):
{
  "questions": [
    {
      "type": "situacao",
      "main": "Pergunta principal de situação",
      "alt": "Variação alternativa adaptada ao perfil",
      "rationale": "Por que esta pergunta é relevante (1 frase)"
    },
    {
      "type": "problema",
      "main": "Pergunta principal de problema",
      "alt": "Variação alternativa",
      "rationale": "Razão da pergunta"
    },
    {
      "type": "implicacao",
      "main": "Pergunta principal de implicação",
      "alt": "Variação alternativa",
      "rationale": "Razão da pergunta"
    },
    {
      "type": "direcionamento",
      "main": "Pergunta principal de direcionamento",
      "alt": "Variação alternativa",
      "rationale": "Razão da pergunta"
    }
  ]
}`;

      const userPrompt = `${blocoCliente(customer)}

Bundle sugerido (${bundle.products.length} produtos):
${bundle.products.map((p: { name: string; price: number }, i: number) => `${i + 1}. ${p.name} - Preço: R$ ${Number(p.price ?? 0).toFixed(2)}`).join('\n')}

Confidence: ${(bundle.confidence * 100).toFixed(1)}%`;

      let resposta;
      try {
        resposta = await anthropic.messages.create({
          model: MODELO_PADRAO,
          max_tokens: 2000,
          // Explícito: omitir usaria o default 1 da API. Material comercial pede
          // baixa variabilidade — e o Gemini anterior não tinha o mesmo default.
          temperature: 0.4,
          system: systemPrompt,
          tools: [TOOL_PERGUNTAS],
          tool_choice: { type: "tool", name: TOOL_PERGUNTAS.name, disable_parallel_tool_use: true },
          messages: [{ role: "user", content: userPrompt }],
        });
      } catch (e: unknown) {
        const status = statusDoErro(e);
        console.error("[generate-bundle-argument] erro na API (perguntas):", status, e instanceof Error ? e.message : e);
        const mapeado = traduzirErroAnthropic(status);
        return new Response(JSON.stringify({ error: mapeado?.mensagem ?? "Erro ao gerar perguntas" }), {
          status: mapeado?.http ?? 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Truncou = perguntas cortadas no meio. Entregar as que couberam faria a
      // vendedora ir para a visita com um roteiro SPIN incompleto achando que
      // está inteiro.
      if (resposta.stop_reason === "max_tokens") {
        console.error("[generate-bundle-argument] perguntas truncadas");
        return new Response(JSON.stringify({ error: "Geração truncada. Tente novamente." }), {
          status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ANTES: `JSON.parse` do texto e, no catch, `{ questions: [] }` — lista
      // vazia silenciosa que a tela mostrava como "sem perguntas" em vez de
      // "não consegui gerar".
      const extraido = extrairToolUseUnico(resposta.content);
      const perguntas = extraido.ok ? normalizarPerguntas(extraido.input) : [];
      if (perguntas.length === 0) {
        console.error("[generate-bundle-argument] sem perguntas utilizáveis");
        return new Response(JSON.stringify({ error: "A IA não devolveu perguntas utilizáveis. Tente novamente." }), {
          status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ questions: perguntas }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── MODE: argument (default) ───────────────────────────────
    const systemPrompt = `Você é um consultor técnico de afiação industrial e venda de ferramentas de corte.
Gere argumentação consultiva personalizada para venda de bundles de produtos.

REGRAS:
- Use linguagem técnica mas acessível
- Baseie o diagnóstico no histórico real do cliente
- Relacione com o processo produtivo do segmento
- Antecipe objeções comuns
- Seja conciso e direto

PERFIL DO CLIENTE: ${customerProfile}
- Se "sensivel_preco": foque em economia, ROI, redução de custo por peça
- Se "orientado_qualidade": foque em acabamento, precisão, vida útil
- Se "orientado_produtividade": foque em velocidade, uptime, menos paradas
- Se "misto": balance todos os argumentos

${REGRA_DADO_AUSENTE}

REGRA DE NÚMEROS (obrigatória): use APENAS os valores presentes neste prompt (preço e histórico
do cliente). NÃO estime nem invente economia, payback, percentual de redução ou margem — se o
número não está acima, escreva o benefício de forma qualitativa. Antes o contexto trazia a
margem de cada SKU; ela foi removida de propósito (é dado interno de custo), então qualquer
cifra de economia agora seria fabricada.

Retorne EXATAMENTE um JSON com esta estrutura (sem markdown, sem code blocks):
{
  "diagnostico": "Diagnóstico implícito baseado no histórico (1-2 frases)",
  "insight_tecnico": "Insight técnico sobre o processo produtivo (1-2 frases)",
  "beneficio_operacional": "Benefício operacional concreto (1 frase)",
  "beneficio_economico": "Benefício econômico QUALITATIVO, sem cifras inventadas (1 frase)",
  "objecao_antecipada": "Objeção provável e resposta (1-2 frases)",
  "versao_phone": "Script curto para ligação (máximo 4 linhas)",
  "versao_whatsapp": "Mensagem resumida para WhatsApp (2-3 linhas com emoji)",
  "versao_tecnica": "Versão técnica detalhada (parágrafo completo)"
}`;

    const userPrompt = `${blocoCliente(customer)}

Bundle sugerido (${bundle.products.length} produtos):
${bundle.products.map((p: { name: string; price: number }, i: number) => `${i + 1}. ${p.name} - Preço: R$ ${Number(p.price ?? 0).toFixed(2)}`).join('\n')}

Confidence: ${(bundle.confidence * 100).toFixed(1)}%
Lift: ${bundle.lift.toFixed(2)}`;

    let resposta;
    try {
      resposta = await anthropic.messages.create({
        model: MODELO_PADRAO,
        max_tokens: 2000,
        // Explícito: omitir usaria o default 1 da API. Material comercial pede
        // baixa variabilidade — e o Gemini anterior não tinha o mesmo default.
        temperature: 0.4,
        system: systemPrompt,
        tools: [TOOL_ARGUMENTO],
        tool_choice: { type: "tool", name: TOOL_ARGUMENTO.name, disable_parallel_tool_use: true },
        messages: [{ role: "user", content: userPrompt }],
      });
    } catch (e: unknown) {
      const status = statusDoErro(e);
      console.error("[generate-bundle-argument] erro na API (argumento):", status, e instanceof Error ? e.message : e);
      const mapeado = traduzirErroAnthropic(status);
      return new Response(JSON.stringify({ error: mapeado?.mensagem ?? "Erro ao gerar argumentação" }), {
        status: mapeado?.http ?? 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Truncou = argumentação cortada. As versões phone/whatsapp são os últimos
    // campos do schema, então é justamente o texto que vai ao cliente que some.
    if (resposta.stop_reason === "max_tokens") {
      console.error("[generate-bundle-argument] argumentação truncada");
      return new Response(JSON.stringify({ error: "Geração truncada. Tente novamente." }), {
        status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ANTES: no catch do JSON.parse, `versao_whatsapp` virava `content.slice(0,150)`
    // — o texto CRU do modelo (raciocínio, markdown quebrado, JSON pela metade)
    // como mensagem enviada AO CLIENTE — e `beneficio_economico` virava
    // "Economia potencial identificada", uma afirmação econômica fabricada.
    // Com tool-use, ou o schema é satisfeito, ou a edge falha explícito.
    const extraido = extrairToolUseUnico(resposta.content);
    const parsed = extraido.ok ? normalizarArgumentacao(extraido.input) : null;
    if (!parsed) {
      console.error("[generate-bundle-argument] sem argumentação utilizável");
      return new Response(JSON.stringify({ error: "A IA não devolveu uma argumentação utilizável. Tente novamente." }), {
        status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("generate-bundle-argument error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
