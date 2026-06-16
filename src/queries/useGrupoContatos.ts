import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Contatos consolidados do grupo (lê a view v_grupo_contatos): nome/telefone/endereço/vendedor
 * por documento. Read-only. Cast temporário até a regen de tipos (Task 4).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as unknown as { from: (table: string) => any };

export interface GrupoContato {
  documento: string;
  user_id: string;
  nome: string | null;
  phone: string | null;
  email: string | null;
  cidade: string | null;
  uf: string | null;
  endereco: string | null;
  omie_codigo_vendedor: number | null;
  empresa_omie: string | null;
}

export function useGrupoContatos(grupoId: string | undefined) {
  return useQuery({
    queryKey: ['grupo-contatos', grupoId],
    enabled: !!grupoId,
    queryFn: async (): Promise<GrupoContato[]> => {
      const { data, error } = await db
        .from('v_grupo_contatos')
        .select('*')
        .eq('grupo_id', grupoId);
      if (error) throw error;
      return (data ?? []) as GrupoContato[];
    },
  });
}
