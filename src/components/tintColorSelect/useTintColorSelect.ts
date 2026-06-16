// Lógica do diálogo de seleção de cor tintométrica (queries, preços, alternativas).
// Extraída verbatim de src/components/TintColorSelectDialog.tsx (god-component split).
import { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { ilikeOr } from '@/lib/postgrest';
import { useTintPricing, useTintPrices } from '@/hooks/useTintPricing';
import { selectTintPrice, type TintPriceSource } from '@/lib/tint/select-price';
import type { Product } from '@/hooks/useUnifiedOrder';
import type { FormulaResult, AlternativePackaging } from './types';

interface UseTintColorSelectArgs {
  product: Product;
  open: boolean;
  customerUserId?: string | null;
  /** Pré-preenche a busca ao abrir (re-pedido via "Cores do cliente"). */
  initialSearch?: string | null;
}

export function useTintColorSelect({ product, open, customerUserId, initialSearch }: UseTintColorSelectArgs) {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedFormula, setSelectedFormula] = useState<FormulaResult | null>(null);
  const [discountPct, setDiscountPct] = useState<number>(0);
  const [altDiscounts, setAltDiscounts] = useState<Record<string, number>>({});
  const [syncDiscount, setSyncDiscount] = useState(false);
  useEffect(() => {
    if (!open) {
      setSearch('');
      setDebouncedSearch('');
      setSelectedFormula(null);
      setPriceSourceOverride(null);
    }
  }, [open]);

  // Re-pedido: abre já filtrado pela cor do histórico (debounced direto,
  // sem esperar os 300ms — a vendedora vê a lista filtrada na hora).
  useEffect(() => {
    if (open && initialSearch) {
      setSearch(initialSearch);
      setDebouncedSearch(initialSearch);
    }
  }, [open, initialSearch]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Find SKU id + produto_id + base_id for this omie product
  const { data: skuInfo, isLoading: loadingSku } = useQuery({
    queryKey: ['tint-sku-for-product', product.id],
    staleTime: 5 * 60 * 1000,
    enabled: open,
    queryFn: async () => {
      const { data } = await supabase
        .from('tint_skus')
        .select('id, produto_id, base_id')
        .eq('omie_product_id', product.id)
        .eq('account', 'oben')
        .limit(1)
        .maybeSingle();
      return data || null;
    },
  });
  const skuId = skuInfo?.id || null;

  // Get base description to extract the numeric suffix (e.g. ".7666" from "WFOB.7666 BASE BRANCA...")
  const { data: currentBaseInfo } = useQuery({
    queryKey: ['tint-base-info', skuInfo?.base_id],
    staleTime: 10 * 60 * 1000,
    enabled: !!skuInfo?.base_id,
    queryFn: async () => {
      const { data } = await supabase
        .from('tint_bases')
        .select('id, descricao, id_base_sayersystem')
        .eq('id', skuInfo!.base_id)
        .maybeSingle();
      return data || null;
    },
  });

  // Extract numeric suffix like "6736" from "WFOB.6736 BASE BRANCA..."
  const currentBaseSuffix = useMemo(() => {
    if (!currentBaseInfo?.descricao) return null;
    const match = currentBaseInfo.descricao.match(/\.(\d+)/);
    return match ? match[1] : null;
  }, [currentBaseInfo?.descricao]);

  // Search formulas in current SKU
  const { data: formulas, isLoading: loadingFormulas } = useQuery({
    queryKey: ['tint-formula-search', skuId, debouncedSearch],
    staleTime: 5 * 60 * 1000,
    enabled: !!skuId && debouncedSearch.length >= 2,
    queryFn: async () => {
      const { data } = await supabase
        .from('tint_formulas')
        .select('id, cor_id, nome_cor, preco_final_sayersystem')
        .eq('account', 'oben')
        .eq('sku_id', skuId!)
        .is('desativada_em', null)
        .or(ilikeOr(['cor_id', 'nome_cor'], debouncedSearch))
        .limit(20);
      return (data || []) as FormulaResult[];
    },
  });

  // When color not found in current base, search ALL bases for it
  const colorNotFoundInBase = debouncedSearch.length >= 2 && !loadingFormulas && formulas && formulas.length === 0;

  const { data: globalColorData, isLoading: loadingGlobalColors } = useQuery({
    queryKey: ['tint-global-color-search', debouncedSearch, currentBaseSuffix],
    staleTime: 5 * 60 * 1000,
    // Roda mesmo sem sufixo (base sem código na descrição): aí não filtra por
    // família e mostra todas as bases vendáveis — nunca esconde a cor em silêncio.
    enabled: !!colorNotFoundInBase,
    queryFn: async (): Promise<{ matches: AlternativePackaging[]; colorExists: boolean }> => {
      // Search formulas across all SKUs
      const { data: globalFormulas } = await supabase
        .from('tint_formulas')
        .select('id, cor_id, nome_cor, sku_id, preco_final_sayersystem')
        .eq('account', 'oben')
        .is('desativada_em', null)
        .or(ilikeOr(['cor_id', 'nome_cor'], debouncedSearch))
        .not('sku_id', 'is', null)
        .limit(50);

      // Achou fórmula = a cor EXISTE no catálogo (mesmo que nenhuma seja vendável).
      if (!globalFormulas || globalFormulas.length === 0) return { matches: [], colorExists: false };

      // Get SKU details
      const skuIds = [...new Set(globalFormulas.map(f => f.sku_id!))];
      const { data: skus } = await supabase
        .from('tint_skus')
        .select('id, omie_product_id, produto_id, base_id')
        .in('id', skuIds)
        .not('omie_product_id', 'is', null);

      if (!skus || skus.length === 0) return { matches: [], colorExists: true };

      // Filter SKUs to only those with the same base suffix (e.g. ".7666")
      if (currentBaseSuffix) {
        const baseIds = [...new Set(skus.map(s => s.base_id))];
        const { data: bases } = await supabase
          .from('tint_bases')
          .select('id, descricao')
          .in('id', baseIds);

        const validBaseIds = new Set(
          (bases || [])
            .filter(b => {
              const match = b.descricao?.match(/\.(\d+)/);
              return match && match[1] === currentBaseSuffix;
            })
            .map(b => b.id)
        );

        // Remove SKUs with non-matching bases — filtra skus in-place
        const filteredSkus = skus.filter(s => validBaseIds.has(s.base_id));
        if (filteredSkus.length === 0) return { matches: [], colorExists: true };
        // Replace skus reference
        skus.length = 0;
        skus.push(...filteredSkus);
      }

      // Get product details
      const productIds = skus.map(s => s.omie_product_id!).filter(Boolean);
      const { data: products } = await supabase
        .from('omie_products')
        .select('id, codigo, descricao, unidade, valor_unitario, estoque, ativo, omie_codigo_produto, account, is_tintometric, tint_type')
        .in('id', productIds);

      if (!products) return { matches: [], colorExists: true };

      const result: AlternativePackaging[] = [];
      for (const gf of globalFormulas) {
        const sku = skus.find(s => s.id === gf.sku_id);
        if (!sku?.omie_product_id) continue;
        const prod = products.find(p => p.id === sku.omie_product_id);
        if (!prod) continue;

        result.push({
          formulaId: gf.id,
          skuId: gf.sku_id!,
          omieProductId: sku.omie_product_id,
          productDescricao: prod.descricao,
          productCodigo: prod.codigo,
          precoFinalCsv: gf.preco_final_sayersystem ? Math.ceil(gf.preco_final_sayersystem * 10) / 10 : gf.preco_final_sayersystem,
          product: prod as Product,
          sameAcabamento: false,
          corId: gf.cor_id,
          nomeCor: gf.nome_cor,
        });
      }

      result.sort((a, b) => a.productDescricao.localeCompare(b.productDescricao));
      return { matches: result, colorExists: true };
    },
  });

  const globalColorMatches = globalColorData?.matches ?? [];
  const globalColorExists = globalColorData?.colorExists ?? false;

  // Pricing breakdown for selected formula (motor honesto get_tint_price)
  const { data: pricing, isLoading: pricingLoading, isError: pricingError } = useTintPricing(selectedFormula?.id || null);

  // Last practiced price for this color+base for the customer
  const { data: lastPracticedPrice, isLoading: loadingLastPrice } = useQuery({
    queryKey: ['tint-last-price', customerUserId, product.id, selectedFormula?.cor_id],
    staleTime: 30 * 1000,
    enabled: !!customerUserId && !!selectedFormula?.cor_id && !!product.id,
    queryFn: async () => {
      if (!customerUserId || !selectedFormula?.cor_id || !product.id) return null;

      const { data: orders } = await supabase
        .from('sales_orders')
        .select('items, created_at')
        .eq('customer_user_id', customerUserId)
        .eq('account', 'oben')
        .order('created_at', { ascending: false })
        .limit(50);

      if (!orders) return null;

      for (const order of orders) {
        const items = order.items as Array<{ product_id?: string; tint_cor_id?: string; valor_unitario?: number }>;
        if (!Array.isArray(items)) continue;
        for (const item of items) {
          if (
            item.product_id === product.id &&
            item.tint_cor_id === selectedFormula.cor_id
          ) {
            return {
              price: item.valor_unitario as number,
              date: order.created_at as string,
            };
          }
        }
      }
      return null;
    },
  });

  // Alternative packagings: same color, different SKUs
  const { data: alternatives, isLoading: loadingAlternatives } = useQuery({
    queryKey: ['tint-alternatives', selectedFormula?.cor_id, skuId],
    staleTime: 5 * 60 * 1000,
    enabled: !!selectedFormula?.cor_id && !!skuId,
    queryFn: async (): Promise<AlternativePackaging[]> => {
      if (!selectedFormula?.cor_id || !skuId) return [];

      // Get all formulas with the same cor_id but different sku_id
      const { data: altFormulas } = await supabase
        .from('tint_formulas')
        .select('id, sku_id, preco_final_sayersystem')
        .eq('account', 'oben')
        .eq('cor_id', selectedFormula.cor_id)
        .is('desativada_em', null)
        .neq('sku_id', skuId)
        .not('sku_id', 'is', null);

      if (!altFormulas || altFormulas.length === 0) return [];

      // Get SKU details with omie_product_id, produto_id, base_id
      const skuIds = [...new Set(altFormulas.map(f => f.sku_id!))];
      const { data: skus } = await supabase
        .from('tint_skus')
        .select('id, omie_product_id, produto_id, base_id')
        .in('id', skuIds)
        .not('omie_product_id', 'is', null);

      if (!skus || skus.length === 0) return [];

      // Get product details
      const productIds = skus.map(s => s.omie_product_id!).filter(Boolean);
      const { data: products } = await supabase
        .from('omie_products')
        .select('id, codigo, descricao, unidade, valor_unitario, estoque, ativo, omie_codigo_produto, account, is_tintometric, tint_type')
        .in('id', productIds);

      if (!products) return [];

      const currentProdutoId = skuInfo?.produto_id;
      const currentBaseId = skuInfo?.base_id;

      const result: AlternativePackaging[] = [];
      for (const af of altFormulas) {
        const sku = skus.find(s => s.id === af.sku_id);
        if (!sku?.omie_product_id) continue;
        const prod = products.find(p => p.id === sku.omie_product_id);
        if (!prod) continue;

        result.push({
          formulaId: af.id,
          skuId: af.sku_id!,
          omieProductId: sku.omie_product_id,
          productDescricao: prod.descricao,
          productCodigo: prod.codigo,
          precoFinalCsv: af.preco_final_sayersystem ? Math.ceil(af.preco_final_sayersystem * 10) / 10 : af.preco_final_sayersystem,
          product: prod as Product,
          sameAcabamento: sku.produto_id === currentProdutoId && sku.base_id === currentBaseId,
        });
      }

      // Sort: same acabamento first, then by description
      result.sort((a, b) => {
        if (a.sameAcabamento && !b.sameAcabamento) return -1;
        if (!a.sameAcabamento && b.sameAcabamento) return 1;
        return a.productDescricao.localeCompare(b.productDescricao);
      });

      return result;
    },
  });

  // Preços honestos (motor batch get_tint_prices) das "outras embalagens" + "busca global":
  // uma cor em várias bases, cada fórmula com seu próprio preço. Mapa { formulaId: breakdown }.
  const altFormulaIds = useMemo(
    () => [...(alternatives ?? []), ...globalColorMatches].map((a) => a.formulaId),
    [alternatives, globalColorMatches],
  );
  const { data: altPriceMap, isLoading: altPriceQueryLoading } = useTintPrices(altFormulaIds);
  const altPriceLoading = altFormulaIds.length > 0 && altPriceQueryLoading;

  // Preço honesto da cor selecionada: motor get_tint_price (base + corantes, NULL quando
  // a base/corante falta) + CSV legado + último preço do cliente. Quando o motor não tem
  // preço, vira "sem preço" — nunca um número fabricado. Regras em src/lib/tint/select-price.ts.
  const rawCsv = selectedFormula?.preco_final_sayersystem ?? null;
  const custoCorantes = pricing?.custoCorantes || 0;

  const [priceSourceOverride, setPriceSourceOverride] = useState<TintPriceSource | null>(null);

  // Trocar de cor reseta a escolha manual de fonte — senão um override antigo (ex.: "tabela")
  // venceria o auto da nova cor e esconderia o aviso de recálculo dela.
  useEffect(() => {
    setPriceSourceOverride(null);
  }, [selectedFormula?.id]);

  // Enquanto a RPC de preço (ou o último preço do cliente) carrega, NÃO decidir o preço: o motor
  // honesto ainda não respondeu e cair no CSV/cliente aqui venderia o preço legado (subfaturado)
  // antes de saber. A UI mostra "calculando" e segura o "Adicionar".
  const precoCarregando = !!selectedFormula && (pricingLoading || loadingLastPrice);

  // A RPC de preço pode FALHAR (erro/permissão/runtime) e o hook devolve pricing null igual a
  // "carregando". Sem distinguir, a seleção cairia no CSV legado/preço-cliente e venderia base/
  // corante inativo que a RPC barra. Fail-closed: fórmula selecionada + parou de carregar + a RPC
  // não confirmou breakdown (erro ou sem dado) ⇒ motor falhou ⇒ sem preço (regra 0 de select-price).
  const motorFalhou = !!selectedFormula && !pricingLoading && (pricingError || pricing == null);

  const selection = selectTintPrice({
    lastPracticedPrice: lastPracticedPrice?.price ?? null,
    precoCsv: rawCsv,
    pricing: pricing ?? null,
    motorFalhou,
  });

  // Qualquer "sem preço confiável" (base ausente/zero ex. PRD03657, corante sem custo, receita
  // faltando) bloqueia TODAS as fontes — inclusive o override manual: não deixar a vendedora
  // forçar CSV/cliente quando o motor honesto não tem preço. Corrigir no Omie (self-healing).
  const semPrecoConfiavel = selection.motivoSemPreco != null;
  const precoCsv = !semPrecoConfiavel && rawCsv && rawCsv > 0 ? Math.ceil(rawCsv * 10) / 10 : 0;
  const precoCalc = !semPrecoConfiavel && pricing?.precoFinal != null ? Math.ceil(pricing.precoFinal * 10) / 10 : null;
  const precoCliente = !semPrecoConfiavel ? (lastPracticedPrice?.price ?? null) : null;
  const precoPorFonte: Record<TintPriceSource, number | null> = {
    cliente: precoCliente,
    tabela: precoCsv > 0 ? precoCsv : null,
    calculado: precoCalc,
  };

  // Override manual da vendedora só vale se aquela fonte tiver preço.
  const overrideValido = priceSourceOverride && precoPorFonte[priceSourceOverride] != null ? priceSourceOverride : null;
  const priceSource = overrideValido ?? selection.source;
  // Durante o carregando, segura o preço (null) até o motor responder.
  const precoSemDesconto = precoCarregando ? null : (priceSource ? precoPorFonte[priceSource] : null);
  const disponivel = precoSemDesconto != null;

  // Aviso de recálculo só quando a fonte mostrada é o cálculo que subiu vs o importado.
  const recalculado = priceSource === 'calculado' && selection.recalculado;
  const precoImportadoAnterior = recalculado ? selection.precoImportadoAnterior : null;
  const motivoSemPreco = disponivel ? null : selection.motivoSemPreco;

  const precoFinal = precoSemDesconto == null
    ? null
    : (discountPct > 0 ? Math.round(precoSemDesconto * (1 - discountPct / 100) * 100) / 100 : precoSemDesconto);

  const onSearchChange = (value: string) => {
    setSearch(value);
    setSelectedFormula(null);
    setPriceSourceOverride(null);
  };

  return {
    search,
    onSearchChange,
    loadingSku,
    skuId,
    formulas,
    loadingFormulas,
    colorNotFoundInBase,
    globalColorMatches,
    globalColorExists,
    loadingGlobalColors,
    selectedFormula,
    setSelectedFormula,
    lastPracticedPrice,
    loadingLastPrice,
    alternatives,
    loadingAlternatives,
    altPriceMap,
    altPriceLoading,
    discountPct,
    setDiscountPct,
    altDiscounts,
    setAltDiscounts,
    syncDiscount,
    setSyncDiscount,
    priceSource,
    setPriceSourceOverride,
    precoCsv,
    precoCalc,
    precoCliente,
    custoCorantes,
    precoSemDesconto,
    precoFinal,
    disponivel,
    precoCarregando,
    recalculado,
    precoImportadoAnterior,
    motivoSemPreco,
  };
}
