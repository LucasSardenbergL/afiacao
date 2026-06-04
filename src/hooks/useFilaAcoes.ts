import { useMemo } from 'react';
import { useMinhasTarefas } from '@/hooks/useTarefas';
import { useRouteContactList } from '@/queries/useRouteContactList';
import { useMyMixGap } from '@/hooks/useMyMixGap';
import { tarefasParaAcoes } from '@/lib/fila/adapters/tarefa';
import { rotaParaAcoes } from '@/lib/fila/adapters/rota';
import { mixGapParaAcoes } from '@/lib/fila/adapters/mixgap';
import { dedupe, rankearFila } from '@/lib/fila/ranking';
import { spBusinessDate } from '@/lib/time/sp-day';
import type { AcaoSugerida } from '@/lib/fila/types';

// Fonte "WhatsApp pendente" ADIADA p/ Fase 3 (split): a versão de front tem
// falso-negativo (cap 200 do inbox + proxy last_message_at — Codex P1). Lá será
// reescrita sobre query/RPC de pendentes com last_outbound_at real. O adapter
// (whatsappPendente.ts) e o hook (useWhatsappPendentes.ts) já existem, prontos.
export function useFilaAcoes(): { acoes: AcaoSugerida[]; isLoading: boolean } {
  const workdayIso = useMemo(() => spBusinessDate(new Date()), []);

  const tarefas = useMinhasTarefas();
  const rota = useRouteContactList(workdayIso);
  const mixgap = useMyMixGap();

  const acoes = useMemo(() => {
    const todas: AcaoSugerida[] = [
      ...tarefasParaAcoes(tarefas.data ?? []),
      ...rotaParaAcoes(rota.data?.callQueue ?? [], rota.data?.routeDate ?? workdayIso),
      ...mixGapParaAcoes(mixgap.data ?? null),
    ];
    return rankearFila(dedupe(todas));
  }, [tarefas.data, rota.data, mixgap.data]);

  return { acoes, isLoading: tarefas.isLoading || rota.isLoading || mixgap.isLoading };
}
