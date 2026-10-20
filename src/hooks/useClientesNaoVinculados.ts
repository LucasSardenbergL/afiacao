import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import type { Tables } from '@/integrations/supabase/types';
import { linhasCom, type ComColunas } from '@/lib/linha-view';

// View perde o NOT NULL no types.ts; `id`/`omie_codigo_cliente` são exigidos na borda (`linhasCom`).
type ClienteNaoVinculado = ComColunas<
  Pick<
    Tables<'v_clientes_nao_vinculados_atual'>,
    'id' | 'omie_codigo_cliente' | 'cnpj_cpf' | 'razao_social' | 'nome_fantasia' | 'cidade' | 'uf' | 'codigo_vendedor'
  >,
  'id' | 'omie_codigo_cliente'
>;

// status: idle | running | complete | error (texto no banco; a tela compara por igualdade)
type NaoVinculadosState = Pick<
  Tables<'omie_nao_vinculados_state'>,
  'status' | 'last_complete_synced_at' | 'total' | 'error_message'
>;

export interface NaoVinculadosResult {
  lista: ClienteNaoVinculado[];
  state: NaoVinculadosState | null;
}

const EMPRESA = 'oben';

export function useClientesNaoVinculados() {
  const { isMaster, isGestorComercial } = useAuth();
  const enabled = isMaster || isGestorComercial;

  return useQuery({
    queryKey: ['clientes-nao-vinculados', EMPRESA],
    enabled,
    staleTime: 60_000,
    refetchInterval: (query) => {
      const status = (query.state.data as NaoVinculadosResult | undefined)?.state?.status;
      return status === 'running' ? 4000 : false;
    },
    queryFn: async (): Promise<NaoVinculadosResult> => {
      const [listRes, stateRes] = await Promise.all([
        supabase
          .from('v_clientes_nao_vinculados_atual')
          .select('id, omie_codigo_cliente, cnpj_cpf, razao_social, nome_fantasia, cidade, uf, codigo_vendedor')
          .eq('empresa', EMPRESA)
          .order('razao_social', { ascending: true }),
        supabase
          .from('omie_nao_vinculados_state')
          .select('status, last_complete_synced_at, total, error_message')
          .eq('empresa', EMPRESA)
          .maybeSingle(),
      ]);
      if (listRes.error) throw new Error(listRes.error.message);
      if (stateRes.error) throw new Error(stateRes.error.message);
      return {
        lista: linhasCom(listRes.data, ['id', 'omie_codigo_cliente'], 'v_clientes_nao_vinculados_atual'),
        state: stateRes.data,
      };
    },
  });
}
