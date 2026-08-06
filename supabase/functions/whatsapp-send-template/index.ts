// Edge: whatsapp-send-template — envio de template HSM (fora da janela de 24h).
// Regras: (1) só staff/service_role (cron 403 — o motor de rota entra via service_role no PR do disparo);
// (2) opt_out NUNCA recebe template (LGPD); (3) idempotência dedupe-first: reserva a dedupe_key
// no banco ANTES do POST — retry legítimo só re-envia registro 'failed'.
// Espelhos de src/lib/whatsapp/template-payload.ts e inbound.ts (Deno não importa do src/).
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

// --- espelho de src/lib/whatsapp/template-payload.ts ---
function sanitizeTemplateParam(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/[\n\r]+/g, ", ").replace(/\t/g, " ").replace(/ {2,}/g, " ").trim();
}
function validateBodyParams(params: string[], expected: number): string | null {
  if (params.length !== expected) return `template exige ${expected} parâmetro(s) de body; recebeu ${params.length}`;
  const vazio = params.findIndex((p) => sanitizeTemplateParam(p).length === 0);
  if (vazio >= 0) return `parâmetro ${vazio + 1} vazio pós-sanitize`;
  return null;
}
function buildTemplatePayload(input: { to: string; templateName: string; languageCode?: string; bodyParams: string[] }): Record<string, unknown> {
  const params = input.bodyParams.map((t) => ({ type: "text", text: sanitizeTemplateParam(t) }));
  const template: Record<string, unknown> = { name: input.templateName, language: { code: input.languageCode ?? "pt_BR" } };
  if (params.length > 0) template.components = [{ type: "body", parameters: params }];
  return { messaging_product: "whatsapp", to: input.to, type: "template", template };
}
function renderTemplatePreview(corpoReferencia: string, bodyParams: string[]): string {
  return corpoReferencia.replace(/\{\{(\d+)\}\}/g, (m, n) => {
    const idx = Number(n) - 1;
    const v = bodyParams[idx];
    return v === undefined ? m : sanitizeTemplateParam(v);
  });
}
// --- espelho de src/lib/whatsapp/inbound.ts (waPhoneCandidates) ---
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

type Supa = ReturnType<typeof createClient>;

async function matchCustomer(supabase: Supa, fromPhone: string): Promise<string | null> {
  const cands = waPhoneCandidates(fromPhone);
  if (cands.length === 0) return null;
  const { data } = await supabase.from("profiles").select("user_id, phone").not("phone", "is", null);
  for (const p of (data ?? []) as Array<{ user_id: string; phone: string }>) {
    const pc = waPhoneCandidates(p.phone);
    if (pc.some((x) => cands.includes(x))) return p.user_id;
  }
  return null;
}

