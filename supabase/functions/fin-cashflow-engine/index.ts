import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// =============================================================
// Helper de autorização inlineado (de _shared/auth.ts)
// =============================================================
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

function unauthorized(message = "Unauthorized"): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type AuthResult =
  | { ok: true; via: "cron" | "service_role" | "staff"; userId?: string }
  | { ok: false; response: Response };

async function authorizeCronOrStaff(req: Request): Promise<AuthResult> {
  const expected = Deno.env.get("CRON_SECRET");
  const cronSecret = req.headers.get("x-cron-secret");
  if (expected && cronSecret && cronSecret === expected) {
    return { ok: true, via: "cron" };
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { ok: false, response: unauthorized() };
  }
  const token = authHeader.slice(7);
  if (token === SERVICE_ROLE) {
    return { ok: true, via: "service_role" };
  }

  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: authHeader, apikey: SERVICE_ROLE },
    });
    if (!userRes.ok) return { ok: false, response: unauthorized() };
    const user = await userRes.json();
    if (!user?.id) return { ok: false, response: unauthorized() };

    const roleRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${user.id}&select=role`,
      { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } },
    );
    if (!roleRes.ok) return { ok: false, response: unauthorized() };
    const roles = (await roleRes.json()) as Array<{ role: string }>;
    const allowed = new Set(["employee", "master"]);
    if (roles.some((r) => allowed.has(r.role))) {
      return { ok: true, via: "staff", userId: user.id };
    }
    return { ok: false, response: unauthorized("Forbidden") };
  } catch {
    return { ok: false, response: unauthorized() };
  }
}

// =============================================================
// Edge function: motor de Inteligência de Caixa (A1)
// =============================================================
type Company = 'oben' | 'colacor' | 'colacor_sc';

// ⚠️ ESPELHO VERBATIM de src/lib/financeiro/titulo-status.ts (testado em vitest).
// VOCABULÁRIO REAL do banco = valores NATIVOS do Omie ('A VENCER'/'ATRASADO'/
// 'VENCE HOJE' = aberto; 'RECEBIDO'/'PAGO' = liquidado). O filtro legado
// ['ABERTO','PARCIAL','VENCIDO'] NUNCA casava → NCG=0 e projeção vazia.
// NÃO incluir liquidados em "aberto": saldo é coluna gerada e valor_recebido=0
// (#396) → liquidado tem saldo cheio → contá-lo infla o NCG em dezenas de milhões.
// Editou aqui? Edite lá também.
const OPEN_TITLE_STATUSES = ['A VENCER', 'ATRASADO', 'VENCE HOJE'] as const;
const OPEN_NOT_OVERDUE_TITLE_STATUSES = ['A VENCER', 'VENCE HOJE'] as const;
const SETTLED_TITLE_STATUSES = ['RECEBIDO', 'PAGO', 'LIQUIDADO'] as const;
const OPEN_SET = new Set<string>(OPEN_TITLE_STATUSES);
const OPEN_NOT_OVERDUE_SET = new Set<string>(OPEN_NOT_OVERDUE_TITLE_STATUSES);
const SETTLED_SET = new Set<string>(SETTLED_TITLE_STATUSES);

function isOpenTitleStatus(status: string | null | undefined): boolean {
  return status != null && OPEN_SET.has(status);
}
function isOpenNotOverdueTitleStatus(status: string | null | undefined): boolean {
  return status != null && OPEN_NOT_OVERDUE_SET.has(status);
}
type TituloStatusClass = 'open' | 'settled' | 'cancelled' | 'unknown';
function classifyTituloStatus(status: string | null | undefined): TituloStatusClass {
  if (status == null) return 'unknown';
  if (OPEN_SET.has(status)) return 'open';
  if (SETTLED_SET.has(status)) return 'settled';
  if (status === 'CANCELADO') return 'cancelled';
  return 'unknown';
}

// Anti-truncamento do PostgREST (cap default de 1000 linhas): a colacor tem ~11k CP
// e ~29k CR não-cancelados; um .select() simples carregaria só as 1000 primeiras
// (quase tudo PAGO/RECEBIDO antigo) e PERDERIA a maioria dos títulos em aberto →
// NCG/projeção subcontados. Pagina via .range() com .order('id') estável (sem order,
// páginas podem repetir/pular linhas). Lança no primeiro erro (não engole truncado).
async function fetchAllRows<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message?: string } | null }>,
): Promise<T[]> {
  const PAGE = 1000;
  const all: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(`fetchAllRows: ${error.message ?? 'erro de query'}`);
    const batch = data ?? [];
    all.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return all;
}
type Cenario = 'realista' | 'otimista' | 'pessimista';

type Input = {
  company: Company;
  cenario?: Cenario;
  horizon_weeks?: number;
  save_snapshot?: boolean;
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  let payload: Input;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON' }, 400);
  }

  if (!payload.company || !['oben', 'colacor', 'colacor_sc'].includes(payload.company)) {
    return jsonResponse({ error: 'company inválido' }, 400);
  }

  const cenario: Cenario = payload.cenario ?? 'realista';
  const horizon = payload.horizon_weeks ?? 13;
  const save = payload.save_snapshot ?? false;

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  try {
    const result = await calcular(supabase, payload.company, cenario, horizon, save);
    return jsonResponse(result, 200);
  } catch (err) {
    return jsonResponse({ error: String((err as Error).message ?? err) }, 500);
  }
});

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

type CR = {
  id: string;
  saldo: number;
  valor_documento: number;
  valor_recebido: number;
  data_emissao: string | null;
  data_vencimento: string | null;
  data_recebimento: string | null;
  status_titulo: string;
  cliente_id: string | null;
  nome_cliente: string | null;
  categoria_codigo: string | null;
  omie_codigo_lancamento: number | null; // join com v_titulo_baixas (baixa derivada)
};

type CP = {
  id: string;
  saldo: number;
  valor_documento: number;
  valor_pago: number;
  data_emissao: string | null;
  data_vencimento: string | null;
  data_pagamento: string | null;
  status_titulo: string;
  categoria_codigo: string | null;
};

type EventoRecorrente = {
  id: string;
  descricao: string;
  valor: number;
  tipo: 'entrada' | 'saida';
  categoria_dre: string | null;
  is_folha: boolean;
  dia_do_mes: number;
  inicio: string;
  fim: string | null;
};

type EventoEventual = {
  id: string;
  descricao: string;
  valor: number;
  tipo: 'entrada' | 'saida';
  categoria_dre: string | null;
  data_prevista: string;
  status: 'previsto' | 'confirmado' | 'cancelado' | 'realizado';
};

type Config = {
  overrides_cenario: {
    otimista: { recebimento_no_prazo_pct_delta: number; inadimplencia_pct_delta: number };
    pessimista: { recebimento_no_prazo_pct_delta: number; inadimplencia_pct_delta: number };
  };
  thresholds: {
    caixa_negativo_semanas: number;
    ncg_deficit_alerta: number;
    dias_cobertura_min: number;
    inadimplencia_max_pct: number;
    concentracao_top1_max_pct: number;
    pmr_crescimento_max_pct_90d: number;
  };
  adiantamento_categorias_codigos: string[];
  // Onda 2: categorias de CP que representam folha (opcional; ativa o guard de
  // folha por janela no NCG). Default [] = guard inerte (usa só o evento recorrente).
  folha_categorias_codigos?: string[];
};

// === Onda 2 — Curvas de cobrança por faixa de aging ===
// Espelho VERBATIM de src/lib/financeiro/aging-helpers.ts (testado em vitest).
// Qualquer mudança aqui deve ser refletida lá e vice-versa.
type Faixa = 'a_vencer' | '1-30' | '31-60' | '61-90' | '+90';

type CurvaFaixa = {
  taxa_recebimento: number; // [0,1]
  lag_dias: number;         // média ponderada por R$ do atraso (recebimento - vencimento)
  lag_mediana: number;
  exposicao: number;
  pago: number;
  aberto: number;
  confianca: 'alta' | 'baixa';
};

type TituloHist = {
  valor_documento: number;
  valor_recebido: number;
  saldo: number;
  data_vencimento: string | null;
  // Baixa REAL derivada das movimentações (v_titulo_baixas) — NÃO a coluna base
  // data_recebimento (sempre NULL no LIST do Omie). null = sem movimento joinável.
  data_baixa_derivada: string | null;
  status_titulo: string;
};

// Espelho VERBATIM de aging-helpers.ts: liquidação por STATUS + valorPagoEfetivo robusto.
// STATUS_LIQUIDADO = mesmo conjunto que SETTLED_TITLE_STATUSES acima (mantido verbatim
// do helper p/ o mirror ser fiel). valor_recebido=0 + saldo cheio nos liquidados (#396)
// → o fallback de valorPagoEfetivo cai em valor_documento (face) = recuperação correta.
const STATUS_LIQUIDADO = ['RECEBIDO', 'LIQUIDADO', 'PAGO'];
function statusLiquidado(status: string | null | undefined): boolean {
  return !!status && STATUS_LIQUIDADO.includes(status);
}
function valorPagoEfetivo(t: { valor_recebido: number; valor_documento: number; saldo: number }): number {
  if (t.valor_recebido > 0) return t.valor_recebido;
  const liq = t.valor_documento - t.saldo;
  if (liq > 0) return liq;
  return t.valor_documento;
}
const COBERTURA_MIN_EMPRESA = 0.4;
const MIN_LIQUIDADOS_COM_DATA = 5;
// Gate de confiança do prazo (PMR/PMP) pela cobertura de baixa derivada (espelho de
// aging-helpers.ts). Abaixo de COBERTURA_MIN_EMPRESA → null ("—", amostra não-representativa).
function prazoComGate(
  valor: number | null | undefined,
  cobertura: number | null | undefined,
  min = COBERTURA_MIN_EMPRESA,
): number | null {
  return (cobertura ?? 0) >= min && valor != null ? Number(valor) : null;
}
// Espelho de aging-helpers.ts (Fase 3 B2): dias_cobertura do caixa operacional projetado.
function diasCoberturaProjetado(
  saldoCc: number,
  saidasHorizonte: number,
  horizonWeeks: number,
): number | null {
  if (saldoCc <= 0) return 0;
  const saidaDiaria = saidasHorizonte / Math.max(1, horizonWeeks * 7);
  return saidaDiaria > 0.01 ? saldoCc / saidaDiaria : null;
}

const FAIXAS: Faixa[] = ['a_vencer', '1-30', '31-60', '61-90', '+90'];

const LAG_MAX: Record<Faixa, number> = {
  'a_vencer': 45, '1-30': 60, '31-60': 90, '61-90': 120, '+90': 365,
};

const CURVA_DEFAULT: Record<Faixa, { taxa_recebimento: number; lag_dias: number }> = {
  'a_vencer': { taxa_recebimento: 0.98, lag_dias: 5 },
  '1-30':     { taxa_recebimento: 0.95, lag_dias: 20 },
  '31-60':    { taxa_recebimento: 0.90, lag_dias: 40 },
  '61-90':    { taxa_recebimento: 0.80, lag_dias: 70 },
  '+90':      { taxa_recebimento: 0.50, lag_dias: 150 },
};

type DadosBase = {
  crs: CR[];
  cps: CP[];
  saldo_cc: number;
  estoque_valor: number;
  estoque_data_ref: string | null;
  cmv_ttm: number;
  eventos_rec: EventoRecorrente[];
  eventos_ev: EventoEventual[];
  curvas_aging: Record<Faixa, CurvaFaixa>;
  // PMR/PMP + cobertura da baixa derivada (view v_capital_giro_prazos, 1 linha/empresa).
  // Fonte ÚNICA do prazo (mesma do card client-side getCapitalDeGiro) → consistência.
  prazos: { pmr: number | null; pmp: number | null; pmr_cobertura: number | null; pmp_cobertura: number | null } | null;
  config: Config;
};

async function carregarDados(
  supabase: ReturnType<typeof createClient>,
  company: Company,
): Promise<DadosBase> {
  // CR/CP paginados (anti-truncamento, ver fetchAllRows); o resto cabe em <1000 e vai
  // em Promise.all. Tudo em paralelo.
  const [crsData, cpsData, baixaCrData, [ccRes, recRes, evRes, configRes, estoqueRes, dreRes, folhaCatRes, prazosRes]] = await Promise.all([
    fetchAllRows<Record<string, unknown>>((from, to) =>
      // @ts-expect-error - fin_contas_receber may not be in generated supabase types yet
      supabase.from('fin_contas_receber').select('id, saldo, valor_documento, valor_recebido, data_emissao, data_vencimento, data_recebimento, status_titulo, omie_codigo_cliente, omie_codigo_lancamento, nome_cliente, categoria_codigo')
        .eq('company', company).neq('status_titulo', 'CANCELADO').order('id', { ascending: true }).range(from, to)
    ),
    fetchAllRows<Record<string, unknown>>((from, to) =>
      // @ts-expect-error - fin_contas_pagar may not be in generated supabase types yet
      supabase.from('fin_contas_pagar').select('id, saldo, valor_documento, valor_pago, data_emissao, data_vencimento, data_pagamento, status_titulo, categoria_codigo')
        .eq('company', company).neq('status_titulo', 'CANCELADO').order('id', { ascending: true }).range(from, to)
    ),
    // Fase 3: baixa REAL derivada (v_titulo_baixas, tipo CR) p/ calibrar o TIMING do
    // aging. Paginado (oben CR ~11k linhas > cap 1000 do PostgREST — sem isso a
    // cobertura cairia falsa). order estável; usado SÓ na calibração, PMR/PMP/dias_
    // cobertura do engine ficam intactos (sem regressão, sem novo viés do colacor).
    fetchAllRows<Record<string, unknown>>((from, to) =>
      // @ts-expect-error - v_titulo_baixas (view nova) não está nos types gerados
      supabase.from('v_titulo_baixas').select('omie_codigo_lancamento, data_baixa_final')
        .eq('company', company).eq('tipo', 'CR').order('omie_codigo_lancamento', { ascending: true }).range(from, to)
    ),
    Promise.all([
      // @ts-expect-error - fin_contas_correntes may not be in generated supabase types yet
      supabase.from('fin_contas_correntes').select('saldo_atual')
        .eq('company', company).eq('ativo', true),
      // @ts-expect-error - fin_eventos_recorrentes not in generated supabase types yet (A1 table)
      supabase.from('fin_eventos_recorrentes').select('id, descricao, valor, tipo, categoria_dre, is_folha, dia_do_mes, inicio, fim')
        .eq('company', company).eq('ativo', true),
      // @ts-expect-error - fin_eventos_eventuais not in generated supabase types yet (A1 table)
      supabase.from('fin_eventos_eventuais').select('id, descricao, valor, tipo, categoria_dre, data_prevista, status')
        .eq('company', company).in('status', ['previsto', 'confirmado']),
      // @ts-expect-error - fin_config_cashflow not in generated supabase types yet (A1 table)
      supabase.from('fin_config_cashflow').select('overrides_cenario, thresholds, adiantamento_categorias_codigos')
        .eq('company', company).maybeSingle(),
      // @ts-expect-error - fin_estoque_valor (Onda 1) não está nos types gerados
      supabase.from('fin_estoque_valor').select('valor, data_ref')
        .eq('company', company).order('data_ref', { ascending: false }).limit(1).maybeSingle(),
      // @ts-expect-error - fin_dre_snapshots não está nos types gerados
      supabase.from('fin_dre_snapshots').select('cmv, ano, mes')
        .eq('company', company).eq('regime', 'competencia'),
      // @ts-expect-error - folha_categorias_codigos é coluna OPCIONAL (Onda 2). Se não
      // existir, PostgREST devolve { data: null, error } — não rejeita; cai em [] e o
      // guard de folha fica inerte (comportamento atual preservado, sem migration obrigatória).
      supabase.from('fin_config_cashflow').select('folha_categorias_codigos')
        .eq('company', company).maybeSingle(),
      // Fase 3 (B): PMR/PMP + cobertura da baixa derivada (view v_capital_giro_prazos).
      // @ts-expect-error - v_capital_giro_prazos (view nova) não está nos types gerados
      supabase.from('v_capital_giro_prazos').select('pmr, pmp, pmr_cobertura, pmp_cobertura')
        .eq('company', company).maybeSingle(),
    ]),
  ]);

  const saldo_cc = ((ccRes.data ?? []) as Array<{ saldo_atual?: number | null }>)
    .reduce((s: number, c) => s + Number(c.saldo_atual ?? 0), 0);

  const estoque_valor = Number((estoqueRes.data as { valor?: number } | null)?.valor ?? 0);
  const estoque_data_ref = (estoqueRes.data as { data_ref?: string } | null)?.data_ref ?? null;

  // CMV TTM: soma dos últimos 12 meses de DRE competência
  const _hojeTtm = new Date();
  const _cutoffMesIdx = (_hojeTtm.getFullYear() * 12 + (_hojeTtm.getMonth() + 1)) - 12;
  const cmv_ttm = ((dreRes.data ?? []) as Array<{ cmv?: number; ano: number; mes: number }>)
    .filter((d) => (d.ano * 12 + d.mes) > _cutoffMesIdx)
    .reduce((s, d) => s + Number(d.cmv ?? 0), 0);

  if (!configRes.data) {
    throw new Error(`Config ausente pra ${company}. Aplique seed em fin_config_cashflow.`);
  }

  const crs: CR[] = (crsData as Array<Record<string, unknown>>).map((c) => ({
    id: c.id as string,
    saldo: Number(c.saldo ?? 0),
    valor_documento: Number(c.valor_documento ?? 0),
    valor_recebido: Number(c.valor_recebido ?? 0),
    data_emissao: (c.data_emissao as string | null) ?? null,
    data_vencimento: (c.data_vencimento as string | null) ?? null,
    data_recebimento: (c.data_recebimento as string | null) ?? null,
    status_titulo: c.status_titulo as string,
    cliente_id: c.omie_codigo_cliente ? String(c.omie_codigo_cliente) : null,
    nome_cliente: (c.nome_cliente as string | null) ?? null,
    categoria_codigo: (c.categoria_codigo as string | null) ?? null,
    omie_codigo_lancamento: c.omie_codigo_lancamento != null ? Number(c.omie_codigo_lancamento) : null,
  }));

  // Fase 3: mapa da baixa derivada por omie_codigo_lancamento (CR), pra calibrar as
  // curvas de aging com o TIMING real do recebimento (não a coluna base sempre-NULL).
  const baixaCrPorCod = new Map<number, string>();
  for (const b of (baixaCrData as Array<{ omie_codigo_lancamento?: number | null; data_baixa_final?: string | null }>)) {
    if (b.omie_codigo_lancamento != null && b.data_baixa_final) {
      baixaCrPorCod.set(Number(b.omie_codigo_lancamento), b.data_baixa_final);
    }
  }

  const cps: CP[] = (cpsData as Array<Record<string, unknown>>).map((c) => ({
    id: c.id as string,
    saldo: Number(c.saldo ?? 0),
    valor_documento: Number(c.valor_documento ?? 0),
    valor_pago: Number(c.valor_pago ?? 0),
    data_emissao: (c.data_emissao as string | null) ?? null,
    data_vencimento: (c.data_vencimento as string | null) ?? null,
    data_pagamento: (c.data_pagamento as string | null) ?? null,
    status_titulo: c.status_titulo as string,
    categoria_codigo: (c.categoria_codigo as string | null) ?? null,
  }));

  // Telemetria de qualidade de dado (codex): se o Omie introduzir um status_titulo
  // novo, ele cai em 'unknown' e NÃO conta como aberto (fail-safe) — mas precisamos
  // SABER, senão um título aberto desconhecido somia silenciosamente do NCG/projeção.
  // Log com os valores distintos pra diagnóstico nos logs da edge.
  const statusDesconhecidos = new Map<string, number>();
  for (const s of [...crs.map((c) => c.status_titulo), ...cps.map((c) => c.status_titulo)]) {
    if (classifyTituloStatus(s) === 'unknown') {
      const k = s ?? '(null)';
      statusDesconhecidos.set(k, (statusDesconhecidos.get(k) ?? 0) + 1);
    }
  }
  if (statusDesconhecidos.size > 0) {
    const resumo = [...statusDesconhecidos.entries()].map(([k, n]) => `${k}=${n}`).join(', ');
    console.warn(`[Cashflow][${company}] status_titulo DESCONHECIDO (não conta como aberto): ${resumo}`);
  }

  // Onda 2: folha categorias (coluna opcional). Leitura defensiva — se a coluna não
  // existe, folhaCatRes.data é null e cai em []; o guard de folha fica inerte.
  const folha_categorias_codigos =
    ((folhaCatRes.data as { folha_categorias_codigos?: string[] } | null)?.folha_categorias_codigos) ?? [];
  const config: Config = { ...(configRes.data as unknown as Config), folha_categorias_codigos };

  // Fase 3 (B): PMR/PMP + cobertura da baixa derivada. Degrada p/ null (+ log) se a
  // view não tiver linha pra empresa → calcularIndicadores mostra "—" honesto.
  const prazos = (prazosRes.data as DadosBase['prazos']) ?? null;
  if (!prazos) {
    console.warn(`[Cashflow][${company}] v_capital_giro_prazos sem linha → PMR/PMP/CCC = null`);
  }

  // Onda 2: curvas de cobrança por aging, calibradas POR EXPOSIÇÃO sobre todos os
  // títulos (não só liquidados — corrige o viés otimista). Uma vez por empresa.
  const hojeIso = new Date().toISOString().slice(0, 10);
  const curvas_aging = calibrarCurvas(
    crs.map((c) => ({
      valor_documento: c.valor_documento,
      valor_recebido: c.valor_recebido,
      saldo: c.saldo,
      data_vencimento: c.data_vencimento,
      // baixa derivada das movimentações (NÃO a coluna base data_recebimento, sempre NULL)
      data_baixa_derivada: c.omie_codigo_lancamento != null
        ? (baixaCrPorCod.get(c.omie_codigo_lancamento) ?? null)
        : null,
      status_titulo: c.status_titulo,
    })),
    hojeIso,
  );

  return {
    crs,
    cps,
    saldo_cc,
    estoque_valor,
    estoque_data_ref,
    cmv_ttm,
    eventos_rec: (recRes.data ?? []) as unknown as EventoRecorrente[],
    eventos_ev: (evRes.data ?? []) as unknown as EventoEventual[],
    curvas_aging,
    prazos,
    config,
  };
}

type TaxasHistoricas = {
  atraso_medio_dias: number;
  inadimplencia_observada_pct: number;
  amostra_suficiente: boolean;
  qtd_titulos: number;
};

function calcularTaxasHistoricas(crs: CR[]): TaxasHistoricas {
  const agora = Date.now();
  const noventa = 90 * 24 * 60 * 60 * 1000;
  const cutoff = new Date(agora - 12 * 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const recentes = crs.filter(c =>
    c.data_vencimento && c.data_vencimento >= cutoff
  );

  const liquidados = recentes.filter(c => c.data_recebimento && c.data_vencimento);
  let somaAtraso = 0;
  for (const c of liquidados) {
    const venc = new Date(c.data_vencimento!).getTime();
    const rec = new Date(c.data_recebimento!).getTime();
    somaAtraso += Math.max(0, (rec - venc) / (24 * 60 * 60 * 1000));
  }
  const atraso_medio_dias = liquidados.length > 0 ? somaAtraso / liquidados.length : 0;

  const vencidoLongo = recentes.filter(c =>
    c.data_vencimento &&
    c.saldo > 0 &&
    (agora - new Date(c.data_vencimento).getTime()) > noventa
  ).reduce((s, c) => s + c.saldo, 0);

  const faturamento12m = recentes.reduce((s, c) => s + c.valor_documento, 0);
  const inadimplencia_observada_pct = faturamento12m > 0
    ? (vencidoLongo / faturamento12m) * 100
    : 0;

  return {
    atraso_medio_dias,
    inadimplencia_observada_pct,
    amostra_suficiente: liquidados.length >= 30,
    qtd_titulos: liquidados.length,
  };
}

type PremissasAplicadas = {
  inadimplencia_pct: number;
  atraso_medio_dias: number;
  overrides_cenario: Record<string, unknown>;
  // Onda 2: curvas por faixa COM cenário aplicado (clamps) — driver do timing.
  curvas: Record<Faixa, CurvaFaixa>;
};

function aplicarCenario(
  taxas: TaxasHistoricas,
  cenario: Cenario,
  config: Config,
  curvasAging: Record<Faixa, CurvaFaixa>,
): PremissasAplicadas {
  // Onda 2: deltas do cenário aplicados a cada curva, com clamp (taxa∈[0,1], lag∈[0,LAG_MAX]).
  // No realista os deltas são 0 → curva calibrada pura.
  const deltas = cenario === 'realista'
    ? { recebimento_no_prazo_pct_delta: 0, inadimplencia_pct_delta: 0 }
    : config.overrides_cenario[cenario];
  const curvas = {} as Record<Faixa, CurvaFaixa>;
  for (const f of FAIXAS) {
    curvas[f] = aplicarCenarioCurva(curvasAging[f], f, deltas);
  }

  if (cenario === 'realista') {
    return {
      inadimplencia_pct: taxas.inadimplencia_observada_pct,
      atraso_medio_dias: taxas.atraso_medio_dias,
      overrides_cenario: {},
      curvas,
    };
  }

  const overrides = config.overrides_cenario[cenario];
  const inadAjustado = taxas.inadimplencia_observada_pct * (1 + overrides.inadimplencia_pct_delta / 100);
  const atrasoAjustado = taxas.atraso_medio_dias * (1 - overrides.recebimento_no_prazo_pct_delta / 100);

  return {
    inadimplencia_pct: Math.max(0, inadAjustado),
    atraso_medio_dias: Math.max(0, atrasoAjustado),
    overrides_cenario: overrides as Record<string, unknown>,
    curvas,
  };
}

type LinhaCashflow = {
  origem: 'cr_omie' | 'cp_omie' | 'evento_recorrente' | 'evento_eventual';
  desc: string;
  data: string;
  valor: number;
  id_origem: string;
};

type Semana = {
  inicio: string;
  fim: string;
  saldo_inicial: number;
  entradas: LinhaCashflow[];
  saidas: LinhaCashflow[];
  total_entradas: number;
  total_saidas: number;
  saldo_final: number;
};

function inicioSemanaUTC(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Math.round(days)); // Math.round: lag_dias pode ser fracionário
  return d.toISOString().slice(0, 10);
}

// === Onda 2 — helpers de aging (espelho VERBATIM de aging-helpers.ts) ===
function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(a + 'T00:00:00Z').getTime() - new Date(b + 'T00:00:00Z').getTime()) / 86400000,
  );
}

function faixaAging(diasAtraso: number): Faixa {
  if (diasAtraso <= 0) return 'a_vencer';
  if (diasAtraso <= 30) return '1-30';
  if (diasAtraso <= 60) return '31-60';
  if (diasAtraso <= 90) return '61-90';
  return '+90';
}

function mediaPonderada(itens: Array<{ valor: number; peso: number }>): number {
  const somaPeso = itens.reduce((s, i) => s + i.peso, 0);
  if (somaPeso <= 0) return 0;
  return itens.reduce((s, i) => s + i.valor * i.peso, 0) / somaPeso;
}

function mediana(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function calibrarCurvas(
  titulos: TituloHist[],
  hoje: string,
  minTitulos = 20,
  minVolume = 50000,
  minLiquidadosComData = MIN_LIQUIDADOS_COM_DATA,
  coberturaMinEmpresa = COBERTURA_MIN_EMPRESA,
): Record<Faixa, CurvaFaixa> {
  // Cobertura da empresa: fração dos liquidados-por-status que têm baixa derivada.
  let liqTotal = 0, liqComData = 0;
  for (const t of titulos) {
    if (statusLiquidado(t.status_titulo)) {
      liqTotal += 1;
      if (t.data_baixa_derivada) liqComData += 1;
    }
  }
  const coberturaEmpresa = liqTotal > 0 ? liqComData / liqTotal : 0;
  const empresaCalibravel = coberturaEmpresa >= coberturaMinEmpresa;

  const acc: Record<Faixa, {
    exposicao: number; pago: number; aberto: number; count: number; countLiqData: number;
    topValor: number; lags: Array<{ valor: number; peso: number }>; lagsRaw: number[];
  }> = Object.fromEntries(
    FAIXAS.map((f) => [f, { exposicao: 0, pago: 0, aberto: 0, count: 0, countLiqData: 0, topValor: 0, lags: [], lagsRaw: [] }]),
  ) as unknown as Record<Faixa, {
    exposicao: number; pago: number; aberto: number; count: number; countLiqData: number;
    topValor: number; lags: Array<{ valor: number; peso: number }>; lagsRaw: number[];
  }>;

  for (const t of titulos) {
    if (!t.data_vencimento) continue;
    const liquidado = statusLiquidado(t.status_titulo);
    const temData = !!t.data_baixa_derivada;
    if (liquidado && temData) {
      const faixa = faixaAging(daysBetween(t.data_baixa_derivada!, t.data_vencimento));
      const a = acc[faixa];
      const pago = valorPagoEfetivo(t);
      a.exposicao += t.valor_documento;
      a.count += 1;
      a.countLiqData += 1;
      a.topValor = Math.max(a.topValor, t.valor_documento);
      a.pago += pago;
      const lag = Math.max(0, daysBetween(t.data_baixa_derivada!, t.data_vencimento));
      a.lags.push({ valor: lag, peso: pago });
      a.lagsRaw.push(lag);
    } else if (!liquidado) {
      const faixa = faixaAging(daysBetween(hoje, t.data_vencimento));
      const a = acc[faixa];
      a.exposicao += t.valor_documento;
      a.count += 1;
      a.topValor = Math.max(a.topValor, t.valor_documento);
      a.aberto += t.saldo;
    }
    // liquidado && !temData → EXCLUÍDO (sabemos QUE pagou, não QUANDO)
  }

  const out = {} as Record<Faixa, CurvaFaixa>;
  for (const f of FAIXAS) {
    const a = acc[f];
    const volOk = a.exposicao >= minVolume;
    const countOk = a.count >= minTitulos;
    const concentracaoOk = a.exposicao > 0 ? (a.topValor / a.exposicao) <= 0.6 : false;
    const liqDataOk = a.countLiqData >= minLiquidadosComData && a.pago > 0;
    const confiavel = empresaCalibravel && countOk && volOk && concentracaoOk && liqDataOk;
    if (confiavel) {
      out[f] = {
        taxa_recebimento: Math.min(1, Math.max(0, a.exposicao > 0 ? a.pago / a.exposicao : 0)),
        lag_dias: mediaPonderada(a.lags),
        lag_mediana: mediana(a.lagsRaw),
        exposicao: a.exposicao, pago: a.pago, aberto: a.aberto,
        confianca: 'alta',
      };
    } else {
      out[f] = {
        taxa_recebimento: CURVA_DEFAULT[f].taxa_recebimento,
        lag_dias: CURVA_DEFAULT[f].lag_dias,
        lag_mediana: CURVA_DEFAULT[f].lag_dias,
        exposicao: a.exposicao, pago: a.pago, aberto: a.aberto,
        confianca: 'baixa',
      };
    }
  }
  return out;
}

function dataRecebimentoEsperada(input: {
  data_vencimento: string;
  hoje: string;
  faixa: Faixa;
  lag_dias_faixa: number;
  lag_residual_default?: number;
}): string {
  const residual = input.lag_residual_default ?? 15;
  if (input.faixa === 'a_vencer') {
    return addDays(input.data_vencimento, input.lag_dias_faixa);
  }
  const diasAtraso = daysBetween(input.hoje, input.data_vencimento);
  const lagRestante = input.lag_dias_faixa - diasAtraso;
  // Estimativa positiva = ainda dentro do lag esperado → usa ela.
  // Se já passou do lag esperado (≤0), usa residual pra não cair "hoje seco".
  return addDays(input.hoje, lagRestante > 0 ? lagRestante : residual);
}

function aplicarCenarioCurva(
  curva: CurvaFaixa,
  faixa: Faixa,
  deltas: { recebimento_no_prazo_pct_delta: number; inadimplencia_pct_delta: number },
): CurvaFaixa {
  const perda = 1 - curva.taxa_recebimento;
  const perdaNova = perda * (1 + deltas.inadimplencia_pct_delta / 100);
  const taxa = Math.min(1, Math.max(0, 1 - perdaNova));
  const lagBruto = curva.lag_dias * (1 - deltas.recebimento_no_prazo_pct_delta / 100);
  const lag = Math.min(LAG_MAX[faixa], Math.max(0, lagBruto));
  return { ...curva, taxa_recebimento: taxa, lag_dias: lag };
}

function inadimplenciaPonderada(
  crsAbertos: Array<{ saldo: number; faixa: Faixa }>,
  curvas: Record<Faixa, { taxa_recebimento: number }>,
): number {
  const itens = crsAbertos.map((c) => ({ valor: 1 - curvas[c.faixa].taxa_recebimento, peso: c.saldo }));
  return mediaPonderada(itens) * 100;
}

function prazoMedioPonderado(titulos: Array<{ dias: number; valor: number }>): number {
  return mediaPonderada(titulos.map((t) => ({ valor: t.dias, peso: t.valor })));
}

function expandirRecorrenteDeno(
  rec: EventoRecorrente,
  de: string,
  ate: string,
): string[] {
  const result: string[] = [];
  const startBase = rec.inicio > de ? rec.inicio : de;
  const start = new Date(startBase + 'T00:00:00Z');
  const end = new Date(ate + 'T00:00:00Z');
  const fim = rec.fim ? new Date(rec.fim + 'T00:00:00Z') : null;

  let ano = start.getUTCFullYear();
  let mes1 = start.getUTCMonth() + 1;
  while (true) {
    const ultimoDia = new Date(Date.UTC(ano, mes1, 0)).getUTCDate();
    const dia = Math.min(rec.dia_do_mes, ultimoDia);
    const candidato = new Date(Date.UTC(ano, mes1 - 1, dia));
    if (candidato > end) break;
    if (candidato >= start && (!fim || candidato <= fim)) {
      result.push(candidato.toISOString().slice(0, 10));
    }
    mes1++;
    if (mes1 > 12) { mes1 = 1; ano++; }
  }
  return result;
}

type ResultadoSemanas = {
  semanas: Semana[];
  apos_horizonte: number; // R$ esperado a entrar DEPOIS das 13 semanas (não vira caixa projetado)
  ar_impaired: number;    // R$ de perda esperada sobre o CR aberto ((1 − taxa) × saldo)
};

function gerarSemanas(
  dados: DadosBase,
  premissas: PremissasAplicadas,
  horizon: number,
): ResultadoSemanas {
  const hoje = new Date().toISOString().slice(0, 10);
  const semanaInicio = inicioSemanaUTC(hoje);
  const horizonFim = addDays(semanaInicio, horizon * 7); // exclusivo: 1º dia FORA do horizonte

  // === Onda 2: alocação de CR por curva de aging (uma vez, fora do loop de semanas) ===
  // Vencido reagenda pra frente (não some); recebimento esperado fora das 13s vai pra
  // ponte "após horizonte"; a parte não-recebível (1−taxa) acumula em ar_impaired.
  let apos_horizonte = 0;
  let ar_impaired = 0;
  const crPorSemana: LinhaCashflow[][] = Array.from({ length: horizon }, () => []);
  for (const cr of dados.crs) {
    if (!cr.data_vencimento || cr.saldo <= 0) continue;
    if (!isOpenTitleStatus(cr.status_titulo)) continue;
    const diasAtraso = daysBetween(hoje, cr.data_vencimento);
    const faixa = faixaAging(diasAtraso);
    const curva = premissas.curvas[faixa];
    const valor = cr.saldo * curva.taxa_recebimento;
    ar_impaired += cr.saldo * (1 - curva.taxa_recebimento);
    const dataEsp = dataRecebimentoEsperada({
      data_vencimento: cr.data_vencimento,
      hoje,
      faixa,
      lag_dias_faixa: curva.lag_dias,
    });
    if (dataEsp < semanaInicio || dataEsp >= horizonFim) {
      apos_horizonte += valor;
      continue;
    }
    const idx = Math.floor(daysBetween(dataEsp, semanaInicio) / 7);
    if (idx < 0 || idx >= horizon) { apos_horizonte += valor; continue; }
    crPorSemana[idx].push({
      origem: 'cr_omie',
      desc: cr.nome_cliente || 'Cliente',
      data: dataEsp,
      valor,
      id_origem: cr.id,
    });
  }

  const semanas: Semana[] = [];
  let saldoAtual = dados.saldo_cc;

  for (let i = 0; i < horizon; i++) {
    const inicio = addDays(semanaInicio, i * 7);
    const fim = addDays(inicio, 6);

    const entradas: LinhaCashflow[] = [...crPorSemana[i]];
    const saidas: LinhaCashflow[] = [];

    for (const cp of dados.cps) {
      if (!cp.data_vencimento || cp.saldo <= 0) continue;
      // P1 (codex): SÓ CP em aberto projeta saída. Sem isto, um título PAGO com
      // vencimento futuro entraria como saída fantasma — seu `saldo` é cheio porque
      // valor_pago=0 (#396). Simétrico ao filtro do loop de CR acima.
      if (!isOpenTitleStatus(cp.status_titulo)) continue;
      if (cp.data_vencimento < inicio || cp.data_vencimento > fim) continue;
      saidas.push({
        origem: 'cp_omie',
        desc: cp.categoria_codigo || 'Fornecedor',
        data: cp.data_vencimento,
        valor: cp.saldo,
        id_origem: cp.id,
      });
    }

    for (const rec of dados.eventos_rec) {
      const ocorrencias = expandirRecorrenteDeno(rec, inicio, fim);
      for (const dataOc of ocorrencias) {
        const linha: LinhaCashflow = {
          origem: 'evento_recorrente',
          desc: rec.descricao,
          data: dataOc,
          valor: rec.valor,
          id_origem: rec.id,
        };
        if (rec.tipo === 'entrada') entradas.push(linha);
        else saidas.push(linha);
      }
    }

    for (const ev of dados.eventos_ev) {
      if (ev.data_prevista < inicio || ev.data_prevista > fim) continue;
      const linha: LinhaCashflow = {
        origem: 'evento_eventual',
        desc: ev.descricao,
        data: ev.data_prevista,
        valor: ev.valor,
        id_origem: ev.id,
      };
      if (ev.tipo === 'entrada') entradas.push(linha);
      else saidas.push(linha);
    }

    const total_entradas = entradas.reduce((s, l) => s + l.valor, 0);
    const total_saidas = saidas.reduce((s, l) => s + l.valor, 0);
    const saldo_final = saldoAtual + total_entradas - total_saidas;

    semanas.push({
      inicio, fim,
      saldo_inicial: saldoAtual,
      entradas, saidas,
      total_entradas, total_saidas,
      saldo_final,
    });

    saldoAtual = saldo_final;
  }

  return { semanas, apos_horizonte, ar_impaired };
}

type NCG = {
  aco: { cr_aberto: number; estoque: number; adiantamentos: number; total: number };
  pco: { cp_fornecedor: number; folha_30d: number; tributos_a_pagar: number; total: number };
  valor: number;
  projecao_12m: Array<{ mes: string; valor: number }>;
};

function calcularNCG(dados: DadosBase): NCG {
  const cr_aberto = dados.crs
    .filter(c => isOpenTitleStatus(c.status_titulo) && c.saldo > 0)
    .reduce((s, c) => s + c.saldo, 0);
  const adiantamentos = dados.cps
    .filter(c =>
      c.categoria_codigo &&
      dados.config.adiantamento_categorias_codigos.includes(c.categoria_codigo) &&
      isOpenNotOverdueTitleStatus(c.status_titulo) &&
      c.saldo > 0
    )
    .reduce((s, c) => s + c.saldo, 0);
  const aco = {
    cr_aberto,
    estoque: dados.estoque_valor,
    adiantamentos,
    total: cr_aberto + dados.estoque_valor + adiantamentos,
  };

  // === Onda 2: guard de folha por janela (data + categoria) ===
  // Se a folha já está no ERP como CP de categoria de folha vencendo em ≤30d, ela já
  // entra em cp_fornecedor — não somar o evento recorrente de folha em cima. Regra:
  // ERP vence (folha_30d = max(CP folha na janela, recorrente)); os CPs de folha na
  // janela saem de cp_fornecedor (contados uma vez, em folha_30d). Sem categorias de
  // folha configuradas → guard inerte: cp_fornecedor inalterado, folha = recorrente.
  const folhaCats = dados.config.folha_categorias_codigos ?? [];
  const hojeNcg = new Date().toISOString().slice(0, 10);
  const limite30 = addDays(hojeNcg, 30);
  const isFolhaCPJanela = (c: CP): boolean =>
    folhaCats.length > 0 &&
    c.categoria_codigo != null && folhaCats.includes(c.categoria_codigo) &&
    c.data_vencimento != null && c.data_vencimento <= limite30;

  const cp_fornecedor = dados.cps
    .filter(c =>
      isOpenTitleStatus(c.status_titulo) &&
      c.saldo > 0 &&
      (!c.categoria_codigo || !dados.config.adiantamento_categorias_codigos.includes(c.categoria_codigo)) &&
      !(c.categoria_codigo && c.categoria_codigo.startsWith('3.99')) &&
      !isFolhaCPJanela(c)
    )
    .reduce((s, c) => s + c.saldo, 0);

  const folhaRecorrente = dados.eventos_rec
    .filter(e => e.is_folha && e.tipo === 'saida')
    .reduce((s, e) => s + e.valor, 0);
  const folhaCP30d = dados.cps
    .filter(c => isFolhaCPJanela(c) && isOpenTitleStatus(c.status_titulo) && c.saldo > 0)
    .reduce((s, c) => s + c.saldo, 0);
  const folha_30d = folhaCP30d > 0 ? Math.max(folhaCP30d, folhaRecorrente) : folhaRecorrente;

  const tributos_a_pagar = dados.cps
    .filter(c =>
      isOpenTitleStatus(c.status_titulo) &&
      c.saldo > 0 &&
      c.categoria_codigo && c.categoria_codigo.startsWith('3.99')
    )
    .reduce((s, c) => s + c.saldo, 0);

  const pco = {
    cp_fornecedor,
    folha_30d,
    tributos_a_pagar,
    total: cp_fornecedor + folha_30d + tributos_a_pagar,
  };

  const valor = aco.total - pco.total;

  const hoje = new Date();
  const projecao_12m: Array<{ mes: string; valor: number }> = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() + i, 1);
    projecao_12m.push({
      mes: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      valor,
    });
  }

  return { aco, pco, valor, projecao_12m };
}

type Indicadores = {
  // null quando não há base de saída projetada (Fase 3 B2) → alerta de cobertura pula.
  dias_cobertura: number | null;
  liquidez_operacional_liquida: number;
  saldo_tesouraria: number;
  inadimplencia_pct: number;
  concentracao_top5_clientes: Array<{ cliente: string; pct: number; valor: number }>;
  // null quando a cobertura de baixa derivada é baixa (< COBERTURA_MIN_EMPRESA) → "—".
  // PME é independente da baixa (estoque/cmv) → sempre number.
  prazo_medio_recebimento: number | null;
  prazo_medio_pagamento: number | null;
  prazo_medio_estoque: number;
  cash_conversion_cycle: number | null;
};

function calcularIndicadores(
  dados: DadosBase,
  ncg: NCG,
  saidasHorizonte: number,
  horizonWeeks: number,
  company?: string,
): Indicadores {
  const hoje = new Date().toISOString().slice(0, 10);
  // Fase 3 (B2): dias_cobertura do CAIXA OPERACIONAL PROJETADO, não da coluna base
  // data_pagamento (sempre NULL → dava 999 "infinito" e desligava o alerta). Saída
  // diária = Σ total_saidas do horizonte / (horizon*7) = CP por vencimento + folha/
  // impostos (eventos) — operacional por construção, SEM transferência entre contas
  // próprias (que não entram em CP/eventos). saldo<=0 → 0 (crítico); saída ~0 → null
  // ("sem base de saída", não cobertura infinita); o alerta pula quando null. (codex)
  const dias_cobertura = diasCoberturaProjetado(dados.saldo_cc, saidasHorizonte, horizonWeeks);
  console.log(`[Cashflow][${company ?? '?'}] dias_cobertura=${dias_cobertura ?? 'null'} saidas_horizonte=${saidasHorizonte.toFixed(2)}`);

  const liquidez_operacional_liquida = dados.saldo_cc + ncg.aco.cr_aberto + ncg.aco.estoque - ncg.pco.total;
  const saldo_tesouraria = dados.saldo_cc - ncg.pco.folha_30d;

  // Fase 3 (B): PMR/PMP da baixa DERIVADA (view v_capital_giro_prazos), com gate de
  // cobertura — mesma fonte e mesmo gate do card client-side (getCapitalDeGiro). A
  // coluna base data_recebimento/data_pagamento é sempre NULL no LIST do Omie; usá-la
  // dava PMR=PMP=0d (mostrado em NcgDecomposicao). null = "—" (cobertura < 40%).
  const pmr = prazoComGate(dados.prazos?.pmr, dados.prazos?.pmr_cobertura);
  const pmp = prazoComGate(dados.prazos?.pmp, dados.prazos?.pmp_cobertura);

  const pme = dados.cmv_ttm > 0 ? (dados.estoque_valor / dados.cmv_ttm) * 365 : 0;
  // CCC só faz sentido com PMR E PMP (sem um dos dois, ciclo parcial engana). PME mostra à parte.
  const ccc = (pmr !== null && pmp !== null) ? pmr + pme - pmp : null;

  // Onda 2: inadimplência = média ponderada por R$ de (1 − taxa_recebimento[faixa]) sobre
  // o CR aberto. Taxa de perda limpa — não mistura mais estoque (saldo >90) com fluxo (12m).
  const crsAbertos = dados.crs.filter(c =>
    isOpenTitleStatus(c.status_titulo) && c.saldo > 0 && c.data_vencimento,
  );
  const inadimplencia_pct = inadimplenciaPonderada(
    crsAbertos.map(c => ({ saldo: c.saldo, faixa: faixaAging(daysBetween(hoje, c.data_vencimento!)) })),
    dados.curvas_aging,
  );

  const porCliente = new Map<string, number>();
  for (const cr of dados.crs) {
    if (cr.saldo <= 0) continue;
    const key = cr.nome_cliente || cr.cliente_id || 'sem cliente';
    porCliente.set(key, (porCliente.get(key) ?? 0) + cr.saldo);
  }
  const totalAberto = ncg.aco.cr_aberto;
  const concentracao_top5_clientes = Array.from(porCliente.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cliente, valor]) => ({
      cliente,
      valor,
      pct: totalAberto > 0 ? (valor / totalAberto) * 100 : 0,
    }));

  return {
    dias_cobertura,
    liquidez_operacional_liquida,
    saldo_tesouraria,
    inadimplencia_pct,
    concentracao_top5_clientes,
    prazo_medio_recebimento: pmr,
    prazo_medio_pagamento: pmp,
    prazo_medio_estoque: pme,
    cash_conversion_cycle: ccc,
  };
}

type Alerta = {
  tipo: string;
  severidade: 'info' | 'aviso' | 'critico';
  mensagem: string;
  valor: number | null;
  threshold: number | null;
  contexto: Record<string, unknown>;
};

function avaliarAlertas(
  semanas: Semana[],
  ncg: NCG,
  indicadores: Indicadores,
  config: Config,
): Alerta[] {
  const alertas: Alerta[] = [];
  const t = config.thresholds;

  const semanaNeg = semanas.slice(0, t.caixa_negativo_semanas).findIndex(s => s.saldo_final < 0);
  if (semanaNeg >= 0) {
    const s = semanas[semanaNeg];
    alertas.push({
      tipo: 'caixa_negativo',
      severidade: 'critico',
      mensagem: `Caixa fica negativo em ${s.inicio} (semana ${semanaNeg + 1}): ${formatBRLSimple(s.saldo_final)}`,
      valor: s.saldo_final,
      threshold: 0,
      contexto: { semana: semanaNeg + 1, inicio: s.inicio },
    });
  }

  // 2. NCG > Liquidez Operacional Líquida (déficit)
  if (ncg.valor > indicadores.liquidez_operacional_liquida) {
    const gap = ncg.valor - indicadores.liquidez_operacional_liquida;
    alertas.push({
      tipo: 'ncg_deficit',
      severidade: 'aviso',
      mensagem: `NCG ${formatBRLSimple(ncg.valor)} excede Liquidez Operacional Líquida ${formatBRLSimple(indicadores.liquidez_operacional_liquida)} em ${formatBRLSimple(gap)}. Risco de liquidez.`,
      valor: gap,
      threshold: 0,
      contexto: { ncg: ncg.valor, cgp: indicadores.liquidez_operacional_liquida },
    });
  }

  // dias_cobertura null = sem base de saída projetada → não dá pra avaliar (pula, não floda).
  if (indicadores.dias_cobertura !== null && indicadores.dias_cobertura < t.dias_cobertura_min) {
    alertas.push({
      tipo: 'cobertura_baixa',
      severidade: 'aviso',
      mensagem: `Caixa cobre só ${indicadores.dias_cobertura.toFixed(1)} dias de operação (mín: ${t.dias_cobertura_min})`,
      valor: indicadores.dias_cobertura,
      threshold: t.dias_cobertura_min,
      contexto: {},
    });
  }

  if (indicadores.inadimplencia_pct > t.inadimplencia_max_pct) {
    alertas.push({
      tipo: 'inadimplencia_alta',
      severidade: 'aviso',
      mensagem: `Inadimplência ${indicadores.inadimplencia_pct.toFixed(1)}% acima do limite de ${t.inadimplencia_max_pct}%`,
      valor: indicadores.inadimplencia_pct,
      threshold: t.inadimplencia_max_pct,
      contexto: {},
    });
  }

  const top1 = indicadores.concentracao_top5_clientes[0];
  if (top1 && top1.pct > t.concentracao_top1_max_pct) {
    alertas.push({
      tipo: 'concentracao_top1',
      severidade: 'info',
      mensagem: `Cliente "${top1.cliente}" representa ${top1.pct.toFixed(1)}% do CR aberto (limite: ${t.concentracao_top1_max_pct}%)`,
      valor: top1.pct,
      threshold: t.concentracao_top1_max_pct,
      contexto: { cliente: top1.cliente, valor: top1.valor },
    });
  }

  const s0 = semanas[0];
  if (s0 && s0.total_entradas > 0 && s0.total_saidas > s0.total_entradas * 2) {
    alertas.push({
      tipo: 'saida_spike',
      severidade: 'info',
      mensagem: `Próxima semana: saídas ${formatBRLSimple(s0.total_saidas)} vs entradas ${formatBRLSimple(s0.total_entradas)}`,
      valor: s0.total_saidas,
      threshold: s0.total_entradas * 2,
      contexto: { semana_inicio: s0.inicio },
    });
  }

  return alertas;
}

function formatBRLSimple(value: number): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const formatted = abs.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}R$ ${formatted}`;
}

