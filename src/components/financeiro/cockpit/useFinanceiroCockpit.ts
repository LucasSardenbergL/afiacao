// Hook de dados/estado do Cockpit financeiro.
// Extraído verbatim de src/pages/FinanceiroCockpit.tsx (god-component split):
// state, loadAll (resumo/aging/DRE/inadimplentes/projeção 13s/confiabilidade) e
// todos os derivados consolidados.
import { useState, useEffect, useRef } from 'react';
import { type Company } from '@/contexts/CompanyContext';
import { supabase } from '@/integrations/supabase/client';
import { getResumoFinanceiro, getAgingReceber, getDRE, getTopInadimplentes, type FinResumo, type AgingData, type FinDRE } from '@/services/financeiroService';
import { getProjecaoSnapshotsCockpit } from '@/services/financeiroV2Service';
import { consolidarCockpit, type CockpitConsolidado } from '@/lib/financeiro/cockpit-consolida-helpers';
import { useFinanceiroRegime } from '@/hooks/useFinanceiroRegime';
import { logger } from '@/lib/logger';
import type { DrillDownType } from '@/components/financeiro/CockpitDrillDown';
import type { FinConfiabilidadeRow, InadimplenteRow } from './types';

const EMPRESAS_COCKPIT: Company[] = ['oben', 'colacor', 'colacor_sc'];
// Default = indisponível/parcial (Codex P1): em falha de carga, NCG não pode aparecer como R$0 "saudável".
const COCKPIT_VAZIO: CockpitConsolidado = {
  projecao13: [], ncg_total: 0, ncg_por_empresa: [], ncg_parcial: true,
  saldo_tesouraria_total: 0, saldo_tesouraria_parcial: true,
  empresas_presentes: [], empresas_ausentes: [...EMPRESAS_COCKPIT], empresas_stale: [],
  parcial: true, data_referencia: null, snapshot_at_mais_antigo: null,
  caixa_inicial_projecao: null, caixa_inicial_por_empresa: [], caixa_inicial_parcial: true,
};

