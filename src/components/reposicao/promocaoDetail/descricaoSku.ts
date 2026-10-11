// A descrição do SKU Omie de um item de promoção — LIDA do catálogo pelo sku_codigo_omie.
//
// descricao_produto_fornecedor guarda o que o FORNECEDOR ofertou (o texto que a extração leu da
// campanha); a descrição do SKU que recebeu o desconto vem de omie_products, nunca copiada para
// lá (copiar apagava a auditoria "o que o fornecedor ofertou × qual SKU recebeu o desconto").
// Por ser leitura, "não consegui ler" não pode virar "não há": fora do catálogo só se afirma
// depois de uma leitura bem-sucedida, e cache de refetch falho vai marcado como desatualizado.
import {
  desatualizado,
  estadoDeLeitura,
  type EstadoSemLeitura,
  type FatiaDeQuery,
} from "@/lib/leitura/estado-de-leitura";

export type ProdutoOmie = {
  omie_codigo_produto: number;
  descricao: string | null;
  codigo: string | null;
};

/** O que a tela pode afirmar sobre a descrição do SKU de UM item. */
export type DescricaoSku =
  | { estado: "sem_sku" }
  | { estado: "carregando" }
  | { estado: "indisponivel"; motivo: EstadoSemLeitura }
  | { estado: "fora_do_catalogo"; desatualizada: EstadoSemLeitura | null }
  | { estado: "ok"; descricao: string | null; codigo: string | null; desatualizada: EstadoSemLeitura | null };

/** SKUs distintos, sem nulos e em ordem — a identidade da leitura (mudou um vínculo, mudou a chave). */
export function skusDaLeitura(skus: ReadonlyArray<number | null>): number[] {
  return [...new Set(skus.filter((s): s is number => s != null))].sort((a, b) => a - b);
}

export function descricaoDoSku(
  q: FatiaDeQuery & { data: ReadonlyArray<ProdutoOmie> | undefined },
  sku: number | null,
): DescricaoSku {
  if (sku == null) return { estado: "sem_sku" };
  if (q.data === undefined) {
    const e = estadoDeLeitura(q);
    // 'desabilitada' é a conta da campanha ainda chegando: transitório, como o carregamento.
    return e === "erro" || e === "sem-rede" ? { estado: "indisponivel", motivo: e } : { estado: "carregando" };
  }
  const velha = desatualizado(q, true);
  const produto = q.data.find((p) => p.omie_codigo_produto === sku);
  if (!produto) return { estado: "fora_do_catalogo", desatualizada: velha };
  return { estado: "ok", descricao: produto.descricao, codigo: produto.codigo, desatualizada: velha };
}
