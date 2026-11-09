import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fotoPostgrest, type LoteIngest } from '@/lib/radar/lote-vigente';

/**
 * N do card "Inéditos do lote YYYY-MM: N de T" — quantas empresas ENTRARAM no universo neste
 * lote (`primeira_vista_em >= iniciado_em` do lote vigente E `ultimo_lote` = vigente). É o MESMO
 * predicado do selo "inédito" da linha (`ehInedito`); divergir seria o card contar uma coisa e a
 * fila mostrar outra. T (denominador) é `total_recebido` do próprio lote.
 *
 * Count via `count:'exact', head:true` — o PostgREST capa a resposta em 1.000 linhas (CLAUDE.md),
 * então contar no cliente diria "1.000" para 27.466 (medido 2026-10-19). `count` nulo é ausência de
 * dado e LANÇA: `Number(null) === 0` fabricaria zero (money-path: ausente ≠ zero).
 *
 * Só roda com lote em mãos: sem lote completo não há o que contar, e o card diz "sem lote".
 */
export function useRadarIneditos(lote: LoteIngest | null) {
  return useQuery({
    queryKey: ['radar', 'ineditos', lote?.mes_referencia ?? null, lote?.iniciado_em ?? null, lote?.publicando ?? null],
    enabled: lote != null,
    staleTime: 60_000,
    queryFn: async (): Promise<number> => {
      if (!lote) throw new Error('useRadarIneditos sem lote vigente');
      // Foto vigente como em `radar_lista`: durante a publicação em passos inclui quem já ganhou o
      // rótulo novo vindo do vigente (lote_anterior) — senão o card encolheria a cada passo.
      const foto = fotoPostgrest(lote);
      const base = supabase
        .from('radar_empresas')
        .select('cnpj', { count: 'exact', head: true })
        .in('ultimo_lote', foto.rotulos)
        .gte('primeira_vista_em', lote.iniciado_em);
      const { count, error } = await (foto.ou ? base.or(foto.ou) : base);
      if (error) throw error;
      if (count == null) throw new Error('count de inéditos ausente na resposta');
      return count;
    },
  });
}
