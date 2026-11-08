// Edge Function: sayerlack-encerrar-cancelado-portal  [money-path]
//
// Item 5.3 dos pontos cegos do portal Sayerlack (botão "Encerrar — cancelado no fornecedor", decisão do founder:
// AUDITADO, não automático). Pedido aceito no portal (protocolo, `sucesso_portal`), sem PO, que a Sayerlack cancelou
// (situação 6 gravada pela varredura): o claim de disparo já o recusa, e esta é a ÚNICA porta que o encerra.
//   1. só master (JWT humano; service_role e cron recusados — quem atesta o cancelamento é uma pessoa);
//   2. relê o pedido e recusa cedo (mesmas regras da RPC) — inclusive pendência de disparo aberta, de qualquer idade;
//   3. CONSULTA DIRIGIDA ao Omie (`ConsultarPedCompra` por `AFI-<id>`, o mesmo contrato da conciliação por consulta do
//      disparador): só a resposta que afirma a ausência DESTE pedido segue; existe ⇒ recusa; o resto ⇒ indeterminado;
//   4. RPC `sayerlack_encerrar_cancelado_no_portal` (service_role): revalida tudo sob FOR UPDATE, confere o espelho do
//      Omie (AFI-<id> e contrato), encerra e grava a trilha imutável;
//   5. registro em `acoes_execucoes` (slug próprio, 1 escritor = esta edge).
// Nunca chama IncluirPedCompra nem escreve no Omie/portal.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeMaster, corsHeaders } from "../_shared/auth.ts";
import { chamarOmie } from "../_shared/omie-cliente.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import { classificarConsultaPo, type ConsultaPo, mensagemDoMotivo, motivoRecusaPrevia, type PedidoLido } from "./decisao.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OMIE_PEDIDO_COMPRA_URL = "https://app.omie.com.br/api/v1/produtos/pedidocompra/";
const ACAO_REGISTRO = "reposicao.encerrar_cancelado_portal";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function abrirExecucao(db: SupabaseClient, userId: string): Promise<string | null> {
  try {
    const { data, error } = await db.from("acoes_execucoes")
      .insert({ acao: ACAO_REGISTRO, origem: "manual", executado_por: userId }).select("id").single();
    if (error || !data) { console.warn(`[encerrar-cancelado] registro não abriu (fail-open): ${error?.message ?? "sem id"}`); return null; }
    return (data as { id: string }).id;
  } catch (e) {
    console.warn(`[encerrar-cancelado] registro não abriu (fail-open): ${mensagemDeErro(e) ?? "erro"}`);
    return null;
  }
}

async function fecharExecucao(db: SupabaseClient, id: string | null, status: "sucesso" | "erro", detalhes: Record<string, unknown>) {
  if (!id) return;
  try {
    const { error } = await db.from("acoes_execucoes").update({ status, finalizado_em: new Date().toISOString(), detalhes }).eq("id", id);
    if (error) console.warn(`[encerrar-cancelado] registro não fechou (fail-open): ${error.message}`);
  } catch (e) {
    console.warn(`[encerrar-cancelado] registro não fechou (fail-open): ${mensagemDeErro(e) ?? "erro"}`);
  }
}

