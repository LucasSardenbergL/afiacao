import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type Cenario = 'realista' | 'otimista' | 'pessimista';

export type LinhaCashflow = {
  origem: 'cr_omie' | 'cp_omie' | 'evento_recorrente' | 'evento_eventual';
  desc: string;
  data: string;
  valor: number;
  id_origem: string;
};

export type Semana = {
  inicio: string;
  fim: string;
  saldo_inicial: number;
  entradas: LinhaCashflow[];
  saidas: LinhaCashflow[];
  total_entradas: number;
  total_saidas: number;
  saldo_final: number;
};

export type NCGData = {
  aco: { cr_aberto: number; estoque: number; adiantamentos: number; total: number };
  pco: { cp_fornecedor: number; folha_30d: number; tributos_a_pagar: number; total: number };
  valor: number;
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
    prazo_medio_estoque: number;
    cash_conversion_cycle: number | null;
  };
  alertas: Array<{ tipo: string; severidade: string; mensagem: string; valor: number | null; threshold: number | null; contexto: Record<string, unknown> }>;
  premissas_aplicadas: Record<string, unknown>;
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

export function useCashflowProjection(company: string, cenario: Cenario = 'realista', horizonWeeks = 13) {
  return useQuery({
    queryKey: ['fin_cashflow_projection', company, cenario, horizonWeeks],
    enabled: Boolean(company),
    queryFn: async (): Promise<CashflowResult> => {
      const { data, error } = await supabase.functions.invoke('fin-cashflow-engine', {
        body: { company, cenario, horizon_weeks: horizonWeeks },
      });
      if (error) throw error;
      return data as CashflowResult;
    },
  });
}
