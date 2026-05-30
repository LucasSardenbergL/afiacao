import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const D360_BASE = Deno.env.get("D360_BASE_URL")!;
const D360_KEY = Deno.env.get("D360_API_KEY")!;

function is24hWindowOpen(lastInboundAt: string | null, now = new Date()): boolean {
  if (!lastInboundAt) return false;
  const t = new Date(lastInboundAt).getTime();
  return Number.isFinite(t) && now.getTime() - t < 24 * 60 * 60 * 1000;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;
  // Envio de WhatsApp é ação de staff (ou automação service_role). Cron não envia texto livre.
  if (auth.via === "cron") return json({ error: "forbidden", detail: "apenas staff ou service_role" }, 403);

  const { conversationId, text } = await req.json().catch(() => ({}));
  if (!conversationId || !text) return json({ error: "conversationId e text obrigatórios" }, 400);

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: conv, error: cErr } = await supabase.from("whatsapp_conversations")
    .select("phone_e164, last_inbound_at").eq("id", conversationId).single();
  if (cErr || !conv) return json({ error: "conversa não encontrada" }, 404);

  if (!is24hWindowOpen((conv as { last_inbound_at: string | null }).last_inbound_at)) {
    return json({ error: "window_closed", detail: "Janela de 24h fechada — use template (PR2)" }, 409);
  }

  const to = (conv as { phone_e164: string }).phone_e164.replace(/\D/g, "");
  const resp = await fetch(`${D360_BASE}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "D360-API-KEY": D360_KEY },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
  });
  const result = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    console.error("[whatsapp-send] 360dialog erro", resp.status, result);
    return json({ error: "send_failed", status: resp.status, detail: result }, 502);
  }
  const waId = (result as { messages?: Array<{ id?: string }> })?.messages?.[0]?.id ?? null;
  const nowIso = new Date().toISOString();
  // A mensagem JÁ foi enviada ao cliente. Se a persistência falhar, NÃO falhamos o request,
  // mas logamos alto e sinalizamos persisted=false (histórico pode ficar inconsistente).
  const { error: insErr } = await supabase.from("whatsapp_messages").insert({
    conversation_id: conversationId, wa_message_id: waId, direction: "out", type: "text",
    body: text, status: "sent", sender_user_id: auth.via === "staff" ? auth.userId : null, wa_timestamp: nowIso,
  });
  const { error: updErr } = await supabase.from("whatsapp_conversations")
    .update({ last_message_at: nowIso, status: "aguardando_cliente" }).eq("id", conversationId);
  if (insErr || updErr) console.error("[whatsapp-send] persistência falhou (msg já enviada)", insErr, updErr);

  return json({ ok: true, wa_message_id: waId, persisted: !insErr && !updErr });
});