// find-or-create de conversa por telefone (mesma semântica do whatsapp-inbound).
async function resolveConversa(
  supabase: Supa,
  opts: { conversationId?: string; phoneE164?: string },
): Promise<{ id: string; phone_e164: string; opt_in_status: string } | { erro: string; status: number }> {
  if (opts.conversationId) {
    const { data, error } = await supabase.from("whatsapp_conversations")
      .select("id, phone_e164, opt_in_status").eq("id", opts.conversationId).maybeSingle();
    if (error || !data) return { erro: "conversa não encontrada", status: 404 };
    return data as { id: string; phone_e164: string; opt_in_status: string };
  }
  const phone = String(opts.phoneE164 ?? "");
  const phoneKey = waPhoneCandidates(phone)[0] ?? phone.replace(/\D/g, "");
  if (!phoneKey) return { erro: "telefone inválido", status: 400 };
  const { data: existing } = await supabase.from("whatsapp_conversations")
    .select("id, phone_e164, opt_in_status").eq("phone_key", phoneKey).maybeSingle();
  if (existing) return existing as { id: string; phone_e164: string; opt_in_status: string };
  const customerUserId = await matchCustomer(supabase, phone);
  let operatorId: string | null = null;
  if (customerUserId) {
    const { data: ca } = await supabase.from("carteira_assignments")
      .select("owner_user_id").eq("customer_user_id", customerUserId).limit(1).maybeSingle();
    operatorId = (ca as { owner_user_id?: string } | null)?.owner_user_id ?? null;
  }
  const { data: created, error: cErr } = await supabase.from("whatsapp_conversations").insert({
    phone_key: phoneKey, phone_e164: phone, customer_user_id: customerUserId,
    assigned_operator_id: operatorId, status: "aberta",
  }).select("id, phone_e164, opt_in_status").single();
  if (cErr || !created) return { erro: "falha ao criar conversa", status: 500 };
  return created as { id: string; phone_e164: string; opt_in_status: string };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;
  // Cron NÃO dispara template avulso — automação entra via service_role (motor de rota, PR posterior).
  if (auth.via === "cron") return json({ error: "forbidden", detail: "apenas staff ou service_role" }, 403);

  const body = await req.json().catch(() => ({}));
  const { templateNome, phoneE164, conversationId, dedupeKey } = body ?? {};
  const bodyParams: string[] = Array.isArray(body?.bodyParams) ? body.bodyParams.map(String) : [];
  const origem = ["manual", "proposta", "status_pedido", "rota"].includes(body?.origem) ? body.origem : "manual";
  if (!templateNome || !dedupeKey || (!phoneE164 && !conversationId)) {
    return json({ error: "templateNome, dedupeKey e (phoneE164 ou conversationId) obrigatórios" }, 400);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { data: tpl, error: tErr } = await supabase.from("whatsapp_templates")
    .select("nome, categoria, idioma, corpo_referencia, num_body_params, ativo")
    .eq("nome", templateNome).maybeSingle();
  if (tErr || !tpl) return json({ error: "template não encontrado" }, 404);
  const t = tpl as { nome: string; idioma: string; corpo_referencia: string; num_body_params: number; ativo: boolean };
  if (!t.ativo) return json({ error: "template inativo (aguardando aprovação Meta?)" }, 409);

  const vErr = validateBodyParams(bodyParams, t.num_body_params);
  if (vErr) return json({ error: vErr }, 400);

  const conv = await resolveConversa(supabase, { conversationId, phoneE164 });
  if ("erro" in conv) return json({ error: conv.erro }, conv.status);
  // LGPD: opt_out NUNCA recebe proativo — nem template pago.
  if (conv.opt_in_status === "opt_out") return json({ error: "opt_out", detail: "cliente pediu PARAR" }, 409);

  // Idempotência dedupe-first: reserva ANTES do POST. Duplicata → 409 sem reenviar.
  // Registro anterior 'failed' → retry legítimo reutiliza a MESMA reserva.
  const insRes = await supabase.from("whatsapp_template_sends").insert({
    template_nome: t.nome, conversation_id: conv.id, phone_e164: conv.phone_e164,
    body_params: bodyParams, dedupe_key: dedupeKey, status: "queued", origem,
    disparado_por: auth.via === "staff" ? auth.userId : null,
  }).select("id").single();
  let sendId: string | null = (insRes.data as { id: string } | null)?.id ?? null;
  if (insRes.error) {
    const dup = insRes.error.code === "23505";
    if (!dup) return json({ error: "falha ao reservar envio", detail: insRes.error.message }, 500);
    const { data: existing } = await supabase.from("whatsapp_template_sends")
      .select("id, status, wa_message_id").eq("dedupe_key", dedupeKey).single();
    const ex = existing as { id: string; status: string; wa_message_id: string | null } | null;
    if (!ex || ex.status !== "failed") {
      return json({ error: "duplicate", detail: "dedupe_key já usada", existing: ex }, 409);
    }
    sendId = ex.id; // retry de envio que falhou: reusa a reserva
    await supabase.from("whatsapp_template_sends")
      .update({ status: "queued", erro: null }).eq("id", ex.id);
  }

  const to = conv.phone_e164.replace(/\D/g, "");
  const payload = buildTemplatePayload({ to, templateName: t.nome, languageCode: t.idioma, bodyParams });
  const resp = await fetch(`${D360_BASE}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "D360-API-KEY": D360_KEY },
    body: JSON.stringify(payload),
  });
  const result = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    console.error("[whatsapp-send-template] 360dialog erro", resp.status, result);
    await supabase.from("whatsapp_template_sends")
      .update({ status: "failed", erro: `HTTP ${resp.status} ${JSON.stringify(result).slice(0, 500)}` })
      .eq("id", sendId!);
    return json({ error: "send_failed", status: resp.status, detail: result }, 502);
  }

  const waId = (result as { messages?: Array<{ id?: string }> })?.messages?.[0]?.id ?? null;
  const nowIso = new Date().toISOString();
  // Mensagem JÁ saiu: falha de persistência não falha o request (logar alto), padrão do whatsapp-send.
  const { error: updErr } = await supabase.from("whatsapp_template_sends")
    .update({ status: "sent", wa_message_id: waId, erro: null }).eq("id", sendId!);
  const preview = renderTemplatePreview(t.corpo_referencia, bodyParams);
  const { error: msgErr } = await supabase.from("whatsapp_messages").insert({
    conversation_id: conv.id, wa_message_id: waId, direction: "out", type: "template",
    body: preview, status: "sent", sender_user_id: auth.via === "staff" ? auth.userId : null, wa_timestamp: nowIso,
  });
  const { error: convErr } = await supabase.from("whatsapp_conversations")
    .update({ last_message_at: nowIso, status: "aguardando_cliente" }).eq("id", conv.id);
  if (updErr || msgErr || convErr) {
    console.error("[whatsapp-send-template] persistência falhou (msg já enviada)", updErr, msgErr, convErr);
  }
  return json({ ok: true, wa_message_id: waId, conversationId: conv.id, persisted: !updErr && !msgErr && !convErr });
});
