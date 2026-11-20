// Edge `email-crs-ajuste-lote` — Fase 2a do lote mínimo Sayerlack.
// Envia ao CRS o pedido de redução da qtde que o portal forçou ao lote mínimo (modo `enviar`) e cobra no mesmo
// thread após 1 dia útil (modo `cobrar`). O ESTADO e as decisões vivem no SQL
// (migration 20261120190000_lote_minimo_email_crs.sql); aqui só há o POST no Gmail entre `reservar` e `confirmar`.
//
// Ordem irreversível: reservar (commit no banco) → POST users/me/messages/send (UMA vez, sem retry) → confirmar.
// Só 4xx do Gmail libera a reserva (prova de não envio). Timeout/rede/5xx/2xx ilegível = indeterminado: o SQL
// alerta o founder e nunca reenvia sozinho.
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import {
  assuntoResposta,
  base64Url,
  classificarEnvioGmail,
  CRS_PARA,
  type DesfechoEnvio,
  extrairMessageIdRfc,
  type ItemAjuste,
  montarCorpoCobranca,
  montarCorpoInicial,
  montarRfc2822,
  segundosRetryAfter,
} from "./logica.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
const CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
const REFRESH_TOKEN = Deno.env.get("GOOGLE_OAUTH_REFRESH_TOKEN");

const MAX_POR_CHAMADA = 5;
const TIMEOUT_POST_MS = 30_000;

type Reserva = {
  acao: string;
  etapa?: "inicial" | "cobranca1";
  pedido_id: number;
  token?: string;
  protocolo?: string;
  assunto?: string;
  rfc_message_id?: string;
  thread_id?: string;
  in_reply_to?: string | null;
  itens?: Array<{
    sku_portal: string;
    descricao: string | null;
    qtde_portal_lancada: number;
    qtde_portal_necessaria: number;
  }>;
  motivo?: string;
};

const msgErro = (e: unknown): string => mensagemDeErro(e) ?? "erro sem mensagem";

async function obterAccessToken(): Promise<{ ok: true; token: string } | { ok: false; erro: string }> {
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) return { ok: false, erro: "credencial Google ausente no ambiente" };
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: REFRESH_TOKEN,
        grant_type: "refresh_token",
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const texto = await res.text();
    if (!res.ok) {
      let codigo = `HTTP ${res.status}`;
      try {
        codigo += ` ${(JSON.parse(texto) as { error?: string }).error ?? ""}`.trimEnd();
      } catch { /* corpo não-JSON: fica só o status */ }
      return { ok: false, erro: `OAuth Google falhou (${codigo})` };
    }
    const tok = (JSON.parse(texto) as { access_token?: unknown }).access_token;
    return typeof tok === "string" && tok ? { ok: true, token: tok } : { ok: false, erro: "OAuth Google sem access_token" };
  } catch (e) {
    return { ok: false, erro: `OAuth Google inacessível: ${msgErro(e)}` };
  }
}

/** UM POST, sem retry (retry aqui = risco de 2 e-mails ao fornecedor). */
async function postarGmail(
  accessToken: string,
  raw: string,
  threadId: string | null,
): Promise<{ desfecho: DesfechoEnvio; retryAfterS: number | null }> {
  try {
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(threadId ? { raw: base64Url(raw), threadId } : { raw: base64Url(raw) }),
      signal: AbortSignal.timeout(TIMEOUT_POST_MS),
    });
    const corpo = await res.text().catch(() => "");
    return {
      desfecho: classificarEnvioGmail({ status: res.status, corpo }),
      retryAfterS: segundosRetryAfter(res.headers.get("retry-after"), Date.now()),
    };
  } catch (e) {
    return { desfecho: classificarEnvioGmail({ erroRede: msgErro(e) }), retryAfterS: null };
  }
}

