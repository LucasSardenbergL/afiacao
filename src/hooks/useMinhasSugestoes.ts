import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { hojeSP } from '@/lib/time/sp-day';
import { lerMinhasSugestoes, ONDAS_DESLIGADAS, type MinhasSugestoesResp, type OndasVenda } from '@/lib/venda-cliente/sugestoes';

/**
 * Estado da lista de recompra do dia — cada caso tem UMA tela própria no Meu Dia:
 * - `onda_desligada`: a Onda 1 ainda não ligou no servidor (`venda_config.onda_recompra`)
 *   → "sua lista começa em breve", nunca uma lista vazia que afirma "nada a fazer".
 * - `erro`: falha de leitura (config ou RPC) — nunca vira "dia limpo".
 */
export type EstadoRecompra =
  | { tipo: 'carregando' }
  | { tipo: 'erro'; erro: unknown }
  | { tipo: 'onda_desligada' }
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
  // Lente "Ver como": a lista é a da pessoa VISTA (effectiveUserId), só LEITURA. A RPC da farmer é por
  // auth.uid() (devolveria a do master); `get_venda_sugestoes_for` é master-only no banco (42501) e o
  // prefixo get_ é o que o write-guard da lente deixa passar. A escrita (marcar mostrada, desfecho)
  // segue bloqueada na ficha — useAuth() continua o real.
  const { isImpersonating, effectiveUserId } = useImpersonation();
  const onda = useOndaRecompra();
  const dia = hojeSP();
  const dono = isImpersonating ? effectiveUserId : user?.id ?? null;

  const lista = useQuery({
    queryKey: ['venda-minhas-sugestoes', dono, isImpersonating, dia],
    enabled: !!user && !!dono && onda.data === true,
    staleTime: 60_000,
    queryFn: async (): Promise<MinhasSugestoesResp> => {
      // Sem p_dia: o dia é o do servidor (America/Sao_Paulo), o mesmo do gerador.
      const { data, error } = isImpersonating
        ? await supabase.rpc('get_venda_sugestoes_for', { p_farmer: dono as string })
        : await supabase.rpc('venda_minhas_sugestoes');
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
    if (lista.isError) return { tipo: 'erro', erro: lista.error };
    if (!lista.data) return { tipo: 'carregando' };
    return { tipo: 'pronta', resp: lista.data };
  }, [onda.isError, onda.error, onda.data, lista.isError, lista.error, lista.data]);

  return { estado, refetch };
}

/** As sugestões de UM comprador na lista de hoje (a ficha lê do mesmo cache da fila). */
export function useSugestoesDoComprador(compradorId: string | null) {
  const { estado } = useMinhasSugestoes();
  if (!compradorId || estado.tipo !== 'pronta') return null;
  return estado.resp.compradores.find((c) => c.compradorId === compradorId) ?? null;
}

/**
 * Ondas 2–3 ligadas no servidor, lidas da MESMA resposta da lista (o gerador só cria linha de
 * complemento/preço com a onda ligada; a ficha também esconde a seção com ela desligada).
 * Lista ainda não pronta (carregando, erro, Onda 1 desligada) → tudo desligado.
 */
export function useOndasVenda(): OndasVenda {
  const { estado } = useMinhasSugestoes();
  return estado.tipo === 'pronta' ? estado.resp.ondas : ONDAS_DESLIGADAS;
}
