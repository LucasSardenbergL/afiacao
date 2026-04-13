import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const payload = await req.json();
    console.log("[omie-nfe-webhook] Payload recebido:", JSON.stringify(payload).slice(0, 500));

    // ── Extract NF-e fields from Omie payload ──
    const chaveAcesso: string | undefined =
      payload.chave_acesso ?? payload.chNFe ?? payload.nfe?.chave_acesso ?? payload.nfe?.chNFe;

    if (!chaveAcesso) {
      console.error("[omie-nfe-webhook] chave_acesso ausente no payload");
      return jsonResponse({ error: "chave_acesso ausente no payload" }, 400);
    }

    // ── Duplicate check ──
    const { data: existing } = await supabase
      .from("nfe_recebimentos")
      .select("id")
      .eq("chave_acesso", chaveAcesso)
      .maybeSingle();

    if (existing) {
      console.log("[omie-nfe-webhook] NF-e já importada:", chaveAcesso);
      return jsonResponse({ message: "já importada", id: existing.id });
    }

    // ── Parse header fields ──
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

    // CNPJ destinatário (para determinar o warehouse)
    const cnpjDestinatario: string =
      nfe.cnpj_destinatario ?? nfe.cnpjDestinatario ?? nfe.dest?.cnpj ?? "";

    // ── Determine warehouse ──
    const cnpjOben = (Deno.env.get("CNPJ_OBEN") ?? "").replace(/\D/g, "");
    const cnpjColacor = (Deno.env.get("CNPJ_COLACOR") ?? "").replace(/\D/g, "");
    const cnpjDestClean = cnpjDestinatario.replace(/\D/g, "");

    let warehouseCode = "OB"; // default
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

    // ── Parse items ──
    const rawItems: any[] =
      nfe.itens ?? nfe.items ?? nfe.det ?? nfe.produtos ?? [];

    const itensToInsert = rawItems.map((item: any, idx: number) => {
      const codigoProduto = item.codigo_produto ?? item.cProd ?? item.codigo ?? null;
      const descricao = item.descricao ?? item.xProd ?? item.desc ?? "Item sem descrição";
      const ncm = item.ncm ?? item.NCM ?? null;
      const ean = item.ean ?? item.cEAN ?? null;
      const unidadeNfe = item.unidade_nfe ?? item.uCom ?? item.unidade ?? "UN";
      const quantidadeNfe = parseFloat(item.quantidade_nfe ?? item.qCom ?? item.quantidade ?? 0);
      const valorUnitario = item.valor_unitario ?? item.vUnCom ?? item.preco ?? null;
      const valorTotalItem = item.valor_total ?? item.vProd ?? null;
      const produtoOmieId = item.produto_omie_id ?? item.nCodProd ?? null;

      // Smart rounding: fix floating-point noise from Omie/XML parsing
      const rounded = Math.round(quantidadeNfe);
      const quantidadeEsperada = Math.abs(quantidadeNfe - rounded) < 0.05
        ? rounded
        : Math.ceil(quantidadeNfe);

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
        quantidade_conferida: 0,
        quantidade_esperada: quantidadeEsperada,
        status_item: "pendente",
        produto_omie_id: produtoOmieId ? parseInt(produtoOmieId) : null,
      };
    });

    // ── Insert NF-e header ──
    const { data: recebimento, error: insErr } = await supabase
      .from("nfe_recebimentos")
      .insert({
        warehouse_id: warehouse.id,
        numero_nfe: numeroNfe,
        serie_nfe: serieNfe,
        chave_acesso: chaveAcesso,
        cnpj_emitente: cnpjEmClean,
        razao_social_emitente: razaoSocial,
        data_emissao: dataEmissao,
        valor_total: valorTotal ? parseFloat(valorTotal) : null,
        xml_completo: xmlCompleto,
        status: "pendente",
        omie_nfe_id: omieNfeId ? parseInt(omieNfeId) : null,
        omie_id_receb: omieIdReceb ? parseInt(omieIdReceb) : null,
      })
      .select("id")
      .single();

    if (insErr || !recebimento) {
      console.error("[omie-nfe-webhook] Erro ao inserir nfe_recebimentos:", insErr);
      return jsonResponse({ error: "Erro ao inserir NF-e", details: insErr?.message }, 500);
    }

    // ── Insert items ──
    if (itensToInsert.length > 0) {
      const itensComNfeId = itensToInsert.map((item) => ({
        ...item,
        nfe_recebimento_id: recebimento.id,
      }));

      const { error: itensErr } = await supabase
        .from("nfe_recebimento_itens")
        .insert(itensComNfeId);

      if (itensErr) {
        console.error("[omie-nfe-webhook] Erro ao inserir itens:", itensErr);
        return jsonResponse({
          error: "NF-e criada mas erro ao inserir itens",
          nfe_recebimento_id: recebimento.id,
          details: itensErr.message,
        }, 500);
      }
    }

    console.log(
      `[omie-nfe-webhook] NF-e ${numeroNfe} importada com sucesso. ID: ${recebimento.id}, ${itensToInsert.length} itens.`,
    );

    return jsonResponse({
      success: true,
      nfe_recebimento_id: recebimento.id,
      itens_count: itensToInsert.length,
    });
  } catch (err) {
    console.error("[omie-nfe-webhook] Erro inesperado:", err);
    return jsonResponse({ error: "Erro interno", details: String(err) }, 500);
  }
});
