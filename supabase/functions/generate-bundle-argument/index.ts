import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
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

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

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

      const userPrompt = `Cliente: ${customer.name}
Segmento/CNAE: ${customer.cnae || 'Não informado'}
Tipo: ${customer.customerType || 'Não informado'}
Health Score: ${customer.healthScore}/100
Dias desde última compra: ${customer.daysSinceLastPurchase || 'N/A'}
Gasto médio mensal: R$ ${customer.avgMonthlySpend || 0}
Categorias compradas: ${customer.categoryCount || 0}

Bundle sugerido (${bundle.products.length} produtos):
${bundle.products.map((p: any, i: number) => `${i + 1}. ${p.name} - Preço: R$ ${p.price.toFixed(2)} | Margem: R$ ${p.margin.toFixed(2)}`).join('\n')}

LIE do Bundle: R$ ${bundle.lieBundle.toFixed(2)}
Confidence: ${(bundle.confidence * 100).toFixed(1)}%

Histórico de compras recentes: ${customer.recentProducts?.join(', ') || 'Sem dados'}`;

      const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });

      if (!response.ok) {
        if (response.status === 429) {
          return new Response(JSON.stringify({ error: "Rate limit exceeded. Tente novamente em alguns segundos." }), {
            status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        if (response.status === 402) {
          return new Response(JSON.stringify({ error: "Créditos insuficientes. Adicione créditos ao workspace." }), {
            status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const t = await response.text();
        console.error("AI gateway error:", response.status, t);
        throw new Error(`AI gateway error: ${response.status}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || "";

      let parsed;
      try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(content);
      } catch {
        console.error("Failed to parse AI response:", content);
        parsed = { questions: [] };
      }

      return new Response(JSON.stringify(parsed), {
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

Retorne EXATAMENTE um JSON com esta estrutura (sem markdown, sem code blocks):
{
  "diagnostico": "Diagnóstico implícito baseado no histórico (1-2 frases)",
  "insight_tecnico": "Insight técnico sobre o processo produtivo (1-2 frases)",
  "beneficio_operacional": "Benefício operacional concreto (1 frase)",
  "beneficio_economico": "Benefício econômico com números quando possível (1 frase)",
  "objecao_antecipada": "Objeção provável e resposta (1-2 frases)",
  "versao_phone": "Script curto para ligação (máximo 4 linhas)",
  "versao_whatsapp": "Mensagem resumida para WhatsApp (2-3 linhas com emoji)",
  "versao_tecnica": "Versão técnica detalhada (parágrafo completo)"
}`;

    const userPrompt = `Cliente: ${customer.name}
Segmento/CNAE: ${customer.cnae || 'Não informado'}
Tipo: ${customer.customerType || 'Não informado'}
Health Score: ${customer.healthScore}/100
Dias desde última compra: ${customer.daysSinceLastPurchase || 'N/A'}
Gasto médio mensal: R$ ${customer.avgMonthlySpend || 0}
Categorias compradas: ${customer.categoryCount || 0}

Bundle sugerido (${bundle.products.length} produtos):
${bundle.products.map((p: any, i: number) => `${i + 1}. ${p.name} - Preço: R$ ${p.price.toFixed(2)} | Margem: R$ ${p.margin.toFixed(2)}`).join('\n')}

LIE do Bundle: R$ ${bundle.lieBundle.toFixed(2)}
Confidence: ${(bundle.confidence * 100).toFixed(1)}%
Lift: ${bundle.lift.toFixed(2)}

Histórico de compras recentes do cliente: ${customer.recentProducts?.join(', ') || 'Sem dados'}`;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded. Tente novamente em alguns segundos." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "Créditos insuficientes. Adicione créditos ao workspace." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const t = await response.text();
      console.error("AI gateway error:", response.status, t);
      throw new Error(`AI gateway error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";

    let parsed;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(content);
    } catch {
      console.error("Failed to parse AI response:", content);
      parsed = {
        diagnostico: "Análise em processamento",
        insight_tecnico: "Consulte dados técnicos",
        beneficio_operacional: "Melhoria operacional esperada",
        beneficio_economico: "Economia potencial identificada",
        objecao_antecipada: "Avalie custo-benefício",
        versao_phone: content.slice(0, 200),
        versao_whatsapp: content.slice(0, 150),
        versao_tecnica: content,
      };
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
