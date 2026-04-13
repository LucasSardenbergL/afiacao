import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface AccountConfig {
  appKey: string;
  appSecret: string;
  cnpj: string;
  warehouseCode: string;
}

function getAccounts(): AccountConfig[] {
  const accounts: AccountConfig[] = [];

  const obenKey = Deno.env.get("OMIE_VENDAS_APP_KEY");
  const obenSecret = Deno.env.get("OMIE_VENDAS_APP_SECRET");
  const cnpjOben = Deno.env.get("CNPJ_OBEN") || "";
  if (obenKey && obenSecret) {
    accounts.push({ appKey: obenKey, appSecret: obenSecret, cnpj: cnpjOben.replace(/\D/g, ""), warehouseCode: "OB" });
  }

  const colKey = Deno.env.get("OMIE_APP_KEY");
  const colSecret = Deno.env.get("OMIE_APP_SECRET");
  const cnpjCol = Deno.env.get("CNPJ_COLACOR") || "";
  if (colKey && colSecret) {
    accounts.push({ appKey: colKey, appSecret: colSecret, cnpj: cnpjCol.replace(/\D/g, ""), warehouseCode: "CC" });
  }

  return accounts;
}

async function fetchOmieNfes(appKey: string, appSecret: string, page = 1): Promise<any> {
  const resp = await fetch("https://app.omie.com.br/api/v1/produtos/nfe/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      call: "ListarNFe",
      app_key: appKey,
      app_secret: appSecret,
      param: [{
        nPagina: page,
        nRegPorPagina: 50,
        cOperacao: "E", // Entrada (recebimento)
        cStatus: "10",   // NF-es pendentes / aguardando recebimento
      }],
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error(`Omie ListarNFe error ${resp.status}: ${txt}`);
    return null;
  }

  return await resp.json();
}

async function fetchNfeDetail(appKey: string, appSecret: string, nIdNfe: number): Promise<any> {
  const resp = await fetch("https://app.omie.com.br/api/v1/produtos/nfe/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      call: "ConsultarNFe",
      app_key: appKey,
      app_secret: appSecret,
      param: [{ nIdNfe }],
    }),
  });

  if (!resp.ok) return null;
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

    const filterWarehouse = body.warehouse_code || null; // optional filter
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

      console.log(`[sync] Buscando NF-es de entrada para ${acc.warehouseCode}...`);

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
        const result = await fetchOmieNfes(acc.appKey, acc.appSecret, page);
        if (!result) { totalErrors++; break; }

        // Handle Omie error responses
        if (result.faultstring) {
          console.log(`[sync] Omie: ${result.faultstring}`);
          break;
        }

        const nfes = result.nfeListar || result.nfeCadastro || [];
        if (nfes.length === 0) break;

        console.log(`[sync] Página ${page}: ${nfes.length} NF-es encontradas`);

        for (const nfe of nfes) {
          const chaveAcesso = nfe.chNFe || nfe.chave_nfe || "";
          if (!chaveAcesso) { totalSkipped++; continue; }

          // Check if already exists
          const { data: existing } = await supabase
            .from("nfe_recebimentos")
            .select("id")
            .eq("chave_acesso", chaveAcesso)
            .maybeSingle();

          if (existing) { totalSkipped++; continue; }

          // Get detail for items
          const nIdNfe = nfe.nIdNfe || nfe.nIdReceb;
          let detailNfe = nfe;
          if (nIdNfe) {
            const detail = await fetchNfeDetail(acc.appKey, acc.appSecret, nIdNfe);
            if (detail && !detail.faultstring) {
              detailNfe = detail;
            }
          }

          const numeroNfe = String(detailNfe.nNF || detailNfe.numero_nfe || nfe.nNF || "");
          const serieNfe = detailNfe.cSerie || detailNfe.serie || null;
          const cnpjEmitente = (detailNfe.cnpjEmitente || detailNfe.emit?.cnpj || "").replace(/\D/g, "");
          const razaoSocial = detailNfe.razaoSocialEmitente || detailNfe.emit?.razao_social || detailNfe.xNome || null;
          const dataEmissao = detailNfe.dEmi || detailNfe.data_emissao || null;
          const valorTotal = detailNfe.vNF || detailNfe.valor_total || null;
          const xmlCompleto = detailNfe.xml || null;

          // Insert NF-e
          const { data: rec, error: insErr } = await supabase
            .from("nfe_recebimentos")
            .insert({
              warehouse_id: wh.id,
              numero_nfe: numeroNfe,
              serie_nfe: serieNfe,
              chave_acesso: chaveAcesso,
              cnpj_emitente: cnpjEmitente,
              razao_social_emitente: razaoSocial,
              data_emissao: dataEmissao,
              valor_total: valorTotal ? parseFloat(valorTotal) : null,
              xml_completo: xmlCompleto,
              status: "pendente",
              omie_nfe_id: detailNfe.nIdNfe ? parseInt(detailNfe.nIdNfe) : null,
              omie_id_receb: detailNfe.nIdReceb ? parseInt(detailNfe.nIdReceb) : null,
            })
            .select("id")
            .single();

          if (insErr) {
            console.error(`[sync] Erro ao inserir NF-e ${chaveAcesso}:`, insErr.message);
            totalErrors++;
            continue;
          }

          // Parse and insert items
          const rawItems = detailNfe.det || detailNfe.itens || detailNfe.produtos || [];
          if (rawItems.length > 0 && rec) {
            const itens = rawItems.map((item: any, idx: number) => {
              const quantidadeNfe = parseFloat(item.qCom || item.quantidade || item.quantidade_nfe || 0);
              const rounded = Math.round(quantidadeNfe);
              const quantidadeEsperada = Math.abs(quantidadeNfe - rounded) < 0.05 ? rounded : Math.ceil(quantidadeNfe);

              return {
                nfe_recebimento_id: rec.id,
                sequencia: item.nItem || idx + 1,
                codigo_produto: item.cProd || item.codigo_produto || null,
                descricao: item.xProd || item.descricao || "Item sem descrição",
                ncm: item.NCM || item.ncm || null,
                ean: item.cEAN || item.ean || null,
                unidade_nfe: item.uCom || item.unidade || "UN",
                quantidade_nfe: quantidadeNfe,
                valor_unitario: item.vUnCom ? parseFloat(item.vUnCom) : null,
                valor_total: item.vProd ? parseFloat(item.vProd) : null,
                unidade_estoque: null,
                quantidade_convertida: null,
                quantidade_conferida: 0,
                quantidade_esperada: quantidadeEsperada,
                status_item: "pendente",
                produto_omie_id: item.nCodProd ? parseInt(item.nCodProd) : null,
              };
            });

            await supabase.from("nfe_recebimento_itens").insert(itens);
          }

          totalImported++;
          details.push({ numero_nfe: numeroNfe, chave: chaveAcesso.slice(-8), warehouse: acc.warehouseCode });
          console.log(`[sync] NF-e ${numeroNfe} importada (${acc.warehouseCode})`);
        }

        const totalPages = result.nTotPaginas || 1;
        if (page >= totalPages) break;

        // Small delay between pages
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
