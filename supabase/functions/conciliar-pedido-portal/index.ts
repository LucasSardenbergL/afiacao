// Edge Function: conciliar-pedido-portal
// Conciliação manual: operador informa o número do protocolo de um pedido que
// ficou em aceito_portal_sem_protocolo / indeterminado_requer_conciliacao,
// marcamos como sucesso_portal e disparamos o Omie.

import { createClient } from "npm:@supabase/supabase-js@2.45.0";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const STATUS_CONCILIAVEIS = new Set([
  "aceito_portal_sem_protocolo",
  "indeterminado_requer_conciliacao",
  // Defensivo: legados que indicam falha mas operador insiste que o portal recebeu.
  "falha_envio_portal",
  "erro_nao_retentavel",
]);

interface ConciliarPedidoBody {
  pedido_id?: number | string;
  protocolo?: string;
}

interface PedidoCompraSugeridoRow {
  id: number;
  empresa: string;
  fornecedor_nome: string | null;
  status: string | null;
  status_envio_portal: string | null;
  portal_protocolo: string | null;
  omie_pedido_compra_id: string | number | null;
}

// ⚠️ ESPELHADO VERBATIM de src/lib/reposicao/omie-disparo-helpers.ts (Deno não importa de @/).
// Guard anti-PO-duplicado da conciliação manual (Fase 3 · 3b, §4.4): só dispara a
// criação do PO no Omie quando o pedido AINDA NÃO tem omie_pedido_compra_id. NULL/''/
// whitespace/'0' contam como "não tem" → cria (comportamento de hoje). Mudou aqui? Copie lá.
function deveCriarPedidoOmie(
  omiePedidoCompraId: string | number | null | undefined,
): boolean {
  if (omiePedidoCompraId == null) return true;
  const s = String(omiePedidoCompraId).trim();
  if (s === "") return true;
  if (s === "0") return true;
  return false;
}

async function dispararOmie(empresa: string, pedidoId: number) {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/disparar-pedidos-aprovados`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ empresa, pedido_id: pedidoId }),
  });
  const text = await resp.text();
  return { httpStatus: resp.status, body: text.slice(0, 800) };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  let body: ConciliarPedidoBody = {};
  try {
    body = (await req.json()) as unknown as ConciliarPedidoBody;
  } catch {
    return new Response(JSON.stringify({ error: "Body JSON inválido" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const pedidoId = Number(body?.pedido_id);
  const protocolo = String(body?.protocolo ?? "").trim();

  if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
    return new Response(JSON.stringify({ error: "pedido_id inválido" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!/^\d{3,12}$/.test(protocolo)) {
    return new Response(JSON.stringify({ error: "protocolo deve ser numérico com 3 a 12 dígitos" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Buscar pedido e validar estado.
  const { data: pedidoRaw, error: pErr } = await supabase
    .from("pedido_compra_sugerido")
    .select("id, empresa, fornecedor_nome, status, status_envio_portal, portal_protocolo, omie_pedido_compra_id")
    .eq("id", pedidoId)
    .maybeSingle();

  if (pErr || !pedidoRaw) {
    return new Response(JSON.stringify({ error: `Pedido ${pedidoId} não encontrado` }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const pedido = pedidoRaw as unknown as PedidoCompraSugeridoRow;
  const statusAnterior = pedido.status_envio_portal;

  // Já tem protocolo? Idempotência amigável: se o protocolo é o mesmo, retorna OK.
  if (pedido.portal_protocolo) {
    if (String(pedido.portal_protocolo) === protocolo) {
      return new Response(
        JSON.stringify({
          ok: true,
          already: true,
          pedido_id: pedidoId,
          protocolo,
          status_envio_portal: statusAnterior,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        error: `Pedido ${pedidoId} já tem protocolo (${pedido.portal_protocolo}) diferente do informado (${protocolo}). Resolva manualmente.`,
      }),
      { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (!statusAnterior || !STATUS_CONCILIAVEIS.has(statusAnterior)) {
    return new Response(
      JSON.stringify({
        error: `Pedido ${pedidoId} está em status_envio_portal='${statusAnterior}', que não permite conciliação manual. Estados permitidos: ${Array.from(STATUS_CONCILIAVEIS).join(", ")}.`,
      }),
      { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const agora = new Date().toISOString();
  const iniciadoEm = agora;

  // 2. Marcar pedido como sucesso_portal com o protocolo informado.
  const { error: upErr } = await supabase
    .from("pedido_compra_sugerido")
    .update({
      status_envio_portal: "sucesso_portal",
      portal_protocolo: protocolo,
      portal_erro: null,
      enviado_portal_em: agora,
      portal_proximo_retry_em: null,
    })
    .eq("id", pedidoId);

  if (upErr) {
    return new Response(
      JSON.stringify({ error: `Falha ao atualizar pedido: ${upErr.message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // 3. Gravar auditoria da conciliação manual.
  await supabase.from("pedidos_portal_tentativas").insert({
    pedido_id: pedidoId,
    iniciado_em: iniciadoEm,
    concluido_em: new Date().toISOString(),
    status_resultado: "sucesso_portal",
    elapsed_ms: 0,
    evidence: {
      phase: "conciliacao_manual",
      status_anterior: statusAnterior,
      protocolo,
      operator_user_id: auth.ok && auth.userId ? auth.userId : null,
      via: auth.ok ? auth.via : null,
    },
    browserless_response_ms: null,
    erro: null,
  });

  // 4. Disparar Omie — SÓ se o pedido ainda não tem PO no Omie (guard anti-PO-duplicado,
  // §4.4). Se omie_pedido_compra_id já está preenchido, o PO já existe (corrida/retry
  // anterior) → NÃO recriar; a conciliação acima (protocolo + sucesso_portal) basta.
  // O dedup por cCodIntPed do próprio Omie é backstop; este guard evita a chamada.
  if (!deveCriarPedidoOmie(pedido.omie_pedido_compra_id)) {
    return new Response(
      JSON.stringify({
        ok: true,
        pedido_id: pedidoId,
        protocolo,
        status_anterior: statusAnterior,
        status_envio_portal: "sucesso_portal",
        omie: {
          ok: true,
          skipped: true,
          motivo: "ja_existe",
          omie_pedido_compra_id: String(pedido.omie_pedido_compra_id),
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // disparar-pedidos-aprovados vê sucesso_portal + protocolo como already_sent e
  // cria o pedido de compra no Omie.
  const omie = await dispararOmie(pedido.empresa, pedidoId);
  const omieOk = omie.httpStatus >= 200 && omie.httpStatus < 300;

  return new Response(
    JSON.stringify({
      ok: true,
      pedido_id: pedidoId,
      protocolo,
      status_anterior: statusAnterior,
      status_envio_portal: "sucesso_portal",
      omie: {
        ok: omieOk,
        httpStatus: omie.httpStatus,
        bodyPreview: omie.body,
      },
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
