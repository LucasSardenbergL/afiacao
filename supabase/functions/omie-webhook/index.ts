// ============================================================================
// EDGE FUNCTION: omie-webhook
// Endpoint: POST /functions/v1/omie-webhook
// ============================================================================
// Responsabilidades:
//   1. Receber webhooks do Omie (Oben e Colacor)
//   2. Identificar empresa pelo app_key do payload
//   3. Deduplicar eventos (idempotência via messageId)
//   4. Gravar payload bruto em omie_webhook_events
//   5. Retornar 2xx rápido para o Omie não enfileirar retry
//   6. Processar o evento em background
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const OMIE_APPS = {
  OBEN: {
    app_key: Deno.env.get("OMIE_OBEN_APP_KEY"),
    app_secret: Deno.env.get("OMIE_OBEN_APP_SECRET"),
  },
  COLACOR: {
    app_key: Deno.env.get("OMIE_COLACOR_APP_KEY"),
    app_secret: Deno.env.get("OMIE_COLACOR_APP_SECRET"),
  },
} as const;

type Empresa = keyof typeof OMIE_APPS;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface OmieWebhookPayload {
  messageId: string;
  topic: string;
  author: string;
  appHash?: string;
  appKey?: string;
  event: Record<string, unknown>;
  ping?: string;
}

function identificarEmpresa(payload: OmieWebhookPayload): Empresa | null {
  const key = payload.appKey || payload.author;
  if (!key) return null;
  for (const [empresa, creds] of Object.entries(OMIE_APPS)) {
    if (creds.app_key && creds.app_key === key) {
      return empresa as Empresa;
    }
  }
  return null;
}

async function gerarEventId(payload: OmieWebhookPayload): Promise<string> {
  if (payload.messageId) return payload.messageId;
  const encoder = new TextEncoder();
  const data = encoder.encode(JSON.stringify(payload));
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function registrarEvento(
  empresa: Empresa,
  payload: OmieWebhookPayload,
  eventId: string,
): Promise<{ novo: boolean; id: string | null }> {
  const { data: existente } = await supabase
    .from("omie_webhook_events")
    .select("id")
    .eq("empresa", empresa)
    .eq("event_id", eventId)
    .maybeSingle();

  if (existente) {
    console.log(`[dedupe] evento ${eventId} já existe`);
    return { novo: false, id: existente.id };
  }

  const { data: inserido, error } = await supabase
    .from("omie_webhook_events")
    .insert({
      event_id: eventId,
      empresa,
      topic: payload.topic,
      author_id: payload.author,
      message_id: payload.messageId,
      payload: payload as unknown,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[registrar] erro:", error);
    throw error;
  }
  return { novo: true, id: inserido.id };
}

async function marcarProcessado(id: string) {
  await supabase
    .from("omie_webhook_events")
    .update({ processed_at: new Date().toISOString() })
    .eq("id", id);
}

async function marcarErro(id: string, erro: string) {
  await supabase
    .from("omie_webhook_events")
    .update({ processing_error: erro.substring(0, 2000) })
    .eq("id", id);
}

async function processarEvento(
  empresa: Empresa,
  payload: OmieWebhookPayload,
  eventoId: string,
) {
  const topic = payload.topic;
  console.log(`[processar] ${empresa} · ${topic}`);
  try {
    switch (topic) {
      case "PedidoCompra.Incluido":
      case "PedidoCompra.Alterado":
      case "PedidoCompra.Excluido":
        // TODO Fase 1: sync purchase_orders_tracking
        break;
      case "NFe.Recebida":
      case "DocumentoEntrada.Incluido":
        // TODO Fase 1: atualizar T2 (data faturamento)
        break;
      case "CTe.Recebido":
        // TODO Fase 1: atualizar T3 (data CTe)
        break;
      case "Produto.Alterado":
        // TODO Fase 3: disparar recálculo se parâmetros mudaram
        break;
      default:
        console.log(`[processar] ${topic} sem handler — ignorando`);
    }
    await marcarProcessado(eventoId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[processar] erro:`, msg);
    await marcarErro(eventoId, msg);
  }
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  try {
    const payload = (await req.json()) as OmieWebhookPayload;

    if (payload.ping) {
      console.log("[ping] webhook teste recebido");
      return new Response(
        JSON.stringify({ ok: true, message: "pong" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const empresa = identificarEmpresa(payload);
    if (!empresa) {
      console.warn("[auth] app_key desconhecido:", payload.appKey || payload.author);
      return new Response(
        JSON.stringify({ ok: false, reason: "unknown_app_key" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const eventId = await gerarEventId(payload);
    const { novo, id } = await registrarEvento(empresa, payload, eventId);

    if (novo && id) {
      // @ts-ignore EdgeRuntime existe no Supabase Edge Runtime
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
        // @ts-ignore
        EdgeRuntime.waitUntil(processarEvento(empresa, payload, id));
      } else {
        await processarEvento(empresa, payload, id);
      }
    }

    return new Response(
      JSON.stringify({ ok: true, empresa, event_id: eventId, duplicate: !novo }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[handler] erro fatal:", msg);
    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
