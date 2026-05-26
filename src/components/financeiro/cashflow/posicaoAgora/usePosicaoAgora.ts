// Hook de dados/estado do PosicaoAgora.
// Extraído verbatim de src/components/financeiro/cashflow/PosicaoAgora.tsx (god-component split):
// carrega capital de giro por empresa/consolidado e expõe a posição ativa.
import { useState, useEffect } from 'react';
import { type Company } from '@/contexts/CompanyContext';
import { getCapitalDeGiro, type CapitalDeGiro } from '@/services/financeiroService';
import { buildConsolidated } from './consolidate';

export function usePosicaoAgora() {
  const [data, setData] = useState<CapitalDeGiro[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'all' | Company>('all');

  useEffect(() => {
    loadData();
  }, [view]);

  const loadData = async () => {
    setLoading(true);
    try {
      const result = await getCapitalDeGiro(view);
      setData(result);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const consolidated = buildConsolidated(data);
  const active = view === 'all' ? consolidated : data[0] || null;

  return { data, loading, view, setView, active };
}
