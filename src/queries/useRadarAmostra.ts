import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { podeProspectarRadar } from '@/lib/nav/acesso-radar';
import { lerAmostraVigente, TETO_LEITURA_AMOSTRA, type ItemAmostra } from '@/lib/radar/amostra';
import type { RadarEmpresa } from '@/queries/useRadarLista';

export interface AmostraVigente {
  sorteio: string;
  itens: ItemAmostra<RadarEmpresa>[];
}

const LOTE_IN = 100; // `.in()` vai na URL: lotes de 100 CNPJs mantêm a query curta num sorteio maior

/**
 * A amostra de controle do sorteio vigente (RPC `radar_amostra_vigente`, migration 20261030233200) com a linha
 * ATUAL de cada sorteado em `radar_empresas` — o estado de agora decide se ainda ocupa lugar na fila.
 * `null` = nenhum sorteio registrado. Fora do gate do Radar a query nem roda. Mesma raiz `['radar']` que o
 * registro de contato invalida: o lead contatado sai da fila sem recarregar a página.
 */
export function useRadarAmostra() {
  const { role, commercialRole } = useAuth();
  return useQuery({
    queryKey: ['radar', 'amostra'],
    enabled: podeProspectarRadar({ role, commercialRole }),
    staleTime: 30_000,
    queryFn: async (): Promise<AmostraVigente | null> => {
      // Janela explícita com ordem estável; chegar ao teto é ERRO no leitor (nunca "a amostra acabou").
      const { data, error } = await supabase
        .rpc('radar_amostra_vigente')
        .order('posicao', { ascending: true })
        .range(0, TETO_LEITURA_AMOSTRA - 1);
      if (error) throw error;
      const sorteados = lerAmostraVigente(data, 'radar_amostra_vigente');
      if (sorteados.length === 0) return null;
      const porCnpj = new Map<string, RadarEmpresa>();
      for (let i = 0; i < sorteados.length; i += LOTE_IN) {
        const cnpjs = sorteados.slice(i, i + LOTE_IN).map((s) => s.cnpj);
        // CNPJ é a chave de radar_empresas: no máximo 1 linha por CNPJ pedido, então o teto do lote basta.
        const { data: linhas, error: e2 } = await supabase.from('radar_empresas').select('*').in('cnpj', cnpjs).limit(LOTE_IN);
        if (e2) throw e2;
        for (const l of linhas ?? []) porCnpj.set(l.cnpj, l);
      }
      return {
        sorteio: sorteados[0].sorteio,
        itens: sorteados.map((s) => ({ posicao: s.posicao, cnpj: s.cnpj, empresa: porCnpj.get(s.cnpj) ?? null })),
      };
    },
  });
}
