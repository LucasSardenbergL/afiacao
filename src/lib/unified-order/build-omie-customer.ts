import type { OmieCustomer } from '@/hooks/unifiedOrder/types';

export interface ProfileIdentity {
  razao_social: string | null;
  name: string | null;
  document: string | null;
}

export interface OmieMapping {
  omie_codigo_cliente: number;
  omie_codigo_vendedor: number | null;
}

/**
 * Monta um OmieCustomer a partir da identidade (profiles) + mapeamento (omie_clientes),
 * ambos buscados por user_id. Puro (sem I/O). Retorna null se não há identidade mínima
 * (sem profile não dá pra pré-selecionar). codigo_cliente=0 = cliente local/não-sincronizado,
 * caso que o fluxo manual de pedido já trata.
 */
export function buildOmieCustomer(
  userId: string,
  profile: ProfileIdentity | null,
  omie: OmieMapping | null,
): OmieCustomer | null {
  if (!profile) return null;
  const nome = profile.razao_social || profile.name || '';
  return {
    codigo_cliente: omie?.omie_codigo_cliente ?? 0,
    razao_social: nome,
    nome_fantasia: profile.name || nome,
    cnpj_cpf: profile.document ?? '',
    codigo_vendedor: omie?.omie_codigo_vendedor ?? null,
    local_user_id: userId,
  };
}
