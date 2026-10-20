import { useEffect, useMemo } from 'react';
import { useMyMixGap } from '@/hooks/useMyMixGap';
import { useMinhasSugestoes, type EstadoRecompra } from '@/hooks/useMinhasSugestoes';
import { mixGapParaAcoes } from '@/lib/fila/adapters/mixgap';
import { adaptarRecompra } from '@/lib/fila/adapters/recompra';
import { dedupe, rankearFila } from '@/lib/fila/ranking';
import { logger } from '@/lib/logger';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import type { AcaoSugerida } from '@/lib/fila/types';

/** Fonte da fila — identifica QUAL falhou (a UI e o log nomeiam, não mais "uma das fontes"). */
export type FonteFila = 'recompra' | 'mix-gap';

/**
 * A fila única do Meu Dia. Fonte principal: `recompra` (lista gerada no servidor,
 * `venda_minhas_sugestoes`). `mix-gap` segue até a Onda 2 levá-lo para dentro da ficha.
 *
 * Desligadas enquanto vigorar o congelamento M-41 (telefonia/WhatsApp/rota/tarefas, até
 * 2027-01-10): `rota`, `tarefa` e `whatsappPendente` consultavam tabelas vazias e geravam
 * links para módulos congelados. Os adapters ficam no repo; só não são chamados.
 */
export function useFilaAcoes(): {
  acoes: AcaoSugerida[];
  isLoading: boolean;
  isError: boolean;
  /** Quais fontes falharam (vazio = todas OK). Distingue p/ a UI e o log. */
  fontesComErro: FonteFila[];
  /** Estado da lista de recompra — a UI tem uma tela para "onda desligada" e para a lente. */
  recompra: EstadoRecompra;
  retry: () => void;
} {
  const recompra = useMinhasSugestoes();
  const mixgap = useMyMixGap();
  const estado = recompra.estado;

  const acoes = useMemo(() => {
    const todas: AcaoSugerida[] = [
      ...adaptarRecompra(estado.tipo === 'pronta' ? estado.resp : null),
      ...mixGapParaAcoes(mixgap.data ?? null),
    ];
    return rankearFila(dedupe(todas));
  }, [estado, mixgap.data]);

  // Erro ≠ dia limpo: falha de RLS/rede em qualquer fonte NÃO vira lista vazia que afirma
  // "carteira em dia" (falso-verde num motor de receita).
  const fontesComErro = useMemo<FonteFila[]>(() => {
    const f: FonteFila[] = [];
    if (estado.tipo === 'erro') f.push('recompra');
    if (mixgap.isError) f.push('mix-gap');
    return f;
  }, [estado.tipo, mixgap.isError]);
  const isError = fontesComErro.length > 0;

  useEffect(() => {
    if (fontesComErro.length === 0) return;
    logger.warn('Fila do dia: fonte(s) falharam ao carregar', {
      fontes: fontesComErro,
      recompra: estado.tipo === 'erro' ? mensagemDeErro(estado.erro) : null,
      mixgap: mensagemDeErro(mixgap.error),
    });
  }, [fontesComErro, estado, mixgap.error]);

  const retry = () => {
    if (estado.tipo === 'erro') recompra.refetch();
    if (mixgap.isError) void mixgap.refetch();
  };

  return {
    acoes,
    isLoading: estado.tipo === 'carregando' || mixgap.isLoading,
    isError,
    fontesComErro,
    recompra: estado,
    retry,
  };
}
