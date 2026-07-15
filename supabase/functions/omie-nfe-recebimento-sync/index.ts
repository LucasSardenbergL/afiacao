import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

// ── Local interfaces (Edge Functions bundle independently — no shared types) ──

interface OmieCallParams {
  nPagina?: number;
  nRegistrosPorPagina?: number;
  dtEmissaoDe?: string;
  nIdReceb?: number | string;
  [key: string]: unknown;
}

interface OmieRecebimentoCabec {
  nIdReceb?: number | string;
  nIdNfe?: number | string;
  cNumeroNFe?: number | string;
  cSerieNFe?: string | null;
  cCNPJ_CPF?: string;
  cRazaoSocial?: string | null;
  cNome?: string | null;
  dEmissaoNFe?: string | null;
  nValorNFe?: number | string | null;
  cChaveNFe?: string | null;
  cChaveNfe?: string | null;
}

interface OmieRecebimentoInfoCadastro {
  cCancelada?: string;
  cRecebido?: string;
}

interface OmieRecebimentoListItem {
  cabec?: OmieRecebimentoCabec;
  nIdReceb?: number | string;
  infoCadastro?: OmieRecebimentoInfoCadastro;
}

interface OmieListarRecebimentosResponse {
  recebimentos?: OmieRecebimentoListItem[];
  nTotalPaginas?: number;
}

interface OmieItemCabec {
  nSequencia?: number;
  cCodigoProduto?: string | null;
  cDescricaoProduto?: string | null;
  cNCM?: string | null;
  cEAN?: string | null;
  cUnidadeNfe?: string | null;
  nQtdeNFe?: number | string | null;
  nPrecoUnit?: number | string | null;
  vTotalItem?: number | string | null;
  nIdProduto?: number | string | null;
}

interface OmieRecebimentoItem {
  itensCabec?: OmieItemCabec;
  [key: string]: unknown;
}

interface OmieConsultarRecebimentoResponse {
  cabec?: OmieRecebimentoCabec;
  itensRecebimento?: OmieRecebimentoItem[];
  infoCadastro?: OmieRecebimentoInfoCadastro;
}

interface WarehouseRow {
  id: string;
}

interface NfeRecebimentoExistingRow {
  omie_id_receb: number | null;
}

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

/** Convert "DD/MM/YYYY" to "YYYY-MM-DD" for Postgres */
function parseOmieDate(d: string | null | undefined): string | null {
  if (!d) return null;
  const parts = d.split("/");
  if (parts.length === 3) {
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }
  return d;
}

interface OmieCredentials {
  appKey: string;
  appSecret: string;
  warehouseCode: string;
}

function getCredentials(): OmieCredentials[] {
  const creds: OmieCredentials[] = [];
  const obenKey = Deno.env.get("OMIE_OBEN_APP_KEY");
  const obenSecret = Deno.env.get("OMIE_OBEN_APP_SECRET");
  if (obenKey && obenSecret) {
    creds.push({ appKey: obenKey, appSecret: obenSecret, warehouseCode: "OB" });
  }
  // CC = Colacor SC (afiação)
  const colacorScKey = Deno.env.get("OMIE_COLACOR_SC_APP_KEY");
  const colacorScSecret = Deno.env.get("OMIE_COLACOR_SC_APP_SECRET");
  if (colacorScKey && colacorScSecret) {
    creds.push({ appKey: colacorScKey, appSecret: colacorScSecret, warehouseCode: "CC" });
  }
  return creds;
}

