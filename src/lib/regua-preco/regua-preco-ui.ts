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
