import { useQuery } from '@tanstack/react-query';
import type { Fila } from '@/lib/financeiro/ciclo-fila';
import { supabase } from '@/integrations/supabase/client';

export type Cenario = 'realista' | 'otimista' | 'pessimista';

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

type NCGData = {
  // estoque null = sem fonte (engine v1.5+): o total soma o resto e `parcial` = true.
  aco: { cr_aberto: number; estoque: number | null; adiantamentos: number; total: number };
  pco: { cp_fornecedor: number; folha_30d: number; tributos_a_pagar: number; total: number };
  valor: number;
  // Opcional: engines anteriores à v1.5 não mandam o campo.
  parcial?: boolean;
  projecao_12m: Array<{ mes: string; valor: number }>;
};

export type CashflowResult = {
  semanas: Semana[];
  ncg: NCGData;
  indicadores: {
    // null quando não há base de saída projetada (Fase 3 B2) → consumidor trata "—".
    dias_cobertura: number | null;
    liquidez_operacional_liquida: number;
    saldo_tesouraria: number;
    inadimplencia_pct: number;
    concentracao_top5_clientes: Array<{ cliente: string; pct: number; valor: number }>;
    // null quando a cobertura de baixa derivada é baixa (PMR/PMP/CCC do engine, Fase 3 B).
    // number | null | undefined: snapshots antigos persistidos têm number; os novos, null.
    prazo_medio_recebimento: number | null;
    prazo_medio_pagamento: number | null;
    // null (engine v1.5+) sem estoque, sem os 12 meses de CMV ou com custo incompleto.
    prazo_medio_estoque: number | null;
    cash_conversion_cycle: number | null;
    // Fonte do estoque do PME/NCG (engine v1.5+; ausente em respostas antigas).
    estoque_valor?: number | null;
    estoque_fonte?: 'manual' | 'omie' | null;
    estoque_data_ref?: string | null;
  };
  alertas: Array<{ tipo: string; severidade: string; mensagem: string; valor: number | null; threshold: number | null; contexto: Record<string, unknown> }>;
  premissas_aplicadas: Record<string, unknown>;
  // Degradação honesta das leituras da engine: motivos das fontes que falharam mas não
  // derrubam o cálculo (hoje `v_capital_giro_prazos` → PMR/PMP/CCC ficam "—"). Vazio ou
  // ausente = nenhuma degradação. Fonte que não pode virar zero faz a engine responder
  // 500 — cai no `error` do react-query, não aqui. Opcional: snapshots/edges antigas
  // respondem sem o campo.
  confianca_dados?: { motivos: string[] };
  // Onda 2: ponte de horizonte + curvas de aging calibradas (timing + confiança)
  apos_horizonte?: number;
  ar_impaired?: number;
  curvas_aging?: Record<string, {
    taxa_recebimento: number;
    lag_dias: number;
    lag_mediana: number;
    exposicao: number;
    pago: number;
    aberto: number;
    confianca: 'alta' | 'baixa';
  }>;
};

/** `opcoes.fila`/`retryDelay`: a aba Ciclo põe a edge na faixa própria dela (filaCicloEdge) (carga escalonada — ver ciclo-fila.ts). */
export function useCashflowProjection(
  company: string, cenario: Cenario = 'realista', horizonWeeks = 13,
  opcoes: { fila?: Fila; retryDelay?: (tentativa: number) => number } = {},
) {
  const fila: Fila = opcoes.fila ?? ((fn) => fn());
  return useQuery({
    queryKey: ['fin_cashflow_projection', company, cenario, horizonWeeks],
    enabled: Boolean(company),
    ...(opcoes.retryDelay ? { retryDelay: opcoes.retryDelay } : {}),
    queryFn: (): Promise<CashflowResult> => fila(async () => {
      const { data, error } = await supabase.functions.invoke('fin-cashflow-engine', {
        body: { company, cenario, horizon_weeks: horizonWeeks },
      });
      if (error) throw error;
      return data as CashflowResult;
    }),
  });
}
