import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const OMIE_API_URL = "https://app.omie.com.br/api/v1";

// Observability counters (reset per invocation)
let apiCallCount = 0;
let rateLimitHits = 0;
let globalStartTime = Date.now();
const TIME_BUDGET_MS = 130_000; // stop before 150s edge function timeout

function isTimeBudgetExhausted(): boolean {
  return Date.now() - globalStartTime >= TIME_BUDGET_MS;
}

type Company = "oben" | "colacor" | "colacor_sc";

function getCredentials(company: Company) {
  switch (company) {
    case "oben":
      return {
        key: Deno.env.get("OMIE_VENDAS_APP_KEY"),
        secret: Deno.env.get("OMIE_VENDAS_APP_SECRET"),
      };
    case "colacor":
      return {
        key: Deno.env.get("OMIE_COLACOR_VENDAS_APP_KEY"),
        secret: Deno.env.get("OMIE_COLACOR_VENDAS_APP_SECRET"),
      };
    case "colacor_sc":
      return {
        key: Deno.env.get("OMIE_COLACOR_SC_APP_KEY"),
        secret: Deno.env.get("OMIE_COLACOR_SC_APP_SECRET"),
      };
  }
}

async function callOmie(
  company: Company,
  endpoint: string,
  call: string,
  params: Record<string, unknown>
) {
  const creds = getCredentials(company);
  if (!creds.key || !creds.secret)
    throw new Error(`Credenciais Omie (${company}) não configuradas`);

  const body = {
    call,
    app_key: creds.key,
    app_secret: creds.secret,
    param: [params],
  };

  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(`${OMIE_API_URL}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    apiCallCount++;
    const result = await res.json();

    if (result.faultstring) {
      const fs = String(result.faultstring);
      const isRateLimit =
        fs.includes("Já existe uma requisição desse método") ||
        fs.includes("Consumo redundante") ||
        fs.includes("REDUNDANT") ||
        fs.includes("consumo redundante");
      if (isRateLimit && attempt < maxRetries) {
        rateLimitHits++;
        const waitMatch = fs.match(/Aguarde (\d+) segundos/);
        const requestedDelay = waitMatch ? parseInt(waitMatch[1]) : (attempt + 1) * 5;
        const delay = Math.min(requestedDelay + 2, 15) * 1000;
        console.log(`[Fin][${company}] Rate limit, waiting ${delay / 1000}s`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw new Error(`Omie (${company}): ${fs}`);
    }
    return result;
  }
  return null;
}

// ═══════════════ SYNC CATEGORIAS ═══════════════
async function syncCategorias(
  db: ReturnType<typeof createClient>,
  company: Company
) {
  let pagina = 1;
  let totalPaginas = 1;
  let totalSynced = 0;

  while (pagina <= totalPaginas) {
    const result = (await callOmie(
      company,
      "geral/categorias/",
      "ListarCategorias",
      { pagina, registros_por_pagina: 500 }
    )) as any;
    if (!result) break;

    totalPaginas = result.total_de_paginas || 1;
    const categorias = result.categoria_cadastro || [];

    const rows = categorias.map((c: any) => ({
      company,
      omie_codigo: c.codigo,
      descricao: c.descricao,
      tipo: c.tipo_categoria === "R" ? "R" : c.tipo_categoria === "D" ? "D" : "T",
      conta_pai: c.codigo_conta_pai || null,
      nivel: c.nivel || 1,
      totalizadora: c.conta_totalizadora === "S",
      ativo: c.conta_inativa !== "S",
      updated_at: new Date().toISOString(),
    }));

    if (rows.length > 0) {
      const { error } = await db
        .from("fin_categorias")
        .upsert(rows, { onConflict: "company,omie_codigo" });
      if (error) console.error(`[Fin][${company}] Erro categorias:`, error.message);
      else totalSynced += rows.length;
    }

    console.log(`[Fin][${company}] Categorias p${pagina}/${totalPaginas}`);
    pagina++;
  }
  return { totalSynced };
}

// ═══════════════ SYNC CONTAS CORRENTES ═══════════════
async function syncContasCorrentes(
  db: ReturnType<typeof createClient>,
  company: Company
) {
  let pagina = 1;
  let totalPaginas = 1;
  let totalSynced = 0;

  while (pagina <= totalPaginas) {
    const result = (await callOmie(
      company,
      "geral/contacorrente/",
      "ListarContasCorrentes",
      { pagina, registros_por_pagina: 50 }
    )) as any;
    if (!result) break;

    totalPaginas = result.nTotPaginas || 1;
    const contas = result.ListarContasCorrentes || result.conta_corrente_lista || [];

    for (const c of contas) {
      // Buscar saldo real via ResumirContaCorrente
      let saldoAtual = 0;
      let saldoData: string | null = null;
      try {
        const saldoResult = (await callOmie(
          company,
          "geral/contacorrente/",
          "ResumirContaCorrente",
          { nCodCC: c.nCodCC }
        )) as any;
        if (saldoResult) {
          saldoAtual = saldoResult.nSaldo ?? saldoResult.nSaldoAtual ?? 0;
          saldoData = new Date().toISOString().split("T")[0];
        }
      } catch (e) {
        console.log(`[Fin][${company}] Saldo CC ${c.nCodCC} falhou, usando 0: ${e}`);
      }

      const row = {
        company,
        omie_ncodcc: c.nCodCC,
        descricao: c.descricao || c.cDescricao,
        banco: c.codigo_banco || c.cNomeBanco || c.banco,
        agencia: c.codigo_agencia || c.cAgencia || c.agencia,
        numero_conta: c.numero_conta_corrente || c.cNumeroConta || c.numero_conta,
        tipo: c.tipo_conta_corrente || c.tipo || c.cTipo || "CC",
        saldo_atual: saldoAtual,
        saldo_data: saldoData,
        ativo: c.inativo !== "S" && c.cInativa !== "S",
        updated_at: new Date().toISOString(),
      };

      const { error } = await db
        .from("fin_contas_correntes")
        .upsert(row, { onConflict: "company,omie_ncodcc" });
      if (error)
        console.error(`[Fin][${company}] Erro CC ${c.nCodCC}:`, error.message);
      else totalSynced++;
    }

    pagina++;
  }
  return { totalSynced };
}

// ═══════════════ SYNC CONTAS A PAGAR ═══════════════
async function syncContasPagar(
  db: ReturnType<typeof createClient>,
  company: Company,
  filtroDataDe?: string,
  filtroDataAte?: string,
  maxPages = 500
) {
  let pagina = 1;
  let totalPaginas = 1;
  let totalSynced = 0;
  let pagesProcessed = 0;
  let consecutiveEmpty = 0;

  while (pagina <= totalPaginas && pagesProcessed < maxPages && !isTimeBudgetExhausted()) {
    const params: Record<string, unknown> = {
      pagina,
      registros_por_pagina: 100,
    };
    // Omie lcpListarRequest não aceita filtros de data

    const result = (await callOmie(
      company,
      "financas/contapagar/",
      "ListarContasPagar",
      params
    )) as any;
    if (!result) break;

    totalPaginas = result.total_de_paginas || 1;
    const titulos =
      result.conta_pagar_cadastro || result.titulosEncontrados || [];

    const rows = titulos.map((t: any) => {
      const statusMap: Record<string, string> = {
        LIQUIDADO: "PAGO",
        CANCELADO: "CANCELADO",
        RECEBIDO: "PAGO",
      };

      let status = t.status_titulo || "ABERTO";
      if (statusMap[status]) status = statusMap[status];

      // Verifica vencido
      if (
        status === "ABERTO" &&
        t.data_vencimento &&
        new Date(t.data_vencimento.split("/").reverse().join("-")) <
          new Date()
      ) {
        status = "VENCIDO";
      }

      return {
        company,
        omie_codigo_lancamento:
          t.codigo_lancamento_omie || t.nCodTitulo || t.codigo_lancamento,
        omie_codigo_cliente_fornecedor:
          t.codigo_cliente_fornecedor_integracao
            ? null
            : t.codigo_cliente_fornecedor || null,
        nome_fornecedor: t.nome_cliente_fornecedor || t.nome_fornecedor || "",
        cnpj_cpf: (t.cnpj_cpf || "").replace(/\D/g, ""),
        numero_documento: t.numero_documento || t.cNumDocumento || "",
        numero_documento_fiscal: t.numero_documento_fiscal || null,
        data_emissao: parseOmieDate(t.data_emissao || t.dDtEmissao),
        data_vencimento: parseOmieDate(t.data_vencimento || t.dDtVenc),
        data_pagamento: parseOmieDate(t.data_pagamento || t.dDtPagamento),
        data_previsao: parseOmieDate(t.data_previsao || t.dDtPreworst),
        valor_documento: t.valor_documento || t.nValorTitulo || 0,
        valor_pago: t.valor_pago || t.nValorPago || 0,
        valor_desconto: t.valor_desconto || 0,
        valor_juros: t.valor_juros || 0,
        valor_multa: t.valor_multa || 0,
        status_titulo: status,
        categoria_codigo: t.codigo_categoria || t.cCodCateg || "",
        categoria_descricao: t.descricao_categoria || "",
        departamento: t.departamento || null,
        centro_custo: t.centro_custo || null,
        observacao: t.observacao || null,
        omie_ncodcc: t.nCodCC || null,
        codigo_barras: t.codigo_barras || null,
        tipo_documento: t.tipo_documento || null,
        id_origem: t.id_origem || null,
        metadata: {
          codigo_cliente_fornecedor_integracao:
            t.codigo_cliente_fornecedor_integracao,
          parcela: t.parcela,
          total_parcelas: t.total_parcelas,
          baixa_obs: t.baixa_obs,
        },
        updated_at: new Date().toISOString(),
      };
    });

    // Filter out rows with null primary key (prevents upsert failure)
    const validRows = rows.filter((r: any) => r.omie_codigo_lancamento != null);
    const skipped = rows.length - validRows.length;
    if (skipped > 0) console.log(`[Fin][${company}] CP p${pagina}: ${skipped} títulos sem código, ignorados`);

    if (validRows.length > 0) {
      const { error } = await db
        .from("fin_contas_pagar")
        .upsert(validRows, { onConflict: "company,omie_codigo_lancamento" });
      if (error)
        console.error(
          `[Fin][${company}] Erro CP p${pagina}:`,
          error.message
        );
      else totalSynced += validRows.length;
    }

    if (validRows.length === 0) { consecutiveEmpty++; } else { consecutiveEmpty = 0; }
    console.log(`[Fin][${company}] CP p${pagina}/${totalPaginas} (+${validRows.length})`);
    if (consecutiveEmpty >= 10) { console.log(`[Fin][${company}] CP early exit: 10 empty pages`); break; }
    pagina++;
    pagesProcessed++;
  }

  const timedOut = isTimeBudgetExhausted();
  if (timedOut) console.log(`[Fin][${company}] CP stopped: time budget exhausted`);
  return {
    totalSynced,
    complete: pagina > totalPaginas,
    nextPage: pagina > totalPaginas ? null : pagina,
    timedOut,
  };
}

// ═══════════════ SYNC CONTAS A RECEBER ═══════════════
async function syncContasReceber(
  db: ReturnType<typeof createClient>,
  company: Company,
  filtroDataDe?: string,
  filtroDataAte?: string,
  maxPages = 500
) {
  let pagina = 1;
  let totalPaginas = 1;
  let totalSynced = 0;
  let pagesProcessed = 0;
  let consecutiveEmpty = 0;

  while (pagina <= totalPaginas && pagesProcessed < maxPages && !isTimeBudgetExhausted()) {
    const params: Record<string, unknown> = {
      pagina,
      registros_por_pagina: 100,
    };
    // Omie lcrListarRequest não aceita filtros de data

    const result = (await callOmie(
      company,
      "financas/contareceber/",
      "ListarContasReceber",
      params
    )) as any;
    if (!result) break;

    totalPaginas = result.total_de_paginas || 1;
    const titulos =
      result.conta_receber_cadastro || result.titulosEncontrados || [];

    const rows = titulos.map((t: any) => {
      let status = t.status_titulo || "ABERTO";
      if (status === "LIQUIDADO") status = "RECEBIDO";
      if (
        status === "ABERTO" &&
        t.data_vencimento &&
        new Date(t.data_vencimento.split("/").reverse().join("-")) <
          new Date()
      ) {
        status = "VENCIDO";
      }

      return {
        company,
        omie_codigo_lancamento:
          t.codigo_lancamento_omie || t.nCodTitulo || t.codigo_lancamento,
        omie_codigo_cliente: t.codigo_cliente_fornecedor || null,
        nome_cliente: t.nome_cliente_fornecedor || t.nome_cliente || "",
        cnpj_cpf: (t.cnpj_cpf || "").replace(/\D/g, ""),
        numero_documento: t.numero_documento || "",
        numero_documento_fiscal: t.numero_documento_fiscal || null,
        numero_pedido: t.numero_pedido || null,
        data_emissao: parseOmieDate(t.data_emissao || t.dDtEmissao),
        data_vencimento: parseOmieDate(t.data_vencimento || t.dDtVenc),
        data_recebimento: parseOmieDate(t.data_recebimento || t.dDtPagamento),
        data_previsao: parseOmieDate(t.data_previsao),
        valor_documento: t.valor_documento || t.nValorTitulo || 0,
        valor_recebido: t.valor_recebido || t.nValorPago || 0,
        valor_desconto: t.valor_desconto || 0,
        valor_juros: t.valor_juros || 0,
        valor_multa: t.valor_multa || 0,
        status_titulo: status,
        categoria_codigo: t.codigo_categoria || t.cCodCateg || "",
        categoria_descricao: t.descricao_categoria || "",
        departamento: t.departamento || null,
        centro_custo: t.centro_custo || null,
        observacao: t.observacao || null,
        omie_ncodcc: t.nCodCC || null,
        vendedor_id: t.nCodVend || null,
        tipo_documento: t.tipo_documento || null,
        id_origem: t.id_origem || null,
        metadata: {
          codigo_cliente_fornecedor_integracao:
            t.codigo_cliente_fornecedor_integracao,
          parcela: t.parcela,
          total_parcelas: t.total_parcelas,
        },
        updated_at: new Date().toISOString(),
      };
    });

    const validRows = rows.filter((r: any) => r.omie_codigo_lancamento != null);
    const skipped = rows.length - validRows.length;
    if (skipped > 0) console.log(`[Fin][${company}] CR p${pagina}: ${skipped} títulos sem código, ignorados`);

    if (validRows.length > 0) {
      const { error } = await db
        .from("fin_contas_receber")
        .upsert(validRows, { onConflict: "company,omie_codigo_lancamento" });
      if (error)
        console.error(
          `[Fin][${company}] Erro CR p${pagina}:`,
          error.message
        );
      else totalSynced += validRows.length;
    }

    if (validRows.length === 0) { consecutiveEmpty++; } else { consecutiveEmpty = 0; }
    console.log(`[Fin][${company}] CR p${pagina}/${totalPaginas} (+${validRows.length})`);
    if (consecutiveEmpty >= 10) { console.log(`[Fin][${company}] CR early exit: 10 empty pages`); break; }
    pagina++;
    pagesProcessed++;
  }

  const timedOut = isTimeBudgetExhausted();
  if (timedOut) console.log(`[Fin][${company}] CR stopped: time budget exhausted`);
  return {
    totalSynced,
    complete: pagina > totalPaginas,
    nextPage: pagina > totalPaginas ? null : pagina,
    timedOut,
  };
}

// ═══════════════ SYNC MOVIMENTAÇÕES FINANCEIRAS ═══════════════
function buildSyntheticMovementId(company: Company, detalhes: Record<string, any>, resumo: Record<string, any>) {
  const source = [
    company,
    detalhes.nCodTitulo ?? "",
    detalhes.nCodCC ?? "",
    detalhes.cGrupo ?? "",
    detalhes.cNatureza ?? "",
    detalhes.cOrigem ?? "",
    detalhes.cStatus ?? "",
    detalhes.cNumDocFiscal ?? "",
    detalhes.cNumTitulo ?? "",
    detalhes.cNumOS ?? "",
    detalhes.cNumParcela ?? "",
    detalhes.dDtPagamento ?? "",
    detalhes.dDtRegistro ?? "",
    detalhes.dDtPrevisao ?? "",
    detalhes.dDtVenc ?? "",
    detalhes.dDtEmissao ?? "",
    detalhes.nValorTitulo ?? "",
    resumo.nValPago ?? "",
    resumo.nValLiquido ?? "",
    resumo.nDesconto ?? "",
    resumo.nJuros ?? "",
    resumo.nMulta ?? "",
  ].join("|");

  let hash = 1469598103934665603n;
  const prime = 1099511628211n;
  const mask = (1n << 63n) - 1n;

  for (const char of source) {
    hash ^= BigInt(char.codePointAt(0) ?? 0);
    hash = (hash * prime) & mask;
  }

  return hash.toString();
}

function resolveMovementDate(detalhes: Record<string, any>) {
  return parseOmieDate(
    detalhes.dDtPagamento ||
      detalhes.dDtRegistro ||
      detalhes.dDtPrevisao ||
      detalhes.dDtVenc ||
      detalhes.dDtEmissao
  );
}

function resolveMovementType(detalhes: Record<string, any>) {
  const natureza = String(detalhes.cNatureza || "").toUpperCase();
  const grupo = String(detalhes.cGrupo || "").toUpperCase();

  if (
    natureza.startsWith("R") ||
    natureza.startsWith("E") ||
    grupo.includes("_REC") ||
    grupo.includes("RECEBER")
  ) {
    return "E";
  }

  return "S";
}

function resolveMovementDescription(detalhes: Record<string, any>) {
  const parts = [
    detalhes.cGrupo,
    detalhes.cNumDocFiscal || detalhes.cNumTitulo || detalhes.cNumOS,
    detalhes.cStatus,
  ].filter(Boolean);

  return parts.join(" · ") || "Movimentação financeira";
}

async function syncMovimentacoes(
  db: ReturnType<typeof createClient>,
  company: Company,
  filtroDataDe?: string,
  filtroDataAte?: string,
  maxPages = 500
) {
  const dataInicioIso = parseOmieDate(filtroDataDe) || null;
  const dataFimIso = parseOmieDate(filtroDataAte) || null;

  let pagina = 1;
  let totalPaginas = 1;
  let totalSynced = 0;
  let pagesProcessed = 0;
  let consecutiveEmptyPages = 0;

  const firstPage = (await callOmie(
    company,
    "financas/mf/",
    "ListarMovimentos",
    { nPagina: 1, nRegPorPagina: 100 }
  )) as any;

  if (!firstPage) {
    return { totalSynced: 0, complete: true, nextPage: null, timedOut: false };
  }

  totalPaginas = firstPage.nTotPaginas || 1;
  // Start from the last page (most recent data) and go backwards
  pagina = totalPaginas;

  while (pagina >= 1 && pagesProcessed < maxPages && !isTimeBudgetExhausted()) {
    const result = (await callOmie(
      company,
      "financas/mf/",
      "ListarMovimentos",
      { nPagina: pagina, nRegPorPagina: 100 }
    )) as any;
    if (!result) break;

    const movs = result.movimentos || [];

    const rows = movs
      .map((mov: any) => {
        const detalhes = mov?.detalhes || {};
        const resumo = mov?.resumo || {};
        const dataMovimento = resolveMovementDate(detalhes);

        if (!dataMovimento) return null;

        const valorBase =
          resumo.nValPago ?? resumo.nValLiquido ?? detalhes.nValorTitulo ?? 0;
        const codigoLancamento = Number(detalhes.nCodTitulo || 0);

        return {
          company,
          omie_ncodmov: buildSyntheticMovementId(company, detalhes, resumo),
          omie_ncodcc: detalhes.nCodCC || null,
          data_movimento: dataMovimento,
          tipo: resolveMovementType(detalhes),
          valor: Math.abs(Number(valorBase) || 0),
          descricao: resolveMovementDescription(detalhes),
          categoria_codigo: detalhes.cCodCateg || "",
          categoria_descricao: detalhes.cGrupo || "",
          conciliado: false,
          omie_codigo_lancamento: codigoLancamento > 0 ? codigoLancamento : null,
          natureza: detalhes.cOrigem || null,
          metadata: {
            detalhes,
            resumo,
          },
          updated_at: new Date().toISOString(),
        };
      })
      .filter(Boolean) as Array<Record<string, any>>;

    const filteredRows = rows.filter((row) => {
      if (dataInicioIso && row.data_movimento < dataInicioIso) return false;
      if (dataFimIso && row.data_movimento > dataFimIso) return false;
      return true;
    });

    const uniqueRows = Array.from(
      new Map(filteredRows.map((row) => [String(row.omie_ncodmov), row])).values()
    );

    if (uniqueRows.length > 0) {
      const { error } = await db
        .from("fin_movimentacoes")
        .upsert(uniqueRows, { onConflict: "company,omie_ncodmov" });
      if (error) {
        console.error(`[Fin][${company}] Erro mov p${pagina}:`, error.message);
      } else {
        totalSynced += uniqueRows.length;
      }
      consecutiveEmptyPages = 0;
    } else {
      consecutiveEmptyPages++;
    }

    console.log(
      `[Fin][${company}] Mov p${pagina}/${totalPaginas} (+${uniqueRows.length}) empty_streak=${consecutiveEmptyPages}`
    );

    // Early exit after 30 consecutive empty pages
    if (consecutiveEmptyPages >= 30) {
      console.log(`[Fin][${company}] Mov early exit: 30 páginas vazias consecutivas`);
      break;
    }

    pagina--;
    pagesProcessed++;
  }

  const timedOut = isTimeBudgetExhausted();
  if (timedOut) console.log(`[Fin][${company}] Mov stopped: time budget exhausted`);

  return {
    totalSynced,
    complete: pagina < 1,
    nextPage: pagina < 1 ? null : pagina,
    timedOut,
  };
}

// ═══════════════ CALCULAR DRE SNAPSHOT ═══════════════
async function calcularDRE(
  db: ReturnType<typeof createClient>,
  company: Company,
  ano: number,
  mes: number
) {
  const inicioMes = `${ano}-${String(mes).padStart(2, "0")}-01`;
  const fimMes =
    mes === 12
      ? `${ano + 1}-01-01`
      : `${ano}-${String(mes + 1).padStart(2, "0")}-01`;

  // Regime de competência: usa data_vencimento pois Omie não retorna data_pagamento/data_recebimento
  // Receitas (contas a receber com vencimento no período e status pago/recebido)
  const { data: receitas } = await db
    .from("fin_contas_receber")
    .select("valor_documento, valor_recebido, categoria_codigo, categoria_descricao")
    .eq("company", company)
    .gte("data_vencimento", inicioMes)
    .lt("data_vencimento", fimMes)
    .in("status_titulo", ["RECEBIDO", "PARCIAL", "LIQUIDADO"]);

  // Despesas (contas a pagar com vencimento no período e status pago)
  const { data: despesas } = await db
    .from("fin_contas_pagar")
    .select("valor_documento, valor_pago, categoria_codigo, categoria_descricao")
    .eq("company", company)
    .gte("data_vencimento", inicioMes)
    .lt("data_vencimento", fimMes)
    .in("status_titulo", ["PAGO", "PARCIAL", "LIQUIDADO"]);

  // Buscar mapeamento configurável: empresa-específico tem prioridade sobre _default
  const { data: mappings } = await db
    .from("fin_categoria_dre_mapping")
    .select("omie_codigo, dre_linha, company")
    .in("company", [company, "_default"]);

  // Montar mapa de categorias → linha DRE (empresa-específico ganha)
  const catToDre = new Map<string, string>();
  for (const m of (mappings || []).sort((a: any, b: any) =>
    a.company === "_default" ? -1 : 1
  )) {
    catToDre.set(m.omie_codigo, m.dre_linha);
  }

  // Função de lookup que tenta match exato, depois prefix match
  function resolveCategoria(cod: string, desc: string, isReceita: boolean): string {
    // 1. Match exato
    if (catToDre.has(cod)) return catToDre.get(cod)!;
    // 2. Prefix match (ex: "1.01.02.003" → tenta "1.01.02", depois "1.01")
    const parts = cod.split(".");
    for (let i = parts.length - 1; i >= 2; i--) {
      const prefix = parts.slice(0, i).join(".");
      if (catToDre.has(prefix)) return catToDre.get(prefix)!;
    }
    // 3. Heurística por descrição (fallback)
    const upper = (desc + cod).toUpperCase();
    if (isReceita) {
      if (upper.includes("DEVOL") || upper.includes("CANCEL")) return "deducoes";
      if (upper.includes("FINANC") || upper.includes("REND") || upper.includes("JUROS REC")) return "receitas_financeiras";
      return "receita_bruta";
    } else {
      if (upper.includes("CMV") || upper.includes("CUSTO MERC") || upper.includes("CUSTO PROD") || upper.includes("MATÉRIA") || upper.includes("MATERIA")) return "cmv";
      if (upper.includes("DAS") || upper.includes("SIMPLES") || upper.includes("IRPJ") || upper.includes("CSLL") || upper.includes("PIS") || upper.includes("COFINS") || upper.includes("ISS") || upper.includes("ICMS") || upper.includes("IPI") || upper.includes("IMPOST") || upper.includes("TRIBUT")) return "impostos";
      if (upper.includes("JUROS") || upper.includes("IOF") || upper.includes("TARIFA BANC") || upper.includes("DESC CONCED")) return "despesas_financeiras";
      if (upper.includes("COMISS") || upper.includes("FRETE VEND") || upper.includes("MARKET") || upper.includes("PUBLICID") || upper.includes("PROPAGANDA") || upper.includes("VIAGEM") || upper.includes("REPRESENT")) return "despesas_comerciais";
      if (upper.includes("ALUGUE") || upper.includes("CONDOM") || upper.includes("SALÁR") || upper.includes("FOLHA") || upper.includes("ENCARGO") || upper.includes("FGTS") || upper.includes("INSS PATR") || upper.includes("CONTAB") || upper.includes("CONSULTORI") || upper.includes("SOFTWARE") || upper.includes("TELEFO") || upper.includes("INTERNET") || upper.includes("ENERGIA") || upper.includes("ÁGUA")) return "despesas_administrativas";
      return "despesas_operacionais";
    }
  }

  // Classificar receitas
  let receitaBruta = 0;
  let deducoes = 0;
  let receitasFinanceiras = 0;
  let outrasReceitas = 0;
  const detalheReceitas: Record<string, number> = {};
  const categoriasNaoMapeadas: string[] = [];

  for (const r of receitas || []) {
    const val = r.valor_recebido || 0;
    const cod = r.categoria_codigo || "";
    const desc = r.categoria_descricao || cod || "Sem categoria";
    detalheReceitas[desc] = (detalheReceitas[desc] || 0) + val;

    const linha = resolveCategoria(cod, desc, true);
    if (!catToDre.has(cod) && cod) categoriasNaoMapeadas.push(cod);

    switch (linha) {
      case "receita_bruta": receitaBruta += val; break;
      case "deducoes": deducoes += val; break;
      case "receitas_financeiras": receitasFinanceiras += val; break;
      case "outras_receitas": outrasReceitas += val; break;
      default: receitaBruta += val;
    }
  }

  // Classificar despesas
  let cmv = 0;
  let despesasOperacionais = 0;
  let despesasAdministrativas = 0;
  let despesasComerciais = 0;
  let despesasFinanceiras = 0;
  let impostos = 0;
  let outrasDespesas = 0;
  const detalheDespesas: Record<string, number> = {};

  for (const d of despesas || []) {
    const val = d.valor_pago || 0;
    const cod = d.categoria_codigo || "";
    const desc = d.categoria_descricao || cod || "Sem categoria";
    detalheDespesas[desc] = (detalheDespesas[desc] || 0) + val;

    const linha = resolveCategoria(cod, desc, false);
    if (!catToDre.has(cod) && cod) categoriasNaoMapeadas.push(cod);

    switch (linha) {
      case "cmv": cmv += val; break;
      case "despesas_administrativas": despesasAdministrativas += val; break;
      case "despesas_comerciais": despesasComerciais += val; break;
      case "despesas_financeiras": despesasFinanceiras += val; break;
      case "receitas_financeiras": receitasFinanceiras += val; break;
      case "impostos": impostos += val; break;
      case "outras_despesas": outrasDespesas += val; break;
      default: despesasOperacionais += val;
    }
  }

  const receitaLiquida = receitaBruta - deducoes;
  const lucroBruto = receitaLiquida - cmv;
  const totalDespesasOp =
    despesasOperacionais +
    despesasAdministrativas +
    despesasComerciais;
  const resultadoOperacional =
    lucroBruto - totalDespesasOp + receitasFinanceiras - despesasFinanceiras;
  const resultadoAntesImpostos =
    resultadoOperacional + outrasReceitas - outrasDespesas;
  const resultadoLiquido = resultadoAntesImpostos - impostos;

  // Log categorias não mapeadas para facilitar configuração
  const unique = [...new Set(categoriasNaoMapeadas)];
  if (unique.length > 0) {
    console.log(`[Fin][${company}] DRE ${mes}/${ano}: ${unique.length} categorias sem mapeamento explícito (heurística usada): ${unique.slice(0, 10).join(", ")}`);
  }

  const snapshot = {
    company,
    ano,
    mes,
    regime: "caixa", // Ponto 4: qualificar explicitamente
    receita_bruta: receitaBruta,
    deducoes,
    receita_liquida: receitaLiquida,
    cmv,
    lucro_bruto: lucroBruto,
    despesas_operacionais: despesasOperacionais,
    despesas_administrativas: despesasAdministrativas,
    despesas_comerciais: despesasComerciais,
    despesas_financeiras: despesasFinanceiras,
    receitas_financeiras: receitasFinanceiras,
    resultado_operacional: resultadoOperacional,
    outras_receitas: outrasReceitas,
    outras_despesas: outrasDespesas,
    resultado_antes_impostos: resultadoAntesImpostos,
    impostos,
    resultado_liquido: resultadoLiquido,
    qtd_categorias_sem_mapeamento: unique.length, // Ponto 5
    detalhamento: {
      receitas: detalheReceitas,
      despesas: detalheDespesas,
      categorias_nao_mapeadas: unique,
    },
    calculated_at: new Date().toISOString(),
  };

  const { error } = await db
    .from("fin_dre_snapshots")
    .upsert(snapshot, { onConflict: "company,ano,mes" });
  if (error) console.error(`[Fin][${company}] Erro DRE:`, error.message);

  return snapshot;
}

// ═══════════════ RESUMO RÁPIDO (sem sync, direto do DB) ═══════════════
async function getResumoFinanceiro(
  db: ReturnType<typeof createClient>,
  companies: Company[]
) {
  const resumo: Record<string, any> = {};

  for (const company of companies) {
    // Saldo total de contas correntes
    const { data: contas } = await db
      .from("fin_contas_correntes")
      .select("descricao, saldo_atual, banco")
      .eq("company", company)
      .eq("ativo", true);

    // Totais a receber em aberto
    const { data: crAberto } = await db
      .from("fin_contas_receber")
      .select("saldo")
      .eq("company", company)
      .in("status_titulo", ["ABERTO", "VENCIDO", "PARCIAL"]);

    // Totais a pagar em aberto
    const { data: cpAberto } = await db
      .from("fin_contas_pagar")
      .select("saldo")
      .eq("company", company)
      .in("status_titulo", ["ABERTO", "VENCIDO", "PARCIAL"]);

    // Vencidos a receber
    const { data: crVencido } = await db
      .from("fin_contas_receber")
      .select("saldo")
      .eq("company", company)
      .eq("status_titulo", "VENCIDO");

    // Vencidos a pagar
    const { data: cpVencido } = await db
      .from("fin_contas_pagar")
      .select("saldo")
      .eq("company", company)
      .eq("status_titulo", "VENCIDO");

    const sum = (arr: any[] | null) =>
      (arr || []).reduce((s: number, r: any) => s + (r.saldo || 0), 0);

    resumo[company] = {
      contas_correntes: contas || [],
      saldo_total_cc: (contas || []).reduce(
        (s: number, c: any) => s + (c.saldo_atual || 0),
        0
      ),
      total_a_receber: sum(crAberto),
      total_a_pagar: sum(cpAberto),
      total_vencido_receber: sum(crVencido),
      total_vencido_pagar: sum(cpVencido),
      posicao_liquida: sum(crAberto) - sum(cpAberto),
    };
  }

  return resumo;
}

// ═══════════════ HELPERS ═══════════════
function parseOmieDate(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  // Handle DD/MM/YYYY
  if (dateStr.includes("/")) {
    const [d, m, y] = dateStr.split("/");
    if (d && m && y) return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // Handle YYYY-MM-DD
  if (dateStr.match(/^\d{4}-\d{2}-\d{2}/)) return dateStr.substring(0, 10);
  return null;
}

function formatOmieDate(d: Date): string {
  return `${String(d.getDate()).padStart(2, "0")}/${String(
    d.getMonth() + 1
  ).padStart(2, "0")}/${d.getFullYear()}`;
}

// ═══════════════ AUTH HELPER ═══════════════
async function validateCaller(
  req: Request,
  db: ReturnType<typeof createClient>
): Promise<{ authorized: boolean; userId?: string; error?: string }> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { authorized: false, error: "Token ausente" };
  }
  const token = authHeader.replace("Bearer ", "");

  // Accept service_role key (for cron calls)
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (token === serviceKey) {
    return { authorized: true, userId: "service_role" };
  }

  // Validate JWT and check role
  const anonClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  );
  const { data: { user }, error } = await anonClient.auth.getUser();
  if (error || !user) {
    return { authorized: false, error: "Token inválido" };
  }

  // Check staff role (admin, manager, employee, master)
  const { data: roles } = await db
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .in("role", ["admin", "manager", "employee", "master"])
    .limit(1);

  if (!roles || roles.length === 0) {
    return { authorized: false, error: "Permissão negada: requer perfil de funcionário" };
  }

  return { authorized: true, userId: user.id };
}

// ═══════════════ SYNC LOG ═══════════════

async function logSync(
  db: ReturnType<typeof createClient>,
  action: string,
  companies: string[],
  triggeredBy: string
): Promise<string> {
  const { data } = await db
    .from("fin_sync_log")
    .insert({
      action,
      companies,
      status: "running",
      triggered_by: triggeredBy,
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  return data?.id || "";
}

async function completeSync(
  db: ReturnType<typeof createClient>,
  logId: string,
  results: any,
  errorMsg?: string,
  startTime?: number
) {
  if (!logId) return;
  // Try with observability columns first (migration 200500)
  const { error } = await db
    .from("fin_sync_log")
    .update({
      status: errorMsg ? "error" : "complete",
      results: results || {},
      error_message: errorMsg || null,
      completed_at: new Date().toISOString(),
      duracao_ms: startTime ? Date.now() - startTime : null,
      api_calls: apiCallCount,
      rate_limits_hit: rateLimitHits,
      entidades_por_empresa: results || {},
    })
    .eq("id", logId);

  // Fallback: if columns don't exist yet (200500 not applied), retry with base columns only
  if (error) {
    console.log(`[Fin] completeSync fallback (extra columns may not exist): ${error.message}`);
    await db
      .from("fin_sync_log")
      .update({
        status: errorMsg ? "error" : "complete",
        results: results || {},
        error_message: errorMsg || null,
        completed_at: new Date().toISOString(),
      })
      .eq("id", logId);
  }
}

// ═══════════════ HANDLER PRINCIPAL ═══════════════
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    // Auth check (Ponto 6)
    const auth = await validateCaller(req, supabase);
    if (!auth.authorized) {
      return new Response(
        JSON.stringify({ success: false, error: auth.error }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { action, company, companies, filtro_data_de, filtro_data_ate, ano, mes, meses, maxPages, entidade, ncodcc } =
      await req.json();

    const targetCompanies: Company[] = companies || (company ? [company] : ["oben", "colacor", "colacor_sc"]);

    // Reset global counters per invocation
    globalStartTime = Date.now();
    const startTime = globalStartTime;
    apiCallCount = 0;
    rateLimitHits = 0;
    const logId = await logSync(supabase, action, targetCompanies, auth.userId || "unknown");

    let result: any = {};

    switch (action) {
      case "sync_all": {
        // Ponto 2: inclui TODAS as entidades, incluindo movimentações
        for (const co of targetCompanies) {
          console.log(`[Fin] Sync completo ${co}...`);
          const cats = await syncCategorias(supabase, co);
          const ccs = await syncContasCorrentes(supabase, co);
          
          const dataInicio =
            filtro_data_de ||
            formatOmieDate(new Date(new Date().setMonth(new Date().getMonth() - 6)));
          const dataFim = filtro_data_ate || formatOmieDate(new Date());
          
          const cp = await syncContasPagar(supabase, co, dataInicio, dataFim, maxPages || 500);
          const cr = await syncContasReceber(supabase, co, dataInicio, dataFim, maxPages || 500);

          // Movimentações: últimos 3 meses (mais recente, volume menor)
          const dataInicioMov =
            filtro_data_de ||
            formatOmieDate(new Date(new Date().setMonth(new Date().getMonth() - 3)));
          const mov = await syncMovimentacoes(supabase, co, dataInicioMov, dataFim, maxPages || 500);

          result[co] = {
            categorias: cats,
            contas_correntes: ccs,
            contas_pagar: cp,
            contas_receber: cr,
            movimentacoes: mov,
          };
        }
        break;
      }

      case "sync_categorias": {
        for (const co of targetCompanies) {
          result[co] = await syncCategorias(supabase, co);
        }
        break;
      }

      case "sync_contas_correntes": {
        for (const co of targetCompanies) {
          result[co] = await syncContasCorrentes(supabase, co);
        }
        break;
      }

      case "sync_contas_pagar": {
        const dataInicio =
          filtro_data_de ||
          formatOmieDate(new Date(new Date().setMonth(new Date().getMonth() - 6)));
        const dataFim = filtro_data_ate || formatOmieDate(new Date());
        for (const co of targetCompanies) {
          result[co] = await syncContasPagar(supabase, co, dataInicio, dataFim, maxPages);
        }
        break;
      }

      case "sync_contas_receber": {
        const dataInicio =
          filtro_data_de ||
          formatOmieDate(new Date(new Date().setMonth(new Date().getMonth() - 6)));
        const dataFim = filtro_data_ate || formatOmieDate(new Date());
        for (const co of targetCompanies) {
          result[co] = await syncContasReceber(supabase, co, dataInicio, dataFim, maxPages);
        }
        break;
      }

      case "sync_movimentacoes": {
        const dataInicio =
          filtro_data_de ||
          formatOmieDate(new Date(new Date().setMonth(new Date().getMonth() - 3)));
        const dataFim = filtro_data_ate || formatOmieDate(new Date());
        for (const co of targetCompanies) {
          result[co] = await syncMovimentacoes(supabase, co, dataInicio, dataFim, maxPages);
        }
        break;
      }

      // Ponto 8: contrato unificado — aceita `mes` (number) ou `meses` (number[])
      case "calcular_dre": {
        const targetAno = ano || new Date().getFullYear();
        const targetMeses: number[] = meses
          ? meses
          : mes
            ? [mes]
            : [new Date().getMonth() + 1];

        for (const co of targetCompanies) {
          result[co] = {};
          for (const m of targetMeses) {
            result[co][`${m}`] = await calcularDRE(supabase, co, targetAno, m);
          }
        }
        break;
      }

      // Ponto 8: calcular_dre_year = todos os meses até o mês atual
      case "calcular_dre_year": {
        const targetAno = ano || new Date().getFullYear();
        const currentMonth = new Date().getFullYear() === targetAno ? new Date().getMonth() + 1 : 12;
        for (const co of targetCompanies) {
          result[co] = {};
          for (let m = 1; m <= currentMonth; m++) {
            result[co][`${m}`] = await calcularDRE(supabase, co, targetAno, m);
          }
        }
        break;
      }

      case "resumo": {
        result = await getResumoFinanceiro(supabase, targetCompanies);
        break;
      }

      // Debug: retorna JSON raw do Omie sem transformação (para validação Onda 1)
      case "debug_raw": {
        const endpoints: Record<string, { endpoint: string; call: string; params: any }> = {
          categorias: { endpoint: "geral/categorias/", call: "ListarCategorias", params: { pagina: 1, registros_por_pagina: 2 } },
          contas_correntes: { endpoint: "geral/contacorrente/", call: "ListarContasCorrentes", params: { pagina: 1, registros_por_pagina: 2 } },
          contas_pagar: { endpoint: "financas/contapagar/", call: "ListarContasPagar", params: { pagina: 1, registros_por_pagina: 2 } },
          contas_receber: { endpoint: "financas/contareceber/", call: "ListarContasReceber", params: { pagina: 1, registros_por_pagina: 2 } },
          movimentacoes: { endpoint: "financas/mf/", call: "ListarMovimentos", params: { nPagina: 1, nRegPorPagina: 2 } },
          resumir_cc: { endpoint: "geral/contacorrente/", call: "ResumirContaCorrente", params: { nCodCC: Number(ncodcc) || 0 } },
        };
        const ep = endpoints[entidade || "contas_pagar"];
        if (!ep) {
          result = { error: "Entidade inválida. Use o campo 'entidade'.", disponiveis: Object.keys(endpoints) };
        } else {
          for (const co of targetCompanies) {
            try {
              const raw = await callOmie(co, ep.endpoint, ep.call, ep.params);
              result[co] = { raw_response_keys: raw ? Object.keys(raw) : null, first_record_sample: null, total_paginas: null };
              if (raw) {
                result[co].total_paginas = raw.total_de_paginas || raw.nTotPaginas || null;
                // Find the array of records
                for (const key of Object.keys(raw)) {
                  if (Array.isArray(raw[key]) && raw[key].length > 0) {
                    result[co].first_record_sample = raw[key][0];
                    result[co].array_key = key;
                    result[co].record_count = raw[key].length;
                    break;
                  }
                }
              }
            } catch (e) { result[co] = { error: String(e) }; }
          }
        }
        break;
      }

      default:
        await completeSync(supabase, logId, null, `Ação desconhecida: ${action}`, startTime);
        return new Response(
          JSON.stringify({
            error: `Ação desconhecida: ${action}`,
            acoes_disponiveis: [
              "sync_all", "sync_categorias", "sync_contas_correntes",
              "sync_contas_pagar", "sync_contas_receber", "sync_movimentacoes",
              "calcular_dre", "calcular_dre_year", "resumo", "debug_raw",
            ],
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    // Log sucesso (Ponto 11)
    await completeSync(supabase, logId, result, undefined, startTime);

    return new Response(JSON.stringify({ success: true, action, ...result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[Fin] Erro:", error);
    return new Response(
      JSON.stringify({ success: false, error: String(error) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
