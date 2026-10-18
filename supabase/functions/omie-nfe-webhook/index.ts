import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";
import { type ClienteRpc, importarViaRpc, registrarFalhaImportacao } from "../_shared/nfe-importacao.ts";
import { responderDesfecho } from "./resposta.ts";
// `normalizarNcm` mora na sync porque o incidente (NCM pontuado estourando `varchar(8)`, 22001 no
// lote inteiro, 2026-09-26) foi medido lá; o webhook grava a MESMA coluna com o MESMO dado do Omie.
// Erro determinístico no lote é o pior caso do retry: repete a mesma falha para sempre.
import { normalizarNcm } from "../omie-nfe-recebimento-sync/itens.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-webhook-secret",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  // `versao` em TODA resposta (sucesso e erro), não só na da sonda: a pergunta "essa correção
  // subiu?" quase sempre é feita sobre um recebimento que JÁ entrou — e o caso que mais importa
  // é o da importação que morreu no meio, deixando cabeçalho sem itens.
  return new Response(JSON.stringify({ ...body, versao: VERSAO }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Smart rounding: if qty is within 5% of nearest integer, round it */
function smartRound(qty: number): number {
  const rounded = Math.round(qty);
  return Math.abs(qty - rounded) < 0.05 ? rounded : Math.ceil(qty);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // ⚠️ SONDA DE VERSÃO — antes de tudo, porque daqui pra frente a edge MATERIALIZA o recebimento
  // no nosso banco (RPC `importar_nfe_recebimento`: cabeçalho + itens numa transação).
  //
  // Duas diferenças em relação às edges cujo gate já aceita cron-secret, ambas deliberadas:
  //  1. o corpo é consumido AQUI (req.json() é one-shot) e reaproveitado no fluxo real abaixo;
  //  2. a sonda tem gate PRÓPRIO (`authorizeCronOrStaff`) em vez de esperar o gate desta edge.
  //     O gate daqui é `x-webhook-secret`, o segredo compartilhado com o Omie (que não emite JWT),
  //     e não aceita `x-cron-secret` — mas é pelo SQL Editor, com cron-secret, que a sonda é
  //     invocada em produção; atrás dele ela seria inalcançável para quem precisa dela. Nenhum
  //     caminho fica sem auth, e o FLUXO REAL continua exigindo o webhook-secret logo abaixo.
  // O custo é pago só quando `probe` vem no corpo: sem a chave, nada disto executa.
  // Ver versao.ts / _shared/sonda-versao.ts.
  // Sem anotação de propósito: `req.json()` devolve `any`, e é esse o tipo que os acessos com
  // alias abaixo (chNFe/chave_acesso, det/itens, emit?.cnpj) sempre tiveram. Anotar
  // `Record<string, any>` reprova no ESLint (no-explicit-any); anotar `unknown` quebraria os
  // acessos aninhados e viraria dívida no edges:typecheck. Instrumentar não é hora de retipar.
  let corpoBruto;
  try {
    corpoBruto = await req.json();
  } catch {
    corpoBruto = {};
  }
  const decisaoSonda = classificarSonda(corpoBruto);
  if (decisaoSonda.tipo !== "disparo") {
    const authSonda = await authorizeCronOrStaff(req);
    if (!authSonda.ok) return authSonda.response;
    if (decisaoSonda.tipo === "sonda") return jsonResponse(respostaSonda(VERSAO), 200);
    return jsonResponse({ error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }, 400);
  }

  // Shared-secret webhook auth (Omie cannot send a JWT).
  const expectedSecret = Deno.env.get("OMIE_WEBHOOK_SECRET");
  const providedSecret = req.headers.get("x-webhook-secret");
  if (!expectedSecret || !providedSecret || !timingSafeEq(expectedSecret, providedSecret)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    // Corpo já consumido no bloco da sonda acima (req.json() é one-shot). Não-objeto vira {} —
    // cai no 400 de "chave_acesso ausente", como antes.
    const payload = typeof corpoBruto === "object" && corpoBruto !== null &&
        !Array.isArray(corpoBruto)
      ? corpoBruto
      : {};
    // Só os NOMES dos campos: o payload da NF-e traz CPF/CNPJ, nome e endereço do destinatário (M-36,
    // LGPD) — o log da edge não é lugar de dado pessoal.
    console.log("[omie-nfe-webhook] Payload recebido, campos:", Object.keys(payload).join(","));

    const chaveAcesso: string | undefined =
      payload.chave_acesso ?? payload.chNFe ?? payload.nfe?.chave_acesso ?? payload.nfe?.chNFe;

    if (!chaveAcesso) {
      console.error("[omie-nfe-webhook] chave_acesso ausente no payload");
      return jsonResponse({ error: "chave_acesso ausente no payload" }, 400);
    }

    // O guard de duplicata vive na RPC `importar_nfe_recebimento` (SQL, com lock por chave): ela lê
    // o cabeçalho COM os itens e completa um recebimento `pendente` que ficou sem itens — o reenvio
    // do Omie é o que conserta a importação que morreu no meio, em vez de escondê-la.

    // Parse header fields
    const nfe = payload.nfe ?? payload;
    const numeroNfe = String(nfe.numero_nfe ?? nfe.nNF ?? nfe.numero ?? "");
    const serieNfe = nfe.serie_nfe ?? nfe.serie ?? nfe.cSerie ?? null;
    const cnpjEmitente: string = nfe.cnpj_emitente ?? nfe.cnpjEmitente ?? nfe.emit?.cnpj ?? "";
    const razaoSocial = nfe.razao_social_emitente ?? nfe.razao_social ?? nfe.emit?.razao_social ?? null;
    const dataEmissao = nfe.data_emissao ?? nfe.dEmi ?? null;
    const valorTotal = nfe.valor_total ?? nfe.vNF ?? null;
    const xmlCompleto = nfe.xml ?? nfe.xml_completo ?? null;
    const omieNfeId = nfe.omie_nfe_id ?? nfe.nIdNfe ?? null;
    const omieIdReceb = nfe.omie_id_receb ?? nfe.nIdReceb ?? null;

    const cnpjDestinatario: string =
      nfe.cnpj_destinatario ?? nfe.cnpjDestinatario ?? nfe.dest?.cnpj ?? "";

    // Determine warehouse
    const cnpjOben = (Deno.env.get("CNPJ_OBEN") ?? "").replace(/\D/g, "");
    const cnpjColacor = (Deno.env.get("CNPJ_COLACOR") ?? "").replace(/\D/g, "");
    const cnpjDestClean = cnpjDestinatario.replace(/\D/g, "");

    let warehouseCode = "OB";
    if (cnpjDestClean && cnpjDestClean === cnpjColacor) {
      warehouseCode = "CC";
    } else if (cnpjDestClean && cnpjDestClean === cnpjOben) {
      warehouseCode = "OB";
    }

    const { data: warehouse, error: whErr } = await supabase
      .from("warehouses")
      .select("id")
      .eq("code", warehouseCode)
      .single();

    if (whErr || !warehouse) {
      console.error("[omie-nfe-webhook] Warehouse não encontrado:", warehouseCode, whErr);
      return jsonResponse({ error: "Warehouse não encontrado" }, 500);
    }

    // Parse items — NO conversion table, smart rounding only
    const rawItems: Record<string, unknown>[] =
      nfe.itens ?? nfe.items ?? nfe.det ?? nfe.produtos ?? [];

    const cnpjEmClean = cnpjEmitente.replace(/\D/g, "");

    const itensToInsert = rawItems.map((item: Record<string, unknown>, idx: number) => {
      const codigoProduto = item.codigo_produto ?? item.cProd ?? item.codigo ?? null;
      const descricao = item.descricao ?? item.xProd ?? item.desc ?? "Item sem descrição";
      const ncmBruto = item.ncm ?? item.NCM ?? null;
      const ncm = normalizarNcm(ncmBruto == null ? null : String(ncmBruto));
      const ean = item.ean ?? item.cEAN ?? null;
      const unidadeNfe = item.unidade_nfe ?? item.uCom ?? item.unidade ?? "UN";
      const quantidadeNfe = parseFloat(item.quantidade_nfe ?? item.qCom ?? item.quantidade ?? 0);
      const valorUnitario = item.valor_unitario ?? item.vUnCom ?? item.preco ?? null;
      const valorTotalItem = item.valor_total ?? item.vProd ?? null;
      const produtoOmieId = item.produto_omie_id ?? item.nCodProd ?? null;

      const quantidadeEsperada = smartRound(quantidadeNfe);

      return {
        sequencia: item.sequencia ?? item.nItem ?? idx + 1,
        codigo_produto: codigoProduto,
        descricao,
        ncm,
        ean,
        unidade_nfe: unidadeNfe,
        quantidade_nfe: quantidadeNfe,
        valor_unitario: valorUnitario ? parseFloat(valorUnitario) : null,
        valor_total: valorTotalItem ? parseFloat(valorTotalItem) : null,
        unidade_estoque: null,
        quantidade_convertida: null,
        quantidade_esperada: quantidadeEsperada,
        produto_omie_id: produtoOmieId ? parseInt(produtoOmieId) : null,
      };
    });

    const cabecalho = {
      warehouse_id: warehouse.id,
      numero_nfe: numeroNfe,
      serie_nfe: serieNfe,
      chave_acesso: chaveAcesso,
      cnpj_emitente: cnpjEmClean,
      razao_social_emitente: razaoSocial,
      data_emissao: dataEmissao,
      valor_total: valorTotal ? parseFloat(valorTotal) : null,
      xml_completo: xmlCompleto,
      omie_nfe_id: omieNfeId ? parseInt(omieNfeId) : null,
      omie_id_receb: omieIdReceb ? parseInt(omieIdReceb) : null,
    };

    // UMA chamada, UMA transação: cabeçalho + itens entram juntos ou nada entra (2 pareceres Codex
    // 2026-10-18; prova em db/test-importar-nfe-recebimento.sh). Sem fallback para o caminho antigo
    // de 2 requisições: RPC ausente é 500 nomeando a migration (deploy fora de ordem), não silêncio.
    const cliente = supabase as unknown as ClienteRpc;
    const desfecho = await importarViaRpc(cliente, { cabecalho, itens: itensToInsert, origem: "webhook" });
    // Erro de DADO (NFE0x, tipo que não cabe) tem registro DURÁVEL fora da transação abortada: o
    // Omie tenta 3× e manda à DLQ; "log alto" sozinho não é recuperação.
    const tentativas = desfecho.tipo === "erro"
      ? await registrarFalhaImportacao(cliente, {
        chaveAcesso: chaveAcesso,
        origem: "webhook",
        erro: desfecho,
        warehouseId: warehouse.id,
        omieIdReceb: cabecalho.omie_id_receb,
      })
      : null;
    const resposta = responderDesfecho(desfecho, chaveAcesso, tentativas);
    console[resposta.log.nivel](`[omie-nfe-webhook] NF-e ${numeroNfe}: ${resposta.log.texto}`);
    return jsonResponse(resposta.corpo, resposta.status);
  } catch (err) {
    console.error("[omie-nfe-webhook] Erro inesperado:", err);
    return jsonResponse({ error: "Erro interno", details: String(err) }, 500);
  }
});