async function calcular(
  supabase: ReturnType<typeof createClient>,
  company: Company,
  cenario: Cenario,
  horizon: number,
  save: boolean,
) {
  const dados = await carregarDados(supabase, company);
  const taxas = calcularTaxasHistoricas(dados.crs);
  const premissas = aplicarCenario(taxas, cenario, dados.config, dados.curvas_aging);
  const { semanas, apos_horizonte, ar_impaired } = gerarSemanas(dados, premissas, horizon);
  const ncg = calcularNCG(dados);
  // Fase 3 (B2): saída operacional projetada do horizonte → dias_cobertura.
  const saidasHorizonte = semanas.reduce((s, w) => s + w.total_saidas, 0);
  const indicadores = calcularIndicadores(dados, ncg, saidasHorizonte, horizon, company);
  const alertas = avaliarAlertas(semanas, ncg, indicadores, dados.config);

  // Auditoria: premissas aplicadas (curvas c/ cenário) + curvas calibradas puras + ponte.
  const premissasSnapshot = {
    ...premissas,
    curvas_aging: dados.curvas_aging,
    apos_horizonte,
    ar_impaired,
  };

  // Persistência de alertas (codex): SÓ no cenário canônico 'realista' do snapshot
  // autoritativo (save). Antes a engine só INSERIA → alerta resolvido ficava preso
  // pra sempre (ex.: o ncg_deficit=0 do bug histórico de status). Agora:
  //   - condição persiste → ATUALIZA o ativo (valores frescos; corrige mensagem stale)
  //   - condição nova → INSERE
  //   - condição resolvida → DISMISSA
  // ⚠️ TIPOS_AVALIADOS escopa o dismiss SÓ aos tipos DESTA engine — a tabela
  // fin_alertas também guarda sync_*/data_health_* (watchdog/sentinela); dismissar
  // por exclusão sem esse escopo apagaria alertas de outros sistemas. Manter 1:1
  // com avaliarAlertas().
  if (save && cenario === 'realista') {
    const TIPOS_AVALIADOS = [
      'caixa_negativo', 'ncg_deficit', 'cobertura_baixa',
      'inadimplencia_alta', 'concentracao_top1', 'saida_spike',
    ];
    const tiposAtivos = new Set(alertas.map((a) => a.tipo));
    const nowIso = new Date().toISOString();

    for (const a of alertas) {
      const { data: existente } = await supabase.from('fin_alertas')
        .select('id').eq('company', company).eq('tipo', a.tipo).is('dismissed_at', null).maybeSingle();
      if (existente) {
        // @ts-expect-error - fin_alertas not in supabase types yet
        await supabase.from('fin_alertas').update({
          severidade: a.severidade, mensagem: a.mensagem,
          valor: a.valor, threshold: a.threshold, contexto: a.contexto,
        }).eq('id', (existente as { id: string }).id);
      } else {
        // @ts-expect-error - fin_alertas not in supabase types yet
        await supabase.from('fin_alertas').insert({
          company, tipo: a.tipo, severidade: a.severidade, mensagem: a.mensagem,
          valor: a.valor, threshold: a.threshold, contexto: a.contexto,
        });
      }
    }

    const tiposParaDismiss = TIPOS_AVALIADOS.filter((t) => !tiposAtivos.has(t));
    if (tiposParaDismiss.length > 0) {
      // @ts-expect-error - fin_alertas not in supabase types yet
      await supabase.from('fin_alertas').update({ dismissed_at: nowIso })
        .eq('company', company).in('tipo', tiposParaDismiss).is('dismissed_at', null);
    }
  }

  if (save) {
    // @ts-expect-error - fin_projecao_snapshots not in generated supabase types yet (A1 table)
    await supabase.from('fin_projecao_snapshots').insert({
      company,
      cenario,
      horizon_weeks: horizon,
      dados: semanas as unknown as Record<string, unknown>,
      ncg: ncg.valor,
      liquidez_operacional_liquida: indicadores.liquidez_operacional_liquida,
      saldo_tesouraria: indicadores.saldo_tesouraria,
      dias_cobertura: indicadores.dias_cobertura,
      premissas: premissasSnapshot as unknown as Record<string, unknown>,
    });
  }

  return {
    semanas,
    ncg,
    indicadores,
    alertas,
    premissas_aplicadas: premissas,
    // Onda 2: ponte de horizonte + curvas calibradas (pra UI mostrar timing + confiança)
    apos_horizonte,
    ar_impaired,
    curvas_aging: dados.curvas_aging,
    metadados: {
      cenario,
      horizon,
      amostra_taxas: { suficiente: taxas.amostra_suficiente, qtd_titulos: taxas.qtd_titulos },
    },
  };
}
