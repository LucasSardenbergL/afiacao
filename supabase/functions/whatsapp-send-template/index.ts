// Edge: whatsapp-send-template — envio de template HSM (fora da janela de 24h).
// Regras: (1) só staff/service_role (cron 403 — o motor de rota entra via service_role no PR do disparo);
// (2) opt_out NUNCA recebe template (LGPD); (3) reserva ATÔMICA no banco ANTES do POST
// (whatsapp_template_reservar): idempotência pela dedupe_key, retry só de recusa provada (4xx),
// teto diário. Resultado incerto (rede, 5xx) nunca reenvia sozinho.
// Espelhos de src/lib/whatsapp/template-payload.ts e inbound.ts (Deno não importa do src/).
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";

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

type Supa = SupabaseClient;

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

  // ⚠️ SONDA DE VERSÃO — vem ANTES do gate seguinte de propósito: ela não dispara nada, e é pelo
  // `x-cron-secret` que o founder a alcança sem abrir o app (o gate de auth decide por comparação
  // de env pura ⇒ IO-free). Daqui pra frente a edge dispara template TARIFADO ao cliente.
  // Corpo lido UMA vez — `req.json()` não se consome duas. Ver versao.ts / _shared/sonda-versao.ts.
  const corpoBruto: unknown = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const decisaoSonda = classificarSonda(corpoBruto);
  if (decisaoSonda.tipo === "sonda") return json(respostaSonda(VERSAO), 200);
  if (decisaoSonda.tipo === "ambiguo") {
    return json({ ok: false, versao: VERSAO, error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }, 400);
  }
  // Cron NÃO dispara template avulso — automação entra via service_role (motor de rota, PR posterior).
  if (auth.via === "cron") return json({ error: "forbidden", detail: "apenas staff ou service_role" }, 403);

  // Já parseado acima (para a sonda). Normaliza não-objeto para {} — preserva o comportamento
  // antigo de `.catch(() => ({}))` sem deixar um body `null` quebrar os acessos.
  const body = (typeof corpoBruto === "object" && corpoBruto !== null &&
    !Array.isArray(corpoBruto) ? corpoBruto : {}) as Record<string, unknown>;
  const { templateNome, phoneE164, conversationId, dedupeKey } = body as {
    templateNome?: string; phoneE164?: string; conversationId?: string; dedupeKey?: string;
  };
  const bodyParams: string[] = Array.isArray(body.bodyParams) ? body.bodyParams.map(String) : [];
  // `String(x ?? "")` preserva o `includes` antigo: undefined/null/não-string caem em "manual".
  const origemBruta = String(body.origem ?? "");
  const origem = ["manual", "proposta", "status_pedido", "rota"].includes(origemBruta) ? origemBruta : "manual";
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
  // LGPD: opt_out NUNCA recebe proativo — nem template pago. O consentimento é do TELEFONE, não
  // da linha: confere toda conversa com qualquer variante do número (com/sem o 9, com/sem 55).
  if (conv.opt_in_status === "opt_out") return json({ error: "opt_out", detail: "cliente pediu PARAR" }, 409);
  const variantes = waPhoneCandidates(conv.phone_e164);
  if (variantes.length === 0) return json({ error: "telefone inválido" }, 400);
  const { data: bloqueios, error: bErr } = await supabase.from("whatsapp_conversations")
    .select("id").in("phone_key", variantes).eq("opt_in_status", "opt_out").limit(1);
  if (bErr) return json({ error: "falha ao conferir opt-out", detail: bErr.message }, 500); // fail-closed
  if ((bloqueios ?? []).length > 0) return json({ error: "opt_out", detail: "cliente pediu PARAR" }, 409);
  // O que vai na reserva é EXATAMENTE o que vai no POST (já sanitizado).
  const paramsEnviados = bodyParams.map(sanitizeTemplateParam);

  // Reserva ATÔMICA no banco (RPC whatsapp_template_reservar, migration 20261114210026): numa
  // transação só, idempotência pela dedupe_key + retry só de recusa PROVADA (compare-and-set em
  // 'failed' com retry_seguro) + teto diário. Antes eram 3 idas separadas, e dois retries
  // concorrentes postavam o mesmo template pago DUAS vezes. Uma reserva autoriza UM POST.
  const { data: resv, error: resvErr } = await supabase.rpc("whatsapp_template_reservar", {
    p_dedupe_key: dedupeKey, p_template_nome: t.nome, p_conversation_id: conv.id,
    p_phone_e164: conv.phone_e164, p_body_params: paramsEnviados, p_origem: origem,
    p_disparado_por: auth.via === "staff" ? auth.userId : null,
  });
  // Erro de RPC (inclusive teto mal configurado) = nada sai (fail-closed).
  if (resvErr) return json({ error: "falha ao reservar envio", detail: resvErr.message }, 500);
  const linhas = (Array.isArray(resv) ? resv : []) as Array<{
    resultado: string; send_id: string | null; status_existente: string | null; claim_token: string | null;
  }>;
  if (linhas.length !== 1) return json({ error: "falha ao reservar envio", detail: "reserva ambígua" }, 500);
  const r = linhas[0];
  if (r.resultado === "teto_excedido") {
    return json({ error: "teto_diario", detail: "teto diário de templates atingido — tente amanhã" }, 429);
  }
  if (r.resultado === "duplicata") {
    return json({ error: "duplicate", detail: "dedupe_key já usada",
      existing: { id: r.send_id, status: r.status_existente } }, 409);
  }
  if (r.resultado === "conflito_payload") {
    return json({ error: "conflito_payload", detail: "dedupe_key já usada para outro destinatário/template" }, 409);
  }
  if (r.resultado !== "reservado" || !r.send_id || !r.claim_token) {
    return json({ error: "falha ao reservar envio", detail: `resultado inesperado: ${r.resultado}` }, 500);
  }
  const sendId = r.send_id;
  const token = r.claim_token;
  // Finaliza só a tentativa DESTA reserva: id + token + 'queued'. Uma tentativa atrasada não
  // sobrescreve a seguinte. Conta as linhas: 0 linhas é falha de persistência, não sucesso.
  // Perder a finalização NUNCA autoriza novo envio (a linha segue 'queued', bloqueada).
  const finalizar = async (campos: Record<string, unknown>): Promise<boolean> => {
    const { data, error } = await supabase.from("whatsapp_template_sends").update(campos)
      .eq("id", sendId).eq("tentativa_id", token).eq("status", "queued").select("id");
    const ok = !error && Array.isArray(data) && data.length === 1;
    if (!ok) console.error("[whatsapp-send-template] finalização não gravou 1 linha", sendId, error?.code ?? "0 linhas");
    return ok;
  };

  const to = conv.phone_e164.replace(/\D/g, "");
  const payload = buildTemplatePayload({ to, templateName: t.nome, languageCode: t.idioma, bodyParams: paramsEnviados });
  let resp: Response;
  try {
    resp = await fetch(`${D360_BASE}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "D360-API-KEY": D360_KEY },
      body: JSON.stringify(payload),
      // Redirect 307/308 repetiria o POST (método e corpo preservados): uma reserva = UM POST.
      redirect: "error",
    });
  } catch (e) {
    // Rede caiu: NÃO sabemos se a Meta aceitou. failed SEM retry_seguro — fica bloqueado para
    // conciliação, nunca reenvia sozinho (cobrar 2× é pior que não reenviar).
    await finalizar({ status: "failed", retry_seguro: false,
      erro: `incerto: ${e instanceof Error ? e.message : "falha de rede"}`.slice(0, 500) });
    return json({ error: "send_incerto", detail: "falha de rede ao enviar — confira antes de reenviar" }, 502);
  }
  const result: unknown = await resp.json().catch(() => null);
  if (!resp.ok) {
    console.error("[whatsapp-send-template] 360dialog erro", resp.status, result);
    // Recusa PROVADA = 4xx COM erro estruturado do provedor e sem id de mensagem. Corpo
    // ilegível, 5xx ou id presente = incerto → failed sem retry (parecer Codex 2026-11-14).
    const r4 = (result ?? {}) as { error?: unknown; errors?: unknown; meta?: unknown; messages?: unknown };
    const temErroEstruturado = typeof result === "object" && result !== null &&
      (r4.error !== undefined || r4.errors !== undefined || r4.meta !== undefined);
    const recusaProvada = resp.status >= 400 && resp.status < 500 && temErroEstruturado &&
      r4.messages === undefined;
    await finalizar({ status: "failed", retry_seguro: recusaProvada,
      erro: `HTTP ${resp.status} ${JSON.stringify(result).slice(0, 500)}` });
    return json({ error: recusaProvada ? "send_failed" : "send_incerto", status: resp.status, detail: result }, 502);
  }

  const waIdBruto = (result as { messages?: Array<{ id?: unknown }> } | null)?.messages?.[0]?.id;
  const waId = typeof waIdBruto === "string" && waIdBruto.trim() !== "" ? waIdBruto : null;
  if (!waId) {
    // 2xx fora do contrato (sem id): não dá para afirmar 'sent' nem reenviar.
    await finalizar({ status: "failed", retry_seguro: false, erro: "incerto: 2xx sem id de mensagem" });
    return json({ error: "send_incerto", detail: "provedor respondeu sem id de mensagem — confira antes de reenviar" }, 502);
  }
  const nowIso = new Date().toISOString();
  // Mensagem JÁ saiu: falha de persistência não falha o request (logar alto), padrão do whatsapp-send.
  const finalizouSent = await finalizar({ status: "sent", wa_message_id: waId, erro: null });
  const preview = renderTemplatePreview(t.corpo_referencia, paramsEnviados);
  const { error: msgErr } = await supabase.from("whatsapp_messages").insert({
    conversation_id: conv.id, wa_message_id: waId, direction: "out", type: "template",
    body: preview, status: "sent", sender_user_id: auth.via === "staff" ? auth.userId : null, wa_timestamp: nowIso,
  });
  const { error: convErr } = await supabase.from("whatsapp_conversations")
    .update({ last_message_at: nowIso, status: "aguardando_cliente" }).eq("id", conv.id);
  if (!finalizouSent || msgErr || convErr) {
    console.error("[whatsapp-send-template] persistência falhou (msg já enviada)", finalizouSent, msgErr, convErr);
  }
  return json({ ok: true, wa_message_id: waId, conversationId: conv.id, persisted: finalizouSent && !msgErr && !convErr });
});
