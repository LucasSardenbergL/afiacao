import { createClient } from "npm:@supabase/supabase-js@2";

// Espelho do helper puro testado em src/lib/whatsapp/inbound.ts (Deno não importa do src/).
function waPhoneCandidates(input: string | null | undefined): string[] {
  if (!input) return [];
  let d = String(input).replace(/\D/g, "");
  if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
  d = d.replace(/^0+/, "");
  if (d.length < 10) return [];
  const out = new Set<string>([d]);
  const ddd = d.slice(0, 2);
  const rest = d.slice(2);
  if (rest.length === 9 && rest.startsWith("9")) out.add(ddd + rest.slice(1));
  else if (rest.length === 8 && /^[6-9]/.test(rest)) out.add(ddd + "9" + rest);
  return [...out];
}

interface ParsedInbound {
  waMessageId: string; fromPhone: string;
  type: "text" | "audio" | "image" | "template" | "system";
  body: string | null; mediaId: string | null; contactName: string | null; waTimestamp: Date | null;
}
const KNOWN = new Set(["text", "audio", "image"]);
function parseInboundWebhook(payload: unknown): ParsedInbound[] {
  const out: ParsedInbound[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = (change as { value?: Record<string, unknown> })?.value;
      const messages = value?.messages as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(messages)) continue;
      const contacts = value?.contacts as Array<{ profile?: { name?: string } }> | undefined;
      const contactName = contacts?.[0]?.profile?.name ?? null;
      for (const m of messages) {
        const rawType = String(m.type ?? "");
        const type = (KNOWN.has(rawType) ? rawType : "system") as ParsedInbound["type"];
        const ts = m.timestamp ? Number(m.timestamp) : NaN;
        out.push({
          waMessageId: String(m.id ?? ""), fromPhone: String(m.from ?? ""), type,
          body: type === "text" ? String((m.text as { body?: string })?.body ?? "") : null,
          mediaId: (m.audio as { id?: string })?.id ?? (m.image as { id?: string })?.id ?? null,
          contactName, waTimestamp: Number.isFinite(ts) ? new Date(ts * 1000) : null,
        });
      }
    }
  }
  return out.filter((x) => x.waMessageId && x.fromPhone);
}

// Espelho de src/lib/whatsapp/inbound.ts (parseStatusWebhook/isStatusUpgrade) — statuses
// de entrega das mensagens OUT (sent/delivered/read/failed) chegam em value.statuses[].
interface ParsedStatus {
  waMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  erro: string | null;
  waTimestamp: Date | null;
}
const KNOWN_STATUSES = new Set(["sent", "delivered", "read", "failed"]);
function parseStatusWebhook(payload: unknown): ParsedStatus[] {
  const out: ParsedStatus[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = (change as { value?: Record<string, unknown> })?.value;
      const statuses = value?.statuses as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(statuses)) continue;
      for (const s of statuses) {
        const status = String(s.status ?? "");
        if (!KNOWN_STATUSES.has(status)) continue;
        const tsRaw = s.timestamp ? Number(s.timestamp) : NaN;
        const errors = s.errors as Array<{ code?: number; title?: string; message?: string }> | undefined;
        const e0 = errors?.[0];
        out.push({
          waMessageId: String(s.id ?? ""),
          status: status as ParsedStatus["status"],
          erro: e0 ? `${e0.code ?? ""} ${e0.title ?? e0.message ?? ""}`.trim() : null,
          waTimestamp: Number.isFinite(tsRaw) ? new Date(tsRaw * 1000) : null,
        });
      }
    }
  }
  return out.filter((x) => x.waMessageId);
}
// Progressão monotônica: webhooks chegam fora de ordem; nunca regredir status.
const STATUS_RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 9 };
function isStatusUpgrade(current: string | null, next: string): boolean {
  const cur = current ? (STATUS_RANK[current] ?? 0) : -1;
  const nxt = STATUS_RANK[next] ?? -1;
  return nxt > cur;
}

