import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";

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
  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const { conversationId, text } = await req.json().catch(() => ({}));
  if (!conversationId || !text) return new Response(JSON.stringify({ error: "conversationId e text obrigatórios" }), { status: 400 });

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: conv, error: cErr } = await supabase.from("whatsapp_conversations")
    .select("phone_e164, last_inbound_at").eq("id", conversationId).single();
  if (cErr || !conv) return new Response(JSON.stringify({ error: "conversa não encontrada" }), { status: 404 });

  if (!is24hWindowOpen((conv as { last_inbound_at: string | null }).last_inbound_at)) {
    return new Response(JSON.stringify({ error: "window_closed", detail: "Janela de 24h fechada — use template (PR2)" }), { status: 409 });
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
    return new Response(JSON.stringify({ error: "send_failed", status: resp.status, detail: result }), { status: 502 });
  }
  const waId = (result as { messages?: Array<{ id?: string }> })?.messages?.[0]?.id ?? null;
  const nowIso = new Date().toISOString();
  await supabase.from("whatsapp_messages").insert({
    conversation_id: conversationId, wa_message_id: waId, direction: "out", type: "text",
    body: text, status: "sent", sender_user_id: auth.via === "staff" ? auth.userId : null, wa_timestamp: nowIso,
  });
  await supabase.from("whatsapp_conversations").update({ last_message_at: nowIso, status: "aguardando_cliente" }).eq("id", conversationId);

  return new Response(JSON.stringify({ ok: true, wa_message_id: waId }), { status: 200, headers: { "Content-Type": "application/json" } });
});
