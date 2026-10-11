// Lê do catálogo (omie_products) a descrição dos SKUs vinculados aos itens da campanha — o
// "join" por sku_codigo_omie que substitui copiar a descrição do SKU para
// descricao_produto_fornecedor (ver descricaoSku.ts).
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { descricaoDoSku, skusDaLeitura, type DescricaoSku, type ProdutoOmie } from "./descricaoSku";

/**
 * A conta é a da CAMPANHA (`omie_products.account` é a empresa em minúscula), e a chave carrega
 * os SKUs distintos e ordenados: vincular outro SKU é outra leitura, nunca o mapa anterior.
 * Uma campanha tem dezenas de itens — o `.in()` sobre o código do produto fica muito abaixo
 * da capa de 1.000 linhas do PostgREST.
 */
export function useDescricoesSkuOmie(
  empresaCampanha: string | null | undefined,
  skus: ReadonlyArray<number | null>,
): (sku: number | null) => DescricaoSku {
  const conta = empresaCampanha ? empresaCampanha.toLowerCase() : null;
  const chave = skusDaLeitura(skus);
  const { data, status, fetchStatus } = useQuery({
    queryKey: ["promocao-itens-skus-omie", conta, chave],
    queryFn: async (): Promise<ProdutoOmie[]> => {
      const { data: linhas, error } = await supabase
        .from("omie_products")
        .select("omie_codigo_produto, descricao, codigo")
        .eq("account", conta as string)
        .in("omie_codigo_produto", chave);
      if (error) throw error;
      return (linhas as unknown as ProdutoOmie[] | null) ?? [];
    },
    enabled: conta != null && chave.length > 0,
  });
  return (sku) => descricaoDoSku({ status, fetchStatus, data }, sku);
}
