import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

export interface ClienteNaoVinculado {
  id: string;
  omie_codigo_cliente: number;
  cnpj_cpf: string | null;
  razao_social: string | null;
  nome_fantasia: string | null;
  cidade: string | null;
  uf: string | null;
  codigo_vendedor: number | null;
}

export interface NaoVinculadosState {
  status: string; // idle | running | complete | error
  last_complete_synced_at: string | null;
  total: number | null;
  error_message: string | null;
}

export interface NaoVinculadosResult {
  lista: ClienteNaoVinculado[];
  state: NaoVinculadosState | null;
}

const EMPRESA = 'oben';

// Tabelas/views novas não estão no types.ts gerado → cast por shape mínimo (sem any).
type PgFilter = PromiseLike<{ data: unknown; error: { message: string } | null }> & {
  eq: (col: string, val: string) => PgFilter;
  order: (col: string, opts: { ascending: boolean }) => PgFilter;
  maybeSingle: () => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

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
      const client = supabase as unknown as { from: (t: string) => { select: (c: string) => PgFilter } };
      const [listRes, stateRes] = await Promise.all([
        client
          .from('v_clientes_nao_vinculados_atual')
          .select('id, omie_codigo_cliente, cnpj_cpf, razao_social, nome_fantasia, cidade, uf, codigo_vendedor')
          .eq('empresa', EMPRESA)
          .order('razao_social', { ascending: true }),
        client
          .from('omie_nao_vinculados_state')
          .select('status, last_complete_synced_at, total, error_message')
          .eq('empresa', EMPRESA)
          .maybeSingle(),
      ]);
      if (listRes.error) throw new Error(listRes.error.message);
      if (stateRes.error) throw new Error(stateRes.error.message);
      return {
        lista: (listRes.data as ClienteNaoVinculado[]) ?? [],
        state: (stateRes.data as NaoVinculadosState | null) ?? null,
      };
    },
  });
}
