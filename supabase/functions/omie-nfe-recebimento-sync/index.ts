import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface AccountConfig {
  appKey: string;
  appSecret: string;
  warehouseCode: string;
}

function getAccounts(): AccountConfig[] {
  const accounts: AccountConfig[] = [];

  const obenKey = Deno.env.get("OMIE_VENDAS_APP_KEY");
  const obenSecret = Deno.env.get("OMIE_VENDAS_APP_SECRET");
  if (obenKey && obenSecret) {
    accounts.push({ appKey: obenKey, appSecret: obenSecret, warehouseCode: "OB" });
  }

  const colKey = Deno.env.get("OMIE_APP_KEY");
  const colSecret = Deno.env.get("OMIE_APP_SECRET");
  if (colKey && colSecret) {
    accounts.push({ appKey: colKey, appSecret: colSecret, warehouseCode: "CC" });
  }

  return accounts;
}

async function fetchOmieRecebimentos(appKey: string, appSecret: string, page = 1): Promise<any> {
  const body = {
    call: "ListarRecebimentos",
    app_key: appKey,
    app_secret: appSecret,
    param: [{
      nPagina: page,
      nRegistrosPorPagina: 50,
    }],
  };
  console.log(`[sync] Chamando Omie ListarRecebimentos, page ${page}`);
  const resp = await fetch("https://app.omie.com.br/api/v1/produtos/recebimentonfe/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const txt = await resp.text();
  console.log(`[sync] Omie response (${resp.status}): ${txt.slice(0, 1000)}`);

  if (!resp.ok) return null;

  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

async function fetchRecebimentoDetail(appKey: string, appSecret: string, nIdReceb: number): Promise<any> {
  const resp = await fetch("https://app.omie.com.br/api/v1/produtos/recebimentonfe/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      call: "ConsultarRecebimento",
      app_key: appKey,
      app_secret: appSecret,
      param: [{ nIdReceb }],
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.log(`[sync] ConsultarRecebimento error (${resp.status}): ${txt.slice(0, 300)}`);
    return null;
  }
  return await resp.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    let body: any = {};
    try { body = await req.json(); } catch { /* empty body ok */ }

    const filterWarehouse = body.warehouse_code || null;
    const accounts = getAccounts();

    if (accounts.length === 0) {
      return new Response(
        JSON.stringify({ error: "Nenhuma credencial Omie configurada" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let totalImported = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    const details: any[] = [];

    for (const acc of accounts) {
      if (filterWarehouse && acc.warehouseCode !== filterWarehouse) continue;

      console.log(`[sync] Buscando recebimentos para ${acc.warehouseCode}...`);

      // Get warehouse ID
      const { data: wh } = await supabase
        .from("warehouses")
        .select("id")
        .eq("code", acc.warehouseCode)
        .single();

      if (!wh) {
        console.error(`[sync] Warehouse ${acc.warehouseCode} não encontrado`);
        totalErrors++;
        continue;
      }

      // Fetch pages (max 3 to respect timeout)
      for (let page = 1; page <= 3; page++) {
        const result = await fetchOmieRecebimentos(acc.appKey, acc.appSecret, page);
        if (!result) { totalErrors++; break; }

        if (result.faultstring) {
          console.log(`[sync] Omie fault: ${result.faultstring}`);
          totalErrors++;
          break;
        }

        // Response: recebimentos array, each with cabec and itensRecebimento
        const recebimentos = result.recebimentos || result.listagemRecebimentos || [];
        if (recebimentos.length === 0) {
          console.log(`[sync] Nenhum recebimento na página ${page}. Keys: ${Object.keys(result).join(', ')}`);
          break;
        }

        console.log(`[sync] Página ${page}: ${recebimentos.length} recebimentos`);

        for (const rec of recebimentos) {
          const cabec = rec.cabec || rec;
          const chaveAcesso = cabec.cChaveNfe || cabec.chNFe || "";
          if (!chaveAcesso) {
            console.log(`[sync] Recebimento sem chave, pulando. nIdReceb=${cabec.nIdReceb}`);
            totalSkipped++;
            continue;
          }

          // Check duplicate
          const { data: existing } = await supabase
            .from("nfe_recebimentos")
            .select("id")
            .eq("chave_acesso", chaveAcesso)
            .maybeSingle();

          if (existing) { totalSkipped++; continue; }

          // Get detail if needed (for items)
          let detailRec = rec;
          const nIdReceb = cabec.nIdReceb;
          if (nIdReceb) {
            const detail = await fetchRecebimentoDetail(acc.appKey, acc.appSecret, nIdReceb);
            if (detail && !detail.faultstring) {
              detailRec = detail;
            }
            // Rate limit delay
            await new Promise(r => setTimeout(r, 300));
          }

          const detailCabec = detailRec.cabec || cabec;
          const numeroNfe = String(detailCabec.cNumeroNFe || detailCabec.nNF || cabec.cNumeroNFe || "");
          const serieNfe = detailCabec.cSerieNFe || detailCabec.serie || null;
          const cnpjEmitente = (detailCabec.cCNPJ_CPF || detailCabec.cnpjEmitente || "").replace(/\D/g, "");
          const razaoSocial = detailCabec.cRazaoSocial || detailCabec.cNome || null;
          const dataEmissao = detailCabec.dEmissaoNFe || detailCabec.dEmi || null;
          const valorTotal = detailCabec.nValorNFe || detailCabec.vNF || null;
          const etapa = detailCabec.cEtapa || "";

          // Insert NF-e
          const { data: nfeRec, error: insErr } = await supabase
            .from("nfe_recebimentos")
            .insert({
              warehouse_id: wh.id,
              numero_nfe: numeroNfe,
              serie_nfe: serieNfe,
              chave_acesso: chaveAcesso,
              cnpj_emitente: cnpjEmitente,
              razao_social_emitente: razaoSocial,
              data_emissao: dataEmissao,
              valor_total: valorTotal ? parseFloat(String(valorTotal)) : null,
              status: "pendente",
              omie_nfe_id: null,
              omie_id_receb: nIdReceb ? parseInt(String(nIdReceb)) : null,
            })
            .select("id")
            .single();

          if (insErr) {
            console.error(`[sync] Erro ao inserir NF-e ${chaveAcesso}:`, insErr.message);
            totalErrors++;
            continue;
          }

          // Parse items from detail
          const rawItems = detailRec.itensRecebimento || detailRec.itens || [];
          if (rawItems.length > 0 && nfeRec) {
            const itens = rawItems.map((item: any, idx: number) => {
              const itemCabec = item.itensCabec || item;
              const quantidadeNfe = parseFloat(itemCabec.nQtdeNFe || itemCabec.qCom || itemCabec.quantidade || 0);
              const rounded = Math.round(quantidadeNfe);
              const quantidadeEsperada = Math.abs(quantidadeNfe - rounded) < 0.05 ? rounded : Math.ceil(quantidadeNfe);

              return {
                nfe_recebimento_id: nfeRec.id,
                sequencia: itemCabec.nSequencia || itemCabec.nItem || idx + 1,
                codigo_produto: itemCabec.cCodigoProduto || itemCabec.cProd || null,
                descricao: itemCabec.cDescricaoProduto || itemCabec.xProd || "Item sem descrição",
                ncm: itemCabec.cNCM || itemCabec.ncm || null,
                ean: itemCabec.cEAN || itemCabec.ean || null,
                unidade_nfe: itemCabec.cUnidadeNfe || itemCabec.uCom || "UN",
                quantidade_nfe: quantidadeNfe,
                valor_unitario: itemCabec.nPrecoUnit ? parseFloat(String(itemCabec.nPrecoUnit)) : null,
                valor_total: itemCabec.vTotalItem ? parseFloat(String(itemCabec.vTotalItem)) : null,
                unidade_estoque: null,
                quantidade_convertida: null,
                quantidade_conferida: 0,
                quantidade_esperada: quantidadeEsperada,
                status_item: "pendente",
                produto_omie_id: itemCabec.nIdProduto ? parseInt(String(itemCabec.nIdProduto)) : null,
              };
            });

            const { error: itensErr } = await supabase.from("nfe_recebimento_itens").insert(itens);
            if (itensErr) {
              console.error(`[sync] Erro ao inserir itens da NF-e ${numeroNfe}:`, itensErr.message);
            }
          }

          totalImported++;
          details.push({ numero_nfe: numeroNfe, fornecedor: razaoSocial, etapa, warehouse: acc.warehouseCode });
          console.log(`[sync] NF-e ${numeroNfe} importada (${acc.warehouseCode}), etapa: ${etapa}`);
        }

        const totalPages = result.nTotPaginas || 1;
        if (page >= totalPages) break;

        await new Promise(r => setTimeout(r, 500));
      }
    }

    console.log(`[sync] Resumo: ${totalImported} importadas, ${totalSkipped} já existentes, ${totalErrors} erros`);

    return new Response(
      JSON.stringify({ imported: totalImported, skipped: totalSkipped, errors: totalErrors, details }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("[sync] Erro:", err);
    return new Response(
      JSON.stringify({ error: err.message || "Erro interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
