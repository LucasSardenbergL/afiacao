import Anthropic from "npm:@anthropic-ai/sdk@^0.93.0";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

const SYSTEM_PROMPT = `Você estrutura processos produtivos de clientes da Colacor (distribuidora Sayerlack) em etapas técnicas precisas.

Cliente típico: marcenarias, indústrias moveleiras, oficinas automotivas. Aplicam tinta, primer, verniz em superfícies de madeira/MDF/metal.

# Tipos de etapas que você reconhece
- **preparacao**: lavagem, desengorduramento, lixamento inicial, mascaramento
- **aplicacao**: aplicação de primer, tinta, verniz, catalisador
- **secagem**: ar livre, estufa, infravermelho
- **lixamento**: intermediário entre demãos
- **mistura**: catálise, diluição, ajuste de viscosidade
- **inspecao**: controle de qualidade, retrabalho
- **embalagem**: empilhamento, embalagem final

# Identifique também
- **segmento**: 'moveleiro', 'automotivo', 'industrial', 'marcenaria_pequena', 'oficina_pintura'
- **porte**: 'pequeno' (< 50 peças/mês), 'medio' (50-500), 'grande' (>500). Use pistas: número de funcionários, volume mensal de tinta (litros), cabines, equipamentos.
- **tags**: palavras-chave técnicas relevantes (ex: "pu_2k", "cabine_pressurizada", "lixamento_manual", "ar_comprimido")

# Para cada etapa estruture
- ordem (1, 2, 3...)
- nome curto e descritivo
- tipo (do enum acima)
- produtos: liste **EXATAMENTE** os produtos que o vendedor descreveu (preserve as marcas: "nitro Renner", "diluente da Farben", "lixa 320 Norton"). Se não souber a marca, deixe genérico ("nitro").
- parametros: extraia tempo/temperatura/umidade/etc se vendedor mencionou. Se não, deixe campo ausente.
- equipamentos: ["pistola gravity", "cabine simples"]
- observacoes: problemas, gargalos, qualidades que o vendedor relatou

# Regras
- **NÃO invente etapas que o vendedor não descreveu.**
- Se a descrição é vaga, retorne menos etapas mas com **gaps preenchidos** apontando o que precisa de mais informação.
- confidence 0.9+ se descrição rica; 0.6-0.8 se média; <0.6 se vaga.
- SEMPRE use a tool structure_process.`;

const STRUCTURE_TOOL = {
  name: "structure_process",
  description: "Estrutura processo produtivo do cliente em etapas técnicas.",
  input_schema: {
    type: "object",
    properties: {
      etapas: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ordem: { type: "integer" },
            nome: { type: "string" },
            tipo: { type: "string", enum: ["preparacao", "aplicacao", "secagem", "lixamento", "mistura", "inspecao", "embalagem", "outro"] },
            produtos: { type: "array", items: { type: "string" } },
            parametros: {
              type: "object",
              properties: {
                tempo_minutos: { type: ["number", "null"] },
                temperatura_c: { type: ["number", "null"] },
                umidade_pct: { type: ["number", "null"] },
                espessura_um: { type: ["number", "null"] },
                pressao_bar: { type: ["number", "null"] },
                distancia_cm: { type: ["number", "null"] },
              },
            },
            equipamentos: { type: "array", items: { type: "string" } },
            observacoes: { type: "string" },
          },
          required: ["ordem", "nome", "tipo", "produtos", "parametros", "equipamentos", "observacoes"],
        },
      },
      segmento: { type: "string" },
      porte: { type: "string", enum: ["pequeno", "medio", "grande"] },
      tags: { type: "array", items: { type: "string" } },
      ia_confidence: { type: "number", minimum: 0, maximum: 1 },
      ia_gaps: { type: "array", items: { type: "string" } },
    },
    required: ["etapas", "segmento", "porte", "tags", "ia_confidence", "ia_gaps"],
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

  let body;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!body.descricao_livre || typeof body.descricao_livre !== "string") {
    return new Response(JSON.stringify({ error: "descricao_livre required (string)" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 3000,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: [STRUCTURE_TOOL],
      tool_choice: { type: "tool", name: "structure_process" },
      messages: [{
        role: "user",
        content: `Estruture este processo descrito pelo vendedor:\n\n${body.descricao_livre.slice(0, 20000)}\n\nUse a tool structure_process.`,
      }],
    });

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      return new Response(JSON.stringify({ error: "No tool_use in response" }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      structured: toolUse.input,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      },
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[structure-customer-process]", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
