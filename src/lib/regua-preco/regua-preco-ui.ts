import type { ReguaPrecoInput } from './types';

/** Cap conservador de aumento por confiança da evidência (calibrável; constante no v1). */
export const CAPS_REGUA = { alta: 0.1, media: 0.05 } as const;

/** Retorno cru da RPC `get_regua_preco` (jsonb). */
export interface FetchDataRegua {
  cmc: number | null;
  cmc_confiavel: boolean;
  aliquota_venda: number;
  piso_mc: number | null;
  precos_cliente: number[];
  comparaveis: { preco: number; c: number }[]; // c = cliente anonimizado (dense_rank)
}

/**
 * Retorno cru de um item da RPC `get_regua_preco_customer360` (jsonb array):
 * a camada 360 (resolução/preço/qty) + o pacote bruto da get_regua_preco.
 * Quando `hide_reason` é 'sem_produto'/'sem_preco', os campos do pacote vêm ausentes.
 */
export type FetchData360 = Partial<FetchDataRegua> & {
  omie_codigo: number;
  product_id: string | null;
  preco_atual: number | null;
  preco_atual_at: string | null;
  qty_ref: number | null;
  qty_ref_n: number | null;
  qty_ref_source: string | null;
  hide_reason: string | null;
};

/** Linha do carrinho relevante p/ a Régua. `chave` casa com o cockpit (chaveCockpit). */
export interface ReguaCartItem {
  chave: string;
  productId: string;
  qty: number;
  precoAtual: number;
}

/** Item já deduplicado p/ o fetch (1 RPC por par produto+quantidade). */
export interface ReguaItemFetch {
  productId: string;
  qty: number;
}

/** Chave estável produto+qty — casa item do carrinho ↔ resultado do fetch. */
export const chaveFetch = (i: ReguaItemFetch): string => `${i.productId}:${i.qty}`;

/** Gates + dedupe: só busca itens válidos, 1 vez por (productId, qty). */
export function dedupeFetchItens(itens: ReguaCartItem[]): ReguaItemFetch[] {
  const seen = new Set<string>();
  const out: ReguaItemFetch[] = [];
  for (const it of itens) {
    if (!it.productId || !(it.qty > 0) || !(it.precoAtual > 0)) continue;
    const k = `${it.productId}:${it.qty}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ productId: it.productId, qty: it.qty });
  }
  return out;
}

/** Monta o input do helper a partir do fetch da RPC + o preço atual da linha. */
export function montarInputRegua(fetch: FetchDataRegua, precoAtual: number): ReguaPrecoInput {
  return {
    precoAtual,
    cmc: fetch.cmc,
    cmcConfiavel: fetch.cmc_confiavel,
    aliquotaVenda: fetch.aliquota_venda,
    precosCliente: fetch.precos_cliente ?? [],
    comparaveis: (fetch.comparaveis ?? []).map((c) => ({ preco: c.preco, clienteId: String(c.c) })),
    caps: CAPS_REGUA,
  };
}
