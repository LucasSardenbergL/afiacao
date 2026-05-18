import { useMutation, useQueryClient } from '@tanstack/react-query';
import { invokeFunction } from '@/lib/invoke-function';
import { toast } from 'sonner';

export interface CreateProspectInput {
  razao_social: string;
  phone: string;
  nome_contato?: string;
  email?: string;
  cnpj?: string;
  segmento?: string;
  tags?: string[];
  origin_call_id?: string;
  source?: 'chamada_inbound' | 'chamada_outbound' | 'walk_in' | 'manual';
  /** PR-CAPTURE-B: campos opcionais pra sync Omie multi-empresa */
  cidade?: string;
  estado?: string;
  endereco?: string;
  /** Default true: dispara sync nos 3 Omies em fire-and-forget após criar profile. */
  sync_omie?: boolean;
}

export interface CreateProspectResponse {
  ok: boolean;
  user_id: string;
  profile: {
    user_id: string;
    razao_social: string;
    phone: string;
    is_prospect: boolean;
  };
}

export interface OmieMultiResult {
  ok: boolean;
  summary: { created: number; errors: number; skipped: number; total: number };
  results: Array<{
    empresa: 'colacor' | 'oben' | 'colacor_sc';
    empresa_label: string;
    status: 'created' | 'skipped_no_secret' | 'error';
    codigo_cliente_omie?: number;
    error?: string;
  }>;
}

/**
 * Cria prospect (cliente novo cadastrado pelo vendedor). Edge fn usa service
 * role pra criar auth.users dummy + profile com is_prospect=true. Se passar
 * origin_call_id, retroativa farmer_calls.customer_user_id.
 *
 * PR-CAPTURE-B: dispara `omie-create-customer-multi` fire-and-forget pra
 * sincronizar nas 3 contas Omie em paralelo (toast com summary depois).
 * Falhas no Omie NÃO bloqueiam o sucesso do prospect (graceful degradation).
 */
export function useCreateProspect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateProspectInput): Promise<CreateProspectResponse> => {
      const resp = await invokeFunction<CreateProspectResponse>('create-prospect-customer', input);

      // PR-CAPTURE-B: sync Omie multi-empresa fire-and-forget
      const shouldSyncOmie = input.sync_omie !== false && resp.user_id;
      if (shouldSyncOmie) {
        invokeFunction<OmieMultiResult>('omie-create-customer-multi', {
          user_id: resp.user_id,
          razao_social: input.razao_social,
          cnpj: input.cnpj ?? null,
          email: input.email ?? null,
          phone: input.phone,
          nome_contato: input.nome_contato ?? null,
          cidade: input.cidade ?? null,
          estado: input.estado ?? null,
          endereco: input.endereco ?? null,
          tags: input.tags ?? [],
        })
          .then((omieResult) => {
            const { summary } = omieResult;
            if (summary.created > 0) {
              const empresasOk = omieResult.results
                .filter((r) => r.status === 'created')
                .map((r) => r.empresa_label)
                .join(' + ');
              toast.success(`Sincronizado no Omie: ${empresasOk}`, {
                description: summary.errors > 0 || summary.skipped > 0
                  ? `${summary.errors} erro(s), ${summary.skipped} skipped`
                  : undefined,
              });
            } else if (summary.skipped === summary.total) {
              toast.info('Sync Omie skipped — secrets não configuradas');
            } else {
              const firstError = omieResult.results.find((r) => r.error)?.error;
              toast.warning('Sync Omie falhou em todas as empresas', {
                description: firstError,
              });
            }
          })
          .catch((err) => {
            console.error('[useCreateProspect] omie sync failed:', err);
            toast.warning('Sync Omie falhou', {
              description: err instanceof Error ? err.message : 'Erro desconhecido',
            });
          });
      }

      return resp;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['farmer-pending-link'] });
      qc.invalidateQueries({ queryKey: ['prospects'] });
      qc.invalidateQueries({ queryKey: ['customer-list'] });
      toast.success('Cliente cadastrado como prospect');
    },
    onError: (err) =>
      toast.error('Erro ao criar prospect', {
        description: err instanceof Error ? err.message : '',
      }),
  });
}