async function omieCall(
  appKey: string,
  appSecret: string,
  endpoint: string,
  method: string,
  params: OmieCallParams,
): Promise<unknown> {
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
  {
    const __auth = await authorizeCronOrStaff(req);
    if (!__auth.ok) return __auth.response;
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

      const { data: warehouseData } = await supabase
        .from("warehouses")
        .select("id")
        .eq("code", cred.warehouseCode)
        .maybeSingle();

      const warehouse = warehouseData as unknown as WarehouseRow | null;
      if (!warehouse) {
        console.log(`[sync] Warehouse ${cred.warehouseCode} não encontrado, pulando`);
        continue;
      }

      // Get existing omie_id_recebs to skip quickly
      const { data: existingRecebimentos } = await supabase
        .from("nfe_recebimentos")
        .select("omie_id_receb")
        .eq("warehouse_id", warehouse.id)
        .not("omie_id_receb", "is", null);

      const existingRecebRows = (existingRecebimentos ?? []) as unknown as NfeRecebimentoExistingRow[];
      // Normaliza pra number: o Omie pode devolver nIdReceb como string na listagem — sem
      // isso o has() nunca casa e as MAX_DETAIL_CALLS se esgotam re-consultando NFs já
      // importadas (starvation: NF nova nunca chega a ser vista). (Codex P2)
      const existingIds = new Set(
        existingRecebRows.map((r) => Number(r.omie_id_receb))
      );

      // Filter last 30 days to get recent NF-es with cChaveNfe
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const dtDe = `${String(thirtyDaysAgo.getDate()).padStart(2,'0')}/${String(thirtyDaysAgo.getMonth()+1).padStart(2,'0')}/${thirtyDaysAgo.getFullYear()}`;

      const allRecebimentos: OmieRecebimentoListItem[] = [];
      let page = 1;
      const maxPages = 3;
      let hasMore = true;

      while (hasMore && page <= maxPages) {
        try {
          const pageResult = (await omieCall(
            cred.appKey,
            cred.appSecret,
            "produtos/recebimentonfe/",
            "ListarRecebimentos",
            {
              nPagina: page,
              nRegistrosPorPagina: 50,
              dtEmissaoDe: dtDe,
            },
          )) as unknown as OmieListarRecebimentosResponse;
          const recs = pageResult.recebimentos ?? [];
          allRecebimentos.push(...recs);
          const totalPages = pageResult.nTotalPaginas ?? 1;
          console.log(`[sync] Página ${page}/${totalPages}, ${recs.length} registros`);
          hasMore = page < totalPages;
          page++;
        } catch (pgErr) {
          const msg = pgErr instanceof Error ? pgErr.message : String(pgErr);
          console.warn(`[sync] Erro na página ${page}: ${msg}`);
          break;
        }
      }

      console.log(`[sync] ${allRecebimentos.length} registros recentes (últimos 30 dias)`);

      let detailCalls = 0;
      const MAX_DETAIL_CALLS = 10;

      for (const rec of allRecebimentos) {
        if (detailCalls >= MAX_DETAIL_CALLS) break;

        const cabec = rec.cabec ?? rec;
        const nIdReceb = cabec.nIdReceb;
        if (!nIdReceb) continue;

        // Quick skip if already imported (normalizado pra number, como o Set)
        if (existingIds.has(Number(nIdReceb))) {
          totalSkipped++;
          continue;
        }

        // Skip cancelled/faturado
        const infoCad = rec.infoCadastro ?? {};
        if (infoCad.cCancelada === "S") {
          continue;
        }

        // Need to fetch detail for chave_acesso and items
        detailCalls++;
        let detail: OmieConsultarRecebimentoResponse;
        try {
          detail = (await omieCall(
            cred.appKey,
            cred.appSecret,
            "produtos/recebimentonfe/",
            "ConsultarRecebimento",
            { nIdReceb },
          )) as unknown as OmieConsultarRecebimentoResponse;
        } catch (detErr) {
          const msg = detErr instanceof Error ? detErr.message : String(detErr);
          console.warn(`[sync] Erro ao consultar recebimento ${nIdReceb}: ${msg}`);
          continue;
        }

        const detCabec = detail.cabec ?? {};
        // Log first detail to understand structure
        if (detailCalls <= 2) {
          console.log(`[sync] Detail cabec keys for ${nIdReceb}: ${JSON.stringify(Object.keys(detCabec))}`);
          console.log(`[sync] Detail cabec sample: ${JSON.stringify(detCabec).slice(0, 500)}`);
        }

        // NF que o Omie JÁ recebeu (cRecebido=S) não nasce 'pendente' no app — a entrada
        // foi feita lá (humano); importá-la só criaria pendência fantasma no painel de
        // conferência (a varredura omie-nfe-reconcile teria que baixá-la em seguida).
        if (detail.infoCadastro?.cRecebido === "S") {
          totalSkipped++;
          console.log(`[sync] Recebimento ${nIdReceb} já recebido no Omie (cRecebido=S), pulando`);
          continue;
        }

        const chaveAcesso = detCabec.cChaveNFe || detCabec.cChaveNfe || null;
        if (!chaveAcesso || chaveAcesso.length < 44) {
          console.log(`[sync] Recebimento ${nIdReceb} sem chave de acesso no detalhe, pulando`);
          continue;
        }

        // Double check by chave_acesso
        const { data: existByChave } = await supabase
          .from("nfe_recebimentos")
          .select("id")
          .eq("chave_acesso", chaveAcesso)
          .maybeSingle();

        if (existByChave) {
          totalSkipped++;
          continue;
        }

        const numeroNfe = String(detCabec.cNumeroNFe ?? "");
        const serieNfe = detCabec.cSerieNFe ?? null;
        const cnpjEmitente = (detCabec.cCNPJ_CPF ?? "").replace(/\D/g, "");
        const razaoSocial = detCabec.cRazaoSocial ?? detCabec.cNome ?? null;
        const dataEmissao = parseOmieDate(detCabec.dEmissaoNFe);
        const valorTotal = detCabec.nValorNFe ?? null;

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
            valor_total: valorTotal ? parseFloat(String(valorTotal)) : null,
            status: "pendente",
            omie_nfe_id: detCabec.nIdNfe ? parseInt(String(detCabec.nIdNfe)) : null,
            omie_id_receb: parseInt(String(nIdReceb)),
          })
          .select("id")
          .single();

        if (insErr || !newNfe) {
          console.error(`[sync] Erro ao inserir NF-e ${chaveAcesso}:`, insErr);
          errors.push(`NF-e ${numeroNfe}: ${insErr?.message}`);
          continue;
        }

        // Parse items from itensRecebimento
        const rawItems = detail.itensRecebimento ?? [];
        if (rawItems.length > 0) {
          const itens = rawItems.map((item: OmieRecebimentoItem, idx: number) => {
            const iCabec: OmieItemCabec = item.itensCabec ?? (item as unknown as OmieItemCabec);
            const quantidadeNfe = parseFloat(String(iCabec.nQtdeNFe ?? 0));
            return {
              nfe_recebimento_id: newNfe.id,
              sequencia: iCabec.nSequencia ?? idx + 1,
              codigo_produto: iCabec.cCodigoProduto ?? null,
              descricao: iCabec.cDescricaoProduto ?? "Item",
              ncm: iCabec.cNCM ?? null,
              ean: iCabec.cEAN ?? null,
              unidade_nfe: iCabec.cUnidadeNfe ?? "UN",
              quantidade_nfe: quantidadeNfe,
              valor_unitario: iCabec.nPrecoUnit ? parseFloat(String(iCabec.nPrecoUnit)) : null,
              valor_total: iCabec.vTotalItem ? parseFloat(String(iCabec.vTotalItem)) : null,
              unidade_estoque: null,
              quantidade_convertida: null,
              quantidade_conferida: 0,
              quantidade_esperada: smartRound(quantidadeNfe),
              status_item: "pendente",
              produto_omie_id: iCabec.nIdProduto ? parseInt(String(iCabec.nIdProduto)) : null,
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
      }

      if (detailCalls >= MAX_DETAIL_CALLS) {
        console.log(`[sync] Limite de ${MAX_DETAIL_CALLS} consultas de detalhe atingido para ${cred.warehouseCode}. Execute novamente para mais.`);
      }
    } catch (credErr) {
      const msg = credErr instanceof Error ? credErr.message : String(credErr);
      console.error(`[sync] Erro na conta ${cred.warehouseCode}:`, credErr);
      errors.push(`${cred.warehouseCode}: ${msg}`);
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
