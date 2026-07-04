import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

// ═══════════════ VALIDAÇÃO DE PERÍODO DO DRE (anti-injeção) ═══════════════
// ⚠️ ESPELHO VERBATIM de src/lib/financeiro/dre-period.ts (testado em vitest).
// Fecha injeção PostgREST via ano/mes crus no .or() do calcularDRE + evita
// persistir DRE de período inválido. Editou aqui? Edite lá também.
class DrePeriodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DrePeriodError";
  }
}

function asInteger(value: unknown, field: string): number {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new DrePeriodError(`${field} deve ser inteiro (recebido: ${value})`);
    }
    return value;
  }
  if (typeof value === "string") {
    const t = value.trim();
    if (!/^\d+$/.test(t)) {
      throw new DrePeriodError(`${field} inválido (recebido: "${value}")`);
    }
    return Number(t);
  }
  throw new DrePeriodError(`${field} inválido (recebido: ${String(value)})`);
}

function validateAno(ano: unknown): number {
  const n = asInteger(ano, "ano");
  if (n < 2000 || n > 2100) {
    throw new DrePeriodError(`ano fora do intervalo 2000-2100 (recebido: ${n})`);
  }
  return n;
}

function validateMes(mes: unknown): number {
  const n = asInteger(mes, "mes");
  if (n < 1 || n > 12) {
    throw new DrePeriodError(`mes fora do intervalo 1-12 (recebido: ${n})`);
  }
  return n;
}

function resolveDrePeriod(input: {
  ano?: unknown;
  mes?: unknown;
  meses?: unknown;
  defaultAno: number;
  defaultMes: number;
}): { ano: number; meses: number[] } {
  const ano = input.ano == null ? input.defaultAno : validateAno(input.ano);
  let meses: number[];
  if (input.meses != null) {
    if (!Array.isArray(input.meses)) {
      throw new DrePeriodError("meses deve ser um array de inteiros");
    }
    if (input.meses.length === 0) {
      throw new DrePeriodError("meses não pode ser vazio");
    }
    meses = input.meses.map((m) => validateMes(m));
  } else if (input.mes != null) {
    meses = [validateMes(input.mes)];
  } else {
    meses = [input.defaultMes];
  }
  return { ano, meses };
}

// ═══════════════ VALIDAÇÃO DE EMPRESA (allow-list) ═══════════════
// ⚠️ ESPELHO VERBATIM de src/lib/financeiro/omie-request.ts (testado em vitest).
// Valida company/companies do body contra o allow-list (evita resultado vazio /
// chave-lixo silenciosa). Editou aqui? Edite lá também.
const ALLOWED_COMPANIES = ["oben", "colacor", "colacor_sc"] as const;

class OmieRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OmieRequestError";
  }
}

function validateCompany(value: unknown, allowed: readonly string[]): string {
  if (typeof value === "string" && allowed.includes(value)) {
    return value;
  }
  throw new OmieRequestError(`company inválida (recebido: ${JSON.stringify(value)})`);
}

function resolveCompanies(input: {
  companies?: unknown;
  company?: unknown;
  allowed: readonly string[];
}): string[] {
  const { companies, company, allowed } = input;
  if (companies != null) {
    if (!Array.isArray(companies)) {
      throw new OmieRequestError("companies deve ser um array");
    }
    if (companies.length === 0) {
      throw new OmieRequestError("companies não pode ser vazio");
    }
    return companies.map((c) => validateCompany(c, allowed));
  }
  if (company != null) {
    return [validateCompany(company, allowed)];
  }
  return [...allowed];
}

// ═══════════════ GATE DE ACESSO FINANCEIRO ═══════════════
// ⚠️ ESPELHO VERBATIM de src/lib/financeiro/omie-request.ts (testado em vitest).
// Autoriza master (user_roles) OU gestor comercial (commercial_roles em
// GESTOR_COMMERCIAL_ROLES). Espelha o gate do fin-valor-cockpit. Editou aqui?
// Edite lá também.
const GESTOR_COMMERCIAL_ROLES = ["gerencial", "estrategico", "super_admin"] as const;

function hasFinanceiroAccess(input: {
  userRoles: ReadonlyArray<{ role?: string | null }> | null | undefined;
  commercialRoles: ReadonlyArray<{ commercial_role?: string | null }> | null | undefined;
}): boolean {
  const isMaster = (input.userRoles ?? []).some((r) => r?.role === "master");
  if (isMaster) return true;
  const gestor = new Set<string>(GESTOR_COMMERCIAL_ROLES);
  return (input.commercialRoles ?? []).some(
    (c) => c?.commercial_role != null && gestor.has(c.commercial_role),
  );
}

type OmieGenericResponse = Record<string, unknown> & { faultstring?: string };

interface OmieListResponse<T> {
  total_de_paginas?: number;
  nTotPaginas?: number;
  faultstring?: string;
  [key: string]: T[] | number | string | undefined;
}

interface OmieCategoria {
  codigo?: string;
  descricao?: string;
  tipo_categoria?: string;
  codigo_conta_pai?: string | null;
  nivel?: number;
  conta_totalizadora?: string;
  conta_inativa?: string;
}

interface OmieContaCorrente {
  nCodCC?: number;
  descricao?: string;
  cDescricao?: string;
  codigo_banco?: string;
  cNomeBanco?: string;
  banco?: string;
  codigo_agencia?: string;
  cAgencia?: string;
  agencia?: string;
  numero_conta_corrente?: string;
  cNumeroConta?: string;
  numero_conta?: string;
  tipo_conta_corrente?: string;
  tipo?: string;
  cTipo?: string;
  inativo?: string;
  cInativa?: string;
}

// Resposta de financas/extrato/ ListarExtrato — saldos no top-level.
interface OmieExtratoResponse {
  nSaldoAtual?: number;        // saldo realizado disponível hoje
  nSaldoDisponivel?: number;   // saldo disponível hoje (fallback)
}

interface OmieContaPagar {
  codigo_lancamento_omie?: number;
  nCodTitulo?: number;
  codigo_lancamento?: number;
  codigo_cliente_fornecedor_integracao?: string | null;
  codigo_cliente_fornecedor?: number;
  nome_cliente_fornecedor?: string;
  nome_fornecedor?: string;
  cnpj_cpf?: string;
  numero_documento?: string;
  cNumDocumento?: string;
  numero_documento_fiscal?: string | null;
  data_emissao?: string;
  dDtEmissao?: string;
  data_vencimento?: string;
  dDtVenc?: string;
  data_pagamento?: string;
  dDtPagamento?: string;
  data_previsao?: string;
  dDtPreworst?: string;
  valor_documento?: number;
  nValorTitulo?: number;
  valor_pago?: number;
  nValorPago?: number;
  valor_desconto?: number;
  valor_juros?: number;
  valor_multa?: number;
  status_titulo?: string;
  codigo_categoria?: string;
  cCodCateg?: string;
  descricao_categoria?: string;
  departamento?: string | null;
  centro_custo?: string | null;
  observacao?: string | null;
  nCodCC?: number | null;
  codigo_barras?: string | null;
  tipo_documento?: string | null;
  id_origem?: string | null;
  parcela?: number;
  total_parcelas?: number;
  baixa_obs?: string;
}

interface OmieContaReceber {
  codigo_lancamento_omie?: number;
  nCodTitulo?: number;
  codigo_lancamento?: number;
  codigo_cliente_fornecedor?: number;
  codigo_cliente_fornecedor_integracao?: string | null;
  nome_cliente_fornecedor?: string;
  nome_cliente?: string;
  cnpj_cpf?: string;
  numero_documento?: string;
  numero_documento_fiscal?: string | null;
  numero_pedido?: string | null;
  data_emissao?: string;
  dDtEmissao?: string;
  data_vencimento?: string;
  dDtVenc?: string;
  data_recebimento?: string;
  dDtPagamento?: string;
  data_previsao?: string;
  valor_documento?: number;
  nValorTitulo?: number;
  valor_recebido?: number;
  nValorPago?: number;
  valor_desconto?: number;
  valor_juros?: number;
  valor_multa?: number;
  status_titulo?: string;
  codigo_categoria?: string;
  cCodCateg?: string;
  descricao_categoria?: string;
  departamento?: string | null;
  centro_custo?: string | null;
  observacao?: string | null;
  nCodCC?: number | null;
  nCodVend?: number | null;
  tipo_documento?: string | null;
  id_origem?: string | null;
  parcela?: number;
  total_parcelas?: number;
}

interface OmieMovimentoDetalhes {
  nCodTitulo?: number;
  nCodCC?: number | null;
  cGrupo?: string;
  cNatureza?: string;
  cOrigem?: string;
  cStatus?: string;
  cNumDocFiscal?: string;
  cNumTitulo?: string;
  cNumOS?: string;
  cNumParcela?: string;
  cCodCateg?: string;
  dDtPagamento?: string;
  dDtRegistro?: string;
  dDtPrevisao?: string;
  dDtVenc?: string;
  dDtEmissao?: string;
  nValorTitulo?: number;
}

interface OmieMovimentoResumo {
  nValPago?: number;
  nValLiquido?: number;
  nDesconto?: number;
  nJuros?: number;
  nMulta?: number;
}

interface OmieMovimento {
  detalhes?: OmieMovimentoDetalhes;
  resumo?: OmieMovimentoResumo;
}

interface MovimentoRow {
  company: Company;
  omie_ncodmov: string;
  omie_ncodcc: number | null;
  data_movimento: string;
  tipo: string;
  valor: number;
  descricao: string;
  categoria_codigo: string;
  categoria_descricao: string;
  conciliado: boolean;
  omie_codigo_lancamento: number | null;
  natureza: string | null;
  metadata: null; // antes {detalhes, resumo} bruto; agora não persistido (peso morto)
  updated_at: string;
}

