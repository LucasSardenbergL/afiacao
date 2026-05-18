import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

// === Tipos de domínio ===
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
    // @ts-expect-error - fin_eventos_* tables not yet in supabase types
    supabase.from('fin_contas_receber').select('id, saldo, valor_documento, valor_recebido, data_emissao, data_vencimento, data_recebimento, status_titulo, omie_codigo_cliente, nome_cliente, categoria_codigo')
      .eq('company', company)
      .neq('status_titulo', 'CANCELADO'),
    // @ts-expect-error
    supabase.from('fin_contas_pagar').select('id, saldo, valor_documento, valor_pago, data_emissao, data_vencimento, data_pagamento, status_titulo, categoria_codigo')
      .eq('company', company)
      .neq('status_titulo', 'CANCELADO'),
    // @ts-expect-error
    supabase.from('fin_contas_correntes').select('saldo_atual')
      .eq('company', company).eq('ativo', true),
    // @ts-expect-error
    supabase.from('fin_eventos_recorrentes').select('id, descricao, valor, tipo, categoria_dre, is_folha, dia_do_mes, inicio, fim')
      .eq('company', company).eq('ativo', true),
    // @ts-expect-error
    supabase.from('fin_eventos_eventuais').select('id, descricao, valor, tipo, categoria_dre, data_prevista, status')
      .eq('company', company).in('status', ['previsto', 'confirmado']),
    // @ts-expect-error
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

// === Pipeline (será implementada nas próximas tasks) ===
async function calcular(
  _supabase: ReturnType<typeof createClient>,
  _company: Company,
  _cenario: Cenario,
  _horizon: number,
  _save: boolean,
) {
  return { ok: true, todo: 'pipeline' };
}
