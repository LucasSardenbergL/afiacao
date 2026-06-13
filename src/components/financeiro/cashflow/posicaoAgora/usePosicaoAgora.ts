// Hook de dados/estado do PosicaoAgora.
// Extraído verbatim de src/components/financeiro/cashflow/PosicaoAgora.tsx (god-component split):
// carrega capital de giro por empresa/consolidado e expõe a posição ativa.
import { useState, useEffect, useRef } from 'react';
import { type Company } from '@/contexts/CompanyContext';
import { getCapitalDeGiro, type CapitalDeGiro } from '@/services/financeiroService';
import { buildConsolidated } from './consolidate';

export function usePosicaoAgora() {
  const [data, setData] = useState<CapitalDeGiro[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'all' | Company>('all');
  // Guard de corrida (achado codex pós-#722): o load de 'all' pagina ~15 janelas;
  // trocar a empresa no meio deixava a resposta VELHA sobrescrever a nova — e com
  // active = data[0] a tela rotulava números da Oben como Colacor. Só o load mais
  // recente aplica os setters (mesmo padrão do useFinanceiroCockpit).
  const loadIdRef = useRef(0);

  useEffect(() => {
    loadData();
  }, [view]);

  const loadData = async () => {
    const loadId = ++loadIdRef.current;
    setLoading(true);
    try {
      const result = await getCapitalDeGiro(view);
      if (loadId !== loadIdRef.current) return; // resposta obsoleta — descarta
      setData(result);
    } catch (e) {
      if (loadId !== loadIdRef.current) return;
      console.error(e);
      setData([]); // erro não preserva números da visão anterior (stale com rótulo novo)
    } finally {
      if (loadId === loadIdRef.current) setLoading(false);
    }
  };

  const consolidated = buildConsolidated(data);
  // find (não data[0]): mesmo que um stale escape, nunca exibe outra empresa.
  const active = view === 'all' ? consolidated : (data.find((d) => d.company === view) ?? null);

  return { data, loading, view, setView, active };
}