async function processStatus(supabase: ReturnType<typeof createClient>, s: ParsedStatus) {
  const { data: msg } = await supabase.from("whatsapp_messages")
    .select("id, status").eq("wa_message_id", s.waMessageId).maybeSingle();
  const m = msg as { id: string; status: string | null } | null;
  if (m && isStatusUpgrade(m.status, s.status)) {
    await supabase.from("whatsapp_messages").update({ status: s.status }).eq("id", m.id);
  }
  const { data: send } = await supabase.from("whatsapp_template_sends")
    .select("id, status").eq("wa_message_id", s.waMessageId).maybeSingle();
  const sd = send as { id: string; status: string } | null;
  if (sd && isStatusUpgrade(sd.status, s.status)) {
    await supabase.from("whatsapp_template_sends").update({ status: s.status, erro: s.erro }).eq("id", sd.id);
  }
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Espelho de src/lib/whatsapp/stop-keyword.ts + opt-in.ts (Deno não importa do src/).
const STOP_KEYWORDS = new Set(["PARAR", "SAIR", "STOP", "CANCELAR", "DESCADASTRAR"]);
function isStopKeyword(body: string | null | undefined): boolean {
  if (!body) return false;
  const t = body.normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/[^A-Z\s]/g, "").trim();
  return STOP_KEYWORDS.has(t);
}
// "PARAR"→opt_out (LGPD, precede); opt_out é sticky; 1ª resposta (unknown)→opt_in.
function nextOptInStatus(current: string, body: string | null): "unknown" | "opt_in" | "opt_out" {
  if (isStopKeyword(body)) return "opt_out";
  if (current === "opt_out") return "opt_out";
  if (current === "opt_in") return "opt_in";
  return "opt_in";
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function matchCustomer(supabase: ReturnType<typeof createClient>, fromPhone: string): Promise<string | null> {
  const cands = waPhoneCandidates(fromPhone);
  if (cands.length === 0) return null;
  const { data } = await supabase.from("profiles").select("user_id, phone").not("phone", "is", null);
  for (const p of (data ?? []) as Array<{ user_id: string; phone: string }>) {
    const pc = waPhoneCandidates(p.phone);
    if (pc.some((x) => cands.includes(x))) return p.user_id;
  }
  return null;
}

async function processMessage(supabase: ReturnType<typeof createClient>, msg: ParsedInbound) {
  const phoneKey = waPhoneCandidates(msg.fromPhone)[0] ?? msg.fromPhone.replace(/\D/g, "");

  // 1) find-or-create da conversa SEM resetar estado (estado só muda se uma msg NOVA entrar).
  let conversationId: string | null = null;
  let currentOptIn = "unknown";
  const { data: existing } = await supabase.from("whatsapp_conversations")
    .select("id, opt_in_status").eq("phone_key", phoneKey).maybeSingle();
  if (existing) {
    const ex = existing as { id: string; opt_in_status?: string | null };
    conversationId = ex.id;
    currentOptIn = ex.opt_in_status ?? "unknown";
  } else {
    const customerUserId = await matchCustomer(supabase, msg.fromPhone);
    let operatorId: string | null = null;
    if (customerUserId) {
      const { data: ca } = await supabase.from("carteira_assignments")
        .select("owner_user_id").eq("customer_user_id", customerUserId).limit(1).maybeSingle();
      operatorId = (ca as { owner_user_id?: string } | null)?.owner_user_id ?? null;
    }
    const { data: created } = await supabase.from("whatsapp_conversations").insert({
      phone_key: phoneKey, phone_e164: msg.fromPhone, contact_name: msg.contactName,
      customer_user_id: customerUserId, assigned_operator_id: operatorId, status: "aberta",
    }).select("id").single();
    conversationId = (created as { id: string } | null)?.id ?? null;
  }
  if (!conversationId) return;

  // 2) insere a msg idempotente (ON CONFLICT DO NOTHING); só atualiza a conversa se for NOVA.
  const { data: inserted } = await supabase.from("whatsapp_messages").upsert({
    conversation_id: conversationId, wa_message_id: msg.waMessageId, direction: "in",
    type: msg.type, body: msg.body, media_id: msg.mediaId,
    wa_timestamp: msg.waTimestamp?.toISOString() ?? null,
  }, { onConflict: "wa_message_id", ignoreDuplicates: true }).select("id");
  const isNew = Array.isArray(inserted) && inserted.length > 0;
  if (isNew) {
    const nowIso = new Date().toISOString();
    await supabase.from("whatsapp_conversations")
      .update({
        status: "aberta", last_inbound_at: nowIso, last_message_at: nowIso,
        opt_in_status: nextOptInStatus(currentOptIn, msg.body),
      }).eq("id", conversationId);
  }
}

Deno.serve(async (req) => {
  const expected = Deno.env.get("WHATSAPP_WEBHOOK_SECRET");
  // Segredo SOMENTE via header (x-whatsapp-secret) — nunca em query string, que vaza em logs de
  // proxy/CDN, no Referer e no histórico (achado de segurança "WhatsApp Webhook Secret Exposed
  // via URL Query Parameter"). Configurar o header no webhook da 360dialog; o WHATSAPP_WEBHOOK_SECRET
  // é rotacionável e deve ser rotacionado após esta mudança.
  const provided = req.headers.get("x-whatsapp-secret") ?? "";
  // fail-closed: secret do ambiente E header precisam existir e bater (guarda explícita
  // contra header/secret vazio — defense-in-depth além do length-check do timingSafeEq).
  if (!expected || !provided || !timingSafeEq(expected, provided)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }
  let payload: unknown;
  try { payload = await req.json(); } catch { return new Response(JSON.stringify({ ok: true, ignored: "no-json" }), { status: 200 }); }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  await supabase.from("whatsapp_webhook_events").insert({ payload });

  const messages = parseInboundWebhook(payload);
  const statuses = parseStatusWebhook(payload);
  const work = (async () => {
    for (const m of messages) { try { await processMessage(supabase, m); } catch (e) { console.error("[whatsapp-inbound] processMessage", e); } }
    for (const s of statuses) { try { await processStatus(supabase, s); } catch (e) { console.error("[whatsapp-inbound] processStatus", e); } }
  })();
  const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(work); else await work;

  return new Response(JSON.stringify({ ok: true, received: messages.length, statuses: statuses.length }), { status: 200, headers: { "Content-Type": "application/json" } });
});
