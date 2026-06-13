import Anthropic from "npm:@anthropic-ai/sdk@^0.93.0";
// ⚠️ usar npm: (igual a tarefa-extrair-voz/melhoria-triagem/etc.). O esm.sh/@supabase/supabase-js
// falhava em resolver no boot do edge runtime → RUNTIME_ERROR sem linha/stack (módulo não carrega).
import { createClient } from "npm:@supabase/supabase-js@^2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

const SYSTEM_PROMPT_EXTRACT_SPECS = `Você extrai specs técnicos estruturados de boletins técnicos de tintas industriais para a base de conhecimento da Colacor (distribuidora Sayerlack).

# Regras gerais
- Use APENAS dados explícitos no texto. NÃO invente, NÃO estime.
- Quando o boletim dá um range (ex: "viscosidade 42 ± 3s CF6 a 25°C"), use o valor central (42).
- Para campos que o boletim NÃO menciona, deixe null.
- Liste em \`extraction_gaps\` os campos importantes que estão ausentes.
- \`extraction_confidence\` = 0.9+ se boletim claro, 0.6-0.8 se ambíguo, <0.6 se faltam muitos dados-chave.

# Cálculos derivados permitidos
- \`rendimento_m2_por_litro\` = (densidade_g_cm3 × 1000) / gramatura_g_m2_media. Use gramatura média entre min/max se houver range. Se boletim não tem gramatura nem densidade, deixe null.

# Classificação semântica (vc preenche baseado no texto)
- \`product_line\`: 'wood_pu' | 'wood_nitro' | 'hydropoxi' | 'auto' — Wood PU pra poliuretanos pra madeira (mais comum em boletins moveleiros)
- \`product_category\`: 'primer' | 'verniz' | 'tinta' | 'catalisador' | 'diluente' | 'massa' | 'selador'
- \`diferenciais_chave\`: extrai as 2-5 frases-chave do "Uso Recomendado" e "Características"

# Compliance
- Se boletim menciona "isento de" e lista substâncias/metais, capture nos arrays
- \`certificacoes_aplicaveis\`: capture menções de IKEA, LGA, Proposition 65, JIS, CARB, etc.

SEMPRE use a tool extract_product_specs. NÃO responda em texto fora dela.`;

const EXTRACT_TOOL = {
  name: "extract_product_specs",
  description: "Retorna specs estruturados do produto extraídos do boletim técnico.",
  input_schema: {
    type: "object",
    properties: {
      product_code: { type: "string" },
      product_name: { type: "string" },
      supplier: { type: "string" },
      product_line: { type: ["string", "null"], enum: ["wood_pu", "wood_nitro", "hydropoxi", "auto", null] },
      product_category: { type: ["string", "null"] },
      densidade_g_cm3: { type: ["number", "null"] },
      solidos_pct: { type: ["number", "null"] },
      viscosidade_aplicacao_s: { type: ["number", "null"] },
      viscosidade_copo: { type: ["string", "null"] },
      brilho_ub: { type: ["number", "null"] },
      dureza: { type: ["string", "null"] },
      rendimento_m2_por_litro: { type: ["number", "null"] },
      demaos_recomendadas: { type: ["integer", "null"] },
      gramatura_g_m2_min: { type: ["integer", "null"] },
      gramatura_g_m2_max: { type: ["integer", "null"] },
      pot_life_horas: { type: ["number", "null"] },
      temp_aplicacao_c_min: { type: ["number", "null"] },
      temp_aplicacao_c_max: { type: ["number", "null"] },
      umidade_aplicacao_pct_min: { type: ["number", "null"] },
      umidade_aplicacao_pct_max: { type: ["number", "null"] },
      catalisador_codigo: { type: ["string", "null"] },
      catalisador_proporcao_pct: { type: ["number", "null"] },
      diluente_codigo: { type: ["string", "null"] },
      equipamentos_aplicacao: { type: "array", items: { type: "string" } },
      lixa_recomendada: { type: ["string", "null"] },
      substrato: { type: "array", items: { type: "string" } },
      secagem_manuseio_h: { type: ["number", "null"] },
      secagem_empilhamento_h: { type: ["number", "null"] },
      secagem_total_h: { type: ["number", "null"] },
      validade_dias: { type: ["integer", "null"] },
      temp_armazenamento_c_min: { type: ["integer", "null"] },
      temp_armazenamento_c_max: { type: ["integer", "null"] },
      certificacoes_aplicaveis: { type: "array", items: { type: "string" } },
      isento_metais_pesados: { type: "array", items: { type: "string" } },
      isento_substancias: { type: "array", items: { type: "string" } },
      diferenciais_chave: { type: "array", items: { type: "string" } },
      uso_recomendado: { type: ["string", "null"] },
      publico_alvo: { type: ["string", "null"] },
      extraction_confidence: { type: "number", minimum: 0, maximum: 1 },
      extraction_gaps: { type: "array", items: { type: "string" } },
    },
    required: [
      "product_code",
      "product_name",
      "supplier",
      "extraction_confidence",
      "extraction_gaps",
      "equipamentos_aplicacao",
      "substrato",
      "certificacoes_aplicaveis",
      "isento_metais_pesados",
      "isento_substancias",
      "diferenciais_chave",
    ],
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!body.documentId) {
    return new Response(JSON.stringify({ error: "documentId required" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { data: doc, error } = await supabase
      .from("kb_documents")
      .select("id, title, product_code, supplier, content_extracted, status")
      .eq("id", body.documentId)
      .single();

    if (error || !doc) {
      return new Response(JSON.stringify({ error: "Document not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (doc.status !== "ready" || !doc.content_extracted) {
      return new Response(JSON.stringify({ error: "Document not ready or has no extracted content" }), {
        status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const client = new Anthropic({ apiKey });

    const userMsg = `Extraia os specs estruturados deste boletim técnico:

# Metadata
- Título: ${doc.title}
- Código produto (hint): ${doc.product_code ?? "(não informado)"}
- Fornecedor: ${doc.supplier ?? "sayerlack"}

# Texto extraído
${doc.content_extracted.slice(0, 50_000)}

Use a tool extract_product_specs.`;

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      system: [{
        type: "text",
        text: SYSTEM_PROMPT_EXTRACT_SPECS,
        cache_control: { type: "ephemeral" },
      }],
      tools: [EXTRACT_TOOL],
      tool_choice: { type: "tool", name: "extract_product_specs" },
      messages: [{ role: "user", content: userMsg }],
    });

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      return new Response(JSON.stringify({ error: "No tool_use in response", raw: response }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      specs: toolUse.input,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      },
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[kb-extract-specs]", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
