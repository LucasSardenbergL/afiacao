import { useState, useCallback, useEffect, useMemo } from 'react';
import type { Company } from '@/contexts/CompanyContext';
import {
  triggerFinanceiroSync,
  getResumoFinanceiro,
  getContasPagar,
  getContasReceber,
  getAgingReceber,
  getAgingPagar,
  getDRE,
  getFluxoCaixa,
  getTopInadimplentes,
  getLastSyncTime,
  type FinResumo,
  type FinContaPagar,
  type FinContaReceber,
  type FinDRE,
  type AgingData,
  type FluxoCaixaDiario,
} from '@/services/financeiroService';

export type FinanceiroView = 'all' | Company;

export function useFinanceiro(defaultCompany: FinanceiroView = 'all') {
  const [view, setView] = useState<FinanceiroView>(defaultCompany);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Data states
  const [resumo, setResumo] = useState<Record<string, FinResumo>>({});
  const [contasPagar, setContasPagar] = useState<FinContaPagar[]>([]);
  const [contasReceber, setContasReceber] = useState<FinContaReceber[]>([]);
  const [agingReceber, setAgingReceber] = useState<AgingData | null>(null);
  const [agingPagar, setAgingPagar] = useState<AgingData | null>(null);
  const [dre, setDre] = useState<FinDRE[]>([]);
  const [fluxoCaixa, setFluxoCaixa] = useState<FluxoCaixaDiario[]>([]);
  const [inadimplentes, setInadimplentes] = useState<
    { nome: string; cnpj: string; total_vencido: number; qtd_titulos: number }[]
  >([]);
  const [lastSync, setLastSync] = useState<string | null>(null);

  // Computed resumo consolidado
  const resumoConsolidado: FinResumo | null =
    Object.keys(resumo).length > 0
      ? {
          contas_correntes: Object.values(resumo).flatMap(r => r.contas_correntes),
          saldo_total_cc: Object.values(resumo).reduce((s, r) => s + r.saldo_total_cc, 0),
          total_a_receber: Object.values(resumo).reduce((s, r) => s + r.total_a_receber, 0),
          total_a_pagar: Object.values(resumo).reduce((s, r) => s + r.total_a_pagar, 0),
          total_vencido_receber: Object.values(resumo).reduce((s, r) => s + r.total_vencido_receber, 0),
          total_vencido_pagar: Object.values(resumo).reduce((s, r) => s + r.total_vencido_pagar, 0),
          posicao_liquida: Object.values(resumo).reduce((s, r) => s + r.posicao_liquida, 0),
        }
      : null;

  const activeResumo: FinResumo | null =
    view === 'all' ? resumoConsolidado : resumo[view] || null;

  // Load local data from Supabase
  const loadResumo = useCallback(async () => {
    try {
      setLoading(true);
      const companies: Company[] = view === 'all' 
        ? ['oben', 'colacor', 'colacor_sc'] 
        : [view as Company];
      const [data, syncTime] = await Promise.all([
        getResumoFinanceiro(companies),
        getLastSyncTime(),
      ]);
      setResumo(prev => ({ ...prev, ...data }));
      setLastSync(syncTime);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [view]);

  const loadContasPagar = useCallback(async (filtros?: {
    status?: string;
    dataInicio?: string;
    dataFim?: string;
    limit?: number;
  }) => {
    try {
      setLoading(true);
      const data = await getContasPagar(view === 'all' ? 'all' : view as Company, filtros);
      setContasPagar(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [view]);

  const loadContasReceber = useCallback(async (filtros?: {
    status?: string;
    dataInicio?: string;
    dataFim?: string;
    limit?: number;
  }) => {
    try {
      setLoading(true);
      const data = await getContasReceber(view === 'all' ? 'all' : view as Company, filtros);
      setContasReceber(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [view]);

  const loadAging = useCallback(async () => {
    try {
      const company = view === 'all' ? 'all' : view as Company;
      const [ar, ap] = await Promise.all([
        getAgingReceber(company),
        getAgingPagar(company),
      ]);
      setAgingReceber(ar);
      setAgingPagar(ap);
    } catch (e: any) {
      setError(e.message);
    }
  }, [view]);

  const loadDRE = useCallback(async (ano: number, meses?: number[]) => {
    try {
      setLoading(true);
      if (view === 'all') {
        // Para consolidado, carregar cada empresa e somar
        const allDres: FinDRE[] = [];
        for (const co of ['oben', 'colacor', 'colacor_sc'] as Company[]) {
          const data = await getDRE(co, ano, meses);
          allDres.push(...data);
        }
        setDre(allDres);
      } else {
        const data = await getDRE(view as Company, ano, meses);
        setDre(data);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [view]);

  const loadFluxoCaixa = useCallback(async (dataInicio: string, dataFim: string) => {
    try {
      setLoading(true);
      const company = view === 'all' ? 'all' : view as Company;
      const data = await getFluxoCaixa(company, dataInicio, dataFim);
      setFluxoCaixa(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [view]);

  const loadInadimplentes = useCallback(async () => {
    try {
      const company = view === 'all' ? 'all' : view as Company;
      const data = await getTopInadimplentes(company, 15);
      setInadimplentes(data);
    } catch (e: any) {
      setError(e.message);
    }
  }, [view]);

  // Sync from Omie
  const syncAll = useCallback(async () => {
    try {
      setSyncing(true);
      setError(null);
      const companies: Company[] = view === 'all' 
        ? ['oben', 'colacor', 'colacor_sc']
        : [view as Company];
      await triggerFinanceiroSync('sync_all', companies);
      // Reload local data after sync
      await loadResumo();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSyncing(false);
    }
  }, [view, loadResumo]);

  const calcularDRE = useCallback(async (ano: number, mes: number) => {
    try {
      setSyncing(true);
      const companies: Company[] = view === 'all' 
        ? ['oben', 'colacor', 'colacor_sc'] 
        : [view as Company];
      await triggerFinanceiroSync('calcular_dre', companies, { ano, meses: [mes] });
      await loadDRE(ano, [mes]);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSyncing(false);
    }
  }, [view, loadDRE]);

  const calcularDREAnual = useCallback(async (ano: number) => {
    try {
      setSyncing(true);
      const companies: Company[] = view === 'all' 
        ? ['oben', 'colacor', 'colacor_sc'] 
        : [view as Company];
      await triggerFinanceiroSync('calcular_dre_year', companies, { ano });
      await loadDRE(ano);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSyncing(false);
    }
  }, [view, loadDRE]);

  const syncSpecific = useCallback(async (action: string, options?: Record<string, unknown>) => {
    try {
      setSyncing(true);
      setError(null);
      const companies: Company[] = view === 'all'
        ? ['oben', 'colacor', 'colacor_sc']
        : [view as Company];

      // Heavy sync actions: call one company at a time to avoid 150s timeout
      const heavyActions = ['sync_contas_pagar', 'sync_contas_receber', 'sync_movimentacoes', 'sync_all'];
      if (heavyActions.includes(action)) {
        const allResults: Record<string, any> = {};
        for (const co of companies) {
          const result = await triggerFinanceiroSync(action, [co], options);
          if (result?.results) {
            Object.assign(allResults, result.results);
          } else {
            allResults[co] = result?.[co] || result;
          }
        }
        return { results: allResults };
      }

      const result = await triggerFinanceiroSync(action, companies, options);
      return result;
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSyncing(false);
    }
  }, [view]);

  // Computed: DRE consolidado por mês (soma empresas quando view === 'all')
  const dreConsolidado = useMemo(() => {
    if (view !== 'all' || dre.length === 0) return dre;
    const byMonth = new Map<number, any>();
    const numFields = [
      'receita_bruta', 'deducoes', 'receita_liquida', 'cmv', 'lucro_bruto',
      'despesas_operacionais', 'despesas_administrativas', 'despesas_comerciais',
      'despesas_financeiras', 'receitas_financeiras', 'resultado_operacional',
      'outras_receitas', 'outras_despesas', 'resultado_antes_impostos',
      'impostos', 'resultado_liquido'
    ];
    for (const row of dre) {
      if (!byMonth.has(row.mes)) {
        byMonth.set(row.mes, { ...row, company: 'consolidado' });
      } else {
        const c = byMonth.get(row.mes);
        for (const f of numFields) {
          c[f] = (c[f] || 0) + ((row as any)[f] || 0);
        }
      }
    }
    return Array.from(byMonth.values()).sort((a, b) => a.mes - b.mes);
  }, [dre, view]);

  // Computed: DRE por empresa (para comparativo)
  const drePorEmpresa = useMemo(() => {
    const result: Record<string, FinDRE[]> = {};
    for (const row of dre) {
      if (!result[row.company]) result[row.company] = [];
      result[row.company].push(row);
    }
    return result;
  }, [dre]);

  return {
    // State
    view,
    setView,
    loading,
    syncing,
    error,
    lastSync,
    
    // Data
    resumo,
    activeResumo,
    resumoConsolidado,
    contasPagar,
    contasReceber,
    agingReceber,
    agingPagar,
    dre,
    dreConsolidado,
    drePorEmpresa,
    fluxoCaixa,
    inadimplentes,

    // Actions
    loadResumo,
    loadContasPagar,
    loadContasReceber,
    loadAging,
    loadDRE,
    loadFluxoCaixa,
    loadInadimplentes,
    syncAll,
    syncSpecific,
    calcularDRE,
    calcularDREAnual,
  };
}
