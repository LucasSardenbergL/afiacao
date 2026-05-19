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
};

type DadosBase = {
  crs: CR[];
  cps: CP[];
  saldo_cc: number;
  estoque_valor: number;
  eventos_rec: EventoRecorrente[];
  eventos_ev: EventoEventual[];
  config: Config;
};

async function carregarDados(
  supabase: ReturnType<typeof createClient>,
  company: Company,
): Promise<DadosBase> {
  const [crsRes, cpsRes, ccRes, recRes, evRes, configRes] = await Promise.all([
    // @ts-expect-error - fin_contas_receber may not be in generated supabase types yet
    supabase.from('fin_contas_receber').select('id, saldo, valor_documento, valor_recebido, data_emissao, data_vencimento, data_recebimento, status_titulo, omie_codigo_cliente, nome_cliente, categoria_codigo')
      .eq('company', company)
      .neq('status_titulo', 'CANCELADO'),
    // @ts-expect-error - fin_contas_pagar may not be in generated supabase types yet
    supabase.from('fin_contas_pagar').select('id, saldo, valor_documento, valor_pago, data_emissao, data_vencimento, data_pagamento, status_titulo, categoria_codigo')
      .eq('company', company)
      .neq('status_titulo', 'CANCELADO'),
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
  ]);

  const saldo_cc = ((ccRes.data ?? []) as Array<{ saldo_atual?: number | null }>)
    .reduce((s: number, c) => s + Number(c.saldo_atual ?? 0), 0);

  const estoque_valor = 0;

  if (!configRes.data) {
    throw new Error(`Config ausente pra ${company}. Aplique seed em fin_config_cashflow.`);
  }

  return {
    crs: ((crsRes.data ?? []) as Array<Record<string, unknown>>).map((c) => ({
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
    })),
    cps: ((cpsRes.data ?? []) as Array<Record<string, unknown>>).map((c) => ({
      id: c.id as string,
      saldo: Number(c.saldo ?? 0),
      valor_documento: Number(c.valor_documento ?? 0),
      valor_pago: Number(c.valor_pago ?? 0),
      data_emissao: (c.data_emissao as string | null) ?? null,
      data_vencimento: (c.data_vencimento as string | null) ?? null,
      data_pagamento: (c.data_pagamento as string | null) ?? null,
      status_titulo: c.status_titulo as string,
      categoria_codigo: (c.categoria_codigo as string | null) ?? null,
    })),
    saldo_cc,
    estoque_valor,
    eventos_rec: (recRes.data ?? []) as unknown as EventoRecorrente[],
    eventos_ev: (evRes.data ?? []) as unknown as EventoEventual[],
    config: configRes.data as unknown as Config,
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
};

function aplicarCenario(
  taxas: TaxasHistoricas,
  cenario: Cenario,
  config: Config,
): PremissasAplicadas {
  if (cenario === 'realista') {
    return {
      inadimplencia_pct: taxas.inadimplencia_observada_pct,
      atraso_medio_dias: taxas.atraso_medio_dias,
      overrides_cenario: {},
    };
  }

  const overrides = config.overrides_cenario[cenario];
  const inadAjustado = taxas.inadimplencia_observada_pct * (1 + overrides.inadimplencia_pct_delta / 100);
  const atrasoAjustado = taxas.atraso_medio_dias * (1 - overrides.recebimento_no_prazo_pct_delta / 100);

  return {
    inadimplencia_pct: Math.max(0, inadAjustado),
    atraso_medio_dias: Math.max(0, atrasoAjustado),
    overrides_cenario: overrides as Record<string, unknown>,
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
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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

function gerarSemanas(
  dados: DadosBase,
  premissas: PremissasAplicadas,
  horizon: number,
): Semana[] {
  const hoje = new Date().toISOString().slice(0, 10);
  const semanaInicio = inicioSemanaUTC(hoje);

  const semanas: Semana[] = [];
  let saldoAtual = dados.saldo_cc;

  for (let i = 0; i < horizon; i++) {
    const inicio = addDays(semanaInicio, i * 7);
    const fim = addDays(inicio, 6);

    const entradas: LinhaCashflow[] = [];
    const saidas: LinhaCashflow[] = [];

    for (const cr of dados.crs) {
      if (!cr.data_vencimento || cr.saldo <= 0) continue;
      if (cr.data_vencimento < inicio || cr.data_vencimento > fim) continue;
      const valorAjustado = cr.saldo * (1 - premissas.inadimplencia_pct / 100);
      entradas.push({
        origem: 'cr_omie',
        desc: cr.nome_cliente || 'Cliente',
        data: cr.data_vencimento,
        valor: valorAjustado,
        id_origem: cr.id,
      });
    }

    for (const cp of dados.cps) {
      if (!cp.data_vencimento || cp.saldo <= 0) continue;
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

  return semanas;
}

type NCG = {
  aco: { cr_aberto: number; estoque: number; adiantamentos: number; total: number };
  pco: { cp_fornecedor: number; folha_30d: number; tributos_a_pagar: number; total: number };
  valor: number;
  projecao_12m: Array<{ mes: string; valor: number }>;
};

function calcularNCG(dados: DadosBase): NCG {
  const cr_aberto = dados.crs
    .filter(c => ['ABERTO', 'PARCIAL', 'VENCIDO'].includes(c.status_titulo) && c.saldo > 0)
    .reduce((s, c) => s + c.saldo, 0);
  const adiantamentos = dados.cps
    .filter(c =>
      c.categoria_codigo &&
      dados.config.adiantamento_categorias_codigos.includes(c.categoria_codigo) &&
      ['ABERTO', 'PARCIAL'].includes(c.status_titulo) &&
      c.saldo > 0
    )
    .reduce((s, c) => s + c.saldo, 0);
  const aco = {
    cr_aberto,
    estoque: dados.estoque_valor,
    adiantamentos,
    total: cr_aberto + dados.estoque_valor + adiantamentos,
  };

  const cp_fornecedor = dados.cps
    .filter(c =>
      ['ABERTO', 'PARCIAL', 'VENCIDO'].includes(c.status_titulo) &&
      c.saldo > 0 &&
      (!c.categoria_codigo || !dados.config.adiantamento_categorias_codigos.includes(c.categoria_codigo))
    )
    .reduce((s, c) => s + c.saldo, 0);

  const folha_30d = dados.eventos_rec
    .filter(e => e.is_folha && e.tipo === 'saida')
    .reduce((s, e) => s + e.valor, 0);

  const tributos_a_pagar = dados.cps
    .filter(c =>
      ['ABERTO', 'PARCIAL', 'VENCIDO'].includes(c.status_titulo) &&
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
  dias_cobertura: number;
  capital_giro_proprio: number;
  saldo_tesouraria: number;
  inadimplencia_pct: number;
  concentracao_top5_clientes: Array<{ cliente: string; pct: number; valor: number }>;
  prazo_medio_recebimento: number;
  prazo_medio_pagamento: number;
  cash_conversion_cycle: number;
};

function calcularIndicadores(
  dados: DadosBase,
  ncg: NCG,
  taxas: TaxasHistoricas,
): Indicadores {
  const cutoff90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const saidasUltimos90 = dados.cps
    .filter(c => c.data_pagamento && c.data_pagamento >= cutoff90)
    .reduce((s, c) => s + c.valor_pago, 0);
  const saidaDiariaMedia = saidasUltimos90 / 90;
  const dias_cobertura = saidaDiariaMedia > 0 ? dados.saldo_cc / saidaDiariaMedia : 999;

  const capital_giro_proprio = dados.saldo_cc + ncg.aco.cr_aberto + ncg.aco.estoque - ncg.pco.total;
  const saldo_tesouraria = dados.saldo_cc - ncg.pco.folha_30d;

  const crsLiquidados = dados.crs.filter(c => c.data_recebimento && c.data_emissao);
  const pmr = crsLiquidados.length > 0
    ? crsLiquidados.reduce((s, c) => {
        const dias = (new Date(c.data_recebimento!).getTime() - new Date(c.data_emissao!).getTime()) / (24 * 60 * 60 * 1000);
        return s + dias;
      }, 0) / crsLiquidados.length
    : 0;

  const cpsLiquidados = dados.cps.filter(c => c.data_pagamento && c.data_emissao);
  const pmp = cpsLiquidados.length > 0
    ? cpsLiquidados.reduce((s, c) => {
        const dias = (new Date(c.data_pagamento!).getTime() - new Date(c.data_emissao!).getTime()) / (24 * 60 * 60 * 1000);
        return s + dias;
      }, 0) / cpsLiquidados.length
    : 0;

  const ccc = pmr - pmp;

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
    capital_giro_proprio,
    saldo_tesouraria,
    inadimplencia_pct: taxas.inadimplencia_observada_pct,
    concentracao_top5_clientes,
    prazo_medio_recebimento: pmr,
    prazo_medio_pagamento: pmp,
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

  if (ncg.valor > indicadores.capital_giro_proprio) {
    const gap = ncg.valor - indicadores.capital_giro_proprio;
    alertas.push({
      tipo: 'ncg_deficit',
      severidade: 'aviso',
      mensagem: `NCG ${formatBRLSimple(ncg.valor)} excede Capital Giro Próprio ${formatBRLSimple(indicadores.capital_giro_proprio)} em ${formatBRLSimple(gap)}. Risco de liquidez.`,
      valor: gap,
      threshold: 0,
      contexto: { ncg: ncg.valor, cgp: indicadores.capital_giro_proprio },
    });
  }

  if (indicadores.dias_cobertura < t.dias_cobertura_min) {
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
  const premissas = aplicarCenario(taxas, cenario, dados.config);
  const semanas = gerarSemanas(dados, premissas, horizon);
  const ncg = calcularNCG(dados);
  const indicadores = calcularIndicadores(dados, ncg, taxas);
  const alertas = avaliarAlertas(semanas, ncg, indicadores, dados.config);

  for (const a of alertas) {
    // @ts-expect-error - fin_alertas not in supabase types yet
    await supabase.from('fin_alertas').insert({
      company,
      tipo: a.tipo,
      severidade: a.severidade,
      mensagem: a.mensagem,
      valor: a.valor,
      threshold: a.threshold,
      contexto: a.contexto,
    }).select().maybeSingle();
  }

  if (save) {
    // @ts-expect-error - fin_projecao_snapshots not in generated supabase types yet (A1 table)
    await supabase.from('fin_projecao_snapshots').insert({
      company,
      cenario,
      horizon_weeks: horizon,
      dados: semanas as unknown as Record<string, unknown>,
      ncg: ncg.valor,
      capital_giro_proprio: indicadores.capital_giro_proprio,
      saldo_tesouraria: indicadores.saldo_tesouraria,
      dias_cobertura: indicadores.dias_cobertura,
      premissas: premissas as unknown as Record<string, unknown>,
    });
  }

  return {
    semanas,
    ncg,
    indicadores,
    alertas,
    premissas_aplicadas: premissas,
    metadados: {
      cenario,
      horizon,
      amostra_taxas: { suficiente: taxas.amostra_suficiente, qtd_titulos: taxas.qtd_titulos },
    },
  };
}
