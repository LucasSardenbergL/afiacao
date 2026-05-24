// src/types/carteira.ts
export type CarteiraSource = 'omie' | 'hunter_orphan';

export interface CarteiraAssignment {
  id: string;
  customer_user_id: string;
  owner_user_id: string;
  source: CarteiraSource;
  omie_account: string | null;
  omie_codigo_vendedor: number | null;
  eligible: boolean;
  valid_from: string;
  updated_at: string;
  last_synced_at: string | null;
}

export interface CarteiraCoverage {
  id: string;
  covering_user_id: string;
  covered_user_id: string;
  valid_from: string;
  valid_until: string | null;
  active: boolean;
  created_by: string;
  created_at: string;
}

export interface OmieVendedorMap {
  id: string;
  omie_account: string;
  omie_codigo_vendedor: number;
  user_id: string;
  nome: string | null;
  created_at: string;
}

/** Linha retornada pelo RPC `minha_carteira(uid)`. coberto_de = dono original quando vem de cobertura; null = próprio. */
export interface MinhaCarteiraRow {
  customer_user_id: string;
  owner_user_id: string;
  coberto_de: string | null;
}