async function consultarOmie(codigo: string): Promise<ConsultaPo> {
  const appKey = Deno.env.get("OMIE_OBEN_APP_KEY");
  const appSecret = Deno.env.get("OMIE_OBEN_APP_SECRET");
  if (!appKey || !appSecret) return { tipo: "indeterminado", detalhe: "credenciais Omie da OBEN ausentes" };
  try {
    const r = await chamarOmie(
      { url: OMIE_PEDIDO_COMPRA_URL, metodo: "ConsultarPedCompra", param: { cCodIntPed: codigo }, credenciais: { appKey, appSecret } },
      { conta: "compras", maxTentativas: 2 },
    );
    return classificarConsultaPo(r, null, codigo);
  } catch (e) {
    return classificarConsultaPo(null, mensagemDeErro(e) ?? "erro sem mensagem", codigo);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const auth = await authorizeMaster(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown> = {};
  try {
    const b = await req.json();
    body = b && typeof b === "object" && !Array.isArray(b) ? b as Record<string, unknown> : {};
  } catch {
    return json({ ok: false, mensagem: "Body JSON inválido" }, 400);
  }

  // ⚠️ SONDA DE VERSÃO — depois do gate de credencial, antes de qualquer leitura/escrita ou do Omie.
  const decisaoSonda = classificarSonda(body);
  if (decisaoSonda.tipo === "sonda") return json(respostaSonda(VERSAO));
  if (decisaoSonda.tipo === "ambiguo") return json({ ok: false, versao: VERSAO, error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }, 400);

  // A ação é HUMANA: o service_role passa no authorizeMaster (para a sonda), mas não encerra pedido.
  if (auth.via !== "staff" || !auth.userId) {
    return json({ ok: false, mensagem: "Só um usuário master encerra pedido cancelado no fornecedor." }, 403);
  }
  const pedidoId = typeof body.pedido_id === "number" ? body.pedido_id : Number(body.pedido_id);
  const justificativa = typeof body.justificativa === "string" ? body.justificativa.trim() : "";
  if (!Number.isSafeInteger(pedidoId) || pedidoId <= 0) return json({ ok: false, mensagem: "Informe pedido_id." }, 400);
  if (justificativa.length < 10 || justificativa.length > 1000) {
    return json({ ok: false, mensagem: "Escreva uma justificativa (10 a 1000 caracteres): com quem foi confirmado o cancelamento." }, 400);
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const registro = await abrirExecucao(db, auth.userId);
  const base = { versao: VERSAO, pedido_id: pedidoId };
  const responder = async (status: "sucesso" | "erro", corpo: Record<string, unknown>, http = 200) => {
    await fecharExecucao(db, registro, status, { ...base, ...corpo });
    return json({ ...base, ...corpo }, http);
  };

  try {
    const { data, error } = await db.from("pedido_compra_sugerido")
      .select("id, empresa, status, status_envio_portal, portal_protocolo, omie_pedido_compra_id, disparo_claim_em, portal_situacao_codigo, portal_situacao_protocolo")
      .eq("id", pedidoId).maybeSingle();
    if (error) throw new Error(`leitura do pedido: ${error.message}`);
    const pedido = data as PedidoLido | null;
    const previo = motivoRecusaPrevia(pedido);
    if (previo) {
      return await responder("sucesso", {
        ok: false, desfecho: "recusado", motivo: previo, mensagem: mensagemDoMotivo(previo, { protocolo: pedido?.portal_protocolo }),
      });
    }

    const codigo = `AFI-${pedidoId}`;
    const consulta = await consultarOmie(codigo);
    if (consulta.tipo === "existe") {
      return await responder("sucesso", {
        ok: false, desfecho: "recusado", motivo: "po_existe_no_omie", omie_id: consulta.id, omie_numero: consulta.numero,
        mensagem: mensagemDoMotivo("po_existe_no_omie", { numeroPo: consulta.numero || consulta.id }),
      });
    }
    if (consulta.tipo === "indeterminado") {
      // "Não consegui provar" nunca vira "não existe": nada muda (decisão do founder).
      return await responder("erro", {
        ok: false, desfecho: "indeterminado", motivo: "omie_sem_prova", detalhe: consulta.detalhe,
        mensagem: "O Omie não confirmou que não existe pedido de compra com o código deste pedido — nada foi encerrado. " +
          `Tente de novo mais tarde. (${consulta.detalhe.slice(0, 160)})`,
      });
    }

    const prova = { tipo: "ausente", codigo_integracao: codigo, fault: consulta.fault, consultado_em: new Date().toISOString() };
    const { data: rpc, error: errRpc } = await db.rpc("sayerlack_encerrar_cancelado_no_portal", {
      p_pedido_id: pedidoId, p_ator: auth.userId, p_justificativa: justificativa, p_prova_omie: prova, p_execucao_id: registro,
    });
    if (errRpc) throw new Error(`encerramento: ${errRpc.message}`);
    const r = (rpc ?? {}) as { encerrado?: unknown; motivo?: unknown; trilha_id?: unknown; espelho_sync_em?: unknown; protocolo?: unknown };
    if (r.encerrado === true) {
      return await responder("sucesso", {
        ok: true, desfecho: "encerrado", trilha_id: r.trilha_id ?? null, prova_omie: prova,
        mensagem: `Pedido encerrado como cancelado no fornecedor (protocolo ${String(r.protocolo ?? pedido?.portal_protocolo ?? "?")}). ` +
          `O Omie confirmou que não há pedido de compra ${codigo}, e nenhum PO com este protocolo foi encontrado no espelho ` +
          `consultado (sync de pedidos de compra em ${String(r.espelho_sync_em ?? "data desconhecida")}).`,
      });
    }
    if (typeof r.motivo !== "string") throw new Error(`resposta do encerramento sem contrato: ${JSON.stringify(rpc)?.slice(0, 200)}`);
    return await responder("sucesso", {
      ok: false, desfecho: "recusado", motivo: r.motivo, mensagem: mensagemDoMotivo(r.motivo, { protocolo: pedido?.portal_protocolo }),
    });
  } catch (e) {
    const mensagem = mensagemDeErro(e) ?? "erro inesperado";
    return await responder("erro", { ok: false, desfecho: "erro", mensagem: mensagem.slice(0, 600) }, 500);
  }
});
