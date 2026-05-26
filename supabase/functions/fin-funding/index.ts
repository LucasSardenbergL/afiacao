// supabase/functions/fin-funding/index.ts
// Custo Marginal de Funding — cockpit de decisão de antecipação de recebíveis.
// Master-only. Lê fin_funding_inputs (taxas), empresa_configuracao_custos (cm_anual),
// fin_contas_receber (títulos antecipáveis) e compõe projeção via fin-cashflow-engine.
// Helpers espelhados VERBATIM de src/lib/financeiro/funding-helpers.ts.
// Spec: 2026-05-25-financeiro-funding-divida (sub-PR A: decisão de antecipação).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function unauthorized(message = "Unauthorized"): Response {
  return jsonResponse({ error: message }, 401);
}

// Master-only (verbatim de fin-regime-tributario/index.ts).
async function authorizeMaster(req: Request): Promise<{ ok: true } | { ok: false; response: Response }> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return { ok: false, response: unauthorized() };
  const token = authHeader.slice(7);
  if (token === SERVICE_ROLE) return { ok: true };
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: authHeader, apikey: SERVICE_ROLE } });
    if (!userRes.ok) return { ok: false, response: unauthorized() };
    const user = await userRes.json();
    if (!user?.id) return { ok: false, response: unauthorized() };
    const roleRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${user.id}&select=role`,
      { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } },
    );
    if (!roleRes.ok) return { ok: false, response: unauthorized() };
    const roles = (await roleRes.json()) as Array<{ role: string }>;
    if (roles.some((r) => r.role === "master")) return { ok: true };
    return { ok: false, response: unauthorized("Forbidden — master only") };
  } catch {
    return { ok: false, response: unauthorized() };
  }
}

// ===================== Helpers espelhados VERBATIM de funding-helpers.ts =====================
// Conversão de estilo: sem import/@/, tipos inline, aspas duplas. Lógica idêntica.

type TipoFonte = "caixa_proprio" | "antecipacao" | "capital_giro" | "cheque_especial";

// IOF de operação de crédito PJ: 0,38% fixo + 0,0082%/dia (parcela diária limitada a 365 dias).
function iofCredito(valor: number, dias: number): number {
  if (valor <= 0) return 0;
  const diasCap = Math.min(Math.max(dias, 0), 365);
  return valor * (0.000082 * diasCap + 0.0038);
}

// Custo em R$ de prover M reais por D dias a uma taxa anual efetiva (fração).
function custoEmReais(M: number, dias: number, taxaAnual: number): number {
  if (M <= 0 || dias <= 0 || taxaAnual <= 0) return 0;
  return M * (Math.pow(1 + taxaAnual, dias / 365) - 1);
}

type AntecipacaoResult = {
  desagio: number; iof: number; tarifa: number; v_liq: number;
  custo_rs: number; taxa_efetiva_aa: number | null;
};

// Antecipação/desconto de um título (face V, vence em N dias). Deságio comercial "por fora".
function custoAntecipacao(input: {
  valor: number; dias: number; taxa_desconto_mensal: number; // fração a.m.
  tipo: "desconto" | "factoring"; tarifa_fixa?: number;
}): AntecipacaoResult {
  const { valor, dias } = input;
  const desagio = valor * input.taxa_desconto_mensal * (dias / 30);
  const iof = input.tipo === "desconto" ? iofCredito(valor, dias) : 0;
  const tarifa = input.tarifa_fixa ?? 0;
  const v_liq = valor - desagio - iof - tarifa;
  const custo_rs = valor - v_liq;
  const taxa_efetiva_aa = v_liq > 0 && dias > 0 ? Math.pow(valor / v_liq, 365 / dias) - 1 : null;
  return { desagio, iof, tarifa, v_liq, custo_rs, taxa_efetiva_aa };
}

// Custo de oportunidade do caixa próprio (fração a.a.), sensível à alocação A4.
function custoOportunidadeCaixa(input: {
  cm_anual: number;
  retorno_marginal_a4: number | null;
  ha_fila_a4_positiva: boolean;
  caixa_suficiente: boolean;
}): number {
  if (input.ha_fila_a4_positiva && !input.caixa_suficiente && input.retorno_marginal_a4 != null) {
    return Math.max(input.cm_anual, input.retorno_marginal_a4);
  }
  return input.cm_anual;
}

type Semana = {
  inicio: string; fim: string; saldo_final: number; total_saidas: number;
  entradas: { id_origem: string; data: string; valor: number }[];
};

type Contexto = "gap" | "sobra" | "indefinido";

function classificarContexto(input: {
  tem_projecao: boolean; menor_saldo_ate_n: number | null; reserva_rs: number;
}): Contexto {
  if (!input.tem_projecao || input.menor_saldo_ate_n == null) return "indefinido";
  return input.menor_saldo_ate_n < input.reserva_rs ? "gap" : "sobra";
}

// Simulação de 2 cenários: antecipar adiciona v_liq hoje e remove o recebimento (id_origem) na semana k.
// Delta sobre saldo_final: +v_liq em todas; -valorEntrada de k em diante. Vale criado se algum saldo
// de k em diante cai < reserva no alternativo mas estava >= reserva no base.
function checaValeEmT(input: {
  semanas: Semana[]; titulo_id: string; v_liq: number; reserva_rs: number;
}): boolean {
  const { semanas, titulo_id, v_liq, reserva_rs } = input;
  const k = semanas.findIndex((s) => s.entradas.some((e) => e.id_origem === titulo_id));
  if (k < 0) return false;
  const valorEntrada = semanas[k].entradas
    .filter((e) => e.id_origem === titulo_id)
    .reduce((acc, e) => acc + e.valor, 0);
  for (let i = k; i < semanas.length; i++) {
    const base = semanas[i].saldo_final;
    const alt = base + v_liq - valorEntrada;
    if (alt < reserva_rs && base >= reserva_rs) return true;
  }
  return false;
}

function classificarEstrutural(input: {
  semanas: Semana[]; reserva_rs: number; limiar_semanas: number;
}): boolean {
  const comGap = input.semanas.filter((s) => s.saldo_final < input.reserva_rs).length;
  return comGap >= input.limiar_semanas;
}

type FonteBenchmark = TipoFonte | "melhor_uso_a4";
type Recomendacao = "antecipar" | "nao_antecipar" | "falta_dado";

type DecisaoTitulo = {
  titulo: { id: string; valor: number; dias: number; nome_cliente: string | null };
  v_liq: number;
  custo_rs_antecipacao: number;
  taxa_efetiva_aa: number | null;
  contexto: Contexto;
  benchmark_fonte: FonteBenchmark | null;
  custo_rs_benchmark: number | null;
  net_rs: number | null;
  recomendacao: Recomendacao;
  flags: string[];
};

function decidirTitulo(input: {
  titulo: { id: string; valor: number; dias: number; nome_cliente?: string | null };
  antecipacao: { taxa_desconto_mensal: number | null; tipo: "desconto" | "factoring"; tarifa_fixa?: number; coobrigacao: boolean };
  alternativas: { capital_giro_cet?: number | null; cheque_cet?: number | null };
  cm_anual: number;
  retorno_marginal_a4: number | null;
  contexto: Contexto;
  flags_extra: string[];
}): DecisaoTitulo {
  const t = { id: input.titulo.id, valor: input.titulo.valor, dias: input.titulo.dias, nome_cliente: input.titulo.nome_cliente ?? null };
  const flags = [...input.flags_extra];
  if (input.antecipacao.coobrigacao) flags.push("coobrigacao");

  // Sem taxa de antecipação configurada/ativa → não há como avaliar a antecipação. Degrada honesto
  // (NUNCA fabrica "antecipar com custo zero" passando taxa 0).
  if (input.antecipacao.taxa_desconto_mensal == null) {
    return {
      titulo: t, v_liq: 0, custo_rs_antecipacao: 0, taxa_efetiva_aa: null,
      contexto: input.contexto, benchmark_fonte: null, custo_rs_benchmark: null, net_rs: null,
      recomendacao: "falta_dado", flags: [...flags, "sem_taxa_antecipacao"],
    };
  }
  const ant = custoAntecipacao({ valor: t.valor, dias: t.dias, taxa_desconto_mensal: input.antecipacao.taxa_desconto_mensal, tipo: input.antecipacao.tipo, tarifa_fixa: input.antecipacao.tarifa_fixa });

  const base: DecisaoTitulo = {
    titulo: t, v_liq: ant.v_liq, custo_rs_antecipacao: ant.custo_rs, taxa_efetiva_aa: ant.taxa_efetiva_aa,
    contexto: input.contexto, benchmark_fonte: null, custo_rs_benchmark: null, net_rs: null, recomendacao: "falta_dado", flags,
  };
  if (ant.v_liq <= 0) return base;

  if (input.contexto === "gap") {
    const cands: { fonte: FonteBenchmark; custo: number }[] = [];
    if (input.alternativas.capital_giro_cet != null) cands.push({ fonte: "capital_giro", custo: custoEmReais(ant.v_liq, t.dias, input.alternativas.capital_giro_cet) });
    if (input.alternativas.cheque_cet != null) cands.push({ fonte: "cheque_especial", custo: custoEmReais(ant.v_liq, t.dias, input.alternativas.cheque_cet) });
    if (cands.length === 0) return base;
    const melhor = cands.reduce((a, b) => (b.custo < a.custo ? b : a));
    const net = melhor.custo - ant.custo_rs;
    return { ...base, benchmark_fonte: melhor.fonte, custo_rs_benchmark: melhor.custo, net_rs: net, recomendacao: net > 0 ? "antecipar" : "nao_antecipar" };
  }

  // sobra | indefinido: o caixa liberado renderia rBench; antecipar vale se ganho > custo.
  const rBench = input.retorno_marginal_a4 != null ? Math.max(input.cm_anual, input.retorno_marginal_a4) : input.cm_anual;
  const ganho = custoEmReais(ant.v_liq, t.dias, rBench);
  const net = ganho - ant.custo_rs;
  const benchmark_fonte: FonteBenchmark = input.retorno_marginal_a4 != null ? "melhor_uso_a4" : "caixa_proprio";
  if (input.contexto === "indefinido") flags.push("sem_projecao");
  return { ...base, benchmark_fonte, custo_rs_benchmark: ganho, net_rs: net, recomendacao: net > 0 ? "antecipar" : "nao_antecipar" };
}

// ===================== Utilitários =====================

// Paginação robusta: evita truncamento silencioso do PostgREST (default ~1000 linhas).
// Verbatim do padrão de fin-valor-cockpit/index.ts.
type DbClient = ReturnType<typeof createClient>;

async function fetchAll<T>(
  db: DbClient,
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const page = 1000; let from = 0; const out: T[] = [];
  for (;;) {
    const { data, error } = await build(from, from + page - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < page) break;
    from += page;
  }
  return out;
}

// Invoke de outra edge function via service_role (verbatim de fin-next-best-action/index.ts).
async function invoke<T>(fn: string, body: unknown): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_ROLE}`, apikey: SERVICE_ROLE, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch { return null; } finally { clearTimeout(timer); }
}

