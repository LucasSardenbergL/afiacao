import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Database } from '@/integrations/supabase/types';

type RadarContato = Database['public']['Tables']['radar_contatos']['Row'];

export const LIMITE_HISTORICO_RADAR = 20;

/**
 * Autor de sistema do descarte automático da Receita (o finalize do lote grava com este UUID; migration
 * 20261029150100). Ele não tem `profiles`: sem este mapa a ficha dizia "autor não identificado".
 */
export const AUTOR_SISTEMA_RECEITA = '00000000-0000-0000-0000-00000000ad0f';
export const NOME_AUTOR_SISTEMA_RECEITA = 'Receita Federal (automático)';

/** Contato do histórico com o NOME do autor (B4). `autor` null = não consegui identificar (nunca um nome inventado). */
export type RadarContatoComAutor = RadarContato & { autor: string | null };

/**
 * Histórico de contatos de um lead (`radar_contatos`, RLS `cap_radar_prospectar`). Últimos N, mais recente
 * primeiro. Quem consome distingue erro de vazio (estadoDeLeitura). O autor vem de `profiles` (staff lê todos);
 * falha ao ler os nomes NÃO derruba o histórico — o autor fica `null` e a tela diz "autor não identificado".
 */
export function useRadarContatos(cnpj: string | null) {
  return useQuery({
    queryKey: ['radar', 'contatos', cnpj],
    enabled: !!cnpj,
    queryFn: async (): Promise<RadarContatoComAutor[]> => {
      const { data, error } = await supabase
        .from('radar_contatos')
        .select('*')
        .eq('cnpj', cnpj as string)
        .order('created_at', { ascending: false })
        .range(0, LIMITE_HISTORICO_RADAR - 1);
      if (error) throw error;
      const contatos = data ?? [];
      const ids = [...new Set(contatos.map((c) => c.criado_por)
        .filter((x): x is string => !!x && x !== AUTOR_SISTEMA_RECEITA))];
      const nomes = new Map<string, string>();
      if (ids.length > 0) {
        const { data: perfis, error: e2 } = await supabase
          .from('profiles')
          .select('user_id,name')
          .in('user_id', ids)
          .order('user_id', { ascending: true })
          .range(0, LIMITE_HISTORICO_RADAR - 1);
        if (!e2) for (const p of perfis ?? []) if (p.name) nomes.set(p.user_id, p.name);
      }
      const autorDe = (id: string | null) =>
        id === AUTOR_SISTEMA_RECEITA ? NOME_AUTOR_SISTEMA_RECEITA : (id && nomes.get(id)) || null;
      return contatos.map((c) => ({ ...c, autor: autorDe(c.criado_por) }));
    },
    staleTime: 30_000,
  });
}
