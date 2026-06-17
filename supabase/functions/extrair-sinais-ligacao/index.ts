import Anthropic from "npm:@anthropic-ai/sdk@^0.93.0";
// ⚠️ usar npm: (igual a kb-extract-specs/claude-spin-analyze/tarefa-extrair-voz/etc.).
// O esm.sh/@supabase/supabase-js falhava em resolver no boot do edge runtime →
// RUNTIME_ERROR sem linha/stack (módulo não carrega). npm: é o que o projeto roda.
import { createClient } from "npm:@supabase/supabase-js@^2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

// Idempotência por CONTEÚDO: (source_transcript_hash + prompt_version). Bump PROMPT_VERSION
// quando o SYSTEM_PROMPT/TOOL mudar de forma que invalide extrações anteriores → força re-extração.
const PROMPT_VERSION = "v1";
const SCHEMA_VERSION = 1;
const EXTRACTOR_MODEL = "claude-sonnet-4-6"; // alias canônico (sem sufixo de data) — Sonnet 4.6 most recent

const SYSTEM_PROMPT = `Você extrai sinais comerciais de uma transcrição de ligação de vendas (indústria de abrasivos/tintas, pt-BR).
Extraia SOMENTE o que está EXPLÍCITO na fala, com o trecho literal como evidência. Regras:
- Atribua cada sinal ao FALANTE: marque speaker_is_customer=true só se quem disse foi o CLIENTE (não a vendedora).
- Preço: capture valor + moeda + unidade_base (un/caixa/kg/metro). Se a unidade não ficar clara, deixe valor/unidade_base null (NÃO invente).
- Ignore preços/marcas em NEGAÇÃO ("não uso Norton") ou no PASSADO ("ano passado pagava").
- houve_sinal=false se a ligação não teve nenhum sinal comercial. Nunca fabrique.
Chame a tool extrair_sinais.`;

// JSON Schema da tool — força o Claude a devolver o shape exato dos 4 sinais (forced tool-use).
const TOOL = {
  name: "extrair_sinais",
  description: "Sinais comerciais estruturados da ligação.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      precos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tipo: { type: "string", enum: ["cliente_paga", "concorrente_cobra"] },
            produto: { type: ["string", "null"] },
            valor: { type: ["number", "null"] },
            moeda: { type: ["string", "null"] },
            unidade_base: { type: ["string", "null"] },
            concorrente: { type: ["string", "null"] },
            speaker_is_customer: { type: "boolean" },
            confianca: { type: "number" },
            evidencia: { type: "string" },
          },
          required: ["tipo", "speaker_is_customer", "confianca", "evidencia"],
        },
      },
      marcas_em_uso: {
        type: "array",
        items: {
          type: "object",
          properties: {
            marca: { type: "string" },
            produto: { type: ["string", "null"] },
            e_concorrente: { type: ["boolean", "null"] },
            speaker_is_customer: { type: "boolean" },
            confianca: { type: "number" },
            evidencia: { type: "string" },
          },
          required: ["marca", "speaker_is_customer", "confianca", "evidencia"],
        },
      },
      produtos_gap: {
        type: "array",
        items: {
          type: "object",
          properties: {
            descricao: { type: "string" },
            familia: { type: ["string", "null"] },
            material: { type: ["string", "null"] },
            dimensao: { type: ["string", "null"] },
            recorrente: { type: ["boolean", "null"] },
            confianca: { type: "number" },
            evidencia: { type: "string" },
          },
          required: ["descricao", "confianca", "evidencia"],
        },
      },
      demandas_novas: {
        type: "array",
        items: {
          type: "object",
          properties: {
            descricao: { type: "string" },
            contexto: { type: ["string", "null"] },
            urgencia: { type: ["string", "null"] },
            recorrente: { type: ["boolean", "null"] },
            confianca: { type: "number" },
            evidencia: { type: "string" },
          },
          required: ["descricao", "confianca", "evidencia"],
        },
      },
      houve_sinal: { type: "boolean" },
    },
    required: ["precos", "marcas_em_uso", "produtos_gap", "demandas_novas", "houve_sinal"],
  },
};

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY não configurada" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const body = await req.json().catch(() => null);
  const { callId, transcript, customerUserId, farmerId } = body ?? {};
  if (!callId || !transcript) {
    return new Response(JSON.stringify({ error: "callId e transcript obrigatórios" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // transcript vem no BODY (não re-lê do banco) → evita race de replicação do INSERT do front.
  const transcriptText = typeof transcript === "string" ? transcript : JSON.stringify(transcript);
  const hash = await sha256(transcriptText);

  // Idempotência por conteúdo: já extraído com este hash + prompt_version? pula (não chama o LLM).
  const { data: existente } = await admin
    .from("farmer_calls")
    .select("sinais_ligacao")
    .eq("id", callId)
    .maybeSingle();
  const env = existente?.sinais_ligacao as Record<string, unknown> | null;
  if (
    env &&
    env.status === "extraido" &&
    env.source_transcript_hash === hash &&
    env.prompt_version === PROMPT_VERSION
  ) {
    return new Response(JSON.stringify({ skipped: "ja_extraido" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const client = new Anthropic({ apiKey });

    // System prompt num único breakpoint cacheado (ephemeral, TTL 5min) → cache hit nas próximas calls.
    const resp = await client.messages.create({
      model: EXTRACTOR_MODEL,
      max_tokens: 2000,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: [TOOL as unknown as Anthropic.Tool],
      tool_choice: { type: "tool", name: "extrair_sinais" },
      messages: [{ role: "user", content: `Transcrição:\n\n${transcriptText}` }],
    });

    const tu = resp.content.find((b) => b.type === "tool_use");
    if (!tu || tu.type !== "tool_use") throw new Error("sem tool_use na resposta");

    // Envelope com AUDIT metadata (1 writer). status='extraido' (sem acento — casa o literal do trigger
    // trg_farmer_calls_enqueue_recalc_sinais, que só enfileira o recalc quando status='extraido').
    const envelope = {
      schema_version: SCHEMA_VERSION,
      extractor_model: EXTRACTOR_MODEL,
      prompt_version: PROMPT_VERSION,
      source_transcript_hash: hash,
      extracted_at: new Date().toISOString(),
      status: "extraido",
      error: null,
      customer_user_id: customerUserId ?? null,
      farmer_id: farmerId ?? null,
      sinais: tu.input,
    };

    const { error: uErr } = await admin
      .from("farmer_calls")
      .update({ sinais_ligacao: envelope })
      .eq("id", callId);
    if (uErr) throw uErr;

    return new Response(
      JSON.stringify({
        ok: true,
        houve_sinal: (tu.input as { houve_sinal?: boolean }).houve_sinal,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "erro";
    console.error("[extrair-sinais-ligacao]", msg);
    // Erro NÃO-silencioso: grava status='erro' pra a varredura (sinais-batch) reprocessar.
    // status='erro' NÃO enfileira recalc (o trigger exige status='extraido').
    await admin
      .from("farmer_calls")
      .update({
        sinais_ligacao: {
          schema_version: SCHEMA_VERSION,
          extractor_model: EXTRACTOR_MODEL,
          prompt_version: PROMPT_VERSION,
          source_transcript_hash: hash,
          extracted_at: new Date().toISOString(),
          status: "erro",
          error: msg,
        },
      })
      .eq("id", callId);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
