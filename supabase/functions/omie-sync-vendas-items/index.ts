// omie-sync-vendas-items
// Lista NF-es emitidas (vendas) via Omie produtos/nfconsultar/ ListarNF
// e popula venda_items_history com 1 linha por item válido (CFOP de venda).
//
// Body: { empresa: "OBEN" | "COLACOR", dias: number }
// Defaults: empresa = "OBEN", dias = 180

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// ─── Type definitions ───

/** Resposta genérica de uma chamada à API Omie nfconsultar */
interface OmieNfResponseData {
  faultstring?: string;
  faultcode?: string;
  total_de_paginas?: number;
  nfCadastro?: OmieNfRecord[];
  [k: string]: unknown;
}

/** Bloco prod (produto) dentro de det */
interface OmieNfProd {
  CFOP?: string | number;
  cfop?: string | number;
  cProd?: string;
  xProd?: string;
  NCM?: string;
  uCom?: string;
  qCom?: string | number;
  vUnCom?: string | number;
  vProd?: string | number;
}

/** Bloco nfProdInt (chaves internas Omie do produto) */
interface OmieNfProdInt {
  nCodProd?: number | string;
  cCodProdInt?: string;
}

/** Item det (detalhe) de uma NF-e */
interface OmieNfDetItem {
  prod?: OmieNfProd;
  nfProdInt?: OmieNfProdInt;
  [k: string]: unknown;
}

/** Bloco ide (identificação) da NF-e */
interface OmieNfIde {
  nNF?: string | number;
  serie?: string | number;
  dEmi?: string;
  [k: string]: unknown;
}

/** Bloco compl (complementares) da NF-e */
interface OmieNfCompl {
  cChaveNFe?: string;
  [k: string]: unknown;
}

/** Bloco destinatário (nfDestInt ou dest) */
interface OmieNfDest {
  nCodCli?: number | string;
  cRazao?: string;
  cnpj_cpf?: string;
  [k: string]: unknown;
}

/** Registro de NF-e retornado por ListarNF */
interface OmieNfRecord {
  ide?: OmieNfIde;
  compl?: OmieNfCompl;
  nfDestInt?: OmieNfDest;
  dest?: OmieNfDest;
  det?: OmieNfDetItem[];
  [k: string]: unknown;
}

/** Linha pronta para inserir em venda_items_history */
interface VendaItemHistoryRow {
  empresa: string;
  nfe_chave_acesso: string;
  nfe_numero: string | null;
  nfe_serie: string | null;
  data_emissao: string;
  cliente_codigo_omie: number | null;
  cliente_razao_social: string | null;
  cliente_cnpj_cpf: string | null;
  cliente_uf: string | null;
  cliente_cidade: string | null;
  sku_codigo_omie: number;
  sku_codigo: string | null;
  sku_descricao: string | null;
  sku_ncm: string | null;
  sku_unidade: string | null;
  quantidade: number;
  valor_unitario: number | null;
  valor_total: number | null;
  cfop: string | null;
  raw_data: unknown;
}

/** Linha já existente em venda_items_history (apenas chave usada no incremental) */
interface VendaItemKeyRow {
  nfe_chave_acesso: string | null;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const OMIE_NF_URL = "https://app.omie.com.br/api/v1/produtos/nfconsultar/";
const RATE_LIMIT_MS = 1100;
const TIMEOUT_GUARD_MS = 25_000; // retornar antes do gateway cortar (~30s)
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
  data?: OmieNfResponseData;
  error?: string;
  apiBlocked?: boolean;
}

