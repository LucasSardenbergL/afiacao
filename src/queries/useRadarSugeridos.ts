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
 * da linha precisam contar/mostrar o MESMO conjunto — qualquer cláusula nova entra aqui e lá.
 *
 * `.or()` com string CONSTANTE (sem input) — a regra ESLint barra interpolação, não a forma.
 * RFB: positivo (`is.null` OU `eq.02`), porque a negação do PostgREST é NULL-blind e deixaria
 * de fora quem ainda não foi cruzado — que é a maioria.
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

export interface ContagemSugeridos {
  /** N do card. Só é um zero de verdade quando `temScore`. */
  sugeridos: number;
  /** O lote vigente tem ALGUM score calculado? Sem isso, `sugeridos` seria um 0 fabricado
   *  (o cron das 03:30 ainda não passou sobre o lote). */
  temScore: boolean;
}

/**
 * N do card "Sugeridos para cadastro". Count `exact, head:true` (o PostgREST capa em 1.000 linhas;
 * contar no cliente mentiria) + uma sonda de 1 linha "existe score neste lote?". `count` nulo é
 * ausência de dado e LANÇA — `Number(null) === 0` fabricaria zero.
 */
export function useRadarSugeridos(lote: { mes_referencia: string } | null) {
  return useQuery({
    queryKey: ['radar', 'sugeridos', lote?.mes_referencia ?? null, LIMIAR_SUGERIDO],
    enabled: lote != null,
    staleTime: 60_000,
    queryFn: async (): Promise<ContagemSugeridos> => {
      if (!lote) throw new Error('useRadarSugeridos sem lote vigente');
      const [cont, sonda] = await Promise.all([
        filtrarSugeridos(supabase.from('radar_empresas').select('cnpj', { count: 'exact', head: true }), lote),
        supabase.from('radar_empresas').select('cnpj').eq('ultimo_lote', lote.mes_referencia).not('score', 'is', null).limit(1),
      ]);
      if (cont.error) throw cont.error;
      if (sonda.error) throw sonda.error;
      if (cont.count == null) throw new Error('count de sugeridos ausente na resposta');
      return { sugeridos: cont.count, temScore: (sonda.data?.length ?? 0) > 0 };
    },
  });
}
