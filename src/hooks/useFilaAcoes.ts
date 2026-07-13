import { useEffect, useMemo } from 'react';
import { useMinhasTarefas } from '@/hooks/useTarefas';
import { useRouteContactList } from '@/queries/useRouteContactList';
import { useMyMixGap } from '@/hooks/useMyMixGap';
import { useWhatsappPendentes } from '@/hooks/useWhatsappPendentes';
import { tarefasParaAcoes } from '@/lib/fila/adapters/tarefa';
import { rotaParaAcoes } from '@/lib/fila/adapters/rota';
import { mixGapParaAcoes } from '@/lib/fila/adapters/mixgap';
import { whatsappPendenteParaAcoes } from '@/lib/fila/adapters/whatsappPendente';
import { dedupe, rankearFila } from '@/lib/fila/ranking';
import { spBusinessDate } from '@/lib/time/sp-day';
import { logger } from '@/lib/logger';
import type { AcaoSugerida } from '@/lib/fila/types';

/** Fonte da fila — identifica QUAL falhou (a UI e o log nomeiam, não mais "uma das fontes"). */
export type FonteFila = 'tarefas' | 'rota' | 'mix-gap' | 'whatsapp';

export function useFilaAcoes(): {
  acoes: AcaoSugerida[];
  isLoading: boolean;
  isError: boolean;
  /** Quais fontes falharam (vazio = todas OK). Distingue p/ a UI e o log. */
  fontesComErro: FonteFila[];
  retry: () => void;
} {
  const workdayIso = useMemo(() => spBusinessDate(new Date()), []);

  const tarefas = useMinhasTarefas();
  const rota = useRouteContactList(workdayIso);
  const mixgap = useMyMixGap();
  // Fonte ligada no PR-2 do Canal WhatsApp: RPC sem cap com last_outbound_at real
  // (o v1 de front tinha falso-negativo — cap 200 do inbox + proxy last_message_at).
  const whatsapp = useWhatsappPendentes();

  const acoes = useMemo(() => {
    const todas: AcaoSugerida[] = [
      ...tarefasParaAcoes(tarefas.data ?? []),
      ...rotaParaAcoes(rota.data?.callQueue ?? [], rota.data?.routeDate ?? workdayIso),
      ...mixGapParaAcoes(mixgap.data ?? null),
      ...whatsappPendenteParaAcoes(whatsapp.data),
    ];
    return rankearFila(dedupe(todas));
  }, [tarefas.data, rota.data, mixgap.data, whatsapp.data]);

  // isError PROPAGADO (antes era descartado): falha de RLS/rede em qualquer
  // fonte virava lista vazia → a FilaDoDia afirmava "carteira em dia" —
  // falso-verde num motor de receita. A UI distingue erro de dia limpo.
  // fontesComErro NOMEIA quais falharam — antes o card só dizia "uma das fontes
  // falhou" sem dizer qual, impossível diagnosticar pela tela. (Na lente do
  // master a ROTA lê ~12× mais linhas que p/ a vendedora real — é a candidata.)
  const fontesComErro = useMemo<FonteFila[]>(() => {
    const f: FonteFila[] = [];
    if (tarefas.isError) f.push('tarefas');
    if (rota.isError) f.push('rota');
    if (mixgap.isError) f.push('mix-gap');
    if (whatsapp.isError) f.push('whatsapp');
    return f;
  }, [tarefas.isError, rota.isError, mixgap.isError, whatsapp.isError]);
  const isError = fontesComErro.length > 0;

  // Log estruturado com a MENSAGEM de cada fonte que falhou — o sinal que
  // faltava p/ saber se é RLS, rede, timeout (incidente de plataforma) ou query.
  useEffect(() => {
    if (fontesComErro.length === 0) return;
    const msg = (e: unknown) => (e instanceof Error ? e.message : e ? String(e) : null);
    logger.warn('Fila do dia: fonte(s) falharam ao carregar', {
      fontes: fontesComErro,
      tarefas: msg(tarefas.error),
      rota: msg(rota.error),
      mixgap: msg(mixgap.error),
      whatsapp: msg(whatsapp.error),
    });
  }, [fontesComErro, tarefas.error, rota.error, mixgap.error, whatsapp.error]);

  const retry = () => {
    if (tarefas.isError) void tarefas.refetch();
    if (rota.isError) void rota.refetch();
    if (mixgap.isError) void mixgap.refetch();
    if (whatsapp.isError) whatsapp.refetch();
  };

  return {
    acoes,
    isLoading: tarefas.isLoading || rota.isLoading || mixgap.isLoading || whatsapp.isLoading,
    isError,
    fontesComErro,
    retry,
  };
}
