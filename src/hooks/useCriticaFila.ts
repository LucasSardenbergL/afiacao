// src/hooks/useCriticaFila.ts
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useMinhasTarefas } from '@/hooks/useTarefas';
import { useRouteContactList } from '@/queries/useRouteContactList';
import { spBusinessDate } from '@/lib/time/sp-day';
import { montarEvidencePack } from '@/lib/fila/critica/montar';
import { buildCriticaInputs, type MetricRowFull, type RotaSinalCliente, type TarefaSinalCliente, type WaSlaSinalCliente } from '@/lib/fila/critica/build-inputs';
import type { AcaoSugerida } from '@/lib/fila/types';
import type { EvidencePack } from '@/lib/fila/critica/types';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useWhatsappSla } from '@/queries/useWhatsappSla';
import { rotaCongelada } from '@/lib/modulos/congelamento';
import { MODULOS } from '@/lib/modulos/manifesto';

const IN_CHUNK = 200;

async function fetchCriticaMetrics(ids: string[]): Promise<MetricRowFull[]> {
  const out: MetricRowFull[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await supabase
      .from('customer_metrics_mv')
      .select('customer_user_id, intervalo_medio_dias, dias_desde_ultima_compra, atraso_relativo, faturamento_90d, faturamento_prev_90d, is_cold_start')
      .in('customer_user_id', ids.slice(i, i + IN_CHUNK));
    if (error) throw error;
    out.push(...((data ?? []) as MetricRowFull[]));
  }
  return out;
}

/** EvidencePack por cliente para os top-N cards da fila. Map keyed por clienteUserId. */
export function useCriticaFila(acoes: AcaoSugerida[], topN = 5): Map<string, EvidencePack> {
  const workdayIso = useMemo(() => spBusinessDate(new Date()), []);

  const topIds = useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const a of acoes) {
      if (a.clienteUserId && !seen.has(a.clienteUserId)) { seen.add(a.clienteUserId); ids.push(a.clienteUserId); }
      if (ids.length >= topN) break;
    }
    return ids;
  }, [acoes, topN]);

  const { user } = useAuth();
  const { isImpersonating, effectiveUserId } = useImpersonation();
  const donoEfetivo = isImpersonating && effectiveUserId ? effectiveUserId : (user?.id ?? null);
  // Módulo congelado (M-41) não é lido: a query fica desligada e o sinal sai "indisponível"
  // abaixo (data ausente ⇒ null) — nunca lista vazia, que se passaria por "sem sinal".
  const slaQ = useWhatsappSla({ enabled: rotaCongelada('/whatsapp', MODULOS) === null });

  const rota = useRouteContactList(workdayIso, { enabled: rotaCongelada('/rota', MODULOS) === null });
  const tarefas = useMinhasTarefas({ enabled: rotaCongelada('/tarefas', MODULOS) === null });
  const metricsQ = useQuery({
    queryKey: ['critica-metrics', topIds],
    enabled: topIds.length > 0,
    staleTime: 60_000,
    queryFn: () => fetchCriticaMetrics(topIds),
  });

  return useMemo(() => {
    const result = new Map<string, EvidencePack>();
    if (topIds.length === 0) return result;

    // Sem data (desligada, carregando ou com erro) = fonte NÃO lida ⇒ null, nunca [].
    const rotaSinais: RotaSinalCliente[] | null = rota.data == null || rota.data.cadenciaIndisponivel
      ? null
      : rota.data.callQueue.map(c => ({
          customerUserId: c.customerUserId,
          naCallQueue: true,
          semRespostaRecenteN: c.semRespostaRecenteN,
          ultimoContatoRealHaDias: c.ultimoContatoRealHaDias,
        }));

    // Tarefa sem cliente (recorrente nascida de template sem cliente) não é sinal DE CLIENTE: fica fora.
    const tarefaSinais: TarefaSinalCliente[] | null = tarefas.data == null ? null : tarefas.data.flatMap(t =>
      t.customer_user_id === null
        ? []
        : [{
            customerUserId: t.customer_user_id,
            atrasada: t.atrasada,
            temSugestaoPendente: t.tem_sugestao_pendente,
            descricao: t.descricao,
          }],
    );

    const waSlaSinais: WaSlaSinalCliente[] | null = slaQ.data == null ? null : slaQ.data
      .filter(r => r.customer_user_id != null && donoEfetivo != null && r.owner_user_id === donoEfetivo)
      .map(r => ({ customerUserId: r.customer_user_id as string, minutosUteis: r.minutos_uteis_aguardando, nivel: r.nivel }));

    const topAcoes = acoes.filter(a => a.clienteUserId != null && topIds.includes(a.clienteUserId));
    const inputs = buildCriticaInputs(topAcoes, metricsQ.data ?? [], rotaSinais, tarefaSinais, waSlaSinais);
    for (const input of inputs) result.set(input.clienteUserId, montarEvidencePack(input));
    return result;
  }, [topIds, acoes, rota.data, tarefas.data, metricsQ.data, slaQ.data, donoEfetivo]);
}