/** Best-effort: o Message-ID RFC que o Gmail gravou. 403 = o token só tem gmail.send (fica o proposto). */
async function lerMessageIdRfc(accessToken: string, gmailId: string): Promise<{ rfc: string | null; status: string }> {
  try {
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(gmailId)}` +
      "?format=metadata&metadataHeaders=Message-ID";
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { rfc: null, status: `HTTP ${res.status}` };
    return { rfc: extrairMessageIdRfc(await res.json()), status: "ok" };
  } catch (e) {
    return { rfc: null, status: `erro: ${msgErro(e)}` };
  }
}

function montarEmail(r: Reserva): { raw: string; threadId: string | null } {
  if (!r.token || !r.protocolo || !r.assunto || !r.rfc_message_id) throw new Error("reserva incompleta");
  if (r.etapa === "inicial") {
    const itens: ItemAjuste[] = (r.itens ?? []).map((i) => ({
      skuPortal: i.sku_portal,
      descricao: i.descricao,
      qtdeLancada: Number(i.qtde_portal_lancada),
      qtdeNecessaria: Number(i.qtde_portal_necessaria),
    }));
    const corpo = montarCorpoInicial(r.protocolo, itens);
    return { raw: montarRfc2822({ para: CRS_PARA, assunto: r.assunto, corpo, messageId: r.rfc_message_id }), threadId: null };
  }
  if (r.etapa === "cobranca1") {
    if (!r.thread_id) throw new Error("cobrança sem thread");
    return {
      raw: montarRfc2822({
        para: CRS_PARA,
        assunto: assuntoResposta(r.assunto),
        corpo: montarCorpoCobranca(r.protocolo),
        messageId: r.rfc_message_id,
        inReplyTo: r.in_reply_to ?? null,
      }),
      threadId: r.thread_id,
    };
  }
  throw new Error(`etapa desconhecida: ${String(r.etapa)}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  // ⚠️ SONDA DE VERSÃO — antes de qualquer IO: ela não envia nada. Ver versao.ts / _shared/sonda-versao.ts.
  const corpoBruto: unknown = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const decisaoSonda = classificarSonda(corpoBruto);
  if (decisaoSonda.tipo === "sonda") return json(respostaSonda(VERSAO), 200);
  if (decisaoSonda.tipo === "ambiguo") {
    return json({ ok: false, versao: VERSAO, error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }, 400);
  }

  const modo = (corpoBruto as { modo?: unknown } | null)?.modo;
  if (modo !== "enviar" && modo !== "cobrar") {
    return json({ ok: false, versao: VERSAO, error: "modo deve ser 'enviar' ou 'cobrar'" }, 400);
  }
  const etapa = modo === "enviar" ? "inicial" : "cobranca1";
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // OAuth ANTES de reservar: sem token não há POST e nada fica preso. O SQL alerta o atraso em 30 min.
  const tok = await obterAccessToken();
  if (!tok.ok) {
    console.error(`[email-crs] ${tok.erro}`);
    return json({ ok: false, versao: VERSAO, modo, error: tok.erro }, 502);
  }

  const resultados: Array<Record<string, unknown>> = [];
  let falhaInfra = false;
  for (let i = 0; i < MAX_POR_CHAMADA; i++) {
    const { data, error } = await supabase.rpc("ajuste_lote_email_reservar", { p_etapa: etapa });
    if (error) {
      console.error(`[email-crs] reservar falhou: ${error.message}`);
      resultados.push({ erro_reservar: error.message });
      falhaInfra = true;
      break;
    }
    const r = data as Reserva | null;
    if (!r) break;
    if (r.acao !== "enviar") {
      resultados.push({ pedido_id: r.pedido_id, acao: r.acao, motivo: r.motivo ?? null });
      continue;
    }

    let email: { raw: string; threadId: string | null };
    try {
      email = montarEmail(r);
    } catch (e) {
      // Nada foi postado: liberar é seguro (o SQL bloqueia na 3ª e alerta o founder).
      const { data: f } = await supabase.rpc("ajuste_lote_email_falhou", {
        p_etapa: etapa, p_pedido_id: r.pedido_id, p_token: r.token, p_tipo: "nao_enviado",
        p_erro: `montagem: ${msgErro(e)}`, p_espera_s: null,
      });
      resultados.push({ pedido_id: r.pedido_id, acao: "montagem_falhou", sql: f ?? null });
      continue;
    }

    const { desfecho, retryAfterS } = await postarGmail(tok.token, email.raw, email.threadId);
    if (desfecho.tipo === "enviado") {
      let conf: unknown = null;
      for (let t = 0; t < 3; t++) {  // repete SÓ a confirmação (idempotente pelo token + id)
        const { data: c, error: ec } = await supabase.rpc("ajuste_lote_email_confirmar", {
          p_etapa: etapa, p_pedido_id: r.pedido_id, p_token: r.token,
          p_gmail_message_id: desfecho.id, p_thread_id: desfecho.threadId,
        });
        if (!ec) {
          conf = c;
          break;
        }
        console.error(`[email-crs] confirmar pedido ${r.pedido_id} falhou (tentativa ${t + 1}): ${ec.message}`);
      }
      const linha: Record<string, unknown> = {
        pedido_id: r.pedido_id, acao: "enviado", etapa, gmail_id: desfecho.id, thread_id: desfecho.threadId,
        confirmacao: conf,
      };
      if (etapa === "inicial" && (conf === "confirmado" || conf === "ja_confirmado")) {
        const lido = await lerMessageIdRfc(tok.token, desfecho.id);
        linha.rfc_leitura = lido.status;
        if (lido.rfc) {
          const { data: reg } = await supabase.rpc("ajuste_lote_email_registrar_rfc", {
            p_pedido_id: r.pedido_id, p_token: r.token, p_rfc: lido.rfc,
          });
          linha.rfc_registro = reg ?? null;
          linha.rfc_preservado = lido.rfc === r.rfc_message_id;
        }
      }
      if (conf !== "confirmado" && conf !== "ja_confirmado") {
        console.error(`[email-crs] pedido ${r.pedido_id}: e-mail ACEITO pelo Gmail (${desfecho.id}) sem confirmação no banco`);
      }
      resultados.push(linha);
      continue;
    }
    const { data: f, error: ef } = await supabase.rpc("ajuste_lote_email_falhou", {
      p_etapa: etapa, p_pedido_id: r.pedido_id, p_token: r.token, p_tipo: desfecho.tipo,
      p_erro: desfecho.motivo, p_espera_s: retryAfterS,
    });
    if (ef) console.error(`[email-crs] registrar falha do pedido ${r.pedido_id} falhou: ${ef.message}`);
    console.warn(`[email-crs] pedido ${r.pedido_id} ${etapa}: ${desfecho.tipo} — ${desfecho.motivo}`);
    resultados.push({ pedido_id: r.pedido_id, acao: desfecho.tipo, etapa, sql: f ?? null });
  }

  // Reserva que falhou = nada processado: 500 para o cron/net._http_response mostrar a verdade (Codex P2-10).
  return json({ ok: !falhaInfra, versao: VERSAO, modo, resultados }, falhaInfra ? 500 : 200);
});
