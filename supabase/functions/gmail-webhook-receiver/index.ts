// Edge Function: gmail-webhook-receiver
// Recebe POSTs de um Apps Script do Google que monitora a caixa de entrada
// e encaminha emails de fornecedores (Sayerlack / GoodData) para o pipeline
// de extração via Vision já existente.
//
// Authorization: Bearer <GMAIL_WEBHOOK_SECRET>
//
// Body:
// {
//   fromAddress: string,
//   subject: string,
//   messageId: string,
//   receivedAt: string (ISO),
//   attachments: [{ filename, mimeType, contentBase64 }],
//   bodyText?: string
// }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GMAIL_WEBHOOK_SECRET = Deno.env.get("GMAIL_WEBHOOK_SECRET");

interface AttachmentIn {
  filename: string;
  mimeType: string;
  contentBase64: string;
}

interface WebhookBody {
  fromAddress: string;
  subject?: string;
  messageId: string;
  receivedAt?: string;
  attachments?: AttachmentIn[];
  bodyText?: string;
}

interface RemetenteRule {
  tipo_documento: "campanha_sayerlack" | "aumento_sayerlack" | "relatorio_trimestral";
  bucket: "promocoes" | "aumentos" | null;
  fornecedor_nome: string;
  empresa: string;
  /** Tipo enviado para o extractor (campanha_sayerlack ou aumento) */
  tipo_extractor: "campanha_sayerlack" | "aumento" | null;
}

const REMETENTES: Record<string, RemetenteRule> = {
  "juliana@sayerlack.com.br": {
    tipo_documento: "campanha_sayerlack",
    bucket: "promocoes",
    fornecedor_nome: "Renner Sayerlack",
    empresa: "OBEN",
    tipo_extractor: "campanha_sayerlack",
  },
  "sc@sayerlack.com.br": {
    tipo_documento: "aumento_sayerlack",
    bucket: "aumentos",
    fornecedor_nome: "Renner Sayerlack",
    empresa: "OBEN",
    tipo_extractor: "aumento",
  },
  "noreply@gooddata.com": {
    tipo_documento: "relatorio_trimestral",
    bucket: null, // Não envia para vision; processado por outro fluxo
    fornecedor_nome: "Renner Sayerlack",
    empresa: "OBEN",
    tipo_extractor: null,
  },
};

const SUSPENSAO_PATTERNS = [/SUSPENSA/i, /CANCELADA/i, /CANCELAMENTO/i];

