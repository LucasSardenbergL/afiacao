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

function smartRound(qty: number): number {
  const rounded = Math.round(qty);
  return Math.abs(qty - rounded) < 0.05 ? rounded : Math.ceil(qty);
}

interface OmieCredentials {
  appKey: string;
  appSecret: string;
  warehouseCode: string;
}

function getCredentials(): OmieCredentials[] {
  const creds: OmieCredentials[] = [];

  const obenKey = Deno.env.get("OMIE_VENDAS_APP_KEY");
  const obenSecret = Deno.env.get("OMIE_VENDAS_APP_SECRET");
  if (obenKey && obenSecret) {
    creds.push({ appKey: obenKey, appSecret: obenSecret, warehouseCode: "OB" });
  }

  const colacorKey = Deno.env.get("OMIE_APP_KEY");
  const colacorSecret = Deno.env.get("OMIE_APP_SECRET");
  if (colacorKey && colacorSecret) {
    creds.push({ appKey: colacorKey, appSecret: colacorSecret, warehouseCode: "CC" });
  }

  return creds;
}

async function omieCall(appKey: string, appSecret: string, endpoint: string, method: string, params: any) {
  const res = await fetch(`https://app.omie.com.br/api/v1/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      call: method,
      app_key: appKey,
      app_secret: appSecret,
      param: [params],
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Omie ${method} HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }
  return await res.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const allCreds = getCredentials();
  if (allCreds.length === 0) {
    return jsonResponse({ error: "Nenhuma credencial Omie configurada" }, 500);
  }

  let totalImported = 0;
  let totalSkipped = 0;
  const errors: string[] = [];

  for (const cred of allCreds) {
    try {
      console.log(`[sync] Buscando recebimentos no Omie para warehouse ${cred.warehouseCode}...`);

      // Get warehouse ID
      const { data: warehouse } = await supabase
        .from("warehouses")
        .select("id")
        .eq("code", cred.warehouseCode)
        .maybeSingle();

      if (!warehouse) {
        console.log(`[sync] Warehouse ${cred.warehouseCode} não encontrado, pulando`);
        continue;
      }

      // List pending recebimentos from Omie (paginated, max 3 pages to avoid timeout)
      let page = 1;
      const maxPages = 3;
      let hasMore = true;

      while (hasMore && page <= maxPages) {
        const listResult = await omieCall(
          cred.appKey,
          cred.appSecret,
          "produtos/recebimentonfe/",
          "ListarRecebimentos",
          {
            nPagina: page,
            nRegPorPagina: 50,
            cStatus: "010", // Pendentes
          },
        );

        const recebimentos = listResult.recebimentos ?? listResult.cadastros ?? [];
        const totalPages = listResult.nTotPaginas ?? 1;
        console.log(`[sync] Página ${page}/${totalPages}, ${recebimentos.length} registros`);

        for (const rec of recebimentos) {
          try {
            const nIdReceb = rec.nIdReceb ?? rec.nId;
            if (!nIdReceb) continue;

            // Fetch detail to get chave_acesso and items
            let detail: any;
            try {
              detail = await omieCall(
                cred.appKey,
                cred.appSecret,
                "produtos/recebimentonfe/",
                "ConsultarRecebimento",
                { nIdReceb },
              );
            } catch (detErr: any) {
              console.warn(`[sync] Erro ao consultar recebimento ${nIdReceb}: ${detErr.message}`);
              continue;
            }

            const chaveAcesso = detail.cChaveNfe ?? detail.chave_acesso ?? detail.cChNFe ?? null;
            if (!chaveAcesso) {
              console.log(`[sync] Recebimento ${nIdReceb} sem chave de acesso, pulando`);
              continue;
            }

            // Check if already exists
            const { data: existing } = await supabase
              .from("nfe_recebimentos")
              .select("id")
              .eq("chave_acesso", chaveAcesso)
              .maybeSingle();

            if (existing) {
              totalSkipped++;
              continue;
            }

            // Parse NF-e data from detail
            const numeroNfe = String(detail.cNumeroNfe ?? detail.nNF ?? detail.numero_nfe ?? "");
            const serieNfe = detail.cSerieNfe ?? detail.serie ?? null;
            const cnpjEmitente = (detail.cCnpjEmitente ?? detail.cnpj_emitente ?? "").replace(/\D/g, "");
            const razaoSocial = detail.cRazaoSocialEmitente ?? detail.razao_social ?? null;
            const dataEmissao = detail.dDataEmissao ?? detail.data_emissao ?? null;
            const valorTotal = detail.nValorTotal ?? detail.valor_total ?? null;
            const omieNfeId = detail.nIdNfe ?? null;

            // Insert NF-e header
            const { data: newNfe, error: insErr } = await supabase
              .from("nfe_recebimentos")
              .insert({
                warehouse_id: warehouse.id,
                numero_nfe: numeroNfe,
                serie_nfe: serieNfe,
                chave_acesso: chaveAcesso,
                cnpj_emitente: cnpjEmitente,
                razao_social_emitente: razaoSocial,
                data_emissao: dataEmissao,
                valor_total: valorTotal ? parseFloat(valorTotal) : null,
                status: "pendente",
                omie_nfe_id: omieNfeId ? parseInt(omieNfeId) : null,
                omie_id_receb: parseInt(nIdReceb),
              })
              .select("id")
              .single();

            if (insErr || !newNfe) {
              console.error(`[sync] Erro ao inserir NF-e ${chaveAcesso}:`, insErr);
              errors.push(`NF-e ${numeroNfe}: ${insErr?.message}`);
              continue;
            }

            // Parse and insert items
            const rawItems = detail.itens ?? detail.produtos ?? detail.det ?? [];
            if (rawItems.length > 0) {
              const itens = rawItems.map((item: any, idx: number) => {
                const quantidadeNfe = parseFloat(item.nQuantidade ?? item.qCom ?? item.quantidade ?? 0);
                return {
                  nfe_recebimento_id: newNfe.id,
                  sequencia: item.nSequencia ?? item.nItem ?? idx + 1,
                  codigo_produto: item.cCodigo ?? item.cProd ?? null,
                  descricao: item.cDescricao ?? item.xProd ?? "Item",
                  ncm: item.cNCM ?? item.ncm ?? null,
                  unidade_nfe: item.cUnidade ?? item.uCom ?? "UN",
                  quantidade_nfe: quantidadeNfe,
                  valor_unitario: item.nValorUnitario ? parseFloat(item.nValorUnitario) : null,
                  valor_total: item.nValorTotal ? parseFloat(item.nValorTotal) : null,
                  unidade_estoque: null,
                  quantidade_convertida: null,
                  quantidade_conferida: 0,
                  quantidade_esperada: smartRound(quantidadeNfe),
                  status_item: "pendente",
                  produto_omie_id: item.nCodProduto ? parseInt(item.nCodProduto) : null,
                };
              });

              const { error: itensErr } = await supabase
                .from("nfe_recebimento_itens")
                .insert(itens);

              if (itensErr) {
                console.error(`[sync] Erro ao inserir itens da NF-e ${numeroNfe}:`, itensErr);
              }
            }

            totalImported++;
            console.log(`[sync] NF-e ${numeroNfe} importada (${rawItems.length} itens)`);
          } catch (recErr: any) {
            console.error(`[sync] Erro processando recebimento:`, recErr);
            errors.push(recErr.message);
          }
        }

        hasMore = page < totalPages;
        page++;
      }
    } catch (credErr: any) {
      console.error(`[sync] Erro na conta ${cred.warehouseCode}:`, credErr);
      errors.push(`${cred.warehouseCode}: ${credErr.message}`);
    }
  }

  console.log(`[sync] Concluído: ${totalImported} importadas, ${totalSkipped} já existentes, ${errors.length} erros`);

  return jsonResponse({
    success: true,
    imported: totalImported,
    skipped: totalSkipped,
    errors: errors.length > 0 ? errors : undefined,
  });
});