interface CategoriaDreMappingRow {
  omie_codigo: string;
  dre_linha: string;
  company: string;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const OMIE_API_URL = "https://app.omie.com.br/api/v1";

async function setAuditOrigem(
  supabase: ReturnType<typeof createClient>,
  origem: 'omie_sync' | 'edge_fn' | 'cron',
): Promise<void> {
  // Wrapper RPC restrito ao namespace 'fin.'. Session-level (is_local=false)
  // permite que mutações subsequentes nesta conexão herdem o valor.
  await supabase.rpc('set_config', {
    parameter: 'fin.origem',
    value: origem,
    is_local: false,
  });
}

// Observability counters (reset per invocation)
let apiCallCount = 0;
let rateLimitHits = 0;
let globalStartTime = Date.now();
// 100s (não 130s): folga real antes do kill DURO de 150s da edge fn. Como o
// budget é checado no TOPO de cada página, um callOmie/upsert lento começando
// perto do teto pode overshootar os 150s e a plataforma mata a função
// mid-página → linha fin_sync_log órfã em 'running' (medido: mov p95 129s/max
// 131s raspava os 130s antigos). Todos os syncs que usam isto têm cursor de
// continuação + cron */10, então mais ciclos é trade aceitável por zero órfã.
const TIME_BUDGET_MS = 100_000;

function isTimeBudgetExhausted(): boolean {
  return Date.now() - globalStartTime >= TIME_BUDGET_MS;
}

type Company = "oben" | "colacor" | "colacor_sc";

function getCredentials(company: Company) {
  switch (company) {
    case "oben":
      return {
        key: Deno.env.get("OMIE_OBEN_APP_KEY"),
        secret: Deno.env.get("OMIE_OBEN_APP_SECRET"),
      };
    case "colacor":
      return {
        key: Deno.env.get("OMIE_COLACOR_APP_KEY"),
        secret: Deno.env.get("OMIE_COLACOR_APP_SECRET"),
      };
    case "colacor_sc":
      return {
        key: Deno.env.get("OMIE_COLACOR_SC_APP_KEY"),
        secret: Deno.env.get("OMIE_COLACOR_SC_APP_SECRET"),
      };
  }
}

// ── Classificação de faults do Omie (decide política de retry) ──────────────
// ⚠️ ESPELHADO VERBATIM de src/lib/omie/omie-fault.ts (testado em vitest).
// Qualquer mudança aqui deve refletir lá e vice-versa.
type OmieFaultClass = 'rate_limit' | 'transient' | 'fatal';

function classifyOmieFault(faultstring: string | null | undefined): OmieFaultClass {
  const fs = faultstring ?? '';

  if (
    fs.includes('Já existe uma requisição desse método') ||
    fs.includes('Consumo redundante') ||
    fs.includes('consumo redundante') ||
    fs.includes('REDUNDANT')
  ) {
    return 'rate_limit';
  }

  // Transitório: instabilidade de infra do servidor do Omie. NÃO inclui o
  // "SOAP-ERROR" genérico (SOAP fault também cobre erro de contrato/cliente).
  if (
    fs.includes('Broken response') ||
    fs.includes('Application Server') ||
    fs.includes('ERROR_INTERNAL') ||
    fs.includes('Internal Server Error') ||
    fs.includes('Service Unavailable') ||
    fs.includes('Service Temporarily Unavailable')
  ) {
    return 'transient';
  }

  return 'fatal';
}

// Backoff curto com jitter pra faults transitórios (1s, 2s, 4s + jitter, cap 4s).
// Curto de propósito: o budget de invocação é 100s; o cursor de continuação */10
// retoma o que faltar. Jitter evita sincronizar as 3 empresas e piorar rate-limit.
async function transientBackoff(attempt: number, company: string, reason: string): Promise<void> {
  const base = Math.min(1000 * 2 ** attempt, 4000);
  const delay = base + Math.floor(Math.random() * 500);
  console.log(`[Fin][${company}] Omie transitório, retry em ${(delay / 1000).toFixed(1)}s: ${reason}`);
  await new Promise((r) => setTimeout(r, delay));
}

async function callOmie(
  company: Company,
  endpoint: string,
  call: string,
  params: Record<string, unknown>
): Promise<OmieGenericResponse | null> {
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
    // 1) fetch — erro de REDE (DNS/conexão/timeout) é transitório.
    // AbortSignal.timeout(30s): teto DURO por request. Sem ele, um fetch pendurado
    // deixaria a invocação viva ALÉM do TTL do lease (300s) → outra invocação roubaria
    // o lease e rodaria concorrente na mesma conta (o buraco que o lease fecha). Com o
    // teto, a invocação nunca passa de ~budget(100s)+30s << TTL. O TimeoutError cai aqui
    // no catch de rede → tratado como transitório (retry). (Revisão Codex 2026-07-04.)
    let res: Response;
    try {
      res = await fetch(`${OMIE_API_URL}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (netErr) {
      if (attempt < maxRetries && !isTimeBudgetExhausted()) {
        await transientBackoff(attempt, company, `rede: ${String(netErr).slice(0, 50)}`);
        continue;
      }
      throw netErr instanceof Error ? netErr : new Error(`Omie (${company}): ${String(netErr)}`);
    }
    apiCallCount++;

    // 2) HTTP status ANTES de parsear: 429 = rate-limit, 5xx = transitório, demais 4xx = fatal.
    if (!res.ok) {
      if (res.status === 429 && attempt < maxRetries && !isTimeBudgetExhausted()) {
        rateLimitHits++;
        console.log(`[Fin][${company}] HTTP 429, waiting 5s`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      if (res.status >= 500 && attempt < maxRetries && !isTimeBudgetExhausted()) {
        await transientBackoff(attempt, company, `HTTP ${res.status}`);
        continue;
      }
      throw new Error(`Omie (${company}): HTTP ${res.status}`);
    }

    // 3) parse — corpo 200 não-JSON / quebrado é transitório.
    let result: OmieGenericResponse;
    try {
      result = (await res.json()) as OmieGenericResponse;
    } catch (parseErr) {
      if (attempt < maxRetries && !isTimeBudgetExhausted()) {
        await transientBackoff(attempt, company, `corpo não-JSON`);
        continue;
      }
      throw new Error(`Omie (${company}): resposta não-JSON (${String(parseErr).slice(0, 50)})`);
    }

    // 4) faultstring — classifica e aplica política por classe.
    if (result.faultstring) {
      const fs = String(result.faultstring);
      const klass = classifyOmieFault(fs);
      if (klass === "rate_limit" && attempt < maxRetries) {
        rateLimitHits++;
        const waitMatch = fs.match(/Aguarde (\d+) segundos/);
        const requestedDelay = waitMatch ? parseInt(waitMatch[1]) : (attempt + 1) * 5;
        const delay = Math.min(requestedDelay + 2, 15) * 1000;
        console.log(`[Fin][${company}] Rate limit, waiting ${delay / 1000}s`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      if (klass === "transient" && attempt < maxRetries && !isTimeBudgetExhausted()) {
        await transientBackoff(attempt, company, fs.slice(0, 70));
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
  db: SupabaseClient,
  company: Company
) {
  let pagina = 1;
  let totalPaginas = 1;
  let totalSynced = 0;

  while (pagina <= totalPaginas) {
    const result = await callOmie(
      company,
      "geral/categorias/",
      "ListarCategorias",
      { pagina, registros_por_pagina: 500 }
    );
    if (!result) break;

    totalPaginas = (result.total_de_paginas as number) || 1;
    const categorias = (result.categoria_cadastro as OmieCategoria[] | undefined) || [];

    const rows = categorias.map((c) => ({
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
  db: SupabaseClient,
  company: Company
) {
  let pagina = 1;
  let totalPaginas = 1;
  let totalSynced = 0;

  while (pagina <= totalPaginas) {
    const result = await callOmie(
      company,
      "geral/contacorrente/",
      "ListarContasCorrentes",
      { pagina, registros_por_pagina: 50 }
    );
    if (!result) break;

    totalPaginas = (result.nTotPaginas as number) || 1;
    const contas = (result.ListarContasCorrentes as OmieContaCorrente[] | undefined)
      || (result.conta_corrente_lista as OmieContaCorrente[] | undefined)
      || [];

    // Saldo atual vem de financas/extrato/ (ListarExtrato), NÃO de geral/contacorrente/.
    // dPeriodoInicial/Final são obrigatórios (DD/MM/AAAA); pra saldo "hoje" usamos a data atual nos dois.
    const hoje = new Date();
    const dataBR = `${String(hoje.getDate()).padStart(2, "0")}/${String(hoje.getMonth() + 1).padStart(2, "0")}/${hoje.getFullYear()}`;

    for (const c of contas) {
      // Busca saldo real via ListarExtrato (cExibirApenasSaldo=S => só os saldos, sem movimentos).
      let saldoAtual: number | null = null;
      let saldoData: string | null = null;
      let saldoOk = false;
      try {
        const saldoResult = (await callOmie(
          company,
          "financas/extrato/",
          "ListarExtrato",
          {
            nCodCC: c.nCodCC,
            dPeriodoInicial: dataBR,
            dPeriodoFinal: dataBR,
            cExibirApenasSaldo: "S",
          }
        )) as OmieExtratoResponse | null;
        if (saldoResult && (saldoResult.nSaldoAtual != null || saldoResult.nSaldoDisponivel != null)) {
          saldoAtual = saldoResult.nSaldoAtual ?? saldoResult.nSaldoDisponivel ?? null;
          saldoData = new Date().toISOString().split("T")[0];
          saldoOk = true;
        }
      } catch (e) {
        // NÃO zera em falha: preserva o saldo anterior (não inclui saldo_atual no upsert).
        console.log(`[Fin][${company}] Saldo CC ${c.nCodCC} falhou, preservando saldo anterior: ${e}`);
      }

      const row: Record<string, unknown> = {
        company,
        omie_ncodcc: c.nCodCC,
        descricao: c.descricao || c.cDescricao,
        banco: c.codigo_banco || c.cNomeBanco || c.banco,
        agencia: c.codigo_agencia || c.cAgencia || c.agencia,
        numero_conta: c.numero_conta_corrente || c.cNumeroConta || c.numero_conta,
        tipo: c.tipo_conta_corrente || c.tipo || c.cTipo || "CC",
        ativo: c.inativo !== "S" && c.cInativa !== "S",
        updated_at: new Date().toISOString(),
      };
      // Só grava saldo quando o extrato respondeu; em falha, o upsert não mexe em saldo_atual/saldo_data.
      if (saldoOk) {
        row.saldo_atual = saldoAtual;
        row.saldo_data = saldoData;
      }

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
  db: SupabaseClient,
  company: Company,
  filtroDataDe?: string,
  filtroDataAte?: string,
  maxPages = 500,
  startPage = 1
) {
  // Ver nota em syncContasReceber: 100 = limite real do Omie; paginação data-driven —
  // pagina até a página VAZIA (fim real), não confia no total_de_paginas sub-reportado.
  const PAGE_SIZE = 100;
  let pagina = startPage;
  let totalPaginas = 1;
  let totalSynced = 0;
  let pagesProcessed = 0;
  let reachedEnd = false;
  let lastFingerprint = "";

  while (pagesProcessed < maxPages && !isTimeBudgetExhausted()) {
    const result = await callOmie(
      company,
      "financas/contapagar/",
      "ListarContasPagar",
      { pagina, registros_por_pagina: PAGE_SIZE }
    );
    if (!result) break;

    totalPaginas = (result.total_de_paginas as number) || 1; // só p/ log/sanity
    const titulos: OmieContaPagar[] =
      (result.conta_pagar_cadastro as OmieContaPagar[] | undefined)
      || (result.titulosEncontrados as OmieContaPagar[] | undefined)
      || [];
    if (titulos.length === 0) { reachedEnd = true; break; } // página vazia = fim real
    const fp = `${(titulos[0] as { codigo_lancamento_omie?: number })?.codigo_lancamento_omie ?? ""}:${titulos.length}`;
    if (fp === lastFingerprint) { console.error(`[Fin][${company}] CP p${pagina}: página repetida (anomalia Omie) — parando`); reachedEnd = true; break; }
    lastFingerprint = fp;

    const rows = titulos.map((t) => {
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
    const validRows = rows.filter((r) => r.omie_codigo_lancamento != null);
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

    console.log(`[Fin][${company}] CP p${pagina}/${totalPaginas} (+${validRows.length})`);
    pagina++;
    pagesProcessed++;
  }

  const timedOut = isTimeBudgetExhausted();
  if (timedOut) console.log(`[Fin][${company}] CP stopped: time budget exhausted`);
  return {
    totalSynced,
    complete: reachedEnd,
    nextPage: reachedEnd ? null : pagina,
    timedOut,
  };
}

// ═══════════════ SYNC CONTAS A RECEBER ═══════════════
async function syncContasReceber(
  db: SupabaseClient,
  company: Company,
  filtroDataDe?: string,
  filtroDataAte?: string,
  maxPages = 500,
  startPage = 1
) {
  // 100 = limite real do Omie p/ contareceber. O 500 antigo era IGNORADO pelo Omie
  // (retornava 100/pág) mas o total_de_paginas vinha sub-reportado p/ listas grandes →
  // a paginação parava cedo e perdia os títulos recentes (colacor: ~29k no Omie, só
  // ~12.8k sincronizados, faltando 3,5 anos de recebíveis). Paginação agora é data-driven:
  // pagina até a página VAZIA (fim real). Página parcial no meio NÃO trunca.
  const PAGE_SIZE = 100;
  let pagina = startPage;
  let totalPaginas = 1;
  let totalSynced = 0;
  let pagesProcessed = 0;
  let reachedEnd = false;
  let lastFingerprint = "";

  while (pagesProcessed < maxPages && !isTimeBudgetExhausted()) {
    const result = await callOmie(
      company,
      "financas/contareceber/",
      "ListarContasReceber",
      { pagina, registros_por_pagina: PAGE_SIZE }
    );
    if (!result) break;

    totalPaginas = (result.total_de_paginas as number) || 1; // só p/ log/sanity
    const titulos: OmieContaReceber[] =
      (result.conta_receber_cadastro as OmieContaReceber[] | undefined)
      || (result.titulosEncontrados as OmieContaReceber[] | undefined)
      || [];
    if (titulos.length === 0) { reachedEnd = true; break; } // página vazia = fim real
    // Guard anti-loop: se o Omie repetir a mesma página (em vez de vazia além do fim),
    // pararíamos só no maxPages e o cursor resumiria pra sempre. Fingerprint = 1º código
    // + count; página repetida = fim (anômalo, logado).
    const fp = `${(titulos[0] as { codigo_lancamento_omie?: number })?.codigo_lancamento_omie ?? ""}:${titulos.length}`;
    if (fp === lastFingerprint) { console.error(`[Fin][${company}] CR p${pagina}: página repetida (anomalia Omie) — parando`); reachedEnd = true; break; }
    lastFingerprint = fp;

    const rows = titulos.map((t) => {
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

    const validRows = rows.filter((r) => r.omie_codigo_lancamento != null);
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

    console.log(`[Fin][${company}] CR p${pagina}/${totalPaginas} (+${validRows.length})`);
    pagina++;
    pagesProcessed++;
  }

  const timedOut = isTimeBudgetExhausted();
  if (timedOut) console.log(`[Fin][${company}] CR stopped: time budget exhausted`);
  return {
    totalSynced,
    complete: reachedEnd,
    nextPage: reachedEnd ? null : pagina,
    timedOut,
  };
}

// ═══════════════ SYNC MOVIMENTAÇÕES FINANCEIRAS ═══════════════
function buildSyntheticMovementId(company: Company, detalhes: OmieMovimentoDetalhes, resumo: OmieMovimentoResumo) {
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

function resolveMovementDate(detalhes: OmieMovimentoDetalhes) {
  return parseOmieDate(
    detalhes.dDtPagamento ||
      detalhes.dDtRegistro ||
      detalhes.dDtPrevisao ||
      detalhes.dDtVenc ||
      detalhes.dDtEmissao
  );
}

function resolveMovementType(detalhes: OmieMovimentoDetalhes) {
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

function resolveMovementDescription(detalhes: OmieMovimentoDetalhes) {
  const parts = [
    detalhes.cGrupo,
    detalhes.cNumDocFiscal || detalhes.cNumTitulo || detalhes.cNumOS,
    detalhes.cStatus,
  ].filter(Boolean);

  return parts.join(" · ") || "Movimentação financeira";
}

async function syncMovimentacoes(
  db: SupabaseClient,
  company: Company,
  filtroDataDe?: string,
  filtroDataAte?: string,
  maxPages = 500,
  startPage?: number,
  // Páginas vazias consecutivas que disparam o early-exit. 30 no incremental
  // (para logo após a janela de 3 meses). No backfill (janela ampla) sobe pra
  // 300 — senão buracos longos no histórico encerrariam o backfill cedo.
  maxEmptyPages = 30,
) {
  const dataInicioIso = parseOmieDate(filtroDataDe) || null;
  const dataFimIso = parseOmieDate(filtroDataAte) || null;

  let pagina = 1;
  let totalPaginas = 1;
  let totalSynced = 0;
  let pagesProcessed = 0;
  let consecutiveEmptyPages = 0;

  const firstPage = await callOmie(
    company,
    "financas/mf/",
    "ListarMovimentos",
    { nPagina: 1, nRegPorPagina: 100 }
  );

  if (!firstPage) {
    return { totalSynced: 0, complete: true, nextPage: null, timedOut: false };
  }

  totalPaginas = (firstPage.nTotPaginas as number) || 1;
  // Start from the last page (most recent data) and go backwards.
  // Se startPage veio do cursor (resume), retoma de lá.
  pagina = startPage ?? totalPaginas;

  while (pagina >= 1 && pagesProcessed < maxPages && !isTimeBudgetExhausted()) {
    const result = await callOmie(
      company,
      "financas/mf/",
      "ListarMovimentos",
      { nPagina: pagina, nRegPorPagina: 100 }
    );
    if (!result) break;

    const movs: OmieMovimento[] = (result.movimentos as OmieMovimento[] | undefined) || [];

    const rows = movs
      .map((mov): MovimentoRow | null => {
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
          // metadata era {detalhes, resumo} = payload Omie BRUTO (85% da linha,
          // ~1KB) que NINGUÉM lê (todos os campos úteis já estão normalizados
          // acima). Peso morto que engordava o upsert por página. Null daqui pra
          // frente; sem backfill (~8MB nas ~8k linhas antigas é irrelevante).
          metadata: null,
          updated_at: new Date().toISOString(),
        };
      })
      .filter((r): r is MovimentoRow => r !== null);

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

    // Early exit after N consecutive empty pages (N=30 incremental, 300 backfill)
    if (consecutiveEmptyPages >= maxEmptyPages) {
      console.log(`[Fin][${company}] Mov early exit: ${maxEmptyPages} páginas vazias consecutivas`);
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

// ═══════════════ Onda 3a — DRE v2 estrutural (regime-aware) ═══════════════
// Espelho VERBATIM de src/lib/financeiro/dre-helpers.ts (testado em vitest).
// Qualquer mudança aqui deve ser refletida lá e vice-versa.
type RegimeTributario = 'simples' | 'presumido';

const REGIME_POR_EMPRESA: Record<string, RegimeTributario> = {
  colacor: 'presumido',
  oben: 'presumido',
  colacor_sc: 'simples',
};

type DreLinha =
  | 'receita_bruta' | 'deducoes' | 'receitas_financeiras' | 'outras_receitas'
  | 'cmv' | 'despesas_operacionais' | 'despesas_administrativas' | 'despesas_comerciais'
  | 'despesas_financeiras' | 'outras_despesas'
  | 'ded_icms' | 'ded_iss' | 'ded_pis' | 'ded_cofins' | 'ded_ipi'
  | 'das' | 'irpj' | 'csll';

const DRE_LINHAS_VALIDAS = new Set<string>([
  'receita_bruta', 'deducoes', 'receitas_financeiras', 'outras_receitas',
  'cmv', 'despesas_operacionais', 'despesas_administrativas', 'despesas_comerciais',
  'despesas_financeiras', 'outras_despesas',
  'ded_icms', 'ded_iss', 'ded_pis', 'ded_cofins', 'ded_ipi', 'das', 'irpj', 'csll',
  'impostos',
]);

type ResultadoClassificacao = {
  linha: DreLinha;
  mapeado: boolean;
  viaFallback: boolean;
  impostoNaoMapeado: boolean;
};

function impostoPorKeyword(upper: string, regime: RegimeTributario): DreLinha | null {
  const tem = (s: string) => upper.includes(s);
  if (regime === 'simples') {
    if (tem('DAS') || tem('SIMPLES') || tem('IRPJ') || tem('CSLL') || tem('PIS') ||
        tem('COFINS') || tem('ISS') || tem('ICMS') || tem('IPI') || tem('IMPOST') || tem('TRIBUT')) {
      return 'das';
    }
    return null;
  }
  if (tem('IRPJ')) return 'irpj';
  if (tem('CSLL')) return 'csll';
  if (tem('COFINS')) return 'ded_cofins';
  if (tem('PIS')) return 'ded_pis';
  if (tem('ISS')) return 'ded_iss';
  if (tem('ICMS')) return 'ded_icms';
  if (tem('IPI')) return 'ded_ipi';
  if (tem('DAS') || tem('SIMPLES') || tem('IMPOST') || tem('TRIBUT')) return 'ded_icms';
  return null;
}

function normalizarImpostoLegado(linha: string, regime: RegimeTributario): DreLinha {
  if (linha !== 'impostos') return linha as DreLinha;
  return regime === 'simples' ? 'das' : 'ded_icms';
}

function classificarLinhaDRE(input: {
  categoria_codigo: string;
  categoria_descricao: string;
  isReceita: boolean;
  regime: RegimeTributario;
  mapping: Map<string, string>;
}): ResultadoClassificacao {
  const { categoria_codigo: cod, categoria_descricao: desc, isReceita, regime, mapping } = input;
  if (cod && mapping.has(cod)) {
    const raw = mapping.get(cod)!;
    const linha = DRE_LINHAS_VALIDAS.has(raw) ? normalizarImpostoLegado(raw, regime) : (isReceita ? 'receita_bruta' : 'despesas_operacionais');
    return { linha, mapeado: true, viaFallback: false, impostoNaoMapeado: false };
  }
  if (cod) {
    const parts = cod.split('.');
    for (let i = parts.length - 1; i >= 2; i--) {
      const prefix = parts.slice(0, i).join('.');
      if (mapping.has(prefix)) {
        const raw = mapping.get(prefix)!;
        const linha = DRE_LINHAS_VALIDAS.has(raw) ? normalizarImpostoLegado(raw, regime) : (isReceita ? 'receita_bruta' : 'despesas_operacionais');
        return { linha, mapeado: true, viaFallback: false, impostoNaoMapeado: false };
      }
    }
  }
  const upper = (desc + ' ' + cod).toUpperCase();
  if (isReceita) {
    if (upper.includes('DEVOL') || upper.includes('CANCEL')) return { linha: 'deducoes', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
    if (upper.includes('FINANC') || upper.includes('REND') || upper.includes('JUROS REC')) return { linha: 'receitas_financeiras', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
    return { linha: 'receita_bruta', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
  }
  const imp = impostoPorKeyword(upper, regime);
  if (imp) return { linha: imp, mapeado: false, viaFallback: true, impostoNaoMapeado: true };
  if (upper.includes('CMV') || upper.includes('CUSTO MERC') || upper.includes('CUSTO PROD') || upper.includes('MATÉRIA') || upper.includes('MATERIA')) return { linha: 'cmv', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
  if (upper.includes('JUROS') || upper.includes('IOF') || upper.includes('TARIFA BANC') || upper.includes('DESC CONCED')) return { linha: 'despesas_financeiras', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
  if (upper.includes('COMISS') || upper.includes('FRETE VEND') || upper.includes('MARKET') || upper.includes('PUBLICID') || upper.includes('PROPAGANDA') || upper.includes('VIAGEM') || upper.includes('REPRESENT')) return { linha: 'despesas_comerciais', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
  if (upper.includes('ALUGUE') || upper.includes('CONDOM') || upper.includes('SALÁR') || upper.includes('FOLHA') || upper.includes('ENCARGO') || upper.includes('FGTS') || upper.includes('INSS PATR') || upper.includes('CONTAB') || upper.includes('CONSULTORI') || upper.includes('SOFTWARE') || upper.includes('TELEFO') || upper.includes('INTERNET') || upper.includes('ENERGIA') || upper.includes('ÁGUA')) return { linha: 'despesas_administrativas', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
  return { linha: 'despesas_operacionais', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
}

function resolverDataCaixa(input: {
  data_real: string | null;
  data_vencimento: string | null;
}): { data_efetiva: string | null; usou_fallback: boolean } {
  if (input.data_real) return { data_efetiva: input.data_real, usou_fallback: false };
  if (input.data_vencimento) return { data_efetiva: input.data_vencimento, usou_fallback: true };
  return { data_efetiva: null, usou_fallback: false };
}

// Espelho VERBATIM de dre-helpers.ts (Fase 3 baixa derivada no DRE-caixa).
function valorCaixaEfetivo(valorReal: number | null | undefined, valorDocumento: number | null | undefined): number {
  const real = Number(valorReal ?? 0);
  if (real > 0) return real;
  return Number(valorDocumento ?? 0);
}
function dedupePorCodigo<T extends { omie_codigo_lancamento?: number | null }>(rows: T[]): T[] {
  const byCode = new Map<number, T>();
  const semCodigo: T[] = [];
  for (const r of rows) {
    const c = r.omie_codigo_lancamento;
    if (c == null) semCodigo.push(r);
    else if (!byCode.has(Number(c))) byCode.set(Number(c), r);
  }
  return [...byCode.values(), ...semCodigo];
}

// Fase 3: baixa REAL derivada (v_titulo_baixas) por título, paginada. THROW em erro —
// baixaMap parcial reintroduziria double-count/perda no DRE-caixa (codex). NUNCA degradar
// silenciosamente pra vencimento aqui.
async function carregarBaixaMapDRE(db: SupabaseClient, company: string, tipo: "CR" | "CP"): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await db.from("v_titulo_baixas")
      .select("omie_codigo_lancamento, data_baixa_final")
      .eq("company", company).eq("tipo", tipo)
      .order("omie_codigo_lancamento", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ omie_codigo_lancamento: number | null; data_baixa_final: string | null }>;
    for (const r of rows) {
      if (r.omie_codigo_lancamento != null && r.data_baixa_final) map.set(Number(r.omie_codigo_lancamento), r.data_baixa_final);
    }
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return map;
}

// Carrega títulos por lista de códigos, em chunks (PostgREST .in() estoura se a lista for grande).
async function fetchTitulosPorCodigos(
  db: SupabaseClient, table: string, select: string, company: string, statuses: string[], codes: number[],
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  const CHUNK = 200;
  for (let i = 0; i < codes.length; i += CHUNK) {
    const chunk = codes.slice(i, i + CHUNK);
    const { data, error } = await db.from(table)
      .select(select).eq("company", company).in("status_titulo", statuses).in("omie_codigo_lancamento", chunk);
    if (error) throw error;
    out.push(...((data ?? []) as unknown as Array<Record<string, unknown>>));
  }
  return out;
}

type DRECalculada = {
  receita_bruta: number; deducoes: number; receita_liquida: number;
  cmv: number; lucro_bruto: number;
  despesas_operacionais: number; despesas_administrativas: number; despesas_comerciais: number;
  despesas_financeiras: number; receitas_financeiras: number;
  resultado_operacional: number; outras_receitas: number; outras_despesas: number;
  resultado_antes_impostos: number; impostos: number; resultado_liquido: number;
  detalhamento_impostos: Record<string, number>;
};

function montarDRE(input: { regime: RegimeTributario; totais: Record<string, number> }): DRECalculada {
  const t = (k: string) => input.totais[k] ?? 0;
  const indiretos = t('ded_icms') + t('ded_iss') + t('ded_pis') + t('ded_cofins') + t('ded_ipi');
  const das = t('das');
  const impostoLucro = input.regime === 'simples' ? 0 : (t('irpj') + t('csll'));
  const deducoes = t('deducoes') + indiretos + das;
  const receita_bruta = t('receita_bruta');
  const receita_liquida = receita_bruta - deducoes;
  const cmv = t('cmv');
  const lucro_bruto = receita_liquida - cmv;
  const despesas_operacionais = t('despesas_operacionais');
  const despesas_administrativas = t('despesas_administrativas');
  const despesas_comerciais = t('despesas_comerciais');
  const despesas_financeiras = t('despesas_financeiras');
  const receitas_financeiras = t('receitas_financeiras');
  const resultado_operacional = lucro_bruto - (despesas_operacionais + despesas_administrativas + despesas_comerciais) + receitas_financeiras - despesas_financeiras;
  const outras_receitas = t('outras_receitas');
  const outras_despesas = t('outras_despesas');
  const resultado_antes_impostos = resultado_operacional + outras_receitas - outras_despesas;
  const resultado_liquido = resultado_antes_impostos - impostoLucro;
  const detalhamento_impostos: Record<string, number> = {};
  for (const k of ['ded_icms', 'ded_iss', 'ded_pis', 'ded_cofins', 'ded_ipi', 'das', 'irpj', 'csll']) {
    if (t(k) !== 0) detalhamento_impostos[k] = t(k);
  }
  return {
    receita_bruta, deducoes, receita_liquida, cmv, lucro_bruto,
    despesas_operacionais, despesas_administrativas, despesas_comerciais,
    despesas_financeiras, receitas_financeiras, resultado_operacional,
    outras_receitas, outras_despesas, resultado_antes_impostos,
    impostos: impostoLucro, resultado_liquido, detalhamento_impostos,
  };
}

type Confianca = { nivel: 'alta' | 'media' | 'baixa'; motivos: string[]; pct_mapeado_valor: number; fallback_pct: number };

function scoreConfianca(input: {
  pct_mapeado_valor: number;
  fallback_pct: number;
  share_generico: number;
  tem_imposto_nao_mapeado: boolean;
}): Confianca {
  const motivos: string[] = [];
  let nivel = 3;
  const rebaixar = (para: number, motivo: string) => { if (para < nivel) nivel = para; motivos.push(motivo); };
  if (input.pct_mapeado_valor < 0.8) rebaixar(1, `Só ${(input.pct_mapeado_valor * 100).toFixed(0)}% do valor está mapeado por categoria.`);
  else if (input.pct_mapeado_valor < 0.9) rebaixar(2, `${(input.pct_mapeado_valor * 100).toFixed(0)}% do valor mapeado (ideal ≥90%).`);
  if (input.fallback_pct > 0.2) rebaixar(1, `${(input.fallback_pct * 100).toFixed(0)}% do caixa usou data de vencimento (fallback) — direcional.`);
  else if (input.fallback_pct > 0.1) rebaixar(2, `${(input.fallback_pct * 100).toFixed(0)}% do caixa usou fallback de vencimento.`);
  if (input.share_generico > 0.15) rebaixar(2, `${(input.share_generico * 100).toFixed(0)}% em categorias genéricas (outros/diversos/ajuste).`);
  if (input.tem_imposto_nao_mapeado) rebaixar(2, 'Categoria de imposto classificada por heurística (não mapeada).');
  return {
    nivel: nivel === 3 ? 'alta' : nivel === 2 ? 'media' : 'baixa',
    motivos,
    pct_mapeado_valor: input.pct_mapeado_valor,
    fallback_pct: input.fallback_pct,
  };
}

// ── Onda 3b — imposto teórico (espelho de dre-helpers.ts + dre-tabelas-tributarias.ts) ──
// Tabelas legais (LC 123/2006 c/ LC 155/2016) inlinadas verbatim de dre-tabelas-tributarias.ts.
type AnexoSimples = 'I' | 'II' | 'III' | 'IV' | 'V';
type FaixaSimples = { ate: number; aliquota: number; deduzir: number };

const ANEXOS_SIMPLES: Record<AnexoSimples, FaixaSimples[]> = {
  // Anexo I — Comércio
  I: [
    { ate: 180000, aliquota: 0.04, deduzir: 0 },
    { ate: 360000, aliquota: 0.073, deduzir: 5940 },
    { ate: 720000, aliquota: 0.095, deduzir: 13860 },
    { ate: 1800000, aliquota: 0.107, deduzir: 22500 },
    { ate: 3600000, aliquota: 0.143, deduzir: 87300 },
    { ate: 4800000, aliquota: 0.19, deduzir: 378000 },
  ],
  // Anexo II — Indústria
  II: [
    { ate: 180000, aliquota: 0.045, deduzir: 0 },
    { ate: 360000, aliquota: 0.078, deduzir: 5940 },
    { ate: 720000, aliquota: 0.10, deduzir: 13860 },
    { ate: 1800000, aliquota: 0.112, deduzir: 22500 },
    { ate: 3600000, aliquota: 0.147, deduzir: 85500 },
    { ate: 4800000, aliquota: 0.30, deduzir: 720000 },
  ],
  // Anexo III — Serviços (fator-r ≥ 28%)
  III: [
    { ate: 180000, aliquota: 0.06, deduzir: 0 },
    { ate: 360000, aliquota: 0.112, deduzir: 9360 },
    { ate: 720000, aliquota: 0.135, deduzir: 17640 },
    { ate: 1800000, aliquota: 0.16, deduzir: 35640 },
    { ate: 3600000, aliquota: 0.21, deduzir: 125640 },
    { ate: 4800000, aliquota: 0.33, deduzir: 648000 },
  ],
  // Anexo IV — Serviços (limpeza/vigilância/construção/advocacia)
  IV: [
    { ate: 180000, aliquota: 0.045, deduzir: 0 },
    { ate: 360000, aliquota: 0.09, deduzir: 8100 },
    { ate: 720000, aliquota: 0.102, deduzir: 12420 },
    { ate: 1800000, aliquota: 0.14, deduzir: 39780 },
    { ate: 3600000, aliquota: 0.22, deduzir: 183780 },
    { ate: 4800000, aliquota: 0.33, deduzir: 828000 },
  ],
  // Anexo V — Serviços (fator-r < 28%)
  V: [
    { ate: 180000, aliquota: 0.155, deduzir: 0 },
    { ate: 360000, aliquota: 0.18, deduzir: 4500 },
    { ate: 720000, aliquota: 0.195, deduzir: 9900 },
    { ate: 1800000, aliquota: 0.205, deduzir: 17100 },
    { ate: 3600000, aliquota: 0.23, deduzir: 62100 },
    { ate: 4800000, aliquota: 0.305, deduzir: 540000 },
  ],
};

const PRESUMIDO = {
  irpj_aliquota: 0.15,
  irpj_adicional_aliquota: 0.10,
  irpj_adicional_limite_trimestral: 60000,
  csll_aliquota: 0.09,
  pis_aliquota: 0.0065,
  cofins_aliquota: 0.03,
};

const FATOR_R_LIMIAR = 0.28;

type ReceitaMensal = { ano: number; mes: number; receita_bruta: number };

// RBT12 = soma da receita bruta dos 12 meses ANTERIORES ao mês de apuração (exclusivo).
function calcularRBT12(historico: ReceitaMensal[], ano: number, mes: number): number {
  const idxApuracao = ano * 12 + mes;
  const idxInicio = idxApuracao - 12;
  return historico.reduce((s, h) => {
    const idx = h.ano * 12 + h.mes;
    return (idx >= idxInicio && idx < idxApuracao) ? s + h.receita_bruta : s;
  }, 0);
}

function faixaPorRBT12(anexo: AnexoSimples, rbt12: number): FaixaSimples {
  const faixas = ANEXOS_SIMPLES[anexo];
  for (const f of faixas) {
    if (rbt12 <= f.ate) return f;
  }
  return faixas[faixas.length - 1];
}

// Alíquota efetiva do Simples: (RBT12 × nominal − parcela a deduzir) / RBT12.
function aliquotaEfetivaSimples(anexo: AnexoSimples, rbt12: number): number {
  if (rbt12 <= 0) return 0;
  const f = faixaPorRBT12(anexo, rbt12);
  const efetiva = (rbt12 * f.aliquota - f.deduzir) / rbt12;
  return Math.max(0, efetiva);
}

function anexoPorFatorR(fatorR: number): AnexoSimples {
  return fatorR >= FATOR_R_LIMIAR ? 'III' : 'V';
}

function impostoTeoricoSimples(input: {
  anexo: AnexoSimples | null;
  rbt12: number;
  receitaMes: number;
}): number | null {
  if (!input.anexo) return null;            // degrade: sem anexo configurado
  const efetiva = aliquotaEfetivaSimples(input.anexo, input.rbt12);
  return efetiva * input.receitaMes;
}

function impostoTeoricoPresumido(input: {
  receitaTrimestre: number;
  presuncaoIrpj: number;
  presuncaoCsll: number;
}): { irpj: number; csll: number; pis: number; cofins: number; total: number } {
  const baseIrpj = input.receitaTrimestre * input.presuncaoIrpj;
  const irpjBase = baseIrpj * PRESUMIDO.irpj_aliquota;
  const adicional = Math.max(0, baseIrpj - PRESUMIDO.irpj_adicional_limite_trimestral) * PRESUMIDO.irpj_adicional_aliquota;
  const irpj = irpjBase + adicional;
  const csll = input.receitaTrimestre * input.presuncaoCsll * PRESUMIDO.csll_aliquota;
  const pis = input.receitaTrimestre * PRESUMIDO.pis_aliquota;
  const cofins = input.receitaTrimestre * PRESUMIDO.cofins_aliquota;
  return { irpj, csll, pis, cofins, total: irpj + csll + pis + cofins };
}

type ConfigTributario = {
  regime: RegimeTributario;
  anexo: AnexoSimples | null;       // Simples
  fatorRHabilitado: boolean;        // Simples: alterna III/V por fator-r
  presuncaoIrpj: number;            // presumido
  presuncaoCsll: number;            // presumido
  completa: boolean;                // false → teórico parcial, confiança ≤ media
};

const PRESUNCAO_DEFAULT = { irpj: 0.08, csll: 0.12 }; // comércio/indústria

function normalizarConfigTributario(
  company: string,
  raw: Record<string, unknown> | null,
): ConfigTributario {
  const regimeDefault = REGIME_POR_EMPRESA[company] ?? 'presumido';
  const regime = ((raw?.regime as RegimeTributario) ?? regimeDefault);
  const anexo = (raw?.anexo as AnexoSimples | undefined) ?? null;
  const presuncaoIrpj = Number(raw?.presuncao_irpj ?? PRESUNCAO_DEFAULT.irpj);
  const presuncaoCsll = Number(raw?.presuncao_csll ?? PRESUNCAO_DEFAULT.csll);
  const fatorRHabilitado = Boolean(raw?.fator_r_habilitado ?? false);
  const completa = regime === 'presumido' ? raw != null : anexo != null;
  return { regime, anexo, fatorRHabilitado, presuncaoIrpj, presuncaoCsll, completa };
}

// ═══════════════ CALCULAR DRE SNAPSHOT ═══════════════
type Regime = "caixa" | "competencia";

async function calcularDRE(
  db: SupabaseClient,
  company: Company,
  ano: number,
  mes: number,
  regime: Regime = "caixa"
) {
  // Defense-in-depth: este é o ponto money-path que compõe o filtro .or() cru
  // (1235/1249) e faz upsert em fin_dre_snapshots. Re-valida mesmo que o boundary
  // já valide — qualquer caller futuro fica protegido. Reatribui pra normalizar
  // o tipo (boundary pode entregar string "2026") e fechar o bug de dezembro.
  ano = validateAno(ano);
  mes = validateMes(mes);
  const inicioMes = `${ano}-${String(mes).padStart(2, "0")}-01`;
  const fimMes =
    mes === 12
      ? `${ano + 1}-01-01`
      : `${ano}-${String(mes + 1).padStart(2, "0")}-01`;
  const regimeTrib: RegimeTributario = REGIME_POR_EMPRESA[company] ?? "presumido";

  // ── Fase 3: baixa REAL derivada (só no regime caixa) ──
  // No caixa, a data de baixa derivada (v_titulo_baixas) é a data EFETIVA do título;
  // fallback p/ vencimento ("estimado") onde não houver. baixaMap throw em erro (parcial
  // reintroduz double-count). Competência não usa (bucketiza por emissão).
  const baixaMapCR = regime === "caixa" ? await carregarBaixaMapDRE(db, company, "CR") : new Map<number, string>();
  const baixaMapCP = regime === "caixa" ? await carregarBaixaMapDRE(db, company, "CP") : new Map<number, string>();
  const codigosNoMes = (map: Map<number, string>) =>
    [...map.entries()].filter(([, d]) => d >= inicioMes && d < fimMes).map(([c]) => c);

  // ── Buscar títulos ──
  // Competência: bucketiza por data_emissao (server-side). Caixa: a data efetiva é a BAIXA
  // derivada (ou vencimento, fallback). Carrega (venc-no-mês) ∪ (baixa-no-mês), dedupe por
  // código → cada título cai no mês da baixa quando há baixa, senão no mês do vencimento.
  // Sem o ramo baixa-no-mês, título pago atrasado (venc anterior, baixa neste mês) sumiria.
  const SEL_CR = "valor_documento, valor_recebido, data_recebimento, data_vencimento, categoria_codigo, categoria_descricao, omie_codigo_lancamento";
  const SEL_CP = "valor_documento, valor_pago, data_pagamento, data_vencimento, categoria_codigo, categoria_descricao, omie_codigo_lancamento";
  const ST_CR = ["RECEBIDO", "PARCIAL", "LIQUIDADO"];
  const ST_CP = ["PAGO", "PARCIAL", "LIQUIDADO"];
  async function buscarCR() {
    if (regime === "competencia") {
      const { data, error } = await db.from("fin_contas_receber")
        .select("valor_documento, valor_recebido, data_recebimento, data_vencimento, categoria_codigo, categoria_descricao")
        .eq("company", company).neq("status_titulo", "CANCELADO")
        .gte("data_emissao", inicioMes).lt("data_emissao", fimMes);
      if (error) throw error; // não silenciar falha de DB como DRE vazia
      return data ?? [];
    }
    const { data, error } = await db.from("fin_contas_receber").select(SEL_CR)
      .eq("company", company).in("status_titulo", ST_CR)
      .or(`and(data_recebimento.gte.${inicioMes},data_recebimento.lt.${fimMes}),and(data_recebimento.is.null,data_vencimento.gte.${inicioMes},data_vencimento.lt.${fimMes})`);
    if (error) throw error; // não silenciar falha de DB como DRE vazia
    const porBaixa = await fetchTitulosPorCodigos(db, "fin_contas_receber", SEL_CR, company, ST_CR, codigosNoMes(baixaMapCR));
    return dedupePorCodigo([...(data ?? []) as Array<Record<string, unknown>>, ...porBaixa]);
  }
  async function buscarCP() {
    if (regime === "competencia") {
      const { data, error } = await db.from("fin_contas_pagar")
        .select("valor_documento, valor_pago, data_pagamento, data_vencimento, categoria_codigo, categoria_descricao")
        .eq("company", company).neq("status_titulo", "CANCELADO")
        .gte("data_emissao", inicioMes).lt("data_emissao", fimMes);
      if (error) throw error; // não silenciar falha de DB como DRE vazia
      return data ?? [];
    }
    const { data, error } = await db.from("fin_contas_pagar").select(SEL_CP)
      .eq("company", company).in("status_titulo", ST_CP)
      .or(`and(data_pagamento.gte.${inicioMes},data_pagamento.lt.${fimMes}),and(data_pagamento.is.null,data_vencimento.gte.${inicioMes},data_vencimento.lt.${fimMes})`);
    if (error) throw error; // não silenciar falha de DB como DRE vazia
    const porBaixa = await fetchTitulosPorCodigos(db, "fin_contas_pagar", SEL_CP, company, ST_CP, codigosNoMes(baixaMapCP));
    return dedupePorCodigo([...(data ?? []) as Array<Record<string, unknown>>, ...porBaixa]);
  }
  const receitas = await buscarCR();
  const despesas = await buscarCP();

  // ── Mapping ──
  const { data: mappings, error: mappingsError } = await db.from("fin_categoria_dre_mapping")
    .select("omie_codigo, dre_linha, company").in("company", [company, "_default"]);
  if (mappingsError) throw mappingsError; // categorização incompleta não deve persistir DRE
  const mapping = new Map<string, string>();
  const sorted = ((mappings ?? []) as Array<{ omie_codigo: string; dre_linha: string; company: string }>)
    .slice().sort((a, b) => (a.company === "_default" ? -1 : 1));
  for (const m of sorted) mapping.set(m.omie_codigo, m.dre_linha);

  // Onda 3b: config tributária (coluna opcional — degrade se ausente) + histórico de receita p/ RBT12
  const cfgRes = await db.from("fin_config_cashflow").select("dre_tributario").eq("company", company).maybeSingle();
  const configTrib = normalizarConfigTributario(company, (cfgRes.data as { dre_tributario?: Record<string, unknown> } | null)?.dre_tributario ?? null);
  const histRes = await db.from("fin_dre_snapshots").select("ano, mes, receita_bruta").eq("company", company).eq("regime", "competencia");
  if (histRes.error) throw histRes.error; // histórico p/ RBT12: falha de DB não vira histórico vazio
  const histReceita = ((histRes.data ?? []) as Array<{ ano: number; mes: number; receita_bruta: number }>);

  // ── Classificar + bucketizar (caixa por data efetiva) ──
  const totais: Record<string, number> = {};
  const detalheReceitas: Record<string, number> = {};
  const detalheDespesas: Record<string, number> = {};
  const naoMapeadas: string[] = [];
  let valorTotal = 0, valorMapeado = 0, valorGenerico = 0;
  let temImpostoNaoMapeado = false;
  let fallbackValor = 0, caixaValor = 0;
  const GENERICOS = ["OUTROS", "DIVERSOS", "AJUSTE", "TRANSFER"];

  function processar(rows: Array<Record<string, unknown>>, isReceita: boolean) {
    for (const row of rows) {
      const cod = (row.categoria_codigo as string) || "";
      const desc = (row.categoria_descricao as string) || cod || "Sem categoria";
      let val: number;
      let usouFallback = false;
      if (regime === "competencia") {
        val = Number(row.valor_documento ?? 0);
      } else {
        // data EFETIVA = baixa DERIVADA (v_titulo_baixas) onde houver; senão vencimento (fallback "estimado").
        // A coluna base data_recebimento/data_pagamento é sempre NULL no LIST do Omie → não serve.
        const codLanc = row.omie_codigo_lancamento as number | null;
        const baixaMap = isReceita ? baixaMapCR : baixaMapCP;
        const dataReal = codLanc != null ? (baixaMap.get(Number(codLanc)) ?? null) : null;
        const venc = row.data_vencimento as string | null;
        const { data_efetiva, usou_fallback } = resolverDataCaixa({ data_real: dataReal, data_vencimento: venc });
        if (!data_efetiva || data_efetiva < inicioMes || data_efetiva >= fimMes) continue;
        usouFallback = usou_fallback;
        // valorCaixaEfetivo: liquidado tem valor_recebido=0 (#396) → cai no valor_documento (face),
        // senão alocaria ZERO. Parcial real (valor_recebido>0) usa o valor recebido.
        val = isReceita ? valorCaixaEfetivo(row.valor_recebido as number | null, row.valor_documento as number | null)
                        : valorCaixaEfetivo(row.valor_pago as number | null, row.valor_documento as number | null);
        caixaValor += val;
        if (usouFallback) fallbackValor += val;
      }
      const det = isReceita ? detalheReceitas : detalheDespesas;
      det[desc] = (det[desc] || 0) + val;

      const c = classificarLinhaDRE({ categoria_codigo: cod, categoria_descricao: desc, isReceita, regime: regimeTrib, mapping });
      totais[c.linha] = (totais[c.linha] ?? 0) + val;
      valorTotal += val;
      if (c.mapeado) valorMapeado += val;
      if (c.impostoNaoMapeado) temImpostoNaoMapeado = true;
      if (!c.mapeado && cod) naoMapeadas.push(cod);
      const up = (desc + " " + cod).toUpperCase();
      if (GENERICOS.some((g) => up.includes(g))) valorGenerico += val;
    }
  }
  processar(receitas as Array<Record<string, unknown>>, true);
  processar(despesas as Array<Record<string, unknown>>, false);

  // ── Montar DRE (ladder regime-aware) ──
  const dre = montarDRE({ regime: regimeTrib, totais });

  // ── Onda 3b: imposto teórico (conferência) — degrade honesto p/ null quando faltar dado ──
  let imposto_teorico: Record<string, number | null> | null = null;
  let delta_imposto_pct: number | null = null;
  if (regimeTrib === "simples") {
    const rbt12 = calcularRBT12(histReceita, ano, mes);
    const anexo = configTrib.anexo; // fator-r não alterna sem folha segregada confiável (degrade documentado)
    const dasTeorico = impostoTeoricoSimples({ anexo, rbt12, receitaMes: dre.receita_bruta });
    imposto_teorico = { das: dasTeorico };
    const dasReal = dre.detalhamento_impostos.das ?? 0;
    if (dasTeorico != null && dasTeorico > 0 && dasReal > 0) {
      delta_imposto_pct = (dasReal - dasTeorico) / dasTeorico;
    }
  } else {
    const triIdx = Math.floor((mes - 1) / 3);
    const mesesTri = [triIdx * 3 + 1, triIdx * 3 + 2, triIdx * 3 + 3];
    const receitaTri = histReceita.filter((h) => h.ano === ano && mesesTri.includes(h.mes)).reduce((s, h) => s + h.receita_bruta, 0) || dre.receita_bruta;
    const teo = impostoTeoricoPresumido({ receitaTrimestre: receitaTri, presuncaoIrpj: configTrib.presuncaoIrpj, presuncaoCsll: configTrib.presuncaoCsll });
    // teórico mensal aproximado = trimestre / 3 (rateio linear — aproximação documentada)
    imposto_teorico = { irpj: teo.irpj / 3, csll: teo.csll / 3, pis: teo.pis / 3, cofins: teo.cofins / 3, total: teo.total / 3 };
    const realLucro = (dre.detalhamento_impostos.irpj ?? 0) + (dre.detalhamento_impostos.csll ?? 0);
    const teoLucroMensal = (teo.irpj + teo.csll) / 3;
    if (teoLucroMensal > 0 && realLucro > 0) {
      delta_imposto_pct = (realLucro - teoLucroMensal) / teoLucroMensal;
    }
  }

  // ── Confiança ──
  const fallback_pct = caixaValor > 0 ? fallbackValor / caixaValor : 0;
  const confianca = scoreConfianca({
    pct_mapeado_valor: valorTotal > 0 ? valorMapeado / valorTotal : 1,
    fallback_pct,
    share_generico: valorTotal > 0 ? valorGenerico / valorTotal : 0,
    tem_imposto_nao_mapeado: temImpostoNaoMapeado,
  });
  if (delta_imposto_pct != null && Math.abs(delta_imposto_pct) > 0.25) {
    confianca.motivos.push(`Imposto realizado diverge ${(delta_imposto_pct * 100).toFixed(0)}% do teórico esperado — conferir competência/recolhimento.`);
  }
  if (!configTrib.completa && confianca.nivel === "alta") {
    confianca.nivel = "media";
    confianca.motivos.push("Config tributária incompleta — teórico parcial.");
  }
  const unique = [...new Set(naoMapeadas)];
  const caixa_estimado = regime === "caixa" && fallback_pct > 0.1;
  if (unique.length > 0) {
    console.log(`[Fin][${company}] DRE ${mes}/${ano} (${regimeTrib}): ${unique.length} categorias sem mapeamento explícito: ${unique.slice(0, 10).join(", ")}`);
  }

  const snapshot = {
    company,
    ano,
    mes,
    regime,
    receita_bruta: dre.receita_bruta,
    deducoes: dre.deducoes,
    receita_liquida: dre.receita_liquida,
    cmv: dre.cmv,
    lucro_bruto: dre.lucro_bruto,
    despesas_operacionais: dre.despesas_operacionais,
    despesas_administrativas: dre.despesas_administrativas,
    despesas_comerciais: dre.despesas_comerciais,
    despesas_financeiras: dre.despesas_financeiras,
    receitas_financeiras: dre.receitas_financeiras,
    resultado_operacional: dre.resultado_operacional,
    outras_receitas: dre.outras_receitas,
    outras_despesas: dre.outras_despesas,
    resultado_antes_impostos: dre.resultado_antes_impostos,
    impostos: dre.impostos,
    resultado_liquido: dre.resultado_liquido,
    qtd_categorias_sem_mapeamento: unique.length,
    detalhamento: {
      receitas: detalheReceitas,
      despesas: detalheDespesas,
      categorias_nao_mapeadas: unique,
      impostos: dre.detalhamento_impostos,
      regime_tributario: regimeTrib,
      caixa_estimado,
      confianca,
      imposto_teorico,
      delta_imposto_pct,
      config_tributaria_completa: configTrib.completa,
    },
    calculated_at: new Date().toISOString(),
  };

  const { error } = await db
    .from("fin_dre_snapshots")
    .upsert(snapshot, { onConflict: "company,ano,mes,regime" });
  if (error) console.error(`[Fin][${company}] Erro DRE (${regime}):`, error.message);

  return snapshot;
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
  db: SupabaseClient
): Promise<{ authorized: boolean; userId?: string; error?: string }> {
  const cronSecret = req.headers.get("x-cron-secret");
  const expectedCron = Deno.env.get("CRON_SECRET");
  if (cronSecret && expectedCron && cronSecret === expectedCron) {
    return { authorized: true, userId: "cron" };
  }

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

  // Gate financeiro: master (user_roles) OU gestor comercial (commercial_roles).
  // omie-financeiro expõe DRE/saldos/CP-CR + sync ERP — não é p/ employee comum.
  // Matriz decidida pelo founder (2026-05-25); espelha o gate do fin-valor-cockpit.
  // `db` é service_role → lê as roles sem esbarrar em RLS.
  const { data: userRoles } = await db
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id);
  const { data: commercialRoles } = await db
    .from("commercial_roles")
    .select("commercial_role")
    .eq("user_id", user.id);

  if (!hasFinanceiroAccess({ userRoles, commercialRoles })) {
    return { authorized: false, error: "Permissão negada: requer master ou gestor comercial" };
  }

  return { authorized: true, userId: user.id };
}

// ═══════════════ SYNC LOG ═══════════════

async function logSync(
  db: SupabaseClient,
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
  db: SupabaseClient,
  logId: string,
  results: Record<string, unknown> | null,
  errorMsg?: string,
  startTime?: number,
  opts?: { skippedBusy?: boolean }
) {
  if (!logId) return;
  // skipped_busy: a invocação NÃO adquiriu o lease da conta e saiu sem tocar Omie/cursor.
  // completed_at=NULL de propósito → invisível p/ os consumidores de frescor
  // (_data_health_compute/fin_calcular_confiabilidade/fin_sync_heartbeat filtram
  // completed_at IS NOT NULL ou status='complete'), então NÃO fabrica "sync recente".
  // Erro (inclui lease_error, fail-closed) tem precedência sobre skipped_busy.
  const skipped = opts?.skippedBusy === true && !errorMsg;
  const status = errorMsg ? "error" : skipped ? "skipped_busy" : "complete";
  const completedAt = skipped ? null : new Date().toISOString();

  // Try with observability columns first (migration 200500)
  const { error } = await db
    .from("fin_sync_log")
    .update({
      status,
      results: results || {},
      error_message: errorMsg || null,
      completed_at: completedAt,
      duracao_ms: startTime ? Date.now() - startTime : null,
      api_calls: apiCallCount,
      rate_limits_hit: rateLimitHits,
      entidades_por_empresa: results || {},
    })
    .eq("id", logId);

  // Fallback: if columns don't exist yet (200500 not applied), retry with base columns only
  if (error) {
    console.log(`[Fin] completeSync fallback (extra columns may not exist): ${error.message}`);
    const { error: fbError } = await db
      .from("fin_sync_log")
      .update({
        status,
        results: results || {},
        error_message: errorMsg || null,
        completed_at: completedAt,
      })
      .eq("id", logId);
    // NÃO engolir o erro do fallback (Codex #8): se o UPDATE falhar (ex.: CHECK sem
    // 'skipped_busy' pq a migration não foi aplicada), a linha fica 'running' → o
    // watchdog varre p/ 'error' em 30min. Logar alto pra o incidente não ficar mudo.
    if (fbError) {
      console.error(`[Fin] completeSync FALHOU ao gravar status='${status}' (linha ${logId} fica running→órfã): ${fbError.message}`);
    }
  }
}

// ───────── Cursor de paginação resumível (tabela fin_sync_cursor) ─────────
// Permite que CP/CR/mov retomem de onde pararam entre invocações, pra cobrir
// empresas grandes (ex: colacor CR ~292 págs) sem estourar o time-budget de
// 130s. next_page NULL = sem resume pendente (começa do início na próxima).
async function readCursorStartPage(
  db: SupabaseClient,
  company: string,
  resource: string,
): Promise<number | undefined> {
  try {
    const { data } = await db
      .from("fin_sync_cursor")
      .select("next_page")
      .eq("company", company)
      .eq("resource", resource)
      .maybeSingle();
    const np = (data as { next_page?: number | null } | null)?.next_page;
    return typeof np === "number" ? np : undefined;
  } catch {
    return undefined; // tabela ausente / erro → começa do início
  }
}

// Janela de backfill persistida no cursor (só movimentações usam). Faz a
// continuação `*/10` herdar a janela ampla durante o backfill. undefined =
// incremental normal. Ver migration 20260527220001.
async function readCursorBackfillDesde(
  db: SupabaseClient,
  company: string,
  resource: string,
): Promise<string | undefined> {
  try {
    const { data } = await db
      .from("fin_sync_cursor")
      .select("backfill_desde")
      .eq("company", company)
      .eq("resource", resource)
      .maybeSingle();
    const bf = (data as { backfill_desde?: string | null } | null)?.backfill_desde;
    return bf ?? undefined;
  } catch {
    return undefined;
  }
}

async function writeCursor(
  db: SupabaseClient,
  company: string,
  resource: string,
  result: { complete?: boolean; nextPage?: number | null },
  backfillDesde?: string | null,
): Promise<void> {
  const nextPage = result.complete ? null : (result.nextPage ?? null);
  // Ao completar (página 1), limpa a janela de backfill → volta ao incremental.
  // Enquanto pendente, preserva a janela pra a continuação herdar.
  const bf = result.complete ? null : (backfillDesde ?? null);
  try {
    await db
      .from("fin_sync_cursor")
      .upsert(
        { company, resource, next_page: nextPage, backfill_desde: bf, updated_at: new Date().toISOString() },
        { onConflict: "company,resource" },
      );
  } catch {
    /* tabela ausente → ignora (degrada pro comportamento sem cursor) */
  }
}

// ───────── Lease por company (single-flight da CONTA Omie) ─────────
// Espelha o state-machine SQL da migration 20260704150000 (fin_sync_lease_acquire/
// release — SECURITY DEFINER gated a service_role). Fecha o achado P1: syncs
// concorrentes na MESMA conta Omie → rate-limit fatal SILENCIOSO que mente
// status=complete com synced=0. Rate-limit do Omie é por CONTA (=company) → o lease
// é por company. O lease atômico TEM que ser RPC (`.or()`/predicado em UPDATE do
// PostgREST quebra 42703 — CLAUDE.md). Provado no PG17: db/test-fin-sync-lease.sh.
type LeaseOutcome =
  | { kind: "acquired"; token: string }
  | { kind: "busy" }
  | { kind: "error"; message: string };

// Tenta tomar o lease da conta ATOMICAMENTE (1 retry curto em erro de RPC). Distingue
// 3 desfechos: `acquired` (roda), `busy` (data=null sem erro → outra invocação viva →
// skip), `error` (RPC falhou após retry). ⚠️ supabase-js .rpc() NÃO lança — resolve
// {data,error}; por isso checamos `error` explicitamente.
async function acquireCompanyLease(
  db: SupabaseClient,
  company: Company,
  holder: string,
): Promise<LeaseOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await db.rpc("fin_sync_lease_acquire", {
      p_company: company,
      p_holder: holder,
    });
    if (!error) {
      return typeof data === "string" && data
        ? { kind: "acquired", token: data }
        : { kind: "busy" };
    }
    console.error(`[Fin][${company}] lease_acquire erro (tent ${attempt + 1}/2): ${error.message}`);
    if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
    else return { kind: "error", message: error.message };
  }
  return { kind: "error", message: "lease_acquire inalcançável" };
}

// Libera o lease (token-guarded na RPC). Best-effort: uma falha de release NÃO derruba
// o sync — o TTL (300s) cobre a liberação eventual.
async function releaseCompanyLease(
  db: SupabaseClient,
  company: Company,
  token: string,
): Promise<void> {
  const { error } = await db.rpc("fin_sync_lease_release", {
    p_company: company,
    p_token: token,
  });
  if (error) console.error(`[Fin][${company}] lease_release erro (segue; TTL cobre): ${error.message}`);
}

// Roda `fn` SÓ com o lease da conta. `busy` → {skipped_busy:true} (NÃO toca Omie/cursor
// → o cursor é preservado, a continuação */10 retoma). `error` de RPC → {lease_error}
// FAIL-CLOSED: NÃO roda destravado (rodaria concorrente e mentiria complete — Codex);
// o handler agrega isso p/ status='error' → o watchdog tail-failing alerta.
async function runOmieWithLease<T>(
  db: SupabaseClient,
  company: Company,
  holder: string,
  fn: () => Promise<T>,
): Promise<T | { skipped_busy: true } | { lease_error: string }> {
  const lease = await acquireCompanyLease(db, company, holder);
  if (lease.kind === "busy") {
    console.log(`[Fin][${company}] skipped_busy: outra invocação segura o lease da conta`);
    return { skipped_busy: true };
  }
  if (lease.kind === "error") {
    return { lease_error: lease.message };
  }
  try {
    return await fn();
  } finally {
    await releaseCompanyLease(db, company, lease.token);
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

  // Içados pra fora do try: o catch precisa finalizar o log órfão (sem isto a
  // linha fica 'running' pra sempre — nunca vira 'error' — e a falha some).
  let logId = "";
  let startTime = Date.now();
  let syncFinalized = false;

  try {
    // Auth check (Ponto 6)
    const auth = await validateCaller(req, supabase);
    if (!auth.authorized) {
      return new Response(
        JSON.stringify({ success: false, error: auth.error }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Marca origem no audit log para todas as mutações desta invocação
    await setAuditOrigem(supabase, 'omie_sync');

    const { action, company, companies, filtro_data_de, filtro_data_ate, ano, mes, meses, maxPages, entidade, ncodcc, regime: requestedRegime } =
      await req.json();

    const targetCompanies = resolveCompanies({ companies, company, allowed: ALLOWED_COMPANIES }) as Company[];

    // Reset global counters per invocation
    globalStartTime = Date.now();
    startTime = globalStartTime;
    apiCallCount = 0;
    rateLimitHits = 0;
    logId = await logSync(supabase, action, targetCompanies, auth.userId || "unknown");

    let result: Record<string, unknown> = {};

    switch (action) {
      case "sync_all": {
        // Ponto 2: inclui TODAS as entidades, incluindo movimentações.
        // Sob o lease da conta: o bloco inteiro de uma company roda com 1 lease;
        // outra invocação na mesma conta vira skipped_busy.
        for (const co of targetCompanies) {
          result[co] = await runOmieWithLease(supabase, co, logId, async () => {
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

            return {
              categorias: cats,
              contas_correntes: ccs,
              contas_pagar: cp,
              contas_receber: cr,
              movimentacoes: mov,
            };
          });
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
          result[co] = await runOmieWithLease(supabase, co, logId, async () => {
            const startPage = (await readCursorStartPage(supabase, co, "contas_pagar")) ?? 1;
            const r = await syncContasPagar(supabase, co, dataInicio, dataFim, maxPages, startPage);
            await writeCursor(supabase, co, "contas_pagar", r);
            return r;
          });
        }
        break;
      }

      case "sync_contas_receber": {
        const dataInicio =
          filtro_data_de ||
          formatOmieDate(new Date(new Date().setMonth(new Date().getMonth() - 6)));
        const dataFim = filtro_data_ate || formatOmieDate(new Date());
        for (const co of targetCompanies) {
          result[co] = await runOmieWithLease(supabase, co, logId, async () => {
            const startPage = (await readCursorStartPage(supabase, co, "contas_receber")) ?? 1;
            const r = await syncContasReceber(supabase, co, dataInicio, dataFim, maxPages, startPage);
            await writeCursor(supabase, co, "contas_receber", r);
            return r;
          });
        }
        break;
      }

      case "sync_movimentacoes": {
        const dataFim = filtro_data_ate || formatOmieDate(new Date());
        const incrementalDe = formatOmieDate(new Date(new Date().setMonth(new Date().getMonth() - 3)));
        for (const co of targetCompanies) {
          result[co] = await runOmieWithLease(supabase, co, logId, async () => {
            // mov: undefined = fresh (começa da última página/mais recente); int = resume
            const startPage = await readCursorStartPage(supabase, co, "movimentacoes");
            const cursorBackfill = await readCursorBackfillDesde(supabase, co, "movimentacoes");
            // Backfill = janela ampla client-side. Inicia via body.filtro_data_de (só
            // quando NÃO há resume pendente, pra não reiniciar no meio); resume herda a
            // janela persistida no cursor. NULL = incremental (3 meses, early-exit 30).
            const backfillDesde =
              startPage !== undefined ? (cursorBackfill ?? null) : (filtro_data_de ?? null);
            const dataInicio = backfillDesde || incrementalDe;
            const maxEmpty = backfillDesde ? 300 : 30;
            const r = await syncMovimentacoes(supabase, co, dataInicio, dataFim, maxPages, startPage, maxEmpty);
            await writeCursor(supabase, co, "movimentacoes", r, backfillDesde);
            return r;
          });
        }
        break;
      }

      // Ponto 8: contrato unificado — aceita `mes` (number) ou `meses` (number[])
      // Phase 3 (Fundação): calcula ambos regimes (caixa + competência) por padrão.
      // Aceita `regime` opcional ('caixa' | 'competencia' | 'ambos'). Default 'ambos'.
      case "calcular_dre": {
        const nowDre = new Date();
        const { ano: targetAno, meses: targetMeses } = resolveDrePeriod({
          ano,
          mes,
          meses,
          defaultAno: nowDre.getFullYear(),
          defaultMes: nowDre.getMonth() + 1,
        });
        const regimesToRun: Regime[] = requestedRegime === "caixa"
          ? ["caixa"]
          : requestedRegime === "competencia"
            ? ["competencia"]
            : ["caixa", "competencia"];

        for (const co of targetCompanies) {
          result[co] = {};
          for (const m of targetMeses) {
            result[co][`${m}`] = {};
            for (const reg of regimesToRun) {
              result[co][`${m}`][reg] = await calcularDRE(supabase, co, targetAno, m, reg);
            }
          }
        }
        break;
      }

      // Ponto 8: calcular_dre_year = todos os meses até o mês atual
      case "calcular_dre_year": {
        const targetAno = ano == null ? new Date().getFullYear() : validateAno(ano);
        const currentMonth = new Date().getFullYear() === targetAno ? new Date().getMonth() + 1 : 12;
        const regimesYear: Regime[] = ["caixa", "competencia"];
        for (const co of targetCompanies) {
          result[co] = {};
          for (let m = 1; m <= currentMonth; m++) {
            result[co][`${m}`] = {};
            for (const reg of regimesYear) {
              result[co][`${m}`][reg] = await calcularDRE(supabase, co, targetAno, m, reg);
            }
          }
        }
        break;
      }

      // Debug: retorna JSON raw do Omie sem transformação (para validação Onda 1)
      case "debug_raw": {
        const _hoje = new Date();
        const _hojeBR = `${String(_hoje.getDate()).padStart(2, "0")}/${String(_hoje.getMonth() + 1).padStart(2, "0")}/${_hoje.getFullYear()}`;
        const endpoints: Record<string, { endpoint: string; call: string; params: Record<string, unknown> }> = {
          categorias: { endpoint: "geral/categorias/", call: "ListarCategorias", params: { pagina: 1, registros_por_pagina: 2 } },
          contas_correntes: { endpoint: "geral/contacorrente/", call: "ListarContasCorrentes", params: { pagina: 1, registros_por_pagina: 2 } },
          contas_pagar: { endpoint: "financas/contapagar/", call: "ListarContasPagar", params: { pagina: 1, registros_por_pagina: 2 } },
          contas_receber: { endpoint: "financas/contareceber/", call: "ListarContasReceber", params: { pagina: 1, registros_por_pagina: 2 } },
          movimentacoes: { endpoint: "financas/mf/", call: "ListarMovimentos", params: { nPagina: 1, nRegPorPagina: 2 } },
          // Saldo atual real de uma conta (passe ncodcc). Use pra validar o fix de saldo.
          extrato_cc: { endpoint: "financas/extrato/", call: "ListarExtrato", params: { nCodCC: Number(ncodcc) || 0, dPeriodoInicial: _hojeBR, dPeriodoFinal: _hojeBR, cExibirApenasSaldo: "S" } },
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
        syncFinalized = true;
        return new Response(
          JSON.stringify({
            error: `Ação desconhecida: ${action}`,
            acoes_disponiveis: [
              "sync_all", "sync_categorias", "sync_contas_correntes",
              "sync_contas_pagar", "sync_contas_receber", "sync_movimentacoes",
              "calcular_dre", "calcular_dre_year", "debug_raw",
            ],
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    // Agrega o status quando o lease entrou em jogo (Codex #5: multi-company não
    // esconde o skip — cada result[co] carrega skipped_busy/lease_error). Se ALGUMA
    // company deu lease_error → 'error' (fail-closed; o watchdog tail-failing alerta).
    // Se TODAS as alvo viraram skipped_busy → 'skipped_busy' (completed_at NULL). Senão
    // → 'complete'. Só as LEASE_ACTIONS produzem esses marcadores.
    const LEASE_ACTIONS = new Set([
      "sync_all", "sync_contas_pagar", "sync_contas_receber", "sync_movimentacoes",
    ]);
    let leaseErrorMsg: string | undefined;
    let allSkippedBusy = false;
    if (LEASE_ACTIONS.has(action) && targetCompanies.length > 0) {
      const leaseErr = targetCompanies
        .map((co) => (result[co] as { lease_error?: string } | undefined)?.lease_error)
        .find((m): m is string => typeof m === "string");
      if (leaseErr) {
        leaseErrorMsg = `lease indisponível (fail-closed): ${leaseErr}`;
      } else {
        allSkippedBusy = targetCompanies.every(
          (co) => (result[co] as { skipped_busy?: boolean } | undefined)?.skipped_busy === true,
        );
      }
    }

    // Log final (Ponto 11)
    await completeSync(supabase, logId, result, leaseErrorMsg, startTime, { skippedBusy: allSkippedBusy });
    syncFinalized = true;

    return new Response(JSON.stringify({ success: true, action, ...result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[Fin] Erro:", error);
    // Finaliza o log órfão: marca 'error' em vez de deixar 'running' pra sempre.
    // Guarda syncFinalized → não sobrescreve um completeSync('complete') já feito
    // se a exceção vier depois dele. Update do log em try/catch interno pra NUNCA
    // mascarar a resposta original (se o próprio update falhar, ainda responde).
    if (logId && !syncFinalized) {
      try {
        await completeSync(supabase, logId, null, String(error), startTime);
      } catch (logErr) {
        console.error("[Fin] Falha ao finalizar log órfão:", logErr);
      }
    }
    // Erro de contrato do cliente (período/empresa inválidos) → 400 (não 500).
    const status = error instanceof DrePeriodError || error instanceof OmieRequestError ? 400 : 500;
    return new Response(
      JSON.stringify({ success: false, error: String(error) }),
      {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
