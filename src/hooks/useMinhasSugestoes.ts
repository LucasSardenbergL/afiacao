import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { hojeSP } from '@/lib/time/sp-day';
import { lerMinhasSugestoes, type MinhasSugestoesResp } from '@/lib/venda-cliente/sugestoes';

/**
 * Estado da lista de recompra do dia — cada caso tem UMA tela própria no Meu Dia:
 * - `onda_desligada`: a Onda 1 ainda não ligou no servidor (`venda_config.onda_recompra`)
 *   → "sua lista começa em breve", nunca uma lista vazia que afirma "nada a fazer".
 * - `lente`: na lente "Ver como" a lista NÃO é lida. A RPC é por `auth.uid()` (devolveria a
 *   lista do master, não a da vendedora) e o write-guard da lente bloqueia RPC fora de get_/list_.
 * - `erro`: falha de leitura (config ou RPC) — nunca vira "dia limpo".
 */
export type EstadoRecompra =
  | { tipo: 'carregando' }
  | { tipo: 'erro'; erro: unknown }
  | { tipo: 'onda_desligada' }
  | { tipo: 'lente' }
  | { tipo: 'pronta'; resp: MinhasSugestoesResp };

/** Liga/desliga da Onda 1, no servidor (vale para o aparelho das farmers, não é flag local). */
function useOndaRecompra() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['venda-config', 'onda_recompra'],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase
        .from('venda_config')
        .select('valor')
        .eq('chave', 'onda_recompra')
        .maybeSingle();
      if (error) throw error;
      // Ausente ≠ desligada: a chave é semeada pela migration; sumir é defeito, não "false".
      if (!data) throw new Error('venda_config.onda_recompra ausente');
      return data.valor === true;
    },
  });
}

export function useMinhasSugestoes(): { estado: EstadoRecompra; refetch: () => void } {
  const { user } = useAuth();
  const { isImpersonating } = useImpersonation();
  const onda = useOndaRecompra();
  const dia = hojeSP();

  const lista = useQuery({
    queryKey: ['venda-minhas-sugestoes', user?.id, dia],
    enabled: !!user && onda.data === true && !isImpersonating,
    staleTime: 60_000,
    queryFn: async (): Promise<MinhasSugestoesResp> => {
      // Sem p_dia: o dia é o do servidor (America/Sao_Paulo), o mesmo do gerador.
      const { data, error } = await supabase.rpc('venda_minhas_sugestoes');
      if (error) throw error;
      return lerMinhasSugestoes(data);
    },
  });

  const refetch = () => {
    if (onda.isError) void onda.refetch();
    if (lista.isError) void lista.refetch();
  };

  // Memoizado: o estado é dependência de memos/efeitos da fila (um objeto novo por render
  // recalcularia o ranking e repetiria o log de erro a cada render).
  const estado = useMemo((): EstadoRecompra => {
    if (onda.isError) return { tipo: 'erro', erro: onda.error };
    if (onda.data === undefined) return { tipo: 'carregando' };
    if (!onda.data) return { tipo: 'onda_desligada' };
    if (isImpersonating) return { tipo: 'lente' };
    if (lista.isError) return { tipo: 'erro', erro: lista.error };
    if (!lista.data) return { tipo: 'carregando' };
    return { tipo: 'pronta', resp: lista.data };
  }, [onda.isError, onda.error, onda.data, isImpersonating, lista.isError, lista.error, lista.data]);

  return { estado, refetch };
}

/** As sugestões de UM comprador na lista de hoje (a ficha lê do mesmo cache da fila). */
export function useSugestoesDoComprador(compradorId: string | null) {
  const { estado } = useMinhasSugestoes();
  if (!compradorId || estado.tipo !== 'pronta') return null;
  return estado.resp.compradores.find((c) => c.compradorId === compradorId) ?? null;
}
