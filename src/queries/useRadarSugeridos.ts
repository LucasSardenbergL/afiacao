import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { LIMIAR_SUGERIDO } from '@/lib/radar/sugeridos';

/** O mínimo de builder PostgREST que o predicado usa — a lista e o count passam o deles. */
export interface BuilderSugeridos<T> {
  eq(coluna: string, valor: string | number | boolean): T;
  gte(coluna: string, valor: number): T;
  is(coluna: string, valor: null): T;
  or(filtros: string): T;
  filter(coluna: string, operador: 'match', valor: string): T;
}

/**
 * Tradução PostgREST de `sugeridoParaCadastro` (helper puro): foto vigente, sinal comercial
 * (`em_conversa`), não cliente e sem vínculo Omie, RFB ativa ou não cruzada, CNPJ numérico (o
 * Omie ainda não aceita o alfanumérico) e `score ≥ LIMIAR_SUGERIDO`. Card, filtro da fila e selo
 * da linha precisam contar/mostrar o MESMO conjunto — qualquer cláusula nova entra aqui e lá
 * (`sugeridos.test.ts` + os testes do card e da lista exigem o predicado inteiro).
 *
 * `.or()` com string CONSTANTE (sem input) — a regra ESLint barra interpolação, não a forma.
 * RFB: positivo (`is.null` OU `eq.02`), porque a negação do PostgREST é NULL-blind e deixaria
 * de fora quem ainda não foi cruzado — e hoje (2026-10-20) isso é 100 % da foto 2026-08
 * (501.380 linhas com `rfb_situacao` NULL): exigir `02` deixaria o card morto em zero.
 */
export function filtrarSugeridos<T extends BuilderSugeridos<T>>(q: T, lote: { mes_referencia: string }): T {
  return q
    .eq('ultimo_lote', lote.mes_referencia)
    .eq('prospeccao_status', 'em_conversa')
    .eq('ja_cliente', false)
    .is('omie_codigo_cliente', null)
    .or('rfb_situacao.is.null,rfb_situacao.eq.02')
    .filter('cnpj', 'match', '^[0-9]{14}$')
    .gte('score', LIMIAR_SUGERIDO);
}

/** Slug do ledger `acoes_execucoes` escrito por `radar_score_recalcular()` (1 escritor, cron 03:30 BRT). */
const SLUG_SCORE = 'radar.score_recalcular';

export interface ContagemSugeridos {
  /** N do card. Só é um zero de verdade quando `temScore`. */
  sugeridos: number;
  /** Houve rodada de score CONCLUÍDA (`sucesso`) sobre ESTE lote vigente? Sem isso, `sugeridos`
   *  seria um 0 fabricado: lote novo chega com os CNPJs inéditos em `score NULL` até o cron
   *  passar, e "existe algum score" (sonda por linha) aprovaria o zero sobre cobertura parcial
   *  (parecer Codex 2026-10-20). A prova é o ledger da rodada, não uma linha com nota. */
  temScore: boolean;
}

/**
 * N do card "Sugeridos para cadastro". Count `exact, head:true` (o PostgREST capa em 1.000 linhas;
 * contar no cliente mentiria) + a última rodada `sucesso` do score e o lote que ela cobriu.
 * `count` nulo e `data` nulo são ausência de dado e LANÇAM — `Number(null) === 0` fabricaria zero.
 */
export function useRadarSugeridos(lote: { mes_referencia: string } | null) {
  return useQuery({
    queryKey: ['radar', 'sugeridos', lote?.mes_referencia ?? null, LIMIAR_SUGERIDO],
    enabled: lote != null,
    staleTime: 60_000,
    queryFn: async (): Promise<ContagemSugeridos> => {
      if (!lote) throw new Error('useRadarSugeridos sem lote vigente');
      const [cont, rodada] = await Promise.all([
        filtrarSugeridos(supabase.from('radar_empresas').select('cnpj', { count: 'exact', head: true }), lote),
        supabase
          .from('acoes_execucoes')
          .select('detalhes')
          .eq('acao', SLUG_SCORE)
          .eq('status', 'sucesso')
          .order('iniciado_em', { ascending: false })
          .limit(1),
      ]);
      if (cont.error) throw cont.error;
      if (rodada.error) throw rodada.error;
      if (cont.count == null) throw new Error('count de sugeridos ausente na resposta');
      if (rodada.data == null) throw new Error('ledger do score ausente na resposta');
      const detalhes = rodada.data[0]?.detalhes as { lote_vigente?: unknown } | null | undefined;
      return { sugeridos: cont.count, temScore: detalhes?.lote_vigente === lote.mes_referencia };
    },
  });
}