// ===================== Tipos auxiliares de leitura de DB =====================

type FundingInputsRaw = {
  fontes?: {
    antecipacao?: {
      taxa_desconto_mensal_perc?: unknown;
      tarifa_fixa?: unknown;
      tipo?: unknown;
      coobrigacao?: unknown;
      ativo?: unknown;
    };
    capital_giro?: { cet_anual_perc?: unknown; ativo?: unknown };
    cheque_especial?: { cet_anual_perc?: unknown; ativo?: unknown };
  };
  reserva_dias_min?: unknown;
  gap_estrutural_semanas_min?: unknown;
};

function numOrNull(x: unknown): number | null {
  if (x == null || typeof x === "boolean" || Array.isArray(x)) return null;
  if (typeof x !== "number" && typeof x !== "string") return null;
  if (typeof x === "string" && x.trim() === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

type CashflowProjecao = {
  semanas?: Semana[];
  indicadores?: { dias_cobertura?: number; saldo_tesouraria?: number };
};

// ===================== Handler principal =====================

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const auth = await authorizeMaster(req);
  if (!auth.ok) return auth.response;

  // Parse request body
  let company: string;
  try {
    const body = await req.json() as { company?: unknown };
    if (!body.company || typeof body.company !== "string") {
      return jsonResponse({ error: "Campo 'company' obrigatório no body (string)." }, 400);
    }
    company = body.company;
  } catch {
    return jsonResponse({ error: "Body JSON inválido." }, 400);
  }

  const db: DbClient = createClient(SUPABASE_URL, SERVICE_ROLE);
  const hoje = new Date();
  const hojeISO = hoje.toISOString().slice(0, 10);
  const motivos_confianca: string[] = [];

  // ── 1. Lê fin_funding_inputs ────────────────────────────────────────────────
  const { data: fundingRow } = await db
    .from("fin_funding_inputs")
    .select("funding_inputs")
    .eq("company", company)
    .maybeSingle();

  const fi = ((fundingRow as { funding_inputs?: FundingInputsRaw } | null)?.funding_inputs ?? {}) as FundingInputsRaw;

  // Extrai e converte taxas (% → fração).
  const antInput = fi.fontes?.antecipacao;
  const cgInput = fi.fontes?.capital_giro;
  const ceInput = fi.fontes?.cheque_especial;

  const antAtivo = antInput?.ativo === true;
  const taxa_desconto_mensal_perc = numOrNull(antInput?.taxa_desconto_mensal_perc);
  const taxa_desconto_mensal = antAtivo && taxa_desconto_mensal_perc != null ? taxa_desconto_mensal_perc / 100 : null;
  const tarifa_fixa_raw = numOrNull(antInput?.tarifa_fixa);
  const tarifa_fixa = tarifa_fixa_raw ?? 0;
  const tipo_antecipacao: "desconto" | "factoring" = antInput?.tipo === "factoring" ? "factoring" : "desconto";
  const coobrigacao = antInput?.coobrigacao === true;

  const cgAtivo = cgInput?.ativo === true;
  const cg_cet_perc = numOrNull(cgInput?.cet_anual_perc);
  const capital_giro_cet = cgAtivo && cg_cet_perc != null ? cg_cet_perc / 100 : null;

  const ceAtivo = ceInput?.ativo === true;
  const ce_cet_perc = numOrNull(ceInput?.cet_anual_perc);
  const cheque_cet = ceAtivo && ce_cet_perc != null ? ce_cet_perc / 100 : null;

  // Se não há fonte de antecipação configurada e ativa, a engine não consegue decidir.
  if (taxa_desconto_mensal == null) {
    motivos_confianca.push("Fonte de antecipação não configurada ou inativa — todos os títulos retornam 'falta_dado'.");
  }

  const reserva_dias_min = numOrNull(fi.reserva_dias_min) ?? 15;
  const gap_estrutural_semanas_min = numOrNull(fi.gap_estrutural_semanas_min) ?? 6;

  // ── 2. Lê empresa_configuracao_custos → cm_anual ───────────────────────────
  const { data: custosRow } = await db
    .from("empresa_configuracao_custos")
    .select("selic_anual, spread_oportunidade, armazenagem_fisica")
    .eq("empresa", company)
    .maybeSingle();

  let cm_anual: number | null = null;
  if (custosRow) {
    const selic = numOrNull((custosRow as Record<string, unknown>).selic_anual);
    const spread = numOrNull((custosRow as Record<string, unknown>).spread_oportunidade);
    const arm = numOrNull((custosRow as Record<string, unknown>).armazenagem_fisica);
    if (selic != null && spread != null && arm != null) {
      cm_anual = (selic + spread + arm) / 100;
    }
  }
  if (cm_anual == null) {
    motivos_confianca.push("sem_custo_capital: empresa_configuracao_custos ausente ou incompleto — cm_anual indisponível; benchmark de sobra/indefinido usa 0.");
  }

  // ── 3. Lê concentracao_top1_max_pct de fin_config_cashflow ────────────────
  const { data: cfgRow } = await db
    .from("fin_config_cashflow")
    .select("thresholds")
    .eq("company", company)
    .maybeSingle();

  const thresholds = ((cfgRow as { thresholds?: Record<string, unknown> } | null)?.thresholds ?? {}) as Record<string, unknown>;
  const concentracao_top1_max_pct = numOrNull(thresholds.concentracao_top1_max_pct) ?? 20;

  // ── 4. Compõe projeção de 13 semanas via fin-cashflow-engine ───────────────
  // TODO sub-PR B: compor fin-next-best-action → retorno_marginal_melhor_uso
  const projecao = await invoke<CashflowProjecao>("fin-cashflow-engine", {
    company,
    cenario: "realista",
    horizon_weeks: 13,
  });

  const temProjecao = projecao != null && Array.isArray(projecao.semanas) && projecao.semanas.length > 0;
  const semanas: Semana[] = temProjecao ? (projecao!.semanas as Semana[]) : [];

  if (!temProjecao) {
    motivos_confianca.push("Projeção de caixa indisponível (fin-cashflow-engine falhou ou timeout) — contexto de todos os títulos será 'indefinido'.");
  }

  // ── 5. Calcula reserva e estrutural ───────────────────────────────────────
  let reserva_rs = 0;
  let estrutural = false;

  if (temProjecao) {
    const totalSaidas = semanas.reduce((s, sem) => s + (sem.total_saidas ?? 0), 0);
    const burnDiario = totalSaidas / (semanas.length * 7);
    reserva_rs = burnDiario * reserva_dias_min;
    estrutural = classificarEstrutural({ semanas, reserva_rs, limiar_semanas: gap_estrutural_semanas_min });
    if (estrutural) {
      motivos_confianca.push(`Déficit estrutural detectado: ≥${gap_estrutural_semanas_min} semanas abaixo da reserva de R$ ${reserva_rs.toFixed(0)}.`);
    }
  }

  // ── 6. Lê títulos antecipáveis (fetchAll — pode passar de 1000) ───────────
  type TituloRow = {
    id: string;
    nome_cliente: string | null;
    saldo: number;
    data_vencimento: string;
    status_titulo: string;
  };

  let titulos: TituloRow[] = [];
  try {
    titulos = await fetchAll<TituloRow>(
      db,
      (from, to) =>
        db
          .from("fin_contas_receber")
          .select("id, nome_cliente, saldo, data_vencimento, status_titulo")
          .eq("company", company)
          .eq("status_titulo", "ABERTO")
          .gt("saldo", 0)
          .gt("data_vencimento", hojeISO)
          .range(from, to),
      "fin_contas_receber",
    );
  } catch (e) {
    motivos_confianca.push(`Erro ao ler títulos antecipáveis: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── 7. Pré-calcula concentração por sacado ─────────────────────────────────
  const somaPorCliente = new Map<string, number>();
  let totalGeral = 0;
  for (const t of titulos) {
    const cliente = t.nome_cliente ?? "__sem_cliente__";
    somaPorCliente.set(cliente, (somaPorCliente.get(cliente) ?? 0) + (t.saldo ?? 0));
    totalGeral += t.saldo ?? 0;
  }
  const limiteConcentracao = totalGeral > 0 ? (concentracao_top1_max_pct / 100) * totalGeral : Infinity;
  const clientesConcentrados = new Set<string>();
  for (const [cliente, soma] of somaPorCliente.entries()) {
    if (soma > limiteConcentracao) clientesConcentrados.add(cliente);
  }

  // ── 8. Decide cada título ──────────────────────────────────────────────────
  const decisoes: DecisaoTitulo[] = [];

  for (const t of titulos) {
    const dias = Math.max(1, Math.round((new Date(t.data_vencimento + "T00:00:00Z").getTime() - hoje.getTime()) / 86400000));

    // menor_saldo_ate_n: min(saldo_final) das semanas com fim <= data_vencimento.
    let menor_saldo_ate_n: number | null = null;
    if (temProjecao) {
      const semanasAteN = semanas.filter((s) => s.fim <= t.data_vencimento);
      if (semanasAteN.length > 0) {
        menor_saldo_ate_n = Math.min(...semanasAteN.map((s) => s.saldo_final));
      } else {
        // Título vence antes do fim da 1ª semana → usa saldo_final da 1ª semana como proxy.
        menor_saldo_ate_n = semanas[0].saldo_final;
      }
    }

    const contexto = classificarContexto({ tem_projecao: temProjecao, menor_saldo_ate_n, reserva_rs });

    // Flags extras: estrutural, concentração, cria_vale_em_T.
    // Rodamos decidirTitulo primeiro para obter v_liq, depois adicionamos a flag cria_vale_em_T.
    const flags_extra: string[] = [];
    if (estrutural) flags_extra.push("estrutural");
    const cliente = t.nome_cliente ?? "__sem_cliente__";
    if (clientesConcentrados.has(cliente)) flags_extra.push("concentracao_sacado");

    // Monta a decisão (retorno_marginal_a4 = null no sub-PR A).
    // TODO sub-PR B: compor fin-next-best-action → retorno_marginal_melhor_uso
    const decisao = decidirTitulo({
      titulo: { id: t.id, valor: t.saldo, dias, nome_cliente: t.nome_cliente },
      antecipacao: {
        taxa_desconto_mensal, // null quando a fonte de antecipação não está configurada/ativa → decidirTitulo degrada pra falta_dado (NUNCA antecipa grátis)
        tipo: tipo_antecipacao,
        tarifa_fixa,
        coobrigacao,
      },
      alternativas: { capital_giro_cet, cheque_cet },
      cm_anual: cm_anual ?? 0,
      retorno_marginal_a4: null,
      contexto,
      flags_extra,
    });

    // Adiciona flag "cria_vale_em_T" se a antecipação criaria vale no fluxo.
    if (temProjecao && decisao.v_liq > 0) {
      const valeEmT = checaValeEmT({ semanas, titulo_id: t.id, v_liq: decisao.v_liq, reserva_rs });
      if (valeEmT) decisao.flags.push("cria_vale_em_T");
    }

    // Se cm_anual for null, sinaliza que o benchmark de sobra/indefinido é conservador (usou 0).
    if (cm_anual == null && (contexto === "sobra" || contexto === "indefinido")) {
      decisao.flags.push("sem_custo_capital");
    }

    decisoes.push(decisao);
  }

  // ── 9. Ordena: antecipar (net_rs desc) → nao_antecipar → falta_dado ────────
  const ORDEM_REC: Record<Recomendacao, number> = { antecipar: 0, nao_antecipar: 1, falta_dado: 2 };
  decisoes.sort((a, b) => {
    const oa = ORDEM_REC[a.recomendacao], ob = ORDEM_REC[b.recomendacao];
    if (oa !== ob) return oa - ob;
    if (a.recomendacao === "antecipar") return (b.net_rs ?? 0) - (a.net_rs ?? 0);
    return 0;
  });

  // ── 10. Score de confiança ─────────────────────────────────────────────────
  const nAntecipar = decisoes.filter((d) => d.recomendacao === "antecipar").length;
  const nFaltaDado = decisoes.filter((d) => d.recomendacao === "falta_dado").length;
  const nComFlagEstrutural = decisoes.filter((d) => d.flags.includes("estrutural")).length;
  const nComConcentracao = decisoes.filter((d) => d.flags.includes("concentracao_sacado")).length;

  let nivelConfianca: "alta" | "media" | "baixa";
  if (!temProjecao || cm_anual == null) {
    nivelConfianca = "baixa";
  } else if (nComFlagEstrutural > 0 || nComConcentracao > 0 || nFaltaDado > decisoes.length * 0.3) {
    nivelConfianca = "media";
  } else {
    nivelConfianca = "alta";
  }

  // Motivos adicionais.
  if (nFaltaDado > 0 && taxa_desconto_mensal == null) {
    // já capturado acima
  }
  if (nAntecipar > decisoes.length * 0.5 && estrutural) {
    motivos_confianca.push("Maioria dos títulos recomenda antecipação em contexto de déficit estrutural — revisar a configuração de reserva.");
  }

  return jsonResponse({
    company,
    gerado_em: new Date().toISOString(),
    cm_anual,
    tem_projecao: temProjecao,
    estrutural,
    reserva_rs,
    titulos: decisoes,
    confianca: {
      nivel: nivelConfianca,
      motivos: motivos_confianca,
    },
  }, 200);
});