function isSuspensao(subject: string | undefined | null): boolean {
  if (!subject) return false;
  return SUSPENSAO_PATTERNS.some((p) => p.test(subject));
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function base64ToBytes(b64: string): Uint8Array {
  // Apps Script costuma enviar base64 padrão; aceitamos também url-safe
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  // 1. Validação do shared secret
  if (!GMAIL_WEBHOOK_SECRET) {
    console.error("[gmail-webhook] GMAIL_WEBHOOK_SECRET não configurado");
    return jsonResponse(500, { error: "Webhook secret não configurado" });
  }

  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${GMAIL_WEBHOOK_SECRET}`;
  if (auth !== expected) {
    console.warn("[gmail-webhook] Auth inválido");
    return jsonResponse(401, { error: "Unauthorized" });
  }

  // 2. Parse + validação básica do body
  let body: WebhookBody;
  try {
    body = (await req.json()) as WebhookBody;
  } catch {
    return jsonResponse(400, { error: "JSON inválido" });
  }

  if (!body?.messageId || !body?.fromAddress) {
    return jsonResponse(400, {
      error: "Campos obrigatórios: messageId, fromAddress",
    });
  }

  const fromAddress = body.fromAddress.toLowerCase().trim();
  const rule = REMETENTES[fromAddress];

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // 3. Deduplicação por message_id
  const { data: existing } = await supabase
    .from("gmail_webhook_log")
    .select("id, status")
    .eq("message_id", body.messageId)
    .maybeSingle();

  if (existing) {
    console.log(
      `[gmail-webhook] Duplicado messageId=${body.messageId} log_id=${existing.id}`,
    );
    return jsonResponse(200, {
      success: true,
      duplicado: true,
      log_id: existing.id,
      message: "Já processado",
    });
  }

  // 4. Cria log inicial
  const { data: logRow, error: logErr } = await supabase
    .from("gmail_webhook_log")
    .insert({
      message_id: body.messageId,
      remetente: fromAddress,
      subject: body.subject ?? null,
      received_at: body.receivedAt ?? null,
      status: "processando",
      tipo_documento: rule?.tipo_documento ?? null,
      detalhes: {
        attachments_count: body.attachments?.length ?? 0,
        body_preview: body.bodyText?.slice(0, 500) ?? null,
      },
    })
    .select("id")
    .single();

  if (logErr || !logRow) {
    console.error("[gmail-webhook] Erro criando log:", logErr);
    return jsonResponse(500, { error: "Erro registrando log" });
  }
  const logId = logRow.id;

  // 5. Remetente não suportado → registra como rejeitado
  if (!rule) {
    await supabase
      .from("gmail_webhook_log")
      .update({
        status: "rejeitado",
        processado_em: new Date().toISOString(),
        erro: `Remetente ${fromAddress} não está mapeado`,
      })
      .eq("id", logId);
    return jsonResponse(400, {
      error: "Remetente não suportado",
      log_id: logId,
    });
  }

  // 6. Detecta suspensão → cria alerta e termina sem processar anexo
  if (isSuspensao(body.subject)) {
    const { data: alerta, error: alertaErr } = await supabase
      .from("fornecedor_alerta")
      .insert({
        empresa: rule.empresa,
        fornecedor_nome: rule.fornecedor_nome,
        tipo: "promocao_suspensa",
        severidade: "atencao",
        titulo: body.subject ?? "Promoção suspensa",
        mensagem:
          `Email recebido de ${fromAddress} indica suspensão/cancelamento.\n\n` +
          (body.bodyText?.slice(0, 1000) ?? ""),
        email_origem_id: body.messageId,
      })
      .select("id")
      .single();

    const alertaId = alerta?.id ?? null;

    await supabase
      .from("gmail_webhook_log")
      .update({
        status: "suspensao",
        processado_em: new Date().toISOString(),
        alertas_criados: alertaId ? [alertaId] : [],
        erro: alertaErr ? alertaErr.message : null,
      })
      .eq("id", logId);

    return jsonResponse(200, {
      success: true,
      log_id: logId,
      campanhas_criadas: [],
      alertas_criados: alertaId ? [alertaId] : [],
      suspensao: true,
    });
  }

  // 7. Processa anexos (PDF / imagem) em paralelo
  const attachments = (body.attachments ?? []).filter((a) => {
    const mt = (a.mimeType ?? "").toLowerCase();
    return (
      mt === "application/pdf" ||
      mt === "image/jpeg" ||
      mt === "image/jpg" ||
      mt === "image/png"
    );
  });

  if (attachments.length === 0 || !rule.bucket || !rule.tipo_extractor) {
    // Sem anexos processáveis (ou tipo que não vai para vision: relatorio_trimestral)
    await supabase
      .from("gmail_webhook_log")
      .update({
        status: rule.tipo_extractor ? "parcial" : "sucesso",
        processado_em: new Date().toISOString(),
        erro:
          rule.tipo_extractor && attachments.length === 0
            ? "Nenhum anexo PDF/imagem encontrado"
            : null,
      })
      .eq("id", logId);
    return jsonResponse(200, {
      success: true,
      log_id: logId,
      campanhas_criadas: [],
      alertas_criados: [],
      aumentos_criados: [],
      message: rule.tipo_extractor
        ? "Email registrado sem anexos processáveis"
        : "Email registrado (não requer extração)",
    });
  }

  const campanhasCriadas: number[] = [];
  const aumentosCriados: number[] = [];
  const alertasCriados: number[] = [];
  const errosExtractor: string[] = [];

  await Promise.all(
    attachments.map(async (att, idx) => {
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(att.contentBase64);
      } catch (e) {
        errosExtractor.push(
          `Anexo ${att.filename}: base64 inválido (${
            (e as Error).message
          })`,
        );
        return;
      }

      // 7a. Upload para o bucket correspondente
      const objectPath =
        `${logId}/${Date.now()}_${idx}_${safeFilename(att.filename)}`;
      const { error: upErr } = await supabase.storage
        .from(rule.bucket!)
        .upload(objectPath, bytes, {
          contentType: att.mimeType,
          upsert: false,
        });

      if (upErr) {
        // Upload é considerado erro "duro" (retryable do lado do Apps Script)
        throw new Error(
          `Falha upload ${rule.bucket}/${objectPath}: ${upErr.message}`,
        );
      }

      // 7b. Chama o extractor existente
      try {
        const { data: extractRes, error: extractErr } =
          await supabase.functions.invoke("promocao-extrair-via-vision", {
            body: {
              empresa: rule.empresa,
              fornecedor_nome: rule.fornecedor_nome,
              arquivo_base64: att.contentBase64,
              arquivo_tipo: att.mimeType,
              tipo_documento: rule.tipo_extractor,
              origem_email: {
                remetente: fromAddress,
                assunto: body.subject ?? null,
                data: body.receivedAt ?? null,
              },
              criado_por: "gmail_webhook",
            },
          });

        if (extractErr) {
          errosExtractor.push(
            `Anexo ${att.filename}: ${extractErr.message ?? "erro extractor"}`,
          );
          return;
        }

        const r = extractRes as Record<string, unknown> | null;
        const campanhaId = r?.campanha_id ?? r?.campaign_id;
        const aumentoId = r?.aumento_id;
        const alertaId = r?.alerta_id;
        if (typeof campanhaId === "number") campanhasCriadas.push(campanhaId);
        if (typeof aumentoId === "number") aumentosCriados.push(aumentoId);
        if (typeof alertaId === "number") alertasCriados.push(alertaId);
      } catch (e) {
        errosExtractor.push(
          `Anexo ${att.filename}: ${(e as Error).message}`,
        );
      }
    }),
  ).catch(async (e: Error) => {
    // Erro de upload (rethrow) → marca erro e devolve 500 (retryable)
    await supabase
      .from("gmail_webhook_log")
      .update({
        status: "erro",
        processado_em: new Date().toISOString(),
        erro: e.message,
      })
      .eq("id", logId);
    throw e;
  }).then(() => undefined);

  // 8. Status final
  const statusFinal =
    errosExtractor.length === 0
      ? "sucesso"
      : campanhasCriadas.length + aumentosCriados.length > 0
      ? "parcial"
      : "parcial"; // extractor falhou mas não retornamos 500 (evita retry infinito)

  await supabase
    .from("gmail_webhook_log")
    .update({
      status: statusFinal,
      processado_em: new Date().toISOString(),
      campanhas_criadas: campanhasCriadas,
      aumentos_criados: aumentosCriados,
      alertas_criados: alertasCriados,
      erro: errosExtractor.length > 0 ? errosExtractor.join(" | ") : null,
    })
    .eq("id", logId);

  return jsonResponse(200, {
    success: true,
    log_id: logId,
    status: statusFinal,
    campanhas_criadas: campanhasCriadas,
    aumentos_criados: aumentosCriados,
    alertas_criados: alertasCriados,
    erros: errosExtractor,
  });
});