async function omieCall(
  app_key: string,
  app_secret: string,
  call: string,
  param: Record<string, unknown>,
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
      let data: OmieNfResponseData;
      try {
        data = JSON.parse(text) as OmieNfResponseData;
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

async function authorizeCronOrStaff(req: Request): Promise<boolean> {
  const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
  const SVC_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const CRON_SEC = Deno.env.get("CRON_SECRET");
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret && CRON_SEC && cronSecret === CRON_SEC) return true;
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);
  if (token === SVC_KEY) return true;
  try {
    const userRes = await fetch(`${SUPA_URL}/auth/v1/user`, { headers: { Authorization: authHeader, apikey: SVC_KEY } });
    if (!userRes.ok) return false;
    const user = await userRes.json();
    if (!user?.id) return false;
    const roleRes = await fetch(`${SUPA_URL}/rest/v1/user_roles?user_id=eq.${user.id}&select=role`, { headers: { apikey: SVC_KEY, Authorization: `Bearer ${SVC_KEY}` } });
    if (!roleRes.ok) return false;
    const roles = (await roleRes.json()) as Array<{ role: string }>;
    const allowed = new Set(["employee", "master"]);
    return roles.some((r) => allowed.has(r.role));
  } catch { return false; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (!(await authorizeCronOrStaff(req))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
      ((existingRows ?? []) as unknown as VendaItemKeyRow[])
        .map((r) => r.nfe_chave_acesso)
        .filter((k): k is string => !!k),
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
        dEmiInicial,
        dEmiFinal,
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

      const data: OmieNfResponseData = result.data ?? {};
      totalPaginas = Number(data.total_de_paginas ?? 1);
      const nfes: OmieNfRecord[] = Array.isArray(data.nfCadastro) ? data.nfCadastro : [];
      nfes_listadas += nfes.length;

      // Diagnóstico do primeiro payload (apenas página 1)
      if (pagina === 1 && nfes.length > 0) {
        const sample = nfes[0];
        console.log(
          `[${empresa}] SAMPLE keys=${Object.keys(sample).join(",")} det_len=${
            Array.isArray(sample?.det) ? sample.det.length : "no_det"
          } compl_keys=${Object.keys(sample?.compl ?? {}).join(",")} ide_keys=${
            Object.keys(sample?.ide ?? {}).join(",")
          }`,
        );
        if (Array.isArray(sample?.det) && sample.det[0]) {
          console.log(
            `[${empresa}] SAMPLE det[0] keys=${Object.keys(sample.det[0]).join(",")} prod_keys=${
              Object.keys(sample.det[0]?.prod ?? {}).join(",")
            } nfProdInt_keys=${Object.keys(sample.det[0]?.nfProdInt ?? {}).join(",")}`,
          );
          console.log(
            `[${empresa}] SAMPLE nfDestInt_keys=${Object.keys(sample?.nfDestInt ?? {}).join(",")} dest_keys=${Object.keys(sample?.dest ?? {}).join(",")}`,
          );
        }
      }

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
          const ide: OmieNfIde = nf?.ide ?? {};
          const compl: OmieNfCompl = nf?.compl ?? {};
          const dest: OmieNfDest = nf?.nfDestInt ?? nf?.dest ?? {};
          const det: OmieNfDetItem[] = Array.isArray(nf?.det) ? nf.det : [];

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

          const rows: VendaItemHistoryRow[] = [];
          let itensValidosNesta = 0;

          for (const it of det) {
            const prod = it?.prod ?? {};
            const prodInt = it?.nfProdInt ?? {};
            const cfop = normalizeCfop(prod?.CFOP ?? prod?.cfop);

            if (cfop && CFOPS_NAO_VENDA.has(cfop)) {
              itens_pulados_cfop++;
              continue;
            }

            // ID interno Omie do produto (bigint)
            const skuOmie = prodInt?.nCodProd != null ? Number(prodInt.nCodProd) : null;
            if (!skuOmie || !Number.isFinite(skuOmie)) {
              continue;
            }

            const qtde = Number(prod?.qCom ?? 0);
            const valorTotal = prod?.vProd != null ? Number(prod.vProd) : null;
            const valorUnitario = prod?.vUnCom != null
              ? Number(prod.vUnCom)
              : (qtde > 0 && valorTotal != null ? valorTotal / qtde : null);

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
              sku_codigo: prod?.cProd ?? prodInt?.cCodProdInt ?? null,
              sku_descricao: prod?.xProd ?? null,
              sku_ncm: prod?.NCM ?? null,
              sku_unidade: prod?.uCom ?? null,
              quantidade: qtde,
              valor_unitario: Number.isFinite(valorUnitario as number) ? valorUnitario : null,
              valor_total: Number.isFinite(valorTotal as number) ? valorTotal : null,
              cfop: cfop || null,
              raw_data: it,
            });
            itensValidosNesta++;
          }

          if (rows.length > 0) {
            // Consolidar duplicatas (mesmo SKU 2x na mesma NF) somando qtd e valor_total
            const dedup = new Map<number, VendaItemHistoryRow>();
            for (const r of rows) {
              const key = r.sku_codigo_omie;
              const existing = dedup.get(key);
              if (!existing) {
                dedup.set(key, { ...r });
              } else {
                existing.quantidade = Number(existing.quantidade) + Number(r.quantidade);
                existing.valor_total = Number(existing.valor_total ?? 0) + Number(r.valor_total ?? 0);
                existing.valor_unitario = existing.quantidade > 0
                  ? existing.valor_total / existing.quantidade
                  : existing.valor_unitario;
              }
            }
            const dedupedRows = Array.from(dedup.values());

            const { error: upErr } = await supabase
              .from("venda_items_history")
              .upsert(dedupedRows, { onConflict: "nfe_chave_acesso,sku_codigo_omie" });

            if (upErr) {
              erros++;
              console.error(`Upsert erro NF ${numero}:`, upErr.message);
            } else {
              itens_processados += dedupedRows.length;
              chavesExistentes.add(chave);
              nfes_processadas++;
            }
          } else {
            nfes_processadas++;
            chavesExistentes.add(chave);
          }
        } catch (err) {
          erros++;
          const msg = err instanceof Error ? err.message : String(err);
          console.error("Erro processando NF:", msg);
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
  } catch (err) {
    console.error("Fatal error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
