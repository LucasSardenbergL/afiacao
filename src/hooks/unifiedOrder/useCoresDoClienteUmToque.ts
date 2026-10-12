import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useTintPrices } from '@/hooks/useTintPricing';
import {
  decidirUmToque,
  ehCodigoDeCor,
  escolherFormulaUmToque,
  normalizarCodigoCor,
  type CandidataUmToque,
} from '@/lib/tint/cor-um-toque';
import type { AltPriceSource } from '@/lib/tint/select-price';
import type { Product } from '@/hooks/useUnifiedOrder';

export interface AlvoUmToque {
  /** Chave da ocorrência na tela (cor + índice). */
  key: string;
  /** Produto-base daquela compra, já resolvido no catálogo (tintométrico, Oben). */
  product: Product;
  /** Código da cor extraído do histórico (`termoBuscaCor`). */
  codigo: string;
}

export interface UmToquePronto {
  formulaId: string;
  corId: string;
  nomeCor: string;
  preco: number;
  fonte: AltPriceSource;
  custoCorantes: number;
  product: Product;
}

/** `'carregando'` = ainda resolvendo (a UI diz "calculando"); ausente = sem 1 toque (abre o diálogo). */
export type EstadoUmToque = UmToquePronto | 'carregando';

/**
 * "Cores do cliente" em 1 toque: para cada ocorrência visível, acha a fórmula ÚNICA da
 * mesma base com o mesmo código de cor e o preço do MOTOR (batch `get_tint_prices`).
 * Fail-closed em cada degrau — erro de leitura, motor carregando/falhou, fórmula
 * ambígua, R$ 0 — a ocorrência fica sem atalho e o botão abre o diálogo de sempre.
 * O tintométrico só existe na Oben (`account='oben'` fixo, como no seletor).
 */
export function useCoresDoClienteUmToque(alvos: AlvoUmToque[]): Record<string, EstadoUmToque> {
  const elegiveis = useMemo(() => alvos.filter((a) => ehCodigoDeCor(a.codigo)), [alvos]);
  const productIds = useMemo(() => [...new Set(elegiveis.map((a) => a.product.id))].sort(), [elegiveis]);
  const codigos = useMemo(
    () => [...new Set(elegiveis.flatMap((a) => [a.codigo.trim(), normalizarCodigoCor(a.codigo)]))].sort(),
    [elegiveis],
  );

  const { data: leitura, isLoading, isError } = useQuery({
    queryKey: ['tint-um-toque-formulas', productIds, codigos],
    staleTime: 5 * 60 * 1000,
    enabled: productIds.length > 0 && codigos.length > 0,
    queryFn: async () => {
      // Mesma escolha de SKU do seletor (`order('id')`, o 1º por produto Omie).
      const { data: skus, error: skusErr } = await supabase
        .from('tint_skus')
        .select('id, omie_product_id')
        .in('omie_product_id', productIds)
        .eq('account', 'oben')
        .order('id', { ascending: true });
      if (skusErr) throw skusErr;
      const skuPorProduto = new Map<string, string>();
      for (const s of skus ?? []) {
        if (s.omie_product_id && !skuPorProduto.has(s.omie_product_id)) skuPorProduto.set(s.omie_product_id, s.id);
      }
      const skuIds = [...new Set(skuPorProduto.values())];
      if (skuIds.length === 0) return { skuPorProduto, candidatas: [] as CandidataUmToque[] };

      const { data, error } = await supabase
        .from('v_tint_formula_canonica')
        .select('id, sku_id, cor_id, nome_cor, preco_csv_legado')
        .eq('account', 'oben')
        .in('sku_id', skuIds)
        .in('cor_id', codigos)
        .order('id', { ascending: true });
      if (error) throw error;
      const candidatas = (data ?? []).filter(
        (r): r is CandidataUmToque =>
          r.id != null && r.sku_id != null && r.cor_id != null && r.nome_cor != null,
      );
      return { skuPorProduto, candidatas };
    },
  });

  const escolhidas = useMemo(() => {
    const m = new Map<string, CandidataUmToque>();
    if (!leitura) return m;
    for (const a of elegiveis) {
      const skuId = leitura.skuPorProduto.get(a.product.id);
      if (!skuId) continue;
      const f = escolherFormulaUmToque(skuId, a.codigo, leitura.candidatas);
      if (f) m.set(a.key, f);
    }
    return m;
  }, [leitura, elegiveis]);

  const formulaIds = useMemo(() => [...new Set([...escolhidas.values()].map((f) => f.id))], [escolhidas]);
  const {
    data: precosBrutos,
    isLoading: precoQueryLoading,
    isError: precoErro,
    isFetching: precoFetching,
  } = useTintPrices(formulaIds);
  // Fail-closed (mesmo corte do seletor, Codex P1 da Fase 1): após erro o React Query
  // mantém o mapa velho — com erro ou recarregando, NENHUM preço vale para o atalho.
  const precoCarregando = formulaIds.length > 0 && (precoQueryLoading || (precoErro && precoFetching));
  const precos = precoErro || precoCarregando ? undefined : precosBrutos;

  return useMemo(() => {
    const out: Record<string, EstadoUmToque> = {};
    if (isError) return out;
    for (const a of elegiveis) {
      if (isLoading) {
        out[a.key] = 'carregando';
        continue;
      }
      const f = escolhidas.get(a.key);
      if (!f) continue;
      if (precoCarregando) {
        out[a.key] = 'carregando';
        continue;
      }
      const decisao = precos ? decidirUmToque(f.preco_csv_legado, precos[f.id]) : null;
      if (!decisao) continue;
      out[a.key] = {
        formulaId: f.id,
        corId: f.cor_id,
        nomeCor: f.nome_cor,
        preco: decisao.preco,
        fonte: decisao.fonte,
        custoCorantes: decisao.custoCorantes,
        product: a.product,
      };
    }
    return out;
  }, [elegiveis, escolhidas, isLoading, isError, precoCarregando, precos]);
}

/** Chave de uma ocorrência na tela — a MESMA no card e no cálculo do 1 toque. */
export function chaveUmToque(corNome: string, indiceOcorrencia: number): string {
  return `${corNome}#${indiceOcorrencia}`;
}
