import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllPages } from '@/lib/postgrest';
import { agruparPorCor, contagemDoBadge, type CorRejeitada, type LinhaDeErro } from '@/lib/tint/rejeicoes';

const ACCOUNT = 'oben';

type FormulasRejeitadas = {
  /** Quando o último run de fórmulas começou — a janela termina nele. */
  runEm: string | null;
  /** Soma de `tint_sync_runs.errors` na janela — pode ser >0 com a lista vazia (detalhe faltou). */
  rejeicoesNaJanela: number;
  cores: CorRejeitada[];
};

/** Janela que o card cobre, ancorada no ÚLTIMO run (não em "agora": balcão desligado ≠ zero erro). */
export const JANELA_HORAS = 24;

const QUERY_KEY = ['tint-formulas-rejeitadas'] as const;

/**
 * Fórmulas que o guard REJEITOU nas 24h até o último run de fórmulas — deduplicadas por cor.
 *
 * Antes o card lia `tint_importacoes.erros_detalhe`, coluna que o writer vivo (`tint_promote_sync_run`)
 * NUNCA preenche (0 de 4.160 linhas com erro, psql-ro 2026-10-18). O detalhe vive em
 * `tint_sync_errors`; a correção dessas receitas é na máquina SayerSystem / no re-scan do conector
 * (`docs/agent/tintometrico.md`: dado da fonte, guard certo).
 *
 * Janela e não só o último run: o conector manda um LOTE diferente a cada ciclo (~11min), então o
 * último run é um recorte — em 21/10/2026 ele mostrava 7 cores, as 24h tinham 51, e o run seguinte
 * teve 0 (o card sumia sem nada ter mudado na fonte).
 */
async function lerFormulasRejeitadas(): Promise<FormulasRejeitadas | null> {
  const ultimo = await supabase
    .from('tint_sync_runs')
    .select('started_at')
    .eq('account', ACCOUNT)
    .eq('sync_type', 'formulas')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (ultimo.error) throw ultimo.error;
  // Sem run nenhum não há o que listar — `null` aqui é "não existe", não "não li".
  if (!ultimo.data) return null;

  const inicio = new Date(new Date(ultimo.data.started_at).getTime() - JANELA_HORAS * 3_600_000).toISOString();

  // Teto do PostgREST é 1.000 linhas SILENCIOSO — as duas leituras paginam (`fetchAllPages`
  // lança em página perdida em vez de devolver o parcial como se fosse tudo).
  const runs = await fetchAllPages<{ errors: number | null }>(
    (de, ate) => supabase
      .from('tint_sync_runs')
      .select('id, errors')
      .eq('account', ACCOUNT)
      .eq('sync_type', 'formulas')
      .gte('started_at', inicio)
      .order('started_at', { ascending: false })
      .order('id')
      .range(de, ate),
    'tint_sync_runs/rejeitadas',
  );

  // Mais novo primeiro — `agruparPorCor` usa a 1ª ocorrência de cada cor como o run dela.
  const linhas = await fetchAllPages<LinhaDeErro>(
    (de, ate) => supabase
      .from('tint_sync_errors')
      .select('sync_run_id, entity_type, entity_id, error_message, error_details, tint_sync_runs!inner(account, sync_type, started_at)')
      .eq('tint_sync_runs.account', ACCOUNT)
      .eq('tint_sync_runs.sync_type', 'formulas')
      .gte('tint_sync_runs.started_at', inicio)
      .order('created_at', { ascending: false })
      .order('id')
      .range(de, ate),
    'tint_sync_errors/rejeitadas',
  );

  return {
    runEm: ultimo.data.started_at,
    rejeicoesNaJanela: runs.reduce((s, r) => s + (r.errors ?? 0), 0),
    cores: agruparPorCor(linhas),
  };
}

/** O card "Fórmulas rejeitadas pela fonte" do Dashboard tintométrico. */
export function useFormulasRejeitadas() {
  return useQuery({ queryKey: QUERY_KEY, queryFn: lerFormulasRejeitadas });
}

/**
 * Badge da sidebar em `/tintometrico`: o MESMO número do card (mesma query/queryKey — na página do
 * Dashboard as duas leituras são uma só). Erro de leitura → `data` undefined → o shell não pinta
 * badge (ausente ≠ zero, e também ≠ alerta).
 *
 * Antes contava runs de `tint_importacoes` com `registros_erro > 0` em 60 dias — histórico
 * acumulado (2.656 em 31/10/2026 com 1 cor barrada de fato). Ver `contagemDoBadge`.
 *
 * `enabled` é OBRIGATÓRIO — ver nota em useAlertasCriticos (sem gate, usuários
 * não-staff polavam a tabela contra RLS que nega).
 */
export function useTintAlertas(enabled: boolean) {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: lerFormulasRejeitadas,
    enabled,
    select: contagemDoBadge,
    // O conector roda a cada ~11min e a leitura pagina `tint_sync_errors` — 5min basta para o badge.
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}