export function useFinanceiroCockpit() {
  const [loading, setLoading] = useState(true);
  const [resumo, setResumo] = useState<Record<string, FinResumo>>({});
  const [aging, setAging] = useState<AgingData | null>(null);
  const [dre, setDre] = useState<FinDRE[]>([]);
  const [inadimplentes, setInadimplentes] = useState<InadimplenteRow[]>([]);
  const [cockpit, setCockpit] = useState<CockpitConsolidado>(COCKPIT_VAZIO);
  const [confiabilidade, setConfiabilidade] = useState<FinConfiabilidadeRow[]>([]);
  const [drillDown, setDrillDown] = useState<DrillDownType>(null);

  const { regime } = useFinanceiroRegime();
  const ano = new Date().getFullYear();
  const mes = new Date().getMonth() + 1;
  // Guard de race (Codex P2): toggle rápido de regime pode resolver fora de ordem;
  // só o último loadAll aplica os setters.
  const loadIdRef = useRef(0);

  useEffect(() => { loadAll(); }, [regime]);

  const loadAll = async () => {
    const loadId = ++loadIdRef.current;
    setLoading(true);
    try {
      const [res, ag, dr, inad, snaps] = await Promise.all([
        // getResumoFinanceiro agora LANÇA em erro de query (era swallow→R$0); o catch
        // por fonte impede que uma falha do resumo derrube aging/DRE/inadimplentes junto.
        getResumoFinanceiro(['oben', 'colacor', 'colacor_sc']).catch((e): Record<string, FinResumo> => {
          logger.warn('Resumo financeiro indisponível', { error: e instanceof Error ? e.message : String(e) });
          return {};
        }),
        getAgingReceber('all'),
        Promise.all(['oben', 'colacor', 'colacor_sc'].map(co => getDRE(co as Company, ano, undefined, regime))).then(r => r.flat()),
        getTopInadimplentes('all', 5),
        // Projeção 13s + NCG consolidados via snapshot real da engine A1 (não a RPC ingênua)
        getProjecaoSnapshotsCockpit(EMPRESAS_COCKPIT).catch((e) => {
          logger.warn('Snapshots de projeção indisponíveis', { error: e instanceof Error ? e.message : String(e) });
          return [];
        }),
      ]);
      if (loadId !== loadIdRef.current) return; // resposta obsoleta — descarta
      setResumo(res);
      setAging(ag);
      setDre(dr);
      setInadimplentes(inad);
      setCockpit(consolidarCockpit({ esperadas: EMPRESAS_COCKPIT, snapshots: snaps }));

      // Confiabilidade for current month per company
      const confResults: FinConfiabilidadeRow[] = [];
      for (const co of ['oben', 'colacor', 'colacor_sc']) {
        try {
          const { data: conf } = await supabase
            .from('fin_confiabilidade')
            .select('*')
            .eq('company', co)
            .eq('ano', ano)
            .eq('mes', mes)
            .maybeSingle();
          if (conf) confResults.push(conf);
        } catch (e) {
          logger.warn('Tabela fin_confiabilidade indisponível', {
            company: co,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      setConfiabilidade(confResults);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  // Computed
  const totalCC = Object.values(resumo).reduce((s, r) => s + r.saldo_total_cc, 0);
  const totalCR = Object.values(resumo).reduce((s, r) => s + r.total_a_receber, 0);
  const totalCP = Object.values(resumo).reduce((s, r) => s + r.total_a_pagar, 0);
  const totalVencidoCR = Object.values(resumo).reduce((s, r) => s + r.total_vencido_receber, 0);
  // NCG real (ACO−PCO) consolidado da engine A1, não o CR−CP ingênuo
  const ncg = cockpit.ncg_total;
  const pctInadimplencia = totalCR > 0 ? (totalVencidoCR / totalCR) * 100 : 0;

  // DRE do mês mais recente
  const dreUltimo = new Map<string, FinDRE>();
  for (const d of dre) {
    const key = d.company;
    if (!dreUltimo.has(key) || d.mes > (dreUltimo.get(key)?.mes || 0)) {
      dreUltimo.set(key, d);
    }
  }
  const dreConsolidado = Array.from(dreUltimo.values());
  const totalReceita = dreConsolidado.reduce((s, d) => s + d.receita_liquida, 0);
  const totalLucroBruto = dreConsolidado.reduce((s, d) => s + d.lucro_bruto, 0);
  const totalResultadoOp = dreConsolidado.reduce((s, d) => s + d.resultado_operacional, 0);
  const margemBruta = totalReceita > 0 ? (totalLucroBruto / totalReceita) * 100 : 0;
  const margemOp = totalReceita > 0 ? (totalResultadoOp / totalReceita) * 100 : 0;

  // Risco de liquidez
  const riscoLiquidez = totalCP > 0 && totalCC > 0
    ? totalCC / totalCP
    : 0;
  const riscoLabel = riscoLiquidez >= 1 ? 'Baixo' : riscoLiquidez >= 0.5 ? 'Médio' : 'Alto';
  const riscoColor = riscoLiquidez >= 1 ? 'text-status-success' : riscoLiquidez >= 0.5 ? 'text-status-warning' : 'text-status-error';

  // Concentração (do aging)
  const totalAgingCR = aging
    ? aging.a_vencer_valor + aging.vencido_1_30_valor + aging.vencido_31_60_valor + aging.vencido_61_90_valor + aging.vencido_90_plus_valor
    : 0;
  const pctCritico = totalAgingCR > 0
    ? ((aging?.vencido_61_90_valor || 0) + (aging?.vencido_90_plus_valor || 0)) / totalAgingCR * 100
    : 0;
  const agingCriticoValor = (aging?.vencido_61_90_valor || 0) + (aging?.vencido_90_plus_valor || 0);

  return {
    loading,
    regime,
    confiabilidade,
    dreConsolidado,
    cockpit,
    inadimplentes,
    drillDown,
    setDrillDown,
    totalCC,
    totalCR,
    totalCP,
    totalVencidoCR,
    ncg,
    pctInadimplencia,
    margemBruta,
    margemOp,
    riscoLiquidez,
    riscoLabel,
    riscoColor,
    pctCritico,
    agingCriticoValor,
  };
}
