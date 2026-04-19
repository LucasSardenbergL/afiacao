// omie-sync-vendas-items
// Lista NF-es emitidas (vendas) via Omie produtos/nfconsultar/ ListarNF
// e popula venda_items_history com 1 linha por item válido (CFOP de venda).
//
// Body: { empresa: "OBEN" | "COLACOR", dias: number }
// Defaults: empresa = "OBEN", dias = 180

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const OMIE_NF_URL = "https://app.omie.com.br/api/v1/produtos/nfconsultar/";
const RATE_LIMIT_MS = 1100;
const TIMEOUT_GUARD_MS = 120_000;
const MAX_RETRIES = 3;

// CFOPs de operações que NÃO são venda → pular item
const CFOPS_NAO_VENDA = new Set<string>([
  // Devoluções de compra
  "1202", "2202",
  // Lançamentos simbólicos
  "5920", "6920",
  // Transferências entre estabelecimentos
  "5151", "5152", "5153", "6151", "6152", "6153",
  // Bonificações / amostras / brindes
  "5910", "6910", "5911", "6911",
  // Perdas, roubos, deterioração / quebra
  "5927", "6927", "5928", "6928",
  // Outras saídas não-venda
  "5949", "6949",
]);

function normalizeCfop(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  return String(raw).replace(/\D/g, "");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function ddmmaaaa(date: Date): string {
  const d = String(date.getUTCDate()).padStart(2, "0");
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const y = date.getUTCFullYear();
  return `${d}/${m}/${y}`;
}

function getOmieCreds(empresa: string): { app_key: string; app_secret: string } | null {
  const e = empresa.toUpperCase();
  if (e === "OBEN") {
    return {
      app_key: Deno.env.get("OMIE_OBEN_APP_KEY") ?? "",
      app_secret: Deno.env.get("OMIE_OBEN_APP_SECRET") ?? "",
    };
  }
  if (e === "COLACOR") {
    return {
      app_key: Deno.env.get("OMIE_COLACOR_APP_KEY") ?? "",
      app_secret: Deno.env.get("OMIE_COLACOR_APP_SECRET") ?? "",
    };
  }
  return null;
}

interface OmieCallResult {
  ok: boolean;
  status: number;
  data?: any;
  error?: string;
  apiBlocked?: boolean;
}

async function omieCall(
  app_key: string,
  app_secret: string,
  call: string,
  param: any,
): Promise<OmieCallResult> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(OMIE_NF_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          call,
          app_key,
          app_secret,
          param: [param],
        }),
      });

      if (res.status === 425) {
        return {
          ok: false,
          status: 425,
          error: "MISUSE_API_PROCESS",
          apiBlocked: true,
        };
      }

      if (res.status === 429) {
        const wait = 2000 * (attempt + 1);
        console.warn(`429 received, waiting ${wait}ms (attempt ${attempt + 1})`);
        await sleep(wait);
        continue;
      }

      const text = await res.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        return { ok: false, status: res.status, error: `invalid JSON: ${text.slice(0, 200)}` };
      }

      if (data?.faultstring || data?.faultcode) {
        const fs = String(data.faultstring ?? "");
        // Soft-throttle messages from Omie
        if (/processo/i.test(fs) && /bloqueado|aguard/i.test(fs)) {
          return { ok: false, status: 425, error: fs, apiBlocked: true };
        }
        return { ok: false, status: res.status, error: fs || "Omie fault" };
      }

      return { ok: true, status: res.status, data };
    } catch (err) {
      console.error(`omieCall network error attempt ${attempt + 1}:`, err);
      await sleep(1000 * (attempt + 1));
    }
  }
  return { ok: false, status: 0, error: "max retries exceeded" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const startedAt = Date.now();

  try {
    const body = await req.json().catch(() => ({}));
    const empresa = String(body.empresa ?? "OBEN").toUpperCase();
    const dias = Number.isFinite(body.dias) ? Number(body.dias) : 180;

    const creds = getOmieCreds(empresa);
    if (!creds || !creds.app_key || !creds.app_secret) {
      return new Response(
        JSON.stringify({ ok: false, error: `Credenciais Omie ausentes para ${empresa}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Janela de datas
    const fim = new Date();
    const inicio = new Date();
    inicio.setUTCDate(inicio.getUTCDate() - dias);
    const dEmiInicial = ddmmaaaa(inicio);
    const dEmiFinal = ddmmaaaa(fim);

    console.log(`[${empresa}] Período: ${dEmiInicial} → ${dEmiFinal} (${dias}d)`);

    // Pré-carregar chaves já processadas (modo incremental)
    const { data: existingRows, error: existingErr } = await supabase
      .from("venda_items_history")
      .select("nfe_chave_acesso")
      .eq("empresa", empresa)
      .gte("data_emissao", inicio.toISOString().slice(0, 10));

    if (existingErr) {
      console.error("Erro ao carregar chaves existentes:", existingErr);
    }
    const chavesExistentes = new Set<string>(
      (existingRows ?? [])
        .map((r: any) => r.nfe_chave_acesso)
        .filter((k: string | null): k is string => !!k),
    );
    console.log(`[${empresa}] Chaves já processadas: ${chavesExistentes.size}`);

    // Contadores
    let nfes_listadas = 0;
    let nfes_processadas = 0;
    let nfes_puladas_ja_existentes = 0;
    let consultas_detalhadas = 0;
    let itens_processados = 0;
    let itens_pulados_cfop = 0;
    let erros = 0;
    let interrompido_por_timeout = false;
    let interrompido_por_api_block = false;

    const skusDistintos = new Set<number>();
    const clientesDistintos = new Set<number>();

    // Loop de páginas
    let pagina = 1;
    let totalPaginas = 1;
    const registrosPorPagina = 50;

    pageLoop: while (pagina <= totalPaginas) {
      // Timeout guard
      if (Date.now() - startedAt > TIMEOUT_GUARD_MS) {
        interrompido_por_timeout = true;
        console.warn("Timeout guard: interrompendo loop de páginas");
        break;
      }

      const param = {
        pagina,
        registros_por_pagina: registrosPorPagina,
        apenas_importado_api: "N",
        filtrar_por_data_de: dEmiInicial,
        filtrar_por_data_ate: dEmiFinal,
        tpNF: "1", // 1 = saída/venda
        filtrar_por_status: "N",
        ordenar_por: "CODIGO",
      };

      const result = await omieCall(creds.app_key, creds.app_secret, "ListarNF", param);
      consultas_detalhadas++;

      if (result.apiBlocked) {
        interrompido_por_api_block = true;
        console.error("API block (425) detectado, interrompendo");
        break;
      }
      if (!result.ok) {
        erros++;
        console.error(`Erro ListarNF página ${pagina}:`, result.error);
        // Avança página para não ficar em loop infinito
        pagina++;
        await sleep(RATE_LIMIT_MS);
        continue;
      }

      const data = result.data ?? {};
      totalPaginas = Number(data.total_de_paginas ?? 1);
      const nfes = Array.isArray(data.nfCadastro) ? data.nfCadastro : [];
      nfes_listadas += nfes.length;

      console.log(
        `[${empresa}] Página ${pagina}/${totalPaginas} → ${nfes.length} NF-es listadas`,
      );

      // Processar cada NF-e
      for (const nf of nfes) {
        // Timeout guard interno
        if (Date.now() - startedAt > TIMEOUT_GUARD_MS) {
          interrompido_por_timeout = true;
          break pageLoop;
        }

        try {
          const ide = nf?.ide ?? {};
          const compl = nf?.compl ?? {};
          const dest = nf?.dest ?? {};
          const det: any[] = Array.isArray(nf?.det) ? nf.det : [];

          const chave: string = String(compl?.cChaveNFe ?? "").trim();
          const numero: string = String(ide?.nNF ?? "").trim();
          const serie: string = String(ide?.serie ?? "").trim();

          // Data de emissão DD/MM/AAAA → YYYY-MM-DD
          const dEmiRaw: string = String(ide?.dEmi ?? "").trim();
          let dataEmissao: string | null = null;
          if (/^\d{2}\/\d{2}\/\d{4}$/.test(dEmiRaw)) {
            const [d, m, y] = dEmiRaw.split("/");
            dataEmissao = `${y}-${m}-${d}`;
          } else if (/^\d{4}-\d{2}-\d{2}$/.test(dEmiRaw)) {
            dataEmissao = dEmiRaw;
          }

          if (!chave || !dataEmissao) {
            // Sem chave → não conseguimos UPSERT por chave, pulamos
            console.warn(`NF sem chave/data, pulando (numero=${numero})`);
            continue;
          }

          if (chavesExistentes.has(chave)) {
            nfes_puladas_ja_existentes++;
            continue;
          }

          const clienteCodigo = dest?.nCodCli != null ? Number(dest.nCodCli) : null;
          const clienteRazao = dest?.cRazao ?? null;
          const clienteDoc = dest?.cnpj_cpf ?? null;

          if (clienteCodigo) clientesDistintos.add(clienteCodigo);

          // Montar linhas a inserir
          const rows: any[] = [];
          let itensValidosNesta = 0;

          for (const it of det) {
            const prod = it?.prod ?? {};
            const cfop = normalizeCfop(prod?.cfop);

            if (cfop && CFOPS_NAO_VENDA.has(cfop)) {
              itens_pulados_cfop++;
              continue;
            }

            const skuOmie = prod?.codigo_produto != null
              ? Number(prod.codigo_produto)
              : (prod?.nCodProd != null ? Number(prod.nCodProd) : null);
            if (!skuOmie || !Number.isFinite(skuOmie)) {
              continue;
            }

            const qtde = Number(prod?.quantidade ?? prod?.nQtde ?? 0);
            const vProd = Number(prod?.valor_unitario != null ? (Number(prod.valor_unitario) * qtde) : (prod?.vProd ?? 0));
            // Preferir vProd direto se vier
            const valorTotal = prod?.vProd != null
              ? Number(prod.vProd)
              : (prod?.valor_mercadoria != null ? Number(prod.valor_mercadoria) : vProd);
            const valorUnitario = prod?.vUnCom != null
              ? Number(prod.vUnCom)
              : (prod?.valor_unitario != null
                ? Number(prod.valor_unitario)
                : (qtde > 0 ? valorTotal / qtde : null));

            skusDistintos.add(skuOmie);

            rows.push({
              empresa,
              nfe_chave_acesso: chave,
              nfe_numero: numero || null,
              nfe_serie: serie || null,
              data_emissao: dataEmissao,
              cliente_codigo_omie: clienteCodigo,
              cliente_razao_social: clienteRazao,
              cliente_cnpj_cpf: clienteDoc,
              cliente_uf: null,
              cliente_cidade: null,
              sku_codigo_omie: skuOmie,
              sku_codigo: prod?.codigo ?? prod?.cProd ?? null,
              sku_descricao: prod?.descricao ?? prod?.xProd ?? null,
              sku_ncm: prod?.ncm ?? prod?.cNCM ?? null,
              sku_unidade: prod?.unidade ?? prod?.cUnidadeNfe ?? null,
              quantidade: qtde,
              valor_unitario: Number.isFinite(valorUnitario as number) ? valorUnitario : null,
              valor_total: Number.isFinite(valorTotal) ? valorTotal : null,
              cfop: cfop || null,
              raw_data: it,
            });
            itensValidosNesta++;
          }

          if (rows.length > 0) {
            const { error: upErr } = await supabase
              .from("venda_items_history")
              .upsert(rows, { onConflict: "nfe_chave_acesso,sku_codigo_omie" });

            if (upErr) {
              erros++;
              console.error(`Upsert erro NF ${numero}:`, upErr.message);
            } else {
              itens_processados += itensValidosNesta;
              chavesExistentes.add(chave);
              nfes_processadas++;
            }
          } else {
            // NF sem itens válidos (todos pulados por CFOP) → marcar como processada para não reprocessar
            nfes_processadas++;
            chavesExistentes.add(chave);
          }
        } catch (err: any) {
          erros++;
          console.error("Erro processando NF:", err?.message ?? err);
        }
      }

      pagina++;
      await sleep(RATE_LIMIT_MS);
    }

    const summary = {
      empresa,
      nfes_listadas,
      nfes_processadas,
      nfes_puladas_ja_existentes,
      consultas_detalhadas,
      itens_processados,
      itens_pulados_cfop,
      skus_distintos: skusDistintos.size,
      clientes_distintos: clientesDistintos.size,
      erros,
      interrompido_por_timeout,
      interrompido_por_api_block,
    };

    return new Response(
      JSON.stringify({
        ok: true,
        duracao_ms: Date.now() - startedAt,
        summary: [summary],
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    console.error("Fatal error:", err);
    return new Response(
      JSON.stringify({ ok: false, error: err?.message ?? String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
