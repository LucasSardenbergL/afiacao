import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function jsonRes(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── Retry with exponential backoff ──
async function omieCall(
  url: string,
  payload: Record<string, unknown>,
  maxRetries = 3,
): Promise<any> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
      if (!res.ok) {
        // Omie returns 500 for many transient errors
        if (attempt < maxRetries && res.status >= 500) {
          const delay = Math.pow(2, attempt) * 500;
          console.warn(`[omie-nfe-recebimento] Omie ${res.status}, retry ${attempt}/${maxRetries} in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        return { error: true, status: res.status, data };
      }
      return { error: false, data };
    } catch (err) {
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 500;
        console.warn(`[omie-nfe-recebimento] Network error, retry ${attempt}/${maxRetries} in ${delay}ms:`, err);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return { error: true, data: { message: String(err) } };
    }
  }
}

function formatDateBR(isoDate: string | null): string | null {
  if (!isoDate) return null;
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return null;
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

// ── Credential mapping by warehouse code ──
function getOmieCredentials(warehouseCode: string): { appKey: string; appSecret: string } {
  if (warehouseCode === "CC") {
    // CC = Colacor SC (afiação)
    return {
      appKey: Deno.env.get("OMIE_COLACOR_SC_APP_KEY") ?? "",
      appSecret: Deno.env.get("OMIE_COLACOR_SC_APP_SECRET") ?? "",
    };
  }
  // OB (Oben) - default
  return {
    appKey: Deno.env.get("OMIE_OBEN_APP_KEY") ?? "",
    appSecret: Deno.env.get("OMIE_OBEN_APP_SECRET") ?? "",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonRes({ error: "Method not allowed" }, 405);
  }

  // ── Auth check ──
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonRes({ error: "Unauthorized" }, 401);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const supabaseAuth = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const token = authHeader.replace("Bearer ", "");
  const { data: claimsData, error: claimsErr } = await supabaseAuth.auth.getClaims(token);
  if (claimsErr || !claimsData?.claims) {
    return jsonRes({ error: "Unauthorized" }, 401);
  }

  try {
    const body = await req.json();
    const nfeRecebimentoId: string = body.nfe_recebimento_id;
    if (!nfeRecebimentoId) {
      return jsonRes({ error: "nfe_recebimento_id obrigatório" }, 400);
    }

    console.log(`[omie-nfe-recebimento] Iniciando efetivação: ${nfeRecebimentoId}`);

    // ── 1. Fetch NF-e with warehouse ──
    const { data: nfe, error: nfeErr } = await supabase
      .from("nfe_recebimentos")
      .select("*, warehouses(id, code, name)")
      .eq("id", nfeRecebimentoId)
      .single();

    if (nfeErr || !nfe) {
      console.error("[omie-nfe-recebimento] NF-e não encontrada:", nfeErr);
      return jsonRes({ error: "NF-e não encontrada" }, 404);
    }

    if (nfe.status !== "conferido") {
      return jsonRes({ error: `Status inválido: ${nfe.status}. Esperado: conferido` }, 400);
    }

    if (!nfe.omie_id_receb) {
      return jsonRes({ error: "omie_id_receb ausente — NF-e não importada pelo Omie" }, 400);
    }

    const warehouseCode = (nfe.warehouses as any)?.code ?? "OB";
    const creds = getOmieCredentials(warehouseCode);

    if (!creds.appKey || !creds.appSecret) {
      return jsonRes({ error: `Credenciais Omie não configuradas para warehouse ${warehouseCode}` }, 500);
    }

    // ── Fetch items ──
    const { data: itens } = await supabase
      .from("nfe_recebimento_itens")
      .select("*")
      .eq("nfe_recebimento_id", nfeRecebimentoId)
      .order("sequencia");

    // ── Fetch all scanned lots ──
    const itemIds = (itens ?? []).map((i: any) => i.id);
    let lotes: any[] = [];
    if (itemIds.length > 0) {
      const { data: lotesData } = await supabase
        .from("nfe_lotes_escaneados")
        .select("*")
        .in("nfe_recebimento_item_id", itemIds);
      lotes = lotesData ?? [];
    }

    // ── 2. Aggregate lots per item ──
    const lotesPerItem = new Map<string, Map<string, { count: number; fab: string | null; val: string | null }>>();
    for (const l of lotes) {
      if (!lotesPerItem.has(l.nfe_recebimento_item_id)) {
        lotesPerItem.set(l.nfe_recebimento_item_id, new Map());
      }
      const itemLotes = lotesPerItem.get(l.nfe_recebimento_item_id)!;
      if (!itemLotes.has(l.numero_lote)) {
        itemLotes.set(l.numero_lote, { count: 0, fab: l.data_fabricacao, val: l.data_validade });
      }
      const entry = itemLotes.get(l.numero_lote)!;
      entry.count++;
      // Keep most recent dates if they differ
      if (l.data_fabricacao) entry.fab = l.data_fabricacao;
      if (l.data_validade) entry.val = l.data_validade;
    }

    function buildLoteValidade(itemId: string): any[] {
      const map = lotesPerItem.get(itemId);
      if (!map) return [];
      return Array.from(map.entries()).map(([lote, info]) => ({
        cNumLote: lote,
        nQtdLote: info.count,
        dDataFab: formatDateBR(info.fab) ?? "",
        dDataVal: formatDateBR(info.val) ?? "",
      }));
    }

    const results: any[] = [];

    // ── 3. Check if supplier has unit conversions (Sayerlack case) ──
    const cnpjEmClean = (nfe.cnpj_emitente ?? "").replace(/\D/g, "");
    const { data: conversoes } = await supabase
      .from("conversao_unidades")
      .select("codigo_produto_fornecedor")
      .eq("cnpj_fornecedor", cnpjEmClean)
      .eq("is_active", true)
      .limit(1);

    const hasConversion = (conversoes ?? []).length > 0;

    // ── 4. AlterarRecebimento — efetivar NF-e no Omie ──
    const recebItens = (itens ?? []).map((item: any) => ({
      nItem: item.sequencia,
      nCodProd: item.produto_omie_id,
      lote_validade: buildLoteValidade(item.id),
    }));

    const alterarPayload = {
      call: "AlterarRecebimento",
      app_key: creds.appKey,
      app_secret: creds.appSecret,
      param: [
        {
          nIdReceb: nfe.omie_id_receb,
          cabecalho: {},
          det: recebItens,
        },
      ],
    };

    console.log("[omie-nfe-recebimento] Chamando AlterarRecebimento...");
    const alterarRes = await omieCall(
      "https://app.omie.com.br/api/v1/produtos/recebimentonfe/",
      alterarPayload,
    );
    results.push({ step: "AlterarRecebimento", ...alterarRes });

    if (alterarRes.error) {
      console.error("[omie-nfe-recebimento] Erro no AlterarRecebimento:", alterarRes.data);
      // Continue anyway to try stock adjustments if needed
    } else {
      console.log("[omie-nfe-recebimento] AlterarRecebimento OK");
    }

    // ── 5. Stock adjustments for converted items (Sayerlack) ──
    if (hasConversion) {
      console.log("[omie-nfe-recebimento] Fornecedor com conversão — ajustando estoque...");
      for (const item of (itens ?? [])) {
        if (item.quantidade_convertida && item.produto_omie_id) {
          const loteVal = buildLoteValidade(item.id);
          const ajustePayload = {
            call: "IncluirAjusteEstoque",
            app_key: creds.appKey,
            app_secret: creds.appSecret,
            param: [
              {
                id_prod: item.produto_omie_id,
                codigo: "",
                qtde: item.quantidade_convertida,
                tipo: "ENT",
                obs: `Entrada NF-e ${nfe.numero_nfe} - conversão de ${item.quantidade_nfe} ${item.unidade_nfe} para ${item.quantidade_convertida} ${item.unidade_estoque}`,
                lote_validade: loteVal,
              },
            ],
          };

          console.log(`[omie-nfe-recebimento] Ajuste estoque item ${item.sequencia}, prod ${item.produto_omie_id}, qtd ${item.quantidade_convertida}`);
          const ajusteRes = await omieCall(
            "https://app.omie.com.br/api/v1/estoque/ajuste/",
            ajustePayload,
          );
          results.push({ step: `AjusteEstoque_item_${item.sequencia}`, ...ajusteRes });

          if (ajusteRes.error) {
            console.error(`[omie-nfe-recebimento] Erro ajuste estoque item ${item.sequencia}:`, ajusteRes.data);
          }
        }
      }
    }

    // ── 6. Import associated CT-es ──
    const { data: ctes } = await supabase
      .from("cte_associados")
      .select("*")
      .eq("nfe_recebimento_id", nfeRecebimentoId)
      .eq("status", "pendente");

    for (const cte of (ctes ?? [])) {
      if (!cte.xml_cte) {
        console.warn(`[omie-nfe-recebimento] CT-e ${cte.id} sem XML, pulando`);
        continue;
      }

      const importPayload = {
        call: "ImportarNFe",
        app_key: creds.appKey,
        app_secret: creds.appSecret,
        param: [{ cXML: cte.xml_cte }],
      };

      console.log(`[omie-nfe-recebimento] Importando CT-e ${cte.numero_cte}...`);
      const cteRes = await omieCall(
        "https://app.omie.com.br/api/v1/produtos/nfe/",
        importPayload,
      );
      results.push({ step: `ImportarCTe_${cte.numero_cte}`, ...cteRes });

      if (!cteRes.error) {
        await supabase
          .from("cte_associados")
          .update({ status: "efetivado", omie_cte_id: cteRes.data?.nIdNfe ?? null })
          .eq("id", cte.id);
      } else {
        console.error(`[omie-nfe-recebimento] Erro CT-e ${cte.numero_cte}:`, cteRes.data);
      }
    }

    // ── 7. Update status ──
    await supabase
      .from("nfe_recebimentos")
      .update({ status: "efetivado", efetivado_at: new Date().toISOString() })
      .eq("id", nfeRecebimentoId);

    console.log(`[omie-nfe-recebimento] NF-e ${nfe.numero_nfe} efetivada com sucesso.`);

    return jsonRes({
      success: true,
      nfe_recebimento_id: nfeRecebimentoId,
      numero_nfe: nfe.numero_nfe,
      warehouse: warehouseCode,
      has_conversion: hasConversion,
      ctes_processed: (ctes ?? []).length,
      operations: results,
    });
  } catch (err) {
    console.error("[omie-nfe-recebimento] Erro inesperado:", err);
    return jsonRes({ error: "Erro interno", details: String(err) }, 500);
  }
});
