// Leituras de apoio do plano de execução (pacote 2): taxa de custo de capital (custo de esperar) e a equipe
// que pode ser responsável. Ambas DEGRADAM: falha de leitura → taxa null (a tela não mostra número) e
// equipe vazia (o Sheet mostra o id cru do responsável já gravado). Nunca fabricam 0 nem bloqueiam o Raio-X.
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { logger } from '@/lib/logger';
import { fetchAllPages } from '@/lib/postgrest';
import type { Empresa } from '@/lib/reposicao/raio-x/tipos';

/** Taxa ANUAL (fração, ex.: 0,1775) de `fin_regua_custo_capital` — Selic + spread configurados. Sem config → null. */
export function useTaxaCustoCapital(empresa: Empresa | null): number | null {
  const q = useQuery({
    queryKey: ['raio-x', empresa, 'taxa-capital'],
    enabled: empresa !== null,
    retry: false,
    staleTime: 60 * 60 * 1000,
    queryFn: async (): Promise<number | null> => {
      try {
        const { data, error } = await supabase.rpc('fin_regua_custo_capital', {
          p_empresa: empresa === 'oben' ? 'OBEN' : 'COLACOR',
        });
        if (error) throw error;
        return typeof data === 'number' && Number.isFinite(data) && data > 0 ? data : null;
      } catch (e) {
        logger.warn('raio-x: taxa de custo de capital indisponível', { error: String((e as { code?: unknown })?.code ?? e) });
        return null;
      }
    },
  });
  return q.data ?? null;
}

export interface MembroEquipe {
  user_id: string;
  nome: string;
}

/** Quem pode ser responsável: employee/master (a RPC valida o mesmo). Paginado (user_roles/profiles são tabelas grandes). */
export function useEquipeRaioX(): MembroEquipe[] {
  const q = useQuery({
    queryKey: ['raio-x', 'equipe'],
    staleTime: 10 * 60 * 1000,
    queryFn: async (): Promise<MembroEquipe[]> => {
      try {
        const papeis = await fetchAllPages(
          (de, ate) =>
            supabase.from('user_roles').select('user_id').in('role', ['employee', 'master']).order('user_id', { ascending: true }).range(de, ate),
          'user_roles',
        );
        const ids = [...new Set(papeis.map((p) => p.user_id))];
        if (ids.length === 0) return [];
        // Sem nomes (falha de leitura) a equipe aparece pelo id — nunca some da lista.
        const perfis = await fetchAllPages(
          (de, ate) =>
            supabase.from('profiles').select('user_id, name, email').in('user_id', ids).order('user_id', { ascending: true }).range(de, ate),
          'profiles',
        ).catch((e: unknown) => {
          logger.warn('raio-x: nomes da equipe indisponíveis', { error: String(e) });
          return [];
        });
        const nomes = new Map(perfis.map((p) => [p.user_id, p.name || p.email || p.user_id]));
        return ids
          .map((id) => ({ user_id: id, nome: nomes.get(id) ?? id }))
          .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
      } catch (e) {
        logger.warn('raio-x: equipe indisponível', { error: String((e as { code?: unknown })?.code ?? e) });
        return [];
      }
    },
  });
  return q.data ?? [];
}
