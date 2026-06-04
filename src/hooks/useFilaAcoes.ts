import { useMemo } from 'react';
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
import type { AcaoSugerida } from '@/lib/fila/types';

export function useFilaAcoes(): { acoes: AcaoSugerida[]; isLoading: boolean } {
  const workdayIso = useMemo(() => spBusinessDate(new Date()), []);

  const tarefas = useMinhasTarefas();
  const rota = useRouteContactList(workdayIso);
  const mixgap = useMyMixGap();
  const waPend = useWhatsappPendentes();

  const acoes = useMemo(() => {
    const todas: AcaoSugerida[] = [
      ...tarefasParaAcoes(tarefas.data ?? []),
      ...rotaParaAcoes(rota.data?.callQueue ?? []),
      ...mixGapParaAcoes(mixgap.data ?? null),
      ...whatsappPendenteParaAcoes(waPend.data ?? []),
    ];
    return rankearFila(dedupe(todas));
  }, [tarefas.data, rota.data, mixgap.data, waPend.data]);

  return { acoes, isLoading: tarefas.isLoading || rota.isLoading || mixgap.isLoading || waPend.isLoading };
}
